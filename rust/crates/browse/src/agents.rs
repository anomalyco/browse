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
    // dsh's home: $DSH_HOME when set to something other than blank, else ~/.dsh (dsh-home-paths).
    let dsh = env("DSH_HOME").filter(|home| !home.to_string_lossy().trim().is_empty()).unwrap_or_else(|| at(".dsh"));
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
        loc("dsh", dsh.join("cordis.patch.yml"), Some("dsh"), None, Some(vec![dsh.clone()])),
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
        crate::setup::write_keeping_mode(file, after.as_bytes())?;
    }
    Ok(outcome)
}

fn kind(name: &str) -> &'static str {
    match format(name) {
        Format::Json(_) => "JSON",
        Format::Toml | Format::TomlList => "TOML",
        Format::Yaml(_) => "YAML",
        Format::Dsh => "YAML",
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

/// The dsh MCP plugin, and the row id browse uses in dsh's Cordis patch files.
const DSH_CLIENT: &str = "@deepseek-ai/dsh-mcp-client";

/// A dsh patch file's rows: a top-level YAML list of patch entries, where an empty or comment-only file is an empty list.
fn dsh_patches(text: &str) -> anyhow::Result<Vec<serde_yaml::Value>> {
    let value: serde_yaml::Value = if text.trim().is_empty() { serde_yaml::Value::Null } else { serde_yaml::from_str(text)? };
    match value {
        serde_yaml::Value::Null => Ok(Vec::new()),
        serde_yaml::Value::Sequence(rows) if rows.iter().all(serde_yaml::Value::is_mapping) => Ok(rows),
        _ => bail!("not a top-level YAML list of patch entries"),
    }
}

/// Whether an inserted dsh row is the browse server: our id, or the `serverName` its tools are named after.
fn dsh_named(row: &serde_yaml::Value) -> bool {
    row.get("id").and_then(serde_yaml::Value::as_str) == Some("browse")
        || row.get("config").and_then(|config| config.get("serverName")).and_then(serde_yaml::Value::as_str) == Some("browse")
}

/// Whether the row's own text contains a YAML tag such as `!!js`, which the YAML value API drops and a rewrite would
/// lose. Tags elsewhere in the file are safe: browse only splices lines, it never re-serializes the file.
fn yaml_tagged_text(text: &str) -> bool {
    text.lines().any(|line| {
        let mut quote = None;
        let mut previous = ' ';
        for character in line.chars() {
            match quote {
                Some(end) => quote = (character != end).then_some(end),
                None => match character {
                    '\'' | '"' => quote = Some(character),
                    '#' if previous.is_whitespace() => break,
                    '!' if previous.is_whitespace() || previous == '[' || previous == ',' => return true,
                    _ => {}
                },
            }
            previous = character;
        }
        false
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

/// The lines of the inserted browse row: a nested `- ` item under an `insert:` patch, which is how dsh's own examples
/// and dsh's config tools write them.
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

/// browse's config as a dsh mcp-client row mapping: the fields dsh needs, in a readable order, then anything else the
/// user added to our row.
fn dsh_config(server: &Value) -> anyhow::Result<serde_yaml::Mapping> {
    let known = ["serverName", "transport", "command", "args"];
    let mut config = serde_yaml::Mapping::new();
    for key in known {
        if let Some(value) = server.get(key) {
            config.insert(key.into(), serde_yaml::to_value(value)?);
        }
    }
    for (key, value) in server.as_object().into_iter().flatten() {
        if !known.contains(&key.as_str()) {
            config.insert(key.as_str().into(), serde_yaml::to_value(value)?);
        }
    }
    Ok(config)
}

fn dsh_row(server: &Value) -> anyhow::Result<serde_yaml::Value> {
    let mut row = serde_yaml::Mapping::new();
    row.insert("id".into(), "browse".into());
    row.insert("name".into(), DSH_CLIENT.into());
    row.insert("config".into(), serde_yaml::Value::Mapping(dsh_config(server)?));
    Ok(serde_yaml::Value::Mapping(row))
}

/// One YAML value on one line, for a scalar or a flow list.
fn yaml_scalar(value: &serde_yaml::Value) -> String {
    let text = serde_yaml::to_string(value).unwrap_or_default();
    let text = text.trim_end_matches('\n');
    if text.contains('\n') {
        return match value {
            serde_yaml::Value::String(text) => serde_json::to_string(text).unwrap_or_default(),
            _ => "null".to_owned(),
        };
    }
    text.to_owned()
}

/// The browse row's lines at `indent`, in dsh's MCP example shape.
fn dsh_lines(server: &Value, indent: usize) -> anyhow::Result<Vec<String>> {
    let pad = " ".repeat(indent);
    let name = yaml_scalar(&serde_yaml::Value::String(DSH_CLIENT.to_owned()));
    let mut lines = vec![format!("{pad}- id: browse"), format!("{pad}  name: {name}"), format!("{pad}  config:")];
    for (key, value) in &dsh_config(server)? {
        let key = key.as_str().unwrap_or_default();
        match value {
            serde_yaml::Value::Sequence(items)
                if items.iter().all(|item| !matches!(item, serde_yaml::Value::Sequence(_) | serde_yaml::Value::Mapping(_) | serde_yaml::Value::Tagged(_))) =>
            {
                let items: Vec<String> = items.iter().map(yaml_scalar).collect();
                lines.push(format!("{pad}    {key}: [{}]", items.join(", ")));
            }
            serde_yaml::Value::Sequence(_) | serde_yaml::Value::Mapping(_) => {
                lines.push(format!("{pad}    {key}:"));
                let block = serde_yaml::to_string(value)?;
                lines.extend(block.trim_end_matches('\n').lines().map(|line| format!("{pad}      {line}")));
            }
            value => lines.push(format!("{pad}    {key}: {}", yaml_scalar(value))),
        }
    }
    Ok(lines)
}

/// Appends a patch row as text, so the rest of the file stays byte-for-byte as the user wrote it. An explicit `[]` can't
/// be followed by block items, so that empty list is replaced by the new patch.
fn dsh_append(before: &str, block: &[String], empty: bool) -> String {
    let block = block.join("\n");
    let lines: Vec<&str> = before.lines().collect();
    if empty && let Some(at) = lines.iter().position(|line| line.trim() == "[]" && indent_of(line) == 0) {
        let mut out: Vec<String> = lines.iter().map(|line| (*line).to_owned()).collect();
        out.splice(at..=at, block.lines().map(str::to_owned));
        return out.join("\n") + "\n";
    }
    let mut after = before.to_owned();
    if !after.is_empty() {
        if !after.ends_with('\n') {
            after.push('\n');
        }
        after.push('\n');
    }
    after.push_str(&block);
    after.push('\n');
    after
}

/// Adds, replaces or removes browse's row in a dsh Cordis patch layer by splicing lines, then checks that the result
/// parses to exactly the old list with that one row changed.
fn edit_dsh(before: &str, expected: &Value, remove: bool) -> anyhow::Result<(Option<String>, Edit)> {
    let invalid = || anyhow::anyhow!("isn't a dsh patch file browse can edit safely; add the browse entry by hand");
    let patches = dsh_patches(before).map_err(|_| invalid())?;
    let found = dsh_find(&patches).map_err(|_| invalid())?;
    let current = found.map(|(patch, row)| {
        serde_json::to_value(&patches[patch]["insert"][row]["config"]).unwrap_or(Value::Null)
    });
    let (outcome, change) = decide(current.as_ref(), expected, remove);
    let Some(server) = change else { return Ok((None, outcome)) };
    let lines: Vec<&str> = before.lines().collect();
    let span = match found {
        Some(_) => Some(dsh_span(&lines).map_err(|_| invalid())?),
        None => None,
    };
    if let Some((start, end)) = span && yaml_tagged_text(&lines[start..end].join("\n")) {
        return Ok((None, Edit::Conflict));
    }
    let (start, end) = span.unwrap_or((0, 0));
    let mut wanted = patches.clone();
    let after = match (found, &server, remove) {
        (None, Some(server), false) => {
            let mut patch = serde_yaml::Mapping::new();
            patch.insert("insert".into(), serde_yaml::Value::Sequence(vec![dsh_row(server)?]));
            wanted.push(serde_yaml::Value::Mapping(patch));
            let mut block = vec!["- insert:".to_owned()];
            block.extend(dsh_lines(server, 4)?);
            dsh_append(before, &block, patches.is_empty())
        }
        (Some((patch, _)), None, true) if patches[patch]["insert"].as_sequence().is_some_and(|insert| insert.len() == 1) => {
            let (parent, parent_end) = dsh_parent(&lines, start).map_err(|_| invalid())?;
            let mut out: Vec<String> = lines.iter().map(|line| (*line).to_owned()).collect();
            let from = if parent > 0 && out[parent - 1].trim().is_empty() { parent - 1 } else { parent };
            out.drain(from..parent_end);
            wanted.remove(patch);
            if out.is_empty() { String::new() } else { out.join("\n") + "\n" }
        }
        (Some((patch, row)), None, true) => {
            let mut out: Vec<String> = lines.iter().map(|line| (*line).to_owned()).collect();
            out.drain(start..end);
            if let Some(insert) = wanted[patch]["insert"].as_sequence_mut() {
                insert.remove(row);
            }
            out.join("\n") + "\n"
        }
        (Some((patch, row)), Some(server), false) => {
            let replacement = dsh_row(server)?;
            let mut out: Vec<String> = lines.iter().map(|line| (*line).to_owned()).collect();
            out.splice(start..end, dsh_lines(server, indent_of(lines[start]))?);
            if let Some(insert) = wanted[patch]["insert"].as_sequence_mut() {
                insert[row] = replacement;
            }
            out.join("\n") + "\n"
        }
        _ => return Err(invalid()),
    };
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
            serde_json::to_value(patches[patch]["insert"][row].get("config")?).ok()
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

    #[test]
    fn dsh_patch_file() {
        let dir = temp("dsh");
        let dsh = loc("dsh", dir.join("dsh/cordis.patch.yml"));
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(
            std::fs::read_to_string(&dsh.file).unwrap(),
            "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n"
        );
        let text = std::fs::read_to_string(&dsh.file).unwrap();
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Unchanged);
        assert_eq!(std::fs::read_to_string(&dsh.file).unwrap(), text);
        assert_eq!(current(&dsh).unwrap()["serverName"], "browse");
        assert!(owned(&current(&dsh).unwrap()));
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Updated);
        assert_eq!(current(&dsh).unwrap()["command"], "/usr/bin/browse");
        // Settings the user added to our row stay across an update.
        let with_env = std::fs::read_to_string(&dsh.file).unwrap().replace("        args: [mcp]\n", "        args: [mcp]\n        env:\n          KEEP: '1'\n");
        std::fs::write(&dsh.file, with_env).unwrap();
        assert_eq!(edit(&dsh, &command("/opt/browse"), false).unwrap(), Edit::Updated);
        let parsed = current(&dsh).unwrap();
        assert_eq!(parsed["command"], "/opt/browse");
        assert_eq!(parsed["env"]["KEEP"], "1");
        // A file that only had our row goes back to nothing.
        assert_eq!(edit(&dsh, &command("/opt/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&dsh.file).unwrap(), "");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dsh_keeps_comments_and_tags() {
        let dir = temp("dsh-comments");
        let file = dir.join("cordis.patch.yml");
        let original = "# my dsh patches\n# keep every byte of this one\n- insert:\n    - id: memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memory\n        transport: stdio\n        command: engram\n        args: [mcp]\n        cwd: !!js process.cwd()\n";
        std::fs::write(&file, original).unwrap();
        assert_eq!(dsh_patches(original).unwrap().len(), 1);
        let dsh = loc("dsh", file.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&file).unwrap();
        let expected = "\n- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n";
        assert_eq!(text.strip_prefix(original).unwrap(), expected);
        assert!(text.contains("        cwd: !!js process.cwd()\n"), "{text}");
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Unchanged);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dsh_empty_files() {
        let dir = temp("dsh-empty");
        let comment = dir.join("comment/cordis.patch.yml");
        std::fs::create_dir_all(comment.parent().unwrap()).unwrap();
        std::fs::write(&comment, "# only comments\n").unwrap();
        let dsh = loc("dsh", comment.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert!(current(&dsh).is_some());
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&comment).unwrap(), "# only comments\n");
        // An explicit empty list can't be followed by block rows, so the row takes its place.
        let list = dir.join("list/cordis.patch.yml");
        std::fs::create_dir_all(list.parent().unwrap()).unwrap();
        std::fs::write(&list, "# mine\n[]\n").unwrap();
        let dsh = loc("dsh", list.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&list).unwrap();
        assert!(text.starts_with("# mine\n- insert:\n"), "{text}");
        assert!(owned(&current(&dsh).unwrap()));
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&list).unwrap(), "# mine\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dsh_leaves_foreign_rows() {
        let dir = temp("dsh-foreign");
        let file = dir.join("cordis.patch.yml");
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
        // A hand-written expression in our row isn't ours to rewrite either.
        let tagged = dir.join("tagged.yml");
        let original = "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n        cwd: !!js process.cwd()\n";
        std::fs::write(&tagged, original).unwrap();
        let dsh = loc("dsh", tagged.clone());
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Conflict);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Conflict);
        assert_eq!(std::fs::read_to_string(&tagged).unwrap(), original);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dsh_rows_between_others() {
        let dir = temp("dsh-middle");
        let file = dir.join("cordis.patch.yml");
        let other = "- insert:\n    - id: memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memory\n        transport: stdio\n        command: engram\n        args: [mcp]\n";
        let ours = "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n";
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
    fn dsh_home_override() {
        let dir = temp("dsh-home");
        // SAFETY: DSH_HOME is read by locations() and this is the only test that sets it.
        unsafe { std::env::set_var("DSH_HOME", &dir) };
        let dsh = locations(Path::new("/nonexistent/opencode.json"), None).into_iter().find(|location| location.name == "dsh").unwrap();
        unsafe { std::env::remove_var("DSH_HOME") };
        assert_eq!(dsh.file, dir.join("cordis.patch.yml"));
        assert!(dsh.installed);
        let _ = std::fs::remove_dir_all(dir);
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
