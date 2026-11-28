//! Checks a tool call's arguments against the tool's input schema before it runs, and explains arguments a tool
//! doesn't take when a call fails. Extra arguments alone never fail a call: tools ignore what they don't read.
//! Missing required arguments are left to the tools, whose own messages say where to get them (`Pass `tab``).

use serde_json::Value;

/// Problems with the arguments' types and allowed values, one `path: message` line each.
pub fn issues(schema: &Value, arguments: &Value) -> Vec<String> {
    let mut found = Vec::new();
    check(schema, arguments, "", &mut found);
    found
}

/// The error for a call whose arguments don't fit the schema, in the shape OpenCode uses for its own tools.
pub fn invalid(tool: &str, issues: &[String], schema: &Value, arguments: &Value) -> String {
    let mut lines: Vec<String> = issues.iter().take(5).map(|issue| format!("- {issue}")).collect();
    if issues.len() > 5 {
        lines.push(format!("- ...and {} more", issues.len() - 5));
    }
    let mut text = format!("Invalid arguments for tool \"{tool}\":\n{}", lines.join("\n"));
    if let Some(note) = ignored(tool, schema, arguments) {
        text.push_str(&format!("\n\n{note}"));
    }
    let provided = serde_json::to_string_pretty(arguments).unwrap_or_default();
    text.push_str(&format!("\n\nArguments provided:\n{provided}\n\nUpdate the arguments and call the tool again."));
    text
}

/// Names the arguments the tool doesn't take, and the ones it does, or None when every argument is known.
pub fn ignored(tool: &str, schema: &Value, arguments: &Value) -> Option<String> {
    let properties = schema.get("properties").and_then(Value::as_object)?;
    let unknown: Vec<&str> = arguments.as_object()?.keys().map(String::as_str).filter(|key| !properties.contains_key(*key)).collect();
    if unknown.is_empty() {
        return None;
    }
    let takes: Vec<&str> = properties.keys().map(String::as_str).collect();
    Some(format!("Ignored: {} (not {tool} arguments). {tool} takes: {}.", unknown.join(", "), takes.join(", ")))
}

fn check(schema: &Value, value: &Value, path: &str, found: &mut Vec<String>) {
    // A null is an absent argument to every tool.
    if value.is_null() {
        return;
    }
    let label = if path.is_empty() { "root" } else { path };
    if let Some(branches) = schema.get("anyOf").or_else(|| schema.get("oneOf")).and_then(Value::as_array) {
        let fits = branches.iter().any(|branch| {
            let mut inner = Vec::new();
            check(branch, value, path, &mut inner);
            inner.is_empty()
        });
        if !fits {
            let expected: Vec<String> = branches.iter().filter_map(describe).collect();
            found.push(format!("{label}: expected {}, got {}", or_list(&expected), shown(value)));
        }
        return;
    }
    if let Some(types) = types(schema)
        && !types.iter().any(|t| is_type(value, t))
    {
        found.push(format!("{label}: expected {}, got {}", or_list(&types), shown(value)));
        return;
    }
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array)
        && !allowed.contains(value)
    {
        let options: Vec<String> = allowed.iter().map(|v| v.to_string()).collect();
        found.push(format!("{label}: expected one of {}, got {}", options.join(", "), shown(value)));
        return;
    }
    if let (Some(properties), Some(object)) = (schema.get("properties").and_then(Value::as_object), value.as_object()) {
        for (key, child) in object {
            if let Some(child_schema) = properties.get(key) {
                let path = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                check(child_schema, child, &path, found);
            }
        }
    }
    if let (Some(items), Some(array)) = (schema.get("items"), value.as_array()) {
        for (index, item) in array.iter().enumerate() {
            check(items, item, &format!("{label}[{index}]"), found);
        }
    }
}

fn types(schema: &Value) -> Option<Vec<String>> {
    match schema.get("type")? {
        Value::String(t) => Some(vec![t.clone()]),
        Value::Array(list) => Some(list.iter().filter_map(Value::as_str).map(str::to_string).collect()),
        _ => None,
    }
}

fn is_type(value: &Value, name: &str) -> bool {
    match name {
        "integer" => value.is_i64() || value.is_u64(),
        "number" => value.is_number(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        "null" => value.is_null(),
        _ => true,
    }
}

/// What a schema branch accepts, in a few words.
fn describe(schema: &Value) -> Option<String> {
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        return Some(allowed.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(" or "));
    }
    let types = types(schema)?;
    let words: Vec<String> = types
        .iter()
        .map(|t| match (t.as_str(), schema.get("items").and_then(describe)) {
            ("array", Some(items)) => format!("array of {items}"),
            _ => t.clone(),
        })
        .collect();
    Some(words.join(" or "))
}

fn or_list(items: &[String]) -> String {
    match items {
        [] => "a different value".into(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
    }
}

fn shown(value: &Value) -> String {
    let text = value.to_string();
    if text.chars().count() > 60 { format!("{}…", text.chars().take(60).collect::<String>()) } else { text }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "tab": { "type": ["integer", "string"] },
                "ref": { "type": "string" },
                "value": { "type": "string" },
                "button": { "type": "string", "enum": ["left", "right", "middle"] },
                "count": { "type": "integer" },
                "key": { "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }] },
                "fields": { "type": "array", "items": { "type": "object", "properties": { "ref": { "type": "string" } } } },
            },
            "required": ["tab"],
            "additionalProperties": false,
        })
    }

    #[test]
    fn right_arguments_and_extras_pass() {
        let ok = json!({ "tab": "work-mail", "ref": "e3", "button": "left", "count": 2, "key": ["a", "b"], "extra": true });
        assert!(issues(&schema(), &ok).is_empty());
        assert!(issues(&schema(), &json!({})).is_empty(), "missing required arguments are left to the tool");
        assert!(issues(&schema(), &json!({ "tab": 12, "ref": null })).is_empty(), "null is absent");
    }

    #[test]
    fn wrong_types_and_values_are_named() {
        let found = issues(&schema(), &json!({ "tab": true, "ref": 5, "button": "top", "count": 1.5, "key": 3, "fields": [{ "ref": 1 }] }));
        // Key order follows serde_json's map (insertion order only with its preserve_order feature).
        let mut sorted = found.clone();
        sorted.sort();
        let mut expected = vec![
                "tab: expected integer or string, got true",
                "ref: expected string, got 5",
                "button: expected one of \"left\", \"right\", \"middle\", got \"top\"",
                "count: expected integer, got 1.5",
                "key: expected string or array of string, got 3",
                "fields[0].ref: expected string, got 1",
            ];
        expected.sort();
        assert_eq!(sorted, expected);
        let text = invalid("click", &found, &schema(), &json!({ "tab": true, "foo": 1 }));
        assert!(text.starts_with("Invalid arguments for tool \"click\":\n- "), "{text}");
        assert!(text.contains("- ...and 1 more"), "five issues at most: {text}");
        assert!(text.contains("Ignored: foo (not click arguments). click takes: "), "{text}");
        assert!(text.ends_with("Update the arguments and call the tool again."), "{text}");
    }

    #[test]
    fn ignored_names_only_unknown_keys() {
        assert_eq!(ignored("fill", &schema(), &json!({ "tab": 1, "ref": "e3" })), None);
        let note = ignored("fill", &schema(), &json!({ "tab": 1, "ref": "e3", "text": "New York" })).unwrap();
        let (head, takes) = note.split_once(" fill takes: ").unwrap();
        assert_eq!(head, "Ignored: text (not fill arguments).");
        let mut takes: Vec<&str> = takes.trim_end_matches('.').split(", ").collect();
        takes.sort();
        assert_eq!(takes, ["button", "count", "fields", "key", "ref", "tab", "value"]);
    }
}
