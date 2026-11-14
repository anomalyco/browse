//! `recording`: screen recording of a tab through the CDP screencast (port of cli/src/recording-relay.ts and
//! recording-relay/cdp-capture.ts). Frames are written as MJPEG into Matroska by a writer thread while recording; .webm
//! and .mp4 are transcoded from it with ffmpeg when the recording stops.

use std::path::PathBuf;
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use browse_core::{Cdp, TabId, Tool, ToolContext, ToolOutput, ToolSpec};
use serde_json::{Value, json};

use crate::screencast::{self, Container, Frame, FrameSink, Screencast, WriterMessage, WriterResult};
use crate::state::{BusyGuard, TaskGuard};
use crate::{arg_action, arg_int, arg_str, bail_user, files, json_output, respond, state, tab_schema, target_tab};

const DEFAULT_FRAME_RATE: u32 = 30;
const DEFAULT_QUALITY: u32 = 90;
const DEFAULT_MAX_DURATION_MS: i64 = 15 * 60_000;
const MAX_PENDING_FRAMES: usize = 30;

#[derive(Default)]
pub(crate) struct RecordingState {
    active: Option<Recording>,
    /// The result of a recording that stopped itself (max duration), for the next stop or status.
    ended: Option<Value>,
}

struct Recording {
    tab: TabId,
    cdp: Arc<dyn Cdp>,
    path: PathBuf,
    partial: PathBuf,
    container: Container,
    started_at: String,
    started: Instant,
    frame_rate: u32,
    quality: u32,
    size: (u32, u32),
    screencast: Screencast,
    sink: Arc<SyncMutex<Sink>>,
    writer: std::thread::JoinHandle<std::io::Result<WriterResult>>,
    timer: TaskGuard,
    _busy: BusyGuard,
}

struct Last {
    jpeg: Arc<Vec<u8>>,
    frame_number: u64,
}

struct Sink {
    started: Instant,
    frame_rate: u32,
    last: Option<Last>,
    tx: Option<SyncSender<WriterMessage>>,
    source_frames: u64,
    encoded_frames: u64,
    coalesced_frames: u64,
    dropped_frames: u64,
    fallback_frames: u64,
    surface_width: Option<f64>,
    source_size: Option<(f64, f64)>,
}

impl Sink {
    /// Sends `last` to the writer, shown until `end_frame`.
    fn write(&mut self, jpeg: Arc<Vec<u8>>, frame_number: u64, end_frame: u64) {
        let fps = self.frame_rate as u64;
        let timestamp_ms = frame_number * 1_000 / fps;
        let duration_ms = ((end_frame.saturating_sub(frame_number)) * 1_000 / fps).max(1);
        let Some(tx) = &self.tx else { return };
        match tx.try_send(WriterMessage::Frame { jpeg, timestamp_ms, duration_ms }) {
            Ok(()) => self.encoded_frames += 1,
            Err(TrySendError::Full(_)) => self.dropped_frames += 1,
            Err(TrySendError::Disconnected(_)) => {
                self.dropped_frames += 1;
                self.tx = None;
            }
        }
    }

    fn quality(&self, duration: Duration) -> Value {
        let seconds = duration.as_secs_f64().max(0.001);
        let mut quality = json!({
            "sourceFrameCount": self.source_frames,
            "encodedSourceFrameCount": self.encoded_frames,
            "coalescedFrameCount": self.coalesced_frames,
            "droppedFrameCount": self.dropped_frames,
            "achievedSourceFrameRate": (self.source_frames as f64 / seconds * 10.0).round() / 10.0,
        });
        if self.fallback_frames > 0 {
            quality["screenshotFallback"] = json!(true);
        }
        if let Some((width, height)) = self.source_size {
            quality["sourceWidth"] = json!(width);
            quality["sourceHeight"] = json!(height);
        }
        quality
    }
}

impl FrameSink for Sink {
    fn frame(&mut self, frame: Frame) {
        self.source_frames += 1;
        if frame.fallback {
            self.fallback_frames += 1;
        }
        if let (Some(width), Some(height)) = (frame.device_width, frame.device_height) {
            self.source_size = Some((width, height));
            self.surface_width.get_or_insert(width);
        }
        let position = frame.at.saturating_duration_since(self.started).as_secs_f64() * self.frame_rate as f64;
        let mut frame_number = if self.source_frames == 1 { 0 } else { position.floor() as u64 };
        if let Some(last) = &self.last {
            if frame_number == last.frame_number && position - frame_number as f64 >= 0.5 {
                frame_number = last.frame_number + 1;
            }
            frame_number = frame_number.max(last.frame_number);
        }
        if let Some(last) = self.last.take() {
            if frame_number != last.frame_number {
                self.write(last.jpeg, last.frame_number, frame_number);
            } else {
                self.coalesced_frames += 1;
            }
        }
        self.last = Some(Last { jpeg: frame.jpeg, frame_number });
    }
}

fn status(recording: &Recording) -> Value {
    let elapsed = recording.started.elapsed();
    let sink = recording.sink.lock().unwrap();
    json!({
        "recording": true,
        "tab": recording.tab,
        "path": recording.path,
        "format": recording.container.name(),
        "startedAt": recording.started_at,
        "durationMs": elapsed.as_millis() as u64,
        "frameRate": recording.frame_rate,
        "quality": sink.quality(elapsed),
    })
}

/// Stops the screencast, writes the last frame, closes the file and transcodes it when needed.
async fn finish(mut recording: Recording) -> anyhow::Result<Value> {
    recording.screencast.stop().await;
    let duration = recording.started.elapsed();
    let (quality, surface_width) = {
        let sink = recording.sink.lock().unwrap();
        (sink.quality(duration), sink.surface_width)
    };
    let last = recording.sink.lock().unwrap().last.take();
    let last = match last {
        Some(last) => Some(last),
        None => screencast::still(recording.cdp.as_ref(), recording.quality)
            .await
            .ok()
            .map(|jpeg| Last { jpeg: Arc::new(jpeg), frame_number: 0 }),
    };
    let tx = recording.sink.lock().unwrap().tx.take();
    if let (Some(last), Some(tx)) = (last, tx) {
        let expected = ((duration.as_secs_f64() * recording.frame_rate as f64).round() as u64).max(1);
        let end = expected.max(last.frame_number + 1);
        let fps = recording.frame_rate as u64;
        let message = WriterMessage::Frame {
            jpeg: last.jpeg,
            timestamp_ms: last.frame_number * 1_000 / fps,
            duration_ms: ((end - last.frame_number) * 1_000 / fps).max(1),
        };
        // The last frame must not be dropped: wait for room in the writer's queue.
        let sent = tokio::task::spawn_blocking(move || tx.send(message).is_ok()).await.unwrap_or(false);
        if sent {
            recording.sink.lock().unwrap().encoded_frames += 1;
        }
    }
    let writer = recording.writer;
    let written = tokio::task::spawn_blocking(move || writer.join())
        .await?
        .map_err(|_| anyhow::anyhow!("the recording writer crashed"))?;
    let written = match written {
        Ok(written) => written,
        Err(error) => {
            let _ = std::fs::remove_file(&recording.partial);
            bail_user!("recording failed: {error}");
        }
    };
    screencast::finalize_output(
        &recording.partial,
        &recording.path,
        recording.container,
        recording.frame_rate,
        recording.size,
        surface_width,
    )
    .await?;
    let size = std::fs::metadata(&recording.path).map(|meta| meta.len()).unwrap_or(0);
    let (width, height) = match recording.container {
        Container::Mkv => written.pixel_size.unwrap_or(recording.size),
        _ => recording.size,
    };
    Ok(json!({
        "recording": false,
        "tab": recording.tab,
        "path": recording.path,
        "format": recording.container.name(),
        "mimeType": recording.container.mime(),
        "bytes": size,
        "durationMs": duration.as_millis() as u64,
        "width": width,
        "height": height,
        "frameRate": recording.frame_rate,
        "frameCount": written.frames,
        "quality": quality,
    }))
}

async fn cancel(mut recording: Recording) {
    recording.screencast.stop().await;
    recording.sink.lock().unwrap().tx = None;
    let writer = recording.writer;
    let _ = tokio::task::spawn_blocking(move || writer.join()).await;
    let _ = std::fs::remove_file(&recording.partial);
}

async fn start(ctx: &ToolContext, args: &Value) -> anyhow::Result<ToolOutput> {
    let Some(raw_path) = arg_str(args, "path")? else { bail_user!("path is required to start a recording") };
    let path = files::output_path(&ctx.file_roots, raw_path)?;
    let container = Container::from_path(&path)?;
    let frame_rate = arg_int(args, "frameRate", 1, 60)?.map_or(DEFAULT_FRAME_RATE, |n| n as u32);
    let quality = arg_int(args, "quality", 1, 100)?.map_or(DEFAULT_QUALITY, |n| n as u32);
    let max_duration = arg_int(args, "maxDurationMs", 1_000, 4 * 60 * 60_000)?.unwrap_or(DEFAULT_MAX_DURATION_MS);
    let tab = target_tab(ctx, args).await?;
    screencast::check_encoder(container).await?;
    let capture = state::get(ctx).await;
    let mut recording_state = capture.recording.lock().await;
    if recording_state.active.is_some() {
        bail_user!("a recording is already running in this session; stop or cancel it first");
    }
    let cdp = ctx.browser.cdp(&ctx.session, tab).await?;
    let size = screencast::recording_size(cdp.as_ref()).await?;
    let partial = files::partial_path(&path, "mkv");
    let (tx, rx) = sync_channel(MAX_PENDING_FRAMES);
    let writer_path = partial.clone();
    let writer = std::thread::Builder::new()
        .name("browse-recording".into())
        .spawn(move || screencast::write_mkv(writer_path, rx))?;
    let started = Instant::now();
    let sink = Arc::new(SyncMutex::new(Sink {
        started,
        frame_rate,
        last: None,
        tx: Some(tx),
        source_frames: 0,
        encoded_frames: 0,
        coalesced_frames: 0,
        dropped_frames: 0,
        fallback_frames: 0,
        surface_width: None,
        source_size: None,
    }));
    let screencast = match Screencast::start(cdp.clone(), frame_rate, quality, sink.clone()).await {
        Ok(screencast) => screencast,
        Err(error) => {
            sink.lock().unwrap().tx = None;
            let _ = writer.join();
            let _ = std::fs::remove_file(&partial);
            return Err(error.context("could not start the screencast"));
        }
    };
    let weak = Arc::downgrade(&capture.recording);
    let timer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(max_duration as u64)).await;
        let Some(state) = weak.upgrade() else { return };
        let mut state = state.lock().await;
        let Some(mut recording) = state.active.take() else { return };
        recording.timer.disarm();
        let mut result = finish(recording).await.unwrap_or_else(|error| json!({ "error": format!("{error:#}") }));
        result["endedBecause"] = json!(format!("it reached maxDurationMs ({max_duration} ms)"));
        state.ended = Some(result);
    });
    let recording = Recording {
        tab,
        cdp,
        path,
        partial,
        container,
        started_at: crate::now_iso(),
        started,
        frame_rate,
        quality,
        size,
        screencast,
        sink,
        writer,
        timer: TaskGuard::new(timer.abort_handle()),
        _busy: BusyGuard::new(ctx, "recording"),
    };
    let result = json!({
        "recording": true,
        "tab": tab,
        "path": recording.path,
        "format": container.name(),
        "frameRate": frame_rate,
        "width": size.0,
        "height": size.1,
    });
    recording_state.ended = None;
    recording_state.active = Some(recording);
    json_output(&result)
}

pub(crate) struct RecordingTool;

#[async_trait]
impl Tool for RecordingTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "recording".into(),
            description: "Record a tab to a video file through the CDP screencast (nothing is shown in or added to the \
                page; the tab doesn't need focus). One recording per session. start begins recording to path: .mkv \
                writes MJPEG Matroska directly at device resolution (no ffmpeg needed; plays in VLC/mpv/ffmpeg, not \
                browsers), .webm (VP8) or .mp4 (H.264) are transcoded with ffmpeg at CSS viewport size when it stops. \
                status reports duration and frame counters; stop finishes the file and returns {path, bytes, \
                durationMs, width, height, frameCount, quality}; cancel discards it. A recording stops itself after \
                maxDurationMs; the next stop or status returns its result."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["start", "status", "stop", "cancel"] },
                    "tab": tab_schema(),
                    "path": { "type": "string", "description": "start: output file ending in .mkv, .webm or .mp4; absolute inside the file roots, or relative to the first root." },
                    "frameRate": { "type": "integer", "minimum": 1, "maximum": 60, "description": "start: frames per second (default 30)." },
                    "quality": { "type": "integer", "minimum": 1, "maximum": 100, "description": "start: JPEG quality of captured frames (default 90)." },
                    "maxDurationMs": { "type": "integer", "minimum": 1000, "maximum": 14_400_000, "description": "start: stop automatically after this long (default 900000)." }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        respond(
            async {
                match arg_action(&args, &["start", "status", "stop", "cancel"])? {
                    "start" => start(&ctx, &args).await,
                    "status" => {
                        let capture = state::get(&ctx).await;
                        let state = capture.recording.lock().await;
                        match (&state.active, &state.ended) {
                            (Some(recording), _) => json_output(&status(recording)),
                            (None, Some(ended)) => json_output(ended),
                            (None, None) => json_output(&json!({ "recording": false })),
                        }
                    }
                    "stop" => {
                        let capture = state::get(&ctx).await;
                        let recording = {
                            let mut state = capture.recording.lock().await;
                            match state.active.take() {
                                Some(recording) => recording,
                                None => match state.ended.take() {
                                    Some(ended) => return json_output(&ended),
                                    None => bail_user!("no recording is running in this session"),
                                },
                            }
                        };
                        json_output(&finish(recording).await?)
                    }
                    _ => {
                        let capture = state::get(&ctx).await;
                        let recording = {
                            let mut state = capture.recording.lock().await;
                            state.ended = None;
                            state.active.take()
                        };
                        let cancelled = recording.is_some();
                        if let Some(recording) = recording {
                            cancel(recording).await;
                        }
                        json_output(&json!({ "cancelled": cancelled }))
                    }
                }
            }
            .await,
        )
        .await
    }
}
