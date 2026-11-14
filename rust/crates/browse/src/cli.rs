//! `browse <tool> [--arg value | --json '{...}']`: call any relay tool from a terminal and print its result.

use std::path::PathBuf;

use anyhow::{Context, bail};
use base64::Engine;
use browse_core::{Content, ToolCallRequest, ToolSpec};
use serde_json::{Map, Value};

use crate::{relay, session};

pub fn list() -> i32 {
    for spec in relay::specs() {
        let first = spec.description.lines().next().unwrap_or_default();
        let summary = first.split_once(". ").map_or(first, |(sentence, _)| sentence);
        println!("  {:<18} {summary}", spec.name);
    }
    0
}

fn property_names(spec: &ToolSpec) -> Vec<String> {
    spec.input_schema.get("properties").and_then(Value::as_object).map(|p| p.keys().cloned().collect()).unwrap_or_default()
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

fn help(spec: &ToolSpec) {
    println!("browse {} [options]\n\n{}\n", spec.name, spec.description);
    let required: Vec<&str> = spec.input_schema.get("required").and_then(Value::as_array).map(|r| r.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    if let Some(properties) = spec.input_schema.get("properties").and_then(Value::as_object) {
        for (name, schema) in properties {
            let kind = schema.get("type").and_then(Value::as_str).unwrap_or("json");
            let mark = if required.contains(&name.as_str()) { " (required)" } else { "" };
            println!("  --{name} <{kind}>{mark}\n      {}", schema.get("description").and_then(Value::as_str).unwrap_or_default());
        }
    }
    println!("\n  --json '<object>'   all arguments as one JSON object\n  --session <id>      run in another session\n  --output <path>     where to save images");
}

pub fn call(name: &str, args: &[String]) -> anyhow::Result<i32> {
    let spec = relay::specs().into_iter().find(|s| s.name == name);
    if spec.is_none() {
        eprintln!("Unknown command or tool: {name}. Run `browse --help`.");
        return Ok(2);
    }
    let properties = spec.as_ref().map(property_names).unwrap_or_default();
    let schema_type = |key: &str| spec.as_ref().and_then(|s| s.input_schema.pointer(&format!("/properties/{key}/type"))?.as_str().map(str::to_owned));
    let resolve = |flag: &str| -> anyhow::Result<String> {
        let candidates = [flag.to_owned(), flag.replace('-', "_"), camel(flag)];
        if properties.is_empty() {
            return Ok(candidates[1].clone());
        }
        candidates.into_iter().find(|c| properties.contains(c)).with_context(|| format!("{name} has no option --{flag}; see `browse {name} --help`"))
    };
    let mut arguments = Map::new();
    let (mut session, mut output, mut positional) = (None, None, Vec::new());
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let next = args.get(i + 1).filter(|n| !n.starts_with("--")).cloned();
        i += 1;
        let Some(flag) = arg.strip_prefix("--") else {
            positional.push(arg.clone());
            continue;
        };
        let (flag, inline) = match flag.split_once('=') {
            Some((f, v)) => (f, Some(v.to_owned())),
            None => (flag, None),
        };
        match flag {
            "help" | "h" => {
                if let Some(spec) = &spec {
                    help(spec);
                }
                return Ok(0);
            }
            "json" | "session" | "output" => {
                let value = inline.or_else(|| next.inspect(|_| i += 1)).with_context(|| format!("--{flag} needs a value"))?;
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
                let boolean = schema_type(&key).as_deref() == Some("boolean");
                let value = match inline.or_else(|| if boolean { None } else { next.inspect(|_| i += 1) }) {
                    None => Value::Bool(true),
                    Some(raw) if schema_type(&key).as_deref() == Some("string") => Value::String(raw),
                    Some(raw) => serde_json::from_str(&raw).unwrap_or(Value::String(raw)),
                };
                arguments.insert(key, value);
            }
        }
    }
    // Positional arguments fill the required options in order: `browse navigate https://example.com`.
    let required: Vec<String> = spec
        .as_ref()
        .and_then(|s| s.input_schema.get("required")?.as_array().map(|r| r.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()))
        .unwrap_or_default();
    let open: Vec<&String> = required.iter().filter(|r| !arguments.contains_key(*r)).collect();
    let mut slots = open.into_iter();
    for value in positional {
        let key = slots.next().with_context(|| format!("unexpected argument {value:?}; see `browse {name} --help`"))?;
        let parsed = if schema_type(key).as_deref() == Some("string") { Value::String(value) } else { serde_json::from_str(&value).unwrap_or(Value::String(value)) };
        arguments.insert(key.clone(), parsed);
    }
    let request = ToolCallRequest { name: name.into(), arguments: Value::Object(arguments), session: session::for_cli(session) };
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
                        std::fs::create_dir_all(&dir)?;
                        dir.join(format!("{name}-{:x}.{ext}", session::random_u64() as u32))
                    }
                };
                std::fs::write(&file, base64::engine::general_purpose::STANDARD.decode(data).context("bad image data")?)?;
                println!("{}", file.display());
                images += 1;
            }
        }
    }
    Ok(i32::from(result.is_error))
}
