//! The relay's own tools: sessions, tabs, handoff, demonstrate, status, settings and tab cleanup.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use async_trait::async_trait;
use browse_core::{Tool, ToolContext, ToolOutput, ToolSpec};
use serde_json::{Value, json};

use crate::browser::SessionOptions;
use crate::relay::{Owner, Relay};
use crate::serve::{CALLER, RELAY};

fn relay() -> anyhow::Result<Arc<Relay>> {
    RELAY.try_with(Arc::clone).map_err(|_| anyhow!("This tool runs only inside the browse relay"))
}

fn caller(ctx: &ToolContext) -> String {
    CALLER.try_with(String::clone).unwrap_or_else(|_| ctx.session.clone())
}

fn json_output(value: Value) -> ToolOutput {
    ToolOutput::text(value.to_string())
}

fn string(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn strings(args: &Value, key: &str) -> anyhow::Result<Option<Vec<String>>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => items.iter().map(|v| v.as_str().map(str::to_string).context(format!("{key} must be an array of strings"))).collect::<anyhow::Result<_>>().map(Some),
        Some(_) => bail!("{key} must be an array of strings"),
    }
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

fn set_current(relay: &Relay, caller: &str, session: &str) {
    let mut st = relay.st();
    if caller == session {
        st.callers.remove(caller);
    } else {
        st.callers.insert(caller.to_string(), session.to_string());
    }
}

fn current_of(relay: &Relay, caller: &str) -> String {
    relay.st().callers.get(caller).cloned().unwrap_or_else(|| caller.to_string())
}

struct SessionTool;

#[async_trait]
impl Tool for SessionTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "session".into(),
            description: "Manage browse sessions. A session owns the tabs it opens (or adopts), its current tab, and an optional domain allowlist; every other tool acts on your current session unless you pass `session`. Actions: `new` creates a session (pass `session` to other tools to use it, or `use: true` to make it current); `list` shows every session; `use` makes an existing one current; `reset` closes its tabs and clears its state; `delete` closes its tabs and removes it; `adopt` makes a tab the user lent you (they click the browse toolbar button on it) the session's current tab; `allowlist` sets the hosts its tabs may load. Each call returns JSON with `currentSession`.".into(),
            input_schema: object(
                json!({
                    "action": { "type": "string", "enum": ["new", "list", "use", "reset", "delete", "adopt", "allowlist"], "description": "What to do." },
                    "id": { "type": "string", "description": "Session id (lowercase letters, numbers, dashes). new: optional, generated when omitted. use: required. reset, delete, adopt, allowlist: defaults to your current session." },
                    "readOnly": { "type": "boolean", "description": "new: a read-only session that can only adopt lent tabs and read them (snapshots, screenshots); input, navigation and new tabs are refused." },
                    "allowedOrigins": { "type": "array", "items": { "type": "string" }, "description": "new, allowlist: hosts or origins the session's tabs may load (example.com, *.example.com, https://app.example.com, http://localhost:3000). Navigations elsewhere are refused or sent back to about:blank; private and loopback addresses need an exact entry. allowlist with an empty list removes it." },
                    "use": { "type": "boolean", "description": "new: also make the new session your current one. Off by default, so a side session never moves your bare calls off the tab you were using." },
                    "keepVisible": { "type": "boolean", "description": "new: keep the session's own tabs focused to the page between calls, for apps that pause while hidden. Pages can notice." },
                    "browser": { "type": "string", "description": "new: which connected browser to use, by the id or name `status` lists. Defaults to the first connected one." },
                    "tabId": { "type": "integer", "description": "adopt: the lent tab's id (from `tabs` action list, under `lent`). Optional when only one tab is lent." },
                    "url": { "type": "string", "description": "adopt: pick the lent tab whose URL contains this text." },
                }),
                &["action"],
            ),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        let relay = relay()?;
        let caller = caller(&ctx);
        let action = string(&args, "action").context("action is required: new, list, use, reset, delete, adopt or allowlist")?;
        let id = string(&args, "id");
        let target = id.clone().unwrap_or_else(|| ctx.session.clone());
        let exists = |id: &str| -> anyhow::Result<()> {
            if relay.st().sessions.contains_key(id) { Ok(()) } else { bail!("Session not found: {id}. Create it with action new first.") }
        };
        let result = match action.as_str() {
            "new" => {
                let options = SessionOptions {
                    read_only: args["readOnly"] == true,
                    allowed_origins: strings(&args, "allowedOrigins")?,
                    keep_visible: args["keepVisible"] == true,
                    browser: string(&args, "browser"),
                };
                let created = relay.create_session(id.as_deref(), options)?;
                if args["use"] == true {
                    set_current(&relay, &caller, &created);
                }
                json!({ "session": relay.session_summary(&created) })
            }
            "list" => json!({ "sessions": relay.session_summaries() }),
            "use" => {
                let id = id.context("id is required for use")?;
                exists(&id)?;
                set_current(&relay, &caller, &id);
                json!({ "session": relay.session_summary(&id) })
            }
            "reset" => {
                exists(&target)?;
                relay.end_session(&target, false).await?;
                set_current(&relay, &caller, &target);
                json!({ "session": relay.session_summary(&target) })
            }
            "delete" => {
                let deleted = relay.end_session(&target, true).await?;
                let mut result = json!({ "deleted": deleted, "id": target });
                if caller == target {
                    // The caller's own default session: there is no current one until the next call starts it afresh.
                    result["currentSession"] = Value::Null;
                    result["note"] = format!("Session {target} is gone; your next call starts a fresh session with that id.").into();
                    return Ok(json_output(result));
                }
                result["currentSession"] = current_of(&relay, &caller).into();
                result
            }
            "adopt" => {
                relay.ensure_session(&target)?;
                let tab = args.get("tabId").and_then(Value::as_i64);
                if let Some(tab) = tab {
                    relay.await_tab(tab).await;
                }
                let url = string(&args, "url");
                let info = relay.adopt(&target, tab, url.as_deref())?;
                set_current(&relay, &caller, &target);
                json!({ "session": relay.session_summary(&target), "adopted": info })
            }
            "allowlist" => {
                exists(&target)?;
                let origins = strings(&args, "allowedOrigins")?.context("allowedOrigins is required for allowlist (an empty list removes it)")?;
                relay.set_allowlist(&target, &origins)?;
                json!({ "session": relay.session_summary(&target) })
            }
            other => bail!("Unknown action {other:?}: use new, list, use, reset, delete, adopt or allowlist"),
        };
        let mut result = result;
        result["currentSession"] = current_of(&relay, &caller).into();
        Ok(json_output(result))
    }
}

struct TabsTool;

#[async_trait]
impl Tool for TabsTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "tabs".into(),
            description: "List, open, select or close the current session's tabs. `list` returns the session's tabs (the current one marked active) and `lent`: tabs the user lent browse that no session has adopted yet (adopt one with the session tool). `new` opens a background tab (at `url`, else about:blank), waits for it to load and makes it current. `select` makes a tab current for the other tools. `close` closes an agent's tab; a tab the user lent is given back to them instead of closed. Tabs open in the background and never take focus from the user.".into(),
            input_schema: object(
                json!({
                    "action": { "type": "string", "enum": ["list", "new", "select", "close"], "description": "What to do. Defaults to list." },
                    "url": { "type": "string", "description": "new: the URL to open." },
                    "tabId": { "type": "integer", "description": "select, close: the tab. close defaults to the current tab." },
                    "session": { "type": "string", "description": "Optional session id; defaults to your current session." },
                }),
                &[],
            ),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        let relay = relay()?;
        let action = string(&args, "action").unwrap_or_else(|| "list".into());
        let tab = args.get("tabId").and_then(Value::as_i64);
        match action.as_str() {
            "list" => {
                let tabs = ctx.browser.tabs(&ctx.session).await?;
                let lent: Vec<Value> = {
                    let st = relay.st();
                    let mut lent: Vec<&crate::relay::Tab> = st.tabs.values().filter(|t| t.owner == Owner::User && t.session.is_none()).collect();
                    lent.sort_by_key(|t| t.id);
                    lent.iter().map(|t| json!({ "tabId": t.id, "url": t.url, "title": t.title })).collect()
                };
                Ok(json_output(json!({ "session": ctx.session, "tabs": tabs, "lent": lent })))
            }
            "new" => {
                let info = ctx.browser.open_tab(&ctx.session, string(&args, "url").as_deref()).await?;
                Ok(json_output(json!({ "session": ctx.session, "tab": info })))
            }
            "select" => {
                let tab = tab.context("tabId is required for select")?;
                ctx.browser.select_tab(&ctx.session, tab).await?;
                Ok(json_output(json!({ "session": ctx.session, "currentTab": tab })))
            }
            "close" => {
                let tab = match tab {
                    Some(tab) => tab,
                    None => relay.st().sessions.get(&ctx.session).and_then(|s| s.current).context("The session has no current tab; pass tabId")?,
                };
                relay.await_tab(tab).await;
                relay.await_tab(tab).await;
            relay.visible_tab(&ctx.session, tab)?;
                let outcome = relay.close_or_release(tab).await?;
                let current = relay.st().sessions.get(&ctx.session).and_then(|s| s.current);
                let note = match current {
                    Some(current) => format!("Tab {current} is the session's current tab now."),
                    None => "The session has no tabs left; the next call that needs one opens a new tab.".into(),
                };
                Ok(json_output(json!({ "session": ctx.session, "tabId": tab, "outcome": outcome, "currentTab": current, "note": note })))
            }
            other => bail!("Unknown action {other:?}: use list, new, select or close"),
        }
    }
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

async fn handoff_tab(relay: &Arc<Relay>, ctx: &ToolContext, args: &Value) -> anyhow::Result<i64> {
    match args.get("tabId").and_then(Value::as_i64) {
        Some(tab) => {
            relay.visible_tab(&ctx.session, tab)?;
            Ok(tab)
        }
        None => {
            let current = {
                let st = relay.st();
                st.sessions.get(&ctx.session).and_then(|s| s.current).filter(|tab| st.tabs.contains_key(tab))
            };
            match current {
                Some(tab) => Ok(tab),
                None => Ok(ctx.browser.current_tab(&ctx.session).await?.tab_id),
            }
        }
    }
}

fn handoff_schema(message: &str) -> Value {
    object(
        json!({
            "message": { "type": "string", "description": message },
            "tabId": { "type": "integer", "description": "The tab; defaults to the session's current tab." },
            "timeoutSeconds": { "type": "integer", "minimum": 1, "description": "How long to wait for the user. Defaults to 600." },
            "session": { "type": "string", "description": "Optional session id; defaults to your current session." },
        }),
        &["message"],
    )
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

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        let relay = relay()?;
        let message = string(&args, "message").context("message is required")?;
        let timeout = handoff_timeout(&args)?;
        let tab = handoff_tab(&relay, &ctx, &args).await?;
        let result = relay.run_handoff(&ctx.session, tab, &message, timeout).await?;
        let output = json!({ "outcome": result.outcome, "tabId": tab });
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

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        let relay = relay()?;
        let message = string(&args, "message").unwrap_or_default();
        let timeout = handoff_timeout(&args)?;
        let tab = handoff_tab(&relay, &ctx, &args).await?;
        let result = crate::demonstrate::demonstrate(&relay, &ctx.session, tab, &message, timeout).await?;
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
            description: "Report the relay, the connected browsers (ids to pass as `browser` to session new), pairing state and what to do when no browser is connected (`nextStep`), your current session, every session and every attached tab.".into(),
            input_schema: object(json!({}), &[]),
        }
    }

    async fn call(&self, ctx: ToolContext, _args: Value) -> anyhow::Result<ToolOutput> {
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
            "currentSession": ctx.session,
            "extension": extension,
            "sessions": relay.session_summaries(),
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
                "Read or change the user's browse settings from the extension's options page: where agent tabs open (window), how they're grouped (grouping), when untouched agent tabs close (idleMinutes), human-like input (humanInput) and handoff notifications (handoffNotifications). Use it only when the user asks to change how browse behaves. Without `set` it returns each setting's stored value, the value in effect and the relay environment variable that overrides it, if any. With `set` it validates every value, applies the change at once and returns what changed: tell the user what you changed. Security switches ({}) are environment-only and can't be read or changed here.",
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

struct TabsCleanupTool;

/// How long the browser gets to look for other agents' idle tabs.
const CLEANUP_BUDGET: Duration = Duration::from_secs(5);

#[async_trait]
impl Tool for TabsCleanupTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "tabs_cleanup".into(),
            description: "Close tabs agents opened that nobody has used for a while. Your session's own tabs close once no command used them for `idleMinutes` (default: the user's idle setting); 0 closes all of them except one waiting for a handoff. Tabs the user lent stay open (they're released instead by the session tool's reset or delete). Every other agent's tab closes only once idle for the user's setting, and never while it's pinned, active, playing audio or in use. To finish your own work, the session tool's reset or delete is more direct. browse also does this automatically after the user's idle setting (10 minutes unless they changed it).".into(),
            input_schema: object(
                json!({
                    "idleMinutes": { "type": "number", "minimum": 0, "description": "Close your session's tabs idle at least this long; 0 closes all of them. Defaults to the user's setting." },
                    "session": { "type": "string", "description": "Optional session id; defaults to your current session." },
                }),
                &[],
            ),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        let relay = relay()?;
        let minutes = match args.get("idleMinutes") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_f64().filter(|m| m.is_finite() && *m >= 0.0).with_context(|| format!("idleMinutes must be a number of minutes, 0 or more; got {value}"))?),
        };
        let links: Vec<_> = relay.st().links.iter().filter(|l| l.connected()).cloned().collect();
        if links.is_empty() {
            bail!("{}", relay.not_connected_advice());
        }
        let mut notes = Vec::new();
        // The session's own tabs: the relay knows when it last used each, so it decides, the same before and after a
        // restart. The user's setting stands in when no idleMinutes was given.
        let own_minutes = match minutes {
            Some(minutes) => Some(minutes),
            None => match tokio::time::timeout(CLEANUP_BUDGET, relay.ext_link(&links[0], "settings.get", Value::Null)).await {
                Ok(Ok(answer)) => crate::settings::from_extension(&answer)
                    .ok()
                    .and_then(|values| values.into_iter().find(|(k, _)| k == "idleMinutes"))
                    .and_then(|(_, v)| v.parse::<f64>().ok()),
                _ => {
                    notes.push("The browser didn't say what the user's idle setting is, so your session's tabs were left alone.".to_string());
                    None
                }
            },
        };
        let mut closed = Vec::new();
        if let Some(limit) = own_minutes {
            let limit = Duration::from_secs_f64(limit * 60.0);
            let idle: Vec<(i64, String, String, u64)> = {
                let st = relay.st();
                st.session_tabs(&ctx.session)
                    .into_iter()
                    .filter_map(|tab| st.tabs.get(&tab))
                    .filter(|t| t.owner == Owner::Relay && t.last_used.elapsed() >= limit && st.handoff_for_tab(t.id).is_none())
                    .map(|t| (t.id, t.title.clone(), st.link(&t.link_key).map(|l| l.id.clone()).unwrap_or_default(), t.last_used.elapsed().as_secs() / 60))
                    .collect()
            };
            for (tab, title, browser, idle_minutes) in idle {
                match tokio::time::timeout(CLEANUP_BUDGET, relay.close_or_release(tab)).await {
                    Ok(Ok(_)) => closed.push(json!({ "tabId": tab, "title": title, "idleMinutes": idle_minutes, "browser": browser })),
                    Ok(Err(error)) => notes.push(format!("Tab {tab} didn't close: {error}")),
                    Err(_) => notes.push(format!("Tab {tab} didn't close within {} s.", CLEANUP_BUDGET.as_secs())),
                }
            }
        }
        // Everyone else's tabs: the extension's own idle rules, with a bounded wait.
        for link in links {
            let mut own = json!({ "tabIds": [] });
            if let Some(minutes) = minutes {
                own["idleMinutes"] = minutes.into();
            }
            match tokio::time::timeout(CLEANUP_BUDGET, relay.ext_link(&link, "tabs.cleanup", json!({ "own": own }))).await {
                Ok(Ok(result)) => {
                    for tab in result["closed"].as_array().into_iter().flatten() {
                        let mut tab = tab.clone();
                        if let Some(local) = tab["tabId"].as_i64() {
                            tab["tabId"] = relay.st().relay_tab_id(&link.key, local).into();
                        }
                        tab["browser"] = link.id.clone().into();
                        closed.push(tab);
                    }
                }
                Ok(Err(error)) => notes.push(format!("{}: other agents' tabs weren't checked: {error}", link.id)),
                Err(_) => notes.push(format!("{}: the browser didn't finish checking other agents' tabs within {} s.", link.id, CLEANUP_BUDGET.as_secs())),
            }
        }
        let mut output = json!({ "closed": closed });
        if !notes.is_empty() {
            output["notes"] = notes.into();
        }
        Ok(json_output(output))
    }
}

/// The relay's tools. They find the relay through the call, so they only work in the relay `serve` runs.
pub fn tools() -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(StatusTool),
        Arc::new(SessionTool),
        Arc::new(TabsTool),
        Arc::new(HandoffTool),
        Arc::new(DemonstrateTool),
        Arc::new(SettingsTool),
        Arc::new(TabsCleanupTool),
    ]
}
