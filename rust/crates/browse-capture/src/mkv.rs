//! A minimal Matroska writer for timestamped MJPEG frames (port of cli/src/recording-relay/mjpeg-matroska.ts), written
//! to a seekable file so the segment size and duration are filled in when it finishes.
//! References: <https://www.matroska.org/technical/elements.html> and RFC 8794.

use std::io::{Seek, SeekFrom, Write};

const EBML: u32 = 0x1A45_DFA3;
const EBML_VERSION: u32 = 0x4286;
const EBML_READ_VERSION: u32 = 0x42F7;
const EBML_MAX_ID_LENGTH: u32 = 0x42F2;
const EBML_MAX_SIZE_LENGTH: u32 = 0x42F3;
const DOC_TYPE: u32 = 0x4282;
const DOC_TYPE_VERSION: u32 = 0x4287;
const DOC_TYPE_READ_VERSION: u32 = 0x4285;
const SEGMENT: u32 = 0x1853_8067;
const INFO: u32 = 0x1549_A966;
const TIMESTAMP_SCALE: u32 = 0x2A_D7B1;
const DURATION: u32 = 0x4489;
const MUXING_APP: u32 = 0x4D80;
const WRITING_APP: u32 = 0x5741;
const TRACKS: u32 = 0x1654_AE6B;
const TRACK_ENTRY: u32 = 0xAE;
const TRACK_NUMBER: u32 = 0xD7;
const TRACK_UID: u32 = 0x73C5;
const TRACK_TYPE: u32 = 0x83;
const FLAG_LACING: u32 = 0x9C;
const CODEC_ID: u32 = 0x86;
const VIDEO: u32 = 0xE0;
const PIXEL_WIDTH: u32 = 0xB0;
const PIXEL_HEIGHT: u32 = 0xBA;
const CLUSTER: u32 = 0x1F43_B675;
const TIMESTAMP: u32 = 0xE7;
const BLOCK_GROUP: u32 = 0xA0;
const BLOCK: u32 = 0xA1;
const BLOCK_DURATION: u32 = 0x9B;

fn id_bytes(id: u32) -> Vec<u8> {
    let bytes = id.to_be_bytes();
    let skip = bytes.iter().position(|b| *b != 0).unwrap_or(3);
    bytes[skip..].to_vec()
}

/// EBML variable-size integer, shortest form (all-ones values are reserved for "unknown").
pub fn vint(value: u64) -> Vec<u8> {
    let mut length = 1;
    while length < 8 && value >= (1u64 << (7 * length)) - 1 {
        length += 1;
    }
    let mut out = vec![0u8; length];
    let mut rest = value;
    for index in (0..length).rev() {
        out[index] = (rest & 0xff) as u8;
        rest >>= 8;
    }
    out[0] |= 1 << (8 - length);
    out
}

fn uint(value: u64) -> Vec<u8> {
    if value == 0 {
        return vec![0];
    }
    let bytes = value.to_be_bytes();
    let skip = bytes.iter().position(|b| *b != 0).unwrap_or(7);
    bytes[skip..].to_vec()
}

fn element(id: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = id_bytes(id);
    out.extend(vint(payload.len() as u64));
    out.extend_from_slice(payload);
    out
}

fn concat(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.concat()
}

pub use browse_core::image::jpeg_size;

pub struct MjpegWriter<W: Write + Seek> {
    out: W,
    segment_size_at: u64,
    segment_data_at: u64,
    duration_at: u64,
    end_ms: u64,
    frames: u64,
}

impl<W: Write + Seek> MjpegWriter<W> {
    /// Writes the header for a `width`×`height` MJPEG track with millisecond timestamps.
    pub fn new(mut out: W, width: u32, height: u32) -> std::io::Result<Self> {
        let header = element(
            EBML,
            &concat(&[
                element(EBML_VERSION, &uint(1)),
                element(EBML_READ_VERSION, &uint(1)),
                element(EBML_MAX_ID_LENGTH, &uint(4)),
                element(EBML_MAX_SIZE_LENGTH, &uint(8)),
                element(DOC_TYPE, b"matroska"),
                element(DOC_TYPE_VERSION, &uint(4)),
                element(DOC_TYPE_READ_VERSION, &uint(2)),
            ]),
        );
        out.write_all(&header)?;
        out.write_all(&id_bytes(SEGMENT))?;
        let segment_size_at = out.stream_position()?;
        // Unknown size until finish() patches it, so a cut-off file still parses.
        out.write_all(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])?;
        let segment_data_at = out.stream_position()?;
        let timestamp_scale = element(TIMESTAMP_SCALE, &uint(1_000_000));
        let info_payload = concat(&[
            timestamp_scale.clone(),
            element(DURATION, &0f64.to_be_bytes()),
            element(MUXING_APP, b"browse"),
            element(WRITING_APP, b"browse"),
        ]);
        let info_header = concat(&[id_bytes(INFO), vint(info_payload.len() as u64)]);
        let info_start = out.stream_position()?;
        out.write_all(&info_header)?;
        out.write_all(&info_payload)?;
        // Duration's float payload follows the Info header, TimestampScale and Duration's own id and size.
        let duration_header = id_bytes(DURATION).len() + 1;
        let duration_at = info_start + (info_header.len() + timestamp_scale.len() + duration_header) as u64;
        let track = element(
            TRACK_ENTRY,
            &concat(&[
                element(TRACK_NUMBER, &uint(1)),
                element(TRACK_UID, &uint(1)),
                element(TRACK_TYPE, &uint(1)),
                element(FLAG_LACING, &uint(0)),
                element(CODEC_ID, b"V_MJPEG"),
                element(VIDEO, &concat(&[element(PIXEL_WIDTH, &uint(width as u64)), element(PIXEL_HEIGHT, &uint(height as u64))])),
            ]),
        );
        out.write_all(&element(TRACKS, &track))?;
        Ok(Self { out, segment_size_at, segment_data_at, duration_at, end_ms: 0, frames: 0 })
    }

    /// Appends one JPEG frame shown from `timestamp_ms` for `duration_ms`, in its own cluster.
    pub fn write_frame(&mut self, jpeg: &[u8], timestamp_ms: u64, duration_ms: u64) -> std::io::Result<()> {
        let duration_ms = duration_ms.max(1);
        // Block header: track number 1, relative timestamp 0, no flags.
        let mut block = vint(1);
        block.extend_from_slice(&[0, 0, 0]);
        let block_len = block.len() + jpeg.len();
        let block_header = concat(&[id_bytes(BLOCK), vint(block_len as u64), block]);
        let duration = element(BLOCK_DURATION, &uint(duration_ms));
        let group_len = block_header.len() + jpeg.len() + duration.len();
        let group_header = concat(&[id_bytes(BLOCK_GROUP), vint(group_len as u64)]);
        let timestamp = element(TIMESTAMP, &uint(timestamp_ms));
        let cluster_len = timestamp.len() + group_header.len() + group_len;
        self.out.write_all(&id_bytes(CLUSTER))?;
        self.out.write_all(&vint(cluster_len as u64))?;
        self.out.write_all(&timestamp)?;
        self.out.write_all(&group_header)?;
        self.out.write_all(&block_header)?;
        self.out.write_all(jpeg)?;
        self.out.write_all(&duration)?;
        self.end_ms = self.end_ms.max(timestamp_ms + duration_ms);
        self.frames += 1;
        Ok(())
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Fills in the segment size and duration and returns the output.
    pub fn finish(mut self) -> std::io::Result<W> {
        let end = self.out.stream_position()?;
        let size = end - self.segment_data_at;
        let mut patched = [0u8; 8];
        patched[0] = 0x01;
        patched[1..].copy_from_slice(&size.to_be_bytes()[1..]);
        self.out.seek(SeekFrom::Start(self.segment_size_at))?;
        self.out.write_all(&patched)?;
        self.out.seek(SeekFrom::Start(self.duration_at))?;
        self.out.write_all(&(self.end_ms as f64).to_be_bytes())?;
        self.out.seek(SeekFrom::Start(end))?;
        self.out.flush()?;
        Ok(self.out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads an EBML id and returns it with its length.
    fn read_id(data: &[u8]) -> (u32, usize) {
        let length = data[0].leading_zeros() as usize + 1;
        let mut id = 0u32;
        for byte in &data[..length] {
            id = (id << 8) | *byte as u32;
        }
        (id, length)
    }

    fn read_size(data: &[u8]) -> (u64, usize) {
        let length = data[0].leading_zeros() as usize + 1;
        let mut value = (data[0] as u64) & ((1u64 << (8 - length)) - 1);
        for byte in &data[1..length] {
            value = (value << 8) | *byte as u64;
        }
        (value, length)
    }

    /// Top-level children of a master element payload: (id, payload range).
    fn children(data: &[u8]) -> Vec<(u32, std::ops::Range<usize>)> {
        let mut out = Vec::new();
        let mut index = 0;
        while index < data.len() {
            let (id, id_len) = read_id(&data[index..]);
            let (size, size_len) = read_size(&data[index + id_len..]);
            let start = index + id_len + size_len;
            let end = start + size as usize;
            assert!(end <= data.len(), "element {id:x} overruns its parent");
            out.push((id, start..end));
            index = end;
        }
        out
    }

    fn fake_jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut data = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x0B, 0x08];
        data.extend(height.to_be_bytes());
        data.extend(width.to_be_bytes());
        data.extend([0x01, 0x01, 0x11, 0x00, 0xFF, 0xD9]);
        data
    }

    #[test]
    fn ffprobe_reads_the_file() {
        let Ok(version) = std::process::Command::new("ffprobe").arg("-version").output() else {
            eprintln!("skipping: no ffprobe");
            return;
        };
        assert!(version.status.success());
        let mut frames = Vec::new();
        for shade in [0u8, 128, 255] {
            let mut jpeg = Vec::new();
            let pixels: Vec<u8> = std::iter::repeat_n([shade, 64, 255 - shade], 64 * 48).flatten().collect();
            jpeg_encoder::Encoder::new(&mut jpeg, 80).encode(&pixels, 64, 48, jpeg_encoder::ColorType::Rgb).unwrap();
            frames.push(jpeg);
        }
        let path = std::env::temp_dir().join(format!("browse-capture-mkv-{}.mkv", std::process::id()));
        let file = std::fs::File::create(&path).unwrap();
        let (width, height) = jpeg_size(&frames[0]).unwrap();
        assert_eq!((width, height), (64, 48));
        let mut writer = MjpegWriter::new(file, width, height).unwrap();
        for (index, frame) in frames.iter().enumerate() {
            writer.write_frame(frame, index as u64 * 500, 500).unwrap();
        }
        writer.finish().unwrap();
        let output = std::process::Command::new("ffprobe")
            .args(["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,width,height,nb_read_frames:format=duration", "-of", "compact"])
            .arg(&path)
            .output()
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success() && output.stderr.is_empty(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(text.contains("codec_name=mjpeg|width=64|height=48|nb_read_frames=3"), "{text}");
        assert!(text.contains("duration=1.5"), "{text}");
    }

    #[test]
    fn vints_use_the_shortest_form() {
        assert_eq!(vint(0), vec![0x80]);
        assert_eq!(vint(126), vec![0xFE]);
        assert_eq!(vint(127), vec![0x40, 0x7F]);
        assert_eq!(vint(300), vec![0x41, 0x2C]);
    }

    #[test]
    fn reads_jpeg_dimensions() {
        assert_eq!(jpeg_size(&fake_jpeg(640, 360)), Some((640, 360)));
        assert_eq!(jpeg_size(b"nope"), None);
    }

    #[test]
    fn writes_a_well_formed_file() {
        let mut writer = MjpegWriter::new(std::io::Cursor::new(Vec::new()), 640, 360).unwrap();
        let frame = fake_jpeg(640, 360);
        writer.write_frame(&frame, 0, 33).unwrap();
        writer.write_frame(&frame, 33, 300).unwrap();
        let data = writer.finish().unwrap().into_inner();

        let top = children(&data);
        assert_eq!(top.iter().map(|(id, _)| *id).collect::<Vec<_>>(), vec![EBML, SEGMENT]);
        let header = children(&data[top[0].1.clone()]);
        let doc_type = header.iter().find(|(id, _)| *id == DOC_TYPE).unwrap();
        assert_eq!(&data[top[0].1.clone()][doc_type.1.clone()], b"matroska");

        let segment = &data[top[1].1.clone()];
        assert_eq!(top[1].1.end, data.len(), "segment size covers the rest of the file");
        let parts = children(segment);
        assert_eq!(parts.iter().map(|(id, _)| *id).collect::<Vec<_>>(), vec![INFO, TRACKS, CLUSTER, CLUSTER]);
        let info = children(&segment[parts[0].1.clone()]);
        let duration = info.iter().find(|(id, _)| *id == DURATION).unwrap();
        let bytes: [u8; 8] = segment[parts[0].1.clone()][duration.1.clone()].try_into().unwrap();
        assert_eq!(f64::from_be_bytes(bytes), 333.0);

        let cluster = &segment[parts[3].1.clone()];
        let cluster_parts = children(cluster);
        assert_eq!(cluster_parts[0].0, TIMESTAMP);
        assert_eq!(&cluster[cluster_parts[0].1.clone()], &[33]);
        let group = children(&cluster[cluster_parts[1].1.clone()]);
        assert_eq!(group.iter().map(|(id, _)| *id).collect::<Vec<_>>(), vec![BLOCK, BLOCK_DURATION]);
        let block = &cluster[cluster_parts[1].1.clone()][group[0].1.clone()];
        assert_eq!(&block[..4], &[0x81, 0, 0, 0]);
        assert_eq!(&block[4..], frame.as_slice());
    }
}
