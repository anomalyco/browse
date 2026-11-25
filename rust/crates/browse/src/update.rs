//! Updates (cli/src/update/**), by how browse was installed (method.rs):
//!   binary      the release service's manifest for this build's channel, the protocol's client rules, a size- and
//!               SHA-256-checked download of the install script's tarball whose executable replaces this one in place
//!   global      the same manifest (rollout and required included), then the package manager that installed it:
//!               `npm install -g`, `bun add -g`, `pnpm add -g`, `yarn global add` or `volta install` of
//!               @opencode/browse@<the manifest's version> into the same folder; npm can lag the service by a few
//!               minutes, and a version its registry doesn't have yet is simply tried again later
//!   runner      npx, bunx, pnpm dlx and yarn dlx resolve the package themselves: the manifest only says another release
//!               is out
//!   a checkout build, anything else: no updates
//! Every check sends `browse/<channel>/<version>/cli/<install kind>` as its User-Agent: the protocol allows segments
//! after the tool, and the last one lets the service's analytics split installs by how they update.
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
use ureq::tls::{RootCerts, TlsConfig};

pub use crate::method::{Global, Install, Manager, dist_tag, install};
use crate::method::{PACKAGE, Runner};
use crate::relay_api::paths;
use crate::protocol::{self, Decision};
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

/// The message from the last background check that failed (`auto-update.json` `failed`), cleared by the next check
/// that works. Unlike `lastError`, which is about installing a release, this is about reaching the release service.
fn check_failure(state: &Value) -> Option<&str> {
    state.get("failed").and_then(Value::as_str)
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

/// How this install updates, as the manifest check's User-Agent names it (`browse/<channel>/<version>/cli/<kind>`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Binary,
    Npm,
    Bun,
    Pnpm,
    Yarn,
    Volta,
    Npx,
    Bunx,
    PnpmDlx,
    YarnDlx,
    /// A build from a checkout: it doesn't update, but `browse update` still checks the channel for it, with no kind.
    Checkout,
    /// An install browse didn't make: its relay checks in, and never installs.
    Other,
}

impl Kind {
    fn of(install: &Install) -> Kind {
        match install {
            Install::Binary(_) => Kind::Binary,
            Install::Global(Global { manager: Manager::Npm { .. }, .. }) => Kind::Npm,
            Install::Global(Global { manager: Manager::Bun { .. }, .. }) => Kind::Bun,
            Install::Global(Global { manager: Manager::Pnpm { .. }, .. }) => Kind::Pnpm,
            Install::Global(Global { manager: Manager::Yarn { .. }, .. }) => Kind::Yarn,
            Install::Global(Global { manager: Manager::Volta { .. }, .. }) => Kind::Volta,
            Install::Runner(Runner::Npx) => Kind::Npx,
            Install::Runner(Runner::Bunx) => Kind::Bunx,
            Install::Runner(Runner::PnpmDlx) => Kind::PnpmDlx,
            Install::Runner(Runner::YarnDlx) => Kind::YarnDlx,
            Install::Checkout => Kind::Checkout,
            Install::Other => Kind::Other,
        }
    }

    /// The last User-Agent segment. The protocol's fourth segment names the tool (`cli`); kinds follow it, and a
    /// checkout build, which has none, sends the three-segment form older clients use.
    fn name(self) -> Option<&'static str> {
        match self {
            Kind::Binary => Some("binary"),
            Kind::Npm => Some("npm"),
            Kind::Bun => Some("bun"),
            Kind::Pnpm => Some("pnpm"),
            Kind::Yarn => Some("yarn"),
            Kind::Volta => Some("volta"),
            Kind::Npx => Some("npx"),
            Kind::Bunx => Some("bunx"),
            Kind::PnpmDlx => Some("pnpm-dlx"),
            Kind::YarnDlx => Some("yarn-dlx"),
            Kind::Other => Some("other"),
            Kind::Checkout => None,
        }
    }

    fn user_agent(self) -> String {
        let channel = channel();
        match self.name() {
            Some(kind) => format!("browse/{channel}/{VERSION}/cli/{kind}"),
            None => format!("browse/{channel}/{VERSION}/cli"),
        }
    }
}

pub struct Release {
    pub version: String,
    /// The channel's tarball for this build's platform: what a binary install downloads, `None` for every other kind.
    pub file: Option<ReleaseFile>,
}

pub struct ReleaseFile {
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

/// The client every update request uses: this install's User-Agent, `timeout`, and the given roots. The platform
/// store (and `SSL_CERT_FILE`/`SSL_CERT_DIR` on Linux) is what lets updates work behind a TLS-inspecting proxy whose
/// root isn't one of the bundled ones.
fn agent(kind: Kind, timeout: Duration, roots: RootCerts) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .user_agent(kind.user_agent())
        .tls_config(TlsConfig::builder().root_certs(roots).build())
        .build()
        .into()
}

/// Whether a failed request is worth retrying with the bundled roots: the system has no CA bundle (a slim container, an
/// empty `SSL_CERT_FILE`) or its chain rejected the certificate. A handshake rejection arrives wrapped as
/// `Io(InvalidData, rustls::Error::InvalidCertificate)`, not `Error::Rustls`. Timeouts, DNS, connections, HTTP
/// statuses and other IO errors never retry, so a broken download isn't restarted.
fn should_fall_back(error: &ureq::Error) -> bool {
    match error {
        ureq::Error::Rustls(_) | ureq::Error::Tls(_) => true,
        ureq::Error::Io(error) => matches!(
            error.get_ref().and_then(|inner| inner.downcast_ref::<rustls::Error>()),
            Some(rustls::Error::InvalidCertificate(_))
        ),
        _ => false,
    }
}

/// One request with `agent`, failing on an error status, a body over `limit` bytes or `timeout`.
fn fetch(agent: &ureq::Agent, url: &str, limit: u64) -> Result<Vec<u8>, ureq::Error> {
    let mut response = agent.get(url).call()?;
    response.body_mut().with_config().limit(limit).read_to_vec()
}

/// GETs `url`, first against this computer's trusted certificates, then against the bundled roots (the trust the
/// updater had before it used the platform store) when the system has none or rejects the chain. If the fallback fails
/// too, the error that explains it wins: the fallback's for a machine with no roots, the platform's for a rejection.
fn get(kind: Kind, url: &str, timeout: Duration, limit: u64) -> anyhow::Result<Vec<u8>> {
    let error = match fetch(&agent(kind, timeout, RootCerts::PlatformVerifier), url, limit) {
        Ok(body) => return Ok(body),
        Err(error) => error,
    };
    if should_fall_back(&error) {
        match fetch(&agent(kind, timeout, RootCerts::WebPki), url, limit) {
            Ok(body) => return Ok(body),
            // No platform roots at all: the fallback's error (network, chain) is the real cause.
            Err(fallback) if matches!(error, ureq::Error::Rustls(_)) => {
                return Err(anyhow::Error::new(fallback).context(format!("couldn't get {url}")));
            }
            Err(_) => {}
        }
    }
    Err(anyhow::Error::new(error).context(format!("couldn't get {url}")))
}

/// The channel's manifest, through the release protocol's client rules (protocol.rs). A binary install takes the
/// manifest's file for this platform; a package install or runner takes the release's version (the package manager is
/// asked for it), so it checks as `unknown`.
pub fn check(install: &Install) -> anyhow::Result<Check> {
    let kind = Kind::of(install);
    let channel = channel();
    let body = get(kind, &format!("{}/browse/cli/{channel}.json", service()), Duration::from_secs(30), 1024 * 1024)?;
    let body = String::from_utf8(body).context("the release manifest isn't text")?;
    let target = target();
    let running = protocol::Running {
        version: VERSION,
        target: &target,
        distribution: if kind == Kind::Binary { "direct" } else { "unknown" },
        bucket: rollout_bucket(),
        sha256: None,
        channel: None,
    };
    let version = || serde_json::from_str::<Value>(&body).ok().and_then(|m| m["release"]["version"].as_str().map(str::to_owned)).unwrap_or_default();
    Ok(match protocol::decide("browse", "cli", channel, &body, &running) {
        Decision::Reject("malformed") => bail!("the release manifest is malformed"),
        Decision::Reject("wrong_channel") => bail!("the release manifest is for another channel"),
        Decision::Reject(reason) => bail!("the release manifest doesn't fit this install ({reason})"),
        Decision::None("up_to_date") => Check::UpToDate(version()),
        Decision::None(_) => Check::Deferred(version()),
        Decision::Install { version, target, .. } => Check::Available(Release { version, file: Some(ReleaseFile { url: target.url, size: target.size, sha256: target.sha256 }) }),
        Decision::Notify { version, .. } => Check::Available(Release { version, file: None }),
    })
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
    let file = release.file.as_ref().context("the release manifest has no download for this platform")?;
    let dir = binary.parent().context("no parent folder")?;
    let work = dir.join(format!(".browse.{}.update", std::process::id()));
    let archive = work.join("browse.tgz");
    let staged = dir.join(format!(".browse.{}.new", std::process::id()));
    let result = (|| {
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work)?;
        let bytes = get(Kind::Binary, &file_url(&file.url)?, Duration::from_secs(900), file.size + 1)?;
        std::fs::write(&archive, &bytes)?;
        if bytes.len() as u64 != file.size || session::hex(&Sha256::digest(&bytes)) != file.sha256 {
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

/// Whether the channel's release is an update for a relay running `running` while `on_disk` is installed: neither is
/// it (versions are only tested for equality, so a rollback is an update too).
pub fn package_wanted(latest: &str, running: &str, on_disk: Option<&str>) -> bool {
    latest != running && on_disk != Some(latest)
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

/// The version an executable reports (`--version`).
fn executable_version(file: &Path) -> Option<String> {
    let mut command = Command::new(file);
    command.arg("--version").env("OPENCODE_BROWSER_AUTOSTART", "0");
    let output = run(command, Duration::from_secs(30)).ok().filter(|o| o.status.success())?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!version.is_empty()).then_some(version)
}

pub enum Installed {
    /// The version its binary reports.
    Version(String),
    /// The package manager doesn't have this version yet: npm's registry lags the release service after a release.
    NotYet,
}

/// Whether a package manager's output says it doesn't have that version: npm's ETARGET, bun's "No version matching",
/// yarn's "Couldn't find any versions", pnpm's ERR_PNPM_NO_MATCHING_VERSION. A release is on the service a few minutes
/// before npm, so this is a wait, not a failure.
fn not_published(text: &str) -> bool {
    ["ETARGET", "No matching version", "No version matching", "Couldn't find any versions", "ERR_PNPM_NO_MATCHING_VERSION"].iter().any(|needle| text.contains(needle))
}

/// Installs @opencode/browse@<version> into this global install with its package manager.
pub fn package_install(global: &Global, version: &str) -> anyhow::Result<Installed> {
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
            if not_published(&text) {
                return Ok(Installed::NotYet);
            }
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
    if installed != version {
        bail!("{words} left {installed}, not the requested {version}");
    }
    Ok(Installed::Version(installed))
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

/// `browse update` for a global install: the channel's manifest, then its package manager.
fn package_command_update(install: &Install, global: &Global, check_only: bool) -> anyhow::Result<()> {
    let channel = channel();
    match check(install)? {
        Check::UpToDate(version) => {
            record_check(None)?;
            if version == VERSION {
                println!("browse {VERSION} is up to date ({channel} channel).");
            } else {
                println!("browse {VERSION} is up to date ({channel} channel's latest release is {version}).");
            }
        }
        Check::Deferred(version) => {
            record_check(None)?;
            println!("browse {version} is out, but not for this install yet. Running {VERSION}.");
        }
        Check::Available(release) => {
            let latest = release.version;
            record_check(Some(&latest))?;
            let on_disk = global.version();
            if !package_wanted(&latest, VERSION, on_disk.as_deref()) {
                println!("browse {latest} is installed; the relay switches to it as soon as no agent is using the browser.");
            } else if check_only {
                println!("browse {latest} is available (running {VERSION}). Run `browse update`.");
            } else {
                println!("Installing browse {latest} with {}…", global.manager.name());
                match package_install(global, &latest)? {
                    Installed::Version(installed) => {
                        record_install(&installed)?;
                        println!("✓ Updated browse {VERSION} → {installed}");
                        if matches!(crate::relay::probe(), crate::relay::Probe::Running(_)) {
                            println!("The relay switches to it as soon as no agent is using the browser.");
                        }
                    }
                    Installed::NotYet => {
                        record_pending(&latest)?;
                        println!("browse {latest} is out, but {} doesn't have {PACKAGE}@{latest} yet; trying again shortly.", global.manager.name());
                    }
                }
            }
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

/// The value of `--mode`, if given. A `--mode` with no value is an error, not a manual update.
fn mode_arg(args: &[String]) -> anyhow::Result<Option<Mode>> {
    let Some(i) = args.iter().position(|a| a == "--mode") else { return Ok(None) };
    let value = args.get(i + 1).context("--mode needs a value: on, notify or off")?;
    Mode::parse(value).map(Some).context("--mode is on, notify or off")
}

/// `browse update [--check]`.
pub fn command(args: &[String]) -> anyhow::Result<()> {
    let check_only = args.iter().any(|a| a == "--check");
    if let Some(mode) = mode_arg(args)? {
        set_mode(mode)?;
        println!("Automatic updates: {}", describe_mode(mode));
        if let Some(fixed) = override_mode().filter(|m| *m != mode) {
            println!("! OPENCODE_BROWSER_AUTO_UPDATE keeps it {} in this environment.", fixed.name());
        }
        return Ok(());
    }
    let install = install();
    let binary = match &install {
        Install::Global(global) => return package_command_update(&install, global, check_only),
        Install::Runner(runner) => {
            let tag = dist_tag(VERSION);
            println!("This is a {} run: it resolves {PACKAGE} itself, so there is nothing to update here.", runner.name().replace('-', " "));
            match check(&install) {
                Ok(Check::Available(release)) => println!("browse {} is out (running {VERSION}); `{}` runs it.", release.version, runner.run(tag)),
                Ok(Check::Deferred(version)) => println!("browse {version} is out, but not for everyone yet. Running {VERSION}."),
                Ok(Check::UpToDate(_)) => println!("browse {VERSION} is up to date."),
                Err(error) => println!("! couldn't check for a release: {error:#}"),
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
        Install::Binary(binary) => Some(binary.clone()),
        Install::Checkout => None,
    };
    let checked = check(&install)?;
    // A manual check that reached the service clears a stale `failed` from the background loop, as the package manager
    // path does. A checkout build doesn't check in.
    if !matches!(install, Install::Checkout) {
        let _ = record_check(match &checked {
            Check::Available(release) => Some(release.version.as_str()),
            Check::UpToDate(_) | Check::Deferred(_) => None,
        });
    }
    match checked {
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
            for key in ["lastError", "latest", "failed", "pending"] {
                o.remove(key);
            }
        }
    })
}

/// The channel's release, when this install hasn't taken it: `(summary, command)`. A self-updating install tells it when updates
/// are notify-only; a package runner, which can't update, whenever updates aren't off.
pub fn pending_notice() -> Option<(String, String)> {
    let mode = effective_mode();
    let command = match install() {
        Install::Binary(_) | Install::Global(_) if mode == Mode::Notify => "browse update".to_owned(),
        Install::Runner(runner) if mode != Mode::Off => format!("{} install", runner.run(dist_tag(VERSION))),
        _ => return None,
    };
    let latest = state().get("latest")?.as_str()?.to_owned();
    (latest != VERSION).then(|| (format!("browse {latest} is available (running {VERSION})"), command))
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
    if let Some(latest) = state.get("latest").and_then(Value::as_str).filter(|l| *l != VERSION) {
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
    if let Some(failed) = check_failure(&state) {
        status["checkFailed"] = json!(failed);
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
    let latest = state.get("latest").and_then(Value::as_str).filter(|l| *l != VERSION);
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
    } else if let Some(failed) = check_failure(&state) {
        line.push_str(&format!(", last check failed: {failed}"));
    }
    line
}

fn fingerprint(file: &Path) -> Option<(u64, SystemTime)> {
    let meta = std::fs::metadata(file).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// The relay's updater: checks this install's channel at launch and hourly in its own thread, in every mode, and in
/// "on" mode installs what it finds (a package manager's install only while nothing is using the browser, as they replace
/// the package in steps). `replacement` says when the executable on disk is no longer the one this relay runs (this
/// updater's install, `browse update`, or a package manager run by hand) and can take over. A package runner's relay
/// only checks, for the notice.
pub struct Updater {
    install: Install,
    /// Whether this relay can install and restart: a self-updating install whose executable resolved at launch.
    updates: bool,
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
    /// `idle` says whether nothing is using the browser. Every relay but a checkout build's checks in.
    pub fn spawn(idle: Arc<dyn Fn() -> bool + Send + Sync>) -> Option<Updater> {
        let (updater, worker) = Updater::new(install(), idle)?;
        std::thread::spawn(move || worker.run());
        Some(updater)
    }

    fn new(install: Install, idle: Arc<dyn Fn() -> bool + Send + Sync>) -> Option<(Updater, Worker)> {
        if install == Install::Checkout {
            return None;
        }
        // An install whose executable can't be found still checks in; it just doesn't install or restart.
        let executable = install.executable();
        let updates = matches!(install, Install::Binary(_) | Install::Global(_)) && executable.is_some();
        let started = executable.as_deref().and_then(fingerprint);
        let interval = std::env::var("OPENCODE_BROWSER_AUTO_UPDATE_INTERVAL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .map(Duration::from_millis)
            .unwrap_or(HOUR)
            .min(HOUR);
        let installing = Arc::new(AtomicBool::new(false));
        let worker = Worker { install: install.clone(), updates, interval, idle, installing: installing.clone(), checked: None, failed: None };
        Some((Updater { install, updates, started, seen: None, installing }, worker))
    }

    /// The executable to restart the relay with, once a different, working build replaced this relay's on disk.
    pub fn replacement(&mut self) -> Option<PathBuf> {
        if !self.updates || self.installing.load(Ordering::SeqCst) {
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
    updates: bool,
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
        loop {
            self.tick(effective_mode());
            std::thread::sleep(tick);
        }
    }

    fn tick(&mut self, mode: Mode) {
        if self.checked.is_none_or(|at| at.elapsed() >= self.interval) {
            // A failed check (no network yet) is tried again on the next tick, not an hour later.
            let checked = match check(&self.install) {
                Ok(checked) => checked,
                Err(error) => {
                    // Only reaching the release service is a check failure; installs write `lastError` instead.
                    let _ = update_state(|s| s["failed"] = json!(format!("{error:#}")));
                    return;
                }
            };
            self.checked = Some(Instant::now());
            let found = match checked {
                Check::Available(release) if matches!(&self.install, Install::Binary(_)) => Some(Found::Binary(release)),
                Check::Available(release) => Some(Found::Package(release.version)),
                Check::UpToDate(_) | Check::Deferred(_) => None,
            };
            let _ = record_check(found.as_ref().map(|f| match f {
                Found::Binary(release) => release.version.as_str(),
                Found::Package(version) => version.as_str(),
            }));
            if mode == Mode::On
                && self.updates
                && let (Some(Found::Binary(release)), Install::Binary(binary)) = (&found, &self.install)
            {
                match install_binary(release, binary) {
                    Ok(()) => {
                        let _ = record_install(&release.version);
                    }
                    Err(error) => record_failure(&release.version, &error),
                }
            }
        }
        if mode == Mode::On
            && self.updates
            && let Install::Global(global) = self.install.clone()
        {
            let _ = self.package_tick(&global);
        }
    }

    /// Installs the release a check found with the package manager, once nothing is using the browser.
    fn package_tick(&mut self, global: &Global) -> anyhow::Result<()> {
        let state = state();
        let Some(latest) = state.get("latest").and_then(Value::as_str).filter(|l| package_wanted(l, VERSION, global.version().as_deref())) else {
            return Ok(());
        };
        if state.pointer("/lastError/version").and_then(Value::as_str) == Some(latest) {
            let attempts = state.pointer("/lastError/attempts").and_then(Value::as_u64).unwrap_or(1);
            if self.failed.is_some_and(|at| at.elapsed() < retry_delay(attempts).min(self.interval)) {
                return Ok(());
            }
        } else if state.pointer("/pending/version").and_then(Value::as_str) == Some(latest) {
            // The package manager didn't have it yet: retry on the same backoff, without telling the user.
            let attempts = state.pointer("/pending/attempts").and_then(Value::as_u64).unwrap_or(1);
            let at = state.pointer("/pending/at").and_then(Value::as_u64).unwrap_or(0);
            if Duration::from_millis(now_ms().saturating_sub(at)) < retry_delay(attempts).min(self.interval) {
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
            Ok(Installed::Version(installed)) => record_install(&installed),
            Ok(Installed::NotYet) => record_pending(latest),
            Err(error) => {
                self.failed = Some(Instant::now());
                record_failure(latest, &error);
                Ok(())
            }
        }
    }
}

/// The wait before trying the same package version again: npm's registry can need a few minutes to have a release the
/// release service already has.
fn retry_delay(attempts: u64) -> Duration {
    Duration::from_secs(60 * if attempts <= 1 { 15 } else if attempts == 2 { 60 } else { 240 })
}

/// The package manager doesn't have `version` yet: retry on the same backoff as a failure, but don't record it as one
/// (nothing the user is shown, no `lastError`).
fn record_pending(version: &str) -> anyhow::Result<()> {
    let state = state();
    let previous = (state.pointer("/pending/version").and_then(Value::as_str) == Some(version))
        .then(|| state.pointer("/pending/attempts").and_then(Value::as_u64))
        .flatten();
    update_state(|s| s["pending"] = json!({ "version": version, "at": now_ms(), "attempts": previous.unwrap_or(0) + 1 }))
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
                let stale_pending = s.pointer("/pending/version").and_then(Value::as_str) != Some(version);
                if let Some(o) = s.as_object_mut() {
                    o.remove("failed");
                    if stale_pending {
                        o.remove("pending");
                    }
                }
            }
            None => {
                if let Some(o) = s.as_object_mut() {
                    for key in ["latest", "latestAt", "failed", "pending"] {
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
    use super::{Global, Install, Kind, Manager, Runner, dist_tag, package_wanted};

    #[test]
    fn mode_without_a_value_is_an_error() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(super::mode_arg(&args(&[])).unwrap(), None);
        assert_eq!(super::mode_arg(&args(&["--check"])).unwrap(), None);
        assert_eq!(super::mode_arg(&args(&["--mode", "off"])).unwrap(), Some(super::Mode::Off));
        assert!(super::mode_arg(&args(&["--mode"])).unwrap_err().to_string().contains("--mode needs a value"));
        assert!(super::mode_arg(&args(&["--mode", "sometimes"])).is_err());
    }

    #[test]
    fn checks_name_the_install_kind_in_the_user_agent() {
        let global = |manager| Install::Global(Global { package: "/x/@opencode/browse".into(), platform: "browse-linux-x64".into(), manager, launcher: crate::method::Launcher::default() });
        let table = [
            (Install::Binary("/b".into()), "binary"),
            (global(Manager::Npm { prefix: "/p".into() }), "npm"),
            (global(Manager::Bun { root: "/b".into() }), "bun"),
            (global(Manager::Pnpm { home: "/p".into() }), "pnpm"),
            (global(Manager::Yarn { folder: "/y".into() }), "yarn"),
            (global(Manager::Volta { home: "/v".into() }), "volta"),
            (Install::Runner(Runner::Npx), "npx"),
            (Install::Runner(Runner::Bunx), "bunx"),
            (Install::Runner(Runner::PnpmDlx), "pnpm-dlx"),
            (Install::Runner(Runner::YarnDlx), "yarn-dlx"),
            (Install::Other, "other"),
            (Install::Checkout, "cli"),
        ];
        for (install, kind) in table {
            let channel = super::channel();
            let expected = if kind == "cli" {
                format!("browse/{channel}/{}/cli", super::VERSION)
            } else {
                format!("browse/{channel}/{}/cli/{kind}", super::VERSION)
            };
            assert_eq!(Kind::of(&install).user_agent(), expected, "{}", install.name());
        }
    }

    /// A proxy's root is in this computer's store, not among the bundled roots: update requests must trust the platform
    /// verifier or they fail with "invalid peer certificate: UnknownIssuer" behind TLS inspection.
    #[test]
    fn update_requests_trust_the_platform_certificate_store() {
        let timeout = std::time::Duration::from_secs(1);
        let platform = super::agent(Kind::Binary, timeout, ureq::tls::RootCerts::PlatformVerifier);
        assert!(matches!(platform.config().tls_config().root_certs(), ureq::tls::RootCerts::PlatformVerifier));
        let bundled = super::agent(Kind::Binary, timeout, ureq::tls::RootCerts::WebPki);
        assert!(matches!(bundled.config().tls_config().root_certs(), ureq::tls::RootCerts::WebPki));
    }

    /// Only certificate problems fall back to the bundled roots; a timeout, a 500 or any other IO error won't.
    #[test]
    fn only_certificate_problems_fall_back_to_the_bundled_roots() {
        assert!(super::should_fall_back(&ureq::Error::Tls("no platform verifier")));
        assert!(super::should_fall_back(&ureq::Error::Rustls(rustls::Error::General("no CA certificates".into()))));
        // A rejected chain comes wrapped: rustls returns InvalidData around InvalidCertificate, and ureq hands that
        // through as Error::Io rather than Error::Rustls.
        assert!(super::should_fall_back(&ureq::Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer),
        ))));
        assert!(!super::should_fall_back(&ureq::Error::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, "not a certificate"))));
        assert!(!super::should_fall_back(&ureq::Error::Timeout(ureq::Timeout::Global)));
        assert!(!super::should_fall_back(&ureq::Error::HostNotFound));
        assert!(!super::should_fall_back(&ureq::Error::ConnectionFailed));
        assert!(!super::should_fall_back(&ureq::Error::Io(std::io::Error::from(std::io::ErrorKind::ConnectionRefused))));
        assert!(!super::should_fall_back(&ureq::Error::StatusCode(500)));
        assert!(!super::should_fall_back(&ureq::Error::BodyExceedsLimit(1)));
    }

    /// A check that can't reach the release service is reported from `auto-update.json`'s `failed`, separately from an
    /// install's `lastError`.
    #[test]
    fn a_failed_check_is_read_from_the_state() {
        let state = serde_json::json!({ "failed": "couldn't get https://anoma.ly/release/browse/cli/stable.json: invalid peer certificate: UnknownIssuer" });
        assert_eq!(
            super::check_failure(&state),
            Some("couldn't get https://anoma.ly/release/browse/cli/stable.json: invalid peer certificate: UnknownIssuer")
        );
        assert_eq!(super::check_failure(&serde_json::json!({ "lastError": { "message": "npm failed" } })), None);
    }

    /// Only a checkout build skips the updater; a global install whose binary can't be found still checks in, and
    /// never installs or restarts.
    #[test]
    fn every_install_but_a_checkout_checks_in() {
        let idle = || std::sync::Arc::new(|| true) as std::sync::Arc<dyn Fn() -> bool + Send + Sync>;
        assert!(super::Updater::new(Install::Checkout, idle()).is_none());
        let (mut other, worker) = super::Updater::new(Install::Other, idle()).unwrap();
        assert!(!worker.updates && other.replacement().is_none());
        let lost = Install::Global(Global { package: "/nowhere/@opencode/browse".into(), platform: "browse-linux-x64".into(), manager: Manager::Npm { prefix: "/nowhere".into() }, launcher: crate::method::Launcher::default() });
        assert!(lost.executable().is_none());
        let (mut updater, worker) = super::Updater::new(lost, idle()).unwrap();
        assert!(!worker.updates, "no executable: check only");
        assert!(updater.replacement().is_none());
    }

    #[test]
    fn packages_follow_their_dist_tag_by_equality() {
        assert_eq!(dist_tag("0.1.0"), "latest");
        assert_eq!(dist_tag("0.1.1-dev.57"), "dev");
        assert_eq!(dist_tag("0.1.1-beta.2"), "beta");
        assert!(package_wanted("0.1.1", "0.1.0", Some("0.1.0")));
        assert!(package_wanted("0.1.1-dev.58", "0.1.1-dev.57", None));
        assert!(!package_wanted("0.1.0", "0.1.0", Some("0.1.0")), "the same version");
        assert!(package_wanted("0.0.17", "0.1.0", Some("0.1.0")), "a rollback is an update");
        assert!(!package_wanted("0.1.1", "0.1.0", Some("0.1.1")), "already installed, waiting for the relay to switch");
        assert!(package_wanted("0.1.1", "0.1.0", Some("0.1.2")), "the channel's release replaces any other");
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
    fn a_version_missing_from_the_registry_is_a_wait_not_a_failure() {
        let npm = "npm error code ETARGET\nnpm error notarget No matching version found for @opencode/browse@99.0.0.\n";
        assert!(super::not_published(npm));
        let bun = "error: No version matching \"99.0.0\" found for specifier \"@opencode/browse\" (but package exists)\n";
        assert!(super::not_published(bun));
        let pnpm = " ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @opencode/browse@99.0.0\n";
        assert!(super::not_published(pnpm));
        let yarn = "error Couldn't find any versions for \"@opencode/browse\" that matches \"99.0.0\"\n";
        assert!(super::not_published(yarn));
        assert!(!super::not_published("npm error code EACCES\nnpm error Error: EACCES: permission denied\n"));
    }
}
