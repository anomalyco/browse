//! `files` in execute code: paths, reads and writes inside the file roots, with browse-capture's rules (the same
//! source file, so screenshots, recordings and execute files can't drift apart).

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use base64::Engine;
use serde_json::{Value, json};

#[allow(dead_code)]
#[path = "../../browse-capture/src/files.rs"]
mod rules;

const MAX_READ: usize = 25 * 1024 * 1024;

/// `{ op: "info" | "path" | "write" | "read", target?, text?, base64?, encoding? }`.
pub fn run(roots: &[PathBuf], payload: &Value) -> Result<Value> {
    let target = payload["target"].as_str().unwrap_or_default();
    match payload["op"].as_str().unwrap_or_default() {
        "info" => {
            let dir = rules::output_path(roots, "file", "files.dir").ok().and_then(|p| p.parent().map(|d| d.display().to_string()));
            Ok(json!({ "dir": dir, "roots": roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>() }))
        }
        "path" => Ok(Value::String(rules::output_path(roots, target, "files.path")?.display().to_string())),
        "write" => {
            let path = rules::output_path(roots, target, "files.write")?;
            let bytes = match (payload["text"].as_str(), payload["base64"].as_str()) {
                (Some(text), _) => text.as_bytes().to_vec(),
                (None, Some(data)) => base64::engine::general_purpose::STANDARD.decode(data).context("files.write: bad bytes")?,
                _ => bail!("files.write needs a string or bytes"),
            };
            rules::write(roots, &path, &bytes, "files.write")?;
            Ok(Value::String(path.display().to_string()))
        }
        "read" => {
            let bytes = rules::read(roots, target, "files.read", MAX_READ)?;
            Ok(match payload["encoding"].as_str() {
                Some("base64") => json!({ "base64": base64::engine::general_purpose::STANDARD.encode(&bytes) }),
                Some(_) => json!({ "text": String::from_utf8_lossy(&bytes) }),
                None => json!({ "base64": base64::engine::general_purpose::STANDARD.encode(&bytes) }),
            })
        }
        other => bail!("unknown files operation {other}"),
    }
}
