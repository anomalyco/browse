//! Finding and starting the browsers the sweep drives, each in a throwaway profile (never the user's own profile or
//! downloads folder).
//!
//! `launch` answers `Ok(None)` only when the browser isn't installed: a browser that is there but fails to start is an
//! error, never a silent skip.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use async_trait::async_trait;
use browse_bidi::BiDiBrowserDriver;
use browse_core::BrowserDriver;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use browse_cdp::CdpWsBrowserDriver;

pub const CHROMIUM: &str = "chromium-cdp";
pub const FIREFOX: &str = "firefox-bidi";
/// Every backend, the reference (whose transcript the others are diffed against) first.
pub const BACKENDS: [&str; 2] = [CHROMIUM, FIREFOX];

/// The oldest majors the sweep accepts; older browsers lack protocol features the drivers rely on.
pub const MIN_CHROMIUM_MAJOR: u32 = 120;
pub const MIN_FIREFOX_MAJOR: u32 = 129;
/// The versions the pinned divergences were last verified against.
pub const TESTED_WITH: &[(&str, &str)] =
    &[(CHROMIUM, "Google Chrome for Testing 148.0.7778.96"), (FIREFOX, "Mozilla Firefox 160.0.1")];

/// The viewport every scenario emulates first.
pub const VIEWPORT: (u64, u64) = (1000, 800);

/// Strips the Windows `\\?\` verbatim path prefix from `std::fs::canonicalize` so Chromium's
/// `Browser.setDownloadBehavior` accepts `downloadPath`.
fn strip_windows_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    if let Some(stripped) = path.to_str().and_then(|s| s.strip_prefix("\\\\?\\")) {
        return PathBuf::from(stripped);
    }
    path
}

/// A private temporary folder, removed on drop.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(name: &str) -> anyhow::Result<TempDir> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
        let unique = (nanos as u64) ^ (NEXT.fetch_add(1, Ordering::Relaxed) << 32);
        let path = std::env::temp_dir().join(format!("browse-conformance-{name}-{}-{unique:x}", std::process::id()));
        std::fs::create_dir_all(&path).with_context(|| format!("creating {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
        }
        let canonical = strip_windows_verbatim(std::fs::canonicalize(&path)?);
        Ok(TempDir(canonical))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Browser-wide facts the protocol-neutral `BrowserDriver` doesn't expose, for the sweep's leak checks.
#[async_trait]
pub trait BrowserControl: Send + Sync {
    /// How many top-level tabs the browser has open (the keeper tab included).
    async fn top_level_tabs(&self) -> anyhow::Result<usize>;
}

struct CdpControl(Arc<CdpWsBrowserDriver>);

#[async_trait]
impl BrowserControl for CdpControl {
    async fn top_level_tabs(&self) -> anyhow::Result<usize> {
        Ok(self.0.page_targets().await?.len())
    }
}

struct BiDiControl(Arc<BiDiBrowserDriver>);

#[async_trait]
impl BrowserControl for BiDiControl {
    async fn top_level_tabs(&self) -> anyhow::Result<usize> {
        let tree = self
            .0
            .transport()
            .send("browsingContext.getTree", json!({ "maxDepth": 0 }))
            .await
            .map_err(|error| anyhow!("{error}"))?;
        Ok(tree.get("contexts").and_then(Value::as_array).map(Vec::len).unwrap_or(0))
    }
}

/// A running browser in its own profile.
pub struct Launched {
    /// `chromium-cdp` or `firefox-bidi`: the transcript's name.
    pub backend: &'static str,
    /// The backend with its flavor, e.g. `chromium-cdp(headless-shell)`.
    pub label: String,
    pub version: String,
    pub binary: PathBuf,
    pub driver: Arc<dyn BrowserDriver>,
    pub control: Arc<dyn BrowserControl>,
    pub downloads: PathBuf,
    child: tokio::process::Child,
    _profile: TempDir,
}

impl Launched {
    /// Quits the browser through its driver, then makes sure the process is gone.
    pub async fn quit(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(5), self.driver.quit()).await;
        if tokio::time::timeout(Duration::from_secs(10), self.child.wait()).await.is_err() {
            let _ = self.child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
        }
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// Where Playwright keeps its browsers on this OS.
fn playwright_caches() -> Vec<PathBuf> {
    let mut caches = Vec::new();
    if let Some(path) = std::env::var_os("PLAYWRIGHT_BROWSERS_PATH") {
        caches.push(PathBuf::from(path));
    }
    if let Some(home) = home() {
        caches.push(home.join("Library/Caches/ms-playwright"));
        caches.push(home.join(".cache/ms-playwright"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        caches.push(PathBuf::from(local).join("ms-playwright"));
    }
    caches
}

/// `<cache>/<prefix><revision>/<one of inner>`, newest revision first.
fn playwright_builds(prefix: &str, inner: &[&str]) -> Vec<PathBuf> {
    let mut found: Vec<(u64, PathBuf)> = Vec::new();
    for cache in playwright_caches() {
        let Ok(entries) = std::fs::read_dir(&cache) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(revision) = name.strip_prefix(prefix).and_then(|r| r.parse::<u64>().ok()) else { continue };
            for path in inner {
                let candidate = entry.path().join(path);
                if candidate.is_file() {
                    found.push((revision, candidate));
                }
            }
        }
    }
    found.sort_by_key(|(revision, _)| std::cmp::Reverse(*revision));
    found.into_iter().map(|(_, path)| path).collect()
}

fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
            #[cfg(windows)]
            {
                let exe = dir.join(format!("{name}.exe"));
                if exe.is_file() {
                    return Some(exe);
                }
            }
        }
    }
    None
}

/// The Chromium to test and whether it is the headless shell.
pub fn chromium_binary() -> Option<(PathBuf, bool)> {
    if let Some(path) = std::env::var_os("BROWSE_TEST_CHROME") {
        let path = PathBuf::from(path);
        let shell = path.file_name().is_some_and(|n| n.to_string_lossy().contains("headless-shell"));
        return Some((path, shell));
    }
    let testing = playwright_builds(
        "chromium-",
        &[
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
            "chrome-linux64/chrome",
            "chrome-linux/chrome",
            "chrome-win64/chrome.exe",
            "chrome-win/chrome.exe",
        ],
    );
    if let Some(path) = testing.into_iter().next() {
        return Some((path, false));
    }
    let system = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ];
    if let Some(path) = system.iter().map(PathBuf::from).find(|p| p.is_file()) {
        return Some((path, false));
    }
    if let Some(path) = on_path(&["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
        return Some((path, false));
    }
    let shell = playwright_builds(
        "chromium_headless_shell-",
        &[
            "chrome-headless-shell-mac-arm64/chrome-headless-shell",
            "chrome-headless-shell-mac-x64/chrome-headless-shell",
            "chrome-headless-shell-linux64/chrome-headless-shell",
            "chrome-headless-shell-win64/chrome-headless-shell.exe",
        ],
    );
    shell.into_iter().next().map(|path| (path, true))
}

pub fn firefox_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("BROWSE_TEST_FIREFOX") {
        return Some(PathBuf::from(path));
    }
    let mac = PathBuf::from("/Applications/Firefox.app/Contents/MacOS/firefox");
    if mac.is_file() {
        return Some(mac);
    }
    let windows = PathBuf::from(r"C:\Program Files\Mozilla Firefox\firefox.exe");
    if windows.is_file() {
        return Some(windows);
    }
    on_path(&["firefox"])
}

/// How long a started browser gets to open its port and start a protocol session.
const STARTUP: Duration = Duration::from_secs(45);

/// Starts `backend` (`chromium-cdp` or `firefox-bidi`); None when that browser isn't installed. A start that stalls
/// (Firefox 160 on macOS now and then spins at startup in a fresh profile) is tried once more in a new profile; a
/// second failure is the error.
pub async fn launch(backend: &str) -> anyhow::Result<Option<Launched>> {
    let attempt = || async {
        match backend {
            CHROMIUM => match chromium_binary() {
                Some((binary, shell)) => launch_chromium(binary, shell).await.map(Some),
                None => Ok(None),
            },
            FIREFOX => match firefox_binary() {
                Some(binary) => launch_firefox(binary).await.map(Some),
                None => Ok(None),
            },
            other => bail!("unknown backend {other}"),
        }
    };
    match attempt().await {
        Err(first) => {
            eprintln!("conformance: {backend} did not start ({first:#}); trying once more in a new profile");
            attempt().await.map_err(|second| anyhow!("{second:#} (and before that: {first:#})"))
        }
        started => started,
    }
}

fn major(version: &str) -> Option<u32> {
    version.trim().split(['.', ' ']).next()?.parse().ok()
}

/// Reads the child's stderr until `find` picks a line, or `file` (in the profile) appears; the rest of stderr is
/// drained in the background so the browser never blocks on it.
async fn endpoint(
    child: &mut tokio::process::Child,
    find: fn(&str) -> Option<String>,
    file: impl Fn() -> Option<String>,
    what: &str,
) -> anyhow::Result<String> {
    let stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;
    let mut lines = BufReader::new(stderr).lines();
    let mut seen = Vec::new();
    let found = tokio::time::timeout(STARTUP, async {
        loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => {
                        if let Some(url) = find(&line) {
                            return Some(url);
                        }
                        if seen.len() < 40 {
                            seen.push(line);
                        }
                    }
                    _ => return file(),
                },
                _ = tokio::time::sleep(Duration::from_millis(200)) => {
                    if let Some(url) = file() {
                        return Some(url);
                    }
                }
            }
        }
    })
    .await
    .ok()
    .flatten();
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    found.ok_or_else(|| anyhow!("{what} never announced its endpoint; stderr:\n{}", seen.join("\n")))
}

async fn launch_chromium(binary: PathBuf, shell: bool) -> anyhow::Result<Launched> {
    let profile = TempDir::new("chromium")?;
    let downloads = profile.path().join("downloads");
    std::fs::create_dir_all(&downloads)?;
    let data = profile.path().join("data");
    let mut command = tokio::process::Command::new(&binary);
    command.arg(if shell { "--headless" } else { "--headless=new" }).args([
        "--remote-debugging-port=0",
        "--site-per-process",
        "--force-device-scale-factor=1",
        "--hide-scrollbars",
        "--force-color-profile=srgb",
        "--no-proxy-server",
        "--disable-background-networking",
        "--disable-gpu",
        // An assistive app on the machine turns Chromium's accessibility on, and new headless on macOS can then
        // deadlock its renderer when a text selection changes.
        "--disable-renderer-accessibility",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate,MediaRouter,OptimizationHints",
        "--window-size=1000,800",
    ]);
    #[cfg(target_os = "linux")]
    command.arg("--no-sandbox");
    // Without these a macOS Chromium can wait on the login keychain before it opens its DevTools port.
    #[cfg(target_os = "macos")]
    command.args(["--use-mock-keychain", "--password-store=basic"]);
    command.arg(format!("--user-data-dir={}", data.display())).arg("about:blank");
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("starting {}", binary.display()))?;
    let port_file = data.join("DevToolsActivePort");
    let ws = endpoint(
        &mut child,
        |line| line.strip_prefix("DevTools listening on ").map(|url| url.trim().to_string()),
        || {
            let text = std::fs::read_to_string(&port_file).ok()?;
            let mut lines = text.lines();
            let port = lines.next()?.trim();
            let path = lines.next()?.trim();
            Some(format!("ws://127.0.0.1:{port}{path}"))
        },
        "Chromium",
    )
    .await?;
    let cdp = tokio::time::timeout(STARTUP, CdpWsBrowserDriver::connect(&ws))
        .await
        .map_err(|_| anyhow!("Chromium at {ws} did not answer within {} s", STARTUP.as_secs()))?
        .with_context(|| format!("connecting to Chromium at {ws}"))?;
    cdp.browser_send(
        "Browser.setDownloadBehavior",
        json!({ "behavior": "allow", "downloadPath": downloads.display().to_string(), "eventsEnabled": false }),
    )
    .await
    .context("Browser.setDownloadBehavior")?;
    let product = cdp.product().to_string();
    let version = product.split('/').nth(1).unwrap_or(&product).to_string();
    if major(&version).is_none_or(|m| m < MIN_CHROMIUM_MAJOR) {
        bail!("{} is {product}; the sweep needs Chromium {MIN_CHROMIUM_MAJOR} or newer", binary.display());
    }
    let label = if shell { format!("{CHROMIUM}(headless-shell)") } else { CHROMIUM.to_string() };
    let flavor = if shell { "chrome-headless-shell" } else { "Chromium" };
    Ok(Launched {
        backend: CHROMIUM,
        label,
        version: format!("{flavor} {version} ({product})"),
        binary,
        driver: cdp.clone(),
        control: Arc::new(CdpControl(cdp)),
        downloads,
        child,
        _profile: profile,
    })
}

fn firefox_prefs(downloads: &Path) -> String {
    let downloads = downloads.display().to_string().replace('\\', "\\\\").replace('"', "\\\"");
    let mut prefs = String::new();
    for (name, value) in [
        ("app.update.disabledForTesting", "true".to_string()),
        ("ui.useOverlayScrollbars", "1".to_string()),
        ("accessibility.tabfocus", "7".to_string()),
        ("network.proxy.type", "0".to_string()),
        // Light and full motion, whatever the machine's own OS accessibility/theme settings (Chromium's headless default).
        ("layout.css.prefers-color-scheme.content-override", "1".to_string()),
        ("ui.systemUsesDarkTheme", "0".to_string()),
        ("ui.prefersReducedMotion", "0".to_string()),
        ("browser.shell.checkDefaultBrowser", "false".to_string()),
        ("datareporting.policy.dataSubmissionEnabled", "false".to_string()),
        ("toolkit.telemetry.reportingpolicy.firstRun", "false".to_string()),
        ("browser.startup.homepage_override.mstone", "\"ignore\"".to_string()),
        ("browser.tabs.warnOnClose", "false".to_string()),
        ("browser.download.folderList", "2".to_string()),
        ("browser.download.dir", format!("\"{downloads}\"")),
        ("browser.download.useDownloadDir", "true".to_string()),
        ("browser.download.always_ask_before_handling_new_types", "false".to_string()),
        ("browser.download.manager.showWhenStarting", "false".to_string()),
        ("browser.download.panel.shown", "true".to_string()),
    ] {
        prefs.push_str(&format!("user_pref(\"{name}\", {value});\n"));
    }
    prefs
}

async fn launch_firefox(binary: PathBuf) -> anyhow::Result<Launched> {
    let profile = TempDir::new("firefox")?;
    let downloads = profile.path().join("downloads");
    std::fs::create_dir_all(&downloads)?;
    let data = profile.path().join("profile");
    std::fs::create_dir_all(&data)?;
    std::fs::write(data.join("user.js"), firefox_prefs(&downloads))?;
    let mut child = tokio::process::Command::new(&binary)
        .args(["--headless", "--no-remote", "--profile"])
        .arg(&data)
        .args(["--remote-debugging-port", "0", "about:blank"])
        .env("MOZ_CRASHREPORTER_DISABLE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("starting {}", binary.display()))?;
    let server_file = data.join("WebDriverBiDiServer.json");
    let ws = endpoint(
        &mut child,
        |line| line.split("WebDriver BiDi listening on ").nth(1).map(|url| url.trim().to_string()),
        || {
            let server: Value = serde_json::from_str(&std::fs::read_to_string(&server_file).ok()?).ok()?;
            Some(format!("ws://{}:{}", server["ws_host"].as_str()?, server["ws_port"].as_u64()?))
        },
        "Firefox",
    )
    .await?;
    let bidi = tokio::time::timeout(STARTUP, BiDiBrowserDriver::connect(&ws))
        .await
        .map_err(|_| anyhow!("Firefox at {ws} did not start a BiDi session within {} s", STARTUP.as_secs()))?
        .map_err(|error| anyhow!("starting a BiDi session at {ws}: {error}"))?;
    let capabilities = bidi.capabilities();
    let name = capabilities.get("browserName").and_then(Value::as_str).unwrap_or("firefox").to_string();
    let version = capabilities.get("browserVersion").and_then(Value::as_str).unwrap_or("").to_string();
    if major(&version).is_none_or(|m| m < MIN_FIREFOX_MAJOR) {
        bidi.shutdown().await;
        bail!("{} is {name} {version}; the sweep needs Firefox {MIN_FIREFOX_MAJOR} or newer", binary.display());
    }
    Ok(Launched {
        backend: FIREFOX,
        label: FIREFOX.to_string(),
        version: format!("{name} {version}"),
        binary,
        driver: bidi.clone(),
        control: Arc::new(BiDiControl(bidi)),
        downloads,
        child,
        _profile: profile,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn majors() {
        assert_eq!(major("148.0.7778.96"), Some(148));
        assert_eq!(major("160.0.1"), Some(160));
        assert_eq!(major(""), None);
    }

    #[test]
    fn firefox_prefs_keep_downloads_in_the_profile() {
        let prefs = firefox_prefs(Path::new("/tmp/x/downloads"));
        assert!(prefs.contains("user_pref(\"browser.download.dir\", \"/tmp/x/downloads\");"));
        assert!(prefs.contains("user_pref(\"browser.download.folderList\", 2);"));
        assert!(prefs.contains("user_pref(\"accessibility.tabfocus\", 7);"));
    }
}