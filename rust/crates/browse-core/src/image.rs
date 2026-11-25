//! Screenshot image helpers shared by the protocol and capture crates: PNG decoding and encoding, a box-filter resample,
//! and reading the size of a PNG, JPEG or WebP without decoding it.

use crate::{DriverError, DriverResult};

pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

pub fn decode_png(bytes: &[u8]) -> DriverResult<Rgba> {
    let invalid = |error: png::DecodingError| DriverError::Protocol(format!("invalid PNG screenshot: {error}"));
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(invalid)?;
    let mut buffer = vec![0u8; reader.output_buffer_size().unwrap_or(0)];
    let info = reader.next_frame(&mut buffer).map_err(invalid)?;
    let raw = &buffer[..info.buffer_size()];
    let data = match info.color_type {
        png::ColorType::Rgba => raw.to_vec(),
        png::ColorType::Rgb => raw.as_chunks::<3>().0.iter().flat_map(|&[r, g, b]| [r, g, b, 255]).collect(),
        png::ColorType::GrayscaleAlpha => raw.as_chunks::<2>().0.iter().flat_map(|&[g, a]| [g, g, g, a]).collect(),
        png::ColorType::Grayscale => raw.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        other => return Err(DriverError::Protocol(format!("unsupported PNG color type {other:?}"))),
    };
    Ok(Rgba { width: info.width, height: info.height, data })
}

pub fn encode_png(image: &Rgba) -> DriverResult<Vec<u8>> {
    let failed = |error: png::EncodingError| DriverError::Protocol(format!("PNG encoding failed: {error}"));
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(failed)?;
        writer.write_image_data(&image.data).map_err(failed)?;
    }
    Ok(out)
}

/// The overlap of source pixel span `[index, index + 1)` with `[start, end)`.
fn coverage(index: usize, start: f64, end: f64) -> f64 {
    let low = (index as f64).max(start);
    let high = ((index + 1) as f64).min(end);
    (high - low).max(0.0)
}

/// Resizes with a box filter: each output pixel is the area-weighted average of the source pixels it covers.
pub fn resample(image: &Rgba, width: u32, height: u32) -> Rgba {
    let (width, height) = (width.max(1), height.max(1));
    if image.width == 0 || image.height == 0 {
        return Rgba { width, height, data: vec![0; width as usize * height as usize * 4] };
    }
    let sx = image.width as f64 / width as f64;
    let sy = image.height as f64 / height as f64;
    let stride = image.width as usize * 4;
    let mut data = Vec::with_capacity(width as usize * height as usize * 4);
    for oy in 0..height as usize {
        let (y0, y1) = (oy as f64 * sy, ((oy + 1) as f64 * sy).min(image.height as f64));
        let rows = (y0.floor() as usize)..(y1.ceil() as usize).min(image.height as usize);
        for ox in 0..width as usize {
            let (x0, x1) = (ox as f64 * sx, ((ox + 1) as f64 * sx).min(image.width as f64));
            let cols = (x0.floor() as usize)..(x1.ceil() as usize).min(image.width as usize);
            let mut sum = [0.0f64; 4];
            let mut total = 0.0;
            for y in rows.clone() {
                let wy = coverage(y, y0, y1);
                if wy <= 0.0 {
                    continue;
                }
                for x in cols.clone() {
                    let weight = wy * coverage(x, x0, x1);
                    if weight <= 0.0 {
                        continue;
                    }
                    let at = y * stride + x * 4;
                    for (channel, value) in sum.iter_mut().zip(&image.data[at..at + 4]) {
                        *channel += *value as f64 * weight;
                    }
                    total += weight;
                }
            }
            for channel in sum {
                data.push(if total > 0.0 { (channel / total).round().clamp(0.0, 255.0) as u8 } else { 0 });
            }
        }
    }
    Rgba { width, height, data }
}

/// Width and height from a JPEG's start-of-frame marker.
pub fn jpeg_size(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return None;
    }
    let mut index = 2;
    while index + 9 < data.len() {
        if data[index] != 0xFF {
            index += 1;
            continue;
        }
        let marker = data[index + 1];
        if marker == 0xFF {
            index += 1;
            continue;
        }
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            index += 2;
            continue;
        }
        let length = u16::from_be_bytes([data[index + 2], data[index + 3]]) as usize;
        if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
            let height = u16::from_be_bytes([data[index + 5], data[index + 6]]) as u32;
            let width = u16::from_be_bytes([data[index + 7], data[index + 8]]) as u32;
            return Some((width, height));
        }
        index += 2 + length;
    }
    None
}

/// Width and height of a PNG, JPEG or WebP image.
pub fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 {
        return Some((u32::from_be_bytes(bytes[16..20].try_into().ok()?), u32::from_be_bytes(bytes[20..24].try_into().ok()?)));
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return jpeg_size(bytes);
    }
    if bytes.len() >= 30 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        let le24 = |at: usize| u32::from(bytes[at]) | u32::from(bytes[at + 1]) << 8 | u32::from(bytes[at + 2]) << 16;
        return match &bytes[12..16] {
            b"VP8 " => Some((
                u32::from(u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3FFF),
                u32::from(u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3FFF),
            )),
            b"VP8L" => {
                let bits = u32::from_le_bytes(bytes[21..25].try_into().ok()?);
                Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
            }
            b"VP8X" => Some((le24(24) + 1, le24(27) + 1)),
            _ => None,
        };
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 4]) -> Rgba {
        let mut data = Vec::new();
        for y in 0..height {
            for x in 0..width {
                data.extend_from_slice(&pixel(x, y));
            }
        }
        Rgba { width, height, data }
    }

    #[test]
    fn halving_averages_blocks() {
        let source = image(4, 2, |x, _| if x < 2 { [255, 0, 0, 255] } else { [0, 0, 254, 255] });
        let half = resample(&source, 2, 1);
        assert_eq!((half.width, half.height), (2, 1));
        assert_eq!(half.data, vec![255, 0, 0, 255, 0, 0, 254, 255]);
        let checker = image(2, 2, |x, y| if (x + y) % 2 == 0 { [200, 200, 200, 255] } else { [0, 0, 0, 255] });
        assert_eq!(resample(&checker, 1, 1).data, vec![100, 100, 100, 255]);
    }

    #[test]
    fn png_round_trip_and_size() {
        let source = image(10, 6, |x, y| [x as u8 * 20, y as u8 * 40, 7, 255]);
        let bytes = encode_png(&source).unwrap();
        assert_eq!(image_size(&bytes), Some((10, 6)));
        let decoded = decode_png(&bytes).unwrap();
        assert_eq!((decoded.width, decoded.height), (10, 6));
        assert_eq!(decoded.data, source.data);
        assert_eq!(image_size(b"nope"), None);
    }
}
