//! WebDriver BiDi values: `RemoteValue` → JSON, JSON → `LocalValue`, `RemoteRef` tokens and exceptions.
//!
//! A `RemoteRef` token names the remote object directly, so the driver keeps no handle table:
//! - `n:<sharedId>` or `n:<sharedId>:<handle>` for DOM nodes (the `sharedId` works in every realm of the document)
//! - `o:<handle>` for any other object (valid in the realm that returned it)

use browse_core::{DocumentId, DriverError, DriverResult, Evaluated, FrameId, JsError, RemoteRef, Returns, World};
use serde_json::{Map, Value, json};

/// A decoded `RemoteRef` token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Token {
    Node { shared: String, handle: Option<String> },
    Object { handle: String },
}

impl Token {
    pub(crate) fn parse(token: &str) -> Option<Token> {
        if let Some(rest) = token.strip_prefix("n:") {
            return match rest.split_once(':') {
                Some((shared, handle)) if !shared.is_empty() && !handle.is_empty() => {
                    Some(Token::Node { shared: shared.into(), handle: Some(handle.into()) })
                }
                Some(_) => None,
                None if !rest.is_empty() => Some(Token::Node { shared: rest.into(), handle: None }),
                None => None,
            };
        }
        token
            .strip_prefix("o:")
            .filter(|handle| !handle.is_empty())
            .map(|handle| Token::Object { handle: handle.into() })
    }

    pub(crate) fn encode(&self) -> String {
        match self {
            Token::Node { shared, handle: Some(handle) } => format!("n:{shared}:{handle}"),
            Token::Node { shared, handle: None } => format!("n:{shared}"),
            Token::Object { handle } => format!("o:{handle}"),
        }
    }

    /// The handle the browser holds for this ref, which `script.disown` releases.
    pub(crate) fn handle(&self) -> Option<&str> {
        match self {
            Token::Node { handle, .. } => handle.as_deref(),
            Token::Object { handle } => Some(handle),
        }
    }

    /// The `RemoteReference` passed as an argument or `this`.
    pub(crate) fn reference(&self) -> Value {
        match self {
            Token::Node { shared, .. } => json!({ "sharedId": shared }),
            Token::Object { handle } => json!({ "handle": handle }),
        }
    }
}

/// The `script` target for a realm: browse's sandbox for the isolated world, the page's own realm for the main one.
pub(crate) fn target(frame: &FrameId, world: World) -> Value {
    match world {
        World::Main => json!({ "context": frame.as_str() }),
        World::Isolated => json!({ "context": frame.as_str(), "sandbox": crate::SANDBOX }),
    }
}

/// Result ownership and serialization options for `script.evaluate` / `script.callFunction`.
pub(crate) fn apply_returns(params: &mut Value, returns: Returns) {
    match returns {
        Returns::Json => {
            params["resultOwnership"] = json!("none");
            params["serializationOptions"] = json!({ "maxDomDepth": 0 });
        }
        Returns::Ref => {
            params["resultOwnership"] = json!("root");
            params["serializationOptions"] = json!({ "maxObjectDepth": 0, "maxDomDepth": 0 });
        }
    }
}

/// A JSON value as a BiDi `LocalValue`.
pub(crate) fn local_value(value: &Value) -> Value {
    match value {
        Value::Null => json!({ "type": "null" }),
        Value::Bool(b) => json!({ "type": "boolean", "value": b }),
        Value::Number(n) => json!({ "type": "number", "value": n }),
        Value::String(s) => json!({ "type": "string", "value": s }),
        Value::Array(items) => json!({ "type": "array", "value": items.iter().map(local_value).collect::<Vec<_>>() }),
        Value::Object(map) => json!({
            "type": "object",
            "value": map.iter().map(|(key, item)| json!([key, local_value(item)])).collect::<Vec<_>>(),
        }),
    }
}

fn number(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(special)) if special == "-0" => json!(0),
        Some(Value::String(_)) | None => Value::Null,
        Some(other) => other.clone(),
    }
}

fn is_skipped(value: &Value) -> bool {
    matches!(value.get("type").and_then(Value::as_str), Some("undefined" | "function" | "symbol"))
}

/// A BiDi `RemoteValue` as JSON, close to what `JSON.stringify` keeps: `undefined`, `NaN` and infinities become
/// null; `-0` is 0; bigints, dates and regexps become strings; arrays, sets and node lists become arrays; maps
/// become objects when every key is a string (otherwise `[key, value]` pairs). Values serialized without their
/// contents (nodes, windows, errors, promises, ...) become `{}`.
pub(crate) fn to_json(value: &Value) -> Value {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let inner = value.get("value");
    match kind {
        "undefined" | "null" => Value::Null,
        "string" | "boolean" => inner.cloned().unwrap_or(Value::Null),
        "number" => number(inner),
        "bigint" => inner.and_then(Value::as_str).map(|v| json!(v)).unwrap_or(Value::Null),
        "date" => inner.cloned().unwrap_or(Value::Null),
        "regexp" => match inner {
            Some(regexp) => json!(format!(
                "/{}/{}",
                regexp.get("pattern").and_then(Value::as_str).unwrap_or(""),
                regexp.get("flags").and_then(Value::as_str).unwrap_or("")
            )),
            None => Value::Null,
        },
        "array" | "set" | "nodelist" | "htmlcollection" => match inner.and_then(Value::as_array) {
            Some(items) => Value::Array(items.iter().map(to_json).collect()),
            None => json!({}),
        },
        "object" => match inner.and_then(Value::as_array) {
            Some(entries) => {
                let mut out = Map::new();
                for entry in entries {
                    let Some([key, item]) = entry.as_array().map(Vec::as_slice) else { continue };
                    if is_skipped(item) {
                        continue;
                    }
                    let key = match key {
                        Value::String(key) => key.clone(),
                        other => match to_json(other) {
                            Value::String(key) => key,
                            other => other.to_string(),
                        },
                    };
                    out.insert(key, to_json(item));
                }
                Value::Object(out)
            }
            None => json!({}),
        },
        "map" => match inner.and_then(Value::as_array) {
            Some(entries) => {
                let pairs: Vec<(&Value, &Value)> = entries
                    .iter()
                    .filter_map(|entry| match entry.as_array().map(Vec::as_slice) {
                        Some([key, item]) => Some((key, item)),
                        _ => None,
                    })
                    .collect();
                if pairs.iter().all(|(key, _)| key.is_string()) {
                    let mut out = Map::new();
                    for (key, item) in pairs {
                        if !is_skipped(item) {
                            out.insert(key.as_str().unwrap_or_default().to_string(), to_json(item));
                        }
                    }
                    Value::Object(out)
                } else {
                    let key_json = |key: &Value| if key.is_string() { key.clone() } else { to_json(key) };
                    Value::Array(pairs.into_iter().map(|(key, item)| json!([key_json(key), to_json(item)])).collect())
                }
            }
            None => json!({}),
        },
        _ => json!({}),
    }
}

/// Reads a `script.evaluate` / `script.callFunction` result.
pub(crate) fn parse_result(
    result: &Value,
    frame: &FrameId,
    world: World,
    document: DocumentId,
    returns: Returns,
) -> Result<Evaluated, Box<JsError>> {
    if result.get("type").and_then(Value::as_str) == Some("exception") {
        return Err(Box::new(js_error(&result["exceptionDetails"])));
    }
    let value = &result["result"];
    if returns == Returns::Ref {
        let handle = value.get("handle").and_then(Value::as_str).map(str::to_string);
        if value.get("type").and_then(Value::as_str) == Some("node")
            && let Some(shared) = value.get("sharedId").and_then(Value::as_str)
        {
            let token = Token::Node { shared: shared.to_string(), handle };
            return Ok(Evaluated::Node(RemoteRef::new(frame.clone(), world, document, token.encode())));
        }
        if let Some(handle) = handle {
            let token = Token::Object { handle };
            return Ok(Evaluated::Object(RemoteRef::new(frame.clone(), world, document, token.encode())));
        }
    }
    Ok(Evaluated::Json(to_json(value)))
}

/// A BiDi `ExceptionDetails` as a `JsError`.
pub(crate) fn js_error(details: &Value) -> JsError {
    let text = details.get("text").and_then(Value::as_str).unwrap_or("").to_string();
    let exception = &details["exception"];
    let is_error = exception.get("type").and_then(Value::as_str) == Some("error");
    let frames: Vec<Value> = details
        .pointer("/stackTrace/callFrames")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let message = if is_error {
        if text.is_empty() { "the page threw an exception".to_string() } else { text.clone() }
    } else if exception.get("type").and_then(Value::as_str) == Some("undefined") {
        "threw undefined".to_string()
    } else {
        format!("threw {}", to_json(exception))
    };
    let name = is_error
        .then(|| text.split_once(": ").map(|(name, _)| name.to_string()))
        .flatten()
        .filter(|name| !name.is_empty() && !name.contains(char::is_whitespace));
    let is_compile_syntax_error = text.starts_with("SyntaxError") && frames.is_empty();
    let stack = (!frames.is_empty()).then(|| {
        frames
            .iter()
            .map(|frame| {
                format!(
                    "{}@{}:{}:{}",
                    frame.get("functionName").and_then(Value::as_str).unwrap_or(""),
                    frame.get("url").and_then(Value::as_str).unwrap_or(""),
                    frame.get("lineNumber").and_then(Value::as_i64).unwrap_or(0) + 1,
                    frame.get("columnNumber").and_then(Value::as_i64).unwrap_or(0) + 1,
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    });
    let (line, column) = if is_compile_syntax_error {
        (None, None)
    } else {
        (
            details.get("lineNumber").and_then(Value::as_i64),
            details.get("columnNumber").and_then(Value::as_i64),
        )
    };
    JsError {
        name,
        message,
        stack,
        thrown: (!is_error).then(|| to_json(exception)),
        url: frames
            .first()
            .and_then(|frame| frame.get("url").and_then(Value::as_str))
            .filter(|url| !url.is_empty())
            .map(str::to_string),
        line,
        column,
        is_compile_syntax_error,
    }
}

/// The token of a ref that must still belong to `document` of `frame`; `Stale` without a round-trip otherwise.
pub(crate) fn checked_token(reference: &RemoteRef, frame: &FrameId, document: DocumentId) -> DriverResult<Token> {
    if &reference.frame != frame || reference.document != document {
        return Err(DriverError::Stale);
    }
    Token::parse(reference.token()).ok_or_else(|| DriverError::Protocol("not a WebDriver BiDi remote reference".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_round_trip() {
        for token in [
            Token::Node { shared: "f.1.d.2.e.3".into(), handle: None },
            Token::Node { shared: "3ff54aa6-710a".into(), handle: Some("685a5ea0-e016".into()) },
            Token::Object { handle: "26275be9".into() },
        ] {
            assert_eq!(Token::parse(&token.encode()), Some(token));
        }
        assert_eq!(Token::parse("o:"), None);
        assert_eq!(Token::parse("n:"), None);
        assert_eq!(Token::parse("x:1"), None);
        assert_eq!(Token::parse("n:abc").unwrap().reference(), json!({ "sharedId": "abc" }));
        assert_eq!(Token::parse("n:abc:h").unwrap().reference(), json!({ "sharedId": "abc" }));
        assert_eq!(Token::parse("n:abc:h").unwrap().handle(), Some("h"));
        assert_eq!(Token::parse("o:h").unwrap().reference(), json!({ "handle": "h" }));
    }

    #[test]
    fn remote_values_decode_like_json() {
        let decode = |raw: &str| to_json(&serde_json::from_str(raw).unwrap());
        assert_eq!(decode(r#"{"type":"undefined"}"#), Value::Null);
        assert_eq!(
            decode(r#"{"type":"array","value":[{"type":"number","value":"NaN"},{"type":"number","value":"-0"},{"type":"number","value":"Infinity"},{"type":"number","value":"-Infinity"},{"type":"number","value":1.5},{"type":"undefined"}]}"#),
            json!([null, 0, null, null, 1.5, null])
        );
        assert_eq!(decode(r#"{"type":"bigint","value":"10"}"#), json!("10"));
        assert_eq!(decode(r#"{"type":"date","value":"1970-01-01T00:00:00.000Z"}"#), json!("1970-01-01T00:00:00.000Z"));
        assert_eq!(decode(r#"{"type":"regexp","value":{"pattern":"a+","flags":"gi"}}"#), json!("/a+/gi"));
        assert_eq!(
            decode(r#"{"type":"map","value":[["a",{"type":"number","value":1}],[{"type":"object","value":[["x",{"type":"number","value":1}]]},{"type":"number","value":2}]]}"#),
            json!([["a", 1], [{ "x": 1 }, 2]])
        );
        assert_eq!(decode(r#"{"type":"map","value":[["a",{"type":"number","value":1}]]}"#), json!({ "a": 1 }));
        assert_eq!(decode(r#"{"type":"set","value":[{"type":"number","value":1},{"type":"string","value":"a"}]}"#), json!([1, "a"]));
        assert_eq!(
            decode(r#"{"type":"object","value":[["f",{"type":"function"}],["s",{"type":"symbol"}],["u",{"type":"undefined"}],["n",{"type":"null"}],["k y",{"type":"number","value":1}]]}"#),
            json!({ "n": null, "k y": 1 })
        );
        for opaque in ["node", "window", "error", "typedarray", "arraybuffer", "promise", "proxy", "weakmap"] {
            assert_eq!(decode(&format!(r#"{{"type":"{opaque}"}}"#)), json!({}), "{opaque}");
        }
        assert_eq!(
            decode(r#"{"type":"object","internalId":"1","value":[["n",{"type":"number","value":1}],["self",{"type":"object","internalId":"1"}]]}"#),
            json!({ "n": 1, "self": {} })
        );
        assert_eq!(
            decode(r#"{"type":"object","value":[["el",{"type":"node","sharedId":"x","value":{"nodeType":1}}],["list",{"type":"nodelist","value":[{"type":"node","sharedId":"y"}]}]]}"#),
            json!({ "el": {}, "list": [{}] })
        );
    }

    #[test]
    fn json_becomes_local_values() {
        assert_eq!(
            local_value(&json!({ "a": null, "b": [true, 1, "x"] })),
            json!({ "type": "object", "value": [
                ["a", { "type": "null" }],
                ["b", { "type": "array", "value": [
                    { "type": "boolean", "value": true },
                    { "type": "number", "value": 1 },
                    { "type": "string", "value": "x" },
                ] }],
            ] })
        );
    }

    #[test]
    fn results_become_refs_or_json() {
        let frame = FrameId::from("ctx");
        let doc = DocumentId(7);
        let node = json!({ "type": "success", "result": { "type": "node", "sharedId": "s1", "handle": "h1", "value": {} } });
        match parse_result(&node, &frame, World::Isolated, doc, Returns::Ref).unwrap() {
            Evaluated::Node(r) => {
                assert_eq!(r.token(), "n:s1:h1");
                assert_eq!(r.document, doc);
                assert_eq!(r.world, World::Isolated);
            }
            other => panic!("{other:?}"),
        }
        let object = json!({ "type": "success", "result": { "type": "object", "handle": "h2" } });
        assert!(matches!(parse_result(&object, &frame, World::Main, doc, Returns::Ref).unwrap(), Evaluated::Object(r) if r.token() == "o:h2"));
        let number = json!({ "type": "success", "result": { "type": "number", "value": 3 } });
        assert!(matches!(parse_result(&number, &frame, World::Main, doc, Returns::Ref).unwrap(), Evaluated::Json(v) if v == json!(3)));
        assert!(matches!(parse_result(&node, &frame, World::Main, doc, Returns::Json).unwrap(), Evaluated::Json(v) if v == json!({})));
    }

    #[test]
    fn exceptions() {
        let thrown = json!({ "type": "exception", "exceptionDetails": {
            "columnNumber": 15, "lineNumber": 4, "text": "TypeError: bad thing", "exception": { "type": "error" },
            "stackTrace": { "callFrames": [{ "columnNumber": 15, "functionName": "", "lineNumber": 4, "url": "http://a/x" }] },
        } });
        let error = parse_result(&thrown, &FrameId::from("c"), World::Main, DocumentId(1), Returns::Json).unwrap_err();
        assert_eq!(error.name.as_deref(), Some("TypeError"));
        assert_eq!(error.message, "TypeError: bad thing");
        assert_eq!(error.url.as_deref(), Some("http://a/x"));
        assert_eq!((error.line, error.column), (Some(4), Some(15)));
        assert!(!error.stack.as_deref().unwrap().starts_with("at "));
        assert!(!error.is_compile_syntax_error);

        let syntax = js_error(&json!({ "columnNumber": 39, "lineNumber": 305, "text": "SyntaxError: expected expression, got '*'", "exception": { "type": "error" }, "stackTrace": { "callFrames": [] } }));
        assert!(syntax.is_compile_syntax_error);
        assert_eq!((syntax.line, syntax.column), (None, None));
        assert_eq!(syntax.name.as_deref(), Some("SyntaxError"));
        let runtime_syntax = js_error(&json!({ "text": "SyntaxError: JSON.parse: bad", "exception": { "type": "error" }, "stackTrace": { "callFrames": [{ "url": "u", "lineNumber": 0, "columnNumber": 5 }] } }));
        assert!(!runtime_syntax.is_compile_syntax_error);

        assert_eq!(js_error(&json!({ "text": "null", "exception": { "type": "null" } })).message, "threw null");
        assert_eq!(js_error(&json!({ "text": "undefined", "exception": { "type": "undefined" } })).message, "threw undefined");
        let object = js_error(&json!({ "text": "[object Object]", "exception": { "type": "object", "value": [["custom", { "type": "number", "value": 1 }]] } }));
        assert_eq!(object.message, r#"threw {"custom":1}"#);
        assert_eq!(object.thrown, Some(json!({ "custom": 1 })));
        assert_eq!(object.name, None);
    }

    #[test]
    fn refs_from_another_document_are_stale() {
        let frame = FrameId::from("ctx");
        let reference = RemoteRef::new(frame.clone(), World::Isolated, DocumentId(1), "n:s");
        assert!(checked_token(&reference, &frame, DocumentId(1)).is_ok());
        assert!(matches!(checked_token(&reference, &frame, DocumentId(2)), Err(DriverError::Stale)));
        assert!(matches!(checked_token(&reference, &FrameId::from("other"), DocumentId(1)), Err(DriverError::Stale)));
    }
}
