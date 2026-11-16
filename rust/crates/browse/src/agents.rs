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

/// dsh's home: `$DSH_HOME` unless it is blank, else `~/.dsh` (dsh-home-paths).
fn dsh_home(value: Option<std::ffi::OsString>, home: &Path) -> PathBuf {
    value.filter(|value| !value.to_string_lossy().trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".dsh"))
}

/// dsh's user patch layer. Debian's unrelated `dsh` (distributed shell) also has a `dsh` binary and `~/.dsh`, so only
/// dsh's own files count as installed.
fn dsh_location(home: PathBuf) -> Location {
    let file = home.join("cordis.patch.yml");
    let installed = home.join("profiles").exists() || file.exists();
    Location { name: "dsh", file, installed }
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
    let dsh = dsh_home(std::env::var_os("DSH_HOME"), &home);
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
        dsh_location(dsh),
        loc("hermes", env("HERMES_HOME").unwrap_or_else(|| at(".hermes")).join("config.yaml"), Some("hermes"), None, None),
        loc("grok", env("GROK_HOME").unwrap_or_else(|| at(".grok")).join("config.toml"), Some("grok"), None, None),
        loc("vibe", env("VIBE_HOME").unwrap_or_else(|| at(".vibe")).join("config.toml"), Some("vibe"), None, None),
        loc("qoder", at(".qoder/settings.json"), Some("qoder"), Some("Qoder"), None),
        loc("pi", env("PI_CODING_AGENT_DIR").unwrap_or_else(|| at(".pi/agent")).join("mcp.json"), Some("pi"), None, None),
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

/// The browse server as `name`'s config expects it, running `command args...`.
pub fn definition(name: &str, command: &str, args: &[String]) -> Value {
    match name {
        "kilo" => json!({ "type": "local", "command": std::iter::once(command.to_owned()).chain(args.iter().cloned()).collect::<Vec<_>>() }),
        "goose" => json!({ "type": "stdio", "name": "browse", "enabled": true, "cmd": command, "args": args }),
        "copilot" => json!({ "type": "local", "command": command, "args": args, "tools": ["*"] }),
        "vibe" => json!({ "name": "browse", "transport": "stdio", "command": command, "args": args }),
        "dsh" => json!({ "serverName": "browse", "transport": "stdio", "command": command, "args": args }),
        "claude" | "vscode" | "cortex" | "droid" | "codebuddy" => json!({ "type": "stdio", "command": command, "args": args }),
        _ => json!({ "command": command, "args": args }),
    }
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
/// takes it out again. Settings the user added to the entry stay.
pub fn edit(location: &Location, command: &[String], remove: bool) -> anyhow::Result<Edit> {
    let file = &location.file;
    let exists = file.is_file();
    if !exists && remove {
        return Ok(Edit::Unchanged);
    }
    let before = if exists { std::fs::read_to_string(file).with_context(|| format!("can't read {}", file.display()))? } else { String::new() };
    let (program, args) = command.split_first().context("empty command")?;
    let expected = definition(location.name, program, args);
    let invalid = || anyhow::anyhow!("{} isn't valid {}; left unchanged", file.display(), kind(location.name));
    let (after, outcome) = match format(location.name) {
        Format::Json(key) => edit_json(&before, key, &expected, remove).map_err(|_| invalid())?,
        Format::Toml => edit_toml(&before, &expected, remove, false).map_err(|_| invalid())?,
        Format::TomlList => edit_toml(&before, &expected, remove, true).map_err(|_| invalid())?,
        Format::Yaml(key) => edit_yaml(&before, key, &expected, remove)?,
        Format::Dsh => edit_dsh(&before, &expected, remove)?,
    };
    if let Some(after) = after {
        if exists && std::fs::read_to_string(file).ok().as_deref() != Some(before.as_str()) {
            bail!("{} changed while browse was editing it; try again", file.display());
        }
        if location.name == "dsh" && after.is_empty() {
            std::fs::remove_file(file).with_context(|| format!("can't remove {}", file.display()))?;
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

/// The entry with browse's fields set over what's there.
fn merged(current: Option<&Value>, expected: &Value) -> Value {
    let mut server = current.filter(|c| c.is_object()).cloned().unwrap_or_else(|| json!({}));
    for (key, value) in expected.as_object().into_iter().flatten() {
        server[key] = value.clone();
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
fn decide(current: Option<&Value>, expected: &Value, remove: bool) -> (Edit, Option<Option<Value>>) {
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

/// Sets browse's fields in a TOML table (keeping the user's other keys), or a new table with just them.
fn fill(table: &mut toml_edit::Table, server: &Value) {
    for (key, value) in server.as_object().into_iter().flatten() {
        table.insert(key, toml_edit::Item::Value(json_to_toml(value)));
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

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// Whether a line carries content (not blank, not only a comment).
fn content(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && !trimmed.starts_with('#')
}

/// The lines after `start` that belong to the block at indentation `indent` (more deeply indented, or blank).
fn block_end(lines: &[&str], start: usize, indent: usize) -> usize {
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

/// The dsh MCP plugin whose rows run browse.
const DSH_CLIENT: &str = "@deepseek-ai/dsh-mcp-client";
/// The config keys a browse row always has.
const DSH_KEYS: [&str; 4] = ["serverName", "transport", "command", "args"];

/// A dsh patch file's rows: a top-level YAML list of patch entries, where an empty or comment-only file is an empty list.
fn dsh_patches(text: &str) -> anyhow::Result<Vec<serde_yaml::Value>> {
    let value: serde_yaml::Value = if text.trim().is_empty() { serde_yaml::Value::Null } else { serde_yaml::from_str(text)? };
    match value {
        serde_yaml::Value::Null => Ok(Vec::new()),
        serde_yaml::Value::Sequence(rows) if rows.iter().all(serde_yaml::Value::is_mapping) => Ok(rows),
        _ => bail!("not a top-level YAML list of patch entries"),
    }
}

fn dsh_config(row: &serde_yaml::Value) -> Option<&serde_yaml::Value> {
    row.get("config")
}

/// Whether an inserted dsh row is named browse: our id, or the `serverName` its tools are named after.
fn dsh_named(row: &serde_yaml::Value) -> bool {
    row.get("id").and_then(serde_yaml::Value::as_str) == Some("browse")
        || dsh_config(row).and_then(|config| config.get("serverName")).and_then(serde_yaml::Value::as_str) == Some("browse")
}

/// Whether a row is one browse wrote: our plugin name, and browse's id or serverName.
fn dsh_ours(row: &serde_yaml::Value) -> bool {
    row.get("name").and_then(serde_yaml::Value::as_str) == Some(DSH_CLIENT) && dsh_named(row)
}

/// Whether a `serverName` is set to browse anywhere, including rows nested too deeply for the finder.
fn dsh_mentions_browse(text: &str) -> bool {
    text.lines().any(|line| {
        if line.trim_start().starts_with('#') {
            return false;
        }
        line.split_once("serverName").is_some_and(|(_, rest)| {
            let rest = rest.trim_start();
            let rest = rest.strip_prefix(':').unwrap_or(rest).trim_start();
            let value = rest.split(['}', ']', ',', '#', ' ']).next().unwrap_or_default();
            value.trim_matches(['\'', '"']) == "browse"
        })
    })
}

/// The patch and inserted row that configure browse, if the file has one.
fn dsh_find(patches: &[serde_yaml::Value]) -> anyhow::Result<Option<(usize, usize)>> {
    let mut found = None;
    for (patch, entry) in patches.iter().enumerate() {
        for (row, inserted) in entry.get("insert").and_then(serde_yaml::Value::as_sequence).into_iter().flatten().enumerate() {
            if dsh_named(inserted) {
                if found.is_some() {
                    bail!("has more than one browse server");
                }
                found = Some((patch, row));
            }
        }
    }
    Ok(found)
}

/// The lines of the inserted browse row: a nested `- ` item under an `insert:` patch.
fn dsh_span(lines: &[&str]) -> anyhow::Result<(usize, usize)> {
    let mut found = Vec::new();
    for (start, line) in lines.iter().enumerate() {
        let indent = indent_of(line);
        if indent == 0 || !line.trim_start().starts_with("- ") {
            continue;
        }
        let end = block_end(lines, start, indent);
        let block: Vec<&str> = lines[start..end].iter().map(|line| line.get(indent..).unwrap_or_default()).collect();
        if let Ok(serde_yaml::Value::Sequence(rows)) = serde_yaml::from_str::<serde_yaml::Value>(&block.join("\n"))
            && rows.len() == 1
            && dsh_named(&rows[0])
        {
            found.push((start, end));
        }
    }
    match found.as_slice() {
        [span] => Ok(*span),
        [] => bail!("has no browse row browse can find"),
        _ => bail!("has more than one browse row"),
    }
}

/// The lines of the top-level `- insert:` patch that holds a nested row.
fn dsh_parent(lines: &[&str], start: usize) -> anyhow::Result<(usize, usize)> {
    let indent = indent_of(lines[start]);
    for at in (0..start).rev() {
        if !content(lines[at]) || indent_of(lines[at]) >= indent {
            continue;
        }
        if lines[at].trim_start().strip_prefix('-').is_some_and(|rest| rest.trim_start().starts_with("insert:")) {
            return Ok((at, block_end(lines, at, indent_of(lines[at]))));
        }
        break;
    }
    bail!("can't find the insert patch around the browse row")
}

/// The file's lines without terminators, its newline style, and whether it ended with one.
fn dsh_text(text: &str) -> (Vec<String>, &'static str, bool) {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let trailing = text.ends_with('\n');
    let mut lines: Vec<String> = text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned()).collect();
    if text.is_empty() {
        lines.clear();
    } else if trailing {
        lines.pop();
    }
    (lines, newline, trailing)
}

fn dsh_join(lines: &[String], newline: &str, trailing: bool) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut out = lines.join(newline);
    if trailing {
        out.push_str(newline);
    }
    out
}

/// One YAML value on one line.
fn yaml_scalar(value: &serde_yaml::Value) -> String {
    serde_yaml::to_string(value).unwrap_or_default().trim_end_matches('\n').to_owned()
}

fn yaml_flow(value: &serde_yaml::Value) -> String {
    match value {
        serde_yaml::Value::Sequence(items) => format!("[{}]", items.iter().map(yaml_scalar).collect::<Vec<_>>().join(", ")),
        value => yaml_scalar(value),
    }
}

/// A new browse row, with only the config keys browse sets.
fn dsh_new_row(expected: &Value) -> anyhow::Result<serde_yaml::Value> {
    let mut config = serde_yaml::Mapping::new();
    for key in DSH_KEYS {
        config.insert(key.into(), serde_yaml::to_value(expected.get(key).unwrap_or(&Value::Null))?);
    }
    let mut row = serde_yaml::Mapping::new();
    row.insert("id".into(), "browse".into());
    row.insert("name".into(), DSH_CLIENT.into());
    row.insert("config".into(), serde_yaml::Value::Mapping(config));
    Ok(serde_yaml::Value::Mapping(row))
}

/// The new row's lines at `indent`, in dsh's MCP example shape.
fn dsh_lines(expected: &Value, indent: usize) -> Vec<String> {
    let pad = " ".repeat(indent);
    let name = yaml_scalar(&serde_yaml::Value::String(DSH_CLIENT.to_owned()));
    let mut lines = vec![format!("{pad}- id: browse"), format!("{pad}  name: {name}"), format!("{pad}  config:")];
    for key in DSH_KEYS {
        let value = serde_yaml::to_value(expected.get(key).unwrap_or(&Value::Null)).unwrap_or(serde_yaml::Value::Null);
        lines.push(format!("{pad}    {key}: {}", yaml_flow(&value)));
    }
    lines
}

/// Appends a patch as text. A blank separator marks a file that ended with a newline, so removal can restore the exact
/// bytes; an explicit `[]` (which can't be followed by block rows) is dropped first.
fn dsh_append(before: &str, block: &[String], empty: bool) -> String {
    let (mut lines, newline, trailing) = dsh_text(before);
    if empty && let Some(at) = lines.iter().position(|line| indent_of(line) == 0 && line.trim() == "[]") {
        lines.remove(at);
    }
    let trailing = trailing && !lines.is_empty();
    let mut out = lines;
    if trailing {
        out.push(String::new());
    }
    out.extend(block.iter().cloned());
    dsh_join(&out, newline, true)
}

/// A line with a value, not just a comment or YAML document marker.
fn dsh_content(line: &str) -> bool {
    let line = line.trim();
    content(line) && line != "---" && line != "..." && !line.starts_with('%')
}

/// dsh only boots when its patch layer is a list: comments left after removing the last patch get an empty `[]` list.
fn dsh_valid_empty(text: String, newline: &str) -> String {
    if text.lines().any(dsh_content) {
        return text;
    }
    if text.trim().is_empty() {
        return String::new();
    }
    let mut out = text;
    if !out.ends_with('\n') {
        out.push_str(newline);
    }
    out.push_str("[]");
    out.push_str(newline);
    out
}

/// A line's mapping key, allowing the `- ` of the row's first item.
fn dsh_key(line: &str) -> Option<&str> {
    let line = line.trim_start();
    let line = line.strip_prefix("- ").unwrap_or(line);
    line.split_once(':').map(|(key, _)| key.trim())
}

/// The row's `config:` line, which must be a block mapping.
fn dsh_config_line(lines: &[&str], start: usize, end: usize) -> Option<usize> {
    let indent = indent_of(lines[start]) + 2;
    let mut found = None;
    for (at, line) in lines.iter().enumerate().take(end).skip(start) {
        let key_indent = if at == start { indent_of(line) + 2 } else { indent_of(line) };
        if key_indent != indent || dsh_key(line) != Some("config") {
            continue;
        }
        if found.is_some() {
            return None;
        }
        let line = line.trim_start();
        let line = line.strip_prefix("- ").unwrap_or(line);
        let rest = line.strip_prefix("config:")?.trim();
        if !rest.is_empty() && !rest.starts_with('#') {
            return None;
        }
        found = Some(at);
    }
    found
}

/// A config key's simple single-line `key: value` line, if it has exactly one and no comment or multi-line value.
fn dsh_value_line(lines: &[&str], config: usize, end: usize, key: &str) -> Option<usize> {
    let indent = (config + 1..end).find(|&at| content(lines[at])).map_or(indent_of(lines[config]) + 2, |at| indent_of(lines[at]));
    let mut found = None;
    for (at, line) in lines.iter().enumerate().take(end).skip(config + 1) {
        if indent_of(line) != indent || dsh_key(line) != Some(key) {
            continue;
        }
        if found.is_some() {
            return None;
        }
        let line = line.trim_start();
        let line = line.strip_prefix("- ").unwrap_or(line);
        let value = line.split_once(':')?.1.trim();
        if value.is_empty() || value.starts_with('#') || value.contains('#') || value.starts_with(['&', '*', '|', '>']) {
            return None;
        }
        if at + 1 < end && content(lines[at + 1]) && indent_of(lines[at + 1]) > indent {
            return None;
        }
        found = Some(at);
    }
    found
}

/// The config keys whose value differs from what browse runs.
fn dsh_changed(have: Option<&serde_yaml::Mapping>, expected: &Value) -> Vec<&'static str> {
    let want = serde_yaml::to_value(expected).ok();
    let want = want.as_ref().and_then(serde_yaml::Value::as_mapping);
    DSH_KEYS.iter().copied().filter(|key| have.and_then(|have| have.get(*key)) != want.and_then(|want| want.get(*key))).collect()
}

/// Adds, updates or removes browse's row in a dsh Cordis patch layer by splicing lines, then checks that the result
/// parses to exactly the old list with that one row changed.
fn edit_dsh(before: &str, expected: &Value, remove: bool) -> anyhow::Result<(Option<String>, Edit)> {
    let invalid = || anyhow::anyhow!("isn't a dsh patch file browse can edit safely; add the browse entry by hand");
    let patches = dsh_patches(before).map_err(|_| invalid())?;
    let found = match dsh_find(&patches) {
        Ok(found) => found,
        Err(_) => return Ok((None, Edit::Conflict)),
    };
    let current = match found {
        None => {
            if dsh_mentions_browse(before) {
                return Ok((None, Edit::Conflict));
            }
            None
        }
        Some((patch, row)) => {
            let row = &patches[patch]["insert"][row];
            let config = dsh_config(row).and_then(|config| serde_json::to_value(config).ok());
            if !dsh_ours(row) || !config.as_ref().is_some_and(owned) {
                return Ok((None, Edit::Conflict));
            }
            config
        }
    };
    let (outcome, change) = decide(current.as_ref(), expected, remove);
    let Some(server) = change else { return Ok((None, outcome)) };
    let (lines, newline, trailing) = dsh_text(before);
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let span = match found {
        Some(_) => match dsh_span(&refs) {
            Ok(span) => Some(span),
            Err(_) => return Ok((None, Edit::Conflict)),
        },
        None => None,
    };
    let mut wanted = patches.clone();
    let after = match (found, &server, remove) {
        (None, Some(server), false) => {
            let mut patch = serde_yaml::Mapping::new();
            patch.insert("insert".into(), serde_yaml::Value::Sequence(vec![dsh_new_row(server)?]));
            wanted.push(serde_yaml::Value::Mapping(patch));
            let mut block = vec!["- insert:".to_owned()];
            block.extend(dsh_lines(server, 4));
            dsh_append(before, &block, patches.is_empty())
        }
        (Some((patch, row)), None, true) => {
            let Some((start, end)) = span else { return Ok((None, Edit::Conflict)) };
            let mut out = lines.clone();
            let only = patches[patch]["insert"].as_sequence().is_some_and(|insert| insert.len() == 1);
            let trailing = if only {
                let Ok((parent, parent_end)) = dsh_parent(&refs, start) else { return Ok((None, Edit::Conflict)) };
                let from = if parent > 0 && out[parent - 1].is_empty() { parent - 1 } else { parent };
                let trailing = if from < parent { true } else if parent_end == out.len() { false } else { trailing };
                out.drain(from..parent_end);
                wanted.remove(patch);
                trailing
            } else {
                out.drain(start..end);
                if let Some(insert) = wanted[patch]["insert"].as_sequence_mut() {
                    insert.remove(row);
                }
                trailing
            };
            dsh_join(&out, newline, trailing)
        }
        (Some((patch, row)), Some(_), false) => {
            let Some((start, end)) = span else { return Ok((None, Edit::Conflict)) };
            if refs[start..end].join("\n").contains('!') {
                return Ok((None, Edit::Conflict));
            }
            let have = dsh_config(&patches[patch]["insert"][row]).and_then(serde_yaml::Value::as_mapping);
            let changed = dsh_changed(have, expected);
            if changed.is_empty() {
                return Ok((None, outcome));
            }
            let want = serde_yaml::to_value(expected)?;
            let mut out = lines.clone();
            let Some(config_line) = dsh_config_line(&refs, start, end) else { return Ok((None, Edit::Conflict)) };
            let config_end = block_end(&refs, config_line, indent_of(refs[config_line])).min(end);
            for key in &changed {
                let Some(at) = dsh_value_line(&refs, config_line, config_end, key) else { return Ok((None, Edit::Conflict)) };
                let value = want.get(*key).cloned().unwrap_or(serde_yaml::Value::Null);
                let lead = &out[at][..out[at].len() - out[at].trim_start().len()];
                out[at] = format!("{lead}{key}: {}", yaml_flow(&value));
            }
            if let Some(config) = wanted[patch]["insert"][row].get_mut("config")
                && let Some(map) = config.as_mapping_mut()
            {
                for key in &changed {
                    map.insert((*key).into(), want.get(*key).cloned().unwrap_or(serde_yaml::Value::Null));
                }
            }
            dsh_join(&out, newline, trailing)
        }
        _ => return Err(invalid()),
    };
    let after = if wanted.is_empty() && !after.lines().any(dsh_content) { dsh_valid_empty(after, newline) } else { after };
    if dsh_patches(&after).map_err(|_| invalid())? != wanted {
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
        Format::Dsh => {
            let patches = dsh_patches(&text).ok()?;
            let (patch, row) = dsh_find(&patches).ok()??;
            let row = &patches[patch]["insert"][row];
            if !dsh_ours(row) {
                return None;
            }
            serde_json::to_value(dsh_config(row)?).ok()
        }
    }
}

/// The MCP entry most stdio clients take, for an agent install doesn't know.
pub fn manual_entry(command: &[String]) -> String {
    let (program, args) = command.split_first().map_or(("browse", &[][..]), |(p, a)| (p.as_str(), a));
    let server = json!({ "command": program, "args": args });
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
        assert_eq!(edit(&amp, &command("/bin/browse"), false).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("// mine"));
        let parsed = jsonc::parse(&text).unwrap();
        assert_eq!(parsed["amp.mcpServers"]["browse"], json!({ "command": "/bin/browse", "args": ["mcp"] }));
        assert_eq!(edit(&amp, &command("/bin/browse"), false).unwrap(), Edit::Unchanged);
        // Another install's path is updated; the user's own keys stay.
        let with_env = text.replace("\"args\": [", "\"env\": { \"A\": \"1\" },\n      \"args\": [");
        std::fs::write(&file, with_env).unwrap();
        assert_eq!(edit(&amp, &command("/home/u/.bun/bin/browse"), false).unwrap(), Edit::Updated);
        let parsed = jsonc::parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(parsed["amp.mcpServers"]["browse"]["command"], "/home/u/.bun/bin/browse");
        assert_eq!(parsed["amp.mcpServers"]["browse"]["env"]["A"], "1");
        assert_eq!(edit(&amp, &command("x"), true).unwrap(), Edit::Removed);
        let parsed = jsonc::parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert!(parsed["amp.mcpServers"].get("browse").is_none() && parsed["amp.mcpServers"]["other"].is_object());
        // Someone else's server called browse is left alone.
        std::fs::write(&file, r#"{"mcpServers":{"browse":{"command":"other-tool","args":["serve"]}}}"#).unwrap();
        assert_eq!(edit(&loc("claude", file.clone()), &command("/bin/browse"), false).unwrap(), Edit::Conflict);
        assert_eq!(edit(&loc("claude", file.clone()), &command("/bin/browse"), true).unwrap(), Edit::Conflict);
        // A new file, a new entry; claude's has a type.
        let new = dir.join("new/.claude.json");
        assert_eq!(edit(&loc("claude", new.clone()), &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(jsonc::parse(&std::fs::read_to_string(&new).unwrap()).unwrap()["mcpServers"]["browse"]["type"], "stdio");
        std::fs::write(&file, "{ not json").unwrap();
        assert!(edit(&loc("claude", file), &command("/bin/browse"), false).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn toml_keeps_comments() {
        let dir = temp("toml");
        let file = dir.join("config.toml");
        std::fs::write(&file, "# my codex\nmodel = \"o3\"\n\n[mcp_servers.other]\ncommand = \"x\" # keep\n").unwrap();
        let codex = loc("codex", file.clone());
        assert_eq!(edit(&codex, &command("/bin/browse"), false).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("# my codex") && text.contains("# keep") && text.contains("[mcp_servers.browse]"), "{text}");
        assert_eq!(edit(&codex, &command("/bin/browse"), false).unwrap(), Edit::Unchanged);
        assert_eq!(edit(&codex, &command("/usr/bin/browse"), false).unwrap(), Edit::Updated);
        assert!(std::fs::read_to_string(&file).unwrap().contains("command = \"/usr/bin/browse\""));
        assert_eq!(edit(&codex, &command("x"), true).unwrap(), Edit::Removed);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(!text.contains("browse") && text.contains("[mcp_servers.other]"), "{text}");
        // A fresh file.
        let fresh = loc("codex", dir.join("fresh/config.toml"));
        edit(&fresh, &command("/bin/browse"), false).unwrap();
        assert_eq!(std::fs::read_to_string(&fresh.file).unwrap(), "[mcp_servers.browse]\ncommand = \"/bin/browse\"\nargs = [\"mcp\"]\n");
        // Vibe's list of servers.
        let vibe = loc("vibe", dir.join("vibe.toml"));
        std::fs::write(&vibe.file, "[[mcp_servers]]\nname = \"other\"\ntransport = \"stdio\"\ncommand = \"x\"\n").unwrap();
        assert_eq!(edit(&vibe, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(edit(&vibe, &command("/bin/browse"), false).unwrap(), Edit::Unchanged);
        assert_eq!(edit(&vibe, &command("/bin/browse"), true).unwrap(), Edit::Removed);
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
        assert_eq!(edit(&goose, &command("/bin/browse"), false).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("# goose") && text.contains("# keep"), "{text}");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();
        assert_eq!(parsed["extensions"]["browse"]["cmd"].as_str(), Some("/bin/browse"));
        assert_eq!(parsed["extensions"]["developer"]["type"].as_str(), Some("builtin"));
        assert_eq!(edit(&goose, &command("/bin/browse"), false).unwrap(), Edit::Unchanged);
        assert_eq!(edit(&goose, &command("/usr/bin/browse"), false).unwrap(), Edit::Updated);
        let parsed: serde_yaml::Value = serde_yaml::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(parsed["extensions"]["browse"]["cmd"].as_str(), Some("/usr/bin/browse"));
        assert_eq!(edit(&goose, &command("x"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
        // No key yet, an empty mapping, a new file.
        let hermes = loc("hermes", dir.join("hermes.yaml"));
        std::fs::write(&hermes.file, "model: x\n").unwrap();
        assert_eq!(edit(&hermes, &command("/bin/browse"), false).unwrap(), Edit::Added);
        std::fs::write(&hermes.file, "mcp_servers: {}\n").unwrap();
        assert_eq!(edit(&hermes, &command("/bin/browse"), false).unwrap(), Edit::Added);
        let fresh = loc("hermes", dir.join("fresh/config.yaml"));
        assert_eq!(edit(&fresh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        let parsed: serde_yaml::Value = serde_yaml::from_str(&std::fs::read_to_string(&fresh.file).unwrap()).unwrap();
        assert_eq!(parsed["mcp_servers"]["browse"]["args"][0].as_str(), Some("mcp"));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn dsh_row(command: &str) -> String {
        format!("- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: {command}\n        args: [mcp]\n")
    }

    #[test]
    fn dsh_patch_file() {
        let dir = temp("dsh");
        let file = dir.join("dsh/cordis.patch.yml");
        let dsh = loc("dsh", file.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), dsh_row("/bin/browse"));
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Unchanged);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
        assert_eq!(current(&dsh).unwrap()["serverName"], "browse");
        assert!(owned(&current(&dsh).unwrap()));
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Updated);
        assert_eq!(current(&dsh).unwrap()["command"], "/usr/bin/browse");
        // Settings the user added to our row stay across an update.
        let with_env = std::fs::read_to_string(&file).unwrap().replace("        args: [mcp]\n", "        args: [mcp]\n        env:\n          KEEP: '1'\n");
        std::fs::write(&file, &with_env).unwrap();
        assert_eq!(edit(&dsh, &command("/opt/browse"), false).unwrap(), Edit::Updated);
        let parsed = current(&dsh).unwrap();
        assert_eq!(parsed["command"], "/opt/browse");
        assert_eq!(parsed["env"]["KEEP"], "1");
        // A file that only had our row is removed: dsh treats a missing layer as no layer.
        assert_eq!(edit(&dsh, &command("/opt/browse"), true).unwrap(), Edit::Removed);
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dsh_keeps_comments_and_tags_elsewhere() {
        let dir = temp("dsh-comments");
        let file = dir.join("cordis.patch.yml");
        let original = "# my dsh patches\n# keep every byte of this one\n- insert:\n    - id: memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memory\n        transport: stdio\n        command: engram\n        args: [mcp]\n        cwd: !!js process.cwd()\n";
        std::fs::write(&file, original).unwrap();
        assert_eq!(dsh_patches(original).unwrap().len(), 1);
        let dsh = loc("dsh", file.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text.strip_prefix(original).unwrap(), format!("\n{}", dsh_row("/bin/browse")));
        assert!(text.contains("        cwd: !!js process.cwd()\n"), "{text}");
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Unchanged);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
        // Removal doesn't care about tags in our own row: dropping lines is safe.
        let tagged = dir.join("tagged.yml");
        let original = "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n        cwd: !!js process.cwd()\n";
        std::fs::write(&tagged, original).unwrap();
        let dsh = loc("dsh", tagged.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert!(!tagged.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dsh_empty_files() {
        let dir = temp("dsh-empty");
        // A missing file is created, then removed again.
        let missing = dir.join("missing/cordis.patch.yml");
        let dsh = loc("dsh", missing.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert!(current(&dsh).is_some());
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert!(!missing.exists());
        // So is an empty one.
        let empty = dir.join("empty/cordis.patch.yml");
        std::fs::create_dir_all(empty.parent().unwrap()).unwrap();
        std::fs::write(&empty, "").unwrap();
        let dsh = loc("dsh", empty.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert!(!empty.exists());
        // Leftover comments keep an empty list so dsh can still load the file.
        let comments = dir.join("comments/cordis.patch.yml");
        std::fs::create_dir_all(comments.parent().unwrap()).unwrap();
        std::fs::write(&comments, "# only comments\n").unwrap();
        let dsh = loc("dsh", comments.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        let text = std::fs::read_to_string(&comments).unwrap();
        assert_eq!(text, "# only comments\n[]\n");
        assert_eq!(dsh_patches(&text).unwrap().len(), 0);
        // Comments plus an explicit empty list come back exactly.
        let listed = dir.join("listed/cordis.patch.yml");
        std::fs::create_dir_all(listed.parent().unwrap()).unwrap();
        std::fs::write(&listed, "# mine\n[]\n").unwrap();
        let dsh = loc("dsh", listed.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&listed).unwrap(), "# mine\n[]\n");
        // An empty list with nothing else is replaced, then the file is removed.
        let only = dir.join("only/cordis.patch.yml");
        std::fs::create_dir_all(only.parent().unwrap()).unwrap();
        std::fs::write(&only, "[]\n").unwrap();
        let dsh = loc("dsh", only.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert!(!only.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dsh_update_edits_only_config_values() {
        let dir = temp("dsh-update");
        let file = dir.join("cordis.patch.yml");
        let original = "# top\n- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      # row comment\n      disabled: true\n      note: keep me\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n        env:\n          A: '1'\n";
        std::fs::write(&file, original).unwrap();
        let dsh = loc("dsh", file.clone());
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Updated);
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text, original.replace("command: /bin/browse", "command: /usr/bin/browse"));
        let before: Vec<&str> = original.lines().collect();
        let after: Vec<&str> = text.lines().collect();
        assert_eq!(after.len(), before.len());
        assert_eq!(before.iter().zip(&after).filter(|(before, after)| before != after).count(), 1);
        assert_eq!(current(&dsh).unwrap()["env"]["A"], "1");
        // A row with another id is ours through serverName, and its id stays.
        let custom = dir.join("custom.yml");
        let original = "- insert:\n    - id: my-browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n";
        std::fs::write(&custom, original).unwrap();
        let dsh = loc("dsh", custom.clone());
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Updated);
        let text = std::fs::read_to_string(&custom).unwrap();
        assert!(text.contains("    - id: my-browse\n"), "{text}");
        assert!(text.contains("command: /usr/bin/browse\n"), "{text}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dsh_update_refuses_unsafe_rows() {
        let dir = temp("dsh-unsafe");
        let cases = [
            // The apostrophe must not hide the tag; a rewrite would drop it.
            ("tag", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n        env: {A: it's, B: !!js process.env.X}\n"),
            // Another plugin, even with browse's id and server name.
            ("name", "- insert:\n    - id: browse\n      name: '@deepseek-ai/other-mcp'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n"),
            // A block list would have to be rebuilt.
            ("args", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args:\n          - serve\n"),
            // A command on its own line has no simple value to replace.
            ("block", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command:\n          - x\n        args: [mcp]\n"),
            // A trailing comment on the line we would replace.
            ("comment", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse # old\n        args: [mcp]\n"),
            // A value that continues on a deeper line.
            ("continuation", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/\n          browse\n        args: [mcp]\n"),
        ];
        for (name, original) in cases {
            let file = dir.join(format!("{name}.yml"));
            std::fs::write(&file, original).unwrap();
            let dsh = loc("dsh", file.clone());
            assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Conflict, "{name}");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), original, "{name}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dsh_leaves_foreign_rows() {
        let dir = temp("dsh-foreign");
        let file = dir.join("name.yml");
        let original = "- insert:\n    - id: browse\n      name: '@deepseek-ai/some-other-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: other-tool\n        args: [serve]\n";
        std::fs::write(&file, original).unwrap();
        let dsh = loc("dsh", file.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Conflict);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Conflict);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
        // Our id and plugin, but someone else's command: not ours to change.
        let second = dir.join("ours-other-command.yml");
        std::fs::write(&second, "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: other-tool\n        args: [serve]\n").unwrap();
        let dsh = loc("dsh", second.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Conflict);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Conflict);
        // A nested serverName: browse the finder can't edit must not gain a second row.
        let nested = dir.join("nested.yml");
        let original = "- insert:\n    - id: group\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        - id: nested\n          name: '@deepseek-ai/dsh-mcp-client'\n          config:\n            serverName: browse\n            transport: stdio\n            command: /bin/browse\n            args: [mcp]\n";
        std::fs::write(&nested, original).unwrap();
        let dsh = loc("dsh", nested.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Conflict);
        assert_eq!(std::fs::read_to_string(&nested).unwrap(), original);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dsh_rows_between_others() {
        let dir = temp("dsh-middle");
        let file = dir.join("cordis.patch.yml");
        let other = "- insert:\n    - id: memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memory\n        transport: stdio\n        command: engram\n        args: [mcp]\n";
        let ours = dsh_row("/bin/browse");
        std::fs::write(&file, format!("{ours}{other}")).unwrap();
        let dsh = loc("dsh", file.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), other);
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), format!("{other}\n{ours}"));
        // Our row can share an insert list with another plugin's row.
        let shared = dir.join("shared.yml");
        let memory = "    - id: memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memory\n        transport: stdio\n        command: engram\n        args: [mcp]\n";
        let ours = ours.strip_prefix("- insert:\n").unwrap();
        std::fs::write(&shared, format!("- insert:\n{memory}{ours}")).unwrap();
        let dsh = loc("dsh", shared.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Unchanged);
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Updated);
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&shared).unwrap(), format!("- insert:\n{memory}"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dsh_round_trips_bytes() {
        let dir = temp("dsh-bytes");
        // CRLF stays CRLF.
        let crlf = dir.join("crlf/cordis.patch.yml");
        std::fs::create_dir_all(crlf.parent().unwrap()).unwrap();
        let original = "# c\r\n- insert:\r\n    - id: memory\r\n      name: '@deepseek-ai/dsh-mcp-client'\r\n      config:\r\n        serverName: memory\r\n        transport: stdio\r\n        command: engram\r\n        args: [mcp]\r\n";
        std::fs::write(&crlf, original).unwrap();
        let dsh = loc("dsh", crlf.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&crlf).unwrap();
        assert!(!text.replace("\r\n", "").contains('\n'), "{text:?}");
        assert!(text.contains("\r\n\r\n- insert:\r\n    - id: browse\r\n"), "{text:?}");
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&crlf).unwrap().as_bytes(), original.as_bytes());
        // A file without a trailing newline keeps that too.
        let bare = dir.join("bare/cordis.patch.yml");
        std::fs::create_dir_all(bare.parent().unwrap()).unwrap();
        let original = "# c\n- insert:\n    - id: memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memory\n        transport: stdio\n        command: engram\n        args: [mcp]";
        std::fs::write(&bare, original).unwrap();
        let dsh = loc("dsh", bare.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&bare).unwrap();
        assert_eq!(text.strip_prefix(original).unwrap(), format!("\n{}", dsh_row("/bin/browse")));
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&bare).unwrap().as_bytes(), original.as_bytes());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dsh_home_and_location() {
        let home = Path::new("/home/u");
        assert_eq!(dsh_home(Some("/custom".into()), home), PathBuf::from("/custom"));
        assert_eq!(dsh_home(Some("   ".into()), home), home.join(".dsh"));
        assert_eq!(dsh_home(None, home), home.join(".dsh"));
        let dir = temp("dsh-home");
        assert!(!dsh_location(dir.clone()).installed);
        std::fs::create_dir_all(dir.join("profiles")).unwrap();
        let location = dsh_location(dir.clone());
        assert!(location.installed);
        assert_eq!(location.file, dir.join("cordis.patch.yml"));
        let _ = std::fs::remove_dir_all(dir);
        let patch = temp("dsh-home-patch");
        std::fs::write(patch.join("cordis.patch.yml"), "[]\n").unwrap();
        assert!(dsh_location(patch.clone()).installed);
        let _ = std::fs::remove_dir_all(patch);
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
}
