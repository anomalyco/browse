//! Capture tools against a scripted CDP connection: cross-session requests, closed tabs, console filtering.

use serde_json::{Value, json};

use crate::testing::{FakeCdp, call, context, settle};

fn tool(name: &str) -> std::sync::Arc<dyn browse_core::Tool> {
    crate::tools().into_iter().find(|tool| tool.spec().name == name).unwrap()
}

fn private_root(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("browse-capture-unit-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::fs::canonicalize(root).unwrap()
}

#[tokio::test]
async fn out_of_process_iframe_documents_complete_across_sessions() {
    let cdp = FakeCdp::new();
    cdp.reply("Network.getResponseBody", json!({ "body": "{\"ok\":true}", "base64Encoded": false }));
    let ctx = context(cdp.clone(), vec![]);
    let network = tool("network");
    let (error, _) = call(&ctx, network.as_ref(), json!({ "action": "start" })).await;
    assert!(!error);
    // The iframe's document is requested on the parent's session and answered on the iframe's own session.
    cdp.emit(
        "Network.requestWillBeSent",
        json!({ "requestId": "LOADER1", "type": "Document", "request": { "url": "https://other.test/frame", "method": "GET", "headers": {} } }),
        None,
    );
    cdp.emit(
        "Target.attachedToTarget",
        json!({ "sessionId": "child", "targetInfo": { "type": "iframe", "url": "https://other.test/frame" } }),
        None,
    );
    let html = json!({ "status": 200, "statusText": "OK", "headers": { "content-type": "text/html" }, "mimeType": "text/html" });
    cdp.emit("Network.responseReceived", json!({ "requestId": "LOADER1", "response": html }), Some("child"));
    cdp.emit("Network.dataReceived", json!({ "requestId": "LOADER1", "dataLength": 1234 }), Some("child"));
    cdp.emit("Network.loadingFinished", json!({ "requestId": "LOADER1", "encodedDataLength": 900 }), Some("child"));
    // A JSON request inside the iframe: its body is fetched from the iframe's session.
    cdp.emit(
        "Network.requestWillBeSent",
        json!({ "requestId": "7.1", "type": "Fetch", "request": { "url": "https://other.test/api", "method": "GET", "headers": {} } }),
        Some("child"),
    );
    let api = json!({ "status": 200, "statusText": "OK", "headers": { "content-type": "application/json" }, "mimeType": "application/json" });
    cdp.emit("Network.responseReceived", json!({ "requestId": "7.1", "response": api }), Some("child"));
    cdp.emit("Network.loadingFinished", json!({ "requestId": "7.1" }), Some("child"));
    settle().await;
    let (error, status) = call(&ctx, network.as_ref(), json!({ "action": "status" })).await;
    assert!(!error);
    assert_eq!(status["pendingCount"], json!(0), "{status}");
    let (error, stopped) = call(&ctx, network.as_ref(), json!({ "action": "stop" })).await;
    assert!(!error, "{stopped}");
    let exchanges = stopped["exchanges"].as_array().unwrap();
    assert_eq!(exchanges.len(), 2, "{stopped}");
    let document = &exchanges[0];
    assert_eq!(document["response"]["status"], json!(200), "{document}");
    assert!(document.get("failure").is_none(), "{document}");
    // HTML isn't returned, so it is never fetched and doesn't count against the body budget.
    assert_eq!(document["response"]["body"]["size"], json!(1234));
    assert_eq!(document["response"]["body"]["truncated"], json!(false));
    assert!(document["response"]["body"]["omitted"].as_str().unwrap().starts_with("not returned"));
    assert_eq!(exchanges[1]["response"]["body"]["text"], json!("{\"ok\":true}"));
    let fetched = cdp.calls("Network.getResponseBody");
    assert_eq!(fetched.len(), 1, "{fetched:?}");
    assert_eq!(fetched[0].1.as_deref(), Some("child"));
    assert_eq!(stopped["capturedBodyBytes"], json!(11));
    assert_eq!(cdp.calls("Network.enable").iter().filter(|(_, session)| session.as_deref() == Some("child")).count(), 1);
}

#[tokio::test]
async fn captures_end_when_their_tab_closes() {
    let cdp = FakeCdp::new();
    let root = private_root("closed");
    let ctx = context(cdp.clone(), vec![root.clone()]);
    let (network, console, recording) = (tool("network"), tool("console"), tool("recording"));
    assert!(!call(&ctx, network.as_ref(), json!({ "action": "start" })).await.0);
    assert!(!call(&ctx, console.as_ref(), json!({ "action": "start" })).await.0);
    let (error, started) = call(&ctx, recording.as_ref(), json!({ "action": "start", "path": "rec/x.mkv" })).await;
    assert!(!error, "{started}");
    assert!(root.join("rec").is_dir());
    cdp.emit(
        "Network.requestWillBeSent",
        json!({ "requestId": "1", "type": "XHR", "request": { "url": "https://a.test/", "method": "GET", "headers": {} } }),
        None,
    );
    settle().await;
    cdp.close();
    settle().await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let (_, status) = call(&ctx, network.as_ref(), json!({ "action": "status" })).await;
    assert_eq!(status["active"], json!(false), "{status}");
    assert!(status["ended"].as_str().unwrap().contains("tab closed"), "{status}");
    let (error, stopped) = call(&ctx, network.as_ref(), json!({ "action": "stop" })).await;
    assert!(!error, "{stopped}");
    assert!(stopped["endedBecause"].as_str().unwrap().contains("tab closed"));
    assert_eq!(stopped["exchanges"][0]["failure"].as_str().map(|f| f.contains("tab closed")), Some(true), "{stopped}");

    let (error, read) = call(&ctx, console.as_ref(), json!({ "action": "read" })).await;
    assert!(!error, "{read}");
    assert!(read["ended"].as_str().unwrap().contains("tab closed"), "{read}");

    let (_, status) = call(&ctx, recording.as_ref(), json!({ "action": "status" })).await;
    assert!(status["endedBecause"].as_str().unwrap().contains("tab closed"), "{status}");
    // No frame was ever captured: the partial file and the folder made for it are gone.
    assert!(!root.join("rec").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn recording_cancel_removes_the_folder_it_made() {
    let cdp = FakeCdp::new();
    let root = private_root("cancel");
    let ctx = context(cdp.clone(), vec![root.clone()]);
    let recording = tool("recording");
    let (error, started) = call(&ctx, recording.as_ref(), json!({ "action": "start", "path": "a/b/x.mkv" })).await;
    assert!(!error, "{started}");
    assert_eq!(started["width"], json!(1280));
    assert!(root.join("a/b").is_dir());
    let (_, cancelled) = call(&ctx, recording.as_ref(), json!({ "action": "cancel" })).await;
    assert_eq!(cancelled["cancelled"], json!(true));
    assert!(!root.join("a").exists());
    std::fs::remove_dir_all(root).unwrap();
}

fn log(text: &str, context: i64) -> Value {
    json!({ "type": "log", "args": [{ "type": "string", "value": text }], "executionContextId": context })
}

#[tokio::test]
async fn console_reads_clear_only_what_they_return() {
    let cdp = FakeCdp::new();
    let ctx = context(cdp.clone(), vec![]);
    let console = tool("console");
    assert!(!call(&ctx, console.as_ref(), json!({ "action": "start" })).await.0);
    // browse's own isolated world: its messages are left out.
    cdp.emit("Runtime.executionContextCreated", json!({ "context": { "id": 5, "auxData": { "isDefault": false, "type": "isolated" } } }), None);
    cdp.emit("Runtime.consoleAPICalled", log("browse internal", 5), None);
    cdp.emit("Runtime.consoleAPICalled", log("first", 1), None);
    cdp.emit(
        "Runtime.consoleAPICalled",
        json!({ "type": "error", "args": [{ "type": "string", "value": "bad" }], "executionContextId": 1 }),
        None,
    );
    cdp.emit(
        "Log.entryAdded",
        json!({ "entry": { "source": "network", "level": "error", "text": "Failed to load resource: 404", "url": "https://a.test/x.png" } }),
        None,
    );
    cdp.emit("Log.entryAdded", json!({ "entry": { "source": "violation", "level": "verbose", "text": "[Violation] slow" } }), None);
    cdp.emit("Target.attachedToTarget", json!({ "sessionId": "c1", "targetInfo": { "type": "iframe", "url": "https://b.test/" } }), None);
    cdp.emit("Runtime.consoleAPICalled", log("from iframe", 1), Some("c1"));
    settle().await;
    assert!(cdp.calls("Runtime.enable").iter().any(|(_, session)| session.as_deref() == Some("c1")));
    assert!(cdp.calls("Log.enable").iter().any(|(_, session)| session.is_none()));

    let (_, errors) = call(&ctx, console.as_ref(), json!({ "action": "read", "errorsOnly": true })).await;
    let texts: Vec<&str> = errors["entries"].as_array().unwrap().iter().map(|entry| entry["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["bad", "Failed to load resource: 404"], "{errors}");
    assert_eq!(errors["entries"][1]["source"], json!("network"));
    let (_, rest) = call(&ctx, console.as_ref(), json!({ "action": "read" })).await;
    let entries = rest["entries"].as_array().unwrap();
    let texts: Vec<&str> = entries.iter().map(|entry| entry["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["first", "from iframe"], "{rest}");
    assert_eq!(entries[1]["target"], json!("iframe"));
    let (_, empty) = call(&ctx, console.as_ref(), json!({ "action": "read" })).await;
    assert_eq!(empty["entries"], json!([]));
}
