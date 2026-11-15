//! Global package installs update themselves: the relay finds a newer dist-tag on the registry, runs the package
//! manager that installed it (a stub that records its arguments and replaces the package as that manager would), and
//! restarts on the new binary once idle. One test per manager: npm, bun, pnpm (11's global virtual store) and yarn.
#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const NEXT: &str = "99.0.0";
const PLATFORM: &str = "browse-linux-x64";

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

/// A registry that answers every request with @opencode/browse's packument, its dist-tags all at NEXT.
fn registry() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            seen.lock().unwrap().push(line.split_whitespace().nth(1).unwrap_or_default().to_owned());
            let mut header = String::new();
            while reader.read_line(&mut header).is_ok_and(|n| n > 2) {
                header.clear();
            }
            let body = format!(r#"{{"name":"@opencode/browse","dist-tags":{{"latest":"{NEXT}","dev":"{NEXT}","beta":"{NEXT}"}}}}"#);
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

fn version() -> String {
    String::from_utf8(Command::new(env!("CARGO_BIN_EXE_browse")).arg("--version").output().unwrap().stdout).unwrap().trim().to_owned()
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
        format!("#!/bin/sh\nif [ \"$1\" = --version ]; then echo {NEXT}; exit 0; fi\necho \"$* $OPENCODE_BROWSER_MANAGED_RELAY\" > '{}'\n", self.started.display())
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

    /// Runs the scenario: `binary` (the platform package's) launched by `launcher`, with stubs in `stubs` first on
    /// PATH. Checks status and `update --check`, then that a managed relay updates with the manager (`expected` is
    /// the stub's recorded call) and restarts on the new binary.
    fn run(&self, manager: &str, binary: &Path, launcher: &Path, stubs: Option<&Path>, expected: impl Fn(&str) -> String) {
        let (registry, requests) = registry();
        let port = free_port();
        let path = std::env::var_os("PATH").unwrap_or_default();
        let path = std::env::join_paths(stubs.map(Path::to_path_buf).into_iter().chain(std::env::split_paths(&path))).unwrap();
        let env = |command: &mut Command| {
            for name in ["BUN_INSTALL", "PNPM_HOME", "VOLTA_HOME", "OPENCODE_BROWSER_NPM_NODE", "OPENCODE_BROWSER_NPM_BUN", "OPENCODE_BROWSER_NPM_USER_AGENT", "OPENCODE_BROWSER_NPM_EXECPATH", "OPENCODE_BROWSER_AUTO_UPDATE", "OPENCODE_BROWSER_UPDATE_CHECK", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_BIN_HOME"] {
                command.env_remove(name);
            }
            command
                .env("PATH", &path)
                .env("HOME", &self.home)
                .env("OPENCODE_BROWSER_HOME", self.home.join(".browse"))
                .env("OPENCODE_BROWSER_PORT", port.to_string())
                .env("OPENCODE_BROWSER_AUTOSTART", "0")
                .env("OPENCODE_BROWSER_NPM_REGISTRY", &registry)
                .env("OPENCODE_BROWSER_NPM_LAUNCHER", launcher);
        };

        let mut status = Command::new(binary);
        status.args(["status", "--json"]);
        env(&mut status);
        let output = run_output(&mut status);
        let status: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_else(|_| panic!("{output:?}"));
        let updates = status["setup"]["updates"].as_str().unwrap();
        assert!(updates.starts_with(&format!("automatic ({manager} @opencode/browse@")), "{updates}");
        let mut check = Command::new(binary);
        check.args(["update", "--check"]);
        env(&mut check);
        let check = run_output(&mut check);
        assert!(String::from_utf8_lossy(&check.stdout).contains(&format!("browse {NEXT} is available")), "{check:?}");
        assert!(!self.calls.exists(), "--check doesn't install");

        let mut serve = Command::new(binary);
        serve
            .arg("serve")
            .env("OPENCODE_BROWSER_MANAGED_RELAY", "1")
            .env("OPENCODE_BROWSER_AUTO_UPDATE_INTERVAL_MS", "200")
            .env("OPENCODE_BROWSER_AUTO_UPDATE_QUIET_MS", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        env(&mut serve);
        let mut relay = serve.spawn().unwrap();
        wait_for("the relay to restart on the new binary", Duration::from_secs(60), || self.started.exists() && relay.try_wait().unwrap().is_some());
        assert!(relay.wait().unwrap().success());
        assert_eq!(std::fs::read_to_string(&self.started).unwrap().trim(), "serve 1");
        assert_eq!(std::fs::read_to_string(&self.calls).unwrap().trim(), expected(&registry));
        let requests = requests.lock().unwrap().clone();
        assert!(!requests.is_empty() && requests.iter().all(|path| path.eq_ignore_ascii_case("/@opencode%2fbrowse")), "{requests:?}");
        let state: serde_json::Value = serde_json::from_slice(&std::fs::read(self.home.join(".browse/auto-update.json")).unwrap()).unwrap();
        assert_eq!(state["lastUpdate"]["to"], NEXT);
        assert!(state.get("lastError").is_none(), "{state}");
    }
}

impl Drop for Scene {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
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
fn pnpm_global_install() {
    // pnpm 11: the package in the global virtual store, linked from global/v11/<install>, which a stable alias names.
    // An update puts the new release in another store folder and install folder, and points the alias at it.
    let scene = Scene::new("pnpm");
    let home = scene.home.join(".local/share/pnpm");
    let links = home.join("store/v11/links/@opencode");
    let package = links.join("browse/0.1.0/aaa/node_modules/@opencode/browse");
    let launcher = scene.package(&package);
    let binary = scene.platform(&links.join(format!("{PLATFORM}/0.1.0/bbb/node_modules/@opencode/{PLATFORM}")));
    link(&package.with_file_name(PLATFORM), &format!("../../../../../{PLATFORM}/0.1.0/bbb/node_modules/@opencode/{PLATFORM}"));
    let installs = home.join("global/v11");
    link(&installs.join("old/node_modules/@opencode/browse"), "../../../../../store/v11/links/@opencode/browse/0.1.0/aaa/node_modules/@opencode/browse");
    link(&installs.join("770e7348"), "old");

    let next_package = links.join(format!("browse/{NEXT}/ddd/node_modules/@opencode/browse"));
    let next_binary = links.join(format!("{PLATFORM}/{NEXT}/eee/node_modules/@opencode/{PLATFORM}/bin/browse"));
    let stub = format!(
        "#!/bin/sh\necho \"$PNPM_HOME $*\" >> '{calls}'\n{swap}mkdir -p '{package}/dist' '{installs}/new/node_modules/@opencode'\nln -s '../../../../../{PLATFORM}/{NEXT}/eee/node_modules/@opencode/{PLATFORM}' '{package}/../{PLATFORM}'\nln -s '../../../../../store/v11/links/@opencode/browse/{NEXT}/ddd/node_modules/@opencode/browse' '{installs}/new/node_modules/@opencode/browse'\nln -sfn new '{installs}/770e7348'\nrm -rf '{installs}/old'\n",
        calls = scene.calls.display(),
        swap = scene.swap(&next_package, &next_binary),
        package = next_package.display(),
        installs = installs.display(),
    );
    let stubs = scene.root.join("stubs");
    write_executable(&stubs.join("pnpm"), &stub);
    scene.run("pnpm", &binary, &launcher, Some(&stubs), |registry| format!("{} add --global @opencode/browse@{NEXT} --registry={registry}", home.display()));
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
