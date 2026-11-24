//! Driver behavior against a scripted fake browser.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use browse_core::{
    CallOptions, CloseReason, DialogKind, DriverError, Evaluated, FrameId, LoadState, PageEvent, Realm, Returns,
    TabDriver, TargetId, World,
};
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::{BiDiError, BiDiEvent, BiDiTabDriver, BiDiTransport};

type Handler = Box<dyn Fn(&str, &Value) -> Option<Result<Value, BiDiError>> + Send + Sync>;

/// Answers commands with `handler` (None: never answers) and records them.
struct Fake {
    events: Mutex<Option<broadcast::Sender<BiDiEvent>>>,
    sent: Mutex<Vec<(String, Value)>>,
    handler: Handler,
}

impl Fake {
    fn new(handler: impl Fn(&str, &Value) -> Option<Result<Value, BiDiError>> + Send + Sync + 'static) -> Arc<Fake> {
        Arc::new(Fake { events: Mutex::new(Some(broadcast::channel(256).0)), sent: Mutex::default(), handler: Box::new(handler) })
    }

    fn emit(&self, method: &str, params: Value) {
        if let Some(sender) = self.events.lock().unwrap().as_ref() {
            let _ = sender.send(BiDiEvent { method: method.into(), params });
        }
    }

    /// Ends the event stream, as a closed socket does.
    fn close(&self) {
        self.events.lock().unwrap().take();
    }

    fn sent(&self, method: &str) -> Vec<Value> {
        self.sent.lock().unwrap().iter().filter(|(m, _)| m == method).map(|(_, p)| p.clone()).collect()
    }
}

#[async_trait]
impl BiDiTransport for Fake {
    async fn send(&self, method: &str, params: Value) -> Result<Value, BiDiError> {
        self.sent.lock().unwrap().push((method.to_string(), params.clone()));
        match method {
            "session.subscribe" => return Ok(json!({ "subscription": "sub-1" })),
            "browsingContext.getTree" => {
                return Ok(json!({ "contexts": [{ "context": "top", "url": "http://a/", "parent": null, "children": [
                    { "context": "child", "url": "http://b/", "children": [] }
                ] }] }));
            }
            _ => {}
        }
        match (self.handler)(method, &params) {
            Some(result) => result,
            None => std::future::pending().await,
        }
    }

    fn events(&self) -> broadcast::Receiver<BiDiEvent> {
        match self.events.lock().unwrap().as_ref() {
            Some(sender) => sender.subscribe(),
            None => broadcast::channel(1).1,
        }
    }
}

fn command(error: &str, message: &str) -> BiDiError {
    BiDiError::Command { error: error.into(), message: message.into() }
}

async fn attach(fake: &Arc<Fake>) -> Arc<BiDiTabDriver> {
    BiDiTabDriver::attach(fake.clone(), TargetId::from("top")).await.unwrap()
}

async fn next(events: &mut broadcast::Receiver<PageEvent>) -> PageEvent {
    tokio::time::timeout(Duration::from_secs(2), events.recv()).await.expect("an event").unwrap()
}

#[tokio::test]
async fn attach_reads_the_frame_tree_and_subscribes() {
    let fake = Fake::new(|_, _| Some(Ok(json!({}))));
    let tab = attach(&fake).await;
    let frames = tab.frames().await.unwrap();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0].id, FrameId::from("top"));
    assert_eq!(frames[1].parent, Some(FrameId::from("top")));
    assert_eq!(frames[1].url, "http://b/");
    assert_ne!(frames[0].document, frames[1].document);
    let subscribe = &fake.sent("session.subscribe")[0];
    assert_eq!(subscribe["contexts"], json!(["top"]));
    assert!(subscribe["events"].as_array().unwrap().contains(&json!("browsingContext")));
}

#[tokio::test]
async fn lifecycle_events_become_page_events() {
    let fake = Fake::new(|_, _| Some(Ok(json!({}))));
    let tab = attach(&fake).await;
    let mut events = tab.events();
    let before = tab.frames().await.unwrap()[0].document;

    fake.emit("browsingContext.navigationStarted", json!({ "context": "top", "navigation": "n1", "url": "http://c/" }));
    assert!(matches!(next(&mut events).await, PageEvent::NavigationStarted { navigation: Some(n), .. } if n.as_str() == "n1"));
    fake.emit("browsingContext.contextDestroyed", json!({ "context": "child", "parent": "top" }));
    assert!(matches!(next(&mut events).await, PageEvent::FrameDetached(f) if f.as_str() == "child"));
    fake.emit("browsingContext.navigationCommitted", json!({ "context": "top", "navigation": "n1", "url": "about:neterror?e=dnsNotFound&u=http%3A//c/&c=UTF-8" }));
    let document = match next(&mut events).await {
        PageEvent::Committed { document, url, navigation, .. } => {
            assert_eq!(url, "http://c/");
            assert_eq!(navigation.unwrap().as_str(), "n1");
            document
        }
        other => panic!("{other:?}"),
    };
    assert!(document > before);
    fake.emit("browsingContext.domContentLoaded", json!({ "context": "top", "navigation": "n1" }));
    assert!(matches!(next(&mut events).await, PageEvent::Loaded { state: LoadState::DomContentLoaded, document: d, .. } if d == document));
    fake.emit("browsingContext.contextCreated", json!({ "context": "kid", "parent": "top", "url": "about:blank" }));
    assert!(matches!(next(&mut events).await, PageEvent::FrameAttached(f) if f.id.as_str() == "kid"));
    fake.emit("browsingContext.historyUpdated", json!({ "context": "top", "url": "http://c/pushed" }));
    assert!(matches!(next(&mut events).await, PageEvent::UrlChanged { url, .. } if url == "http://c/pushed"));
    fake.emit("browsingContext.contextCreated", json!({ "context": "popup", "parent": null, "originalOpener": "top", "url": "about:blank" }));
    assert!(matches!(next(&mut events).await, PageEvent::PopupOpened { .. }));
    fake.emit("browsingContext.navigationStarted", json!({ "context": "top", "navigation": "n2", "url": "http://d/" }));
    next(&mut events).await;
    fake.emit("browsingContext.downloadWillBegin", json!({ "context": "top", "navigation": "n2", "url": "http://d/" }));
    assert!(matches!(next(&mut events).await, PageEvent::NavigationAborted { .. }));
    fake.emit("browsingContext.contextDestroyed", json!({ "context": "top", "parent": null }));
    assert!(matches!(next(&mut events).await, PageEvent::Closed(CloseReason::Closed)));
    assert!(matches!(tab.frames().await, Err(DriverError::Closed(CloseReason::Closed))));
}

#[tokio::test]
async fn dialogs_are_answered_in_the_frame_that_opened_them() {
    let fake = Fake::new(|_, _| Some(Ok(json!({}))));
    let tab = attach(&fake).await;
    let mut events = tab.events();
    fake.emit(
        "browsingContext.userPromptOpened",
        json!({ "context": "child", "type": "prompt", "message": "Name?", "defaultValue": "Dax", "handler": "ignore" }),
    );
    match next(&mut events).await {
        PageEvent::DialogOpened(dialog) => {
            assert_eq!(dialog.kind, DialogKind::Prompt);
            assert_eq!(dialog.default_prompt, "Dax");
            assert_eq!(dialog.url, "http://b/");
        }
        other => panic!("{other:?}"),
    }
    tab.answer_dialog(true, Some("Zed")).await.unwrap();
    let answered = &fake.sent("browsingContext.handleUserPrompt")[0];
    assert_eq!(answered["context"], "child");
    assert_eq!(answered["userText"], "Zed");
}

#[tokio::test]
async fn awaited_scripts_end_when_their_document_goes_away() {
    // Firefox never answers a call awaiting a promise once its document navigated away.
    let fake = Fake::new(|method, _| match method {
        "script.evaluate" | "script.callFunction" => None,
        _ => Some(Ok(json!({}))),
    });
    let tab = attach(&fake).await;
    let realm = Realm { frame: FrameId::from("top"), world: World::Isolated };
    let opts = CallOptions { returns: Returns::Json, await_promise: true, user_activation: false };
    let pending = tab.evaluate(&realm, "new Promise(() => {})", opts);
    let navigate = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        fake.emit("browsingContext.navigationCommitted", json!({ "context": "top", "navigation": "n1", "url": "http://c/" }));
    };
    let (result, _) = tokio::time::timeout(Duration::from_secs(2), async { tokio::join!(pending, navigate) }).await.unwrap();
    assert!(matches!(result, Err(DriverError::Stale)), "{result:?}");
    let sent = &fake.sent("script.evaluate")[0];
    assert_eq!(sent["target"], json!({ "context": "top", "sandbox": "__browse" }));
    assert_eq!(sent["resultOwnership"], "none");
}

#[tokio::test]
async fn refs_encode_nodes_and_objects_and_go_stale_without_a_round_trip() {
    let fake = Fake::new(|method, params| match method {
        "script.evaluate" if params["resultOwnership"] == "root" => {
            Some(Ok(json!({ "type": "success", "result": { "type": "node", "sharedId": "s1", "handle": "h1" } })))
        }
        "script.callFunction" => Some(Ok(json!({ "type": "success", "result": { "type": "string", "value": "ok" } }))),
        _ => Some(Ok(json!({}))),
    });
    let tab = attach(&fake).await;
    let realm = Realm { frame: FrameId::from("top"), world: World::Isolated };
    let node = match tab.evaluate(&realm, "document.body", CallOptions { returns: Returns::Ref, ..CallOptions::default() }).await {
        Ok(Ok(Evaluated::Node(node))) => node,
        other => panic!("{other:?}"),
    };
    let main = tab.adopt(&node, World::Main).await.unwrap();
    assert_eq!(main.world, World::Main);
    let called = tab
        .call(&browse_core::Receiver::Ref(main.clone()), "function () { return 1 }", &[browse_core::Arg::Ref(node.clone())], CallOptions::default())
        .await;
    assert!(matches!(called, Ok(Ok(Evaluated::Json(v))) if v == "ok"));
    let sent = &fake.sent("script.callFunction")[0];
    assert_eq!(sent["this"], json!({ "sharedId": "s1" }));
    assert_eq!(sent["arguments"], json!([{ "sharedId": "s1" }]));
    assert_eq!(sent["target"], json!({ "context": "top" }));

    tab.release(vec![node.clone()]).await;
    let disowned = &fake.sent("script.disown")[0];
    assert_eq!(disowned["handles"], json!(["h1"]));

    fake.emit("browsingContext.navigationCommitted", json!({ "context": "top", "navigation": "n1", "url": "http://c/" }));
    tokio::time::sleep(Duration::from_millis(50)).await;
    let calls = fake.sent("script.callFunction").len();
    let stale = tab.call(&browse_core::Receiver::Ref(node), "function () {}", &[], CallOptions::default()).await;
    assert!(matches!(stale, Err(DriverError::Stale)));
    assert_eq!(fake.sent("script.callFunction").len(), calls, "no round-trip for a stale ref");
}

#[tokio::test]
async fn commands_map_errors_by_code() {
    let fake = Fake::new(|method, _| match method {
        "browsingContext.traverseHistory" => Some(Err(command("no such history entry", "delta 5"))),
        "browsingContext.navigate" => Some(Err(command("unknown error", "Error: NS_BINDING_ABORTED"))),
        "network.getData" => Some(Err(command("no such network data", ""))),
        "input.setFiles" => Some(Err(command("unsupported operation", "Failed to add file"))),
        "browsingContext.handleUserPrompt" => Some(Err(command("no such alert", ""))),
        "emulation.setMediaFeaturesOverride" => Some(Err(command("unsupported operation", "prefers-reduced-motion"))),
        _ => Some(Ok(json!({}))),
    });
    let tab = attach(&fake).await;
    assert!(!tab.traverse_history(5).await.unwrap());
    assert!(matches!(
        tab.navigate("http://x/", None).await,
        Err(DriverError::Navigation(error)) if error.kind == browse_core::NavigationErrorKind::Aborted
    ));
    assert_eq!(tab.capture().body(&browse_core::RequestId::from("r"), browse_core::BodyKind::Response).await.unwrap(), None);
    let input = browse_core::RemoteRef::new(FrameId::from("top"), World::Isolated, tab.frames().await.unwrap()[0].document, "n:s");
    assert!(matches!(tab.set_files(&input, &["/nope".into()]).await, Err(DriverError::Refused(_))));
    assert!(matches!(tab.answer_dialog(true, None).await, Err(DriverError::Protocol(m)) if m == "no dialog is open"));
    let media = browse_core::MediaOverride {
        media: String::new(),
        features: vec![browse_core::MediaFeature { name: "prefers-reduced-motion".into(), value: "reduce".into() }],
    };
    assert!(matches!(tab.emulate(browse_core::Emulation::Media(media)).await, Err(DriverError::Unsupported(_))));
    let print = browse_core::MediaOverride { media: "print".into(), features: vec![] };
    assert!(matches!(tab.emulate(browse_core::Emulation::Media(print)).await, Err(DriverError::Unsupported(_))));
    assert!(matches!(tab.emulate(browse_core::Emulation::Touch(Some(5))).await, Err(DriverError::Unsupported(_))));
    // reload never passes ignoreCache, which Firefox refuses.
    tab.reload(true).await.unwrap();
    assert!(fake.sent("browsingContext.reload")[0].get("ignoreCache").is_none());
    assert_eq!(fake.sent("network.setCacheBehavior")[0]["cacheBehavior"], "bypass");
}

#[tokio::test]
async fn a_closed_connection_closes_the_tab() {
    let fake = Fake::new(|_, _| Some(Ok(json!({}))));
    let tab = attach(&fake).await;
    let mut events = tab.events();
    fake.close();
    assert!(matches!(next(&mut events).await, PageEvent::Closed(CloseReason::BrowserDisconnected)));
}


#[tokio::test]
async fn a_javascript_url_is_refused_without_asking_the_browser() {
    let fake = Fake::new(|_, _| Some(Ok(json!({}))));
    let tab = attach(&fake).await;
    assert!(matches!(tab.navigate("  JavaScript:alert(1)", None).await, Err(DriverError::Refused(_))));
    assert!(fake.sent("browsingContext.navigate").is_empty(), "Firefox never answers it");
}

#[tokio::test]
async fn closing_the_last_tab_blanks_it_instead() {
    use browse_core::BrowserDriver;
    let fake = Fake::new(|_, _| Some(Ok(json!({}))));
    let info = browse_core::DriverInfo {
        id: "bidi+ws".into(),
        name: "WebDriver BiDi".into(),
        protocol: "webdriver-bidi".into(),
        transport: "ws".into(),
        browser: "firefox".into(),
    };
    let driver = crate::BiDiBrowserDriver::new(info, fake.clone()).await.unwrap();
    driver.close(&TargetId::from("top")).await.unwrap();
    assert!(fake.sent("browsingContext.close").is_empty(), "closing the last tab would quit Firefox");
    let navigated = fake.sent("browsingContext.navigate");
    assert_eq!(navigated.len(), 1);
    assert_eq!(navigated[0]["url"], "about:blank");
    assert_eq!(fake.sent("browsingContext.getTree")[0]["maxDepth"], 0);
    // A tab that is already gone has nothing to close.
    driver.close(&TargetId::from("gone")).await.unwrap();
    assert!(fake.sent("browsingContext.close").is_empty());
    BrowserDriver::shutdown(driver.as_ref()).await;
    assert_eq!(fake.sent("session.unsubscribe").len(), 1);
}
