//! The tab's CDP screencast for recordings (port of
//! cli/src/recording-relay/screencast.ts), plus writing frames to Matroska and the optional ffmpeg transcode.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex as SyncMutex};
use std::time::{Duration, Instant};

use base64::Engine;
use browse_core::Cdp;
use serde_json::{Value, json};
use tokio::sync::{Semaphore, broadcast, oneshot};

use crate::bail_user;
use crate::mkv::{MjpegWriter, jpeg_size};

/// How long a screencast may stay silent before screenshots stand in for it.
const FALLBACK_GRACE: Duration = Duration::from_millis(1_500);
/// How long the screencast may go quiet mid-recording before screenshots fill in.
const QUIET_GRACE: Duration = Duration::from_millis(400);
/// Longest wait for one fallback screenshot.
const MAX_FALLBACK_WAIT: Duration = Duration::from_secs(3);
/// Slowest fallback rate while screenshots keep coming back identical.
const MAX_FALLBACK_BACKOFF: Duration = Duration::from_secs(1);
/// Screenshots are slower than screencast frames; this many per second at most.
const MAX_FALLBACK_FRAME_RATE: u32 = 10;
/// Never run more than this many ffmpeg processes at once; each is already multithreaded.
static FFMPEG: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));

#[derive(Clone)]
pub(crate) struct Frame {
    pub jpeg: Arc<Vec<u8>>,
    /// The compositor surface's CSS width, when Chrome reported it.
    pub device_width: Option<f64>,
    pub device_height: Option<f64>,
    pub at: Instant,
    /// Taken with Page.captureScreenshot because the screencast sent nothing (a tab Chrome doesn't paint).
    pub fallback: bool,
}

pub(crate) trait FrameSink: Send + 'static {
    fn frame(&mut self, frame: Frame);
}

pub(crate) struct Screencast {
    stop: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Screencast {
    pub async fn start<S: FrameSink>(
        cdp: Arc<dyn Cdp>,
        frame_rate: u32,
        quality: u32,
        sink: Arc<SyncMutex<S>>,
    ) -> anyhow::Result<Self> {
        let mut events = cdp.events();
        cdp.send("Page.startScreencast", json!({ "format": "jpeg", "quality": quality, "everyNthFrame": 1 }), None)
            .await?;
        let (stop, mut stopped) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let interval = Duration::from_millis(1_000 / frame_rate.clamp(1, MAX_FALLBACK_FRAME_RATE) as u64);
            // Screenshots stand in whenever the screencast goes quiet: Chrome stops painting background and
            // occluded tabs, and sends nothing while a page doesn't change. Identical screenshots back off.
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
                                let ack = cdp.clone();
                                tokio::spawn(async move {
                                    let _ = ack.send("Page.screencastFrameAck", json!({ "sessionId": id }), None).await;
                                });
                            }
                            if let Some(frame) = decode_frame(&event.params, false) {
                                previous = Some(frame.jpeg.clone());
                                sink.lock().unwrap().frame(frame);
                            }
                        }
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                    _ = tokio::time::sleep_until(next_fallback) => {
                        let started = tokio::time::Instant::now();
                        let shot = tokio::time::timeout(MAX_FALLBACK_WAIT, cdp.send("Page.captureScreenshot", json!({
                            "format": "jpeg", "quality": quality, "fromSurface": true, "captureBeyondViewport": false
                        }), None)).await;
                        if let Ok(Ok(shot)) = shot
                            && let Some(frame) = decode_frame(&shot, true) {
                                let unchanged = previous.as_ref().is_some_and(|previous| **previous == *frame.jpeg);
                                backoff = if unchanged { (backoff * 2).min(MAX_FALLBACK_BACKOFF) } else { interval };
                                previous = Some(frame.jpeg.clone());
                                sink.lock().unwrap().frame(frame);
                            }
                        next_fallback = started + backoff;
                    }
                }
            }
            let _ = cdp.send("Page.stopScreencast", json!({}), None).await;
        });
        Ok(Self { stop: Some(stop), task: Some(task) })
    }

    /// Stops the screencast and waits until no more frames reach the sink.
    pub async fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        }
    }
}

impl Drop for Screencast {
    fn drop(&mut self) {
        // Stopping lets the task send Page.stopScreencast itself.
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

fn decode_frame(params: &Value, fallback: bool) -> Option<Frame> {
    let data = params.get("data").and_then(Value::as_str)?;
    let jpeg = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    Some(Frame {
        jpeg: Arc::new(jpeg),
        device_width: params.pointer("/metadata/deviceWidth").and_then(Value::as_f64),
        device_height: params.pointer("/metadata/deviceHeight").and_then(Value::as_f64),
        at: Instant::now(),
        fallback,
    })
}

/// A single JPEG of the tab, for recordings that ended before any frame arrived.
pub(crate) async fn still(cdp: &dyn Cdp, quality: u32) -> anyhow::Result<Vec<u8>> {
    let shot = cdp
        .send(
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": quality, "fromSurface": true, "captureBeyondViewport": false }),
            None,
        )
        .await?;
    let data = shot.get("data").and_then(Value::as_str).ok_or_else(|| anyhow::anyhow!("no video frames were captured"))?;
    Ok(base64::engine::general_purpose::STANDARD.decode(data)?)
}

/// The size to record at: the CSS viewport, rounded down to even numbers for video encoders.
pub(crate) fn recording_size(viewport: &crate::page::Viewport) -> (u32, u32) {
    ((viewport.width as u32 & !1).max(2), (viewport.height as u32 & !1).max(2))
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Container {
    /// MJPEG in Matroska, written directly; no ffmpeg needed.
    Mkv,
    Webm,
    Mp4,
}

impl Container {
    pub fn from_path(path: &Path) -> anyhow::Result<Self> {
        match path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref() {
            Some("mkv") => Ok(Container::Mkv),
            Some("webm") => Ok(Container::Webm),
            Some("mp4") => Ok(Container::Mp4),
            _ => bail_user!("the output path must end in .mkv (MJPEG, no ffmpeg needed), .webm or .mp4 (need ffmpeg)"),
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Container::Mkv => "video/x-matroska",
            Container::Webm => "video/webm",
            Container::Mp4 => "video/mp4",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Container::Mkv => "mkv",
            Container::Webm => "webm",
            Container::Mp4 => "mp4",
        }
    }
}

/// Fails fast when a container needs ffmpeg and it isn't installed.
pub(crate) async fn check_encoder(container: Container) -> anyhow::Result<()> {
    if container == Container::Mkv {
        return Ok(());
    }
    let found = tokio::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .is_ok_and(|status| status.success());
    if !found {
        bail_user!("ffmpeg is needed for .{} output and wasn't found; record to .mkv instead", container.name());
    }
    Ok(())
}

pub(crate) struct WriterResult {
    pub frames: u64,
    pub pixel_size: Option<(u32, u32)>,
}

pub(crate) enum WriterMessage {
    Frame { jpeg: Arc<Vec<u8>>, timestamp_ms: u64, duration_ms: u64 },
}

/// Writes frames from `messages` into `file` (a new, private MJPEG Matroska file) until the channel closes. The track
/// size comes from the first frame's JPEG.
pub(crate) fn write_mkv(
    file: std::fs::File,
    messages: std::sync::mpsc::Receiver<WriterMessage>,
) -> std::io::Result<WriterResult> {
    let mut file = Some(file);
    let mut writer: Option<MjpegWriter<std::io::BufWriter<std::fs::File>>> = None;
    let mut pixel_size = None;
    for message in messages {
        let WriterMessage::Frame { jpeg, timestamp_ms, duration_ms } = message;
        if let Some(file) = file.take() {
            let size = jpeg_size(&jpeg).unwrap_or((2, 2));
            pixel_size = Some(size);
            writer = Some(MjpegWriter::new(std::io::BufWriter::with_capacity(1 << 20, file), size.0, size.1)?);
        }
        if let Some(writer) = writer.as_mut() {
            writer.write_frame(&jpeg, timestamp_ms, duration_ms)?;
        }
    }
    let Some(writer) = writer else { return Err(std::io::Error::other("no video frames were captured")) };
    let frames = writer.frames();
    let file = writer.finish()?;
    file.into_inner().map_err(|error| error.into_error())?.sync_all()?;
    Ok(WriterResult { frames, pixel_size })
}

/// Moves a finished MJPEG Matroska file into place, transcoding it with ffmpeg for .webm and .mp4: frames are scaled
/// to CSS size (`surface_width`), held at a constant `frame_rate`, padded/cropped to `width`×`height` and converted
/// from MJPEG's full-range yuvj420p to limited-range yuv420p. Outputs end up 0600.
pub(crate) async fn finalize_output(
    roots: &[PathBuf],
    mkv: &Path,
    output: &Path,
    container: Container,
    frame_rate: u32,
    size: (u32, u32),
    surface_width: Option<f64>,
) -> anyhow::Result<()> {
    let operation = "recording path";
    if container == Container::Mkv {
        let committed = crate::files::commit(roots, mkv, output, operation);
        if committed.is_err() {
            let _ = std::fs::remove_file(mkv);
        }
        return committed;
    }
    let (width, height) = size;
    let surface = surface_width.map_or(width, |w| w.round().max(2.0) as u32);
    let filter = format!(
        "scale=min(iw\\,{surface}):-1:flags=lanczos,pad=ceil(max(iw\\,{width})/2)*2:ceil(max(ih\\,{height})/2)*2:0:0:gray,crop={width}:{height}:0:0,scale=out_range=tv,format=yuv420p"
    );
    let codec: &[&str] = match container {
        Container::Webm => &["-c:v", "libvpx", "-crf", "4", "-deadline", "good", "-cpu-used", "4", "-b:v", "6M", "-threads", "2"],
        _ => &["-c:v", "libx264", "-preset", "fast", "-crf", "14", "-tune", "animation", "-movflags", "+faststart"],
    };
    let partial = crate::files::partial_path(output, container.name());
    let _permit = FFMPEG.acquire().await?;
    let result = tokio::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(mkv)
        .args(["-an", "-r", &frame_rate.to_string(), "-fps_mode", "cfr", "-vf", &filter])
        .args(["-pix_fmt", "yuv420p", "-color_range", "tv"])
        .args(codec)
        .args(["-f", container.name()])
        .arg(&partial)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await;
    let _ = std::fs::remove_file(mkv);
    match result {
        Ok(out) if out.status.success() => {
            let committed = crate::files::commit(roots, &partial, output, operation);
            if committed.is_err() {
                let _ = std::fs::remove_file(&partial);
            }
            committed
        }
        Ok(out) => {
            let _ = std::fs::remove_file(&partial);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let tail: String = stderr.trim().chars().rev().take(2_000).collect::<Vec<_>>().into_iter().rev().collect();
            bail_user!("ffmpeg failed ({}): {tail}", out.status)
        }
        Err(error) => {
            let _ = std::fs::remove_file(&partial);
            bail_user!("could not run ffmpeg ({error}); record to .mkv instead")
        }
    }
}
