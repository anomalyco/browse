//! Updates (cli/src/update/**), by how browse was installed:
//!   binary      the release service's manifest for this build's channel, the protocol's client rules, a size- and
//!               SHA-256-checked download of the install script's tarball whose executable replaces this one in place
//!   npm global  the channel's npm dist-tag, then `npm install -g @opencode/browse@<version>` into the same prefix,
//!               with the npm of the node that runs the launcher (npm/browse.mjs)
//!   npx, a checkout build, anything else: no updates
//! The relay's background loop installs updates and restarts itself with the new executable once nothing is using the
//! browser.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::relay_api::{bin_root, paths};
use crate::{VERSION, session};

const RELEASE_SERVICE: &str = "https://anoma.ly/release";
const NPM_REGISTRY: &str = "https://registry.npmjs.org";
const PACKAGE: &str = "@opencode/browse";
const HOUR: Duration = Duration::from_secs(3600);
const EXECUTABLE: &str = if cfg!(windows) { "browse.exe" } else { "browse" };

/// How this browse was installed, which decides how it updates (cli/src/update/auto-update.ts `InstallKind`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Install {
    /// The executable the install script or `browse install` put in the bin folder.
    Binary(PathBuf),
    /// `npm install -g @opencode/browse`: the launcher runs its platform package's binary, which is this one.
    Npm(Npm),
    /// A temporary npx install, which npx resolves itself.
    Npx,
    /// A build in a checkout's cargo target folder.
    Checkout,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Npm {
    /// The @opencode/browse package folder in npm's global node_modules.
    pub package: PathBuf,
    /// The global prefix it's installed under, which updates install into (`npm install -g --prefix`).
    pub prefix: PathBuf,
    /// The node that ran the launcher: its npm installs updates.
    pub node: Option<PathBuf>,
    /// The platform package this binary came from (`browse-linux-x64`), preferred after an update.
    pub platform: String,
}

impl Install {
    pub fn name(&self) -> &'static str {
        match self {
            Install::Binary(_) => "binary",
            Install::Npm(_) => "npm",
            Install::Npx => "npx",
            Install::Checkout => "checkout",
            Install::Other => "other",
        }
    }

    pub fn updates_itself(&self) -> bool {
        matches!(self, Install::Binary(_) | Install::Npm(_))
    }

    /// The executable a relay of this install starts from now: an npm update may have replaced the platform package.
    pub fn executable(&self) -> Option<PathBuf> {
        match self {
            Install::Binary(binary) => Some(binary.clone()),
            Install::Npm(npm) => npm.binary(),
            _ => None,
        }
    }
}

impl Npm {
    /// The binary the launcher would run now: this platform package (or the other libc's, as the launcher falls back),
    /// nested in the package as `npm install -g` lays it out, or beside it.
    pub fn binary(&self) -> Option<PathBuf> {
        let mut names = vec![self.platform.clone()];
        if cfg!(target_os = "linux") {
            names.push(self.platform.strip_suffix("-musl").map_or_else(|| format!("{}-musl", self.platform), str::to_owned));
        }
        let scopes = [self.package.join("node_modules").join("@opencode"), self.package.parent()?.to_path_buf()];
        names.iter().flat_map(|name| scopes.iter().map(move |scope| scope.join(name).join("bin").join(EXECUTABLE))).find(|file| file.is_file())
    }

    /// The version of @opencode/browse installed now.
    pub fn version(&self) -> Option<String> {
        let manifest: Value = serde_json::from_slice(&std::fs::read(self.package.join("package.json")).ok()?).ok()?;
        manifest["version"].as_str().map(str::to_owned)
    }
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn named(path: Option<&Path>, name: &str) -> bool {
    path.and_then(Path::file_name).is_some_and(|n| n == name)
}

/// What kind of install the executable `exe` belongs to. `launcher` and `node` are what the npm launcher passes
/// (OPENCODE_BROWSER_NPM_LAUNCHER, OPENCODE_BROWSER_NPM_NODE); `installed` is the bin folder's executable.
pub fn detect(exe: &Path, launcher: Option<&Path>, node: Option<PathBuf>, installed: &Path) -> Install {
    let exe = canonical(exe);
    if installed.is_file() && canonical(installed) == exe {
        return Install::Binary(installed.to_path_buf());
    }
    if let Some(install) = npm_layout(&exe, launcher, node) {
        return install;
    }
    let checkout = exe.ancestors().any(|dir| dir.file_name().is_some_and(|n| n == "target") && dir.parent().is_some_and(|p| p.join("Cargo.toml").is_file()));
    if checkout { Install::Checkout } else { Install::Other }
}

/// An npm install of @opencode/browse whose platform package holds `exe`: `node_modules/@opencode/browse-<target>/bin/`,
/// nested in the launcher's package or beside it.
fn npm_layout(exe: &Path, launcher: Option<&Path>, node: Option<PathBuf>) -> Option<Install> {
    let bin = exe.parent().filter(|b| named(Some(b), "bin"))?;
    let platform_dir = bin.parent()?;
    let platform = platform_dir.file_name()?.to_str().filter(|n| n.starts_with("browse-"))?.to_owned();
    let scope = platform_dir.parent().filter(|s| named(Some(s), "@opencode"))?;
    let modules = scope.parent().filter(|m| named(Some(m), "node_modules"))?;
    // The launcher that ran this (its dist/cli.mjs), else the package an older launcher, which doesn't say, runs from.
    let given = launcher.and_then(|l| canonical(l).parent()?.parent().map(Path::to_path_buf));
    let candidates = [given, modules.parent().map(Path::to_path_buf), Some(scope.join("browse"))];
    let package = candidates.into_iter().flatten().find(|package| {
        let runs_this = package.join("node_modules").join("@opencode") == scope || package.parent() == Some(scope);
        named(Some(package), "browse") && named(package.parent(), "@opencode") && runs_this && package.join("dist").join("cli.mjs").is_file()
    })?;
    if package.components().any(|c| c.as_os_str() == "_npx") {
        return Some(Install::Npx);
    }
    // A global install: <prefix>/lib/node_modules (<prefix>/node_modules on Windows) with the bin links npm made. A
    // project's own node_modules has no global prefix to update.
    let global = package.parent()?.parent().filter(|g| named(Some(g), "node_modules"))?;
    let prefix = if cfg!(windows) { global.parent()? } else { global.parent().filter(|lib| named(Some(lib), "lib"))?.parent()? };
    let linked = ["browse", "opencode-browser"].iter().any(|name| {
        if cfg!(windows) { prefix.join(format!("{name}.cmd")).is_file() } else { std::fs::symlink_metadata(prefix.join("bin").join(name)).is_ok() }
    });
    if !linked {
        return Some(Install::Other);
    }
    Some(Install::Npm(Npm { package: package.clone(), prefix: prefix.to_path_buf(), node, platform }))
}

/// This process's install.
pub fn install() -> Install {
    let Ok(exe) = crate::relay::current_exe() else { return Install::Other };
    let launcher = std::env::var_os("OPENCODE_BROWSER_NPM_LAUNCHER").filter(|v| !v.is_empty()).map(PathBuf::from);
    let node = std::env::var_os("OPENCODE_BROWSER_NPM_NODE").filter(|v| !v.is_empty()).map(PathBuf::from);
    detect(&exe, launcher.as_deref(), node, &bin_root().join(EXECUTABLE))
}

/// The release service's name for this build's platform.
pub fn target() -> String {
    let os = if cfg!(target_os = "macos") { "macos" } else if cfg!(windows) { "windows" } else { "linux" };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    format!("{os}-{arch}{}", if cfg!(target_env = "musl") { "-musl" } else { "" })
}

pub fn channel() -> &'static str {
    if VERSION.contains("-dev.") {
        "dev"
    } else if VERSION.contains("-beta.") {
        "beta"
    } else {
        "stable"
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    On,
    Notify,
    Off,
}

impl Mode {
    fn parse(value: &str) -> Option<Mode> {
        match value.trim().to_lowercase().as_str() {
            "on" | "1" | "true" => Some(Mode::On),
            "notify" => Some(Mode::Notify),
            "off" | "0" | "false" => Some(Mode::Off),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Mode::On => "on",
            Mode::Notify => "notify",
            Mode::Off => "off",
        }
    }
}

/// OPENCODE_BROWSER_AUTO_UPDATE (or OPENCODE_BROWSER_UPDATE_CHECK=0) fixes the mode over the stored one.
pub fn override_mode() -> Option<Mode> {
    std::env::var("OPENCODE_BROWSER_AUTO_UPDATE").ok().and_then(|v| Mode::parse(&v)).or_else(|| {
        (std::env::var("OPENCODE_BROWSER_UPDATE_CHECK").as_deref() == Ok("0")).then_some(Mode::Off)
    })
}

pub fn stored_mode() -> Mode {
    state().get("mode").and_then(Value::as_str).and_then(Mode::parse).unwrap_or(Mode::On)
}

pub fn effective_mode() -> Mode {
    override_mode().unwrap_or_else(stored_mode)
}

pub fn set_mode(mode: Mode) -> anyhow::Result<()> {
    update_state(|state| state["mode"] = json!(mode.name()))
}

fn state_path() -> PathBuf {
    paths().auto_update()
}

pub fn state() -> Value {
    std::fs::read(state_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}))
}

pub fn update_state(change: impl FnOnce(&mut Value)) -> anyhow::Result<()> {
    let mut state = state();
    change(&mut state);
    write_private(&state_path(), format!("{:#}\n", state).as_bytes())
}

pub fn write_private(file: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let dir = file.parent().context("no parent folder")?;
    std::fs::create_dir_all(dir)?;
    let temporary = dir.join(format!(".{}.{}.tmp", file.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
    std::fs::write(&temporary, bytes)?;
    set_mode_bits(&temporary, 0o600);
    std::fs::rename(&temporary, file)?;
    Ok(())
}

fn set_mode_bits(_file: &Path, _mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(_file, std::fs::Permissions::from_mode(_mode));
    }
}

/// Orders versions as semver does for the shapes releases use: dev below beta below the release, then by run.
fn version_order(value: &str) -> Option<[u64; 6]> {
    let (core, pre) = value.split_once('-').map_or((value, None), |(c, p)| (c, Some(p)));
    let core: Vec<u64> = core.split('.').map(|n| n.parse().ok()).collect::<Option<_>>()?;
    let [major, minor, patch] = core[..] else { return None };
    let (stage, run, build) = match pre {
        None => (2, 0, 0),
        Some(pre) => {
            let mut parts = pre.split('.');
            let stage = match parts.next()? {
                "dev" => 0,
                "beta" => 1,
                _ => return None,
            };
            let run = parts.next()?.parse().ok()?;
            let build = parts.next().map(str::parse::<u64>).transpose().ok()?.unwrap_or(0);
            if parts.next().is_some() {
                return None;
            }
            (stage, run, build)
        }
    };
    Some([major, minor, patch, stage, run, build])
}

/// Whether `latest` is strictly newer than `current` (src/shared/protocol.ts `newerCliVersion`). Unlike there, an
/// unknown version shape is never newer: an update must not downgrade.
pub fn newer(latest: &str, current: &str) -> bool {
    match (version_order(latest), version_order(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// This install's rollout bucket: drawn once, 0–99, kept locally and never sent.
fn rollout_bucket() -> u64 {
    let file = paths().state.join("rollout-bucket");
    if let Some(saved) = std::fs::read_to_string(&file).ok().and_then(|s| s.trim().parse::<u64>().ok()).filter(|b| *b < 100) {
        return saved;
    }
    let bucket = session::random_u64() % 100;
    let _ = write_private(&file, format!("{bucket}\n").as_bytes());
    bucket
}

pub struct Release {
    pub version: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

pub enum Check {
    UpToDate(String),
    /// Released, but not for this install yet (a staged rollout) or not for this platform.
    Deferred(String),
    Available(Release),
}

fn service() -> String {
    std::env::var("OPENCODE_BROWSER_RELEASE_SERVICE").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| RELEASE_SERVICE.into()).trim_end_matches('/').to_owned()
}

fn curl(args: &[&str]) -> anyhow::Result<Vec<u8>> {
    let output = Command::new("curl")
        .args(["-fsSL", "--proto", "=https,http", "-H", &format!("user-agent: browse/{}/{VERSION}/cli", channel())])
        .args(args)
        .output()
        .context("curl is needed to download updates")?;
    if !output.status.success() {
        bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(output.stdout)
}

/// The channel's manifest, through the release protocol's client rules (cli/src/update/release-service.ts `decide`).
pub fn check() -> anyhow::Result<Check> {
    let channel = channel();
    let body = curl(&["--max-time", "30", &format!("{}/browse/cli/{channel}.json", service())])?;
    let manifest: Value = serde_json::from_slice(&body).context("the release manifest isn't JSON")?;
    let field = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    if manifest["schema"] != 1 || field(&manifest, "app").as_deref() != Some("browse") || field(&manifest, "artifact").as_deref() != Some("cli") {
        bail!("the release manifest is malformed");
    }
    if field(&manifest, "channel").as_deref() != Some(channel) {
        bail!("the release manifest is for another channel");
    }
    let release = &manifest["release"];
    let version = field(release, "version").context("the release manifest has no version")?;
    if !newer(&version, VERSION) {
        return Ok(Check::UpToDate(version));
    }
    let target_name = target();
    let Some(target) = release["targets"].get(&target_name) else { return Ok(Check::Deferred(version)) };
    let rollout = release["rollout_percent"].as_u64().unwrap_or(0);
    if release["required"] != true && rollout_bucket() >= rollout {
        return Ok(Check::Deferred(version));
    }
    let (Some(url), Some(size), Some(sha256)) = (field(target, "url"), target["size"].as_u64(), field(target, "sha256")) else {
        bail!("the release manifest's {target_name} target is malformed");
    };
    if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("the release manifest's {target_name} checksum is malformed");
    }
    Ok(Check::Available(Release { version, url, size, sha256: sha256.to_lowercase() }))
}

/// A manifest's file URL: the service gives a path on its own origin (`/release/files/...`), like the install script reads it.
fn file_url(url: &str) -> anyhow::Result<String> {
    if url.starts_with("https://") {
        return Ok(url.to_owned());
    }
    let service = service();
    let origin = service.strip_suffix("/release").context("OPENCODE_BROWSER_RELEASE_SERVICE must end in /release")?;
    if !url.starts_with('/') {
        bail!("unexpected download URL {url}");
    }
    Ok(format!("{origin}{url}"))
}

/// The tar that reads the release tarballs: Windows 10 and later ship bsdtar as System32\tar.exe (another tar on PATH,
/// like Git's, can't read C:\ paths).
fn tar() -> PathBuf {
    if cfg!(windows)
        && let Some(root) = std::env::var_os("SystemRoot")
    {
        let system = PathBuf::from(root).join("System32").join("tar.exe");
        if system.is_file() {
            return system;
        }
    }
    PathBuf::from("tar")
}

/// Downloads `release` (the install script's tarball, `package/bin/browse[.exe]`) beside `binary`, checks its size and
/// SHA-256, and swaps the executable in. A running relay keeps its old executable until it restarts.
pub fn install_binary(release: &Release, binary: &Path) -> anyhow::Result<()> {
    let dir = binary.parent().context("no parent folder")?;
    let work = dir.join(format!(".browse.{}.update", std::process::id()));
    let archive = work.join("browse.tgz");
    let staged = dir.join(format!(".browse.{}.new", std::process::id()));
    let result = (|| {
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work)?;
        curl(&["--max-time", "900", "-o", &archive.to_string_lossy(), &file_url(&release.url)?])?;
        let bytes = std::fs::read(&archive)?;
        if bytes.len() as u64 != release.size || session::hex(&Sha256::digest(&bytes)) != release.sha256 {
            bail!("the download of browse {} didn't match its checksum; nothing was installed", release.version);
        }
        drop(bytes);
        let entry = format!("package/bin/{}", if cfg!(windows) { "browse.exe" } else { "browse" });
        let output = Command::new(tar()).arg("-xzf").arg(&archive).arg("-C").arg(&work).arg(&entry).output().context("tar is needed to unpack updates")?;
        if !output.status.success() {
            bail!("couldn't unpack browse {}: {}", release.version, String::from_utf8_lossy(&output.stderr).trim());
        }
        std::fs::rename(work.join(&entry), &staged).with_context(|| format!("browse {}'s download has no {entry}", release.version))?;
        set_mode_bits(&staged, 0o755);
        if cfg!(windows) && binary.exists() {
            // A running .exe can be renamed but not replaced.
            for entry in std::fs::read_dir(dir)?.flatten() {
                if entry.file_name().to_string_lossy().starts_with("browse.exe.old-") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
            std::fs::rename(binary, dir.join(format!("browse.exe.old-{}", now_ms())))?;
        }
        std::fs::rename(&staged, binary)?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&staged);
    let _ = std::fs::remove_dir_all(&work);
    result
}

/// The npm dist-tag a build follows: `latest` for a release, `dev` or `beta` for those builds.
pub fn dist_tag(version: &str) -> &'static str {
    if version.contains("-dev.") {
        "dev"
    } else if version.contains("-beta.") {
        "beta"
    } else {
        "latest"
    }
}

/// Whether npm's `latest` (the channel's dist-tag) is an update for a relay running `running` while `on_disk` is
/// installed: newer than both, so it never downgrades and doesn't install what is already there.
pub fn npm_wanted(latest: &str, running: &str, on_disk: Option<&str>) -> bool {
    newer(latest, running) && on_disk.is_none_or(|disk| newer(latest, disk))
}

/// Runs `command` with no stdin, collecting its output, and kills it after `timeout`.
fn run(mut command: Command, timeout: Duration) -> anyhow::Result<std::process::Output> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The relay has no console; don't let npm open one.
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn()?;
    let pipe = |mut from: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = from.read_to_end(&mut bytes);
            bytes
        })
    };
    let stdout = pipe(Box::new(child.stdout.take().context("no stdout")?));
    let stderr = pipe(Box::new(child.stderr.take().context("no stderr")?));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("it didn't finish within {} minutes", timeout.as_secs() / 60);
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    Ok(std::process::Output { status, stdout: stdout.join().unwrap_or_default(), stderr: stderr.join().unwrap_or_default() })
}

/// npm, as the node that runs the launcher has it (npm's own CLI beside it, with that node first on PATH), else the
/// npm on PATH.
fn npm_command(npm: &Npm) -> Command {
    if let Some(node) = npm.node.as_ref().filter(|n| n.is_file())
        && let Some(dir) = node.parent()
    {
        let candidates = [dir.join("node_modules/npm/bin/npm-cli.js"), dir.join("../lib/node_modules/npm/bin/npm-cli.js")];
        if let Some(cli) = candidates.into_iter().find(|c| c.is_file()) {
            let mut command = Command::new(node);
            command.arg(cli);
            let path = std::env::var_os("PATH").unwrap_or_default();
            if let Ok(joined) = std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&path))) {
                command.env("PATH", joined);
            }
            return command;
        }
    }
    // Rust runs (and quotes the arguments of) a .cmd through cmd.exe itself.
    Command::new(if cfg!(windows) { "npm.cmd" } else { "npm" })
}

fn registry_override() -> Option<String> {
    std::env::var("OPENCODE_BROWSER_NPM_REGISTRY").ok().map(|r| r.trim().trim_end_matches('/').to_owned()).filter(|r| !r.is_empty())
}

/// The registry npm installs @opencode/browse from: OPENCODE_BROWSER_NPM_REGISTRY, else npm's configuration (the
/// @opencode scope's registry, else the default one), else npmjs.org.
fn registry(npm: &Npm) -> String {
    if let Some(registry) = registry_override() {
        return registry;
    }
    let configured = |key: &str| {
        let mut command = npm_command(npm);
        command.args(["config", "get", key]);
        let output = run(command, Duration::from_secs(20)).ok().filter(|o| o.status.success())?;
        let value = String::from_utf8_lossy(&output.stdout).trim().trim_end_matches('/').to_owned();
        (value.starts_with("https://") || value.starts_with("http://")).then_some(value)
    };
    configured("@opencode:registry").or_else(|| configured("registry")).unwrap_or_else(|| NPM_REGISTRY.into())
}

/// The version this build's dist-tag points at.
pub fn npm_latest(npm: &Npm) -> anyhow::Result<String> {
    let tag = dist_tag(VERSION);
    let url = format!("{}/{}", registry(npm), PACKAGE.replace('/', "%2f"));
    let body = curl(&["--max-time", "30", "-H", "accept: application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8", &url])?;
    let packument: Value = serde_json::from_slice(&body).with_context(|| format!("{url} isn't a package's JSON"))?;
    packument["dist-tags"][tag].as_str().map(str::to_owned).with_context(|| format!("{PACKAGE} has no {tag} dist-tag"))
}

/// The version an executable reports (`--version`).
fn executable_version(file: &Path) -> Option<String> {
    let mut command = Command::new(file);
    command.arg("--version").env("OPENCODE_BROWSER_AUTOSTART", "0");
    let output = run(command, Duration::from_secs(30)).ok().filter(|o| o.status.success())?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!version.is_empty()).then_some(version)
}

/// `npm install -g @opencode/browse@<version>` into this install's prefix. Returns the version its binary reports.
pub fn npm_install(npm: &Npm, version: &str) -> anyhow::Result<String> {
    let spec = format!("{PACKAGE}@{version}");
    let mut command = npm_command(npm);
    command.args(["install", "--global", "--prefix"]).arg(&npm.prefix).args(["--no-fund", "--no-audit", "--no-update-notifier", &spec]);
    if let Some(registry) = registry_override() {
        command.arg(format!("--registry={registry}")).arg(format!("--@opencode:registry={registry}"));
    }
    let stashed = stash_running(npm);
    let output = run(command, Duration::from_secs(600)).map_err(|error| anyhow::anyhow!("npm install -g {spec} couldn't run: {error}"));
    let output = match output {
        Ok(output) if output.status.success() => output,
        failed => {
            if let Some((from, to)) = stashed {
                let _ = std::fs::rename(to, from);
            }
            let output = failed?;
            let text = if output.stderr.iter().any(|b| !b.is_ascii_whitespace()) { &output.stderr } else { &output.stdout };
            let text = String::from_utf8_lossy(text);
            let mut message = format!("npm install -g {spec} failed: {}", npm_error(&text));
            if text.contains("EACCES") || text.contains("EPERM") {
                message.push_str(&format!(
                    " (npm can't write to {}: run `npm install -g {PACKAGE}@latest` yourself, or `browse install` to switch to the self-updating binary)",
                    npm.prefix.display()
                ));
            }
            bail!(message);
        }
    };
    drop(output);
    let binary = npm.binary().with_context(|| format!("npm install -g {spec} ran, but {} has no browse binary for this computer", npm.package.display()))?;
    let installed = executable_version(&binary).with_context(|| format!("npm install -g {spec} ran, but {} doesn't run", binary.display()))?;
    if newer(version, &installed) {
        bail!("npm install -g {spec} left {installed}, not the requested {version}");
    }
    Ok(installed)
}

/// The gist of npm's error output: its error code and the first line that explains it.
fn npm_error(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(|l| l.trim().trim_start_matches("npm error").trim_start_matches("npm ERR!").trim())
        .filter(|l| !l.is_empty() && !l.starts_with("A complete log of this run"))
        .collect();
    let code = lines.iter().find_map(|l| l.strip_prefix("code "));
    let detail = lines.iter().find(|l| !["code ", "syscall ", "path ", "dest ", "errno "].iter().any(|p| l.starts_with(p))).or(lines.last());
    match (code, detail) {
        (Some(code), Some(detail)) if !detail.contains(code) => format!("{code}: {detail}"),
        (_, Some(detail)) => detail.to_string(),
        _ => "it printed nothing".into(),
    }
}

/// Windows can't delete a running executable, which npm must do to replace the package: move it out of the way first
/// (renaming a running .exe works). Returns where it went, to put it back if npm fails.
fn stash_running(npm: &Npm) -> Option<(PathBuf, PathBuf)> {
    if !cfg!(windows) {
        return None;
    }
    let running = npm.binary()?;
    let dir = paths().state.join("npm-old");
    if let Ok(entries) = std::fs::read_dir(&dir) {
        // Earlier ones that no process runs anymore.
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    std::fs::create_dir_all(&dir).ok()?;
    let to = dir.join(format!("browse-{}.exe", now_ms()));
    std::fs::rename(&running, &to).ok()?;
    Some((running, to))
}

/// `browse update` for an npm install: the channel's dist-tag, then npm.
fn npm_command_update(npm: &Npm, check_only: bool) -> anyhow::Result<()> {
    let tag = dist_tag(VERSION);
    let latest = npm_latest(npm)?;
    update_state(|s| {
        s["checkedAt"] = json!(now_ms());
        s["latest"] = json!(latest);
        s.as_object_mut().map(|o| o.remove("failed"));
    })?;
    let on_disk = npm.version();
    if !newer(&latest, VERSION) {
        println!("browse {VERSION} is up to date ({PACKAGE}@{tag} is {latest}).");
    } else if !npm_wanted(&latest, VERSION, on_disk.as_deref()) {
        println!("browse {latest} is installed; the relay switches to it as soon as no agent is using the browser.");
    } else if check_only {
        println!("browse {latest} is available (running {VERSION}). Run `browse update`.");
    } else {
        println!("Installing browse {latest} with npm…");
        let installed = npm_install(npm, &latest)?;
        record_install(&installed)?;
        println!("✓ Updated browse {VERSION} → {installed}");
        if matches!(crate::relay::probe(), crate::relay::Probe::Running(_)) {
            println!("The relay switches to it as soon as no agent is using the browser.");
        }
    }
    Ok(())
}

/// `browse update [--check]`.
pub fn command(args: &[String]) -> anyhow::Result<()> {
    let check_only = args.iter().any(|a| a == "--check");
    let mode = args.iter().position(|a| a == "--mode").and_then(|i| args.get(i + 1));
    if let Some(mode) = mode {
        let mode = Mode::parse(mode).context("--mode is on, notify or off")?;
        set_mode(mode)?;
        println!("Automatic updates: {}", describe_mode(mode));
        if let Some(fixed) = override_mode().filter(|m| *m != mode) {
            println!("! OPENCODE_BROWSER_AUTO_UPDATE keeps it {} in this environment.", fixed.name());
        }
        return Ok(());
    }
    let binary = match install() {
        Install::Npm(npm) => return npm_command_update(&npm, check_only),
        Install::Npx => {
            println!("This is an npx run: npx resolves {PACKAGE} itself, so there is nothing to update here.");
            println!("Run `npx {PACKAGE}@{} install` once to get the self-updating binary.", dist_tag(VERSION));
            return Ok(());
        }
        Install::Binary(binary) => Some(binary),
        Install::Checkout | Install::Other => None,
    };
    match check()? {
        Check::UpToDate(version) if version == VERSION => println!("browse {VERSION} is up to date ({} channel).", channel()),
        Check::UpToDate(version) => println!("browse {VERSION} is up to date ({} channel's latest release is {version}).", channel()),
        Check::Deferred(version) => println!("browse {version} is out, but not for this install yet. Running {VERSION}."),
        Check::Available(release) if check_only => println!("browse {} is available (running {VERSION}). Run `browse update`.", release.version),
        Check::Available(release) => {
            let binary = match binary {
                Some(binary) => binary,
                None => bail!("this browse isn't an installed binary ({}); run `browse install` first", crate::relay::current_exe()?.display()),
            };
            println!("Downloading browse {}…", release.version);
            install_binary(&release, &binary)?;
            record_install(&release.version)?;
            println!("✓ Updated browse {VERSION} → {}", release.version);
            if matches!(crate::relay::probe(), crate::relay::Probe::Running(_)) {
                println!("The relay switches to it as soon as no agent is using the browser.");
            }
        }
    }
    Ok(())
}

fn record_install(version: &str) -> anyhow::Result<()> {
    update_state(|s| {
        s["lastUpdate"] = json!({ "from": VERSION, "to": version, "at": now_ms() });
        if let Some(o) = s.as_object_mut() {
            for key in ["lastError", "latest", "failed"] {
                o.remove(key);
            }
        }
    })
}

/// A newer release this install hasn't taken, when updates are notify-only: `(summary, command)`.
pub fn pending_notice() -> Option<(String, String)> {
    if effective_mode() != Mode::Notify || !install().updates_itself() {
        return None;
    }
    let latest = state().get("latest")?.as_str()?.to_owned();
    newer(&latest, VERSION).then(|| (format!("browse {latest} is available (running {VERSION})"), "browse update".to_owned()))
}

/// What the extension's options page shows about updates (cli/src/update/auto-update.ts `AutoUpdateStatus`).
pub fn status_json() -> Value {
    let state = state();
    let install = install();
    let stored = stored_mode();
    // The command that runs this install's CLI in a terminal (cli/src/paths.ts `cliPrefix`).
    let cli = match &install {
        Install::Npx if dist_tag(VERSION) == "latest" => format!("npx {PACKAGE}"),
        Install::Npx => format!("npx {PACKAGE}@{}", dist_tag(VERSION)),
        Install::Checkout => crate::relay::current_exe().map(|exe| exe.display().to_string()).unwrap_or_else(|_| "browse".into()),
        _ => "browse".into(),
    };
    let mut status = json!({
        "install": install.name(),
        "cli": cli,
        "mode": stored.name(),
        "effective": if install.updates_itself() { effective_mode().name() } else { "off" },
        "version": VERSION,
        "channel": channel(),
    });
    if override_mode().is_some() {
        let by = if std::env::var_os("OPENCODE_BROWSER_AUTO_UPDATE").is_some() { "OPENCODE_BROWSER_AUTO_UPDATE" } else { "OPENCODE_BROWSER_UPDATE_CHECK" };
        status["overriddenBy"] = json!(by);
    }
    if let Some(latest) = state.get("latest").and_then(Value::as_str).filter(|l| newer(l, VERSION)) {
        status["latest"] = json!(latest);
    }
    for key in ["latestAt", "checkedAt"] {
        if let Some(ms) = state.get(key).and_then(Value::as_u64) {
            status[key] = json!(iso(ms));
        }
    }
    if let Some(error) = state.get("lastError") {
        status["lastError"] = error.clone();
    }
    status
}

/// Milliseconds since the epoch as ISO 8601 UTC.
fn iso(ms: u64) -> String {
    let (days, rest) = ((ms / 86_400_000) as i64, ms % 86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (h, m, s, milli) = (rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{milli:03}Z")
}

pub fn describe_mode(mode: Mode) -> &'static str {
    match mode {
        Mode::On => "automatic",
        Mode::Notify => "notify only",
        Mode::Off => "off",
    }
}

pub fn describe() -> String {
    let install = install();
    match install {
        Install::Npx => return format!("npx resolves {PACKAGE} itself; run `browse install` for automatic updates"),
        Install::Checkout => return "a build from a checkout; it doesn't update itself".into(),
        Install::Other => return "not an installed binary; run `browse install`".into(),
        Install::Binary(_) | Install::Npm(_) => {}
    }
    let mode = effective_mode();
    let state = state();
    let source = if matches!(install, Install::Npm(_)) { format!("npm {PACKAGE}@{}", dist_tag(VERSION)) } else { format!("{} channel", channel()) };
    let mut line = format!("{} ({source})", describe_mode(mode));
    if let Some(latest) = state.get("latest").and_then(Value::as_str).filter(|l| newer(l, VERSION)) {
        line.push_str(&format!(", {latest} available"));
    }
    if let Some(error) = state.get("lastError").and_then(|e| e.get("message")).and_then(Value::as_str) {
        line.push_str(&format!(", last attempt failed: {error}"));
    }
    line
}

fn fingerprint(file: &Path) -> Option<(u64, SystemTime)> {
    let meta = std::fs::metadata(file).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// The relay's updater: checks this install's channel at launch and at most hourly in its own thread, and in "on"
/// mode installs what it finds (an npm install only while nothing is using the browser, as npm replaces the package
/// in steps). `replacement` says when the executable on disk is no longer the one this relay runs (this updater's
/// install, `browse update`, or npm run by hand) and can take over.
pub struct Updater {
    install: Install,
    started: Option<(u64, SystemTime)>,
    /// The last changed file asked its version, and whether it can replace this relay.
    seen: Option<((u64, SystemTime), bool)>,
    installing: Arc<AtomicBool>,
}

/// What a check found to install.
enum Found {
    Binary(Release),
    Npm(String),
}

impl Updater {
    /// `idle` says whether nothing is using the browser.
    pub fn spawn(idle: Arc<dyn Fn() -> bool + Send + Sync>) -> Option<Updater> {
        let install = install();
        let started = fingerprint(&install.executable()?);
        let interval = std::env::var("OPENCODE_BROWSER_AUTO_UPDATE_INTERVAL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .map(Duration::from_millis)
            .unwrap_or(HOUR)
            .min(HOUR);
        let installing = Arc::new(AtomicBool::new(false));
        let worker = Worker { install: install.clone(), interval, idle, installing: installing.clone(), checked: None, failed: None };
        std::thread::spawn(move || worker.run());
        Some(Updater { install, started, seen: None, installing })
    }

    /// The executable to restart the relay with, once a different, working build replaced this relay's on disk.
    pub fn replacement(&mut self) -> Option<PathBuf> {
        if self.installing.load(Ordering::SeqCst) {
            return None;
        }
        let file = self.install.executable()?;
        let print = fingerprint(&file)?;
        if Some(print) == self.started {
            return None;
        }
        if self.seen.is_none_or(|(seen, _)| seen != print) {
            self.seen = Some((print, executable_version(&file).is_some_and(|v| v != VERSION)));
        }
        self.seen.is_some_and(|(_, ready)| ready).then_some(file)
    }
}

struct Worker {
    install: Install,
    interval: Duration,
    idle: Arc<dyn Fn() -> bool + Send + Sync>,
    installing: Arc<AtomicBool>,
    checked: Option<Instant>,
    /// When the last npm install failed, to back off before trying the same version again.
    failed: Option<Instant>,
}

impl Worker {
    fn run(mut self) {
        // npm installs wait for an idle moment, so look more often than the channel is checked.
        let tick = self.interval.min(Duration::from_secs(300));
        std::thread::sleep(Duration::from_secs(60).min(self.interval));
        loop {
            let mode = effective_mode();
            if mode != Mode::Off
                && let Err(error) = self.tick(mode)
            {
                let _ = update_state(|s| s["failed"] = json!(error.to_string()));
            }
            std::thread::sleep(tick);
        }
    }

    fn tick(&mut self, mode: Mode) -> anyhow::Result<()> {
        if self.checked.is_none_or(|at| at.elapsed() >= self.interval) {
            self.checked = Some(Instant::now());
            let found = match &self.install {
                Install::Binary(_) => match check()? {
                    Check::Available(release) => Some(Found::Binary(release)),
                    _ => None,
                },
                Install::Npm(npm) => Some(npm_latest(npm)?).filter(|latest| newer(latest, VERSION)).map(Found::Npm),
                _ => None,
            };
            record_check(found.as_ref().map(|f| match f {
                Found::Binary(release) => release.version.as_str(),
                Found::Npm(version) => version.as_str(),
            }))?;
            if mode == Mode::On
                && let (Some(Found::Binary(release)), Install::Binary(binary)) = (&found, &self.install)
            {
                install_binary(release, binary).inspect_err(|error| record_failure(&release.version, error))?;
                record_install(&release.version)?;
            }
        }
        if mode == Mode::On
            && let Install::Npm(npm) = self.install.clone()
        {
            self.npm_tick(&npm)?;
        }
        Ok(())
    }

    /// Installs the npm release a check found, once nothing is using the browser.
    fn npm_tick(&mut self, npm: &Npm) -> anyhow::Result<()> {
        let state = state();
        let Some(latest) = state.get("latest").and_then(Value::as_str).filter(|l| npm_wanted(l, VERSION, npm.version().as_deref())) else {
            return Ok(());
        };
        if state.pointer("/lastError/version").and_then(Value::as_str) == Some(latest) {
            let attempts = state.pointer("/lastError/attempts").and_then(Value::as_u64).unwrap_or(1);
            let backoff = Duration::from_secs(60 * if attempts <= 1 { 15 } else if attempts == 2 { 60 } else { 240 });
            if self.failed.is_some_and(|at| at.elapsed() < backoff.min(self.interval)) {
                return Ok(());
            }
        }
        if !(self.idle)() {
            return Ok(());
        }
        self.installing.store(true, Ordering::SeqCst);
        let result = npm_install(npm, latest);
        self.installing.store(false, Ordering::SeqCst);
        match result {
            Ok(installed) => record_install(&installed),
            Err(error) => {
                self.failed = Some(Instant::now());
                record_failure(latest, &error);
                Ok(())
            }
        }
    }
}

/// A check's result: the release to install, or none.
fn record_check(found: Option<&str>) -> anyhow::Result<()> {
    update_state(|s| {
        s["checkedAt"] = json!(now_ms());
        match found {
            Some(version) => {
                if s.get("latest").and_then(Value::as_str) != Some(version) {
                    s["latestAt"] = json!(now_ms());
                }
                s["latest"] = json!(version);
                s.as_object_mut().map(|o| o.remove("failed"));
            }
            None => {
                if let Some(o) = s.as_object_mut() {
                    for key in ["latest", "latestAt", "failed"] {
                        o.remove(key);
                    }
                }
            }
        }
    })
}

/// A failed install of `version`, as the options page shows it (auto-update.json `lastError`).
fn record_failure(version: &str, error: &anyhow::Error) {
    let state = state();
    let previous = (state.pointer("/lastError/version").and_then(Value::as_str) == Some(version)).then(|| state.pointer("/lastError/attempts").and_then(Value::as_u64)).flatten();
    let at = iso(now_ms());
    let _ = update_state(|s| s["lastError"] = json!({ "message": format!("{error:#}"), "version": version, "at": at, "attempts": previous.unwrap_or(0) + 1 }));
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{EXECUTABLE, Install, Npm, detect, dist_tag, newer, npm_wanted};

    #[test]
    fn npm_follows_its_dist_tag_and_never_downgrades() {
        assert_eq!(dist_tag("0.1.0"), "latest");
        assert_eq!(dist_tag("0.1.1-dev.57"), "dev");
        assert_eq!(dist_tag("0.1.1-beta.2"), "beta");
        assert!(npm_wanted("0.1.1", "0.1.0", Some("0.1.0")));
        assert!(npm_wanted("0.1.1-dev.58", "0.1.1-dev.57", None));
        assert!(!npm_wanted("0.1.0", "0.1.0", Some("0.1.0")), "the same version");
        assert!(!npm_wanted("0.0.17", "0.1.0", Some("0.1.0")), "a dist-tag moved back");
        assert!(!npm_wanted("0.1.1", "0.1.0", Some("0.1.1")), "already installed, waiting for the relay to switch");
        assert!(!npm_wanted("0.1.1", "0.1.0", Some("0.1.2")), "something newer is installed");
        assert!(!npm_wanted("0.1.1-dev.3", "0.1.1", None), "a dev build is older than its release");
        assert!(!npm_wanted("latest", "0.1.0", None));
    }

    #[test]
    fn npm_errors_keep_the_gist() {
        let eacces = "npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/lib/node_modules/@opencode\nnpm error errno -13\nnpm error Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/@opencode'\nnpm error\nnpm error The operation was rejected by your operating system.\nnpm error A complete log of this run can be found in: /x.log\n";
        assert_eq!(super::npm_error(eacces), "Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/@opencode'");
        let missing = "npm error code ETARGET\nnpm error notarget No matching version found for @opencode/browse@9.9.9.\nnpm error A complete log of this run can be found in: /x.log\n";
        assert_eq!(super::npm_error(missing), "ETARGET: notarget No matching version found for @opencode/browse@9.9.9.");
        assert_eq!(super::npm_error(""), "it printed nothing");
    }

    struct Dir(PathBuf);

    impl Dir {
        fn new(name: &str) -> Dir {
            let dir = std::env::temp_dir().join(format!("browse-update-test-{name}-{}", crate::session::random_u64()));
            std::fs::create_dir_all(&dir).unwrap();
            Dir(std::fs::canonicalize(dir).unwrap())
        }
        fn file(&self, path: &str) -> PathBuf {
            let file = self.0.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, "{\"version\":\"0.1.0\"}").unwrap();
            file
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A global npm install under `<prefix>/lib/node_modules`, with its platform package nested or hoisted. Returns
    /// (launcher, binary).
    #[cfg(unix)]
    fn npm_global(dir: &Dir, prefix: &str, hoisted: bool) -> (PathBuf, PathBuf) {
        let package = format!("{prefix}/lib/node_modules/@opencode/browse");
        let launcher = dir.file(&format!("{package}/dist/cli.mjs"));
        dir.file(&format!("{package}/package.json"));
        let platform = if hoisted { format!("{prefix}/lib/node_modules/@opencode/browse-linux-x64") } else { format!("{package}/node_modules/@opencode/browse-linux-x64") };
        let binary = dir.file(&format!("{platform}/bin/{EXECUTABLE}"));
        std::os::unix::fs::symlink(&launcher, dir.file(&format!("{prefix}/bin/.keep")).with_file_name("browse")).unwrap();
        (launcher, binary)
    }

    #[cfg(unix)]
    #[test]
    fn detects_a_global_npm_install() {
        let dir = Dir::new("npm");
        let installed = dir.0.join("home/.local/bin/browse");
        let (launcher, binary) = npm_global(&dir, "prefix", false);
        let expected = Install::Npm(Npm {
            package: dir.0.join("prefix/lib/node_modules/@opencode/browse"),
            prefix: dir.0.join("prefix"),
            node: Some("/usr/bin/node".into()),
            platform: "browse-linux-x64".into(),
        });
        assert_eq!(detect(&binary, Some(&launcher), Some("/usr/bin/node".into()), &installed), expected);
        let Install::Npm(npm) = &expected else { unreachable!() };
        assert_eq!(npm.binary(), Some(binary.clone()));
        assert_eq!(npm.version().as_deref(), Some("0.1.0"));
        // An older launcher doesn't say where it is; the package is found around the binary.
        let Install::Npm(found) = detect(&binary, None, None, &installed) else { panic!("not npm") };
        assert_eq!(found.package, npm.package);
        // A launcher that isn't the one running this binary (an inherited variable) doesn't make it npm's.
        let other = Dir::new("other");
        assert_eq!(detect(&other.file("browse"), Some(&launcher), None, &installed), Install::Other);

        let hoisted = Dir::new("hoisted");
        let (launcher, binary) = npm_global(&hoisted, "usr", true);
        let Install::Npm(npm) = detect(&binary, Some(&launcher), None, &installed) else { panic!("not npm") };
        assert_eq!((npm.binary(), npm.prefix), (Some(binary), hoisted.0.join("usr")));
    }

    #[cfg(unix)]
    #[test]
    fn a_platform_package_after_an_update() {
        let dir = Dir::new("moved");
        let (launcher, binary) = npm_global(&dir, "prefix", false);
        let Install::Npm(npm) = detect(&binary, Some(&launcher), None, Path::new("/nonexistent/browse")) else { panic!("not npm") };
        // npm picked the other libc's package this time.
        std::fs::remove_dir_all(binary.parent().unwrap().parent().unwrap()).unwrap();
        assert_eq!(npm.binary(), None);
        let musl = dir.file(&format!("prefix/lib/node_modules/@opencode/browse/node_modules/@opencode/browse-linux-x64-musl/bin/{EXECUTABLE}"));
        assert_eq!(npm.binary(), cfg!(target_os = "linux").then_some(musl));
    }

    #[test]
    fn detects_the_other_installs() {
        let dir = Dir::new("kinds");
        let installed = dir.file("home/.local/bin/browse");
        assert_eq!(detect(&installed, None, None, &installed), Install::Binary(installed.clone()));
        // npx: a package in npm's temporary cache.
        let launcher = dir.file("home/.npm/_npx/4d2a/node_modules/@opencode/browse/dist/cli.mjs");
        let binary = dir.file(&format!("home/.npm/_npx/4d2a/node_modules/@opencode/browse-linux-x64/bin/{EXECUTABLE}"));
        assert_eq!(detect(&binary, Some(&launcher), None, &installed), Install::Npx);
        // A project's own node_modules: no global prefix to update.
        let launcher = dir.file("project/node_modules/@opencode/browse/dist/cli.mjs");
        let binary = dir.file(&format!("project/node_modules/@opencode/browse-linux-x64/bin/{EXECUTABLE}"));
        assert_eq!(detect(&binary, Some(&launcher), None, &installed), Install::Other);
        dir.file("checkout/rust/Cargo.toml");
        assert_eq!(detect(&dir.file("checkout/rust/target/debug/browse"), None, None, &installed), Install::Checkout);
        assert_eq!(detect(&dir.file("checkout/rust/target/x86_64-unknown-linux-musl/release/browse"), None, None, &installed), Install::Checkout);
        assert_eq!(detect(&dir.file("Downloads/browse"), None, None, &installed), Install::Other);
    }

    #[test]
    fn only_newer_versions() {
        assert!(!newer("0.0.17", "0.1.0"));
        assert!(!newer("0.1.0", "0.1.0"));
        assert!(newer("0.1.1", "0.1.0"));
        assert!(newer("0.1.0", "0.1.0-beta.3"));
        assert!(newer("0.1.0-beta.1", "0.1.0-dev.9"));
        assert!(newer("0.1.0-dev.2.1", "0.1.0-dev.2"));
        assert!(!newer("garbage", "0.1.0"));
        assert!(!newer("0.2.0", "local"));
    }
}
