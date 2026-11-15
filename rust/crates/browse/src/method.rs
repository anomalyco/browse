//! How this browse was installed, which decides how it updates (cli/src/update/auto-update.ts `InstallKind`):
//!   binary   the install script's (or `browse install`'s) executable in the bin folder
//!   global   @opencode/browse installed globally by npm, bun, pnpm, yarn classic or volta: the npm launcher
//!            (npm/browse.mjs) runs its platform package's binary, which is this one
//!   runner   a one-off run that npx, bunx, pnpm dlx or yarn dlx resolves itself
//!   checkout a build in a checkout's cargo target folder
//!   other    anything else
//! Each is told apart by where the package that runs this binary lives, as each package manager lays out its global
//! installs, with what the launcher says about itself (its file and the node or bun running it) to confirm it.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

pub const PACKAGE: &str = "@opencode/browse";
pub const EXECUTABLE: &str = if cfg!(windows) { "browse.exe" } else { "browse" };

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Install {
    Binary(PathBuf),
    Global(Global),
    Runner(Runner),
    Checkout,
    Other,
}

/// A package runner that resolves @opencode/browse itself on every run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Runner {
    Npx,
    Bunx,
    PnpmDlx,
    YarnDlx,
}

/// A global install of @opencode/browse.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Global {
    /// The package folder, as a path that keeps naming the installed package after an update (pnpm's link to it,
    /// not the versioned folder it points at).
    pub package: PathBuf,
    /// The platform package this binary came from (`browse-linux-x64`), preferred after an update.
    pub platform: String,
    pub manager: Manager,
    pub launcher: Launcher,
}

/// The package manager of a global install, and the folder it installs into.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Manager {
    /// `npm install -g`, into this prefix (`<prefix>/lib/node_modules`; `<prefix>/node_modules` on Windows).
    Npm { prefix: PathBuf },
    /// `bun add -g`, into this bun folder (`$BUN_INSTALL`, ~/.bun) and its install/global.
    Bun { root: PathBuf },
    /// `pnpm add -g`, into this PNPM_HOME and its global folder.
    Pnpm { home: PathBuf },
    /// `yarn global add` (yarn classic), into this global folder.
    Yarn { folder: PathBuf },
    /// `volta install`, into this VOLTA_HOME's tools/image/packages.
    Volta { home: PathBuf },
}

/// What the npm launcher (npm/browse.mjs) says about itself: its file, the node or bun running it, and the package
/// manager that ran it when one did (npm_config_user_agent, npm_execpath).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Launcher {
    pub file: Option<PathBuf>,
    pub node: Option<PathBuf>,
    pub bun: Option<PathBuf>,
    pub user_agent: Option<String>,
    pub exec_path: Option<PathBuf>,
}

impl Launcher {
    pub fn from_env() -> Launcher {
        let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
        let path = |name: &str| var(name).map(PathBuf::from);
        Launcher {
            file: path("OPENCODE_BROWSER_NPM_LAUNCHER"),
            node: path("OPENCODE_BROWSER_NPM_NODE"),
            bun: path("OPENCODE_BROWSER_NPM_BUN"),
            user_agent: var("OPENCODE_BROWSER_NPM_USER_AGENT").map(|v| v.to_string_lossy().into_owned()),
            exec_path: path("OPENCODE_BROWSER_NPM_EXECPATH"),
        }
    }

    /// The package manager that ran the launcher, as its user agent names it (`pnpm/11.3.0 npm/? node/v22…`).
    fn agent(&self) -> Option<&str> {
        self.user_agent.as_deref()?.split('/').next()
    }
}

/// The dist-tag a build follows: `latest` for a release, `dev` or `beta` for those builds.
pub fn dist_tag(version: &str) -> &'static str {
    if version.contains("-dev.") {
        "dev"
    } else if version.contains("-beta.") {
        "beta"
    } else {
        "latest"
    }
}

/// `@opencode/browse@<tag>`, or just the package for `latest`.
fn spec(tag: &str) -> String {
    if tag == "latest" { PACKAGE.into() } else { format!("{PACKAGE}@{tag}") }
}

impl Install {
    /// The install method, as status and the relay's `autoUpdate` name it.
    pub fn name(&self) -> &'static str {
        match self {
            Install::Binary(_) => "binary",
            Install::Global(global) => global.manager.name(),
            Install::Runner(runner) => runner.name(),
            Install::Checkout => "checkout",
            Install::Other => "other",
        }
    }

    /// The closest install kind extensions before the method field know (binary, npm, npx, checkout, other). Their
    /// update command for `binary` is `browse update`, which updates every global install, so bun, pnpm, yarn and
    /// volta read as that; their npm command would install a second copy with npm.
    pub fn compatible_name(&self) -> &'static str {
        match self {
            Install::Global(Global { manager: Manager::Npm { .. }, .. }) => "npm",
            Install::Binary(_) | Install::Global(_) => "binary",
            Install::Runner(_) => "npx",
            Install::Checkout => "checkout",
            Install::Other => "other",
        }
    }

    pub fn updates_itself(&self) -> bool {
        matches!(self, Install::Binary(_) | Install::Global(_))
    }

    /// The executable a relay of this install starts from now: a package update may have replaced the platform package.
    pub fn executable(&self) -> Option<PathBuf> {
        match self {
            Install::Binary(binary) => Some(binary.clone()),
            Install::Global(global) => global.binary(),
            _ => None,
        }
    }

    /// The command that updates this install in a terminal for `version`'s channel; for one that can't update, the
    /// command that switches it to one that can.
    pub fn update_command(&self, version: &str, exe: &Path) -> String {
        let tag = dist_tag(version);
        match self {
            Install::Binary(_) => "browse update".into(),
            Install::Global(global) => global.manager.words(tag),
            Install::Runner(runner) => format!("{} install", runner.run(tag)),
            Install::Checkout => format!("{} update", exe.display()),
            Install::Other => format!("{} install", exe.display()),
        }
    }
}

impl Runner {
    pub fn name(self) -> &'static str {
        match self {
            Runner::Npx => "npx",
            Runner::Bunx => "bunx",
            Runner::PnpmDlx => "pnpm-dlx",
            Runner::YarnDlx => "yarn-dlx",
        }
    }

    /// The command that runs the CLI this way: `npx @opencode/browse@dev`.
    pub fn run(self, tag: &str) -> String {
        let runner = match self {
            Runner::Npx => "npx",
            Runner::Bunx => "bunx",
            Runner::PnpmDlx => "pnpm dlx",
            Runner::YarnDlx => "yarn dlx",
        };
        format!("{runner} {}", spec(tag))
    }

    /// The global install command of the same package manager (npm's for yarn dlx: yarn berry has no global installs).
    pub fn global_words(self, tag: &str) -> String {
        let manager = match self {
            Runner::Npx | Runner::YarnDlx => Manager::Npm { prefix: PathBuf::new() },
            Runner::Bunx => Manager::Bun { root: PathBuf::new() },
            Runner::PnpmDlx => Manager::Pnpm { home: PathBuf::new() },
        };
        manager.words(tag)
    }
}

impl Manager {
    pub fn name(&self) -> &'static str {
        match self {
            Manager::Npm { .. } => "npm",
            Manager::Bun { .. } => "bun",
            Manager::Pnpm { .. } => "pnpm",
            Manager::Yarn { .. } => "yarn",
            Manager::Volta { .. } => "volta",
        }
    }

    /// How its install command reads in messages: `bun add -g @opencode/browse@<version>`.
    pub fn words(&self, version: &str) -> String {
        let spec = format!("{PACKAGE}@{version}");
        match self {
            Manager::Npm { .. } => format!("npm install -g {spec}"),
            Manager::Bun { .. } => format!("bun add -g {spec}"),
            Manager::Pnpm { .. } => format!("pnpm add -g {spec}"),
            Manager::Yarn { .. } => format!("yarn global add {spec}"),
            Manager::Volta { .. } => format!("volta install {spec}"),
        }
    }

    /// The folder it writes to.
    pub fn folder(&self) -> &Path {
        match self {
            Manager::Npm { prefix } => prefix,
            Manager::Bun { root } => root,
            Manager::Pnpm { home } => home,
            Manager::Yarn { folder } => folder,
            Manager::Volta { home } => home,
        }
    }
}

impl Global {
    /// The installed package's folder now. pnpm moves it on every update (another versioned folder), which its link
    /// follows; a link that's gone is looked for again among pnpm's global installs.
    pub fn current_package(&self) -> Option<PathBuf> {
        if let Ok(package) = std::fs::canonicalize(&self.package) {
            return Some(package);
        }
        let Manager::Pnpm { home } = &self.manager else { return None };
        pnpm_globals(home).into_iter().find_map(|entry| std::fs::canonicalize(entry).ok())
    }

    /// The binary the launcher would run now: this platform package, else the other libc's, as Node resolves it from
    /// the package.
    pub fn binary(&self) -> Option<PathBuf> {
        platform_binary(&self.current_package()?, &self.platform)
    }

    /// The version of @opencode/browse installed now.
    pub fn version(&self) -> Option<String> {
        let manifest: Value = serde_json::from_slice(&std::fs::read(self.current_package()?.join("package.json")).ok()?).ok()?;
        manifest["version"].as_str().map(str::to_owned)
    }

    /// The command that installs `version` into this install, from `registry` when one is given. Each package
    /// manager comes from beside the runtime that ran the launcher when it's there, else from its own folder, else PATH.
    pub fn command(&self, version: &str, registry: Option<&str>) -> Command {
        let spec = format!("{PACKAGE}@{version}");
        let launcher = &self.launcher;
        match &self.manager {
            Manager::Npm { prefix } => {
                let mut command = npm_command(launcher.node.as_deref());
                command.args(["install", "--global", "--prefix"]).arg(prefix).args(["--no-fund", "--no-audit", "--no-update-notifier", &spec]);
                if let Some(registry) = registry {
                    command.arg(format!("--registry={registry}")).arg(format!("--@opencode:registry={registry}"));
                }
                command
            }
            Manager::Bun { root } => {
                let own = Some(root.join("bin").join(exe("bun")));
                let mut command = Command::new(program([launcher.bun.clone(), own], &exe("bun")));
                command.env("BUN_INSTALL", root).args(["add", "--global", "--no-progress", &spec]);
                if let Some(registry) = registry {
                    command.arg(format!("--registry={registry}"));
                }
                command
            }
            Manager::Pnpm { home } => {
                let own = [Some(home.join(exe("pnpm"))), Some(home.join("bin").join(exe("pnpm"))), beside_node(launcher, &shim("pnpm"))];
                let mut command = run_by_agent(launcher, "pnpm").unwrap_or_else(|| Command::new(program(own, &shim("pnpm"))));
                // pnpm refuses a global install whose bin folder (PNPM_HOME, or its bin since pnpm 11) isn't on PATH.
                let path = std::env::var_os("PATH").unwrap_or_default();
                let dirs = [home.join("bin"), home.clone()].into_iter().chain(std::env::split_paths(&path));
                if let Ok(joined) = std::env::join_paths(dirs) {
                    command.env("PATH", joined);
                }
                command.env("PNPM_HOME", home).args(["add", "--global", &spec]);
                if let Some(registry) = registry {
                    command.arg(format!("--registry={registry}"));
                }
                command
            }
            Manager::Yarn { folder } => {
                let own = [beside_node(launcher, &shim("yarn"))];
                let mut command = run_by_agent(launcher, "yarn").unwrap_or_else(|| Command::new(program(own, &shim("yarn"))));
                command.args(["global", "add", &spec, "--global-folder"]).arg(folder).args(["--non-interactive", "--no-progress"]);
                if let Some(registry) = registry {
                    command.args(["--registry", registry]);
                }
                command
            }
            Manager::Volta { home } => {
                // Volta installs from the registry in .npmrc, as npm would.
                let mut command = Command::new(program([Some(home.join("bin").join(exe("volta")))], &exe("volta")));
                command.env("VOLTA_HOME", home).args(["install", &spec]);
                command
            }
        }
    }
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.into() }
}

/// A Node package manager's command: a .cmd shim on Windows, which Rust runs through cmd.exe itself.
fn shim(name: &str) -> String {
    if cfg!(windows) { format!("{name}.cmd") } else { name.into() }
}

/// The first candidate that exists, else `fallback` from PATH.
fn program(candidates: impl IntoIterator<Item = Option<PathBuf>>, fallback: &str) -> PathBuf {
    candidates.into_iter().flatten().find(|c| c.is_file()).unwrap_or_else(|| PathBuf::from(fallback))
}

/// `name` beside the node that runs the launcher (corepack's pnpm and yarn shims live there).
fn beside_node(launcher: &Launcher, name: &str) -> Option<PathBuf> {
    Some(launcher.node.as_ref()?.parent()?.join(name))
}

/// The package manager that ran the launcher (npm_execpath), when it's `agent`: its JavaScript entry runs with node.
fn run_by_agent(launcher: &Launcher, agent: &str) -> Option<Command> {
    let file = launcher.exec_path.as_ref().filter(|f| launcher.agent() == Some(agent) && f.is_file())?;
    let script = file.extension().is_some_and(|e| e == "js" || e == "cjs" || e == "mjs");
    if !script {
        return Some(Command::new(file));
    }
    let mut command = Command::new(launcher.node.as_ref().filter(|n| n.is_file()).map_or_else(|| PathBuf::from("node"), Clone::clone));
    command.arg(file);
    Some(command)
}

/// npm, as the node that runs the launcher has it (npm's own CLI beside it, with that node first on PATH), else the
/// npm on PATH.
pub fn npm_command(node: Option<&Path>) -> Command {
    if let Some(node) = node.filter(|n| n.is_file())
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
    Command::new(shim("npm"))
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn named(path: Option<&Path>, name: &str) -> bool {
    path.and_then(Path::file_name).is_some_and(|n| n == name)
}

/// The closest folder around `path` named `name`.
fn ancestor<'a>(path: &'a Path, name: &str) -> Option<&'a Path> {
    path.ancestors().find(|a| named(Some(a), name))
}

fn has_component(path: &Path, test: impl Fn(&str) -> bool) -> bool {
    path.components().any(|c| test(&c.as_os_str().to_string_lossy()))
}

/// The binary of `platform` (or the other libc's, as the launcher falls back) that Node resolves from `package`:
/// `node_modules/@opencode/<platform>` in the package or any folder above it (nested by npm, hoisted beside it by
/// npm, bun and yarn, a sibling link in pnpm's store).
pub fn platform_binary(package: &Path, platform: &str) -> Option<PathBuf> {
    let mut names = vec![platform.to_owned()];
    if cfg!(target_os = "linux") {
        names.push(platform.strip_suffix("-musl").map_or_else(|| format!("{platform}-musl"), str::to_owned));
    }
    names.iter().find_map(|name| package.ancestors().map(|dir| dir.join("node_modules").join("@opencode").join(name).join("bin").join(EXECUTABLE)).find(|file| file.is_file()))
}

/// Whether `package` is an @opencode/browse package folder with the launcher.
fn is_package(package: &Path) -> bool {
    named(Some(package), "browse") && named(package.parent(), "@opencode") && package.join("dist").join("cli.mjs").is_file()
}

/// What kind of install the executable `exe` belongs to; `installed` is the bin folder's executable.
pub fn detect(exe: &Path, launcher: &Launcher, installed: &Path) -> Install {
    let exe = canonical(exe);
    if installed.is_file() && canonical(installed) == exe {
        return Install::Binary(installed.to_path_buf());
    }
    if let Some(install) = package_install(&exe, launcher) {
        return install;
    }
    let checkout = exe.ancestors().any(|dir| dir.file_name().is_some_and(|n| n == "target") && dir.parent().is_some_and(|p| p.join("Cargo.toml").is_file()));
    if checkout { Install::Checkout } else { Install::Other }
}

/// An install of @opencode/browse whose platform package (`node_modules/@opencode/browse-<target>/bin/`) holds `exe`.
fn package_install(exe: &Path, launcher: &Launcher) -> Option<Install> {
    let bin = exe.parent().filter(|b| named(Some(b), "bin"))?;
    let platform_dir = bin.parent()?;
    let platform = platform_dir.file_name()?.to_str().filter(|n| n.starts_with("browse-"))?.to_owned();
    let scope = platform_dir.parent().filter(|s| named(Some(s), "@opencode"))?;
    let modules = scope.parent().filter(|m| named(Some(m), "node_modules"))?;
    let runs_this = |package: &Path| is_package(package) && platform_binary(package, &platform).is_some_and(|b| canonical(&b) == exe);
    // The launcher that ran this (its dist/cli.mjs), else the package an older launcher, which doesn't say, runs from:
    // the one this platform package is nested in, the one beside it, or (pnpm before 11) the link to it beside the
    // .pnpm store.
    let given = launcher.file.as_deref().and_then(|l| canonical(l).parent()?.parent().map(Path::to_path_buf));
    let mut candidates = vec![given, modules.parent().map(Path::to_path_buf), Some(scope.join("browse"))];
    if let Some(store) = ancestor(modules, ".pnpm").and_then(Path::parent) {
        candidates.push(Some(canonical(&store.join("node_modules").join("@opencode").join("browse"))));
        candidates.push(Some(canonical(&store.parent()?.join("node_modules").join("@opencode").join("browse"))));
    }
    match candidates.into_iter().flatten().find(|package| runs_this(package)) {
        Some(package) => Some(classify(&package, platform, launcher)),
        // pnpm 11 keeps platform packages apart in its global store: find the global install that runs this binary.
        None => pnpm_store_home(exe).and_then(|homes| {
            homes.into_iter().find_map(|home| {
                let entry = pnpm_globals(&home).into_iter().find(|entry| platform_binary(&canonical(entry), &platform).is_some_and(|b| canonical(&b) == exe))?;
                Some(Install::Global(Global { package: entry, platform: platform.clone(), manager: Manager::Pnpm { home }, launcher: launcher.clone() }))
            })
        }),
    }
}

/// Which install the package folder `package` (resolved) is, by where its package manager puts global installs.
fn classify(package: &Path, platform: String, launcher: &Launcher) -> Install {
    let global = |package: PathBuf, manager: Manager| Install::Global(Global { package, platform: platform.clone(), manager, launcher: launcher.clone() });
    // npx's cache (~/.npm/_npx/<hash>), bunx's temporary folder (bunx-<uid>-<spec>), yarn berry's dlx (xfs-<id>).
    if has_component(package, |c| c == "_npx") {
        return Install::Runner(Runner::Npx);
    }
    if has_component(package, |c| c.starts_with("bunx-")) {
        return Install::Runner(Runner::Bunx);
    }
    if has_component(package, |c| c.starts_with("xfs-")) {
        return Install::Runner(Runner::YarnDlx);
    }
    // volta install: <VOLTA_HOME>/tools/image/packages/@opencode/browse/[lib/]node_modules/@opencode/browse.
    if let Some(packages) = ancestor(package, "packages").filter(|p| named(p.parent(), "image") && named(p.parent().and_then(Path::parent), "tools")) {
        let home = packages.ancestors().nth(3).map(Path::to_path_buf);
        return home.map_or(Install::Other, |home| global(package.to_path_buf(), Manager::Volta { home }));
    }
    // pnpm 11's global virtual store: <PNPM_HOME>/store/v11/links/@opencode/browse/<version>/<hash>/node_modules/@opencode/browse,
    // linked from <PNPM_HOME>/global/v11/<install>/node_modules/@opencode/browse. pnpm dlx links the same store from its cache.
    if let Some(homes) = pnpm_store_home(package) {
        let found = homes.into_iter().find_map(|home| Some((pnpm_globals(&home).into_iter().find(|entry| canonical(entry) == package)?, home)));
        return found.map_or(Install::Runner(Runner::PnpmDlx), |(entry, home)| global(entry, Manager::Pnpm { home }));
    }
    // pnpm before 11: <PNPM_HOME>/global/5/[node_modules/].pnpm/@opencode+browse@<version>/node_modules/@opencode/browse,
    // linked from <PNPM_HOME>/global/5/node_modules/@opencode/browse; pnpm dlx's under <cache>/pnpm/dlx/.
    if let Some(store) = ancestor(package, ".pnpm").and_then(Path::parent) {
        if has_component(store, |c| c == "dlx") {
            return Install::Runner(Runner::PnpmDlx);
        }
        let root = if named(Some(store), "node_modules") { store.parent() } else { Some(store) };
        let Some(root) = root.filter(|r| named(r.parent(), "global")) else { return Install::Other };
        let home = root.parent().and_then(Path::parent).map(Path::to_path_buf);
        return home.map_or(Install::Other, |home| global(root.join("node_modules").join("@opencode").join("browse"), Manager::Pnpm { home }));
    }
    let Some(modules) = package.parent().and_then(Path::parent).filter(|m| named(Some(m), "node_modules")) else { return Install::Other };
    let Some(folder) = modules.parent() else { return Install::Other };
    // bun: <BUN_INSTALL>/install/global; yarn classic: its global folder (~/.config/yarn/global,
    // ~/.local/share/yarn/global, %LOCALAPPDATA%\Yarn\Data\global), with the package.json and yarn.lock it keeps.
    if named(Some(folder), "global") && folder.join("package.json").is_file() {
        if named(folder.parent(), "install")
            && !folder.join("yarn.lock").is_file()
            && let Some(root) = folder.parent().and_then(Path::parent)
        {
            return global(package.to_path_buf(), Manager::Bun { root: root.to_path_buf() });
        }
        let yarn_parent = folder.parent().and_then(Path::file_name).is_some_and(|n| n.eq_ignore_ascii_case("yarn") || n == "Data");
        if folder.join("yarn.lock").is_file() || yarn_parent {
            return global(package.to_path_buf(), Manager::Yarn { folder: folder.to_path_buf() });
        }
    }
    // npm: <prefix>/lib/node_modules (<prefix>/node_modules on Windows) with the bin links npm made, whatever the
    // prefix (the node's own, nvm's, fnm's, asdf's, mise's, Homebrew's, NPM_CONFIG_PREFIX). A project's own
    // node_modules has no global prefix to update.
    let prefix = if cfg!(windows) { Some(folder) } else { Some(folder).filter(|lib| named(Some(lib), "lib")).and_then(Path::parent) };
    let Some(prefix) = prefix else { return Install::Other };
    let linked = ["browse", "opencode-browser"].iter().any(|name| {
        if cfg!(windows) { prefix.join(format!("{name}.cmd")).is_file() } else { std::fs::symlink_metadata(prefix.join("bin").join(name)).is_ok() }
    });
    if linked { global(package.to_path_buf(), Manager::Npm { prefix: prefix.to_path_buf() }) } else { Install::Other }
}

/// The PNPM_HOMEs that may own `path` in pnpm 11's global virtual store (`<store>/v<n>/links/...`): the store's
/// folder (the default store is PNPM_HOME/store), then PNPM_HOME and pnpm's default home.
fn pnpm_store_home(path: &Path) -> Option<Vec<PathBuf>> {
    let links = path.ancestors().find(|a| named(Some(a), "links") && a.parent().is_some_and(|v| named(v.parent(), "store") && v.file_name().is_some_and(|n| n.to_string_lossy().starts_with('v'))))?;
    let store = links.parent()?.parent()?;
    let mut homes = vec![store.parent()?.to_path_buf()];
    if let Some(home) = std::env::var_os("PNPM_HOME").filter(|h| !h.is_empty()) {
        homes.push(PathBuf::from(home));
    }
    let home = crate::setup::home();
    homes.push(if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map_or_else(|| home.join("AppData/Local"), PathBuf::from).join("pnpm")
    } else if cfg!(target_os = "macos") {
        home.join("Library/pnpm")
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".local/share")).join("pnpm")
    });
    homes.dedup();
    Some(homes)
}

/// The @opencode/browse links of pnpm's global installs under `home`: `global/<layout>/node_modules/...` before
/// pnpm 11, `global/v11/<install>/node_modules/...` since, the stable alias links to an install folder first.
fn pnpm_globals(home: &Path) -> Vec<PathBuf> {
    let link = |dir: &Path| dir.join("node_modules").join("@opencode").join("browse");
    let mut found: Vec<(bool, PathBuf)> = Vec::new();
    let Ok(layouts) = std::fs::read_dir(home.join("global")) else { return Vec::new() };
    for layout in layouts.flatten().map(|e| e.path()) {
        if link(&layout).exists() {
            found.push((false, link(&layout)));
            continue;
        }
        let Ok(installs) = std::fs::read_dir(&layout) else { continue };
        for install in installs.flatten() {
            let path = install.path();
            if link(&path).exists() {
                let alias = install.file_type().is_ok_and(|t| t.is_symlink());
                found.push((!alias, link(&path)));
            }
        }
    }
    found.sort();
    found.into_iter().map(|(_, path)| path).collect()
}

/// This process's install.
pub fn install() -> Install {
    let Ok(exe) = crate::relay::current_exe() else { return Install::Other };
    detect(&exe, &Launcher::from_env(), &crate::relay_api::bin_root().join(EXECUTABLE))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{EXECUTABLE, Global, Install, Launcher, Manager, Runner, detect};

    const V: &str = "0.1.0";

    /// A throwaway folder laid out like a package manager's real install.
    struct Tree(PathBuf);

    impl Tree {
        fn new(name: &str) -> Tree {
            let dir = std::env::temp_dir().join(format!("browse-method-test-{name}-{}", crate::session::random_u64()));
            std::fs::create_dir_all(&dir).unwrap();
            Tree(std::fs::canonicalize(dir).unwrap())
        }
        fn path(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }
        fn file(&self, rel: &str, text: &str) -> PathBuf {
            let file = self.path(rel);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, text).unwrap();
            file
        }
        /// @opencode/browse at `rel`: its launcher (returned) and package.json.
        fn package(&self, rel: &str) -> PathBuf {
            self.file(&format!("{rel}/package.json"), &format!("{{\"name\":\"@opencode/browse\",\"version\":\"{V}\"}}"));
            self.file(&format!("{rel}/dist/cli.mjs"), "")
        }
        /// The platform package at `rel` (a `.../@opencode/browse-linux-x64` folder): its binary.
        fn platform(&self, rel: &str) -> PathBuf {
            self.file(&format!("{rel}/bin/{EXECUTABLE}"), "")
        }
        #[cfg(unix)]
        fn link(&self, rel: &str, target: &str) {
            let link = self.path(rel);
            std::fs::create_dir_all(link.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(target, link).unwrap();
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const P: &str = "browse-linux-x64";

    /// (case, launcher, binary, method, manager folder, package path).
    type Case = (&'static str, PathBuf, PathBuf, &'static str, Option<String>, Option<String>);

    fn launched(file: &Path) -> Launcher {
        Launcher { file: Some(file.to_path_buf()), ..Launcher::default() }
    }

    /// What `detect` found, as (method, the manager's folder, the package path) for comparing.
    fn found(install: &Install) -> (&'static str, Option<PathBuf>, Option<PathBuf>) {
        match install {
            Install::Global(global) => (install.name(), Some(global.manager.folder().to_path_buf()), Some(global.package.clone())),
            _ => (install.name(), None, None),
        }
    }

    /// An npm global install under `prefix`, its platform package nested (npm 7+) or hoisted, with npm's bin link.
    #[cfg(unix)]
    fn npm(tree: &Tree, prefix: &str, hoisted: bool) -> (PathBuf, PathBuf, &'static str) {
        let package = format!("{prefix}/lib/node_modules/@opencode/browse");
        let launcher = tree.package(&package);
        let platform = if hoisted { format!("{prefix}/lib/node_modules/@opencode/{P}") } else { format!("{package}/node_modules/@opencode/{P}") };
        let binary = tree.platform(&platform);
        tree.link(&format!("{prefix}/bin/browse"), "../lib/node_modules/@opencode/browse/dist/cli.mjs");
        (launcher, binary, "npm")
    }

    #[cfg(unix)]
    #[test]
    fn detects_every_install_layout() {
        let tree = Tree::new("layouts");
        let installed = tree.path("home/.local/bin/browse");
        let mut cases: Vec<Case> = Vec::new();
        let npm_case = |cases: &mut Vec<Case>, case: &'static str, prefix: &str, hoisted: bool| {
            let (launcher, binary, method) = npm(&tree, prefix, hoisted);
            cases.push((case, launcher, binary, method, Some(prefix.to_owned()), Some(format!("{prefix}/lib/node_modules/@opencode/browse"))));
        };
        npm_case(&mut cases, "npm, node's own prefix", "usr", false);
        npm_case(&mut cases, "npm, hoisted platform package", "usr-local", true);
        npm_case(&mut cases, "npm under nvm", "home/.nvm/versions/node/v22.11.0", false);
        npm_case(&mut cases, "npm under fnm", "home/.local/share/fnm/node-versions/v22.11.0/installation", false);
        npm_case(&mut cases, "npm under asdf", "home/.asdf/installs/nodejs/22.11.0", false);
        npm_case(&mut cases, "npm under mise", "home/.local/share/mise/installs/node/22.11.0", false);
        npm_case(&mut cases, "npm with Homebrew's node", "opt/homebrew", false);
        npm_case(&mut cases, "npm with Linuxbrew's node", "home/linuxbrew/.linuxbrew", false);
        npm_case(&mut cases, "npm with NPM_CONFIG_PREFIX", "home/.npm-global", false);

        // volta install @opencode/browse (also what `npm i -g` does under volta).
        let image = "home/.volta/tools/image/packages/@opencode/browse/lib/node_modules/@opencode/browse";
        let launcher = tree.package(image);
        let binary = tree.platform(&format!("{image}/node_modules/@opencode/{P}"));
        tree.link("home/.volta/tools/image/packages/@opencode/browse/bin/browse", "../lib/node_modules/@opencode/browse/dist/cli.mjs");
        cases.push(("volta", launcher, binary, "volta", Some("home/.volta".into()), Some(image.into())));

        // bun add -g: $BUN_INSTALL/install/global, platform package hoisted.
        let global = "home/.bun/install/global";
        tree.file(&format!("{global}/package.json"), "{}");
        tree.file(&format!("{global}/bun.lock"), "{}");
        let launcher = tree.package(&format!("{global}/node_modules/@opencode/browse"));
        let binary = tree.platform(&format!("{global}/node_modules/@opencode/{P}"));
        cases.push(("bun", launcher, binary, "bun", Some("home/.bun".into()), Some(format!("{global}/node_modules/@opencode/browse"))));

        // yarn global add (classic): its global folder with package.json and yarn.lock, hoisted.
        for (case, folder) in [("yarn, XDG data", "home/.local/share/yarn/global"), ("yarn, ~/.config", "home/.config/yarn/global"), ("yarn, Windows", "home/AppData/Local/Yarn/Data/global")] {
            tree.file(&format!("{folder}/package.json"), "{}");
            tree.file(&format!("{folder}/yarn.lock"), "");
            let launcher = tree.package(&format!("{folder}/node_modules/@opencode/browse"));
            let binary = tree.platform(&format!("{folder}/node_modules/@opencode/{P}"));
            cases.push((case, launcher, binary, "yarn", Some(folder.into()), Some(format!("{folder}/node_modules/@opencode/browse"))));
        }

        // pnpm 10: $PNPM_HOME/global/5/.pnpm, linked from global/5/node_modules.
        let store = "pnpm10/global/5/.pnpm";
        let launcher = tree.package(&format!("{store}/@opencode+browse@{V}/node_modules/@opencode/browse"));
        let binary = tree.platform(&format!("{store}/@opencode+{P}@{V}/node_modules/@opencode/{P}"));
        tree.link(&format!("{store}/@opencode+browse@{V}/node_modules/@opencode/{P}"), &format!("../../../@opencode+{P}@{V}/node_modules/@opencode/{P}"));
        tree.link("pnpm10/global/5/node_modules/@opencode/browse", &format!("../../.pnpm/@opencode+browse@{V}/node_modules/@opencode/browse"));
        cases.push(("pnpm 10", launcher, binary.clone(), "pnpm", Some("pnpm10".into()), Some("pnpm10/global/5/node_modules/@opencode/browse".into())));
        cases.push(("pnpm 10, older launcher", PathBuf::new(), binary, "pnpm", Some("pnpm10".into()), Some("pnpm10/global/5/node_modules/@opencode/browse".into())));

        // pnpm 9 and earlier: global/5/node_modules/.pnpm.
        let store = "pnpm9/global/5/node_modules/.pnpm";
        let launcher = tree.package(&format!("{store}/@opencode+browse@{V}/node_modules/@opencode/browse"));
        let binary = tree.platform(&format!("{store}/@opencode+{P}@{V}/node_modules/@opencode/{P}"));
        tree.link(&format!("{store}/@opencode+browse@{V}/node_modules/@opencode/{P}"), &format!("../../../@opencode+{P}@{V}/node_modules/@opencode/{P}"));
        tree.link("pnpm9/global/5/node_modules/@opencode/browse", &format!("../.pnpm/@opencode+browse@{V}/node_modules/@opencode/browse"));
        cases.push(("pnpm 9", launcher, binary.clone(), "pnpm", Some("pnpm9".into()), Some("pnpm9/global/5/node_modules/@opencode/browse".into())));
        cases.push(("pnpm 9, older launcher", PathBuf::new(), binary, "pnpm", Some("pnpm9".into()), Some("pnpm9/global/5/node_modules/@opencode/browse".into())));

        // pnpm 11: the global virtual store in $PNPM_HOME/store/v11/links, linked from global/v11/<install>, which a
        // stable alias names; the platform package is a sibling link to its own store folder.
        let links = "pnpm11/store/v11/links/@opencode";
        let package = format!("{links}/browse/{V}/aaa/node_modules/@opencode/browse");
        let launcher = tree.package(&package);
        let binary = tree.platform(&format!("{links}/{P}/{V}/bbb/node_modules/@opencode/{P}"));
        tree.link(&format!("{links}/browse/{V}/aaa/node_modules/@opencode/{P}"), &format!("../../../../../{P}/{V}/bbb/node_modules/@opencode/{P}"));
        tree.link("pnpm11/global/v11/3ee71c-1a1dd/node_modules/@opencode/browse", &format!("../../../../../store/v11/links/@opencode/browse/{V}/aaa/node_modules/@opencode/browse"));
        tree.link("pnpm11/global/v11/770e7348", "3ee71c-1a1dd");
        let alias = "pnpm11/global/v11/770e7348/node_modules/@opencode/browse";
        cases.push(("pnpm 11", launcher, binary.clone(), "pnpm", Some("pnpm11".into()), Some(alias.into())));
        cases.push(("pnpm 11, older launcher", PathBuf::new(), binary.clone(), "pnpm", Some("pnpm11".into()), Some(alias.into())));
        // pnpm dlx links the same store (its own browse folder, the same platform package) from its cache.
        let dlx = format!("{links}/browse/{V}/ccc/node_modules/@opencode/browse");
        let launcher = tree.package(&dlx);
        tree.link(&format!("{links}/browse/{V}/ccc/node_modules/@opencode/{P}"), &format!("../../../../../{P}/{V}/bbb/node_modules/@opencode/{P}"));
        cases.push(("pnpm 11 dlx", launcher, binary, "pnpm-dlx", None, None));

        // pnpm 10 dlx: <cache>/pnpm/dlx/<hash>/<id>/node_modules/.pnpm.
        let store = "home/.cache/pnpm/dlx/e432/1a1d-3f05/node_modules/.pnpm";
        let launcher = tree.package(&format!("{store}/@opencode+browse@{V}/node_modules/@opencode/browse"));
        let binary = tree.platform(&format!("{store}/@opencode+{P}@{V}/node_modules/@opencode/{P}"));
        tree.link(&format!("{store}/@opencode+browse@{V}/node_modules/@opencode/{P}"), &format!("../../../@opencode+{P}@{V}/node_modules/@opencode/{P}"));
        cases.push(("pnpm 10 dlx", launcher, binary, "pnpm-dlx", None, None));

        // npx, bunx and yarn dlx: their temporary installs.
        for (case, modules, method) in [
            ("npx", "home/.npm/_npx/4d2a/node_modules", "npx"),
            ("bunx", "tmp/bunx-1000-@opencode/browse@dev/node_modules", "bunx"),
            ("yarn dlx", "tmp/xfs-1a2b3c/dlx-4242/node_modules", "yarn-dlx"),
            ("a project's node_modules", "project/node_modules", "other"),
        ] {
            let launcher = tree.package(&format!("{modules}/@opencode/browse"));
            let binary = tree.platform(&format!("{modules}/@opencode/{P}"));
            cases.push((case, launcher, binary, method, None, None));
        }

        for (case, launcher, binary, method, folder, package) in cases {
            let launcher = if launcher.as_os_str().is_empty() { Launcher::default() } else { launched(&launcher) };
            let install = detect(&binary, &launcher, &installed);
            let expected = (method, folder.map(|f| tree.path(&f)), package.map(|p| tree.path(&p)));
            assert_eq!(found(&install), expected, "{case}");
            if let Install::Global(global) = &install {
                assert_eq!(global.binary().map(|b| std::fs::canonicalize(b).unwrap()), Some(binary.clone()), "{case}: re-resolves its binary");
                assert_eq!(global.version().as_deref(), Some(V), "{case}");
                assert_eq!(install.executable().map(|b| std::fs::canonicalize(b).unwrap()), Some(binary), "{case}");
            }
        }
    }

    #[test]
    fn detects_the_binary_a_checkout_and_anything_else() {
        let tree = Tree::new("kinds");
        let installed = tree.file("home/.local/bin/browse", "");
        assert_eq!(detect(&installed, &Launcher::default(), &installed), Install::Binary(installed.clone()));
        tree.file("checkout/rust/Cargo.toml", "");
        assert_eq!(detect(&tree.file("checkout/rust/target/debug/browse", ""), &Launcher::default(), &installed), Install::Checkout);
        assert_eq!(detect(&tree.file("checkout/rust/target/x86_64-unknown-linux-musl/release/browse", ""), &Launcher::default(), &installed), Install::Checkout);
        assert_eq!(detect(&tree.file("Downloads/browse", ""), &Launcher::default(), &installed), Install::Other);
        // A launcher that isn't the one running this binary (an inherited variable) doesn't make it a package's.
        let launcher = tree.package("usr/lib/node_modules/@opencode/browse");
        assert_eq!(detect(&tree.file("elsewhere/browse", ""), &launched(&launcher), &installed), Install::Other);
        // bun's folder layout without bun's package.json isn't bun's.
        let launcher = tree.package("somewhere/install/global/node_modules/@opencode/browse");
        let binary = tree.platform(&format!("somewhere/install/global/node_modules/@opencode/{P}"));
        assert_eq!(detect(&binary, &launched(&launcher), &installed), Install::Other);
    }

    #[cfg(unix)]
    #[test]
    fn a_platform_package_after_an_update() {
        let tree = Tree::new("moved");
        let (launcher, binary, _) = npm(&tree, "prefix", false);
        let Install::Global(npm) = detect(&binary, &launched(&launcher), Path::new("/nonexistent/browse")) else { panic!("not npm") };
        // npm picked the other libc's package this time.
        std::fs::remove_dir_all(binary.parent().unwrap().parent().unwrap()).unwrap();
        assert_eq!(npm.binary(), None);
        let musl = tree.platform(&format!("prefix/lib/node_modules/@opencode/browse/node_modules/@opencode/{P}-musl"));
        assert_eq!(npm.binary(), cfg!(target_os = "linux").then_some(musl));
    }

    fn args(command: &std::process::Command) -> Vec<String> {
        command.get_args().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    fn env(command: &std::process::Command, name: &str) -> Option<PathBuf> {
        command.get_envs().find(|(k, _)| *k == name).and_then(|(_, v)| v.map(PathBuf::from))
    }

    fn global(manager: Manager, launcher: Launcher) -> Global {
        Global { package: PathBuf::from("/x/@opencode/browse"), platform: P.into(), manager, launcher }
    }

    #[test]
    fn each_manager_installs_into_its_own_folder() {
        let tree = Tree::new("commands");
        let exe = |name: &str| if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() };
        let shim = |name: &str| if cfg!(windows) { format!("{name}.cmd") } else { name.to_owned() };

        let npm = global(Manager::Npm { prefix: "/p".into() }, Launcher::default());
        let command = npm.command("0.2.0", Some("http://r"));
        assert_eq!(command.get_program(), shim("npm").as_str());
        assert_eq!(args(&command), ["install", "--global", "--prefix", "/p", "--no-fund", "--no-audit", "--no-update-notifier", "@opencode/browse@0.2.0", "--registry=http://r", "--@opencode:registry=http://r"]);

        // bun: the bun that ran the launcher, else the bun folder's own, else PATH; always into that folder.
        let root = tree.path(".bun");
        let bun = |ran: Option<PathBuf>| global(Manager::Bun { root: root.clone() }, Launcher { bun: ran, ..Launcher::default() });
        let command = bun(None).command("0.2.0", None);
        assert_eq!(command.get_program(), exe("bun").as_str());
        assert_eq!(args(&command), ["add", "--global", "--no-progress", "@opencode/browse@0.2.0"]);
        assert_eq!(env(&command, "BUN_INSTALL"), Some(root.clone()));
        let own = tree.file(&format!(".bun/bin/{}", exe("bun")), "");
        assert_eq!(bun(None).command("0.2.0", Some("http://r")).get_program(), own.as_os_str());
        assert_eq!(args(&bun(None).command("0.2.0", Some("http://r"))).last().unwrap(), "--registry=http://r");
        let ran = tree.file(&format!("opt/bun/{}", exe("bun")), "");
        assert_eq!(bun(Some(ran.clone())).command("0.2.0", None).get_program(), ran.as_os_str());
        assert_eq!(bun(Some(tree.path("gone/bun"))).command("0.2.0", None).get_program(), own.as_os_str());

        // pnpm: the pnpm that ran the launcher, PNPM_HOME's, corepack's beside node, else PATH; PNPM_HOME and its bin
        // folders on PATH, as pnpm requires.
        let home = tree.path("pnpm");
        let node = tree.file("node/bin/node", "");
        let pnpm = |launcher: Launcher| global(Manager::Pnpm { home: home.clone() }, launcher);
        let command = pnpm(Launcher::default()).command("0.2.0", Some("http://r"));
        assert_eq!(command.get_program(), shim("pnpm").as_str());
        assert_eq!(args(&command), ["add", "--global", "@opencode/browse@0.2.0", "--registry=http://r"]);
        assert_eq!(env(&command, "PNPM_HOME"), Some(home.clone()));
        let path = env(&command, "PATH").unwrap();
        assert_eq!(std::env::split_paths(&path).take(2).collect::<Vec<_>>(), [home.join("bin"), home.clone()]);
        let corepack = tree.file(&format!("node/bin/{}", shim("pnpm")), "");
        let by_node = Launcher { node: Some(node.clone()), ..Launcher::default() };
        assert_eq!(pnpm(by_node.clone()).command("0.2.0", None).get_program(), corepack.as_os_str());
        let standalone = tree.file(&format!("pnpm/{}", exe("pnpm")), "");
        assert_eq!(pnpm(by_node.clone()).command("0.2.0", None).get_program(), standalone.as_os_str());
        let cli = tree.file("pnpm-cli/bin/pnpm.cjs", "");
        let by_pnpm = Launcher { user_agent: Some("pnpm/11.3.0 npm/? node/v22.11.0 linux x64".into()), exec_path: Some(cli.clone()), ..by_node.clone() };
        let command = pnpm(by_pnpm.clone()).command("0.2.0", None);
        assert_eq!((command.get_program(), args(&command)[0].as_str()), (node.as_os_str(), cli.to_str().unwrap()));
        // Another package manager's npm_execpath is no pnpm.
        let by_npm = Launcher { user_agent: Some("npm/10.9.0 node/v22.11.0".into()), ..by_pnpm };
        assert_eq!(pnpm(by_npm).command("0.2.0", None).get_program(), standalone.as_os_str());

        // yarn classic: into its global folder.
        let folder = tree.path("home/.config/yarn/global");
        let yarn = global(Manager::Yarn { folder: folder.clone() }, Launcher::default());
        let command = yarn.command("0.2.0", Some("http://r"));
        assert_eq!(command.get_program(), shim("yarn").as_str());
        assert_eq!(args(&command), ["global", "add", "@opencode/browse@0.2.0", "--global-folder", folder.to_str().unwrap(), "--non-interactive", "--no-progress", "--registry", "http://r"]);

        // volta: VOLTA_HOME's volta.
        let home = tree.path(".volta");
        let volta = global(Manager::Volta { home: home.clone() }, Launcher::default());
        assert_eq!(args(&volta.command("0.2.0", None)), ["install", "@opencode/browse@0.2.0"]);
        assert_eq!(volta.command("0.2.0", None).get_program(), exe("volta").as_str());
        let own = tree.file(&format!(".volta/bin/{}", exe("volta")), "");
        assert_eq!(volta.command("0.2.0", None).get_program(), own.as_os_str());
        assert_eq!(env(&volta.command("0.2.0", None), "VOLTA_HOME"), Some(home));
    }

    #[test]
    fn every_method_names_its_update_command_and_an_old_extension_s_kind() {
        let exe = Path::new("/somewhere/browse");
        let global = |manager| Install::Global(global(manager, Launcher::default()));
        let table = [
            (Install::Binary("/b".into()), "binary", "binary", "browse update"),
            (global(Manager::Npm { prefix: "/p".into() }), "npm", "npm", "npm install -g @opencode/browse@dev"),
            (global(Manager::Bun { root: "/b".into() }), "bun", "binary", "bun add -g @opencode/browse@dev"),
            (global(Manager::Pnpm { home: "/p".into() }), "pnpm", "binary", "pnpm add -g @opencode/browse@dev"),
            (global(Manager::Yarn { folder: "/y".into() }), "yarn", "binary", "yarn global add @opencode/browse@dev"),
            (global(Manager::Volta { home: "/v".into() }), "volta", "binary", "volta install @opencode/browse@dev"),
            (Install::Runner(Runner::Npx), "npx", "npx", "npx @opencode/browse@dev install"),
            (Install::Runner(Runner::Bunx), "bunx", "npx", "bunx @opencode/browse@dev install"),
            (Install::Runner(Runner::PnpmDlx), "pnpm-dlx", "npx", "pnpm dlx @opencode/browse@dev install"),
            (Install::Runner(Runner::YarnDlx), "yarn-dlx", "npx", "yarn dlx @opencode/browse@dev install"),
            (Install::Checkout, "checkout", "checkout", "/somewhere/browse update"),
            (Install::Other, "other", "other", "/somewhere/browse install"),
        ];
        for (install, method, compatible, command) in table {
            assert_eq!((install.name(), install.compatible_name(), install.update_command("0.2.0-dev.4", exe).as_str()), (method, compatible, command));
        }
        assert_eq!(Install::Runner(Runner::Npx).update_command("0.2.0", exe), "npx @opencode/browse install");
        assert_eq!(Runner::Bunx.global_words("dev"), "bun add -g @opencode/browse@dev");
    }
}
