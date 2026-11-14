//! Setting browse up for OpenCode (cli/src/setup.ts, setup/**): install the executable, add the browse MCP server to
//! OpenCode's config, and connect the extension. `pair`, `extension`, and `status` live here too.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use serde_json::{Value, json};

use crate::browsers::{self, Browser};
use crate::relay_api::{self, bin_root};
use browse_relay::pairing;
use crate::{VERSION, jsonc, relay, session, update};

const MCP_NAME: &str = "browse";
const LEGACY_MCP_NAME: &str = "opencode-browser";
const OPENCODE_CONFIG_NAMES: &[&str] = &["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"];
const CONNECTED: &str = "✓ Connected to your browser. Ask your agent to open a page.";
const PAIRED_OFFLINE: &str = "! Not connected yet. Open the browser profile already paired with browse and make sure the extension is enabled. It reconnects automatically.";

pub fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

pub fn config_home() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home().join(".config"))
}

fn tilde(path: &Path) -> String {
    let home = home();
    match path.strip_prefix(&home) {
        Ok(rest) if !home.as_os_str().is_empty() => format!("~/{}", rest.display()),
        _ => path.display().to_string(),
    }
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str)
}

pub fn binary_name() -> &'static str {
    if cfg!(windows) { "browse.exe" } else { "browse" }
}

/// OpenCode's global config file: the first that exists, else opencode.json.
pub fn opencode_config() -> PathBuf {
    let dir = config_home().join("opencode");
    OPENCODE_CONFIG_NAMES.iter().map(|name| dir.join(name)).find(|f| f.is_file()).unwrap_or_else(|| dir.join(OPENCODE_CONFIG_NAMES[0]))
}

fn mcp_servers(file: &Path) -> anyhow::Result<(String, serde_json::Map<String, Value>)> {
    let text = std::fs::read_to_string(file).unwrap_or_default();
    let invalid = || format!("Invalid {}; left unchanged", file.display());
    let config = jsonc::parse(&text).with_context(invalid)?;
    let mut servers = serde_json::Map::new();
    for (depth, value) in [Some(&config), config.get("mcp"), config.pointer("/mcp/servers")].into_iter().enumerate() {
        match value {
            Some(Value::Object(map)) if depth == 2 => servers = map.clone(),
            Some(Value::Object(_)) | None => {}
            Some(_) => bail!(invalid()),
        }
    }
    Ok((text, servers))
}

/// A browse server an install wrote: `[<browse executable>, "mcp"]` (or an older `[node, <entry>, "mcp"]`).
fn owned(server: &Value, entry: &Path) -> bool {
    let Some(command) = server.get("command").and_then(Value::as_array) else { return false };
    if !(2..=3).contains(&command.len()) || command.last().and_then(Value::as_str) != Some("mcp") {
        return false;
    }
    let target = command[command.len() - 2].as_str().unwrap_or_default();
    let name = Path::new(target).file_name().and_then(|n| n.to_str()).unwrap_or_default();
    Path::new(target) == entry || ["browse", "browse.exe", "cli.mjs", "opencode-browser.mjs"].contains(&name)
}

pub enum McpEdit {
    Added,
    Updated,
    UpToDate,
    Conflict,
}

/// Writes (or updates) the browse MCP server so it runs `entry`, keeping settings the user added. One pooled server
/// with a fixed cwd serves every OpenCode session; browse keys each agent's session on OpenCode's session id.
pub fn configure_opencode(file: &Path, entry: &Path) -> anyhow::Result<McpEdit> {
    let (mut text, servers) = mcp_servers(file)?;
    let existing = servers.get(MCP_NAME);
    if existing.is_some_and(|s| !owned(s, entry)) {
        return Ok(McpEdit::Conflict);
    }
    if servers.get(LEGACY_MCP_NAME).is_some_and(|s| owned(s, entry)) {
        text = jsonc::modify(&text, &["mcp", "servers", LEGACY_MCP_NAME], None)?;
    }
    let mut server = existing.cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
    let environment = server.get("environment").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
    server["type"] = json!("local");
    server["command"] = json!([entry.to_string_lossy(), "mcp"]);
    server["cwd"] = json!("~");
    server["pool"] = json!(true);
    server["environment"] = environment;
    server["environment"]["OPENCODE_BROWSER_RUNTIME"] = json!("auto-update");
    if existing == Some(&server) {
        return Ok(McpEdit::UpToDate);
    }
    let after = jsonc::modify(&text, &["mcp", "servers", MCP_NAME], Some(&server))?;
    write_keeping_mode(file, after.as_bytes())?;
    Ok(if existing.is_some() { McpEdit::Updated } else { McpEdit::Added })
}

fn write_keeping_mode(file: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let dir = file.parent().context("no parent folder")?;
    std::fs::create_dir_all(dir)?;
    let temporary = dir.join(format!(".{}.{}.tmp", file.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
    std::fs::write(&temporary, bytes)?;
    if let Ok(meta) = std::fs::metadata(file) {
        let _ = std::fs::set_permissions(&temporary, meta.permissions());
    }
    std::fs::rename(&temporary, file).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })?;
    Ok(())
}

/// Puts this executable at the install's stable path (~/.local/bin/browse); updates replace that file in place.
fn install_binary() -> anyhow::Result<PathBuf> {
    let target = bin_root().join(binary_name());
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

/// Adds the bin folder to PATH in the shell's startup file (or the Windows user PATH). Returns where.
fn add_to_path(dir: &Path) -> Option<String> {
    if std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|e| e == dir)) {
        return None;
    }
    if cfg!(windows) {
        let script = "$p=[Environment]::GetEnvironmentVariable('Path','User'); if (($p -split ';') -notcontains $env:BROWSE_DIR) { [Environment]::SetEnvironmentVariable('Path', ($(if ($p) { \"$p;\" }) + $env:BROWSE_DIR), 'User') }";
        let ok = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("BROWSE_DIR", dir)
            .status()
            .is_ok_and(|s| s.success());
        return ok.then(|| "Windows user PATH".into());
    }
    let shell = std::env::var("SHELL").unwrap_or_default();
    let shell = shell.rsplit('/').next().unwrap_or("sh");
    let home = home();
    let zdot = std::env::var_os("ZDOTDIR").map(PathBuf::from).unwrap_or_else(|| home.clone());
    let candidates = match shell {
        "fish" => vec![config_home().join("fish/config.fish")],
        "zsh" => vec![zdot.join(".zshrc"), zdot.join(".zshenv")],
        "bash" => vec![home.join(".bashrc"), home.join(".bash_profile"), home.join(".profile")],
        _ => vec![home.join(".profile")],
    };
    let quoted = format!("'{}'", dir.to_string_lossy().replace('\'', "'\\''"));
    let line = if shell == "fish" { format!("fish_add_path {quoted}") } else { format!("export PATH={quoted}:\"$PATH\"") };
    let file = candidates.iter().find(|f| f.exists()).unwrap_or(&candidates[0]);
    let text = std::fs::read_to_string(file).unwrap_or_default();
    if text.lines().any(|l| l == line) {
        return None;
    }
    let sep = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
    std::fs::create_dir_all(file.parent()?).ok()?;
    std::fs::write(file, format!("{text}{sep}\n# browse\n{line}\n")).ok()?;
    Some(tilde(file))
}

fn settings_path() -> PathBuf {
    relay_api::paths().config.join("settings.json")
}

pub fn settings() -> Value {
    std::fs::read(settings_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}))
}

pub fn install(args: &[String]) -> anyhow::Result<i32> {
    let tty = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    let no_open = args.iter().any(|a| a == "--no-open");
    let entry = install_binary()?;
    println!("✓ browse {VERSION} installed ({})", tilde(&entry));
    if !args.iter().any(|a| a == "--no-modify-path")
        && let Some(file) = entry.parent().and_then(add_to_path)
    {
        println!("✓ Added browse to your PATH ({file}). Open a new terminal to use it.");
    }
    let file = opencode_config();
    let mut status = 0;
    match configure_opencode(&file, &entry)? {
        McpEdit::Added => println!("✓ Added browse to OpenCode ({})", tilde(&file)),
        McpEdit::Updated => println!("✓ Updated browse in OpenCode ({})", tilde(&file)),
        McpEdit::UpToDate => println!("✓ OpenCode already has browse"),
        McpEdit::Conflict => {
            println!("! OpenCode already has a different server named browse in {}; left it unchanged.", tilde(&file));
            status = 1;
        }
    }
    let opencode = flag(args, "--opencode").map(PathBuf::from).or_else(|| browsers::on_path("opencode"));
    let mut saved = settings();
    saved["entry"] = json!(entry);
    saved["version"] = json!(VERSION);
    saved["opencodeConfigs"] = json!([file]);
    if let Some(opencode) = opencode {
        saved["opencode"] = json!(opencode);
    }
    update::write_private(&settings_path(), format!("{saved:#}\n").as_bytes())?;
    let seconds = match flag(args, "--wait-seconds") {
        Some(s) => s.parse::<u64>().ok().filter(|s| (1..=3600).contains(s)).context("--wait-seconds must be between 1 and 3600")?,
        None if tty => 180,
        None => 90,
    };
    let wait = !args.iter().any(|a| a == "--no-wait");
    Ok(status.max(connect_extension(!no_open, wait, Duration::from_secs(seconds))?))
}

/// The relay's view of the extension.
struct Extension {
    connected: bool,
    pairing: String,
}

fn extension_status(waiting: bool) -> Option<Extension> {
    let status = relay::extension_status(waiting)?;
    Some(Extension {
        connected: status.get("connected").and_then(Value::as_bool).unwrap_or(false),
        pairing: status.get("pairingState").and_then(Value::as_str).unwrap_or_default().to_owned(),
    })
}

fn mint_code(receipt: &str) -> anyhow::Result<String> {
    Ok(pairing::mint_pairing_code(&relay_api::paths(), pairing::PAIRING_CODE_TTL_MS, Some(receipt))?)
}

fn manual_pair(code: &str) -> String {
    let listen = relay_api::port();
    let address = if listen == relay_api::DEFAULT_PORT { String::new() } else { format!(" and localhost:{listen} as the relay address") };
    format!(
        "Open the Extensions menu → browse → Options, expand advanced (or click Pair with a code), enter {} as the pairing code{address}, then click Connect.",
        pairing::format_pairing_code(code)
    )
}

/// Opens the extension's status page with a one-time code in its fragment, in the profile that has it.
fn pair_in_browser(browser: &Browser, profile: &str, open: bool) -> anyhow::Result<bool> {
    let code = mint_code(&format!("{:016x}", session::random_u64()))?;
    let listen = relay_api::port();
    let port = if listen == relay_api::DEFAULT_PORT { String::new() } else { format!("&port={listen}") };
    let url = format!("chrome-extension://{}/welcome.html#code={code}{port}", browsers::store_id());
    if open && browsers::open_in(browser, &url, Some(profile)) {
        println!("✓ Opened browse in {} to connect it", browser.name);
        return Ok(true);
    }
    println!("To connect browse in {}: {}", browser.name, manual_pair(&code));
    Ok(false)
}

fn connect_extension(open: bool, wait: bool, timeout: Duration) -> anyhow::Result<i32> {
    relay::ensure()?;
    let initial = extension_status(false);
    if initial.as_ref().is_some_and(|s| s.connected) {
        println!("{CONNECTED}");
        return Ok(0);
    }
    if initial.as_ref().is_some_and(|s| s.pairing == "paired-offline") {
        println!("{PAIRED_OFFLINE}");
        return Ok(0);
    }
    let needs_pairing = initial.as_ref().is_some_and(|s| s.pairing == "unpaired" || s.pairing == "refused");
    let ssh = std::env::var_os("SSH_CONNECTION").is_some() || std::env::var_os("SSH_TTY").is_some();
    let display = !cfg!(target_os = "linux") || std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some();
    let open = open && display && !ssh;
    let all = browsers::browsers();
    let mut offered = false;
    let offer = |all: &[Browser]| -> anyhow::Result<bool> {
        let found = if ssh { Vec::new() } else { browsers::detect(all) };
        if let Some(m) = found.iter().find(|m| m.enabled) {
            pair_in_browser(&all[m.browser], &m.profile, open)?;
            return Ok(true);
        }
        let off: Vec<_> = found.iter().map(|m| format!("{} ({})", all[m.browser].name, m.profile_name)).collect();
        if !off.is_empty() {
            println!("! browse is turned off in {}. Turn it on in the browser's extensions page.", off.join(", "));
        }
        Ok(false)
    };
    offered |= offer(&all)?;
    if !offered && needs_pairing {
        println!("browse is installed in a browser but isn't paired with this relay yet.");
        println!("{}", manual_pair(&mint_code("install")?));
        offered = true;
    }
    if !offered {
        let url = browsers::store_url();
        let opened = open && browsers::open_default(&url);
        println!("Add browse to your browser from the Chrome Web Store{}: {url}", if opened { " (opened)" } else { "" });
    }
    if !std::io::stdout().is_terminal() {
        println!("Agent: ask the user to {}. Then call the browse status tool to check the connection.", if offered { "finish connecting browse in their browser" } else { "add browse from the Chrome Web Store" });
    }
    if !wait || ssh || !display {
        return Ok(0);
    }
    println!("Waiting for browse to connect (up to {}s; Ctrl+C to skip)…", timeout.as_secs());
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(1));
        match extension_status(true) {
            Some(s) if s.connected => {
                println!("{CONNECTED}");
                return Ok(0);
            }
            Some(s) if s.pairing == "paired-offline" => {
                println!("{PAIRED_OFFLINE}");
                return Ok(0);
            }
            _ if !offered => offered = offer(&all)?,
            _ => {}
        }
    }
    println!("! Not connected yet. If browse isn't connected after you add it, run `browse install` again, or `browse pair` for a code.");
    Ok(1)
}

fn ago(ms: u64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let minutes = now.saturating_sub(ms) / 60_000;
    match minutes {
        0 => "just now".into(),
        1..60 => format!("{minutes} min ago"),
        60..2880 => format!("{} h ago", minutes / 60),
        _ => format!("{} days ago", minutes / 1440),
    }
}

pub fn pair(args: &[String]) -> anyhow::Result<i32> {
    let paths = relay_api::paths();
    match args.first().map(String::as_str) {
        Some("--list") => {
            let list = pairing::read_browser_pairings(&paths);
            if list.is_empty() {
                println!("No paired browsers. Run `browse pair` for a code.");
            }
            let date = |t: Option<u64>| t.map_or("never".into(), ago);
            for (key, browser) in list {
                println!("{}{}", browser.id.as_deref().unwrap_or("(not connected yet)"), browser.name.map(|n| format!("  {n}")).unwrap_or_default());
                println!("  profile    {key}");
                println!("  paired     {}", date(Some(browser.paired_at)));
                println!("  last seen  {}", date(browser.last_seen));
            }
            if pairing::legacy_pairing_code(&paths).is_some() {
                println!("\nThe shared pairing code of an earlier version is still accepted. Once every browser shows up above, `browse pair --revoke legacy` retires it.");
            }
            return Ok(0);
        }
        Some("--revoke") if args.get(1).is_some_and(|t| t == "legacy") => {
            println!("{}", if pairing::remove_legacy_pairing_code(&paths) { "✓ The old shared pairing code is no longer accepted" } else { "The old shared pairing code was already gone." });
            return Ok(0);
        }
        Some("--revoke") => {
            let Some(target) = args.get(1) else {
                eprintln!("Usage: browse pair --revoke <browser id, name or profile>  (see `browse pair --list`)");
                return Ok(2);
            };
            let wanted = target.trim().to_lowercase();
            let found = pairing::read_browser_pairings(&paths).into_iter().find(|(key, b)| {
                key == target || b.id.as_deref() == Some(&wanted) || b.name.as_deref().is_some_and(|n| n.to_lowercase() == wanted)
            });
            return Ok(match found {
                Some((key, browser)) if pairing::revoke_browser_token(&paths, &key)? => {
                    relay::drop_browser(&key);
                    println!("✓ Unpaired {}", browser.name.or(browser.id).unwrap_or(key));
                    0
                }
                _ => {
                    println!("No paired browser \"{target}\". `browse pair --list` shows them.");
                    1
                }
            });
        }
        _ => {}
    }
    let seconds = flag(args, "--wait-seconds").map(|s| s.parse::<u64>()).transpose().context("--wait-seconds must be a number")?.unwrap_or(180).min(600);
    relay::ensure()?;
    let receipt = format!("{:016x}", session::random_u64());
    let code = mint_code(&receipt)?;
    println!("Pairing code: {}", pairing::format_pairing_code(&code));
    println!("{} It works once, within 10 minutes.", manual_pair(&code));
    println!("Waiting up to {seconds}s for that browser. Later, `browse pair --list` shows paired browsers.");
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        let pairings = pairing::read_browser_pairings(&paths);
        if let Some((key, b)) = pairings.into_iter().find(|(_, b)| b.receipt.as_deref() == Some(&receipt) && b.last_seen.is_some()) {
            println!("✓ Paired {}.", b.name.or(b.id).unwrap_or(key));
            return Ok(0);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    println!("! Pairing not confirmed. For a fresh code run `browse pair`.");
    Ok(1)
}

pub fn extension() -> i32 {
    println!("Add browse to your Chrome-family browser from the Chrome Web Store: {}", browsers::store_url());
    println!("Then run `browse install` (or `browse pair`) to connect it.");
    0
}

fn installed_server() -> Option<Value> {
    mcp_servers(&opencode_config()).ok()?.1.remove(MCP_NAME)
}

pub fn status(args: &[String]) -> anyhow::Result<i32> {
    let json = args.iter().any(|a| a == "--json");
    let settings = settings();
    let entry = settings.get("entry").and_then(Value::as_str);
    if json {
        // The relay's `status` tool output (relay, browsers, currentSession, sessions, tabs, autoUpdate) plus this
        // install's setup. A relay that isn't running isn't started.
        let mut status = match relay::probe() {
            relay::Probe::Running(_) => {
                let request = browse_core::ToolCallRequest { name: "status".into(), arguments: json!({}), session: session::for_cli() };
                let output = relay::call(&request)?;
                output
                    .content
                    .iter()
                    .find_map(|c| match c {
                        browse_core::Content::Text { text } => serde_json::from_str::<Value>(text).ok(),
                        _ => None,
                    })
                    .filter(Value::is_object)
                    .context("the relay's status tool didn't answer JSON")?
            }
            _ => json!({ "relay": { "running": false, "endpoint": relay_api::endpoint() } }),
        };
        status["setup"] = json!({
            "installed": entry.is_some(),
            "version": VERSION,
            "executable": relay::current_exe()?,
            "mcp": installed_server().is_some().then(opencode_config),
            "updates": update::describe(),
        });
        println!("{status:#}");
        return Ok(0);
    }
    let running = relay::extension_status(false);
    println!("Setup:     {}", if entry.is_some() { "installed" } else { "not installed. Run `browse install`." });
    println!("Version:   {VERSION} ({})", relay::current_exe()?.display());
    println!("opencode:  {}", settings.get("opencode").and_then(Value::as_str).map(PathBuf::from).or_else(|| browsers::on_path("opencode")).map_or("not found".into(), |p| p.display().to_string()));
    println!("MCP:       {}", if installed_server().is_some() { format!("\"{MCP_NAME}\" configured in {}", tilde(&opencode_config())) } else { "not configured".into() });
    println!("Updates:   {}", update::describe());
    println!("Files:     {}", relay_api::browse_files().iter().map(|p| tilde(p)).collect::<Vec<_>>().join(", "));
    println!("Logs:      {}", tilde(&relay_api::paths().state.join("logs")));
    if browsers::on_path("browse").is_none() {
        println!("Warning:   browse isn't on PATH; add {} to it", tilde(&bin_root()));
    }
    println!();
    match running {
        Some(status) => {
            println!("Relay:     running at {}", relay_api::endpoint());
            let relay_version = match relay::probe() {
                relay::Probe::Running(version) => version.get("version").and_then(Value::as_str).map(str::to_owned),
                _ => None,
            };
            if let Some(running) = relay_version.filter(|v| v != VERSION) {
                println!("           runs {running}, this CLI is {VERSION}; it restarts with the new version once idle");
            }
            let state = status.get("pairingState").and_then(Value::as_str).unwrap_or("unknown");
            println!("Extension: {state}");
            if let Some(next) = status.get("nextStep").and_then(Value::as_str) {
                println!("           {next}");
            }
            for browser in status.get("browsers").and_then(Value::as_array).into_iter().flatten() {
                let text = |k: &str| browser.get(k).and_then(Value::as_str).unwrap_or("?").to_owned();
                println!("Browser:   {} ({}){}", text("name"), text("id"), if browser["default"] == true { ", default" } else { "" });
            }
            let sessions = status.get("sessions").and_then(Value::as_array).map_or(0, Vec::len);
            let tabs = status.get("targets").and_then(Value::as_array).map_or(0, Vec::len);
            println!("Sessions:  {sessions}, tabs: {tabs} (`browse status --json` for details)");
        }
        None => println!("Relay:     not running at {} (it starts when an agent uses browse)", relay_api::endpoint()),
    }
    Ok(0)
}

