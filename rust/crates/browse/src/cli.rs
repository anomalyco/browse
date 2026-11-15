//! `browse <tool> [positional]... [--arg value | --json '{...}']`: call any relay tool from a terminal and print its
//! result.

use std::path::PathBuf;

use anyhow::{Context, bail};
use base64::Engine;
use browse_core::{Content, ToolCallRequest, ToolSpec};
use serde_json::{Map, Value};

use crate::{relay, session};

/// Flags the CLI handles itself, for every tool. They may also come before the tool name.
pub const GLOBAL_FLAGS: &[&str] = &["json", "session", "output"];

/// Options a positional argument fills when no required option is open, in order of preference.
const PRIMARY: &[&str] = &["url", "text", "value", "expression", "key", "values", "files", "message", "action", "to", "within", "selector"];

pub fn list() -> i32 {
    for spec in relay::specs() {
        let first = spec.description.lines().next().unwrap_or_default();
        let summary = first.split_once(". ").map_or(first, |(sentence, _)| sentence);
        println!("  {:<18} {summary}", spec.name);
    }
    0
}

fn properties(spec: &ToolSpec) -> Map<String, Value> {
    spec.input_schema.get("properties").and_then(Value::as_object).cloned().unwrap_or_default()
}

fn required(spec: &ToolSpec) -> Vec<String> {
    spec.input_schema.get("required").and_then(Value::as_array).map(|r| r.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

fn camel(kebab: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in kebab.chars() {
        if c == '-' || c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// A snapshot ref: "e12", or "a5" / "f1a5" from an aria snapshot.
fn looks_like_ref(value: &str) -> bool {
    let body = match value.strip_prefix('f') {
        Some(rest) if rest.starts_with(|c: char| c.is_ascii_digit()) => rest.trim_start_matches(|c: char| c.is_ascii_digit()),
        _ => value,
    };
    let mut chars = body.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase()) && !chars.as_str().is_empty() && chars.all(|c| c.is_ascii_digit())
}

/// The option a positional value fills: a ref-looking value goes to `ref`, else the first open required option,
/// else the tool's primary option.
fn slot(spec: &ToolSpec, arguments: &Map<String, Value>, value: &str) -> Option<String> {
    let properties = properties(spec);
    let open = |key: &str| properties.contains_key(key) && !arguments.contains_key(key);
    if looks_like_ref(value) && open("ref") {
        return Some("ref".into());
    }
    // A word naming one of an enum option's values (`browse tabs close`) fills that option.
    if let Some(key) = properties.iter().find(|(key, schema)| open(key) && schema["enum"].as_array().is_some_and(|values| values.iter().any(|v| v == value))).map(|(key, _)| key.clone()) {
        return Some(key);
    }
    required(spec).into_iter().find(|key| open(key)).or_else(|| PRIMARY.iter().find(|key| open(key)).map(|key| (*key).to_owned()))
}

/// What `browse <tool> --help` shows as the positional form.
fn usage(spec: &ToolSpec) -> String {
    let properties = properties(spec);
    let mut slots: Vec<String> = required(spec).into_iter().map(|key| format!("<{key}>")).collect();
    if slots.is_empty() {
        if properties.contains_key("ref") {
            slots.push("[ref]".into());
        }
        if let Some(primary) = PRIMARY.iter().find(|key| properties.contains_key(**key)) {
            slots.push(format!("[{primary}]"));
        }
    }
    slots.join(" ")
}

fn help(spec: &ToolSpec) {
    let usage = usage(spec);
    println!("browse {}{}{} [options]\n\n{}\n", spec.name, if usage.is_empty() { "" } else { " " }, usage, spec.description);
    let required = required(spec);
    for (name, schema) in properties(spec) {
        let mark = if required.contains(&name) { " (required)" } else { "" };
        println!("  --{name} <{}>{mark}\n      {}", kinds(&schema).join("|"), schema.get("description").and_then(Value::as_str).unwrap_or_default());
    }
    if !usage.is_empty() {
        println!("\n  Positional values fill {usage} in order (a ref like e12 goes to --ref).");
    }
    let session = if spec.name == "session" { "the session to act on (same as --id)" } else { "run in this existing session" };
    println!("\n  --json '<object>'   all arguments as one JSON object\n  --session <id>      {session}\n  --output <path>     where to save images");
}

fn variants(schema: &Value) -> Vec<&Value> {
    match schema.get("anyOf").or_else(|| schema.get("oneOf")).and_then(Value::as_array) {
        Some(list) => list.iter().collect(),
        None => vec![schema],
    }
}

fn types(schema: &Value) -> Vec<&str> {
    match schema.get("type") {
        Some(Value::String(kind)) => vec![kind.as_str()],
        Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

fn kinds(schema: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for variant in variants(schema) {
        for kind in types(variant) {
            if !out.iter().any(|k| k == kind) {
                out.push(kind.to_owned());
            }
        }
    }
    if out.is_empty() {
        out.push("json".into());
    }
    out
}

fn matches(schema: &Value, value: &Value) -> bool {
    variants(schema).into_iter().any(|variant| {
        let kinds = types(variant);
        let typed = kinds.is_empty()
            || kinds.iter().any(|kind| match *kind {
                "string" => value.is_string(),
                "integer" => value.is_i64() || value.is_u64(),
                "number" => value.is_number(),
                "boolean" => value.is_boolean(),
                "array" => value.is_array(),
                "object" => value.is_object(),
                "null" => value.is_null(),
                _ => true,
            });
        let listed = variant.get("enum").and_then(Value::as_array).is_none_or(|options| options.contains(value));
        typed && listed
    })
}

/// A command-line value for an option with `schema`: JSON when that fits the schema, else the raw string when a
/// string fits, else an error naming what the option takes.
fn coerce(key: &str, schema: &Value, raw: String) -> anyhow::Result<Value> {
    if let Ok(parsed) = serde_json::from_str::<Value>(&raw)
        && matches(schema, &parsed)
    {
        return Ok(parsed);
    }
    let text = Value::String(raw);
    if matches(schema, &text) {
        return Ok(text);
    }
    let raw = text.as_str().unwrap_or_default();
    let options: Vec<String> = variants(schema).iter().filter_map(|v| v.get("enum")?.as_array()).flatten().map(|v| v.to_string()).collect();
    if options.is_empty() {
        bail!("--{key} takes {}, not {raw:?}", kinds(schema).join(" or "));
    }
    bail!("--{key} is one of {}, not {raw:?}", options.join(", "));
}

fn check(name: &str, properties: &Map<String, Value>, arguments: &Map<String, Value>) -> anyhow::Result<()> {
    for (key, value) in arguments {
        if let Some(schema) = properties.get(key)
            && !matches(schema, value)
        {
            bail!("{name}: {key} takes {}, not {value}; see `browse {name} --help`", kinds(schema).join(" or "));
        }
    }
    Ok(())
}

/// Moves global flags given before the tool name (`browse --session x navigate ...`) after it.
pub fn split_globals(args: &[String]) -> (Vec<String>, Vec<String>) {
    let mut globals = Vec::new();
    let mut i = 0;
    while let Some(flag) = args.get(i).and_then(|a| a.strip_prefix("--")) {
        let name = flag.split_once('=').map_or(flag, |(name, _)| name);
        if !GLOBAL_FLAGS.contains(&name) {
            break;
        }
        globals.push(args[i].clone());
        i += 1;
        if !flag.contains('=')
            && let Some(value) = args.get(i)
        {
            globals.push(value.clone());
            i += 1;
        }
    }
    (globals, args[i..].to_vec())
}

pub fn call(name: &str, args: &[String]) -> anyhow::Result<i32> {
    let specs = relay::specs();
    let Some(spec) = specs.iter().find(|s| s.name == name).or_else(|| specs.iter().find(|s| s.name == name.replace('-', "_"))) else {
        eprintln!("Unknown command or tool: {name}. Run `browse --help`.");
        return Ok(2);
    };
    let name = spec.name.as_str();
    let properties = properties(spec);
    let resolve = |flag: &str| -> anyhow::Result<String> {
        [flag.to_owned(), flag.replace('-', "_"), camel(flag)]
            .into_iter()
            .find(|c| properties.contains_key(c))
            .with_context(|| format!("{name} has no option --{flag}; see `browse {name} --help`"))
    };
    let mut arguments = Map::new();
    let (mut session, mut output, mut positional) = (None, None, Vec::new());
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        i += 1;
        let Some(flag) = arg.strip_prefix("--").filter(|f| !f.is_empty()) else {
            positional.push(arg.clone());
            continue;
        };
        let (flag, inline) = match flag.split_once('=') {
            Some((f, v)) => (f, Some(v.to_owned())),
            None => (flag, None),
        };
        // A value may itself start with "-" (`--deltaY -200`), but not with "--".
        let take = |i: &mut usize| -> Option<String> {
            let next = args.get(*i).filter(|n| !n.starts_with("--")).cloned();
            if next.is_some() {
                *i += 1;
            }
            next
        };
        match flag {
            "help" | "h" => {
                help(spec);
                return Ok(0);
            }
            // `browse execute --file script.js` (or `-` for stdin).
            "file" if name == "execute" && !properties.contains_key("file") => {
                let path = inline.or_else(|| take(&mut i)).context("--file needs a path")?;
                let code = if path == "-" {
                    let mut code = String::new();
                    std::io::Read::read_to_string(&mut std::io::stdin(), &mut code).context("can't read the code from stdin")?;
                    code
                } else {
                    std::fs::read_to_string(&path).with_context(|| format!("can't read {path}"))?
                };
                arguments.insert("code".into(), Value::String(code));
            }
            "json" | "session" | "output" => {
                let value = inline.or_else(|| take(&mut i)).with_context(|| format!("--{flag} needs a value"))?;
                match flag {
                    "json" => match serde_json::from_str(&value).context("--json must be a JSON object")? {
                        Value::Object(map) => arguments.extend(map),
                        _ => bail!("--json must be a JSON object"),
                    },
                    "session" => session = Some(value),
                    _ => output = Some(PathBuf::from(value)),
                }
            }
            _ => {
                if let Some(negated) = flag.strip_prefix("no-").filter(|_| inline.is_none())
                    && let Ok(key) = resolve(negated)
                {
                    arguments.insert(key, Value::Bool(false));
                    continue;
                }
                let key = resolve(flag)?;
                let schema = &properties[&key];
                let boolean = kinds(schema) == ["boolean"];
                let value = match inline.or_else(|| if boolean { None } else { take(&mut i) }) {
                    None if boolean => Value::Bool(true),
                    None => bail!("--{flag} needs a value; see `browse {name} --help`"),
                    Some(raw) => coerce(flag, schema, raw)?,
                };
                arguments.insert(key, value);
            }
        }
    }
    for value in positional {
        let key = slot(spec, &arguments, &value).with_context(|| format!("unexpected argument {value:?}; see `browse {name} --help`"))?;
        let parsed = coerce(&key, &properties[&key], value)?;
        arguments.insert(key, parsed);
    }
    // `--session` never creates a session: for the session tool it names the session to act on; any other call runs
    // in that session when the relay has it.
    if let Some(id) = session {
        let key = if name == "session" { "id" } else { "session" };
        match arguments.get(key).and_then(Value::as_str) {
            Some(other) if other != id => bail!("--session {id} conflicts with --{key} {other}"),
            _ => {
                arguments.insert(key.into(), Value::String(id));
            }
        }
    }
    check(name, &properties, &arguments)?;
    if let Some(dir) = output.as_ref().and_then(|p| p.parent()).filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("can't create {} for --output", dir.display()))?;
    }
    let request = ToolCallRequest { name: name.into(), arguments: Value::Object(arguments), session: session::for_cli() };
    let result = match relay::call(&request) {
        Ok(result) => result,
        Err(error) => {
            eprintln!("browse: {error:#}");
            return Ok(4);
        }
    };
    let mut images = 0;
    for content in &result.content {
        match content {
            Content::Text { text } => println!("{text}"),
            Content::Image { data, mime_type } => {
                let ext = mime_type.rsplit('/').next().unwrap_or("png").replace("jpeg", "jpg");
                let file = match &output {
                    Some(path) if images == 0 => path.clone(),
                    Some(path) => path.with_extension(format!("{images}.{ext}")),
                    None => {
                        let dir = std::env::temp_dir().join("browse");
                        std::fs::create_dir_all(&dir).with_context(|| format!("can't create {}", dir.display()))?;
                        dir.join(format!("{name}-{:x}.{ext}", session::random_u64() as u32))
                    }
                };
                let bytes = base64::engine::general_purpose::STANDARD.decode(data).context("bad image data")?;
                std::fs::write(&file, bytes).with_context(|| format!("can't write {}", file.display()))?;
                println!("{}", file.display());
                images += 1;
            }
        }
    }
    Ok(i32::from(result.is_error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec(schema: Value) -> ToolSpec {
        ToolSpec { name: "t".into(), description: String::new(), input_schema: schema }
    }

    #[test]
    fn positionals() {
        let navigate = spec(json!({ "properties": { "url": { "type": "string" }, "action": { "type": "string" } }, "required": [] }));
        assert_eq!(slot(&navigate, &Map::new(), "https://example.com").as_deref(), Some("url"));
        let fill = spec(json!({ "properties": { "ref": {}, "selector": {}, "value": { "type": "string" } }, "required": [] }));
        let mut args = Map::new();
        assert_eq!(slot(&fill, &args, "e12").as_deref(), Some("ref"));
        args.insert("ref".into(), json!("e12"));
        assert_eq!(slot(&fill, &args, "hello").as_deref(), Some("value"));
        let session = spec(json!({ "properties": { "action": {}, "id": {} }, "required": ["action"] }));
        assert_eq!(slot(&session, &Map::new(), "list").as_deref(), Some("action"));
        assert!(looks_like_ref("f1a5") && looks_like_ref("e3") && !looks_like_ref("example") && !looks_like_ref("e"));
    }

    #[test]
    fn coercion() {
        let integer = json!({ "type": "integer" });
        assert_eq!(coerce("timeout", &integer, "500".into()).unwrap(), json!(500));
        assert!(coerce("timeout", &integer, "abc".into()).is_err());
        assert!(coerce("timeout", &integer, "1.5".into()).is_err());
        let string = json!({ "type": "string" });
        assert_eq!(coerce("text", &string, "42".into()).unwrap(), json!("42"));
        let either = json!({ "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }] });
        assert_eq!(coerce("key", &either, "[\"a\"]".into()).unwrap(), json!(["a"]));
        let choice = json!({ "type": "string", "enum": ["load", "settle"] });
        assert!(coerce("waitUntil", &choice, "soon".into()).is_err());
        assert!(coerce("flag", &json!({ "type": "boolean" }), "maybe".into()).is_err());
    }

    #[test]
    fn globals_before_the_tool() {
        let args: Vec<String> = ["--session", "x", "--output=a.png", "navigate", "u"].map(String::from).to_vec();
        let (globals, rest) = split_globals(&args);
        assert_eq!(globals, ["--session", "x", "--output=a.png"]);
        assert_eq!(rest, ["navigate", "u"]);
    }
}
