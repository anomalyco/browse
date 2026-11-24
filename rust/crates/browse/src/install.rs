//! `browse install` and `browse uninstall` (cli/src/setup.ts, setup/commands.ts): put browse where it keeps itself
//! up to date, add its MCP server to the agents the user picks, and connect the extension; or take all of that out.
//!
//! Where browse lives depends on how it got here (method.rs), so there is always exactly one browse that updates:
//!   install script   ~/.local/bin/browse is this executable already, and updates itself from the release service
//!   npm/bun/pnpm/yarn/volta global   the package manager's own `browse` shim, which that manager updates; nothing
//!                    is copied (a copy would be a second browse that forks the updates)
//!   npx/bunx/dlx, or a binary run from anywhere else   copied to ~/.local/bin, which then updates itself
//!   checkout build   used where it is; it doesn't update

use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, bail};
use serde_json::{Value, json};

use crate::agents::{self, AGENTS, Edit, Location};
use crate::method::{self, Global, Install, Manager};
use crate::relay_api::{self, bin_root};
use crate::setup::{self, McpEdit, tilde};
use crate::{VERSION, browsers, picker, relay, remote, session, update};

#[derive(Default)]
struct Flags {
    requested: Vec<&'static str>,
    all: bool,
    none: bool,
    yes: bool,
    no_open: bool,
    no_wait: bool,
    wait_seconds: Option<u64>,
    no_modify_path: bool,
    remote: bool,
    /// Connect this Firefox-family app (`firefox`, `zen`) instead of the Chrome extension.
    firefox: Option<&'static str>,
    opencode: Option<PathBuf>,
}

fn parse(args: &[String]) -> anyhow::Result<Flags> {
    let mut flags = Flags::default();
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        i += 1;
        let mut value = |name: &str| -> anyhow::Result<String> {
            let value = args.get(i).filter(|v| !v.starts_with('-')).cloned().with_context(|| format!("{name} needs a value"))?;
            i += 1;
            Ok(value)
        };
        match arg {
            "-a" | "--agent" => {
                let start = i;
                while let Some(name) = args.get(i).filter(|a| !a.starts_with('-')) {
                    i += 1;
                    match name.as_str() {
                        "*" | "all" => flags.all = true,
                        "none" => flags.none = true,
                        name => match agents::agent_name(name) {
                            Some(agent) if !flags.requested.contains(&agent) => flags.requested.push(agent),
                            Some(_) => {}
                            None => bail!(
                                "Unknown agent {name:?}. Choose from {}, or `none` to add browse to another agent yourself.",
                                AGENTS.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", ")
                            ),
                        },
                    }
                }
                if i == start {
                    bail!("{arg} needs at least one agent name (or '*' for all, or 'none')");
                }
            }
            "--all-agents" => flags.all = true,
            "-y" | "--yes" => flags.yes = true,
            "--no-open" => flags.no_open = true,
            "--no-wait" => flags.no_wait = true,
            "--no-modify-path" => flags.no_modify_path = true,
            "--remote" => flags.remote = true,
            "--firefox" => flags.firefox = Some("firefox"),
            "--zen" => flags.firefox = Some("zen"),
            "--wait-seconds" => {
                let seconds = value(arg)?.parse::<u64>().ok().filter(|s| (1..=3600).contains(s)).context("--wait-seconds must be between 1 and 3600")?;
                flags.wait_seconds = Some(seconds);
            }
            "--opencode" => flags.opencode = Some(PathBuf::from(value(arg)?)),
            other => bail!("Unknown option {other} for install. Run `browse --help`."),
        }
    }
    if flags.none && (flags.all || !flags.requested.is_empty()) {
        bail!("--agent none can't be combined with agent names");
    }
    if flags.remote && flags.firefox.is_some() {
        bail!("--remote pairs a browser on another computer; --firefox and --zen connect one on this computer. Pick one.");
    }
    Ok(flags)
}

/// Which agents to set up, and whether to ask.
fn plan(locations: &[Location], flags: &Flags, tty: bool, caller: Option<&'static str>, remembered: Option<Vec<&'static str>>) -> (bool, Vec<&'static str>) {
    let detected: Vec<&'static str> = locations.iter().filter(|l| l.installed).map(|l| l.name).collect();
    if flags.none {
        return (false, Vec::new());
    }
    if flags.all {
        return (false, AGENTS.iter().map(|(n, _)| *n).collect());
    }
    if !flags.requested.is_empty() {
        return (false, flags.requested.clone());
    }
    if let Some(caller) = caller {
        return (false, vec![caller]);
    }
    if flags.yes {
        return (false, detected);
    }
    if !tty {
        // Nothing says which agent asked: OpenCode stays the default.
        return (false, detected.into_iter().filter(|n| *n == "opencode").collect());
    }
    let initial = remembered.unwrap_or_else(|| {
        let mut initial = detected;
        if !initial.contains(&"opencode") {
            initial.insert(0, "opencode");
        }
        initial
    });
    (true, initial)
}

/// The shim the package manager put on PATH for this global install, which it keeps pointing at the installed
/// version. Agents run this, so the package manager's updates reach them.
fn global_shim(global: &Global) -> Option<PathBuf> {
    let unix = |dir: &Path| dir.join("browse");
    let candidates: Vec<PathBuf> = match &global.manager {
        Manager::Npm { prefix } => vec![if cfg!(windows) { prefix.join("browse.cmd") } else { unix(&prefix.join("bin")) }],
        Manager::Bun { root } => vec![root.join("bin").join(method::EXECUTABLE)],
        Manager::Pnpm { home } => {
            let name = if cfg!(windows) { "browse.cmd" } else { "browse" };
            vec![home.join(name), home.join("bin").join(name)]
        }
        Manager::Yarn { folder } => {
            let on_path = browsers::on_path("browse").filter(|p| std::fs::canonicalize(p).is_ok_and(|c| c.starts_with(folder)));
            on_path.into_iter().chain([folder.join("node_modules/.bin").join(if cfg!(windows) { "browse.cmd" } else { "browse" })]).collect()
        }
        Manager::Volta { home } => vec![home.join("bin").join(method::EXECUTABLE)],
    };
    candidates.into_iter().find(|c| c.is_file())
}

/// Whether running `file` needs node on PATH (npm's and bun's shims link the launcher, whose shebang is node).
fn needs_node(file: &Path) -> bool {
    if cfg!(windows) {
        return false;
    }
    let target = std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
    target.extension().is_some_and(|e| e == "mjs" || e == "js")
}

/// Whether `file` is a browse executable: it answers `--version` with a version.
fn is_browse(file: &Path) -> bool {
    let output = std::process::Command::new(file).arg("--version").env("OPENCODE_BROWSER_AUTOSTART", "0").stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output();
    output.is_ok_and(|o| {
        let text = String::from_utf8_lossy(&o.stdout);
        let text = text.trim();
        o.status.success() && text.split(['.', '-']).next().is_some_and(|major| !major.is_empty() && major.chars().all(|c| c.is_ascii_digit()))
    })
}

/// How to remove another browse found at `file`, as its path suggests it was installed.
fn removal(file: &Path) -> String {
    let target = std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf()).to_string_lossy().replace('\\', "/");
    let text = format!("{}|{target}", file.to_string_lossy().replace('\\', "/"));
    if text.contains("/.bun/") {
        "`bun remove -g @opencode/browse`".into()
    } else if text.contains("pnpm") {
        "`pnpm remove -g @opencode/browse`".into()
    } else if text.contains("/.volta/") {
        "`volta uninstall @opencode/browse`".into()
    } else if text.contains("yarn") {
        "`yarn global remove @opencode/browse`".into()
    } else if target.contains("@opencode/browse") || target.ends_with(".mjs") {
        "`npm rm -g @opencode/browse`".into()
    } else {
        format!("delete {}", file.display())
    }
}

/// Every `browse` on PATH that isn't `entry`, in PATH order, and whether each comes before it.
fn other_browses(entry: &Path) -> Vec<(PathBuf, bool)> {
    let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let mine = canonical(entry);
    let names: &[&str] = if cfg!(windows) { &["browse.exe", "browse.cmd"] } else { &["browse"] };
    let mut seen_mine = false;
    let mut found: Vec<(PathBuf, bool)> = Vec::new();
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        for name in names {
            let file = dir.join(name);
            // A package runner's own temporary install (npx puts its node_modules/.bin on PATH while it runs).
            let temporary = file.to_string_lossy().replace('\\', "/").contains("node_modules/.bin");
            if !file.is_file() || temporary {
                continue;
            }
            if canonical(&file) == mine || file == entry {
                seen_mine = true;
            } else if !found.iter().any(|(f, _)| canonical(f) == canonical(&file)) {
                found.push((file, !seen_mine));
            }
        }
    }
    found
}

fn warn_other_browses(entry: &Path) {
    for (file, first) in other_browses(entry) {
        let order = if first { ", ahead of this one on PATH" } else { "" };
        println!("! Another browse is installed at {}{order}. Remove it ({}) so your terminal and your agents run the same browse.", tilde(&file), removal(&file));
    }
}

/// Copies this executable to ~/.local/bin/browse (or $XDG_BIN_HOME), where updates replace it in place.
fn copy_binary() -> anyhow::Result<PathBuf> {
    let target = bin_root().join(method::EXECUTABLE);
    let running = relay::current_exe()?;
    if std::fs::canonicalize(&target).ok() == std::fs::canonicalize(&running).ok() {
        return Ok(target);
    }
    let dir = target.parent().context("no bin folder")?;
    std::fs::create_dir_all(dir)?;
    let staged = dir.join(format!(".browse.{}.new", std::process::id()));
    std::fs::copy(&running, &staged).with_context(|| format!("could not install browse to {}", target.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
    }
    if cfg!(windows) && target.exists() {
        std::fs::rename(&target, dir.join(format!("browse.exe.old-{}", session::random_u64() as u32)))?;
    }
    std::fs::rename(&staged, &target)?;
    Ok(target)
}

fn self_updating(binary: &Path, flags: &Flags) {
    println!("✓ browse {VERSION} installed ({}). It updates itself from the {} channel.", tilde(binary), update::channel());
    if !flags.no_modify_path
        && let Some(file) = binary.parent().and_then(setup::add_to_path)
    {
        println!("✓ Added {} to your PATH ({file}). Open a new terminal to use `browse` there.", tilde(binary.parent().unwrap_or(binary)));
    }
    warn_other_browses(binary);
}

/// Puts browse where it stays up to date (see the module comment) and returns the command agents run.
fn place(flags: &Flags) -> anyhow::Result<PathBuf> {
    let exe = relay::current_exe()?;
    match method::install() {
        Install::Binary(binary) => {
            self_updating(&binary, flags);
            Ok(binary)
        }
        Install::Global(global) => {
            let manager = global.manager.name();
            let shim = if cfg!(windows) && !matches!(global.manager, Manager::Pnpm { .. }) { None } else { global_shim(&global) };
            let entry = match shim {
                Some(shim) if needs_node(&shim) && browsers::on_path("node").is_none() => global.binary().unwrap_or(exe),
                Some(shim) => shim,
                None => global.binary().unwrap_or(exe),
            };
            println!("✓ browse {VERSION} is installed with {manager} ({}). {manager} keeps it up to date; nothing else is installed.", tilde(&entry));
            let copy = bin_root().join(method::EXECUTABLE);
            let separate = copy.is_file() && std::fs::canonicalize(&copy).ok() != std::fs::canonicalize(&entry).ok();
            if separate && is_browse(&copy) {
                match std::fs::remove_file(&copy) {
                    Ok(()) => println!("✓ Removed the separate browse at {}, so only the {manager} install runs and updates", tilde(&copy)),
                    Err(error) => println!("! Couldn't remove the separate browse at {} ({error}); delete it so only the {manager} install runs.", tilde(&copy)),
                }
            }
            warn_other_browses(&entry);
            Ok(entry)
        }
        Install::Checkout => {
            println!("✓ Using this checkout's build ({}). It doesn't update itself: rebuild, then run install again.", exe.display());
            Ok(exe)
        }
        Install::Runner(_) | Install::Other => {
            let binary = copy_binary()?;
            self_updating(&binary, flags);
            Ok(binary)
        }
    }
}

/// A relay still running another version keeps serving agents with it; restart it on this one unless an agent is busy.
fn restart_outdated_relay() {
    let relay::Probe::Running(version) = relay::probe() else { return };
    if version.get("version").and_then(Value::as_str) == Some(VERSION) {
        return;
    }
    let running = version.get("version").and_then(Value::as_str).unwrap_or("an older version").to_owned();
    let busy = relay::extension_status(false).and_then(|s| s.get("targets").cloned()).and_then(|t| t.as_array().cloned()).is_some_and(|t| t.iter().any(|t| t["busy"] == true));
    if busy {
        println!("! The relay still runs browse {running} while an agent uses the browser; it switches once you run install again when it's idle.");
        return;
    }
    match relay::stop() {
        Ok(_) => println!("✓ Stopped the relay running browse {running}; the next agent call starts {VERSION}"),
        Err(error) => println!("! The relay still runs browse {running}: {error:#}"),
    }
}

fn names(list: &[&str]) -> String {
    list.iter().map(|n| agents::label(n)).collect::<Vec<_>>().join(", ")
}

pub fn install(args: &[String]) -> anyhow::Result<i32> {
    let flags = parse(args)?;
    let tty = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    let caller = agents::calling_agent();
    if let Some(caller) = caller.filter(|_| flags.requested.is_empty() && !flags.all && !flags.none) {
        println!("{} is running this, so browse is set up for {}.", agents::label(caller), agents::label(caller));
    }
    let entry = place(&flags)?;
    let command = vec![entry.to_string_lossy().into_owned(), "mcp".to_owned()];
    // A pinned relay port goes in every entry, so an agent that starts the server with a bare environment still dials
    // the relay the extension is paired with.
    let port = browse_relay::port::env_port();
    restart_outdated_relay();

    let opencode = flags.opencode.clone().or_else(|| std::env::var_os("OPENCODE_BIN").map(PathBuf::from)).or_else(|| browsers::on_path("opencode"));
    let opencode_config = setup::opencode_config();
    let locations = agents::locations(&opencode_config, opencode.as_deref());
    let mut saved = setup::settings();
    let remembered: Option<Vec<&'static str>> = saved.get("selectedAgents").and_then(Value::as_array).map(|list| list.iter().filter_map(|v| v.as_str().and_then(agents::agent_name)).collect());
    let (ask, initial) = plan(&locations, &flags, tty, caller, remembered);
    let selected = if ask {
        println!();
        let choices: Vec<picker::Choice> = {
            let mut sorted: Vec<&Location> = locations.iter().collect();
            sorted.sort_by_key(|l| (l.name != "opencode", !l.installed, agents::label(l.name)));
            sorted.into_iter().map(|l| picker::Choice { name: l.name, label: agents::label(l.name), installed: l.installed }).collect()
        };
        match picker::pick(&choices, &initial)? {
            Some(selected) => {
                saved["selectedAgents"] = json!(selected);
                selected
            }
            None => {
                println!("Cancelled; nothing was set up. Run `browse install` again when you're ready.");
                return Ok(130);
            }
        }
    } else {
        initial
    };

    let mut status = 0;
    let mut receipts: Vec<Value> = saved.get("agents").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut opencode_configs: Vec<Value> = saved.get("opencodeConfigs").and_then(Value::as_array).cloned().unwrap_or_default();
    for location in locations.iter().filter(|l| selected.contains(&l.name)) {
        let label = agents::label(location.name);
        let file = tilde(&location.file);
        if location.name == "opencode" {
            match setup::configure_opencode(&location.file, &entry, port) {
                Ok(McpEdit::Added) => println!("✓ Added browse to {label} ({file})"),
                Ok(McpEdit::Updated) => println!("✓ Updated browse in {label} ({file})"),
                Ok(McpEdit::UpToDate) => println!("✓ {label} already has browse"),
                Ok(McpEdit::Conflict) => {
                    println!("! {label} already has a different server named browse in {file}; left it unchanged.");
                    status = 1;
                }
                Err(error) => {
                    println!("! Couldn't add browse to {label}: {error:#}");
                    status = 1;
                }
            }
            if !opencode_configs.iter().any(|f| f.as_str() == Some(&location.file.to_string_lossy())) {
                opencode_configs.push(json!(location.file));
            }
            continue;
        }
        match agents::edit(location, &command, false, port) {
            Ok(Edit::Added) => println!("✓ Added browse to {label} ({file})"),
            Ok(Edit::Updated) => println!("✓ Updated browse in {label} ({file})"),
            Ok(Edit::Unchanged | Edit::Removed) => println!("✓ {label} already has browse"),
            Ok(Edit::Conflict) => {
                println!("! {label} already has a different server named browse in {file}; left it unchanged.");
                status = 1;
            }
            Err(error) => {
                println!("! Couldn't add browse to {label}: {error:#}. Fix the file, then run `browse install --agent {}`.", location.name);
                status = 1;
            }
        }
        receipts.retain(|r| r["name"].as_str() != Some(location.name));
        receipts.push(json!({ "name": location.name, "file": location.file, "entry": entry }));
    }
    if selected.is_empty() {
        let intro = if flags.none || ask { "Add browse to your agent as an MCP server (stdio):" } else { "No agent was set up: couldn't tell which agent is running this, and OpenCode isn't installed. Add browse to your agent as an MCP server (stdio):" };
        println!("\n{intro}");
        for line in agents::manual_entry(&command, port).lines() {
            println!("  {line}");
        }
        if !flags.none && !ask {
            println!("or rerun with `browse install --agent <name>` ({}).", AGENTS.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", "));
        }
        println!();
    } else if !ask && flags.requested.is_empty() && !flags.all {
        let others: Vec<&str> = locations.iter().filter(|l| l.installed && !selected.contains(&l.name)).map(|l| l.name).collect();
        if !others.is_empty() {
            println!("Also found {}. To add browse there too: browse install --agent {}", names(&others), others.join(" "));
        }
    }

    saved["entry"] = json!(entry);
    saved["version"] = json!(VERSION);
    saved["method"] = json!(method::install().name());
    saved["agents"] = Value::Array(receipts);
    saved["opencodeConfigs"] = Value::Array(opencode_configs);
    if let Some(opencode) = opencode {
        saved["opencode"] = json!(opencode);
    }
    update::write_private(&setup::settings_path(), format!("{saved:#}\n").as_bytes())?;

    let agent = !std::io::stdout().is_terminal();
    if agent && let Some(caller) = caller {
        println!("Agent: browse's tools appear in {} once it reloads its MCP servers; if they don't show up, ask the user to restart {}.", agents::label(caller), agents::label(caller));
    }
    if flags.remote {
        return Ok(status.max(remote::install(agent)?));
    }
    let firefox = match flags.firefox {
        Some(app) => Some(app),
        None => choose_browser(tty)?,
    };
    let connected = match firefox {
        Some(app) => crate::firefox::connect(&crate::firefox::Options { app: Some(app.into()), ..Default::default() })?,
        None => {
            let seconds = flags.wait_seconds.unwrap_or(if tty { 180 } else { 90 });
            setup::connect_extension(!flags.no_open, !flags.no_wait, Duration::from_secs(seconds))?
        }
    };
    if tty && !selected.is_empty() && connected == 0 {
        match selected.as_slice() {
            [one] => println!("If {} was already running, restart it so it loads browse.", agents::label(one)),
            [rest @ .., last] => println!("If {} or {} were already running, restart them so they load browse.", names(rest), agents::label(last)),
            [] => {}
        }
    }
    Ok(status.max(connected))
}

/// With no Chromium browser that has the extension and Firefox or Zen installed, a person at a terminal picks which to
/// connect; anyone else gets the Chrome flow and a pointer to `browse firefox`.
fn choose_browser(tty: bool) -> anyhow::Result<Option<&'static str>> {
    let apps = browse_relay::firefox::apps();
    if apps.is_empty() || relay::extension_status(false).is_some_and(|s| s["connected"] == true || s["pairingState"] == "paired-offline") {
        return Ok(None);
    }
    if !browsers::detect(&browsers::browsers()).is_empty() {
        return Ok(None);
    }
    let firefox = apps.iter().find(|a| a.kind != browse_relay::firefox::AppKind::Zen).map(|_| "firefox").unwrap_or("zen");
    let names = crate::firefox::installed_names().join(", ");
    if !tty {
        println!("{names} is installed too: `browse firefox{}` connects it instead of the Chrome extension.", if firefox == "zen" { " --app zen" } else { "" });
        return Ok(None);
    }
    print!("Connect which browser? [c]hrome-family browser with the browse extension / [f]irefox or Zen ({names}): ");
    std::io::Write::flush(&mut std::io::stdout())?;
    let mut line = String::new();
    std::io::BufRead::read_line(&mut std::io::stdin().lock(), &mut line)?;
    Ok(line.trim().to_lowercase().starts_with('f').then_some(firefox))
}

/// `browse uninstall`: removes browse from every agent config where an install put it, stops the relay, and deletes
/// the executable this install placed and browse's files. A package manager's install is left to that manager.
pub fn uninstall(args: &[String]) -> anyhow::Result<i32> {
    if let Some(other) = args.first() {
        bail!("Unknown option {other} for uninstall. Run `browse --help`.");
    }
    let paths = relay_api::paths();
    // Only a browser that was paired (or connected through the extension) has an extension to remove.
    let paired = !browse_relay::pairing::read_browser_pairings(&paths).is_empty()
        || browse_relay::paths::read_json::<serde_json::Map<String, Value>>(&paths.browsers()).is_some_and(|known| known.keys().any(|key| !key.starts_with("driver:")));
    let mut status = crate::firefox::uninstall();
    match relay::stop() {
        Ok(true) => println!("✓ Stopped the relay"),
        Ok(false) => {}
        Err(error) => {
            println!("! {error:#}. Stop it yourself (it exits once no agent uses it).");
            status = 1;
        }
    }
    let saved = setup::settings();
    let mut opencode_files: Vec<PathBuf> = saved.get("opencodeConfigs").and_then(Value::as_array).into_iter().flatten().filter_map(|v| v.as_str().map(PathBuf::from)).collect();
    opencode_files.push(setup::opencode_config());
    opencode_files.dedup();
    for file in opencode_files {
        match setup::remove_opencode(&file) {
            Ok(true) => println!("✓ Removed browse from OpenCode ({})", tilde(&file)),
            Ok(false) => {}
            Err(error) => {
                println!("! Couldn't remove browse from {}: {error:#}", tilde(&file));
                status = 1;
            }
        }
    }
    let mut locations: Vec<Location> = agents::locations(&setup::opencode_config(), None).into_iter().filter(|l| l.name != "opencode").collect();
    for receipt in saved.get("agents").and_then(Value::as_array).into_iter().flatten() {
        let (Some(name), Some(file)) = (receipt["name"].as_str().and_then(agents::agent_name), receipt["file"].as_str()) else { continue };
        if name != "opencode" && !locations.iter().any(|l| l.file == Path::new(file)) {
            locations.push(Location { name, file: file.into(), installed: true });
        }
    }
    let placeholder = ["browse".to_owned(), "mcp".to_owned()];
    for location in &locations {
        let label = agents::label(location.name);
        match agents::edit(location, &placeholder, true, None) {
            Ok(Edit::Removed) => println!("✓ Removed browse from {label} ({})", tilde(&location.file)),
            Ok(Edit::Conflict) => println!("! {} has a server named browse that browse didn't write; left it unchanged.", tilde(&location.file)),
            Ok(_) => {}
            Err(error) => {
                println!("! Couldn't remove browse from {label}: {error:#}");
                status = 1;
            }
        }
    }
    let install = method::install();
    let binary = bin_root().join(method::EXECUTABLE);
    if binary.is_file() && (matches!(install, Install::Binary(_)) || is_browse(&binary)) {
        let removed = if cfg!(windows) {
            std::fs::rename(&binary, std::env::temp_dir().join(format!("browse-{}.exe", session::random_u64() as u32)))
        } else {
            std::fs::remove_file(&binary)
        };
        match removed {
            Ok(()) => println!("✓ Removed {}", tilde(&binary)),
            Err(error) => {
                println!("! Couldn't remove {} ({error}); delete it after this exits.", tilde(&binary));
                status = 1;
            }
        }
    }
    if let Some(file) = setup::remove_from_path(&bin_root()) {
        println!("✓ Took {} off your PATH ({file})", tilde(&bin_root()));
    }
    for dir in relay_api::browse_files() {
        if dir.exists() {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => println!("✓ Removed {}", tilde(&dir)),
                Err(error) => {
                    println!("! Couldn't remove all of {} ({error}); close running agents and delete what's left.", tilde(&dir));
                    status = 1;
                }
            }
        }
    }
    if let Install::Global(global) = &install {
        let words = match global.manager {
            Manager::Npm { .. } => "npm rm -g @opencode/browse",
            Manager::Bun { .. } => "bun remove -g @opencode/browse",
            Manager::Pnpm { .. } => "pnpm remove -g @opencode/browse",
            Manager::Yarn { .. } => "yarn global remove @opencode/browse",
            Manager::Volta { .. } => "volta uninstall @opencode/browse",
        };
        println!("browse itself is still installed with {}: run `{words}` to remove it.", global.manager.name());
    }
    if paired {
        println!("Remove the browse extension from your browser to finish (chrome://extensions).");
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn location(name: &'static str, installed: bool) -> Location {
        Location { name, file: PathBuf::from("/x"), installed }
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn flags() {
        let flags = parse(&args(&["-a", "claude", "codex", "--agent", "gemini-cli", "--no-wait"])).unwrap();
        assert_eq!(flags.requested, ["claude", "codex", "gemini"]);
        assert!(flags.no_wait);
        assert!(parse(&args(&["--agent"])).is_err());
        assert!(parse(&args(&["--agent", "nope"])).is_err());
        assert!(parse(&args(&["--bogus"])).is_err());
        assert!(parse(&args(&["--agent", "*"])).unwrap().all);
        assert!(parse(&args(&["--agent", "none"])).unwrap().none);
        assert_eq!(parse(&args(&["--wait-seconds", "5"])).unwrap().wait_seconds, Some(5));
        assert_eq!(parse(&args(&["--firefox"])).unwrap().firefox, Some("firefox"));
        assert_eq!(parse(&args(&["--zen", "-y"])).unwrap().firefox, Some("zen"));
        assert!(parse(&args(&["--firefox", "--remote"])).is_err());
        assert!(parse(&args(&["--remote", "--zen"])).is_err());
    }

    #[test]
    fn plans() {
        let found = [location("opencode", true), location("claude", true), location("codex", false)];
        let none = Flags::default();
        assert_eq!(plan(&found, &none, true, None, None), (true, vec!["opencode", "claude"]));
        assert_eq!(plan(&found, &none, true, None, Some(vec!["claude"])), (true, vec!["claude"]));
        assert_eq!(plan(&found, &none, false, None, None), (false, vec!["opencode"]));
        assert_eq!(plan(&found, &none, false, Some("codex"), None), (false, vec!["codex"]));
        let yes = Flags { yes: true, ..Flags::default() };
        assert_eq!(plan(&found, &yes, false, None, None), (false, vec!["opencode", "claude"]));
        let requested = Flags { requested: vec!["codex"], ..Flags::default() };
        assert_eq!(plan(&found, &requested, true, Some("claude"), None), (false, vec!["codex"]));
        let nothing = [location("opencode", false), location("claude", false)];
        assert_eq!(plan(&nothing, &none, true, None, None), (true, vec!["opencode"]));
        assert_eq!(plan(&nothing, &none, false, None, None), (false, vec![]));
    }
}
