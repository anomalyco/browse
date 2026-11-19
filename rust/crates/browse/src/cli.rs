//! `browse <tool> [positional]... [--arg value | --json '{...}']`: call any relay tool from a terminal and print its
//! result.

use std::path::PathBuf;

use anyhow::{Context, bail};
use base64::Engine;
use browse_core::{Content, ToolCallRequest, ToolSpec};
use serde_json::{Map, Value};

use crate::{relay, session};

/// Flags the CLI handles itself, for every tool. They may also come before the tool name.
pub const GLOBAL_FLAGS: &[&str] = &["json", "tab", "output"];

/// Options a positional argument fills when no required option is open, in order of preference.
const PRIMARY: &[&str] = &["url", "text", "value", "expression", "key", "values", "files", "message", "action", "to", "within", "selector"];

pub fn list() -> i32 {
    for spec in relay::specs(None) {
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
    // A required enum takes a free word so its own error says what it accepts (`console 12 strat`). The PRIMARY
    // fallback only takes plain options: navigate's action is not required, so `navigate <url> extra` is stray.
    let plain = |key: &str| open(key) && properties.get(key).is_some_and(|schema| schema.get("enum").is_none());
    required(spec).into_iter().find(|key| open(key)).or_else(|| PRIMARY.iter().find(|key| plain(key)).map(|key| (*key).to_owned()))
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
    let mut boolean = false;
    for (name, schema) in properties(spec) {
        let mark = if required.contains(&name) { " (required)" } else { "" };
        let kinds = kinds(&schema);
        let placeholder = if kinds == ["boolean"] {
            boolean = true;
            String::new()
        } else {
            format!(" <{}>", kinds.join("|"))
        };
        println!("  --{name}{placeholder}{mark}\n      {}", schema.get("description").and_then(Value::as_str).unwrap_or_default());
    }
    if !usage.is_empty() {
        println!("\n  Positional values fill {usage} in order (a ref like e12 goes to --ref).");
    }
    println!("\n  --json '<object>'   all arguments as one JSON object\n  --output <path>     where to save images");
    if boolean {
        println!("\n  Boolean options need no value: `--name` turns one on, `--name false` or `--no-name` off.");
    }
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

/// A `--tab` value: a numeric tab id stays a number, anything else is a chosen id like `work-mail`.
fn tab_id(value: &str) -> anyhow::Result<Value> {
    if value.is_empty() {
        bail!("--tab takes a tab id (a number from `browse navigate` or `browse tabs`) or a chosen id like `work-mail`, not {value:?}");
    }
    Ok(match browse_core::tab_argument(&Value::String(value.to_owned()))? {
        browse_core::TabArg::Id(tab) => Value::from(tab),
        browse_core::TabArg::Chosen(chosen) => Value::String(chosen),
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

/// Moves global flags given before the tool name (`browse --tab 12 snapshot`) after it.
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

/// A parsed tool call: its arguments, and where images go (`--output`).
struct ParsedCall {
    arguments: Map<String, Value>,
    output: Option<PathBuf>,
}

enum ParseResult {
    Help,
    Call(ParsedCall),
}

/// Turns a tool's argv into its arguments. `--help` asks for the help text instead of a call.
fn parse(spec: &ToolSpec, args: &[String]) -> anyhow::Result<ParseResult> {
    let name = spec.name.as_str();
    let properties = properties(spec);
    let resolve = |flag: &str| -> anyhow::Result<String> {
        [flag.to_owned(), flag.replace('-', "_"), camel(flag)]
            .into_iter()
            .find(|c| properties.contains_key(c))
            .with_context(|| format!("{name} has no option --{flag}; see `browse {name} --help`"))
    };
    let mut arguments = Map::new();
    let (mut tab, mut output, mut positional) = (None, None, Vec::new());
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
                return Ok(ParseResult::Help);
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
            "json" | "tab" | "output" => {
                let value = inline.or_else(|| take(&mut i)).with_context(|| format!("--{flag} needs a value"))?;
                match flag {
                    "json" => match serde_json::from_str(&value).context("--json must be a JSON object")? {
                        Value::Object(map) => arguments.extend(map),
                        _ => bail!("--json must be a JSON object"),
                    },
                    "tab" => tab = Some(tab_id(&value)?),
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
                // A boolean takes no value, but people write `--keepVisible true`: take a literal word as its value.
                let literal = if boolean && inline.is_none() {
                    args.get(i).filter(|next| matches!(next.as_str(), "true" | "false")).cloned()
                } else {
                    None
                };
                let value = match inline {
                    Some(raw) => coerce(flag, schema, raw)?,
                    None if boolean => match literal {
                        Some(raw) => {
                            i += 1;
                            Value::Bool(raw == "true")
                        }
                        None => Value::Bool(true),
                    },
                    // A non-boolean takes the word after it (`--url https://example.com`), unless that word is
                    // another option (`--url --readOnly`), which leaves the value missing as it was before.
                    None => match take(&mut i) {
                        Some(raw) => coerce(flag, schema, raw)?,
                        None => bail!("--{flag} needs a value; see `browse {name} --help`"),
                    },
                };
                arguments.insert(key, value);
            }
        }
    }
    if let Some(tab) = tab {
        if !properties.contains_key("tab") {
            bail!("{name} doesn't act on a tab; leave out --tab");
        }
        // Before the positionals, so a stray word can't fill `tab` only to be overwritten by --tab below.
        arguments.insert("tab".into(), tab);
    }
    for value in positional {
        let key = slot(spec, &arguments, &value).with_context(|| format!("unexpected argument {value:?}; see `browse {name} --help`"))?;
        let parsed = coerce(&key, &properties[&key], value)?;
        arguments.insert(key, parsed);
    }
    Ok(ParseResult::Call(ParsedCall { arguments, output }))
}

pub fn call(name: &str, args: &[String]) -> anyhow::Result<i32> {
    let specs = relay::specs(None);
    let Some(spec) = specs.iter().find(|s| s.name == name).or_else(|| specs.iter().find(|s| s.name == name.replace('-', "_"))) else {
        eprintln!("Unknown command or tool: {name}. Run `browse --help`.");
        return Ok(2);
    };
    let name = spec.name.as_str();
    let (arguments, output) = match parse(spec, args)? {
        ParseResult::Help => {
            help(spec);
            return Ok(0);
        }
        ParseResult::Call(parsed) => (parsed.arguments, parsed.output),
    };
    check(name, &properties(spec), &arguments)?;
    if let Some(dir) = output.as_ref().and_then(|p| p.parent()).filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("can't create {} for --output", dir.display()))?;
    }
    let request = ToolCallRequest { name: name.into(), arguments: Value::Object(arguments) };
    let result = match relay::call(&request, None) {
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

    fn named(name: &str, schema: Value) -> ToolSpec {
        ToolSpec { name: name.into(), description: String::new(), input_schema: schema }
    }

    fn parse_arguments(spec: &ToolSpec, words: &[&str]) -> anyhow::Result<Map<String, Value>> {
        let args: Vec<String> = words.iter().map(|word| (*word).to_owned()).collect();
        match parse(spec, &args)? {
            ParseResult::Call(parsed) => Ok(parsed.arguments),
            ParseResult::Help => unreachable!("the arguments ask for help"),
        }
    }

    fn navigate() -> ToolSpec {
        named(
            "navigate",
            json!({
                "properties": {
                    "url": { "type": "string" },
                    "action": { "type": "string", "enum": ["goto", "back", "forward", "reload"] },
                    "readOnly": { "type": "boolean" },
                    "keepVisible": { "type": "boolean" },
                    "tab": { "type": ["integer", "string"] }
                },
                "required": []
            }),
        )
    }

    fn snapshot() -> ToolSpec {
        named(
            "snapshot",
            json!({
                "properties": {
                    "within": { "type": "string" },
                    "interactive": { "type": "boolean" },
                    "tab": { "type": ["integer", "string"] }
                },
                "required": ["tab"]
            }),
        )
    }

    fn tabs() -> ToolSpec {
        named(
            "tabs",
            json!({
                "properties": {
                    "action": { "type": "string", "enum": ["list", "new", "close"] },
                    "id": { "type": "string" },
                    "url": { "type": "string" },
                    "readOnly": { "type": "boolean" },
                    "tab": { "type": ["integer", "string"] }
                },
                "required": []
            }),
        )
    }

    fn type_tool() -> ToolSpec {
        named(
            "type",
            json!({
                "properties": {
                    "text": { "type": "string" },
                    "tab": { "type": ["integer", "string"] }
                },
                "required": ["tab", "text"]
            }),
        )
    }

    fn console() -> ToolSpec {
        named(
            "console",
            json!({
                "properties": {
                    "action": { "type": "string", "enum": ["start", "read", "stop"] },
                    "tab": { "type": ["integer", "string"] }
                },
                "required": ["tab", "action"]
            }),
        )
    }

    fn execute() -> ToolSpec {
        named(
            "execute",
            json!({
                "properties": {
                    "code": { "type": "string" },
                    "timeoutMs": { "type": "integer", "minimum": 0 },
                    "tab": { "type": ["integer", "string"] }
                },
                "required": ["code"]
            }),
        )
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
        let tabs = spec(json!({ "properties": { "action": { "enum": ["list", "new", "close"] }, "url": {} }, "required": [] }));
        assert_eq!(slot(&tabs, &Map::new(), "close").as_deref(), Some("action"));
        assert!(looks_like_ref("f1a5") && looks_like_ref("e3") && !looks_like_ref("example") && !looks_like_ref("e"));
    }

    #[test]
    fn boolean_flags_take_a_following_true_or_false() {
        let navigate = navigate();
        let parsed = parse_arguments(&navigate, &["https://example.com", "--keepVisible", "true"]).unwrap();
        assert_eq!(parsed.get("keepVisible"), Some(&json!(true)));
        assert!(!parsed.contains_key("action"));

        let parsed = parse_arguments(&navigate, &["https://example.com", "--keepVisible", "false"]).unwrap();
        assert_eq!(parsed.get("keepVisible"), Some(&json!(false)));

        // A boolean with no literal after it still takes no value: the next word is the URL.
        let parsed = parse_arguments(&navigate, &["--readOnly", "https://example.com"]).unwrap();
        assert_eq!(parsed.get("readOnly"), Some(&json!(true)));
        assert_eq!(parsed.get("url"), Some(&json!("https://example.com")));
    }

    #[test]
    fn option_values_can_be_the_following_word() {
        let navigate = navigate();
        let parsed = parse_arguments(&navigate, &["--url", "https://example.com"]).unwrap();
        assert_eq!(parsed.get("url"), Some(&json!("https://example.com")));

        let tabs = tabs();
        let parsed = parse_arguments(&tabs, &["new", "--id", "probe-tab"]).unwrap();
        assert_eq!(parsed.get("action"), Some(&json!("new")));
        assert_eq!(parsed.get("id"), Some(&json!("probe-tab")));

        let execute = execute();
        let parsed = parse_arguments(&execute, &["--code", "return 1"]).unwrap();
        assert_eq!(parsed.get("code"), Some(&json!("return 1")));

        // A positional after the value still fills its slot.
        let parsed = parse_arguments(&execute, &["--timeoutMs", "8000", "return 1"]).unwrap();
        assert_eq!(parsed.get("timeoutMs"), Some(&json!(8000)));
        assert_eq!(parsed.get("code"), Some(&json!("return 1")));
    }

    #[test]
    fn inline_and_separate_option_values_are_the_same() {
        let navigate = navigate();
        let inline = parse_arguments(&navigate, &["--url=https://example.com"]).unwrap();
        let separate = parse_arguments(&navigate, &["--url", "https://example.com"]).unwrap();
        assert_eq!(inline, separate);

        let execute = execute();
        let inline = parse_arguments(&execute, &["--timeoutMs=8000", "return 1"]).unwrap();
        let separate = parse_arguments(&execute, &["--timeoutMs", "8000", "return 1"]).unwrap();
        assert_eq!(inline, separate);
    }

    #[test]
    fn an_option_at_the_end_without_a_value_still_errors() {
        let navigate = navigate();
        let error = parse_arguments(&navigate, &["--url"]).unwrap_err().to_string();
        assert!(error.contains("--url needs a value"), "{error}");

        // Another option can't be the value.
        let error = parse_arguments(&navigate, &["--url", "--readOnly"]).unwrap_err().to_string();
        assert!(error.contains("--url needs a value"), "{error}");
    }

    #[test]
    fn stray_positionals_are_unexpected_arguments() {
        let navigate = navigate();
        let error = parse_arguments(&navigate, &["https://example.com", "extra"]).unwrap_err().to_string();
        assert!(error.contains("unexpected argument \"extra\""), "{error}");
        assert!(!error.contains("--action"), "{error}");
    }

    #[test]
    fn positional_enum_values_and_tabs_still_fill() {
        let navigate = navigate();
        let parsed = parse_arguments(&navigate, &["https://example.com", "back"]).unwrap();
        assert_eq!(parsed.get("url"), Some(&json!("https://example.com")));
        assert_eq!(parsed.get("action"), Some(&json!("back")));

        let parsed = parse_arguments(&navigate, &["--tab", "12", "back"]).unwrap();
        assert_eq!(parsed.get("tab"), Some(&json!(12)));
        assert_eq!(parsed.get("action"), Some(&json!("back")));

        let tabs = tabs();
        let parsed = parse_arguments(&tabs, &["close", "--tab", "12"]).unwrap();
        assert_eq!(parsed.get("action"), Some(&json!("close")));
        assert_eq!(parsed.get("tab"), Some(&json!(12)));

        let snapshot = snapshot();
        let parsed = parse_arguments(&snapshot, &["12"]).unwrap();
        assert_eq!(parsed.get("tab"), Some(&json!(12)));
    }

    #[test]
    fn a_given_tab_is_never_filled_by_a_positional() {
        let snapshot = snapshot();
        // `main` can't take `tab` when --tab is already there; it lands in the next positional slot, `within`.
        let parsed = parse_arguments(&snapshot, &["--tab", "12", "main"]).unwrap();
        assert_eq!(parsed.get("tab"), Some(&json!(12)));
        assert_eq!(parsed.get("within"), Some(&json!("main")));

        let parsed = parse_arguments(&snapshot, &["--tab", "12", "--interactive", "true"]).unwrap();
        assert_eq!(parsed.get("interactive"), Some(&json!(true)));
        assert_eq!(parsed.get("tab"), Some(&json!(12)));
        assert!(!parsed.contains_key("within"));

        let parsed = parse_arguments(&snapshot, &["12", "--interactive", "true"]).unwrap();
        assert_eq!(parsed.get("interactive"), Some(&json!(true)));
        assert_eq!(parsed.get("tab"), Some(&json!(12)));
        assert!(!parsed.contains_key("within"));
    }

    #[test]
    fn required_options_take_free_words_even_for_enums() {
        let type_tool = type_tool();
        let parsed = parse_arguments(&type_tool, &["--tab", "12", "hello"]).unwrap();
        assert_eq!(parsed.get("tab"), Some(&json!(12)));
        assert_eq!(parsed.get("text"), Some(&json!("hello")));

        let console = console();
        let error = parse_arguments(&console, &["12", "strat"]).unwrap_err().to_string();
        assert!(error.contains("--action is one of"), "{error}");

        let parsed = parse_arguments(&console, &["12", "start"]).unwrap();
        assert_eq!(parsed.get("tab"), Some(&json!(12)));
        assert_eq!(parsed.get("action"), Some(&json!("start")));
    }

    #[test]
    fn tabs_new_takes_a_boolean_after_its_url() {
        let parsed = parse_arguments(&tabs(), &["new", "https://example.com", "--readOnly", "true"]).unwrap();
        assert_eq!(parsed.get("action"), Some(&json!("new")));
        assert_eq!(parsed.get("url"), Some(&json!("https://example.com")));
        assert_eq!(parsed.get("readOnly"), Some(&json!(true)));
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
    fn tab_flag_keeps_numbers_and_passes_chosen_ids() {
        assert_eq!(tab_id("12").unwrap(), json!(12));
        assert_eq!(tab_id("633559866").unwrap(), json!(633559866));
        assert_eq!(tab_id("work-mail").unwrap(), json!("work-mail"));
        assert!(tab_id("").is_err());
        assert!(tab_id("12a").is_err(), "not a number, and not a chosen id either");
        assert!(tab_id("-5").is_err(), "tab ids aren't negative");
        assert!(tab_id(" 12 ").is_err(), "no whitespace tolerance");
        assert!(tab_id("99999999999999999999").is_err(), "too large for a tab id");
    }

    #[test]
    fn globals_before_the_tool() {
        let args: Vec<String> = ["--tab", "12", "--output=a.png", "screenshot"].map(String::from).to_vec();
        let (globals, rest) = split_globals(&args);
        assert_eq!(globals, ["--tab", "12", "--output=a.png"]);
        assert_eq!(rest, ["screenshot"]);
    }
}
