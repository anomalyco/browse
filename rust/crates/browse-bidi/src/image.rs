//! PNG resampling for screenshots taken at a scale the browser can't capture at directly.

use browse_core::{DriverError, DriverResult};

pub(crate) struct Rgba {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

pub(crate) fn decode_png(bytes: &[u8]) -> DriverResult<Rgba> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|error| DriverError::Protocol(format!("invalid PNG screenshot: {error}")))?;
    let mut buffer = vec![0u8; reader.output_buffer_size().unwrap_or(0)];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|error| DriverError::Protocol(format!("invalid PNG screenshot: {error}")))?;
    let raw = &buffer[..info.buffer_size()];
    let pixels = (info.width as usize) * (info.height as usize);
    let mut data = Vec::with_capacity(pixels * 4);
    match info.color_type {
        png::ColorType::Rgba => data.extend_from_slice(raw),
        png::ColorType::Rgb => {
            for &[r, g, b] in raw.as_chunks::<3>().0 {
                data.extend_from_slice(&[r, g, b, 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for &[g, a] in raw.as_chunks::<2>().0 {
                data.extend_from_slice(&[g, g, g, a]);
            }
        }
        png::ColorType::Grayscale => {
            for &g in raw {
                data.extend_from_slice(&[g, g, g, 255]);
            }
        }
        other => return Err(DriverError::Protocol(format!("unsupported PNG color type {other:?}"))),
    }
    Ok(Rgba { width: info.width, height: info.height, data })
}

pub(crate) fn encode_png(image: &Rgba) -> DriverResult<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| DriverError::Protocol(format!("PNG encoding failed: {error}")))?;
        writer
            .write_image_data(&image.data)
            .map_err(|error| DriverError::Protocol(format!("PNG encoding failed: {error}")))?;
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
pub(crate) fn resample(image: &Rgba, width: u32, height: u32) -> Rgba {
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

/// A PNG scaled by `scale` (rounded to whole pixels).
pub(crate) fn rescale_png(bytes: &[u8], scale: f64) -> DriverResult<Vec<u8>> {
    let image = decode_png(bytes)?;
    let width = (image.width as f64 * scale).round().max(1.0) as u32;
    let height = (image.height as f64 * scale).round().max(1.0) as u32;
    if width == image.width && height == image.height {
        return Ok(bytes.to_vec());
    }
    encode_png(&resample(&image, width, height))
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
    fn png_round_trip_and_rescale() {
        let source = image(10, 6, |x, y| [x as u8 * 20, y as u8 * 40, 7, 255]);
        let bytes = encode_png(&source).unwrap();
        let decoded = decode_png(&bytes).unwrap();
        assert_eq!((decoded.width, decoded.height), (10, 6));
        assert_eq!(decoded.data, source.data);
        let scaled = decode_png(&rescale_png(&bytes, 0.5).unwrap()).unwrap();
        assert_eq!((scaled.width, scaled.height), (5, 3));
        let doubled = decode_png(&rescale_png(&bytes, 2.0).unwrap()).unwrap();
        assert_eq!((doubled.width, doubled.height), (20, 12));
        assert_eq!(&doubled.data[..4], &source.data[..4]);
        assert_eq!(rescale_png(&bytes, 1.0).unwrap(), bytes);
    }
}
