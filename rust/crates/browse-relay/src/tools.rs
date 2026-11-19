//! The relay's own tools: tabs, handoff, demonstrate, status and settings.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use async_trait::async_trait;
use browse_core::{TabOptions, Tool, ToolContext, ToolOutput, ToolSpec};
use serde_json::{Value, json};

use crate::relay::{Owner, Relay};
use crate::serve::RELAY;

fn relay() -> anyhow::Result<Arc<Relay>> {
    RELAY.try_with(Arc::clone).map_err(|_| anyhow!("This tool runs only inside the browse relay"))
}

fn json_output(value: Value) -> ToolOutput {
    ToolOutput::text(value.to_string())
}

fn string(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

/// The `id` of a `tabs new`: a lowercase slug like `work-mail`, never something that reads as a number.
fn chosen_id(args: &Value) -> anyhow::Result<Option<String>> {
    match args.get("id") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            let id = text.trim();
            if !browse_core::valid_chosen_id(id) {
                bail!("id must be a lowercase slug like `work-mail` (letters, digits and dashes, starting with a letter, at most 64 characters), not {text:?}");
            }
            Ok(Some(id.to_string()))
        }
        Some(other) => bail!("id must be a string like `work-mail`, not {other}"),
    }
}

struct TabsTool;

#[async_trait]
impl Tool for TabsTool {
    fn spec(&self) -> ToolSpec {
        let mut properties = TabOptions::schema();
        properties.insert("action".into(), json!({ "type": "string", "enum": ["list", "new", "close"], "description": "What to do. Defaults to list." }));
        properties.insert("id".into(), json!({ "type": "string", "description": "new: an id you choose for the tab, like `work-mail` (lowercase letters, digits and dashes). Every tool takes it as `tab`. Opening with an id that already exists returns that tab without navigating it; the tab keeps the id while it stays open (a relay restart or extension reload keeps it, a browser restart loses it and the next open is a fresh tab). It closes when idle like every other agent tab unless opened with keepOpen." }));
        properties.insert("url".into(), json!({ "type": "string", "description": "new: the URL to open (else about:blank)." }));
        properties.insert("tab".into(), json!({ "type": ["integer", "string"], "description": "close: the tab to close: its numeric id, or a chosen id like `work-mail`." }));
        properties.insert("tabs".into(), json!({ "type": "array", "items": { "type": ["integer", "string"] }, "description": "close: several tabs to close, by numeric or chosen id." }));
        properties.insert("group".into(), json!({ "type": "string", "description": "new: the new tab's group label. list: only that group's tabs. close: close every tab opened with that group (and their popups)." }));
        properties.insert("idleMinutes".into(), json!({ "type": "number", "minimum": 0, "description": "close: only tabs no call used for this long. It narrows tab, tabs or group; it doesn't pick tabs on its own." }));
        ToolSpec {
            name: "tabs".into(),
            description: "List, open or close tabs. Tabs are the handle every other tool takes as `tab`. `list` returns every agent tab and every tab the user lent (tab id, id when one was chosen, url, title, group, options, lent, lastUsed, busy and browser). An id or group from that list tells you which tabs you opened; use only those unless the user asks you to touch another. `new` opens a background tab (at `url`, else about:blank), waits for it to load and returns its `tab` id; `navigate` without `tab` does the same. Give it an `id` like `work-mail` to name the tab yourself: opening that id again returns the tab it already names, without navigating it, and the id lasts while the tab is open (a relay restart or extension reload keeps it; a browser restart loses it, and opening the id again is a fresh tab). Use it as `tab` in every tool. `keepOpen: true` keeps the tab until an agent or the user closes it, instead of idle cleanup. `close` needs explicit tabs: `tab`, `tabs` or a whole `group`; a lent tab is given back to the user instead of closed. Tabs open in the background and never take focus from the user; close the ones you opened when you're done.".into(),
            input_schema: object(Value::Object(properties), &[]),
        }
    }

    async fn call(&self, _ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        let relay = relay()?;
        let action = string(&args, "action").unwrap_or_else(|| "list".into());
        match action.as_str() {
            "list" => {
                refresh_titles(&relay).await;
                let group = string(&args, "group");
                let tabs: Vec<_> = relay.tab_infos().into_iter().filter(|t| group.is_none() || t.options.group == group).collect();
                Ok(json_output(json!({ "tabs": tabs })))
            }
            "new" => {
                let chosen = chosen_id(&args)?;
                let options = TabOptions::from_args(&args)?;
                if let Some(id) = &chosen {
                    let existing = relay.st().tab_by_chosen(id);
                    if let Some(tab) = existing {
                        let changed = args.get("keepOpen").is_some_and(|v| !v.is_null()) && relay.set_keep_open(tab, options.keep_open);
                        let st = relay.st();
                        let info = relay.tab_info(&st, tab).context("The tab went away")?;
                        let mut value = serde_json::to_value(info)?;
                        value["existed"] = true.into();
                        let note = if changed {
                            format!("Tab {id} already existed, so browse didn't navigate it; keepOpen is now {}.", if options.keep_open { "on" } else { "off" })
                        } else {
                            format!("Tab {id} already existed, so browse didn't navigate it.")
                        };
                        value["note"] = note.into();
                        return Ok(json_output(value));
                    }
                    if relay.st().away_tab_by_chosen(id).is_some() {
                        bail!("`{id}` is in a browser that isn't connected right now. Open that browser and try again; browse gives the tab back when it reconnects.");
                    }
                    if !relay.st().reserve_chosen(id) {
                        bail!("{id} is being opened by another call. Try again in a moment.");
                    }
                }
                let opened = relay.create_tab(string(&args, "url").as_deref(), &options, None, chosen.as_deref()).await;
                if let Some(id) = &chosen {
                    relay.st().release_chosen(id);
                }
                let tab = opened?;
                relay.note_call_tab(tab);
                let st = relay.st();
                let info = relay.tab_info(&st, tab).context("The tab went away")?;
                drop(st);
                Ok(json_output(serde_json::to_value(info)?))
            }
            "close" => close_tabs(&relay, &args).await,
            other => bail!("Unknown action {other:?}: use list, new or close"),
        }
    }
}

/// Brings the tabs' URLs and titles up to date from the browser, briefly.
async fn refresh_titles(relay: &Arc<Relay>) {
    let tabs: Vec<i64> = relay.st().tabs.keys().copied().collect();
    let lookups = tabs.into_iter().map(|tab| async move { (tab, relay.debugger(tab, None, "Target.getTargetInfo", json!({}), Some(Duration::from_secs(2))).await) });
    for (tab, result) in futures_util::future::join_all(lookups).await {
        if let Ok(result) = result
            && let Some(entry) = relay.st().tabs.get_mut(&tab)
        {
            if let Some(url) = result["targetInfo"]["url"].as_str() {
                entry.url = url.to_string();
            }
            if let Some(title) = result["targetInfo"]["title"].as_str() {
                entry.title = title.to_string();
            }
        }
    }
}

/// A `tab` or `tabs` entry: the numeric id (possibly sent as a digit string), or a chosen id like `work-mail`.
fn picked_tab(relay: &Arc<Relay>, value: &Value) -> anyhow::Result<i64> {
    match browse_core::tab_argument(value)? {
        browse_core::TabArg::Id(tab) => Ok(tab),
        browse_core::TabArg::Chosen(chosen) => relay.resolve_chosen_tab(&chosen),
    }
}

async fn close_tabs(relay: &Arc<Relay>, args: &Value) -> anyhow::Result<ToolOutput> {
    let mut picked: Vec<i64> = Vec::new();
    if let Some(tab) = args.get("tab").filter(|v| !v.is_null()) {
        picked.push(picked_tab(relay, tab)?);
    }
    match args.get("tabs") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => {
            for tab in list.iter().filter(|v| !v.is_null()) {
                picked.push(picked_tab(relay, tab)?);
            }
        }
        Some(other) => bail!("tabs must be an array of tab ids, not {other}"),
    }
    let group = string(args, "group");
    let idle = match args.get("idleMinutes") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_f64().filter(|m| m.is_finite() && *m >= 0.0).with_context(|| format!("idleMinutes must be a number of minutes, 0 or more; got {value}"))?),
    };
    if picked.is_empty() && group.is_none() {
        bail!("Say which tabs to close: tab, tabs or group (idleMinutes only narrows the set).");
    }
    let mut forgotten = Vec::new();
    {
        let mut st = relay.st();
        if let Some(group) = &group {
            let mut members: Vec<i64> = st.tabs.values().filter(|t| t.owner == Owner::Relay && t.options.group.as_ref() == Some(group)).map(|t| t.id).collect();
            members.sort();
            picked.extend(members);
            // Tabs of the group whose browser is away close when it comes back.
            let away: Vec<(String, String, i64)> = st
                .reconnect_owners
                .iter()
                .filter(|(_, k)| k.owner == Owner::Relay && k.options.group.as_ref() == Some(group))
                .map(|(target, k)| (target.clone(), k.browser.clone(), k.tab))
                .chain(
                    st.restorable
                        .iter()
                        .filter(|(_, r)| r.options.group.as_ref() == Some(group))
                        .map(|(target, r)| (target.clone(), r.browser_key.clone(), r.tab)),
                )
                .collect();
            for (target, browser, tab) in away {
                st.reconnect_owners.remove(&target);
                st.restorable.remove(&target);
                st.tombstones.insert(target, browser);
                forgotten.push(tab);
            }
        }
        if let Some(minutes) = idle {
            let limit = Duration::from_secs_f64(minutes * 60.0);
            picked.retain(|tab| {
                st.tabs.get(tab).is_some_and(|t| !t.options.keep_open && t.last_used.elapsed() >= limit) && st.handoff_for_tab(*tab).is_none() && !st.tab_work_busy(*tab)
            });
        }
    }
    picked.dedup();
    if !forgotten.is_empty() {
        relay.schedule_persist();
    }
    let (mut closed, mut released, mut failed) = (forgotten, Vec::new(), Vec::new());
    for tab in picked {
        relay.await_tab(tab).await;
        if let Err(error) = relay.usable_tab(tab) {
            failed.push(json!({ "tab": tab, "error": error.to_string() }));
            continue;
        }
        match tokio::time::timeout(Duration::from_secs(10), relay.close_or_release(tab)).await {
            Ok(Ok("released")) => released.push(tab),
            Ok(Ok(_)) => closed.push(tab),
            Ok(Err(error)) => failed.push(json!({ "tab": tab, "error": error.to_string() })),
            Err(_) => failed.push(json!({ "tab": tab, "error": "the browser didn't close it within 10 s" })),
        }
    }
    let mut output = json!({ "closed": closed });
    if !released.is_empty() {
        output["released"] = json!(released);
        output["note"] = "Lent tabs are given back to the user, not closed.".into();
    }
    let error = !failed.is_empty() && closed.is_empty() && released.is_empty();
    if !failed.is_empty() {
        output["failed"] = json!(failed);
    }
    Ok(ToolOutput { is_error: error, ..json_output(output) })
}

fn handoff_timeout(args: &Value) -> anyhow::Result<Duration> {
    match args.get("timeoutSeconds") {
        None | Some(Value::Null) => Ok(crate::presentation::DEFAULT_HANDOFF_TIMEOUT),
        Some(value) => match value.as_u64().filter(|s| *s > 0) {
            Some(seconds) => Ok(Duration::from_secs(seconds)),
            None => bail!("timeoutSeconds must be a whole number of seconds, at least 1 (it defaults to 600); got {value}"),
        },
    }
}

fn handoff_schema(message: &str) -> Value {
    object(
        json!({
            "message": { "type": "string", "description": message },
            "tab": browse_core::tab_schema(),
            "timeoutSeconds": { "type": "integer", "minimum": 1, "description": "How long to wait for the user. Defaults to 600." },
        }),
        &["message", "tab"],
    )
}

/// The tab a handoff or demonstration runs in, checked and noted as the call's.
async fn handoff_tab(relay: &Arc<Relay>, args: &Value) -> anyhow::Result<i64> {
    let tab = browse_core::require_tab(args)?;
    relay.await_tab(tab).await;
    relay.usable_tab(tab)?;
    relay.note_call_tab(tab);
    Ok(tab)
}

struct HandoffTool;

#[async_trait]
impl Tool for HandoffTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "handoff".into(),
            description: "Ask the user to do something in a tab only a person can do (sign in, 2FA, a captcha, a payment confirmation) and wait until they finish. The tab shows a card with your message and a Continue button (the browse toolbar button also continues). Returns `outcome`: continued, timeout, closed (the tab went away) or cancelled. Never solve a captcha yourself; hand it off. Re-read the page afterwards: it has probably changed.".into(),
            input_schema: handoff_schema("What the user should do, in one or two plain sentences, e.g. \"Sign in to GitHub, then click Continue.\""),
        }
    }

    async fn call(&self, _ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        let relay = relay()?;
        let message = string(&args, "message").context("message is required")?;
        let timeout = handoff_timeout(&args)?;
        let tab = handoff_tab(&relay, &args).await?;
        let result = relay.run_handoff(tab, &message, timeout).await?;
        let output = json!({ "outcome": result.outcome, "tab": tab });
        Ok(if result.outcome == "continued" { json_output(output) } else { ToolOutput { is_error: true, ..json_output(output) } })
    }
}

struct DemonstrateTool;

#[async_trait]
impl Tool for DemonstrateTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "demonstrate".into(),
            description: "Ask the user to show you a flow in a tab, recording what they do until they click Continue: clicks (with a CSS selector, role and name), fills (password values are never recorded), checkbox and select changes, and navigations. Use it when you can't find how to do something and the user can show you. Returns `steps` (structured) and `summary` (one line each) to repeat with the page tools.".into(),
            input_schema: handoff_schema("What the user should demonstrate, e.g. \"Show me how to export the report, then click Continue.\""),
        }
    }

    async fn call(&self, _ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        let relay = relay()?;
        let message = string(&args, "message").unwrap_or_default();
        let timeout = handoff_timeout(&args)?;
        let tab = handoff_tab(&relay, &args).await?;
        let result = crate::demonstrate::demonstrate(&relay, tab, &message, timeout).await?;
        let failed = result["outcome"] != "continued";
        Ok(ToolOutput { is_error: failed, ..json_output(result) })
    }
}

struct StatusTool;

#[async_trait]
impl Tool for StatusTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "status".into(),
            description: "Report the relay, the connected browsers (ids to pass as `browser` when opening a tab), pairing state and what to do when no browser is connected (`nextStep`), and the tabs you can use.".into(),
            input_schema: object(json!({}), &[]),
        }
    }

    async fn call(&self, _ctx: ToolContext, _args: Value) -> anyhow::Result<ToolOutput> {
        let relay = relay()?;
        let extension = relay.extension_status();
        Ok(json_output(json!({
            "connected": extension["connected"],
            "pairingState": extension["pairingState"],
            "nextStep": extension.get("nextStep"),
            "relay": {
                "version": relay.version,
                "endpoint": format!("http://127.0.0.1:{}", relay.port),
                "instanceId": relay.instance_id,
                "startedAt": relay.started_at,
                "pid": std::process::id(),
            },
            "extension": extension,
            "tabs": relay.tab_summaries(),
            "autoUpdate": relay.auto_update_status(),
        })))
    }
}

struct SettingsTool;

#[async_trait]
impl Tool for SettingsTool {
    fn spec(&self) -> ToolSpec {
        let mut properties = serde_json::Map::new();
        for key in crate::settings::AGENT_KEYS {
            let spec = crate::settings::spec(key).unwrap();
            let schema = if key == "idleMinutes" {
                json!({ "anyOf": [{ "type": "integer", "enum": [10, 30, 60] }, { "type": "string", "enum": ["never"] }], "description": spec.label })
            } else {
                json!({ "type": "string", "enum": spec.values, "description": spec.label })
            };
            properties.insert(key.into(), schema);
        }
        ToolSpec {
            name: "settings".into(),
            description: format!(
                "Read or change the user's browse settings from the extension's options page: where agent tabs open (window), how they're grouped (grouping), whether browse collapses their groups by itself (groupCollapse), when untouched agent tabs close (idleMinutes), human-like input (humanInput), muting agent tabs (muteTabs) and handoff notifications (handoffNotifications). Use it only when the user asks to change how browse behaves. Without `set` it returns each setting's stored value, the value in effect and the relay environment variable that overrides it, if any. With `set` it validates every value, applies the change at once and returns what changed: tell the user what you changed. Security switches ({}) are environment-only and can't be read or changed here.",
                crate::settings::SECURITY_VARIABLES.join(", ")
            ),
            input_schema: object(json!({ "set": { "type": "object", "description": "Settings to change; omit to only read them.", "properties": properties, "additionalProperties": false } }), &[]),
        }
    }

    async fn call(&self, _ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        let relay = relay()?;
        let link = relay.st().default_link().filter(|l| l.connected()).ok_or_else(|| {
            anyhow!("The browse extension isn't connected, so its settings can't be read or changed. Ask the user to open the browser with the extension; its options page shows whether it's connected.")
        })?;
        let read = |answer: Result<Value, crate::link::RpcError>| -> anyhow::Result<Vec<(String, String)>> {
            let answer = answer.map_err(|error| match error.to_string() {
                text if text.contains("Invalid extension command") => anyhow!("The connected browse extension is too old to read or change settings from here. Update it, or change them on its options page."),
                text => anyhow!(text),
            })?;
            crate::settings::from_extension(&answer).map_err(|e| anyhow!(e))
        };
        let before = read(relay.ext_link(&link, "settings.get", Value::Null).await)?;
        let Some(set) = args.get("set").filter(|v| !v.is_null()) else {
            return Ok(json_output(json!({ "settings": crate::settings::report(&before), "note": crate::settings::security_note() })));
        };
        let requested = crate::settings::parse_changes(set).map_err(|e| anyhow!(e))?;
        let fixed: Vec<&str> = crate::settings::overrides().iter().map(|(k, _, _)| *k).collect();
        let writable: Vec<(String, String)> = requested.iter().filter(|(k, _)| !fixed.contains(&k.as_str())).cloned().collect();
        let after = if writable.is_empty() {
            before.clone()
        } else {
            read(relay.ext_link(&link, "settings.set", json!({ "values": crate::settings::to_extension(&writable) })).await)?
        };
        crate::rlog!("settings.set", changes = writable.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>().join(","));
        Ok(json_output(crate::settings::describe_changes(&before, &after, &requested)))
    }
}

/// The relay's tools. They find the relay through the call, so they only work in the relay `serve` runs.
pub fn tools() -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(StatusTool),
        Arc::new(TabsTool),
        Arc::new(HandoffTool),
        Arc::new(DemonstrateTool),
        Arc::new(SettingsTool),
    ]
}
