//! CDP screencast (`Page.startScreencast` + ack + screenshot fallback when Chrome stops painting).

use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use browse_core::{DriverResult, ScreencastFrame, ScreencastOptions, Subscription};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::wire::{Cdp, map_cdp_error};

const FALLBACK_GRACE: Duration = Duration::from_millis(1_500);
const QUIET_GRACE: Duration = Duration::from_millis(400);
const MAX_FALLBACK_WAIT: Duration = Duration::from_secs(3);
const MAX_FALLBACK_BACKOFF: Duration = Duration::from_secs(1);
const MAX_FALLBACK_FRAME_RATE: u32 = 10;

pub(crate) async fn start(
    cdp: Arc<dyn Cdp>,
    options: ScreencastOptions,
) -> DriverResult<Subscription<ScreencastFrame>> {
    let mut events = cdp.events();
    cdp.send(
        "Page.startScreencast",
        json!({ "format": "jpeg", "quality": options.quality, "everyNthFrame": 1 }),
        None,
    )
    .await
    .map_err(map_cdp_error)?;
    let (stop_tx, mut stopped) = oneshot::channel::<()>();
    let (tx, rx) = mpsc::unbounded_channel::<ScreencastFrame>();
    let frame_rate = options.frame_rate;
    let quality = options.quality;
    let task_cdp = cdp.clone();
    let task = tokio::spawn(async move {
        let interval = Duration::from_millis(1_000 / frame_rate.clamp(1, MAX_FALLBACK_FRAME_RATE) as u64);
        let mut next_fallback = tokio::time::Instant::now() + FALLBACK_GRACE;
        let mut backoff = interval;
        let mut previous: Option<Arc<Vec<u8>>> = None;
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                event = events.recv() => match event {
                    Ok(event) if event.method == "Page.screencastFrame" && event.session_id.is_none() => {
                        next_fallback = tokio::time::Instant::now() + QUIET_GRACE;
                        backoff = interval;
                        if let Some(id) = event.params.get("sessionId").cloned() {
                            let ack = task_cdp.clone();
                            tokio::spawn(async move {
                                let _ = ack.send("Page.screencastFrameAck", json!({ "sessionId": id }), None).await;
                            });
                        }
                        if let Some(frame) = decode_frame(&event.params, false) {
                            previous = Some(frame.jpeg.clone());
                            if tx.send(frame).is_err() {
                                break;
                            }
                        }
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                _ = tokio::time::sleep_until(next_fallback) => {
                    let started = tokio::time::Instant::now();
                    let shot = tokio::time::timeout(
                        MAX_FALLBACK_WAIT,
                        task_cdp.send(
                            "Page.captureScreenshot",
                            json!({ "format": "jpeg", "quality": quality, "fromSurface": true, "captureBeyondViewport": false }),
                            None,
                        ),
                    )
                    .await;
                    if let Ok(Ok(shot)) = shot
                        && let Some(frame) = decode_frame(&shot, true)
                    {
                        let unchanged = previous.as_ref().is_some_and(|prev| **prev == *frame.jpeg);
                        backoff = if unchanged { (backoff * 2).min(MAX_FALLBACK_BACKOFF) } else { interval };
                        previous = Some(frame.jpeg.clone());
                        if tx.send(frame).is_err() {
                            break;
                        }
                    }
                    next_fallback = started + backoff;
                }
            }
        }
        let _ = task_cdp.send("Page.stopScreencast", json!({}), None).await;
    });
    let cleanup = Box::new(move || {
        Box::pin(async move {
            let _ = stop_tx.send(());
            let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
    });
    Ok(Subscription::new(rx, None, Some(cleanup)))
}

fn decode_frame(params: &Value, fallback: bool) -> Option<ScreencastFrame> {
    let data = params.get("data").and_then(Value::as_str)?;
    let jpeg = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    Some(ScreencastFrame {
        jpeg: Arc::new(jpeg),
        device_width: params.pointer("/metadata/deviceWidth").and_then(Value::as_f64),
        device_height: params.pointer("/metadata/deviceHeight").and_then(Value::as_f64),
        at: Instant::now(),
        fallback,
    })
}
