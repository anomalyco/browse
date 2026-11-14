//! Just enough JSONC to read OpenCode's config and change one entry in place, keeping comments and formatting.

use anyhow::{Context, bail};
use serde_json::Value;

/// Parses JSONC (comments, trailing commas) into a value.
pub fn parse(text: &str) -> anyhow::Result<Value> {
    if text.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    let bytes = text.as_bytes();
    let mut plain = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let end = string_end(bytes, i)?;
                plain.extend_from_slice(&bytes[i..end]);
                i = end;
            }
            b'/' if bytes.get(i + 1).is_some_and(|b| matches!(b, b'/' | b'*')) => i = comment_end(bytes, i)?,
            b',' => {
                let next = skip(bytes, i + 1)?;
                if !matches!(bytes.get(next), Some(b'}' | b']')) {
                    plain.push(b',');
                }
                i += 1;
            }
            byte => {
                plain.push(byte);
                i += 1;
            }
        }
    }
    serde_json::from_slice(&plain).context("invalid JSON")
}

fn string_end(bytes: &[u8], start: usize) -> anyhow::Result<usize> {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Ok(i + 1),
            _ => i += 1,
        }
    }
    bail!("unterminated string")
}

fn comment_end(bytes: &[u8], start: usize) -> anyhow::Result<usize> {
    if bytes[start + 1] == b'/' {
        return Ok(bytes[start..].iter().position(|b| *b == b'\n').map_or(bytes.len(), |p| start + p));
    }
    bytes[start + 2..].windows(2).position(|w| w == b"*/").map(|p| start + 2 + p + 2).context("unterminated comment")
}

/// The next index that isn't whitespace or a comment.
fn skip(bytes: &[u8], mut i: usize) -> anyhow::Result<usize> {
    while i < bytes.len() {
        match bytes[i] {
            b' ' | b'\t' | b'\r' | b'\n' => i += 1,
            b'/' if bytes.get(i + 1).is_some_and(|b| matches!(b, b'/' | b'*')) => i = comment_end(bytes, i)?,
            _ => break,
        }
    }
    Ok(i)
}

struct Prop {
    key: String,
    start: usize,
    value: Node,
}

struct Node {
    start: usize,
    end: usize,
    /// Properties when the node is an object.
    props: Option<Vec<Prop>>,
}

fn node(bytes: &[u8], at: usize) -> anyhow::Result<Node> {
    let start = skip(bytes, at)?;
    match bytes.get(start) {
        Some(b'{') => {
            let mut props = Vec::new();
            let mut i = skip(bytes, start + 1)?;
            while bytes.get(i) != Some(&b'}') {
                if bytes.get(i) != Some(&b'"') {
                    bail!("expected a property name at byte {i}");
                }
                let key_end = string_end(bytes, i)?;
                let key: String = serde_json::from_slice(&bytes[i..key_end])?;
                let colon = skip(bytes, key_end)?;
                if bytes.get(colon) != Some(&b':') {
                    bail!("expected ':' at byte {colon}");
                }
                let value = node(bytes, colon + 1)?;
                props.push(Prop { key, start: i, value });
                i = skip(bytes, props.last().unwrap().value.end)?;
                if bytes.get(i) == Some(&b',') {
                    i = skip(bytes, i + 1)?;
                }
            }
            Ok(Node { start, end: i + 1, props: Some(props) })
        }
        Some(b'[') => {
            let mut i = skip(bytes, start + 1)?;
            while bytes.get(i) != Some(&b']') {
                i = skip(bytes, node(bytes, i)?.end)?;
                if bytes.get(i) == Some(&b',') {
                    i = skip(bytes, i + 1)?;
                } else if bytes.get(i) != Some(&b']') {
                    bail!("expected ',' or ']' at byte {i}");
                }
            }
            Ok(Node { start, end: i + 1, props: None })
        }
        Some(b'"') => Ok(Node { start, end: string_end(bytes, start)?, props: None }),
        Some(_) => {
            let len = bytes[start..].iter().position(|b| !(b.is_ascii_alphanumeric() || matches!(b, b'-' | b'+' | b'.'))).unwrap_or(bytes.len() - start);
            if len == 0 {
                bail!("unexpected character at byte {start}");
            }
            Ok(Node { start, end: start + len, props: None })
        }
        None => bail!("unexpected end of input"),
    }
}

fn indent_of(text: &str, at: usize) -> String {
    let line = text[..at].rfind('\n').map_or(0, |p| p + 1);
    text[line..].chars().take_while(|c| *c == ' ' || *c == '\t').collect()
}

fn render(value: &Value, indent: &str) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default().replace('\n', &format!("\n{indent}"))
}

/// Sets (or with `None`, removes) the value at `path`, creating missing objects on the way.
pub fn modify(text: &str, path: &[&str], value: Option<&Value>) -> anyhow::Result<String> {
    let source = if text.trim().is_empty() { "{}" } else { text };
    let bytes = source.as_bytes();
    let mut current = node(bytes, 0)?;
    if skip(bytes, current.end)? != bytes.len() {
        bail!("unexpected content after the JSON value");
    }
    for (depth, key) in path.iter().enumerate() {
        let Some(props) = current.props.take() else { bail!("{} is not an object", path[..depth].join(".")) };
        let index = props.iter().position(|p| p.key == *key);
        let last = depth + 1 == path.len();
        match (index, value) {
            (Some(i), _) if !last => current = props.into_iter().nth(i).unwrap().value,
            (Some(i), Some(value)) => {
                let target = &props[i].value;
                let indent = indent_of(source, props[i].start);
                return Ok(format!("{}{}{}", &source[..target.start], render(value, &indent), &source[target.end..]));
            }
            (Some(i), None) => {
                let (from, to) = match (i.checked_sub(1).map(|p| &props[p]), props.get(i + 1)) {
                    (Some(previous), _) => (previous.value.end, props[i].value.end),
                    (None, Some(next)) => (props[i].start, next.start),
                    (None, None) => (current.start + 1, skip(bytes, props[i].value.end)?.min(current.end - 1)),
                };
                let to = if i == 0 && props.len() == 1 && bytes.get(to) == Some(&b',') { to + 1 } else { to };
                return Ok(format!("{}{}", &source[..from], &source[to..]));
            }
            (None, None) => return Ok(text.to_owned()),
            (None, Some(value)) => {
                let nested = path[depth + 1..].iter().rev().fold(value.clone(), |inner, k| serde_json::json!({ *k: inner }));
                let base = indent_of(source, current.start);
                let inner = props.first().map_or_else(|| format!("{base}  "), |p| indent_of(source, p.start));
                let entry = format!("{}: {}", serde_json::to_string(key)?, render(&nested, &inner));
                return Ok(match props.last() {
                    Some(last) => format!("{},\n{inner}{entry}{}", &source[..last.value.end], &source[last.value.end..]),
                    None if source[current.start + 1..current.end - 1].trim().is_empty() => {
                        format!("{}{{\n{inner}{entry}\n{base}}}{}", &source[..current.start], &source[current.end..])
                    }
                    None => format!("{}\n{inner}{entry}{}", &source[..current.start + 1], &source[current.start + 1..]),
                });
            }
        }
    }
    bail!("empty path")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn edits_keep_comments() {
        let text = "{\n  // mine\n  \"theme\": \"x\", /* keep */\n  \"mcp\": { \"servers\": { \"other\": {\"a\": 1} } },\n}\n";
        let added = modify(text, &["mcp", "servers", "browse"], Some(&json!({"type": "local"}))).unwrap();
        assert!(added.contains("// mine") && added.contains("/* keep */"));
        assert_eq!(parse(&added).unwrap()["mcp"]["servers"]["browse"]["type"], "local");
        let replaced = modify(&added, &["mcp", "servers", "browse"], Some(&json!({"type": "remote"}))).unwrap();
        assert_eq!(parse(&replaced).unwrap()["mcp"]["servers"]["browse"]["type"], "remote");
        let removed = modify(&replaced, &["mcp", "servers", "browse"], None).unwrap();
        assert_eq!(parse(&removed).unwrap(), parse(text).unwrap());
        let removed = modify(&removed, &["mcp", "servers", "other"], None).unwrap();
        assert_eq!(parse(&removed).unwrap()["mcp"]["servers"], json!({}));
    }

    #[test]
    fn creates_missing_objects() {
        for text in ["", "{}", "{\n}\n", "{ \"$schema\": \"s\" }"] {
            let out = modify(text, &["mcp", "servers", "browse"], Some(&json!({"command": ["browse", "mcp"]}))).unwrap();
            assert_eq!(parse(&out).unwrap()["mcp"]["servers"]["browse"]["command"][1], "mcp", "{out}");
        }
    }
}
