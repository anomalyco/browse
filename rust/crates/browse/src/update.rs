//! Updates for a binary install (cli/src/update/**): the release service's manifest for this build's channel, the
//! protocol's client rules, a size- and SHA-256-checked download that replaces the executable in place, and the
//! relay's background loop that installs updates and restarts itself with them once nothing is using the browser.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::relay_api::{bin_root, paths};
use crate::{VERSION, session};

const RELEASE_SERVICE: &str = "https://anoma.ly/release";
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

/// The executable an install put in the bin folder, when this process is it: only that one updates itself.
pub fn installed_binary() -> Option<PathBuf> {
    let installed = bin_root().join(if cfg!(windows) { "browse.exe" } else { "browse" });
    let running = crate::relay::current_exe().ok()?;
    let same = std::fs::canonicalize(&installed).ok()? == std::fs::canonicalize(&running).unwrap_or(running);
    same.then_some(installed)
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

/// Downloads `release` beside `binary`, checks its size and SHA-256, and swaps it in. A running relay keeps its old
/// executable until it restarts.
pub fn install(release: &Release, binary: &Path) -> anyhow::Result<()> {
    let dir = binary.parent().context("no parent folder")?;
    let staged = dir.join(format!(".browse.{}.new", std::process::id()));
    let staged_text = staged.to_string_lossy().into_owned();
    let result = (|| {
        curl(&["--max-time", "900", "-o", &staged_text, &release.url])?;
        let bytes = std::fs::read(&staged)?;
        if bytes.len() as u64 != release.size || session::hex(&Sha256::digest(&bytes)) != release.sha256 {
            bail!("the download of browse {} didn't match its checksum; nothing was installed", release.version);
        }
        drop(bytes);
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
    result
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
    let binary = installed_binary();
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
            install(&release, &binary)?;
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
    if effective_mode() != Mode::Notify || installed_binary().is_none() {
        return None;
    }
    let latest = state().get("latest")?.as_str()?.to_owned();
    newer(&latest, VERSION).then(|| (format!("browse {latest} is available (running {VERSION})"), "browse update".to_owned()))
}

/// What the extension's options page shows about updates (cli/src/update/auto-update.ts `AutoUpdateStatus`).
pub fn status_json() -> Value {
    let state = state();
    let installed = installed_binary().is_some();
    let stored = stored_mode();
    let mut status = json!({
        "install": if installed { "binary" } else { "other" },
        "cli": "browse",
        "mode": stored.name(),
        "effective": if installed { effective_mode().name() } else { "off" },
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
    if installed_binary().is_none() {
        return "not an installed binary; run `browse install`".into();
    }
    let mode = effective_mode();
    let state = state();
    let mut line = format!("{} ({} channel)", describe_mode(mode), channel());
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

/// The relay's updater: checks the channel at most hourly in its own thread and installs in "on" mode. `changed`
/// says when the executable on disk is no longer the one this relay runs (this updater's install, or `browse update`).
pub struct Updater {
    binary: PathBuf,
    started: Option<(u64, SystemTime)>,
}

impl Updater {
    pub fn spawn() -> Option<Updater> {
        let binary = installed_binary()?;
        let interval = std::env::var("OPENCODE_BROWSER_AUTO_UPDATE_INTERVAL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .map(Duration::from_millis)
            .unwrap_or(HOUR)
            .min(HOUR);
        let target = binary.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(60).min(interval));
            loop {
                let mode = effective_mode();
                if mode != Mode::Off
                    && let Err(error) = tick(mode, &target)
                {
                    let _ = update_state(|s| s["failed"] = json!(error.to_string()));
                }
                std::thread::sleep(interval);
            }
        });
        Some(Updater { started: fingerprint(&binary), binary })
    }

    pub fn changed(&self) -> bool {
        fingerprint(&self.binary) != self.started
    }
}

fn tick(mode: Mode, binary: &Path) -> anyhow::Result<()> {
    let Check::Available(release) = check()? else {
        return update_state(|s| {
            s["checkedAt"] = json!(now_ms());
            if let Some(o) = s.as_object_mut() {
                for key in ["latest", "latestAt", "failed"] {
                    o.remove(key);
                }
            }
        });
    };
    update_state(|s| {
        if s.get("latest").and_then(Value::as_str) != Some(&release.version) {
            s["latestAt"] = json!(now_ms());
        }
        s["checkedAt"] = json!(now_ms());
        s["latest"] = json!(release.version);
        s.as_object_mut().map(|o| o.remove("failed"));
    })?;
    if mode != Mode::On {
        return Ok(());
    }
    if let Err(error) = install(&release, binary) {
        let attempts = state().pointer("/lastError/attempts").and_then(Value::as_u64).unwrap_or(0) + 1;
        let at = iso(now_ms());
        update_state(|s| s["lastError"] = json!({ "message": error.to_string(), "version": release.version, "at": at, "attempts": attempts }))?;
        return Err(error);
    }
    record_install(&release.version)
}

#[cfg(test)]
mod tests {
    use super::newer;

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
