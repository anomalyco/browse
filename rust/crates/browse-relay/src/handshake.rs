//! The extension socket (cli/src/relay/extension-handshake.ts). Nothing but the small handshake is accepted until
//! the extension proves it holds this browser's token, or a pending code from `pair`:
//!   extension -> protocol     { protocolVersion, unpaired? }       (an older relay never sees it)
//!   extension -> hello        { profileId, name, pairing: { mode, nonce, ecdh? }, ... }
//!   relay     -> auth.challenge { nonce, proof | ecdh, protocol }
//!   extension -> auth.code    { proof }  relay -> auth.token { proof, wrapped }   (code exchange only)
//!   extension -> auth.response { proof }
//! then the extension re-announces its attached tabs (`debugger.attached`) and sends `ready`.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::link::{Link, LinkInfo};
use crate::pairing::{self, Transcript};
use crate::protocol::{self, EVENT_METHODS, EXTENSION_PROTOCOL_VERSION, MIN_EXTENSION_PROTOCOL_VERSION};
use crate::relay::Relay;
use crate::rlog;
use crate::util::{b64url, random_bytes, secrets_equal, str_field};

pub const MAX_PRE_AUTH_BYTES: usize = 64 * 1024;
pub const PRE_AUTH_TIMEOUT: Duration = Duration::from_secs(10);
pub const UNPAIRED_PRESENCE_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Token,
    Code,
    Legacy,
    Old,
}

struct Challenge {
    mode: Mode,
    hello: Value,
    key: String,
    extension_nonce: String,
    relay_nonce: String,
    expected: Option<String>,
    code: Option<([u8; 32], Transcript)>,
    issue: Option<String>,
}

struct Closing(u16, String);

fn close<T>(code: u16, reason: impl Into<String>) -> Result<T, Closing> {
    Err(Closing(code, reason.into()))
}

fn valid_nonce(nonce: &str) -> bool {
    (22..=128).contains(&nonce.len()) && nonce.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_event(message: &Value) -> bool {
    message.as_object().is_some()
        && message.get("method").and_then(Value::as_str).is_some_and(|m| EVENT_METHODS.contains(&m))
        && message.get("params").is_none_or(Value::is_object)
}

struct Handshake {
    relay: Arc<Relay>,
    peer: SocketAddr,
    origin: Option<String>,
    challenge: Option<Challenge>,
    out: mpsc::UnboundedSender<Message>,
}

impl Handshake {
    fn send(&self, value: Value) {
        let _ = self.out.send(Message::Text(value.to_string().into()));
    }

    fn refused(&self) {
        let mut st = self.relay.st();
        st.handshake.pairing_failures += 1;
        st.handshake.last_refused = Some(Instant::now());
    }

    fn refuse<T>(&self, reason: &str, mode: Mode, text: &str) -> Result<T, Closing> {
        self.refused();
        rlog!("extension.rejected", reason = reason, mode = format!("{mode:?}").to_lowercase(), profile = self.profile_name());
        close(4006, text)
    }

    fn profile_name(&self) -> Option<String> {
        self.challenge.as_ref().and_then(|c| str_field(&c.hello["params"], "profileName").map(str::to_string))
    }

    /// One pre-pairing message; Ok(Some(hello)) once the extension proved itself.
    fn step(&mut self, message: Value) -> Result<Option<(Value, String)>, Closing> {
        if !is_event(&message) {
            return close(4002, "Extension hello required");
        }
        let method = message["method"].as_str().unwrap_or("").to_string();
        if self.challenge.is_none() {
            if method == "protocol" || method == "hello" {
                let compatibility = protocol::compatibility(message["params"].get("protocolVersion"));
                if !compatibility.compatible {
                    self.relay.st().handshake.mismatch = Some((compatibility.version, self.origin.clone()));
                    let side = if compatibility.version.unwrap_or(0) > EXTENSION_PROTOCOL_VERSION { "extension-newer" } else { "extension-older" };
                    return close(4003, format!("Extension protocol incompatible: {side}"));
                }
                self.relay.st().handshake.mismatch = None;
                if method == "protocol" {
                    if message["params"]["unpaired"] == true {
                        self.relay.st().handshake.last_unpaired = Some(Instant::now());
                        return close(1000, "Waiting for pairing");
                    }
                    return Ok(None);
                }
            }
            self.challenge = Some(self.challenge_extension(&message)?);
            return Ok(None);
        }
        if self.challenge.as_ref().is_some_and(|c| c.code.is_some()) {
            self.exchange_code(&message)?;
            return Ok(None);
        }
        let challenge = self.challenge.take().expect("checked above");
        let proof = (method == "auth.response").then(|| str_field(&message["params"], "proof")).flatten();
        if !challenge.expected.as_deref().is_some_and(|e| secrets_equal(e, proof)) {
            self.refused();
            rlog!("extension.rejected", reason = "pairing failed", mode = format!("{:?}", challenge.mode).to_lowercase());
            return close(4006, "Pairing failed: this browser isn't paired with this relay");
        }
        if let Some(token) = &challenge.issue {
            let _ = pairing::issue_browser_token(&self.relay.paths, &challenge.key, Some(token.clone()), None);
        }
        {
            let mut st = self.relay.st();
            st.handshake.last_unpaired = None;
            st.handshake.last_refused = None;
        }
        Ok(Some((challenge.hello, challenge.key)))
    }

    fn challenge_extension(&self, message: &Value) -> Result<Challenge, Closing> {
        let port = self.relay.port;
        if message["method"] != "hello" {
            return close(4002, "Extension hello required");
        }
        let params = &message["params"];
        let pairing = &params["pairing"];
        let Some(extension_nonce) = str_field(pairing, "nonce").map(str::to_string) else {
            self.refused();
            rlog!("extension.rejected", reason = "no pairing (extension too old)", version = str_field(params, "version"));
            return close(4005, "Pairing required: update browse");
        };
        if !valid_nonce(&extension_nonce) {
            return close(4002, "Invalid pairing nonce");
        }
        let mode = match str_field(pairing, "mode") {
            Some("token") => Mode::Token,
            Some("code") => Mode::Code,
            Some("legacy") => Mode::Legacy,
            _ => Mode::Old,
        };
        let key = str_field(params, "profileId").map(str::to_string);
        let valid_key = key.as_deref().is_some_and(|k| (1..=64).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
        if mode != Mode::Old && !valid_key {
            return close(4002, "Invalid profile id");
        }
        let relay_nonce = b64url(&random_bytes::<32>());
        let protocol = json!({ "version": EXTENSION_PROTOCOL_VERSION, "min": MIN_EXTENSION_PROTOCOL_VERSION });
        let mut challenge = Challenge {
            mode,
            hello: message.clone(),
            key: key.unwrap_or_default(),
            extension_nonce: extension_nonce.clone(),
            relay_nonce: relay_nonce.clone(),
            expected: None,
            code: None,
            issue: None,
        };
        let paths = &self.relay.paths;
        match mode {
            Mode::Token => {
                let Some(token) = pairing::browser_token(paths, &challenge.key) else {
                    return self.refuse("not paired", mode, "Not paired: run `pair` on the relay's computer and enter the code");
                };
                let proof = pairing::pairing_proof(&token, "relay", port, &relay_nonce, &extension_nonce);
                self.send(json!({ "method": "auth.challenge", "params": { "nonce": relay_nonce, "proof": proof, "protocol": protocol } }));
                challenge.expected = Some(pairing::pairing_proof(&token, "extension", port, &extension_nonce, &relay_nonce));
            }
            Mode::Old => {
                let Some(code) = pairing::legacy_pairing_code(paths) else {
                    return self.refuse("old extension, no shared code", mode, "Pairing failed: update browse, then pair it with the code `pair` prints");
                };
                let proof = pairing::legacy_pairing_proof(&code, "relay", port, &relay_nonce, &extension_nonce);
                self.send(json!({ "method": "auth.challenge", "params": { "nonce": relay_nonce, "proof": proof, "protocol": protocol } }));
                challenge.expected = Some(pairing::legacy_pairing_proof(&code, "extension", port, &extension_nonce, &relay_nonce));
            }
            Mode::Code | Mode::Legacy => {
                let extension_key = str_field(pairing, "ecdh").unwrap_or("").to_string();
                let Some(exchange) = pairing::ecdh_exchange(&extension_key) else { return close(4002, "Invalid pairing key") };
                let transcript = Transcript { port, extension_nonce: extension_nonce.clone(), relay_nonce: relay_nonce.clone(), extension_key, relay_key: exchange.public_key.clone() };
                if mode == Mode::Code {
                    self.send(json!({ "method": "auth.challenge", "params": { "nonce": relay_nonce, "ecdh": exchange.public_key, "protocol": protocol } }));
                    challenge.code = Some((exchange.secret, transcript));
                } else {
                    let Some(legacy) = pairing::legacy_pairing_code(paths) else {
                        return self.refuse("shared code retired", mode, "The old pairing code is no longer accepted: run `pair` and enter the new code");
                    };
                    let session = pairing::pairing_session_key(&legacy, &exchange.secret, &transcript);
                    let token = pairing::new_browser_token();
                    rlog!("extension.pairing", mode = "legacy");
                    self.send(json!({ "method": "auth.challenge", "params": {
                        "nonce": relay_nonce, "ecdh": exchange.public_key, "proof": pairing::session_proof(&session, "relay"),
                        "wrapped": pairing::wrap_token(&session, &token), "protocol": protocol,
                    } }));
                    challenge.expected = Some(pairing::pairing_proof(&token, "extension", port, &extension_nonce, &relay_nonce));
                    challenge.issue = Some(token);
                }
            }
        }
        Ok(challenge)
    }

    fn exchange_code(&mut self, message: &Value) -> Result<(), Closing> {
        let paths = self.relay.paths.clone();
        let challenge = self.challenge.as_mut().expect("a code challenge is pending");
        let (secret, transcript) = challenge.code.take().expect("checked by the caller");
        let proof = (message["method"] == "auth.code").then(|| str_field(&message["params"], "proof")).flatten();
        let found = proof.and_then(|proof| {
            pairing::pending_code_keys(&paths)
                .into_iter()
                .map(|key| {
                    let session = pairing::pairing_session_key(&key, &secret, &transcript);
                    (key, session)
                })
                .find(|(_, session)| secrets_equal(&pairing::session_proof(session, "extension"), Some(proof)))
        });
        let Some((code_key, session)) = found else {
            self.refused();
            let exhausted = pairing::record_pairing_failure(&paths);
            rlog!("extension.rejected", reason = "wrong pairing code", exhausted = exhausted, profile = self.profile_name());
            return close(4006, if exhausted { "Too many wrong codes: run `pair` for a new one" } else { "Pairing failed: that code is wrong, used or expired" });
        };
        let receipt = pairing::consume_pairing_code(&paths, &code_key);
        let challenge = self.challenge.as_mut().expect("still pending");
        let token = pairing::issue_browser_token(&paths, &challenge.key, None, receipt).map_err(|e| Closing(1011, format!("Could not store the token: {e}")))?;
        rlog!("extension.paired", profile = str_field(&challenge.hello["params"], "profileName"));
        let wrapped = pairing::wrap_token(&session, &token);
        let proof = pairing::session_proof(&session, "relay");
        challenge.expected = Some(pairing::pairing_proof(&token, "extension", transcript.port, &challenge.extension_nonce, &challenge.relay_nonce));
        self.send(json!({ "method": "auth.token", "params": { "proof": proof, "wrapped": wrapped } }));
        Ok(())
    }

    fn accept(&self, hello: &Value, key: String) -> Arc<Link> {
        let relay = &self.relay;
        let params = &hello["params"];
        let local = crate::origins::is_local_peer(&self.peer);
        let computer = if local { crate::util::short_hostname() } else { self.peer.ip().to_string() };
        let named: String = str_field(params, "name").map(str::trim).unwrap_or("").chars().take(60).collect();
        let browser = str_field(params, "browser").map(str::trim).filter(|b| !b.is_empty()).unwrap_or("Browser");
        let name = if named.is_empty() { format!("{browser} on {computer}") } else { named };
        let capabilities: HashSet<String> = params["capabilities"]
            .as_array()
            .map(|list| list.iter().filter_map(Value::as_str).filter(|c| c.len() <= 64).map(str::to_string).collect())
            .unwrap_or_default();
        let (link, replaced) = {
            let mut st = relay.st();
            let id = st.identify(&relay.paths, &key, &name);
            st.generation += 1;
            let link = Arc::new(Link::new(
                LinkInfo {
                    key: key.clone(),
                    id,
                    name,
                    generation: st.generation,
                    version: str_field(params, "version").map(str::to_string),
                    build: str_field(params, "build").map(str::to_string),
                    origin: self.origin.clone(),
                    protocol: protocol::compatibility(params.get("protocolVersion")),
                    capabilities,
                    local,
                },
                self.out.clone(),
                relay.timeouts.clone(),
            ));
            let replaced = st.links.iter().find(|l| l.key == key).cloned();
            (link, replaced)
        };
        if let Some(replaced) = replaced {
            replaced.close(4001, "Extension replaced");
            relay.link_closed(&replaced, "Extension replaced");
        }
        relay.st().links.push(link.clone());
        rlog!(
            "extension.connected",
            browser = link.id.clone(),
            name = link.name.clone(),
            version = link.version.clone(),
            build = link.build.clone(),
            protocol = link.protocol.version,
            generation = link.generation,
        );
        pairing::touch_browser_pairing(&relay.paths, &key, &link.id, &link.name);
        relay.browsers_changed();
        link
    }
}

/// Serves one extension WebSocket until it closes.
pub async fn run<S>(relay: Arc<Relay>, ws: WebSocketStream<S>, peer: SocketAddr, origin: Option<String>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut stream) = ws.split();
    let (out, mut outgoing) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing.recv().await {
            let closing = matches!(message, Message::Close(_));
            if sink.send(message).await.is_err() || closing {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let mut handshake = Handshake { relay: relay.clone(), peer, origin, challenge: None, out: out.clone() };
    let mut link: Option<Arc<Link>> = None;
    let deadline = tokio::time::sleep(PRE_AUTH_TIMEOUT);
    tokio::pin!(deadline);
    let mut close_reason = String::from("closed");
    let stopped = relay.stopped.notified();
    tokio::pin!(stopped);
    stopped.as_mut().enable();
    loop {
        let next = tokio::select! {
            next = stream.next() => next,
            _ = &mut deadline, if link.is_none() => {
                rlog!("extension.rejected", reason = "handshake timeout");
                let _ = out.send(close_frame(1008, "Handshake timed out"));
                break;
            }
            _ = &mut stopped => {
                let _ = out.send(close_frame(1001, "Relay closed"));
                break;
            }
        };
        let Some(Ok(message)) = next else { break };
        match message {
            Message::Text(text) => {
                if let Some(link) = &link {
                    crate::extension::handle(&relay, link, &text);
                    continue;
                }
                if text.len() > MAX_PRE_AUTH_BYTES {
                    rlog!("extension.rejected", reason = "message too large before pairing", bytes = text.len());
                    let _ = out.send(close_frame(1009, "Message too large before pairing"));
                    break;
                }
                let Ok(message) = serde_json::from_str::<Value>(&text) else {
                    let _ = out.send(close_frame(4002, "Extension hello required"));
                    break;
                };
                match handshake.step(message) {
                    Ok(None) => {}
                    Ok(Some((hello, key))) => link = Some(handshake.accept(&hello, key)),
                    Err(Closing(code, reason)) => {
                        let _ = out.send(close_frame(code, &reason));
                        break;
                    }
                }
            }
            Message::Binary(bytes) => {
                if link.is_none() {
                    let reason = if bytes.len() > MAX_PRE_AUTH_BYTES { (1009, "Message too large before pairing") } else { (4002, "Extension hello required") };
                    let _ = out.send(close_frame(reason.0, reason.1));
                    break;
                }
            }
            Message::Pong(_) => {
                if let Some(link) = &link {
                    link.pong.notify_one();
                }
            }
            Message::Close(frame) => {
                close_reason = frame.map(|f| format!("{} {}", u16::from(f.code), f.reason)).unwrap_or_else(|| "closed".into());
                break;
            }
            _ => {}
        }
    }
    if let Some(link) = link {
        relay.link_closed(&link, &close_reason);
    }
    let _ = out.send(close_frame(1000, ""));
    drop(handshake);
    drop(out);
    let mut writer = writer;
    if tokio::time::timeout(Duration::from_secs(2), &mut writer).await.is_err() {
        writer.abort();
    }
}

fn close_frame(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.to_string().into() }))
}
