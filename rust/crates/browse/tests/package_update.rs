//! Every install kind checks Anomaly's release service for the latest version: its channel manifest with
//! `browse/<channel>/<version>/cli/<kind>` as the User-Agent. A binary install downloads the manifest's tarball; a
//! global install runs the package manager that installed it (a stub that records its arguments and replaces the
//! package as that manager would) for the manifest's version, and restarts on the new binary once idle. A package
//! manager that doesn't have the version yet (npm lags the service) is retried quietly. One test per kind: binary,
//! npm, bun, and an npx run, plus npm's ETARGET. Every relay checks at launch with no special environment, in every
//! mode, without curl, and stays up with no client; only a relay browse started restarts itself onto an update.
#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

const NEXT: &str = "99.0.0";
const PLATFORM: &str = "browse-linux-x64";
const REGISTRY: &str = "https://registry.example.test";

fn write(file: &Path, text: &str) {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

fn write_executable(file: &Path, text: &str) {
    write(file, text);
    std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn link(file: &Path, target: &str) {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    symlink(target, file).unwrap();
}

fn version() -> String {
    String::from_utf8(Command::new(env!("CARGO_BIN_EXE_browse")).arg("--version").output().unwrap().stdout).unwrap().trim().to_owned()
}

fn channel() -> &'static str {
    let version = version();
    if version.contains("-dev.") {
        "dev"
    } else if version.contains("-beta.") {
        "beta"
    } else {
        "stable"
    }
}

fn user_agent(kind: &str) -> String {
    format!("browse/{}/{}/cli/{kind}", channel(), version())
}

struct Request {
    path: String,
    user_agent: String,
}

/// A release service that answers every request with the cli manifest for the binary's channel, `NEXT` as its only
/// release, and records what each request asked for.
fn release_service() -> (String, Arc<Mutex<Vec<Request>>>) {
    release_service_with(None)
}

/// [release_service], with `tarball` as the linux-x64 target's file, served at its URL.
fn release_service_with(tarball: Option<Vec<u8>>) -> (String, Arc<Mutex<Vec<Request>>>) {
    let (size, sha256) = match &tarball {
        Some(bytes) => (bytes.len(), Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()),
        None => (1, "a".repeat(64)),
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/release", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            // A connection that closes without a request line (the updater connecting as its relay exits to restart on
            // the new binary, say) isn't a request: skip it rather than record an empty path.
            let Some(path) = line.split_whitespace().nth(1).map(str::to_owned) else { continue };
            let mut user_agent = String::new();
            let mut header = String::new();
            while reader.read_line(&mut header).is_ok_and(|n| n > 2) {
                if let Some((key, value)) = header.trim_end().split_once(':')
                    && key.eq_ignore_ascii_case("user-agent")
                {
                    user_agent = value.trim().to_owned();
                }
                header.clear();
            }
            if let Some(tarball) = tarball.as_ref().filter(|_| path == "/release/files/x") {
                seen.lock().unwrap().push(Request { path, user_agent });
                let _ = write!(reader.get_mut(), "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", tarball.len());
                let _ = reader.get_mut().write_all(tarball);
                continue;
            }
            seen.lock().unwrap().push(Request { path, user_agent });
            let body = format!(
                r#"{{"schema":1,"app":"browse","artifact":"cli","channel":"{}","sequence":1,"published_at":"2026-01-01T00:00:00Z","release":{{"version":"{NEXT}","rollout_percent":100,"targets":{{"linux-x64":{{"url":"/release/files/x","size":{size},"sha256":"{sha256}"}}}},"distributions":[{{"kind":"direct"}}]}}}}"#,
                channel(),
            );
            let _ = write!(reader.get_mut(), "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    (url, requests)
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn wait_for(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Runs `command`, retrying while another test's spawn still holds a just-written executable open (ETXTBSY).
fn run_output(command: &mut Command) -> std::process::Output {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match command.output() {
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            result => return result.unwrap(),
        }
    }
}

/// A test's folder (in the target folder) with its own HOME.
struct Scene {
    root: PathBuf,
    home: PathBuf,
    /// Where the stub records its calls, and where the new release's binary records how it was started.
    calls: PathBuf,
    started: PathBuf,
}

impl Scene {
    fn new(name: &str) -> Scene {
        let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("package-update-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        Scene { home: root.join("home"), calls: root.join("calls"), started: root.join("started"), root }
    }

    /// @opencode/browse at `package` at the running version: its launcher.
    fn package(&self, package: &Path) -> PathBuf {
        write(&package.join("package.json"), &format!(r#"{{"name":"@opencode/browse","version":"{}"}}"#, version()));
        let launcher = package.join("dist/cli.mjs");
        write(&launcher, "");
        launcher
    }

    /// The platform package at `dir`, holding this build: its binary.
    fn platform(&self, dir: &Path) -> PathBuf {
        let binary = dir.join("bin/browse");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        // A link, not a copy: a copy is open for writing while the other tests' threads spawn processes, which keep it
        // open until they exec, and running it then fails with ETXTBSY.
        std::fs::hard_link(env!("CARGO_BIN_EXE_browse"), &binary).unwrap();
        binary
    }

    /// The new release's binary as a shell script: answers --version, and records how it was started.
    fn next_binary(&self) -> String {
        format!("#!/bin/sh\nif [ \"$1\" = --version ]; then echo {NEXT}; exit 0; fi\necho \"$*\" > '{}'\n", self.started.display())
    }

    /// A shell snippet that installs the new release's binary at `binary` and `package`'s package.json, as a package
    /// manager replaces them (the binary by a rename: a running executable can't be written).
    fn swap(&self, package: &Path, binary: &Path) -> String {
        format!(
            "mkdir -p '{bin}' '{package}'\nprintf '%s' '{{\"name\":\"@opencode/browse\",\"version\":\"{NEXT}\"}}' > '{package}/package.json'\ncat > '{bin}/.next' <<'EOF'\n{next}EOF\nchmod +x '{bin}/.next'\nmv -f '{bin}/.next' '{binary}'\n",
            bin = binary.parent().unwrap().display(),
            package = package.display(),
            binary = binary.display(),
            next = self.next_binary(),
        )
    }

    /// This scene's environment for the CLI: its own HOME and release service, and none of the caller's settings, so
    /// nothing reaches the real service or a real package manager.
    fn isolate(&self, command: &mut Command, service: &str, port: u16) {
        for name in [
            "BUN_CONFIG_REGISTRY",
            "BUN_INSTALL",
            "PNPM_HOME",
            "VOLTA_HOME",
            "OPENCODE_BROWSER_NPM_NODE",
            "OPENCODE_BROWSER_NPM_BUN",
            "OPENCODE_BROWSER_NPM_USER_AGENT",
            "OPENCODE_BROWSER_NPM_EXECPATH",
            "OPENCODE_BROWSER_NPM_LAUNCHER",
            "OPENCODE_BROWSER_AUTO_UPDATE",
            "OPENCODE_BROWSER_UPDATE_CHECK",
            "OPENCODE_BROWSER_AUTO_UPDATE_INTERVAL_MS",
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "XDG_BIN_HOME",
        ] {
            command.env_remove(name);
        }
        command
            .env("HOME", &self.home)
            .env("OPENCODE_BROWSER_HOME", self.home.join(".browse"))
            .env("OPENCODE_BROWSER_PORT", port.to_string())
            .env("OPENCODE_BROWSER_AUTOSTART", "0")
            .env("OPENCODE_BROWSER_RELEASE_SERVICE", service)
            .env("OPENCODE_BROWSER_NPM_REGISTRY", REGISTRY);
    }

    /// `status --json`: the install it found and its "Updates:" line.
    fn status(&self, binary: &Path, service: &str, port: u16) -> serde_json::Value {
        let mut status = Command::new(binary);
        status.args(["status", "--json"]);
        self.isolate(&mut status, service, port);
        let output = run_output(&mut status);
        serde_json::from_slice(&output.stdout).unwrap_or_else(|_| panic!("{output:?}"))
    }

    /// Runs the scenario: a global install at `binary` launched by `launcher`, with `stubs` first on PATH. Checks
    /// status and `update --check`, then that a relay browse started updates to the manifest's version with `manager` and
    /// restarts on the new binary. `expected` is the stub's recorded call.
    fn run(&self, manager: &str, binary: &Path, launcher: &Path, stubs: Option<&Path>, expected: impl Fn(&str) -> String) {
        let (service, requests) = release_service();
        let port = free_port();
        let path = std::env::var_os("PATH").unwrap_or_default();
        let path = std::env::join_paths(stubs.map(Path::to_path_buf).into_iter().chain(std::env::split_paths(&path))).unwrap();

        let status = self.status(binary, &service, port);
        let updates = status["setup"]["updates"].as_str().unwrap();
        assert!(updates.starts_with(&format!("automatic ({manager} @opencode/browse@")), "{updates}");

        let mut check = Command::new(binary);
        check.args(["update", "--check"]);
        self.isolate(&mut check, &service, port);
        check.env("PATH", &path).env("OPENCODE_BROWSER_NPM_LAUNCHER", launcher);
        let check = run_output(&mut check);
        assert!(String::from_utf8_lossy(&check.stdout).contains(&format!("browse {NEXT} is available")), "{check:?}");
        assert!(!self.calls.exists(), "--check doesn't install");

        let mut serve = Command::new(binary);
        self.isolate(&mut serve, &service, port);
        serve
            .arg("serve")
            .env("OPENCODE_BROWSER_MANAGED_RELAY", "1")
            .env("OPENCODE_BROWSER_AUTO_UPDATE_INTERVAL_MS", "200")
            .env("OPENCODE_BROWSER_AUTO_UPDATE_QUIET_MS", "0")
            .env("PATH", &path)
            .env("OPENCODE_BROWSER_NPM_LAUNCHER", launcher)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut relay = serve.spawn().unwrap();
        wait_for("the relay to restart on the new binary", Duration::from_secs(60), || self.started.exists() && relay.try_wait().unwrap().is_some());
        assert!(relay.wait().unwrap().success());
        assert_eq!(std::fs::read_to_string(&self.started).unwrap().trim(), "serve");
        assert_eq!(std::fs::read_to_string(&self.calls).unwrap().trim(), expected(REGISTRY));
        self.requests_are(&requests, manager);
        let state: serde_json::Value = serde_json::from_slice(&std::fs::read(self.home.join(".browse/auto-update.json")).unwrap()).unwrap();
        assert_eq!(state["lastUpdate"]["to"], NEXT);
        assert!(state.get("lastError").is_none(), "{state}");
        assert!(state.get("pending").is_none(), "{state}");
    }

    /// Every request went to this channel's manifest with the User-Agent of a `kind` install.
    fn requests_are(&self, requests: &Arc<Mutex<Vec<Request>>>, kind: &str) {
        let requests = requests.lock().unwrap();
        assert!(!requests.is_empty());
        for request in requests.iter() {
            assert_eq!(request.path, format!("/release/browse/cli/{}.json", channel()));
            assert_eq!(request.user_agent, user_agent(kind));
        }
    }
}

impl Drop for Scene {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn binary_install_checks_the_release_service() {
    let scene = Scene::new("binary");
    let binary = scene.home.join(".browse/bin/browse");
    std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
    std::fs::hard_link(env!("CARGO_BIN_EXE_browse"), &binary).unwrap();
    let (service, requests) = release_service();
    let port = free_port();
    let mut check = Command::new(&binary);
    check.args(["update", "--check"]);
    scene.isolate(&mut check, &service, port);
    let check = run_output(&mut check);
    assert!(String::from_utf8_lossy(&check.stdout).contains(&format!("browse {NEXT} is available")), "{check:?}");
    assert!(!scene.calls.exists(), "--check doesn't install");
    scene.requests_are(&requests, "binary");
}

#[test]
fn npx_run_checks_the_release_service() {
    let scene = Scene::new("npx");
    let modules = scene.home.join(".npm/_npx/4d2a/node_modules");
    let launcher = scene.package(&modules.join("@opencode/browse"));
    let binary = scene.platform(&modules.join(format!("@opencode/{PLATFORM}")));
    let (service, requests) = release_service();
    let port = free_port();
    let mut update = Command::new(&binary);
    update.arg("update");
    scene.isolate(&mut update, &service, port);
    update.env("OPENCODE_BROWSER_NPM_LAUNCHER", &launcher);
    let update = run_output(&mut update);
    assert!(String::from_utf8_lossy(&update.stdout).contains(&format!("browse {NEXT} is out")), "{update:?}");
    scene.requests_are(&requests, "npx");
}

#[test]
fn npm_global_install() {
    let scene = Scene::new("npm");
    let prefix = scene.home.join(".nvm/versions/node/v22.11.0");
    let package = prefix.join("lib/node_modules/@opencode/browse");
    let launcher = scene.package(&package);
    let binary = scene.platform(&package.join(format!("node_modules/@opencode/{PLATFORM}")));
    link(&prefix.join("bin/browse"), "../lib/node_modules/@opencode/browse/dist/cli.mjs");
    let stubs = scene.root.join("stubs");
    write_executable(&stubs.join("npm"), &format!("#!/bin/sh\necho \"$*\" >> '{}'\n{}", scene.calls.display(), scene.swap(&package, &binary)));
    scene.run("npm", &binary, &launcher, Some(&stubs), |registry| {
        format!("install --global --prefix {} --no-fund --no-audit --no-update-notifier @opencode/browse@{NEXT} --registry={registry} --@opencode:registry={registry}", prefix.display())
    });
}

#[test]
fn npm_global_install_waits_quietly_when_npm_lags_the_release() {
    let scene = Scene::new("npm-etarget");
    let prefix = scene.home.join(".nvm/versions/node/v22.11.0");
    let package = prefix.join("lib/node_modules/@opencode/browse");
    let launcher = scene.package(&package);
    let binary = scene.platform(&package.join(format!("node_modules/@opencode/{PLATFORM}")));
    link(&prefix.join("bin/browse"), "../lib/node_modules/@opencode/browse/dist/cli.mjs");
    // The first install gets npm's ETARGET (the service has the release, npm doesn't yet); the next one succeeds.
    let marker = scene.root.join("etarget");
    let stubs = scene.root.join("stubs");
    write_executable(
        &stubs.join("npm"),
        &format!(
            "#!/bin/sh\necho \"$*\" >> '{calls}'\nif [ ! -f '{marker}' ]; then\n  : > '{marker}'\n  echo 'npm error code ETARGET' >&2\n  echo 'npm error notarget No matching version found for @opencode/browse@{NEXT}.' >&2\n  exit 1\nfi\n{swap}",
            calls = scene.calls.display(),
            marker = marker.display(),
            swap = scene.swap(&package, &binary),
        ),
    );
    let (service, requests) = release_service();
    let port = free_port();
    let path = std::env::var_os("PATH").unwrap_or_default();
    let path = std::env::join_paths(std::iter::once(stubs.clone()).chain(std::env::split_paths(&path))).unwrap();
    let mut serve = Command::new(&binary);
    scene.isolate(&mut serve, &service, port);
    serve
        .arg("serve")
        .env("OPENCODE_BROWSER_MANAGED_RELAY", "1")
        .env("OPENCODE_BROWSER_AUTO_UPDATE_INTERVAL_MS", "200")
        .env("OPENCODE_BROWSER_AUTO_UPDATE_QUIET_MS", "0")
        .env("PATH", &path)
        .env("OPENCODE_BROWSER_NPM_LAUNCHER", &launcher)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut relay = serve.spawn().unwrap();
    wait_for("the relay to install on retry", Duration::from_secs(60), || scene.started.exists() && relay.try_wait().unwrap().is_some());
    assert!(relay.wait().unwrap().success());
    let calls = std::fs::read_to_string(&scene.calls).unwrap();
    let calls: Vec<&str> = calls.lines().collect();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(calls[0].contains(&format!("@opencode/browse@{NEXT}")), "{calls:?}");
    assert_eq!(calls[0], calls[1]);
    scene.requests_are(&requests, "npm");
    let state: serde_json::Value = serde_json::from_slice(&std::fs::read(scene.home.join(".browse/auto-update.json")).unwrap()).unwrap();
    assert_eq!(state["lastUpdate"]["to"], NEXT);
    assert!(state.get("lastError").is_none(), "a version npm doesn't have yet isn't a failure: {state}");
    assert!(state.get("pending").is_none(), "{state}");
}

#[test]
fn bun_global_install() {
    let scene = Scene::new("bun");
    let root = scene.home.join(".bun");
    let global = root.join("install/global");
    write(&global.join("package.json"), r#"{"dependencies":{"@opencode/browse":"dev"}}"#);
    let package = global.join("node_modules/@opencode/browse");
    let launcher = scene.package(&package);
    let binary = scene.platform(&global.join(format!("node_modules/@opencode/{PLATFORM}")));
    // No bun on PATH: the bun folder's own bun.
    write_executable(&root.join("bin/bun"), &format!("#!/bin/sh\necho \"$BUN_INSTALL $*\" >> '{}'\n{}", scene.calls.display(), scene.swap(&package, &binary)));
    scene.run("bun", &binary, &launcher, None, |registry| format!("{} add --global --no-progress @opencode/browse@{NEXT} --registry={registry}", root.display()));
}

#[test]
fn yarn_global_install() {
    let scene = Scene::new("yarn");
    let folder = scene.home.join(".local/share/yarn/global");
    write(&folder.join("package.json"), r#"{"dependencies":{"@opencode/browse":"0.1.0"}}"#);
    write(&folder.join("yarn.lock"), "");
    let package = folder.join("node_modules/@opencode/browse");
    let launcher = scene.package(&package);
    let binary = scene.platform(&folder.join(format!("node_modules/@opencode/{PLATFORM}")));
    link(&scene.home.join(".yarn/bin/browse"), "../../.local/share/yarn/global/node_modules/@opencode/browse/dist/cli.mjs");
    let stubs = scene.root.join("stubs");
    write_executable(&stubs.join("yarn"), &format!("#!/bin/sh\necho \"$*\" >> '{}'\n{}", scene.calls.display(), scene.swap(&package, &binary)));
    scene.run("yarn", &binary, &launcher, Some(&stubs), |registry| {
        format!("global add @opencode/browse@{NEXT} --global-folder {} --non-interactive --no-progress --registry {registry}", folder.display())
    });
}

impl Scene {
    /// A binary install of this build: the install script's `~/.browse/bin/browse`.
    fn binary(&self) -> PathBuf {
        let binary = self.home.join(".browse/bin/browse");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::hard_link(env!("CARGO_BIN_EXE_browse"), &binary).unwrap();
        binary
    }

    /// The release's tarball, as the install script downloads it: `package/bin/browse` is [Scene::next_binary].
    fn tarball(&self) -> Vec<u8> {
        let dir = self.root.join("tarball");
        write_executable(&dir.join("package/bin/browse"), &self.next_binary());
        let archive = self.root.join("browse.tgz");
        assert!(Command::new("tar").arg("-czf").arg(&archive).arg("-C").arg(&dir).arg("package/bin/browse").status().unwrap().success());
        std::fs::read(archive).unwrap()
    }

    /// `browse serve` from `binary` with this scene's environment and nothing else.
    fn serve(&self, binary: &Path, service: &str, port: u16) -> Command {
        let mut serve = Command::new(binary);
        self.isolate(&mut serve, service, port);
        serve.arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        serve
    }

    fn state(&self) -> serde_json::Value {
        std::fs::read(self.home.join(".browse/auto-update.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
}

fn manifest_requests(requests: &Arc<Mutex<Vec<Request>>>, kind: &str) -> usize {
    let manifest = format!("/release/browse/cli/{}.json", channel());
    requests.lock().unwrap().iter().filter(|r| r.path == manifest && r.user_agent == user_agent(kind)).count()
}

fn answers_version(port: u16) -> bool {
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else { return false };
    let _ = write!(stream, "GET /version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    let mut response = String::new();
    let _ = std::io::Read::read_to_string(&mut stream, &mut response);
    response.starts_with("HTTP/1.1 200")
}

/// No client, no OPENCODE_BROWSER_* settings of its own (a person's `browse serve`): the relay checks the release
/// service at launch, installs the release, and keeps running on the old executable with nobody connected (even with
/// the old idle-shutdown setting): it doesn't restart itself.
#[test]
fn a_relay_with_no_special_environment_checks_at_launch_and_stays_up() {
    let scene = Scene::new("launch");
    let binary = scene.binary();
    let (service, requests) = release_service_with(Some(scene.tarball()));
    let port = free_port();
    let mut relay = scene.serve(&binary, &service, port).env("OPENCODE_BROWSER_IDLE_SHUTDOWN_MS", "1").env("OPENCODE_BROWSER_AUTO_UPDATE_QUIET_MS", "0").spawn().unwrap();
    wait_for("the check at launch", Duration::from_secs(20), || manifest_requests(&requests, "binary") > 0);
    wait_for("the install", Duration::from_secs(20), || scene.state()["lastUpdate"]["to"] == NEXT);
    std::thread::sleep(Duration::from_secs(4));
    let running = relay.try_wait().unwrap().is_none();
    let answered = answers_version(port);
    let _ = relay.kill();
    let _ = relay.wait();
    assert!(running, "the relay exited with no client, or restarted itself");
    assert!(answered, "the relay stopped answering");
    assert!(!scene.started.exists(), "a foreground relay doesn't start the new executable");
}

/// Updates off: the relay still checks the manifest, with the same User-Agent, and downloads and installs nothing.
#[test]
fn updates_off_still_checks_and_installs_nothing() {
    let scene = Scene::new("off");
    let binary = scene.binary();
    let (service, requests) = release_service_with(Some(scene.tarball()));
    let port = free_port();
    let mut off = Command::new(&binary);
    off.args(["update", "--mode", "off"]);
    scene.isolate(&mut off, &service, port);
    assert!(run_output(&mut off).status.success());
    let mut relay = scene.serve(&binary, &service, port).spawn().unwrap();
    wait_for("the check", Duration::from_secs(20), || scene.state().get("checkedAt").is_some());
    std::thread::sleep(Duration::from_secs(2));
    let running = relay.try_wait().unwrap().is_none();
    let _ = relay.kill();
    let _ = relay.wait();
    assert!(running);
    scene.requests_are(&requests, "binary");
    assert_eq!(scene.state()["latest"], NEXT);
    assert!(scene.state().get("lastUpdate").is_none());
    assert_eq!(std::fs::read(&binary).unwrap(), std::fs::read(env!("CARGO_BIN_EXE_browse")).unwrap(), "nothing installed");
}

/// No curl anywhere on PATH: a relay browse started checks, downloads and verifies the release itself, and restarts on
/// it.
#[test]
fn a_relay_updates_without_curl() {
    let scene = Scene::new("no-curl");
    let binary = scene.binary();
    let (service, requests) = release_service_with(Some(scene.tarball()));
    let port = free_port();
    // Only what unpacking needs.
    let bin = scene.root.join("path");
    std::fs::create_dir_all(&bin).unwrap();
    for tool in ["tar", "gzip"] {
        let found = std::env::split_paths(&std::env::var_os("PATH").unwrap()).map(|d| d.join(tool)).find(|f| f.is_file()).unwrap();
        symlink(found, bin.join(tool)).unwrap();
    }
    let mut relay = scene.serve(&binary, &service, port).env("PATH", &bin).env("OPENCODE_BROWSER_MANAGED_RELAY", "1").env("OPENCODE_BROWSER_AUTO_UPDATE_QUIET_MS", "0").spawn().unwrap();
    wait_for("the relay to restart on the new binary", Duration::from_secs(60), || scene.started.exists() && relay.try_wait().unwrap().is_some());
    assert!(relay.wait().unwrap().success());
    assert_eq!(std::fs::read_to_string(&scene.started).unwrap().trim(), "serve");
    assert!(manifest_requests(&requests, "binary") > 0);
    assert!(requests.lock().unwrap().iter().any(|r| r.path == "/release/files/x" && r.user_agent == user_agent("binary")));
}

/// A browse that wasn't installed in a way it can update (a binary in Downloads) still checks in, with kind `other`,
/// and installs nothing.
#[test]
fn an_unrecognized_install_checks_in_and_installs_nothing() {
    let scene = Scene::new("other");
    // Outside the target folder, which would make it a checkout build.
    let outside = PathBuf::from(std::env::var_os("HOME").unwrap()).join(format!(".cache/oc-tmp/browse-other-{}", std::process::id()));
    let binary = outside.join("Downloads/browse");
    std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
    std::fs::copy(env!("CARGO_BIN_EXE_browse"), &binary).unwrap();
    let (service, requests) = release_service_with(Some(scene.tarball()));
    let port = free_port();
    let mut serve = scene.serve(&binary, &service, port);
    serve.env("OPENCODE_BROWSER_MANAGED_RELAY", "1").env("OPENCODE_BROWSER_AUTO_UPDATE_QUIET_MS", "0");
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut relay = loop {
        match serve.spawn() {
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            result => break result.unwrap(),
        }
    };
    wait_for("the check", Duration::from_secs(20), || scene.state().get("checkedAt").is_some());
    std::thread::sleep(Duration::from_secs(2));
    let running = relay.try_wait().unwrap().is_none();
    let _ = relay.kill();
    let _ = relay.wait();
    let unchanged = std::fs::read(&binary).unwrap() == std::fs::read(env!("CARGO_BIN_EXE_browse")).unwrap();
    let _ = std::fs::remove_dir_all(&outside);
    assert!(running);
    assert!(unchanged, "nothing installed");
    scene.requests_are(&requests, "other");
    assert!(scene.state().get("lastUpdate").is_none());
    assert!(!scene.started.exists());
}
