//! The agents `browse install` sets up (cli/src/setup/agents.ts, agent-config.ts): where each keeps its user-level MCP
//! config, whether it looks installed, and adding or removing the browse server in that file's format (JSON/JSONC, TOML
//! or YAML) while leaving everything else in it as it was. OpenCode's own entry is setup.rs's `configure_opencode`.

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use serde_json::{Value, json};

use crate::browsers::on_path;
use crate::jsonc;
use crate::setup::{config_home, home};

/// Every agent install knows, by the name `--agent` takes, with its label. OpenCode first: it's the default.
pub const AGENTS: &[(&str, &str)] = &[
    ("opencode", "OpenCode"),
    ("claude", "Claude Code"),
    ("cursor", "Cursor"),
    ("codex", "Codex"),
    ("vscode", "VS Code"),
    ("windsurf", "Windsurf"),
    ("claude-desktop", "Claude Desktop"),
    ("gemini", "Gemini CLI"),
    ("zed", "Zed"),
    ("cline", "Cline"),
    ("roo", "Roo Code (VS Code)"),
    ("kilo", "Kilo Code"),
    ("goose", "Goose"),
    ("amp", "Amp"),
    ("kiro", "Kiro"),
    ("droid", "Factory Droid"),
    ("copilot", "GitHub Copilot CLI"),
    ("warp", "Warp"),
    ("lm-studio", "LM Studio"),
    ("qwen-code", "Qwen Code"),
    ("kimi", "Kimi Code CLI"),
    ("augment", "Augment (Auggie CLI)"),
    ("antigravity", "Antigravity"),
    ("junie", "Junie"),
    ("codebuddy", "CodeBuddy Code"),
    ("cortex", "Cortex Code"),
    ("dsh", "DeepSeek Harness"),
    ("hermes", "Hermes Agent"),
    ("grok", "Grok Build"),
    ("vibe", "Mistral Vibe"),
    ("qoder", "Qoder CLI"),
    ("pi", "Pi"),
    ("workbuddy", "WorkBuddy"),
    ("trae-cn", "Trae CN"),
];

const ALIASES: &[(&str, &str)] = &[
    ("claude-code", "claude"),
    ("gemini-cli", "gemini"),
    ("roo-code", "roo"),
    ("kilo-code", "kilo"),
    ("kiro-cli", "kiro"),
    ("factory-droid", "droid"),
    ("github-copilot", "copilot"),
    ("copilot-cli", "copilot"),
    ("lmstudio", "lm-studio"),
    ("kimi-code-cli", "kimi"),
    ("hermes-agent", "hermes"),
    ("mistral-vibe", "vibe"),
    ("antigravity-cli", "antigravity"),
];

pub fn label(name: &str) -> &'static str {
    AGENTS.iter().find(|(n, _)| *n == name).map_or("this agent", |(_, l)| l)
}

/// An agent's name from what a user typed (`claude`, `claude-code`, `Claude-Code`).
pub fn agent_name(id: &str) -> Option<&'static str> {
    let id = id.trim().to_lowercase();
    AGENTS.iter().map(|(n, _)| *n).find(|n| *n == id).or_else(|| ALIASES.iter().find(|(a, _)| *a == id).map(|(_, n)| *n))
}

/// The agent running this command, from the markers agents set in their shells (not installed binaries or folders: a
/// plain VS Code terminal isn't its agent).
pub fn calling_agent() -> Option<&'static str> {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let is = |name: &str, value: &str| var(name).as_deref() == Some(value);
    if is("CLAUDECODE", "1") || var("CLAUDE_CODE_ENTRYPOINT").is_some() {
        return Some("claude");
    }
    if var("CODEX_THREAD_ID").is_some() {
        return Some("codex");
    }
    if var("CURSOR_AGENT").is_some() {
        return Some("cursor");
    }
    if is("AI_AGENT", "github_copilot_vscode_agent") || (is("COPILOT_AGENT", "1") && is("TERM_PROGRAM", "vscode")) {
        return Some("vscode");
    }
    if is("GEMINI_CLI", "1") {
        return Some("gemini");
    }
    if var("AMP_CURRENT_THREAD_ID").is_some() {
        return Some("amp");
    }
    if is("COPILOT_CLI", "1") {
        return Some("copilot");
    }
    let named = var("AI_AGENT").and_then(|a| agent_name(a.split('@').next().unwrap_or_default())).or_else(|| var("AGENT").and_then(|a| agent_name(&a)));
    if named.is_some() {
        return named;
    }
    if is("OPENCODE", "1") || var("OPENCODE_SESSION_ID").is_some() {
        return Some("opencode");
    }
    if var("PI_SESSION_ID").is_some() {
        return Some("pi");
    }
    None
}

/// An agent's user-level config file, and whether the agent looks installed here.
#[derive(Clone, Debug)]
pub struct Location {
    pub name: &'static str,
    pub file: PathBuf,
    pub installed: bool,
}

/// Where every agent keeps its user config. User scope only: never a project, workspace or managed config.
pub fn locations(opencode_config: &Path, opencode_binary: Option<&Path>) -> Vec<Location> {
    let home = home();
    let config = config_home();
    let at = |rel: &str| home.join(rel);
    let env = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    let support = if cfg!(target_os = "macos") {
        at("Library/Application Support")
    } else if cfg!(windows) {
        env("APPDATA").unwrap_or_else(|| at("AppData/Roaming"))
    } else {
        config.clone()
    };
    let app = |name: &str| cfg!(target_os = "macos") && [PathBuf::from("/Applications"), at("Applications")].iter().any(|d| d.join(format!("{name}.app")).exists());
    let first = |files: Vec<PathBuf>| files.iter().find(|f| f.exists()).cloned().unwrap_or_else(|| files[0].clone());
    let found = |bin: Option<&str>, bundle: Option<&str>, file: &Path, dirs: &[PathBuf]| {
        bin.is_some_and(|b| on_path(b).is_some()) || bundle.is_some_and(app) || file.exists() || dirs.iter().any(|d| d.exists())
    };
    let loc = |name: &'static str, file: PathBuf, bin: Option<&str>, bundle: Option<&str>, dirs: Option<Vec<PathBuf>>| {
        let dirs = dirs.unwrap_or_else(|| file.parent().map(Path::to_path_buf).into_iter().collect());
        let installed = found(bin, bundle, &file, &dirs);
        Location { name, file, installed }
    };
    let code_storage = support.join("Code/User/globalStorage");
    let cline = env("CLINE_DIR").unwrap_or_else(|| at(".cline"));
    let cline_settings = env("CLINE_DATA_DIR").unwrap_or_else(|| cline.join("data")).join("settings/cline_mcp_settings.json");
    let cline_extension = code_storage.join("saoudrizwan.claude-dev");
    let roo = code_storage.join("rooveterinaryinc.roo-cline");
    let zed = if cfg!(windows) {
        support.join("Zed")
    } else if cfg!(target_os = "macos") {
        at(".config/zed")
    } else {
        env("FLATPAK_XDG_CONFIG_HOME").unwrap_or_else(|| config.clone()).join("zed")
    };
    let goose = match env("GOOSE_PATH_ROOT").filter(|p| p.is_absolute()) {
        Some(root) => root.join("config"),
        None if cfg!(windows) => support.join("Block/goose/config"),
        None => config.join("goose"),
    };
    let codex = env("CODEX_HOME").unwrap_or_else(|| at(".codex"));
    let cascade = if cfg!(windows) { &support } else { &config }.join("devin/mcp_config.json");
    // Windsurf uses .codeium; its renamed Cascade client moved mcp_config.json to the Devin config folder.
    let windsurf = at(".codeium/windsurf/mcp_config.json");
    let windsurf_file = if windsurf.exists() || !cascade.exists() { windsurf.clone() } else { cascade.clone() };
    let claude = env("CLAUDE_CONFIG_DIR").map_or_else(|| at(".claude.json"), |dir| dir.join(".claude.json"));
    let mut warp_dirs = vec![at(".warp"), config.join("warp-terminal")];
    if cfg!(windows) {
        warp_dirs.push(support.join("warp/Warp"));
    }
    vec![
        Location { name: "opencode", file: opencode_config.to_path_buf(), installed: opencode_binary.is_some() || app("OpenCode") || config.join("opencode").exists() },
        Location { name: "claude", file: claude.clone(), installed: on_path("claude").is_some() || claude.exists() || at(".claude").exists() },
        Location { name: "cursor", file: at(".cursor/mcp.json"), installed: on_path("cursor").is_some() || app("Cursor") || at(".cursor").exists() },
        Location { name: "codex", file: codex.join("config.toml"), installed: on_path("codex").is_some() || app("Codex") || codex.exists() },
        Location { name: "vscode", file: support.join("Code/User/mcp.json"), installed: on_path("code").is_some() || app("Visual Studio Code") || support.join("Code/User").exists() },
        Location {
            name: "windsurf",
            file: windsurf_file,
            installed: on_path("windsurf").is_some() || app("Windsurf") || windsurf.parent().is_some_and(Path::exists) || cascade.exists(),
        },
        loc("claude-desktop", support.join("Claude/claude_desktop_config.json"), Some("claude-desktop"), Some("Claude"), None),
        loc("gemini", env("GEMINI_CLI_HOME").unwrap_or_else(|| home.clone()).join(".gemini/settings.json"), Some("gemini"), None, None),
        loc("zed", zed.join("settings.json"), Some("zed"), Some("Zed"), None),
        loc(
            "cline",
            env("CLINE_MCP_SETTINGS_PATH").unwrap_or_else(|| first(vec![cline_settings.clone(), cline_extension.join("settings/cline_mcp_settings.json")])),
            Some("cline"),
            None,
            Some(vec![cline.clone(), cline_extension.clone()]),
        ),
        loc("roo", roo.join("settings/mcp_settings.json"), None, None, Some(vec![roo.clone(), at(".roo")])),
        loc("kilo", first(["kilo.json", "kilo.jsonc", "config.json"].iter().map(|f| config.join("kilo").join(f)).collect()), Some("kilo"), None, None),
        loc("goose", goose.join("config.yaml"), Some("goose"), Some("Goose"), None),
        loc("amp", first(vec![at(".config/amp/settings.json"), at(".config/amp/settings.jsonc")]), Some("amp"), None, None),
        loc("kiro", at(".kiro/settings/mcp.json"), Some("kiro-cli"), Some("Kiro"), Some(vec![at(".kiro")])),
        loc("droid", at(".factory/mcp.json"), Some("droid"), None, None),
        loc("copilot", env("COPILOT_HOME").unwrap_or_else(|| at(".copilot")).join("mcp-config.json"), Some("copilot"), None, None),
        loc("warp", at(".warp/.mcp.json"), Some("warp"), Some("Warp"), Some(warp_dirs)),
        loc("lm-studio", at(".lmstudio/mcp.json"), Some("lms"), Some("LM Studio"), None),
        loc("qwen-code", at(".qwen/settings.json"), Some("qwen"), None, None),
        loc("kimi", env("KIMI_SHARE_DIR").unwrap_or_else(|| at(".kimi")).join("mcp.json"), Some("kimi"), None, None),
        loc("augment", at(".augment/settings.json"), Some("auggie"), None, None),
        loc("antigravity", at(".gemini/config/mcp_config.json"), Some("agy"), Some("Antigravity"), Some(vec![at(".gemini/antigravity"), at(".gemini/antigravity-cli")])),
        loc("junie", at(".junie/mcp/mcp.json"), Some("junie"), None, Some(vec![at(".junie")])),
        loc("codebuddy", first(vec![at(".codebuddy/.mcp.json"), at(".codebuddy/mcp.json")]), Some("codebuddy"), None, None),
        loc("cortex", at(".snowflake/cortex/mcp.json"), Some("cortex"), None, None),
        crate::dsh::location(crate::dsh::home(std::env::var_os("DSH_HOME"), &home)),
        loc("hermes", env("HERMES_HOME").unwrap_or_else(|| at(".hermes")).join("config.yaml"), Some("hermes"), None, None),
        loc("grok", env("GROK_HOME").unwrap_or_else(|| at(".grok")).join("config.toml"), Some("grok"), None, None),
        loc("vibe", env("VIBE_HOME").unwrap_or_else(|| at(".vibe")).join("config.toml"), Some("vibe"), None, None),
        loc("qoder", at(".qoder/settings.json"), Some("qoder"), Some("Qoder"), None),
        loc("pi", env("PI_CODING_AGENT_DIR").unwrap_or_else(|| at(".pi/agent")).join("mcp.json"), Some("pi"), None, None),
        loc("workbuddy", at(".workbuddy/mcp.json"), None, None, None),
        loc("trae-cn", support.join("Trae CN/User/mcp.json"), None, Some("Trae CN"), None),
    ]
}

enum Format {
    /// JSON or JSONC, the servers under this top-level key.
    Json(&'static str),
    /// TOML, `[mcp_servers.browse]`.
    Toml,
    /// TOML, a `[[mcp_servers]]` entry named browse (Mistral Vibe).
    TomlList,
    /// YAML, the servers under this top-level key.
    Yaml(&'static str),
    /// YAML, dsh's Cordis patch layer: a top-level list of patch rows.
    Dsh,
}

fn format(name: &str) -> Format {
    match name {
        "codex" | "grok" => Format::Toml,
        "vibe" => Format::TomlList,
        "dsh" => Format::Dsh,
        "goose" => Format::Yaml("extensions"),
        "hermes" => Format::Yaml("mcp_servers"),
        "vscode" => Format::Json("servers"),
        "zed" => Format::Json("context_servers"),
        "kilo" => Format::Json("mcp"),
        "amp" => Format::Json("amp.mcpServers"),
        _ => Format::Json("mcpServers"),
    }
}

/// The key `name`'s entry keeps its environment under. dsh's and vibe's env schemas aren't known well enough to
/// write one, so they go without.
fn env_key(name: &str) -> Option<&'static str> {
    match name {
        "dsh" | "vibe" => None,
        "opencode" | "kilo" => Some("environment"),
        "goose" => Some("envs"),
        _ => Some("env"),
    }
}

/// The browse server as `name`'s config expects it, running `command args...`. A pinned relay `port` goes in the entry's
/// environment, so the agent's `browse mcp` dials the same relay the extension is paired with.
pub fn definition(name: &str, command: &str, args: &[String], port: Option<u16>) -> Value {
    let mut server = match name {
        "kilo" => json!({ "type": "local", "command": std::iter::once(command.to_owned()).chain(args.iter().cloned()).collect::<Vec<_>>() }),
        "goose" => json!({ "type": "stdio", "name": "browse", "enabled": true, "cmd": command, "args": args }),
        "copilot" => json!({ "type": "local", "command": command, "args": args, "tools": ["*"] }),
        "vibe" => json!({ "name": "browse", "transport": "stdio", "command": command, "args": args }),
        "dsh" => json!({ "serverName": "browse", "transport": "stdio", "command": command, "args": args }),
        "claude" | "vscode" | "cortex" | "droid" | "codebuddy" => json!({ "type": "stdio", "command": command, "args": args }),
        _ => json!({ "command": command, "args": args }),
    };
    if let (Some(port), Some(key)) = (port, env_key(name)) {
        server[key] = json!({ "OPENCODE_BROWSER_PORT": port.to_string() });
    }
    server
}

/// The command line an MCP server entry runs: `command` as an array, or `command`/`cmd` plus `args`.
pub fn command_line(server: &Value) -> Vec<String> {
    let strings = |v: &Value| v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default();
    match server.get("command").or_else(|| server.get("cmd")) {
        Some(Value::Array(_)) => strings(&server["command"]),
        Some(Value::String(command)) => std::iter::once(command.clone()).chain(strings(server.get("args").unwrap_or(&Value::Null))).collect(),
        _ => Vec::new(),
    }
}

/// Whether a server entry runs a browse MCP server some install wrote: `<browse> mcp`, `node <.../cli.mjs> mcp` or
/// `npx @opencode/browse mcp`.
pub fn owned(server: &Value) -> bool {
    let line = command_line(server);
    if line.len() < 2 || line.last().map(String::as_str) != Some("mcp") {
        return false;
    }
    line[..line.len() - 1].iter().any(|part| {
        let name = Path::new(part).file_name().and_then(|n| n.to_str()).unwrap_or_default();
        ["browse", "browse.exe", "browse.cmd", "cli.mjs", "opencode-browser.mjs", "opencode-browser"].contains(&name) || part.starts_with("@opencode/browse")
    })
}

#[derive(Debug, PartialEq, Eq)]
pub enum Edit {
    Added,
    Updated,
    Unchanged,
    Removed,
    /// A server named browse that isn't one browse wrote: left as it is.
    Conflict,
}

/// Adds browse (running `command`) to the agent's config, updates an entry an earlier install wrote, or with `remove`
/// takes it out again. Settings the user added to the entry stay; a pinned `port` is written to its environment.
pub fn edit(location: &Location, command: &[String], remove: bool, port: Option<u16>) -> anyhow::Result<Edit> {
    let file = &location.file;
    let exists = file.is_file();
    if !exists && remove {
        return Ok(Edit::Unchanged);
    }
    let before = if exists { std::fs::read_to_string(file).with_context(|| format!("can't read {}", file.display()))? } else { String::new() };
    let (program, args) = command.split_first().context("empty command")?;
    let expected = definition(location.name, program, args, port);
    let invalid = || anyhow::anyhow!("{} isn't valid {}; left unchanged", file.display(), kind(location.name));
    let (after, outcome) = match format(location.name) {
        Format::Json(key) => edit_json(&before, key, &expected, remove).map_err(|_| invalid())?,
        Format::Toml => edit_toml(&before, &expected, remove, false).map_err(|_| invalid())?,
        Format::TomlList => edit_toml(&before, &expected, remove, true).map_err(|_| invalid())?,
        Format::Yaml(key) => edit_yaml(&before, key, &expected, remove)?,
        Format::Dsh => crate::dsh::write(&before, &expected, remove)?,
    };
    if let Some(after) = after {
        if exists && std::fs::read_to_string(file).ok().as_deref() != Some(before.as_str()) {
            bail!("{} changed while browse was editing it; try again", file.display());
        }
        if location.name == "dsh" && after.is_empty() {
            if file.is_symlink() {
                // Keep the link, and leave dsh a patch layer it can load: deleting the path would only drop the link,
                // leaving browse's row in the file it points at.
                crate::setup::write_keeping_mode(file, b"[]\n")?;
            } else {
                std::fs::remove_file(file).with_context(|| format!("can't remove {}", file.display()))?;
            }
        } else {
            crate::setup::write_keeping_mode(file, after.as_bytes())?;
        }
    }
    Ok(outcome)
}

fn kind(name: &str) -> &'static str {
    match format(name) {
        Format::Json(_) => "JSON",
        Format::Toml | Format::TomlList => "TOML",
        Format::Yaml(_) | Format::Dsh => "YAML",
    }
}

/// The entry with browse's fields set over what's there. An environment gains browse's variables and keeps the user's.
fn merged(current: Option<&Value>, expected: &Value) -> Value {
    let mut server = current.filter(|c| c.is_object()).cloned().unwrap_or_else(|| json!({}));
    for (key, value) in expected.as_object().into_iter().flatten() {
        let merge = matches!((server.get(key), value), (Some(Value::Object(_)), Value::Object(_)));
        if merge {
            if let (Some(Value::Object(existing)), Value::Object(added)) = (server.get_mut(key), value) {
                existing.extend(added.clone());
            }
        } else {
            server[key] = value.clone();
        }
    }
    // An entry that ran `[command, args...]` in one array and now takes `command` plus `args`, or the other way round.
    if expected.get("args").is_none()
        && let Some(object) = server.as_object_mut()
    {
        object.remove("args");
    }
    server
}

/// What an add or remove does to an entry that's there, and the new entry (None to remove it, or to leave it).
pub(crate) fn decide(current: Option<&Value>, expected: &Value, remove: bool) -> (Edit, Option<Option<Value>>) {
    match (current, remove) {
        (None, true) => (Edit::Unchanged, None),
        (Some(c), _) if !owned(c) => (Edit::Conflict, None),
        (Some(_), true) => (Edit::Removed, Some(None)),
        (None, false) => (Edit::Added, Some(Some(expected.clone()))),
        (Some(c), false) => {
            let server = merged(Some(c), expected);
            if &server == c { (Edit::Unchanged, None) } else { (Edit::Updated, Some(Some(server))) }
        }
    }
}

fn edit_json(before: &str, key: &str, expected: &Value, remove: bool) -> anyhow::Result<(Option<String>, Edit)> {
    let config = jsonc::parse(before)?;
    if !config.is_object() {
        bail!("not an object");
    }
    let container = config.get(key);
    if container.is_some_and(|c| !c.is_object()) {
        bail!("{key} is not an object");
    }
    let (outcome, change) = decide(container.and_then(|c| c.get("browse")), expected, remove);
    let after = match change {
        Some(server) => Some(jsonc::modify(before, &[key, "browse"], server.as_ref())?),
        None => None,
    };
    Ok((after, outcome))
}

fn toml_to_json(item: &toml_edit::Item) -> Value {
    use toml_edit::{Item, Value as V};
    fn value(v: &V) -> Value {
        match v {
            V::String(s) => json!(s.value()),
            V::Integer(i) => json!(i.value()),
            V::Float(f) => json!(f.value()),
            V::Boolean(b) => json!(b.value()),
            V::Datetime(d) => json!(d.value().to_string()),
            V::Array(a) => Value::Array(a.iter().map(value).collect()),
            V::InlineTable(t) => Value::Object(t.iter().map(|(k, v)| (k.to_owned(), value(v))).collect()),
        }
    }
    match item {
        Item::None => Value::Null,
        Item::Value(v) => value(v),
        Item::Table(t) => Value::Object(t.iter().map(|(k, v)| (k.to_owned(), toml_to_json(v))).collect()),
        Item::ArrayOfTables(a) => Value::Array(a.iter().map(|t| Value::Object(t.iter().map(|(k, v)| (k.to_owned(), toml_to_json(v))).collect())).collect()),
    }
}

fn json_to_toml(value: &Value) -> toml_edit::Value {
    match value {
        Value::String(s) => s.as_str().into(),
        Value::Bool(b) => (*b).into(),
        Value::Number(n) => n.as_i64().map_or_else(|| n.as_f64().unwrap_or_default().into(), Into::into),
        Value::Array(a) => toml_edit::Value::Array(a.iter().map(json_to_toml).collect()),
        Value::Object(o) => {
            let mut table = toml_edit::InlineTable::new();
            for (k, v) in o {
                table.insert(k, json_to_toml(v));
            }
            toml_edit::Value::InlineTable(table)
        }
        Value::Null => "".into(),
    }
}

/// Sets browse's fields in a TOML table (keeping the user's other keys), or a new table with just them. An
/// environment is its own `[<server>.env]` section, the way the clients' docs show it.
fn fill(table: &mut toml_edit::Table, server: &Value) {
    for (key, value) in server.as_object().into_iter().flatten() {
        match value {
            Value::Object(entries) => {
                let mut section = table.get(key).and_then(toml_edit::Item::as_table).cloned().unwrap_or_else(toml_edit::Table::new);
                for (name, value) in entries {
                    section.insert(name, toml_edit::Item::Value(json_to_toml(value)));
                }
                table.insert(key, toml_edit::Item::Table(section));
            }
            _ => {
                table.insert(key, toml_edit::Item::Value(json_to_toml(value)));
            }
        }
    }
}

fn edit_toml(before: &str, expected: &Value, remove: bool, list: bool) -> anyhow::Result<(Option<String>, Edit)> {
    use toml_edit::{ArrayOfTables, DocumentMut, Item, Table};
    let mut doc: DocumentMut = before.parse()?;
    if list {
        if doc.get("mcp_servers").is_some_and(|i| !i.is_array_of_tables()) {
            bail!("mcp_servers is not a list of tables");
        }
        let entries = doc.get("mcp_servers").and_then(Item::as_array_of_tables);
        let index = entries.and_then(|a| a.iter().position(|t| t.get("name").and_then(Item::as_str) == Some("browse")));
        let current = index.and_then(|i| entries.and_then(|a| a.get(i))).map(|t| toml_to_json(&Item::Table(t.clone())));
        let (outcome, change) = decide(current.as_ref(), expected, remove);
        let Some(server) = change else { return Ok((None, outcome)) };
        if doc.get("mcp_servers").is_none() {
            doc.insert("mcp_servers", Item::ArrayOfTables(ArrayOfTables::new()));
        }
        let entries = doc["mcp_servers"].as_array_of_tables_mut().context("mcp_servers")?;
        match (index, server) {
            (Some(i), None) => {
                entries.remove(i);
            }
            (Some(i), Some(server)) => fill(entries.get_mut(i).context("entry")?, &server),
            (None, Some(server)) => {
                let mut table = Table::new();
                fill(&mut table, &server);
                entries.push(table);
            }
            (None, None) => {}
        }
        return Ok((Some(doc.to_string()), outcome));
    }
    if doc.get("mcp_servers").is_some_and(|i| !i.is_table_like()) {
        bail!("mcp_servers is not a table");
    }
    let current = doc.get("mcp_servers").and_then(|s| s.get("browse")).map(toml_to_json);
    let (outcome, change) = decide(current.as_ref(), expected, remove);
    let Some(server) = change else { return Ok((None, outcome)) };
    if doc.get("mcp_servers").is_none() {
        let mut table = Table::new();
        table.set_implicit(true);
        doc.insert("mcp_servers", Item::Table(table));
    }
    let servers = &mut doc["mcp_servers"];
    match server {
        None => {
            servers.as_table_like_mut().context("mcp_servers")?.remove("browse");
        }
        Some(server) => match servers {
            Item::Table(servers) => match servers.get_mut("browse") {
                Some(Item::Table(table)) => fill(table, &server),
                _ => {
                    let mut table = Table::new();
                    fill(&mut table, &server);
                    servers.insert("browse", Item::Table(table));
                }
            },
            Item::Value(toml_edit::Value::InlineTable(servers)) => {
                servers.insert("browse", json_to_toml(&server));
            }
            _ => bail!("mcp_servers is not a table"),
        },
    }
    Ok((Some(doc.to_string()), outcome))
}

fn yaml_value(text: &str) -> anyhow::Result<serde_yaml::Value> {
    let value: serde_yaml::Value = if text.trim().is_empty() { serde_yaml::Value::Null } else { serde_yaml::from_str(text)? };
    Ok(match value {
        serde_yaml::Value::Null => serde_yaml::Value::Mapping(Default::default()),
        other => other,
    })
}

pub(crate) fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// Whether a line carries content (not blank, not only a comment).
pub(crate) fn content(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && !trimmed.starts_with('#')
}

/// The lines after `start` that belong to the block at indentation `indent` (more deeply indented, or blank).
pub(crate) fn block_end(lines: &[&str], start: usize, indent: usize) -> usize {
    let mut end = start + 1;
    for (i, line) in lines.iter().enumerate().skip(start + 1) {
        if content(line) && indent_of(line) <= indent {
            break;
        }
        if content(line) {
            end = i + 1;
        }
    }
    end
}

/// Adds, replaces or removes `<key>.browse` in a YAML file by editing its lines, so comments, anchors and formatting
/// elsewhere stay; then checks that the result parses to exactly the old document with that one change.
fn edit_yaml(before: &str, key: &str, expected: &Value, remove: bool) -> anyhow::Result<(Option<String>, Edit)> {
    let invalid = || anyhow::anyhow!("isn't valid YAML, or browse can't edit it safely; add the browse entry by hand");
    let doc = yaml_value(before).map_err(|_| invalid())?;
    let serde_yaml::Value::Mapping(map) = &doc else { return Err(invalid()) };
    let container = map.get(key);
    let container = match container {
        None | Some(serde_yaml::Value::Null) => None,
        Some(serde_yaml::Value::Mapping(m)) => Some(m),
        Some(_) => return Err(invalid()),
    };
    let current = container.and_then(|c| c.get("browse")).map(|v| serde_json::to_value(v).unwrap_or(Value::Null));
    let (outcome, change) = decide(current.as_ref(), expected, remove);
    let Some(server) = change else { return Ok((None, outcome)) };
    let rendered = match &server {
        Some(server) => {
            let mut entry = serde_yaml::Mapping::new();
            entry.insert("browse".into(), serde_yaml::to_value(server)?);
            serde_yaml::to_string(&entry)?
        }
        None => String::new(),
    };
    let indented = |indent: usize| rendered.lines().map(|l| format!("{}{l}", " ".repeat(indent))).collect::<Vec<_>>();
    let lines: Vec<&str> = before.lines().collect();
    let key_line = lines.iter().position(|l| {
        l.strip_prefix(key).and_then(|rest| rest.trim_start().strip_prefix(':')).is_some_and(|rest| {
            let rest = rest.trim();
            rest.is_empty() || rest.starts_with('#') || rest == "{}" || rest == "null" || rest == "~"
        })
    });
    let mut out: Vec<String> = lines.iter().map(|l| (*l).to_owned()).collect();
    match key_line {
        None => {
            if container.is_some() || remove {
                return Err(invalid());
            }
            if out.last().is_some_and(|l| !l.trim().is_empty()) {
                out.push(String::new());
            }
            out.push(format!("{key}:"));
            out.extend(indented(2));
        }
        Some(at) => {
            let end = block_end(&lines, at, 0);
            let indent = lines[at + 1..end].iter().find(|l| content(l)).map_or(2, |l| indent_of(l)).max(1);
            let value = lines[at][key.len()..].trim_start().trim_start_matches(':').split('#').next().unwrap_or_default().trim();
            if !value.is_empty() {
                out[at] = format!("{key}:");
            }
            let browse = (at + 1..end).find(|&i| indent_of(lines[i]) == indent && lines[i].trim_start().strip_prefix("browse").is_some_and(|r| r.trim_start().starts_with(':')));
            match browse {
                Some(start) => {
                    let stop = block_end(&lines, start, indent);
                    out.splice(start..stop, indented(indent));
                }
                None if remove => return Err(invalid()),
                None => {
                    out.splice(at + 1..at + 1, indented(indent));
                }
            }
        }
    }
    let mut after = out.join("\n");
    after.push('\n');
    // Only the browse entry may change.
    let mut wanted = doc.clone();
    if let serde_yaml::Value::Mapping(map) = &mut wanted {
        let entry = map.entry(key.into()).or_insert(serde_yaml::Value::Mapping(Default::default()));
        if entry.is_null() {
            *entry = serde_yaml::Value::Mapping(Default::default());
        }
        let servers = entry.as_mapping_mut().ok_or_else(invalid)?;
        match &server {
            Some(server) => {
                servers.insert("browse".into(), serde_yaml::to_value(server)?);
            }
            None => {
                servers.remove("browse");
            }
        }
    }
    let result = yaml_value(&after).map_err(|_| invalid())?;
    let same = result == wanted || (remove && matches!((&result, &wanted), (serde_yaml::Value::Mapping(r), serde_yaml::Value::Mapping(w)) if {
        // Removing the last entry leaves `key:` (null) where the check expects an empty mapping.
        let mut w = w.clone();
        if w.get(key).and_then(serde_yaml::Value::as_mapping).is_some_and(serde_yaml::Mapping::is_empty) {
            w.insert(key.into(), serde_yaml::Value::Null);
        }
        *r == w
    }));
    if !same {
        return Err(invalid());
    }
    Ok((Some(after), outcome))
}

/// The browse server in an agent's config (not OpenCode's), if it has one.
pub fn current(location: &Location) -> Option<Value> {
    let text = std::fs::read_to_string(&location.file).ok()?;
    match format(location.name) {
        Format::Json(key) => jsonc::parse(&text).ok()?.get(key)?.get("browse").cloned(),
        Format::Toml => {
            let doc: toml_edit::DocumentMut = text.parse().ok()?;
            doc.get("mcp_servers")?.get("browse").map(toml_to_json)
        }
        Format::TomlList => {
            let doc: toml_edit::DocumentMut = text.parse().ok()?;
            let list = doc.get("mcp_servers")?.as_array_of_tables()?;
            list.iter().find(|t| t.get("name").and_then(toml_edit::Item::as_str) == Some("browse")).map(|t| toml_to_json(&toml_edit::Item::Table(t.clone())))
        }
        Format::Yaml(key) => serde_json::to_value(yaml_value(&text).ok()?.get(key)?.get("browse")?).ok(),
        Format::Dsh => crate::dsh::read(&text),
    }
}

/// The MCP entry most stdio clients take, for an agent install doesn't know.
pub fn manual_entry(command: &[String], port: Option<u16>) -> String {
    let (program, args) = command.split_first().map_or(("browse", &[][..]), |(p, a)| (p.as_str(), a));
    let mut server = json!({ "command": program, "args": args });
    if let Some(port) = port {
        server["env"] = json!({ "OPENCODE_BROWSER_PORT": port.to_string() });
    }
    format!("{{\n  \"mcpServers\": {{\n    \"browse\": {}\n  }}\n}}", serde_json::to_string(&server).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loc(name: &'static str, file: PathBuf) -> Location {
        Location { name, file, installed: true }
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("browse-agents-{name}-{}", crate::session::random_u64()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn command(entry: &str) -> Vec<String> {
        vec![entry.to_owned(), "mcp".to_owned()]
    }

    #[test]
    fn names_and_aliases() {
        assert_eq!(agent_name("Claude-Code"), Some("claude"));
        assert_eq!(agent_name("codex"), Some("codex"));
        assert_eq!(agent_name("nope"), None);
        assert_eq!(AGENTS[0].0, "opencode");
    }

    #[test]
    fn json_keeps_comments_and_other_servers() {
        let dir = temp("json");
        let file = dir.join("settings.json");
        std::fs::write(&file, "{\n  // mine\n  \"amp.mcpServers\": { \"other\": { \"command\": \"x\" } }\n}\n").unwrap();
        let amp = loc("amp", file.clone());
        assert_eq!(edit(&amp, &command("/bin/browse"), false, None).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("// mine"));
        let parsed = jsonc::parse(&text).unwrap();
        assert_eq!(parsed["amp.mcpServers"]["browse"], json!({ "command": "/bin/browse", "args": ["mcp"] }));
        assert_eq!(edit(&amp, &command("/bin/browse"), false, None).unwrap(), Edit::Unchanged);
        // Another install's path is updated; the user's own keys stay.
        let with_env = text.replace("\"args\": [", "\"env\": { \"A\": \"1\" },\n      \"args\": [");
        std::fs::write(&file, with_env).unwrap();
        assert_eq!(edit(&amp, &command("/home/u/.bun/bin/browse"), false, None).unwrap(), Edit::Updated);
        let parsed = jsonc::parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(parsed["amp.mcpServers"]["browse"]["command"], "/home/u/.bun/bin/browse");
        assert_eq!(parsed["amp.mcpServers"]["browse"]["env"]["A"], "1");
        assert_eq!(edit(&amp, &command("x"), true, None).unwrap(), Edit::Removed);
        let parsed = jsonc::parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert!(parsed["amp.mcpServers"].get("browse").is_none() && parsed["amp.mcpServers"]["other"].is_object());
        // Someone else's server called browse is left alone.
        std::fs::write(&file, r#"{"mcpServers":{"browse":{"command":"other-tool","args":["serve"]}}}"#).unwrap();
        assert_eq!(edit(&loc("claude", file.clone()), &command("/bin/browse"), false, None).unwrap(), Edit::Conflict);
        assert_eq!(edit(&loc("claude", file.clone()), &command("/bin/browse"), true, None).unwrap(), Edit::Conflict);
        // A new file, a new entry; claude's has a type.
        let new = dir.join("new/.claude.json");
        assert_eq!(edit(&loc("claude", new.clone()), &command("/bin/browse"), false, None).unwrap(), Edit::Added);
        assert_eq!(jsonc::parse(&std::fs::read_to_string(&new).unwrap()).unwrap()["mcpServers"]["browse"]["type"], "stdio");
        std::fs::write(&file, "{ not json").unwrap();
        assert!(edit(&loc("claude", file), &command("/bin/browse"), false, None).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn toml_keeps_comments() {
        let dir = temp("toml");
        let file = dir.join("config.toml");
        std::fs::write(&file, "# my codex\nmodel = \"o3\"\n\n[mcp_servers.other]\ncommand = \"x\" # keep\n").unwrap();
        let codex = loc("codex", file.clone());
        assert_eq!(edit(&codex, &command("/bin/browse"), false, None).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("# my codex") && text.contains("# keep") && text.contains("[mcp_servers.browse]"), "{text}");
        assert_eq!(edit(&codex, &command("/bin/browse"), false, None).unwrap(), Edit::Unchanged);
        assert_eq!(edit(&codex, &command("/usr/bin/browse"), false, None).unwrap(), Edit::Updated);
        assert!(std::fs::read_to_string(&file).unwrap().contains("command = \"/usr/bin/browse\""));
        assert_eq!(edit(&codex, &command("x"), true, None).unwrap(), Edit::Removed);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(!text.contains("browse") && text.contains("[mcp_servers.other]"), "{text}");
        // A fresh file.
        let fresh = loc("codex", dir.join("fresh/config.toml"));
        edit(&fresh, &command("/bin/browse"), false, None).unwrap();
        assert_eq!(std::fs::read_to_string(&fresh.file).unwrap(), "[mcp_servers.browse]\ncommand = \"/bin/browse\"\nargs = [\"mcp\"]\n");
        // Vibe's list of servers.
        let vibe = loc("vibe", dir.join("vibe.toml"));
        std::fs::write(&vibe.file, "[[mcp_servers]]\nname = \"other\"\ntransport = \"stdio\"\ncommand = \"x\"\n").unwrap();
        assert_eq!(edit(&vibe, &command("/bin/browse"), false, None).unwrap(), Edit::Added);
        assert_eq!(edit(&vibe, &command("/bin/browse"), false, None).unwrap(), Edit::Unchanged);
        assert_eq!(edit(&vibe, &command("/bin/browse"), true, None).unwrap(), Edit::Removed);
        assert!(!std::fs::read_to_string(&vibe.file).unwrap().contains("browse"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn yaml_keeps_comments() {
        let dir = temp("yaml");
        let file = dir.join("config.yaml");
        let original = "# goose\nGOOSE_MODEL: x # keep\nextensions:\n  developer:\n    enabled: true\n    type: builtin\nother: 1\n";
        std::fs::write(&file, original).unwrap();
        let goose = loc("goose", file.clone());
        assert_eq!(edit(&goose, &command("/bin/browse"), false, None).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("# goose") && text.contains("# keep"), "{text}");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();
        assert_eq!(parsed["extensions"]["browse"]["cmd"].as_str(), Some("/bin/browse"));
        assert_eq!(parsed["extensions"]["developer"]["type"].as_str(), Some("builtin"));
        assert_eq!(edit(&goose, &command("/bin/browse"), false, None).unwrap(), Edit::Unchanged);
        assert_eq!(edit(&goose, &command("/usr/bin/browse"), false, None).unwrap(), Edit::Updated);
        let parsed: serde_yaml::Value = serde_yaml::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(parsed["extensions"]["browse"]["cmd"].as_str(), Some("/usr/bin/browse"));
        assert_eq!(edit(&goose, &command("x"), true, None).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
        // No key yet, an empty mapping, a new file.
        let hermes = loc("hermes", dir.join("hermes.yaml"));
        std::fs::write(&hermes.file, "model: x\n").unwrap();
        assert_eq!(edit(&hermes, &command("/bin/browse"), false, None).unwrap(), Edit::Added);
        std::fs::write(&hermes.file, "mcp_servers: {}\n").unwrap();
        assert_eq!(edit(&hermes, &command("/bin/browse"), false, None).unwrap(), Edit::Added);
        let fresh = loc("hermes", dir.join("fresh/config.yaml"));
        assert_eq!(edit(&fresh, &command("/bin/browse"), false, None).unwrap(), Edit::Added);
        let parsed: serde_yaml::Value = serde_yaml::from_str(&std::fs::read_to_string(&fresh.file).unwrap()).unwrap();
        assert_eq!(parsed["mcp_servers"]["browse"]["args"][0].as_str(), Some("mcp"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn workbuddy_and_trae_cn_use_plain_mcp_servers() {
        let dir = temp("plain-mcp-agents");
        let file = dir.join("mcp.json");
        std::fs::write(&file, "{\n  \"mcpServers\": {\n    \"other\": { \"command\": \"x\", \"disabled\": true }\n  }\n}\n").unwrap();
        for name in ["workbuddy", "trae-cn"] {
            let agent = loc(name, file.clone());
            assert_eq!(edit(&agent, &command("/bin/browse"), false, None).unwrap(), Edit::Added, "{name}");
            let parsed = jsonc::parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
            assert_eq!(parsed["mcpServers"]["browse"], json!({ "command": "/bin/browse", "args": ["mcp"] }), "{name}");
            assert_eq!(parsed["mcpServers"]["other"], json!({ "command": "x", "disabled": true }), "{name}");
            assert_eq!(edit(&agent, &command("/bin/browse"), true, None).unwrap(), Edit::Removed, "{name}");
            let parsed = jsonc::parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
            assert!(parsed["mcpServers"].get("browse").is_none(), "{name}");
            assert_eq!(parsed["mcpServers"]["other"], json!({ "command": "x", "disabled": true }), "{name}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn workbuddy_and_trae_cn_config_paths() {
        let locations = locations(&PathBuf::from("/tmp/opencode.json"), None);
        let file = |name: &str| locations.iter().find(|l| l.name == name).map(|l| l.file.clone()).unwrap();
        assert!(file("workbuddy").ends_with(".workbuddy/mcp.json"), "{:?}", file("workbuddy"));
        assert!(file("trae-cn").ends_with("Trae CN/User/mcp.json"), "{:?}", file("trae-cn"));
        assert_eq!(agent_name("workbuddy"), Some("workbuddy"));
        assert_eq!(agent_name("trae-cn"), Some("trae-cn"));
    }

    #[test]
    fn a_pinned_port_goes_in_each_agents_environment() {
        let dir = temp("pinned-port");
        // Codex's TOML gets its own [mcp_servers.browse.env] section.
        let codex = loc("codex", dir.join("codex/config.toml"));
        assert_eq!(edit(&codex, &command("/bin/browse"), false, Some(20000)).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&codex.file).unwrap();
        assert_eq!(text, "[mcp_servers.browse]\ncommand = \"/bin/browse\"\nargs = [\"mcp\"]\n\n[mcp_servers.browse.env]\nOPENCODE_BROWSER_PORT = \"20000\"\n");
        // The same port again changes nothing; a different one updates it; no port leaves it.
        assert_eq!(edit(&codex, &command("/bin/browse"), false, Some(20000)).unwrap(), Edit::Unchanged);
        assert_eq!(edit(&codex, &command("/bin/browse"), false, Some(20001)).unwrap(), Edit::Updated);
        assert!(std::fs::read_to_string(&codex.file).unwrap().contains("OPENCODE_BROWSER_PORT = \"20001\""));
        assert_eq!(edit(&codex, &command("/bin/browse"), false, None).unwrap(), Edit::Unchanged);

        // A JSON entry with the user's own env keeps it and gains the port.
        let claude = loc("claude", dir.join("claude.json"));
        std::fs::write(&claude.file, r#"{"mcpServers":{"browse":{"type":"stdio","command":"/bin/browse","args":["mcp"],"env":{"MINE":"1"}}}}"#).unwrap();
        assert_eq!(edit(&claude, &command("/bin/browse"), false, Some(20000)).unwrap(), Edit::Updated);
        let parsed = jsonc::parse(&std::fs::read_to_string(&claude.file).unwrap()).unwrap();
        assert_eq!(parsed["mcpServers"]["browse"]["env"], json!({ "MINE": "1", "OPENCODE_BROWSER_PORT": "20000" }));
        assert_eq!(edit(&claude, &command("/bin/browse"), false, Some(20000)).unwrap(), Edit::Unchanged);

        // Goose's envs, Kilo's environment.
        let goose = loc("goose", dir.join("goose.yaml"));
        assert_eq!(edit(&goose, &command("/bin/browse"), false, Some(20000)).unwrap(), Edit::Added);
        let parsed: serde_yaml::Value = serde_yaml::from_str(&std::fs::read_to_string(&goose.file).unwrap()).unwrap();
        assert_eq!(parsed["extensions"]["browse"]["envs"]["OPENCODE_BROWSER_PORT"].as_str(), Some("20000"));
        let kilo = loc("kilo", dir.join("kilo.json"));
        assert_eq!(edit(&kilo, &command("/bin/browse"), false, Some(20000)).unwrap(), Edit::Added);
        let parsed = jsonc::parse(&std::fs::read_to_string(&kilo.file).unwrap()).unwrap();
        assert_eq!(parsed["mcp"]["browse"]["environment"], json!({ "OPENCODE_BROWSER_PORT": "20000" }));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unpinned_install_writes_no_environment() {
        let dir = temp("unpinned");
        let claude = loc("claude", dir.join("claude.json"));
        assert_eq!(edit(&claude, &command("/bin/browse"), false, None).unwrap(), Edit::Added);
        let parsed = jsonc::parse(&std::fs::read_to_string(&claude.file).unwrap()).unwrap();
        assert!(parsed["mcpServers"]["browse"].get("env").is_none(), "{parsed}");
        let codex = loc("codex", dir.join("codex/config.toml"));
        assert_eq!(edit(&codex, &command("/bin/browse"), false, None).unwrap(), Edit::Added);
        assert!(!std::fs::read_to_string(&codex.file).unwrap().contains(".env]"));
        // An env the user wrote is left exactly as it was.
        std::fs::write(&claude.file, r#"{"mcpServers":{"browse":{"type":"stdio","command":"/bin/browse","args":["mcp"],"env":{"MINE":"1"}}}}"#).unwrap();
        assert_eq!(edit(&claude, &command("/bin/browse"), false, None).unwrap(), Edit::Unchanged);
        assert_eq!(jsonc::parse(&std::fs::read_to_string(&claude.file).unwrap()).unwrap()["mcpServers"]["browse"]["env"]["MINE"], "1");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn manual_entry_carries_a_pinned_port() {
        let entry = manual_entry(&command("/home/u/.local/bin/browse"), Some(20000));
        let parsed = jsonc::parse(&entry).unwrap();
        assert_eq!(parsed["mcpServers"]["browse"]["env"], json!({ "OPENCODE_BROWSER_PORT": "20000" }));
        let parsed = jsonc::parse(&manual_entry(&command("/bin/browse"), None)).unwrap();
        assert!(parsed["mcpServers"]["browse"].get("env").is_none());
    }

    #[test]
    fn owned_entries() {
        assert!(owned(&json!({ "command": "/home/u/.local/bin/browse", "args": ["mcp"] })));
        assert!(owned(&json!({ "command": "node", "args": ["/x/@opencode/browse/dist/cli.mjs", "mcp"] })));
        assert!(owned(&json!({ "command": "npx", "args": ["-y", "@opencode/browse@dev", "mcp"] })));
        assert!(owned(&json!({ "type": "local", "command": ["browse", "mcp"] })));
        assert!(owned(&json!({ "cmd": "browse", "args": ["mcp"] })));
        assert!(!owned(&json!({ "command": "playwright-mcp", "args": [] })));
        assert!(!owned(&json!({ "command": "browse", "args": ["serve"] })));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_agent_config_keeps_its_link() {
        use std::os::unix::fs::symlink;

        let dir = temp("symlink-json");
        let target = dir.join("dotfiles/mcp.json");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "{\n  // mine\n  \"mcpServers\": {}\n}\n").unwrap();
        let file = dir.join("pi/mcp.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        symlink("../dotfiles/mcp.json", &file).unwrap();
        let pi = loc("pi", file.clone());

        assert_eq!(edit(&pi, &command("/bin/browse"), false, None).unwrap(), Edit::Added);
        assert!(std::fs::symlink_metadata(&file).unwrap().file_type().is_symlink(), "the link stays a link");
        let text = std::fs::read_to_string(&target).unwrap();
        assert!(text.contains("// mine"), "{text}");
        assert_eq!(current(&pi).unwrap()["command"], "/bin/browse");
        assert_eq!(edit(&pi, &command("/bin/browse"), true, None).unwrap(), Edit::Removed);
        assert!(std::fs::symlink_metadata(&file).unwrap().file_type().is_symlink(), "uninstall keeps it too");
        assert!(!std::fs::read_to_string(&target).unwrap().contains("browse"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_config_link_is_refused() {
        use std::os::unix::fs::symlink;

        let dir = temp("symlink-dangling");
        let file = dir.join("pi/mcp.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        symlink("../dotfiles/missing.json", &file).unwrap();
        let pi = loc("pi", file.clone());

        let error = edit(&pi, &command("/bin/browse"), false, None).expect_err("a dangling link isn't written through");
        assert!(error.to_string().contains("doesn't exist"), "{error}");
        assert!(std::fs::symlink_metadata(&file).unwrap().file_type().is_symlink(), "the dangling link stays where it was");
        assert!(!dir.join("dotfiles/missing.json").exists());
        assert_eq!(edit(&pi, &command("/bin/browse"), true, None).unwrap(), Edit::Unchanged);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn dsh_uninstall_through_a_symlink_clears_the_target() {
        use std::os::unix::fs::symlink;

        let dir = temp("symlink-dsh");
        let target = dir.join("dotfiles/cordis.patch.yml");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        let row = "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n";
        std::fs::write(&target, row).unwrap();
        let file = dir.join("dsh/cordis.patch.yml");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        symlink("../dotfiles/cordis.patch.yml", &file).unwrap();
        let dsh = loc("dsh", file.clone());

        assert_eq!(edit(&dsh, &command("/bin/browse"), true, None).unwrap(), Edit::Removed);
        assert!(std::fs::symlink_metadata(&file).unwrap().file_type().is_symlink(), "the link stays a link");
        // An empty layer dsh can still load, rather than a deleted file.
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "[]\n");
        assert!(current(&dsh).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
