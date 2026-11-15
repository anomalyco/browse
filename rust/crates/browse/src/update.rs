//! Updates (cli/src/update/**), by how browse was installed (method.rs):
//!   binary      the release service's manifest for this build's channel, the protocol's client rules, a size- and
//!               SHA-256-checked download of the install script's tarball whose executable replaces this one in place
//!   global      the channel's npm dist-tag (latest, dev, beta) from the registry the user's configuration names, then
//!               the package manager that installed it: `npm install -g`, `bun add -g`, `pnpm add -g`,
//!               `yarn global add` or `volta install` of @opencode/browse@<version> into the same folder
//!   runner      npx, bunx, pnpm dlx and yarn dlx resolve the package themselves: a newer release is only told
//!   a checkout build, anything else: no updates
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

pub use crate::method::{Global, Install, Launcher, Manager, dist_tag, install};
use crate::method::{PACKAGE, npm_command};
use crate::relay_api::paths;
use crate::{VERSION, session};

const RELEASE_SERVICE: &str = "https://anoma.ly/release";
const NPM_REGISTRY: &str = "https://registry.npmjs.org";
const HOUR: Duration = Duration::from_secs(3600);

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

fn registry_override() -> Option<String> {
    std::env::var("OPENCODE_BROWSER_NPM_REGISTRY").ok().map(|r| r.trim().trim_end_matches('/').to_owned()).filter(|r| !r.is_empty())
}

fn registry_url(value: &str) -> Option<String> {
    let value = value.trim().trim_matches('"').trim().trim_end_matches('/');
    (value.starts_with("https://") || value.starts_with("http://")).then(|| value.to_owned())
}

/// bun's own registry setting: BUN_CONFIG_REGISTRY, else `registry = "<url>"` in a bunfig.toml of the user's.
fn bun_registry() -> Option<String> {
    if let Some(registry) = std::env::var("BUN_CONFIG_REGISTRY").ok().and_then(|r| registry_url(&r)) {
        return Some(registry);
    }
    let home = crate::setup::home();
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".config"));
    [xdg.join(".bunfig.toml"), home.join(".bunfig.toml")].iter().filter_map(|file| std::fs::read_to_string(file).ok()).find_map(|text| {
        text.lines().find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == "registry").then(|| registry_url(value)).flatten()
        })
    })
}

/// The registry @opencode/browse installs from: OPENCODE_BROWSER_NPM_REGISTRY, else bun's own setting for bun, else
/// npm's configuration (the @opencode scope's registry, else the default one; pnpm, yarn and volta read the same
/// .npmrc), else npmjs.org.
fn registry(manager: Option<&Manager>, launcher: &Launcher) -> String {
    if let Some(registry) = registry_override() {
        return registry;
    }
    if (matches!(manager, Some(Manager::Bun { .. })) || launcher.bun.is_some())
        && let Some(registry) = bun_registry()
    {
        return registry;
    }
    let configured = |key: &str| {
        let mut command = npm_command(launcher.node.as_deref());
        command.args(["config", "get", key]);
        let output = run(command, Duration::from_secs(20)).ok().filter(|o| o.status.success())?;
        registry_url(&String::from_utf8_lossy(&output.stdout))
    };
    configured("@opencode:registry").or_else(|| configured("registry")).unwrap_or_else(|| NPM_REGISTRY.into())
}

/// The version this build's dist-tag points at in `registry`.
pub fn registry_latest(registry: &str) -> anyhow::Result<String> {
    let tag = dist_tag(VERSION);
    let url = format!("{registry}/{}", PACKAGE.replace('/', "%2f"));
    let body = curl(&["--max-time", "30", "-H", "accept: application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8", &url])?;
    let packument: Value = serde_json::from_slice(&body).with_context(|| format!("{url} isn't a package's JSON"))?;
    packument["dist-tags"][tag].as_str().map(str::to_owned).with_context(|| format!("{PACKAGE} has no {tag} dist-tag"))
}

pub fn package_latest(global: &Global) -> anyhow::Result<String> {
    registry_latest(&registry(Some(&global.manager), &global.launcher))
}

/// The version an executable reports (`--version`).
fn executable_version(file: &Path) -> Option<String> {
    let mut command = Command::new(file);
    command.arg("--version").env("OPENCODE_BROWSER_AUTOSTART", "0");
    let output = run(command, Duration::from_secs(30)).ok().filter(|o| o.status.success())?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!version.is_empty()).then_some(version)
}

/// Installs @opencode/browse@<version> into this global install with its package manager. Returns the version its
/// binary reports.
pub fn package_install(global: &Global, version: &str) -> anyhow::Result<String> {
    let words = global.manager.words(version);
    let command = global.command(version, registry_override().as_deref());
    let stashed = stash_running(global);
    let output = run(command, Duration::from_secs(600)).map_err(|error| anyhow::anyhow!("{words} couldn't run: {error}"));
    let output = match output {
        Ok(output) if output.status.success() => output,
        failed => {
            if let Some((from, to)) = stashed {
                let _ = std::fs::rename(to, from);
            }
            let output = failed?;
            let text = if output.stderr.iter().any(|b| !b.is_ascii_whitespace()) { &output.stderr } else { &output.stdout };
            let text = String::from_utf8_lossy(text);
            let gist = match global.manager {
                Manager::Npm { .. } | Manager::Pnpm { .. } => npm_error(&text),
                _ => tool_error(&text),
            };
            let mut message = format!("{words} failed: {gist}");
            if text.contains("EACCES") || text.contains("EPERM") {
                message.push_str(&format!(
                    " ({} can't write to {}: run `{}` yourself, or `browse install` to switch to the self-updating binary)",
                    global.manager.name(),
                    global.manager.folder().display(),
                    global.manager.words(dist_tag(VERSION)),
                ));
            }
            bail!(message);
        }
    };
    drop(output);
    let binary = global.binary().with_context(|| format!("{words} ran, but {} has no browse binary for this computer", global.package.display()))?;
    let installed = executable_version(&binary).with_context(|| format!("{words} ran, but {} doesn't run", binary.display()))?;
    if newer(version, &installed) {
        bail!("{words} left {installed}, not the requested {version}");
    }
    Ok(installed)
}

/// The gist of npm's (or pnpm's) error output: its error code and the first line that explains it.
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

/// The gist of bun's, yarn's or volta's error output: its first `error:` line, else its last line.
fn tool_error(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let error = lines.iter().find_map(|l| l.strip_prefix("error:").or_else(|| l.strip_prefix("error "))).map(str::trim);
    error.or(lines.last().copied()).map_or_else(|| "it printed nothing".into(), str::to_owned)
}

/// Windows can't delete a running executable, which the package manager must do to replace the package: move it out
/// of the way first (renaming a running .exe works). Returns where it went, to put it back if the install fails.
fn stash_running(global: &Global) -> Option<(PathBuf, PathBuf)> {
    if !cfg!(windows) {
        return None;
    }
    let running = global.binary()?;
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

/// `browse update` for a global install: the channel's dist-tag, then its package manager.
fn package_command_update(global: &Global, check_only: bool) -> anyhow::Result<()> {
    let tag = dist_tag(VERSION);
    let latest = package_latest(global)?;
    update_state(|s| {
        s["checkedAt"] = json!(now_ms());
        s["latest"] = json!(latest);
        s.as_object_mut().map(|o| o.remove("failed"));
    })?;
    let on_disk = global.version();
    if !newer(&latest, VERSION) {
        println!("browse {VERSION} is up to date ({PACKAGE}@{tag} is {latest}).");
    } else if !npm_wanted(&latest, VERSION, on_disk.as_deref()) {
        println!("browse {latest} is installed; the relay switches to it as soon as no agent is using the browser.");
    } else if check_only {
        println!("browse {latest} is available (running {VERSION}). Run `browse update`.");
    } else {
        println!("Installing browse {latest} with {}…", global.manager.name());
        let installed = package_install(global, &latest)?;
        record_install(&installed)?;
        println!("✓ Updated browse {VERSION} → {installed}");
        if matches!(crate::relay::probe(), crate::relay::Probe::Running(_)) {
            println!("The relay switches to it as soon as no agent is using the browser.");
        }
    }
    Ok(())
}

/// How to switch an install that doesn't update itself to one that does.
fn switch_hint(exe: &Path) -> String {
    let tag = dist_tag(VERSION);
    let globals = ["npm install -g", "bun add -g", "pnpm add -g", "yarn global add", "volta install"].map(|c| format!("`{c} {PACKAGE}@{tag}`")).join(", ");
    format!("run `{} install` for the self-updating binary, or install it globally with one of {globals}", exe.display())
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
        Install::Global(global) => return package_command_update(&global, check_only),
        Install::Runner(runner) => {
            let tag = dist_tag(VERSION);
            println!("This is a {} run: it resolves {PACKAGE} itself, so there is nothing to update here.", runner.name().replace('-', " "));
            match registry_latest(&registry(None, &Launcher::from_env())) {
                Ok(latest) if newer(&latest, VERSION) => println!("browse {latest} is out (running {VERSION}); `{}` runs it.", runner.run(tag)),
                Ok(_) => println!("browse {VERSION} is up to date."),
                Err(error) => println!("! couldn't check for a newer release: {error:#}"),
            }
            println!("For automatic updates run `{} install` once (the self-updating binary), or install it globally: `{}`.", runner.run(tag), runner.global_words(tag));
            return Ok(());
        }
        Install::Other => {
            let exe = crate::relay::current_exe()?;
            println!("{} wasn't installed in a way browse can update.", exe.display());
            println!("For automatic updates, {}.", switch_hint(&exe));
            return Ok(());
        }
        Install::Binary(binary) => Some(binary),
        Install::Checkout => None,
    };
    match check()? {
        Check::UpToDate(version) if version == VERSION => println!("browse {VERSION} is up to date ({} channel).", channel()),
        Check::UpToDate(version) => println!("browse {VERSION} is up to date ({} channel's latest release is {version}).", channel()),
        Check::Deferred(version) => println!("browse {version} is out, but not for this install yet. Running {VERSION}."),
        Check::Available(release) if check_only => println!("browse {} is available (running {VERSION}). Run `browse update`.", release.version),
        Check::Available(release) => {
            let binary = match binary {
                Some(binary) => binary,
                None => bail!("this browse is a checkout build ({}); rebuild it, or run `browse install` for the self-updating binary", crate::relay::current_exe()?.display()),
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

/// A newer release this install hasn't taken: `(summary, command)`. A self-updating install tells it when updates
/// are notify-only; a package runner, which can't update, whenever updates aren't off.
pub fn pending_notice() -> Option<(String, String)> {
    let mode = effective_mode();
    let command = match install() {
        Install::Binary(_) | Install::Global(_) if mode == Mode::Notify => "browse update".to_owned(),
        Install::Runner(runner) if mode != Mode::Off => format!("{} install", runner.run(dist_tag(VERSION))),
        _ => return None,
    };
    let latest = state().get("latest")?.as_str()?.to_owned();
    newer(&latest, VERSION).then(|| (format!("browse {latest} is available (running {VERSION})"), command))
}

/// What the extension's options page shows about updates (cli/src/update/auto-update.ts `AutoUpdateStatus`).
/// `install` is the closest kind extensions before `method` know; `updateCommand` is this install's exact command.
pub fn status_json() -> Value {
    let state = state();
    let install = install();
    let stored = stored_mode();
    let exe = crate::relay::current_exe().unwrap_or_else(|_| "browse".into());
    // The command that runs this install's CLI in a terminal (cli/src/paths.ts `cliPrefix`).
    let cli = match &install {
        Install::Runner(runner) => runner.run(dist_tag(VERSION)),
        Install::Checkout => exe.display().to_string(),
        _ => "browse".into(),
    };
    let mut status = json!({
        "install": install.compatible_name(),
        "method": install.name(),
        "updateCommand": install.update_command(VERSION, &exe),
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
    let state = state();
    let latest = state.get("latest").and_then(Value::as_str).filter(|l| newer(l, VERSION));
    let tag = dist_tag(VERSION);
    let source = match &install {
        Install::Runner(runner) => {
            let mut line = format!("{} resolves {PACKAGE} itself, so it doesn't update", runner.name().replace('-', " "));
            if let Some(latest) = latest {
                line.push_str(&format!(" ({latest} is out)"));
            }
            line.push_str(&format!("; for automatic updates run `{} install` or `{}`", runner.run(tag), runner.global_words(tag)));
            return line;
        }
        Install::Checkout => return "a build from a checkout; it doesn't update itself".into(),
        Install::Other => {
            let exe = crate::relay::current_exe().unwrap_or_else(|_| "browse".into());
            return format!("not installed in a way that updates; {}", switch_hint(&exe));
        }
        Install::Global(global) => format!("{} {PACKAGE}@{tag}", global.manager.name()),
        Install::Binary(_) => format!("{} channel", channel()),
    };
    let mut line = format!("{} ({source})", describe_mode(effective_mode()));
    if let Some(latest) = latest {
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
/// mode installs what it finds (a package manager's install only while nothing is using the browser, as they replace
/// the package in steps). `replacement` says when the executable on disk is no longer the one this relay runs (this
/// updater's install, `browse update`, or a package manager run by hand) and can take over. A package runner's relay
/// only checks, for the notice.
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
    Package(String),
}

impl Updater {
    /// `idle` says whether nothing is using the browser.
    pub fn spawn(idle: Arc<dyn Fn() -> bool + Send + Sync>) -> Option<Updater> {
        let install = install();
        let started = match &install {
            Install::Binary(_) | Install::Global(_) => Some(fingerprint(&install.executable()?)),
            Install::Runner(_) => None,
            Install::Checkout | Install::Other => return None,
        };
        let interval = std::env::var("OPENCODE_BROWSER_AUTO_UPDATE_INTERVAL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .map(Duration::from_millis)
            .unwrap_or(HOUR)
            .min(HOUR);
        let installing = Arc::new(AtomicBool::new(false));
        let worker = Worker { install: install.clone(), interval, idle, installing: installing.clone(), checked: None, failed: None };
        std::thread::spawn(move || worker.run());
        Some(Updater { install, started: started.flatten(), seen: None, installing })
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
    /// When the last package manager install failed, to back off before trying the same version again.
    failed: Option<Instant>,
}

impl Worker {
    fn run(mut self) {
        // Package manager installs wait for an idle moment, so look more often than the channel is checked.
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
                Install::Global(global) => Some(package_latest(global)?).filter(|latest| newer(latest, VERSION)).map(Found::Package),
                Install::Runner(_) => Some(registry_latest(&registry(None, &Launcher::from_env()))?).filter(|latest| newer(latest, VERSION)).map(Found::Package),
                _ => None,
            };
            record_check(found.as_ref().map(|f| match f {
                Found::Binary(release) => release.version.as_str(),
                Found::Package(version) => version.as_str(),
            }))?;
            if mode == Mode::On
                && let (Some(Found::Binary(release)), Install::Binary(binary)) = (&found, &self.install)
            {
                install_binary(release, binary).inspect_err(|error| record_failure(&release.version, error))?;
                record_install(&release.version)?;
            }
        }
        if mode == Mode::On
            && let Install::Global(global) = self.install.clone()
        {
            self.package_tick(&global)?;
        }
        Ok(())
    }

    /// Installs the release a check found with the package manager, once nothing is using the browser.
    fn package_tick(&mut self, global: &Global) -> anyhow::Result<()> {
        let state = state();
        let Some(latest) = state.get("latest").and_then(Value::as_str).filter(|l| npm_wanted(l, VERSION, global.version().as_deref())) else {
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
        let result = package_install(global, latest);
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
    use super::{dist_tag, newer, npm_wanted};

    #[test]
    fn packages_follow_their_dist_tag_and_never_downgrade() {
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

    #[test]
    fn other_tools_errors_keep_the_gist() {
        let bun = "bun add v1.4.4 (abc)\n  🔍 Resolving [1/1]\nerror: No version matching \"9.9.9\" found for specifier \"@opencode/browse\" (but package exists)\nerror: @opencode/browse@9.9.9 failed to resolve\n";
        assert_eq!(super::tool_error(bun), "No version matching \"9.9.9\" found for specifier \"@opencode/browse\" (but package exists)");
        let yarn = "yarn global v1.22.22\n[1/4] Resolving packages...\nerror Couldn't find any versions for \"@opencode/browse\" that matches \"9.9.9\"\ninfo Visit https://yarnpkg.com/en/docs/cli/global for documentation about this command.\n";
        assert_eq!(super::tool_error(yarn), "Couldn't find any versions for \"@opencode/browse\" that matches \"9.9.9\"");
        assert_eq!(super::tool_error("something odd\nlast line\n"), "last line");
        assert_eq!(super::tool_error(" \n"), "it printed nothing");
    }

    #[test]
    fn registry_settings_read_as_urls() {
        assert_eq!(super::registry_url(" \"https://npm.example.com/\" ").as_deref(), Some("https://npm.example.com"));
        assert_eq!(super::registry_url("http://127.0.0.1:4873/\n").as_deref(), Some("http://127.0.0.1:4873"));
        assert_eq!(super::registry_url("undefined"), None);
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
