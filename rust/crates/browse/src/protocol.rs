//! The release protocol's client rules (anomalyco/release docs/protocol.md, src/protocol/decide.ts). Versions are
//! display text, only ever tested for equality: an install updates whenever the channel's current release isn't the
//! build it runs, so a rollback reaches everyone too.

use serde_json::Value;

/// The running install, as the rules see it.
pub struct Running<'a> {
    pub version: &'a str,
    pub target: &'a str,
    /// `direct` when it installs our own files, a package manager's kind, or `unknown`.
    pub distribution: &'a str,
    /// 0–99.
    pub bucket: u64,
    /// The SHA-256 of the target file it was installed from, when known.
    pub sha256: Option<&'a str>,
    /// The channel it was published on; `None` is the expected one.
    pub channel: Option<&'a str>,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Reason {
    Update,
    Required,
    Switch,
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Target {
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Reject(&'static str),
    None(&'static str),
    Install { reason: Reason, version: String, target: Target },
    Notify { reason: Reason, version: String, command: Option<String>, notes_url: Option<String> },
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn optional_text(value: &Value, key: &str) -> Result<Option<String>, ()> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(()),
    }
}

fn target(value: &Value) -> Option<Target> {
    let sha256 = text(value, "sha256").filter(|s| s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))?;
    Some(Target { url: text(value, "url")?, size: value.get("size")?.as_u64()?, sha256 })
}

/// The manifest's shape: what the rules read, checked as the reference schema does.
fn valid(manifest: &Value) -> bool {
    let release = &manifest["release"];
    let shape = || -> Option<()> {
        (manifest.get("schema")?.as_u64()? == 1).then_some(())?;
        for key in ["app", "artifact", "channel"] {
            text(manifest, key)?;
        }
        text(release, "version").filter(|v| !v.is_empty())?;
        (release.get("rollout_percent")?.as_u64()? <= 100).then_some(())?;
        match release.get("required") {
            None | Some(Value::Bool(_)) => {}
            Some(_) => return None,
        }
        optional_text(release, "notes_url").ok()?;
        for value in release.get("targets")?.as_object()?.values() {
            target(value)?;
        }
        for item in release.get("distributions")?.as_array()? {
            text(item, "kind")?;
            optional_text(item, "version").ok()?;
            optional_text(item, "command").ok()?;
        }
        Some(())
    };
    shape().is_some()
}

/// What to do with `manifest`, the text served for `app`'s `artifact` on `channel`, for `running`.
pub fn decide(app: &str, artifact: &str, channel: &str, manifest: &str, running: &Running) -> Decision {
    let Some(manifest) = serde_json::from_str::<Value>(manifest).ok().filter(valid) else { return Decision::Reject("malformed") };
    if manifest["app"] != app {
        return Decision::Reject("wrong_app");
    }
    if manifest["artifact"] != artifact {
        return Decision::Reject("wrong_artifact");
    }
    if manifest["channel"] != channel {
        return Decision::Reject("wrong_channel");
    }
    let release = &manifest["release"];
    let mut candidate = text(release, "version").unwrap_or_default();
    let mut found = None;
    let mut command = None;
    match running.distribution {
        "direct" => match release["targets"].get(running.target).and_then(target) {
            Some(t) => found = Some(t),
            None => return Decision::None("no_target"),
        },
        "unknown" => {}
        kind => {
            let Some(item) = release["distributions"].as_array().into_iter().flatten().find(|d| d["kind"] == kind) else {
                return Decision::None("distribution_unlisted");
            };
            let Some(version) = text(item, "version") else { return Decision::None("distribution_pending") };
            candidate = version;
            command = text(item, "command");
        }
    }
    let up_to_date = match (&found, running.sha256) {
        (Some(t), Some(sha256)) => t.sha256 == sha256,
        _ => candidate == running.version,
    };
    if up_to_date {
        return Decision::None("up_to_date");
    }
    let act = |reason| match found.clone() {
        Some(target) => Decision::Install { reason, version: candidate.clone(), target },
        None => Decision::Notify { reason, version: candidate.clone(), command: command.clone(), notes_url: text(release, "notes_url") },
    };
    if running.channel.is_some_and(|c| c != channel) {
        return act(Reason::Switch);
    }
    if release["required"] == true {
        return act(Reason::Required);
    }
    if running.bucket < release["rollout_percent"].as_u64().unwrap_or(0) {
        return act(Reason::Update);
    }
    Decision::None("rollout_deferred")
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{Decision, Reason, Running, decide};

    fn reason(reason: Reason) -> &'static str {
        match reason {
            Reason::Update => "update",
            Reason::Required => "required",
            Reason::Switch => "switch",
        }
    }

    fn wire(decision: Decision, distribution: &str) -> Value {
        match decision {
            Decision::Reject(r) => json!({ "action": "reject", "reason": r }),
            Decision::None(r) => json!({ "action": "none", "reason": r }),
            Decision::Install { reason: r, version, target } => {
                json!({ "action": "install", "reason": reason(r), "version": version, "target": { "url": target.url, "size": target.size, "sha256": target.sha256 } })
            }
            Decision::Notify { reason: r, version, command, notes_url } => {
                let mut value = json!({ "action": "notify", "reason": reason(r), "version": version, "distribution": distribution });
                if let Some(command) = command {
                    value["command"] = json!(command);
                }
                if let Some(notes_url) = notes_url {
                    value["notes_url"] = json!(notes_url);
                }
                value
            }
        }
    }

    /// Every case in the release repo's test-vectors/decisions.json (copied to tests/fixtures/release).
    #[test]
    fn every_release_protocol_decision_vector_passes() {
        let manifests: Value = serde_json::from_str(include_str!("../tests/fixtures/release/manifests.json")).unwrap();
        let decisions: Value = serde_json::from_str(include_str!("../tests/fixtures/release/decisions.json")).unwrap();
        let cases = decisions["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let input = &case["input"];
            let install = &input["install"];
            let manifest = manifests["manifests"][input["manifest"].as_str().unwrap()]["manifest"].as_str().unwrap();
            let distribution = install["distribution"].as_str().unwrap();
            let running = Running {
                version: install["version"].as_str().unwrap(),
                target: install["target"].as_str().unwrap(),
                distribution,
                bucket: install["rollout_bucket"].as_u64().unwrap(),
                sha256: install["sha256"].as_str(),
                channel: install["channel"].as_str(),
            };
            let decision = decide(input["app"].as_str().unwrap(), input["artifact"].as_str().unwrap(), input["channel"].as_str().unwrap(), manifest, &running);
            assert_eq!(wire(decision, distribution), case["expect"], "{}", case["name"]);
        }
    }
}
