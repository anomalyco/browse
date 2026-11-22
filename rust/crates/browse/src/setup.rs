//! Setting browse up for OpenCode (cli/src/setup.ts, setup/**): install the executable, add the browse MCP server to
//! OpenCode's config, and connect the extension. `pair`, `extension`, and `status` live here too.

use std::io::{IsTerminal, Write};
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

pub fn tilde(path: &Path) -> String {
    let home = home();
    match path.strip_prefix(&home) {
        Ok(rest) if !home.as_os_str().is_empty() => format!("~/{}", rest.display()),
        _ => path.display().to_string(),
    }
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str)
}

/// OpenCode's global config file: the first that exists, else opencode.json.
pub fn opencode_config() -> PathBuf {
    let dir = config_home().join("opencode");
    OPENCODE_CONFIG_NAMES.iter().map(|name| dir.join(name)).find(|f| f.is_file()).unwrap_or_else(|| dir.join(OPENCODE_CONFIG_NAMES[0]))
}

fn mcp_servers(file: &Path) -> anyhow::Result<(String, serde_json::Map<String, Value>)> {
    // Only a missing file starts empty: one that can't be read or isn't UTF-8 is never rewritten.
    let text = match std::fs::read_to_string(file) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        read => read.with_context(|| format!("Can't read {}; left unchanged", file.display()))?,
    };
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
    Path::new(target) == entry || ["browse", "browse.exe", "browse.cmd", "cli.mjs", "opencode-browser.mjs"].contains(&name)
}

/// Removes the browse server (and the legacy opencode-browser one) an install wrote from an OpenCode config.
pub fn remove_opencode(file: &Path) -> anyhow::Result<bool> {
    if !file.is_file() {
        return Ok(false);
    }
    let (mut text, servers) = mcp_servers(file)?;
    let mut removed = false;
    for name in [MCP_NAME, LEGACY_MCP_NAME] {
        if servers.get(name).is_some_and(|s| owned(s, Path::new(""))) {
            text = jsonc::modify(&text, &["mcp", "servers", name], None)?;
            removed = true;
        }
    }
    if removed {
        write_keeping_mode(file, text.as_bytes())?;
    }
    Ok(removed)
}

pub enum McpEdit {
    Added,
    Updated,
    UpToDate,
    Conflict,
}

/// The `cwd` an OpenCode server entry runs in: the absolute home directory. OpenCode only pools one server across
/// directories when `cwd` is fixed, and older OpenCode versions don't expand `~` (it fails on Windows), so a literal
/// one there makes the server fail to start. Rewriting it on install also repairs entries an older install wrote with
/// `~`.
fn mcp_cwd() -> String {
    let home = home();
    // An empty cwd silently turns pooling off, so fall back to the old literal when there's no home directory.
    if home.as_os_str().is_empty() { "~".to_owned() } else { home.display().to_string() }
}

/// Writes (or updates) the browse MCP server so it runs `entry`, keeping settings the user added. One pooled server
/// with a fixed cwd serves every OpenCode session; each agent works in the tabs it opens, by their ids. A pinned relay
/// `port` goes in its environment, so the server dials the relay the extension is paired with.
pub fn configure_opencode(file: &Path, entry: &Path, port: Option<u16>) -> anyhow::Result<McpEdit> {
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
    server["cwd"] = json!(mcp_cwd());
    server["pool"] = json!(true);
    server["environment"] = environment;
    server["environment"]["OPENCODE_BROWSER_RUNTIME"] = json!("auto-update");
    if let Some(port) = port {
        server["environment"]["OPENCODE_BROWSER_PORT"] = json!(port.to_string());
    }
    if existing == Some(&server) {
        return Ok(McpEdit::UpToDate);
    }
    let after = jsonc::modify(&text, &["mcp", "servers", MCP_NAME], Some(&server))?;
    write_keeping_mode(file, after.as_bytes())?;
    Ok(if existing.is_some() { McpEdit::Updated } else { McpEdit::Added })
}

pub fn write_keeping_mode(file: &Path, bytes: &[u8]) -> anyhow::Result<()> {
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

/// The shell's startup files (the first that exists is used) and the line that puts `dir` on PATH there.
fn path_line(dir: &Path) -> (Vec<PathBuf>, String) {
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
    (candidates, line)
}

/// Takes out the PATH line `add_to_path` wrote (with its `# browse` comment). Returns the file it was in.
pub fn remove_from_path(dir: &Path) -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    let (candidates, line) = path_line(dir);
    for file in candidates {
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let block = format!("\n# browse\n{line}\n");
        if text.contains(&block) {
            std::fs::write(&file, text.replacen(&block, "", 1)).ok()?;
            return Some(tilde(&file));
        }
    }
    None
}

/// Adds the bin folder to PATH in the shell's startup file (or the Windows user PATH). Returns where.
pub fn add_to_path(dir: &Path) -> Option<String> {
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
    let (candidates, line) = path_line(dir);
    let file = candidates.iter().find(|f| f.exists()).unwrap_or(&candidates[0]);
    append_path_line(file, &line).then(|| tilde(file))
}

/// Appends browse's PATH line to a shell startup file unless it's there. Bytes, not text: a file with bytes that
/// aren't UTF-8 is still the user's, so it's only ever appended to, and one that can't be read is left alone.
fn append_path_line(file: &Path, line: &str) -> bool {
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return false,
    };
    if bytes.split(|b| *b == b'\n').any(|l| l == line.as_bytes()) {
        return false;
    }
    let sep = if bytes.is_empty() || bytes.ends_with(b"\n") { "" } else { "\n" };
    let Some(parent) = file.parent() else { return false };
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .and_then(|mut out| out.write_all(format!("{sep}\n# browse\n{line}\n").as_bytes()))
        .is_ok()
}

pub fn settings_path() -> PathBuf {
    relay_api::paths().config.join("settings.json")
}

pub fn settings() -> Value {
    std::fs::read(settings_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}))
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
    // The extension takes a port from the link only when it's one of browse's own (19988, 19990-19997); a relay pinned
    // elsewhere with OPENCODE_BROWSER_PORT is entered by hand, with its address.
    let known = listen == relay_api::DEFAULT_PORT || browse_relay::protocol::FALLBACK_PORTS.contains(&listen);
    if open && known && browsers::open_in(browser, &url, Some(profile)) {
        println!("✓ Opened browse in {} to connect it", browser.name);
        return Ok(true);
    }
    println!("To connect browse in {}: {}", browser.name, manual_pair(&code));
    Ok(false)
}

pub fn connect_extension(open: bool, wait: bool, timeout: Duration) -> anyhow::Result<i32> {
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
    if update::channel() == "dev" {
        println!();
        println!("The store extension works with dev builds too. To try the dev extension instead, download");
        println!("https://anoma.ly/release/browse/extension/dev/chromium, unzip it, turn on Developer mode on your browser's");
        println!("extensions page, click Load unpacked and pick the unzipped folder; then run `browse pair`.");
    }
    0
}

/// The agents (OpenCode included) whose config has a browse server an install wrote, with the file.
fn configured_agents() -> Vec<(&'static str, PathBuf)> {
    let opencode = opencode_config();
    crate::agents::locations(&opencode, None)
        .into_iter()
        .filter(|location| if location.name == "opencode" { installed_server().is_some_and(|s| owned(&s, Path::new(""))) } else { crate::agents::current(location).is_some_and(|s| crate::agents::owned(&s)) })
        .map(|location| (location.name, location.file))
        .collect()
}

fn installed_server() -> Option<Value> {
    mcp_servers(&opencode_config()).ok()?.1.remove(MCP_NAME)
}

pub fn status(args: &[String]) -> anyhow::Result<i32> {
    let json = args.iter().any(|a| a == "--json");
    let settings = settings();
    let entry = settings.get("entry").and_then(Value::as_str);
    if json {
        // The relay's `status` tool output (relay, browsers, tabs, autoUpdate) plus this
        // install's setup. A relay that isn't running isn't started.
        let mut status = match relay::probe() {
            relay::Probe::Running(_) => {
                let request = browse_core::ToolCallRequest { name: "status".into(), arguments: json!({}) };
                let output = relay::call(&request, None)?;
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
            "agents": configured_agents().iter().map(|(name, file)| json!({ "name": name, "file": file })).collect::<Vec<_>>(),
            "updates": update::describe(),
        });
        println!("{status:#}");
        return Ok(0);
    }
    let running = relay::extension_status(false);
    println!("Setup:     {}", if entry.is_some() { "installed" } else { "not installed. Run `browse install`." });
    println!("Version:   {VERSION} ({})", relay::current_exe()?.display());
    println!("opencode:  {}", settings.get("opencode").and_then(Value::as_str).map(PathBuf::from).or_else(|| browsers::on_path("opencode")).map_or("not found".into(), |p| p.display().to_string()));
    let configured = configured_agents();
    println!(
        "Agents:    {}",
        if configured.is_empty() {
            "none has browse. Run `browse install`.".to_owned()
        } else {
            configured.iter().map(|(name, file)| format!("{} ({})", crate::agents::label(name), tilde(file))).collect::<Vec<_>>().join(", ")
        }
    );
    println!("Updates:   {}", update::describe());
    println!("Files:     {}", relay_api::browse_files().iter().map(|p| tilde(p)).collect::<Vec<_>>().join(", "));
    println!("Logs:      {}", tilde(&relay_api::paths().state.join("logs")));
    if browsers::on_path("browse").is_none() {
        let dir = entry.map(PathBuf::from).and_then(|e| e.parent().map(Path::to_path_buf)).unwrap_or_else(bin_root);
        println!("Warning:   browse isn't on PATH; add {} to it (agents run it by its full path, so they work either way)", tilde(&dir));
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
            let state = match status.get("pairingState").and_then(Value::as_str).unwrap_or_default() {
                "connected" => "connected",
                "not-seen" => "not connected yet",
                "unpaired" => "in a browser, but not paired",
                "refused" => "refused: its pairing isn't valid here",
                "paired-offline" if status.get("reconnecting").and_then(Value::as_bool) == Some(true) => "paired, reconnecting",
                "paired-offline" => "paired, but the browser isn't connected",
                "incompatible" => "doesn't match this browse version",
                _ => "unknown",
            };
            println!("Extension: {state}");
            if let Some(next) = status.get("nextStep").and_then(Value::as_str) {
                println!("           {next}");
            }
            for browser in status.get("browsers").and_then(Value::as_array).into_iter().flatten() {
                let text = |k: &str| browser.get(k).and_then(Value::as_str).unwrap_or("?").to_owned();
                println!("Browser:   {} ({}){}", text("name"), text("id"), if browser["default"] == true { ", default" } else { "" });
            }
            let tabs = status.get("targets").and_then(Value::as_array).map_or(0, Vec::len);
            println!("Tabs:      {tabs} (`browse status --json` or `browse tabs` for details)");
        }
        None => println!("Relay:     not running at {} (it starts when an agent uses browse)", relay_api::endpoint()),
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("browse-setup-{name}-{}", crate::session::random_u64()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn path_line_is_appended_to_a_startup_file_that_isnt_utf8() {
        let dir = scratch("rc");
        let rc = dir.join(".zshrc");
        let original = b"alias ll='ls -l'\n# caf\xe9 (Latin-1)\nexport EDITOR=vim".to_vec();
        std::fs::write(&rc, &original).unwrap();
        let line = "export PATH='/home/me/.local/bin':\"$PATH\"";
        assert!(append_path_line(&rc, line));
        let after = std::fs::read(&rc).unwrap();
        assert!(after.starts_with(&original), "the user's bytes are kept: {:?}", String::from_utf8_lossy(&after));
        assert!(after.ends_with(format!("\n\n# browse\n{line}\n").as_bytes()));
        assert!(!append_path_line(&rc, line), "added once");
        assert_eq!(std::fs::read(&rc).unwrap(), after);
        let fresh = dir.join("new/.profile");
        assert!(append_path_line(&fresh, line));
        assert_eq!(std::fs::read_to_string(&fresh).unwrap(), format!("\n# browse\n{line}\n"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unreadable_or_non_utf8_opencode_config_is_left_alone() {
        let dir = scratch("oc");
        let file = dir.join("opencode.json");
        let original = b"{ \"theme\": \"caf\xe9\" }".to_vec();
        std::fs::write(&file, &original).unwrap();
        let error = configure_opencode(&file, Path::new("/usr/bin/browse"), None).err().expect("a file that isn't UTF-8 is refused");
        assert!(error.to_string().contains("left unchanged"), "{error}");
        assert_eq!(std::fs::read(&file).unwrap(), original);
        let missing = dir.join("missing/opencode.json");
        assert!(matches!(configure_opencode(&missing, Path::new("/usr/bin/browse"), None).unwrap(), McpEdit::Added));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn opencode_gets_one_pooled_server_with_an_absolute_home_cwd() {
        let dir = scratch("pool");
        let file = dir.join("opencode.json");
        assert!(matches!(configure_opencode(&file, Path::new("/usr/bin/browse"), None).unwrap(), McpEdit::Added));
        let config = jsonc::parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let server = &config["mcp"]["servers"]["browse"];
        assert_eq!(server["type"], "local");
        assert_eq!(server["command"], json!(["/usr/bin/browse", "mcp"]));
        // One server serves every directory: OpenCode only pools an entry with a fixed cwd and `pool`. The cwd is the
        // absolute home directory, not `~`, because older OpenCode versions don't expand `~` (it fails on Windows).
        assert_eq!(server["cwd"], home().display().to_string());
        let cwd = server["cwd"].as_str().unwrap();
        assert!(cwd != "~" && Path::new(cwd).is_absolute(), "cwd should be an absolute path: {cwd}");
        assert_eq!(server["pool"], true);
        assert!(matches!(configure_opencode(&file, Path::new("/usr/bin/browse"), None).unwrap(), McpEdit::UpToDate));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_opencode_entry_with_the_old_tilde_cwd_is_repaired_on_install() {
        let dir = scratch("repair-cwd");
        let file = dir.join("opencode.json");
        let stale = json!({ "mcp": { "servers": { "browse": {
            "type": "local",
            "command": ["/usr/bin/browse", "mcp"],
            "cwd": "~",
            "pool": true,
            "environment": { "OPENCODE_BROWSER_RUNTIME": "auto-update" },
        } } } });
        std::fs::write(&file, serde_json::to_string_pretty(&stale).unwrap()).unwrap();
        assert!(matches!(configure_opencode(&file, Path::new("/usr/bin/browse"), None).unwrap(), McpEdit::Updated));
        let config = jsonc::parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let cwd = config["mcp"]["servers"]["browse"]["cwd"].as_str().unwrap();
        assert!(cwd != "~" && Path::new(cwd).is_absolute(), "the stale ~ is rewritten to the home directory: {cwd}");
        assert_eq!(cwd, home().display().to_string());
        assert!(matches!(configure_opencode(&file, Path::new("/usr/bin/browse"), None).unwrap(), McpEdit::UpToDate));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn opencode_environment_keeps_the_runtime_and_gains_a_pinned_port() {
        let dir = scratch("port");
        let file = dir.join("opencode.json");
        std::fs::write(&file, r#"{"mcp":{"servers":{"browse":{"type":"local","command":["/usr/bin/browse","mcp"],"environment":{"MINE":"1","OPENCODE_BROWSER_RUNTIME":"auto-update"}}}}}"#).unwrap();
        assert!(matches!(configure_opencode(&file, Path::new("/usr/bin/browse"), Some(20000)).unwrap(), McpEdit::Updated));
        let config = jsonc::parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let environment = &config["mcp"]["servers"]["browse"]["environment"];
        assert_eq!(environment["MINE"], "1");
        assert_eq!(environment["OPENCODE_BROWSER_RUNTIME"], "auto-update");
        assert_eq!(environment["OPENCODE_BROWSER_PORT"], "20000");
        assert!(matches!(configure_opencode(&file, Path::new("/usr/bin/browse"), Some(20000)).unwrap(), McpEdit::UpToDate));
        // An install without the variable set leaves the port an earlier one wrote.
        assert!(matches!(configure_opencode(&file, Path::new("/usr/bin/browse"), None).unwrap(), McpEdit::UpToDate));
        let config = jsonc::parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(config["mcp"]["servers"]["browse"]["environment"]["OPENCODE_BROWSER_PORT"], "20000");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_opencode_config_with_a_byte_order_mark_is_updated_in_place() {
        let dir = scratch("bom");
        let file = dir.join("opencode.json");
        std::fs::write(&file, "\u{feff}{\n  // mine\n  \"theme\": \"x\"\n}\n").unwrap();
        assert!(matches!(configure_opencode(&file, Path::new("/usr/bin/browse"), None).unwrap(), McpEdit::Added));
        let after = std::fs::read_to_string(&file).unwrap();
        assert!(after.starts_with('\u{feff}') && after.contains("// mine"), "{after}");
        assert_eq!(jsonc::parse(&after).unwrap()["mcp"]["servers"]["browse"]["command"][0], "/usr/bin/browse");
        assert_eq!(jsonc::parse(&after).unwrap()["theme"], "x");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
