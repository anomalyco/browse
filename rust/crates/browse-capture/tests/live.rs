//! Live checks against a throwaway headless Chromium (its own temp profile and a random debugging port). Skipped when
//! no Chromium is found; set BROWSE_TEST_CHROME to choose one. Never touches the user's browser or the browse relay.

mod support;

use std::time::Duration;

use browse_core::Cdp;
use serde_json::{Value, json};
use support::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_capture_tools() {
    let Some((_chrome, cdp)) = launch().await else {
        eprintln!("skipping: no Chromium found");
        return;
    };
    let port = serve().await;
    let (ctx, root, busy) = context(&cdp);
    goto(&cdp, &format!("http://127.0.0.1:{port}/")).await;
    let viewport: Vec<f64> = serde_json::from_value(evaluate(&cdp, "[innerWidth, innerHeight, devicePixelRatio]").await).unwrap();
    eprintln!("viewport {viewport:?}");

    // Screenshots: CSS-pixel by default, device pixels on request, element clips, labels, saved files.
    let shot = call(&ctx, "screenshot", json!({})).await;
    assert_eq!(png_size(&image(&shot)), (viewport[0] as u32, viewport[1] as u32));
    assert_eq!((text(&shot)["width"].clone(), text(&shot)["height"].clone()), (json!(viewport[0] as u32), json!(viewport[1] as u32)));
    let device = call(&ctx, "screenshot", json!({ "scale": "device" })).await;
    assert_eq!(png_size(&image(&device)).0, (viewport[0] * viewport[2]) as u32);
    assert_eq!(text(&device)["width"], json!((viewport[0] * viewport[2]) as u32));
    let element = call(&ctx, "screenshot", json!({ "selector": "#box" })).await;
    assert_eq!(png_size(&image(&element)), (200, 50));
    let pixels = browse_capture::pixeldiff::decode_png(&image(&element)).unwrap();
    assert_eq!(&pixels.data[..3], &[0x33, 0x66, 0xcc], "the clip is the blue box");
    // Element screenshots by snapshot ref (inside an iframe too) and by selector, resolved by browse-page.
    let page_tool = browse_page::tools().into_iter().find(|tool| tool.spec().name == "snapshot").unwrap();
    let snapshot = page_tool.call(ctx.clone(), json!({})).await.unwrap();
    assert!(!snapshot.is_error, "{:?}", snapshot.content);
    let (_, refs) = browse_page::snapshot_refs(&ctx).await;
    let inner = refs.iter().find(|(_, role, name)| role == "button" && name.as_deref() == Some("Inner")).expect("iframe button ref");
    let by_ref = call(&ctx, "screenshot", json!({ "ref": inner.0 })).await;
    assert_eq!(png_size(&image(&by_ref)), (120, 40));
    let pixels = browse_capture::pixeldiff::decode_png(&image(&by_ref)).unwrap();
    assert_eq!(&pixels.data[..3], &[0x00, 0xaa, 0x00], "the ref clip is the green iframe button ({})", inner.0);
    let go = refs.iter().find(|(_, role, name)| role == "button" && name.as_deref() == Some("Go")).unwrap();
    assert!(call(&ctx, "screenshot", json!({ "ref": go.0 })).await.content.len() == 2);
    let by_role = call(&ctx, "screenshot", json!({ "selector": "internal:role=button[name=\"Go\"i]" })).await;
    assert_eq!(png_size(&image(&by_role)), png_size(&image(&call(&ctx, "screenshot", json!({ "selector": "#go" })).await)));
    let jpeg = call(&ctx, "screenshot", json!({ "format": "jpeg", "quality": 50, "fullPage": true })).await;
    assert_eq!(&image(&jpeg)[..2], &[0xFF, 0xD8]);
    assert_eq!(text(&jpeg)["width"], json!(viewport[0] as u32));
    let webp = call(&ctx, "screenshot", json!({ "format": "webp", "selector": "#box" })).await;
    assert_eq!((text(&webp)["width"].clone(), text(&webp)["height"].clone()), (json!(200), json!(50)));
    let png_quality = text(&call(&ctx, "screenshot", json!({ "quality": 50 })).await);
    assert!(png_quality["note"].as_str().unwrap().contains("ignored for png"), "{png_quality}");
    let labelled = call(&ctx, "screenshot", json!({ "labels": true })).await;
    let labels = text(&labelled)["labels"].as_array().unwrap().clone();
    assert!(labels.iter().any(|label| label["selector"] == "#go" && label["role"] == "button"), "{labels:?}");
    assert!(evaluate(&cdp, "document.querySelectorAll('div').length").await == json!(2), "labels left nothing in the page");
    evaluate(&cdp, "document.getElementById('spin').style.animationPlayState = 'paused'").await;
    let saved = text(&call(&ctx, "screenshot", json!({ "path": "shots/base.png" })).await);
    assert_eq!(saved["path"], json!(root.join("shots/base.png")));
    let same = text(&call(&ctx, "screenshot_diff", json!({ "baseline": "shots/base.png" })).await);
    assert_eq!(same["matches"], json!(true), "{same}");
    evaluate(&cdp, "document.getElementById('box').style.background = 'red'").await;
    let changed = call(&ctx, "screenshot_diff", json!({ "baseline": "shots/base.png" })).await;
    assert_eq!(text(&changed)["matches"], json!(false));
    assert!(text(&changed)["changedPixels"].as_u64().unwrap() >= 200 * 50);
    let outside = tool("screenshot").call(ctx.clone(), json!({ "path": "/etc/shot.png" })).await.unwrap();
    assert!(outside.is_error);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(std::fs::metadata(root.join("shots/base.png")).unwrap().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(root.join("shots")).unwrap().mode() & 0o777, 0o700);
    }
    call(&ctx, "screenshot", json!({ "format": "jpeg", "path": "shots/photo.jpg" })).await;
    let not_png = tool("screenshot_diff").call(ctx.clone(), json!({ "baseline": "shots/photo.jpg" })).await.unwrap();
    assert!(not_png.is_error && format!("{:?}", not_png.content).contains("must be a PNG"), "{:?}", not_png.content);

    // Network capture with redaction, inline and as HAR.
    call(&ctx, "network", json!({ "action": "start", "urlFilter": "/api" })).await;
    assert_eq!(evaluate(&cdp, "go().then(r => r.ok)").await, json!(true));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let status = text(&call(&ctx, "network", json!({ "action": "status" })).await);
    assert_eq!(status["active"], json!(true));
    assert_eq!(busy.lock().unwrap().get("network"), Some(&true));
    let stopped = call(&ctx, "network", json!({ "action": "stop" })).await;
    let raw = serde_json::to_string(&text(&stopped)).unwrap();
    for secret in ["supersecretquery123", "abcdefghijklmnopqrstuvwxyz", "hunter2hunter2", "sessvalue1234567890", "cookievalue1234567890"] {
        assert!(!raw.contains(secret), "{secret} leaked: {raw}");
    }
    assert_eq!(busy.lock().unwrap().get("network"), Some(&false));
    let exchanges = text(&stopped)["exchanges"].as_array().unwrap().clone();
    assert_eq!(exchanges.len(), 1, "{raw}");
    let exchange = &exchanges[0];
    assert_eq!(exchange["response"]["status"], json!(200));
    assert!(exchange["request"]["body"]["text"].as_str().unwrap().contains(r#""username":"dax""#), "{raw}");
    assert!(exchange["response"]["body"]["text"].as_str().unwrap().contains(r#""ok":true"#), "{raw}");
    // Console capture is opt-in, only sees what happens after start and leaves out browse's isolated worlds.
    evaluate(&cdp, "console.log('before start')").await;
    let world = isolated_world(&cdp).await;
    call(&ctx, "console", json!({ "action": "start" })).await;
    evaluate_in(&cdp, world, "console.log('from browse')").await;
    let world = isolated_world(&cdp).await;
    evaluate_in(&cdp, world, "console.log('from a new browse world')").await;
    evaluate(&cdp, "console.log('hello', 42); setTimeout(() => { throw new Error('boom') })").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let read = text(&call(&ctx, "console", json!({ "action": "read" })).await);
    let entries = read["entries"].as_array().unwrap();
    assert!(entries.iter().any(|entry| entry["text"] == "hello 42" && entry["type"] == "log"), "{read}");
    assert!(entries.iter().any(|entry| entry["type"] == "pageerror" && entry["text"].as_str().unwrap().contains("boom")), "{read}");
    assert!(!entries.iter().any(|entry| entry["text"] == "before start"), "{read}");
    assert!(!entries.iter().any(|entry| entry["text"].as_str().unwrap().contains("browse")), "{read}");
    call(&ctx, "console", json!({ "action": "stop" })).await;

    // Recording straight to Matroska.
    evaluate(&cdp, "document.getElementById('spin').style.animationPlayState = 'running'").await;
    let started = text(&call(&ctx, "recording", json!({ "action": "start", "path": "rec/clip.mkv", "frameRate": 20 })).await);
    eprintln!("recording {started}");
    assert_eq!(started["width"], json!((viewport[0] * viewport[2]).round() as u32), "mkv keeps device pixels");
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let status = text(&call(&ctx, "recording", json!({ "action": "status" })).await);
    assert_eq!(status["recording"], json!(true));
    assert_eq!(busy.lock().unwrap().get("recording"), Some(&true));
    let done = text(&call(&ctx, "recording", json!({ "action": "stop" })).await);
    eprintln!("recorded {done}");
    assert_eq!(busy.lock().unwrap().get("recording"), Some(&false));
    let clip = root.join("rec/clip.mkv");
    assert!(done["frameCount"].as_u64().unwrap() >= 2, "{done}");
    assert_eq!(done["width"], started["width"], "{done}");
    if let Some(probe) = ffprobe(&clip) {
        eprintln!("ffprobe {probe}");
        assert!(probe.contains("codec_name=mjpeg"), "{probe}");
    }

    // A page that stops changing: the screencast goes quiet and screenshots fill in.
    evaluate(&cdp, "document.getElementById('spin').style.animationPlayState = 'paused'").await;
    call(&ctx, "recording", json!({ "action": "start", "path": "rec/still.mkv", "frameRate": 10 })).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    let still = text(&call(&ctx, "recording", json!({ "action": "stop" })).await);
    eprintln!("still {still}");
    assert_eq!(still["quality"]["screenshotFallback"], json!(true), "{still}");
    assert!(still["quality"]["sourceFrameCount"].as_u64().unwrap() >= 3, "{still}");
    evaluate(&cdp, "document.getElementById('spin').style.animationPlayState = 'running'").await;

    // Recording transcoded to MP4 (needs ffmpeg).
    if which("ffmpeg") {
        call(&ctx, "recording", json!({ "action": "start", "path": "rec/clip.mp4", "frameRate": 10 })).await;
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        let done = text(&call(&ctx, "recording", json!({ "action": "stop" })).await);
        let probe = ffprobe(&root.join("rec/clip.mp4")).unwrap();
        eprintln!("mp4 {done} {probe}");
        assert!(probe.contains("codec_name=h264") && probe.contains(&format!("width={}", viewport[0] as u32)), "{probe}");
        assert!(probe.contains("pix_fmt=yuv420p") && !probe.contains("yuvj"), "{probe}");
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::MetadataExt::mode(&std::fs::metadata(root.join("rec/clip.mp4")).unwrap()) & 0o777, 0o600);
    }

    std::fs::remove_dir_all(root).unwrap();
}


/// Screenshots that fit the viewport must not resize the page (Chrome resizes it for captureBeyondViewport), which a
/// page would see as resize events and which closes menus and tooltips.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn screenshots_inside_the_viewport_do_not_resize_the_page() {
    let Some((_chrome, cdp)) = launch().await else {
        eprintln!("skipping: no Chromium found");
        return;
    };
    let port = serve().await;
    let (ctx, root, _) = context(&cdp);
    goto(&cdp, &format!("http://127.0.0.1:{port}/")).await;
    let world = isolated_world(&cdp).await;
    evaluate_in(&cdp, world, "window.resizes = 0; addEventListener('resize', () => resizes++); true").await;
    call(&ctx, "screenshot", json!({})).await;
    call(&ctx, "screenshot", json!({ "selector": "#box" })).await;
    call(&ctx, "screenshot", json!({ "clip": { "x": 10, "y": 10, "width": 100, "height": 50 } })).await;
    call(&ctx, "screenshot", json!({ "fullPage": true })).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(evaluate_in(&cdp, world, "resizes").await, json!(0));

    // A tall page: the inline image is scaled to 8000 px, its reported size is the real one, and the viewport is
    // back to normal afterwards.
    goto(&cdp, &format!("http://127.0.0.1:{port}/tall")).await;
    let before = evaluate(&cdp, "[innerWidth, innerHeight]").await;
    let tall = call(&ctx, "screenshot", json!({ "fullPage": true })).await;
    let size = png_size(&image(&tall));
    let summary = text(&tall);
    assert_eq!(size.1, 8000, "{summary}");
    assert_eq!((summary["width"].clone(), summary["height"].clone()), (json!(size.0), json!(size.1)));
    assert!(summary["note"].as_str().unwrap().contains("scaled down"), "{summary}");
    let saved = text(&call(&ctx, "screenshot", json!({ "fullPage": true, "path": "tall.png" })).await);
    assert_eq!(saved["height"], json!(12000), "{saved}");
    assert_eq!(evaluate(&cdp, "[innerWidth, innerHeight]").await, before);
    std::fs::remove_dir_all(root).unwrap();
}

/// An out-of-process iframe's document is requested on the page's CDP session and answered on the iframe's.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn network_capture_completes_out_of_process_iframe_documents() {
    let Some((_chrome, cdp)) = launch().await else {
        eprintln!("skipping: no Chromium found");
        return;
    };
    let port = serve().await;
    let (ctx, root, _) = context(&cdp);
    goto(&cdp, "about:blank").await;
    // Like the relay: iframes attach without waiting for the debugger, so their first Network events can be missed.
    cdp.send("Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }), None).await.unwrap();
    call(&ctx, "network", json!({ "action": "start", "resourceTypes": ["Document"] })).await;
    goto(&cdp, &format!("http://127.0.0.1:{port}/oopif")).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let status = text(&call(&ctx, "network", json!({ "action": "status" })).await);
    assert_eq!(status["pendingCount"], json!(0), "{status}");
    let stopped = text(&call(&ctx, "network", json!({ "action": "stop" })).await);
    let exchanges: Vec<Value> = stopped["exchanges"].as_array().unwrap().clone();
    let frame = exchanges.iter().find(|exchange| exchange["request"]["url"].as_str().unwrap().ends_with("/frame")).expect("the iframe document");
    assert_eq!(frame["response"]["status"], json!(200), "{stopped}");
    assert!(frame.get("failure").is_none(), "{stopped}");
    // HTML isn't returned and isn't fetched.
    assert_eq!(frame["response"]["body"]["truncated"], json!(false), "{stopped}");
    assert_eq!(stopped["capturedBodyBytes"], json!(0));
    std::fs::remove_dir_all(root).unwrap();
}

/// Full-page screenshots must leave the viewport as it was, with or without an emulated viewport and scrollbars.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_page_screenshots_keep_the_viewport() {
    let Some((_chrome, cdp)) = launch_with(&[]).await else {
        eprintln!("skipping: no Chromium found");
        return;
    };
    let port = serve().await;
    let (ctx, root, _) = context(&cdp);
    goto(&cdp, &format!("http://127.0.0.1:{port}/tall")).await;
    let size = || async { evaluate(&cdp, "[innerWidth, innerHeight, devicePixelRatio]").await };
    let before = size().await;
    for _ in 0..3 {
        call(&ctx, "screenshot", json!({ "fullPage": true })).await;
        assert_eq!(size().await, before);
    }
    let viewport = text(&call(&ctx, "screenshot", json!({})).await);
    assert_eq!(viewport["width"], before[0]);
    cdp.send("Emulation.setDeviceMetricsOverride", json!({ "width": 600, "height": 400, "deviceScaleFactor": 1, "mobile": false }), None)
        .await
        .unwrap();
    let emulated = size().await;
    assert_eq!(emulated, json!([600, 400, 1]));
    for _ in 0..3 {
        call(&ctx, "screenshot", json!({ "fullPage": true })).await;
        assert_eq!(size().await, emulated);
    }
    std::fs::remove_dir_all(root).unwrap();
}
