use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use browse_relay::pairing::{self, Transcript};
use browse_relay::paths::Paths;
use browse_relay::protocol::{EXTENSION_PROTOCOL_VERSION, stable_unpacked_origin};
use browse_relay::{ServeOptions, start};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn connect(port: u16) -> Socket {
    let mut request = format!("ws://127.0.0.1:{port}/extension").into_client_request().unwrap();
    request.headers_mut().insert("Origin", stable_unpacked_origin().parse().unwrap());
    tokio_tungstenite::connect_async(request).await.unwrap().0
}

async fn send(socket: &mut Socket, value: Value) {
    socket.send(Message::Text(value.to_string().into())).await.unwrap();
}

async fn next(socket: &mut Socket) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next()).await.unwrap().unwrap().unwrap();
        match message {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Close(frame) => {
                return json!({
                    "close": frame.as_ref().map(|f| u16::from(f.code)),
                    "reason": frame.map(|f| f.reason.to_string()),
                });
            }
            _ => continue,
        }
    }
}

fn hello(profile: &str, mode: &str, nonce: &str, ecdh: Option<&str>) -> Value {
    let mut pairing = json!({ "mode": mode, "nonce": nonce });
    if let Some(key) = ecdh {
        pairing["ecdh"] = json!(key);
    }
    json!({
        "method": "hello",
        "params": {
            "version": "0.1.5",
            "protocolVersion": EXTENSION_PROTOCOL_VERSION,
            "profileId": profile,
            "profileName": "browse",
            "browser": "Chromium",
            "pairing": pairing,
        }
    })
}

fn temp_paths(label: &str) -> Paths {
    let dir = std::env::temp_dir().join(format!("browse-local-pair-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    Paths::rooted(dir)
}

#[tokio::test]
async fn local_auto_pair_requires_env_and_issues_per_browser_token() {
    let paths = temp_paths("opt-in");
    let handle = start(
        ServeOptions { port: Some(0), paths: paths.clone(), version: "0.1.5".into(), ..ServeOptions::default() },
        browse_relay::tools(),
    )
    .await
    .unwrap();
    let port = handle.port();

    let secret = p256::ecdh::EphemeralSecret::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let ext_key = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, secret.public_key().to_encoded_point(false).as_bytes());
    let ext_nonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // Disabled by default: relay rejects mode "local" with 4006.
    unsafe { std::env::remove_var("OPENCODE_BROWSER_AUTO_PAIR_LOCAL") };
    let mut socket = connect(port).await;
    send(&mut socket, hello("profile-local-1", "local", ext_nonce, Some(&ext_key))).await;
    let refused = next(&mut socket).await;
    assert_eq!(refused["close"], 4006, "refused when env is unset: {refused}");

    // Enabled: relay completes ECDH, issues a per-browser token, and accepts subsequent token auth.
    unsafe { std::env::set_var("OPENCODE_BROWSER_AUTO_PAIR_LOCAL", "1") };
    let mut socket = connect(port).await;
    send(&mut socket, hello("profile-local-1", "local", ext_nonce, Some(&ext_key))).await;
    let challenge = next(&mut socket).await;
    assert_eq!(challenge["method"], "auth.challenge", "{challenge}");

    let relay_nonce = challenge["params"]["nonce"].as_str().unwrap();
    let relay_key = challenge["params"]["ecdh"].as_str().unwrap();
    let relay_pub_bytes = base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, relay_key).unwrap();
    let relay_pub = p256::PublicKey::from_sec1_bytes(&relay_pub_bytes).unwrap();
    let shared: [u8; 32] = (*secret.diffie_hellman(&relay_pub).raw_secret_bytes()).into();
    let transcript = Transcript {
        port,
        extension_nonce: ext_nonce.to_string(),
        relay_nonce: relay_nonce.to_string(),
        extension_key: ext_key.clone(),
        relay_key: relay_key.to_string(),
    };
    let session = pairing::pairing_session_key("local", &shared, &transcript);
    assert_eq!(challenge["params"]["proof"].as_str(), Some(pairing::session_proof(&session, "relay").as_str()));

    let wrapped = base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, challenge["params"]["wrapped"].as_str().unwrap()).unwrap();
    let mask = {
        use hmac::{Hmac, Mac};
        let mut mac = Hmac::<sha2::Sha256>::new_from_slice(&session).unwrap();
        mac.update(format!("{}|wrap", pairing::CONTEXT).as_bytes());
        mac.finalize().into_bytes()
    };
    let token_bytes: Vec<u8> = wrapped.iter().zip(mask.iter()).map(|(a, b)| a ^ b).collect();
    let token = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, token_bytes);

    let ext_proof = pairing::pairing_proof(&token, "extension", port, ext_nonce, relay_nonce);
    send(&mut socket, json!({ "method": "auth.response", "params": { "proof": ext_proof } })).await;
    send(&mut socket, json!({ "method": "ready" })).await;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while !handle.relay.st().connected() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(handle.relay.st().connected(), "browser connected after local auto-pair");
    assert_eq!(pairing::browser_token(&paths, "profile-local-1").as_deref(), Some(token.as_str()));

    // Subsequent connection authenticates with the issued per-browser token even if local auto-pair is turned back off.
    unsafe { std::env::remove_var("OPENCODE_BROWSER_AUTO_PAIR_LOCAL") };
    drop(socket);
    let mut socket2 = connect(port).await;
    let nonce2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    send(&mut socket2, hello("profile-local-1", "token", nonce2, None)).await;
    let challenge2 = next(&mut socket2).await;
    assert_eq!(challenge2["method"], "auth.challenge", "{challenge2}");
    let relay_nonce2 = challenge2["params"]["nonce"].as_str().unwrap();
    assert_eq!(
        challenge2["params"]["proof"].as_str(),
        Some(pairing::pairing_proof(&token, "relay", port, relay_nonce2, nonce2).as_str()),
    );

    handle.stop();
    let _ = std::fs::remove_dir_all(&paths.data);
}
