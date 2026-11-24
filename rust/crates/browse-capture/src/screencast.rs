//! Protocol-agnostic recording output pipeline: consumes `Screencast` when a driver provides one, or polyfills by
//! polling `TabDriver::screenshot`, writes MJPEG Matroska, and optionally transcodes with ffmpeg.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex as SyncMutex};
use std::time::{Duration, Instant};

use browse_core::{
    ImageFormat, ScreencastFrame, ScreencastOptions, Screenshot, ScreenshotArea, Subscription, TabDriver,
};
use tokio::sync::{Semaphore, oneshot};

use crate::bail_user;
use crate::mkv::{MjpegWriter, jpeg_size};

static FFMPEG: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));

pub(crate) type Frame = ScreencastFrame;

pub(crate) trait FrameSink: Send + 'static {
    fn frame(&mut self, frame: Frame);
}

pub(crate) struct Screencast {
    stop_tx: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Screencast {
    pub async fn start<S: FrameSink>(
        driver: Arc<dyn TabDriver>,
        frame_rate: u32,
        quality: u32,
        sink: Arc<SyncMutex<S>>,
    ) -> anyhow::Result<Self> {
        let (stop_tx, mut stopped) = oneshot::channel::<()>();
        let task = if let Some(sc) = driver.capture().screencast() {
            let mut sub: Subscription<ScreencastFrame> = sc
                .start(ScreencastOptions { frame_rate, quality })
                .await?;
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = &mut stopped => break,
                        frame = sub.recv() => match frame {
                            Some(frame) => sink.lock().unwrap().frame(frame),
                            None => break,
                        }
                    }
                }
                sub.stop().await;
            })
        } else {
            let interval = Duration::from_millis(1_000 / frame_rate.clamp(1, 10) as u64);
            tokio::spawn(async move {
                let mut next = tokio::time::Instant::now();
                loop {
                    tokio::select! {
                        _ = &mut stopped => break,
                        _ = tokio::time::sleep_until(next) => {
                            let shot = Screenshot {
                                format: ImageFormat::Jpeg,
                                quality: Some(quality as i64),
                                area: ScreenshotArea::Viewport,
                                scale: 1.0,
                            };
                            if let Ok(image) = driver.screenshot(shot).await {
                                // The screenshot is at device resolution, like a screencast frame's surface.
                                let size = jpeg_size(&image.bytes);
                                sink.lock().unwrap().frame(ScreencastFrame {
                                    jpeg: Arc::new(image.bytes),
                                    device_width: size.map(|(w, _)| w as f64),
                                    device_height: size.map(|(_, h)| h as f64),
                                    at: Instant::now(),
                                    fallback: true,
                                });
                            }
                            next = tokio::time::Instant::now() + interval;
                        }
                    }
                }
            })
        };
        Ok(Self { stop_tx: Some(stop_tx), task: Some(task) })
    }

    pub async fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
        }
    }
}

impl Drop for Screencast {
    fn drop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
    }
}

pub(crate) async fn still(driver: &dyn TabDriver, quality: u32) -> anyhow::Result<Vec<u8>> {
    Ok(driver
        .screenshot(Screenshot {
            format: ImageFormat::Jpeg,
            quality: Some(quality as i64),
            area: ScreenshotArea::Viewport,
            scale: 1.0,
        })
        .await?
        .bytes)
}

pub(crate) fn recording_size(viewport: &crate::page::Viewport) -> (u32, u32) {
    ((viewport.width as u32 & !1).max(2), (viewport.height as u32 & !1).max(2))
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Container {
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

