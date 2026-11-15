//! PNG decoding/encoding and a pixelmatch-compatible per-pixel diff (YIQ color distance, anti-aliased pixels counted
//! as changes, like `pixelmatch(..., { includeAA: true })`).

use crate::bail_user;

pub const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_IMAGE_PIXELS: u64 = 16 * 1024 * 1024;

pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

pub fn decode_png(bytes: &[u8]) -> anyhow::Result<Rgba> {
    if bytes.len() > MAX_IMAGE_BYTES || bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        bail_user!("the image must be a PNG no larger than 32 MiB");
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 || width as u64 * height as u64 > MAX_IMAGE_PIXELS {
        bail_user!("the image exceeds the 16 megapixel limit");
    }
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info()?;
    let mut buffer = vec![0; reader.output_buffer_size().ok_or_else(|| anyhow::anyhow!("PNG too large"))?];
    let info = reader.next_frame(&mut buffer)?;
    buffer.truncate(info.buffer_size());
    let pixels = (info.width * info.height) as usize;
    let data = match info.color_type {
        png::ColorType::Rgba => buffer,
        png::ColorType::Rgb => buffer.as_chunks::<3>().0.iter().flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => buffer.as_chunks::<2>().0.iter().flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Grayscale => buffer.iter().flat_map(|g| [*g, *g, *g, 255]).collect(),
        png::ColorType::Indexed => bail_user!("unsupported PNG color type"),
    };
    if data.len() != pixels * 4 {
        bail_user!("the PNG could not be decoded");
    }
    Ok(Rgba { width: info.width, height: info.height, data })
}

pub fn encode_png(image: &Rgba) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(&image.data)?;
    }
    Ok(out)
}

fn blend(color: f64, alpha: f64) -> f64 {
    255.0 + (color - 255.0) * alpha
}

fn rgb2y(r: f64, g: f64, b: f64) -> f64 {
    r * 0.298_895_31 + g * 0.586_622_47 + b * 0.114_482_23
}
fn rgb2i(r: f64, g: f64, b: f64) -> f64 {
    r * 0.595_977_99 - g * 0.274_176_10 - b * 0.321_801_89
}
fn rgb2q(r: f64, g: f64, b: f64) -> f64 {
    r * 0.211_470_17 - g * 0.522_617_11 + b * 0.311_146_94
}

fn pixel(data: &[u8], offset: usize) -> (f64, f64, f64) {
    let (r, g, b, a) = (data[offset] as f64, data[offset + 1] as f64, data[offset + 2] as f64, data[offset + 3] as f64);
    if a < 255.0 {
        let alpha = a / 255.0;
        (blend(r, alpha), blend(g, alpha), blend(b, alpha))
    } else {
        (r, g, b)
    }
}

/// Perceptual squared distance between two pixels (Kotsarenko & Ramos), 0..35215.
fn color_delta(a: &[u8], b: &[u8], offset: usize) -> f64 {
    let (r1, g1, b1) = pixel(a, offset);
    let (r2, g2, b2) = pixel(b, offset);
    let y = rgb2y(r1, g1, b1) - rgb2y(r2, g2, b2);
    let i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2);
    let q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
    0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q
}

pub struct Diff {
    pub changed_pixels: u64,
    /// Unchanged pixels faded to gray, changed pixels red.
    pub image: Rgba,
}

/// Compares two equally sized images. `threshold` (0..1) is the per-pixel color tolerance, not a changed-area allowance.
pub fn diff(before: &Rgba, after: &Rgba, threshold: f64) -> anyhow::Result<Diff> {
    if before.width != after.width || before.height != after.height {
        bail_user!(
            "screenshot sizes differ: baseline {}×{}, current {}×{}. Capture both with the same viewport and fullPage setting; images are never resized.",
            before.width,
            before.height,
            after.width,
            after.height
        );
    }
    if !(0.0..=1.0).contains(&threshold) {
        bail_user!("threshold must be from 0 to 1");
    }
    let max_delta = 35_215.0 * threshold * threshold;
    let mut output = vec![0u8; before.data.len()];
    let mut changed = 0;
    for offset in (0..before.data.len()).step_by(4) {
        let same = before.data[offset..offset + 4] == after.data[offset..offset + 4];
        if !same && color_delta(&before.data, &after.data, offset) > max_delta {
            changed += 1;
            output[offset..offset + 4].copy_from_slice(&[255, 0, 0, 255]);
        } else {
            let (r, g, b) = (before.data[offset] as f64, before.data[offset + 1] as f64, before.data[offset + 2] as f64);
            let alpha = 0.1 * before.data[offset + 3] as f64 / 255.0;
            let value = blend(rgb2y(r, g, b), alpha).round().clamp(0.0, 255.0) as u8;
            output[offset..offset + 4].copy_from_slice(&[value, value, value, 255]);
        }
    }
    Ok(Diff { changed_pixels: changed, image: Rgba { width: before.width, height: before.height, data: output } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, color: [u8; 4]) -> Rgba {
        Rgba { width, height, data: color.iter().copied().cycle().take((width * height * 4) as usize).collect() }
    }

    #[test]
    fn identical_images_match() {
        let image = solid(4, 3, [10, 20, 30, 255]);
        let result = diff(&image, &solid(4, 3, [10, 20, 30, 255]), 0.1).unwrap();
        assert_eq!(result.changed_pixels, 0);
        assert!(result.image.data.chunks(4).all(|p| p[0] == p[1] && p[3] == 255 && p[0] > 200));
    }

    #[test]
    fn changes_are_counted_and_marked_red() {
        let before = solid(4, 4, [255, 255, 255, 255]);
        let mut after = solid(4, 4, [255, 255, 255, 255]);
        after.data[0..4].copy_from_slice(&[0, 0, 0, 255]);
        after.data[20..24].copy_from_slice(&[0, 0, 0, 255]);
        // Barely different: under the default threshold.
        after.data[40..44].copy_from_slice(&[250, 250, 250, 255]);
        let result = diff(&before, &after, 0.1).unwrap();
        assert_eq!(result.changed_pixels, 2);
        assert_eq!(&result.image.data[0..4], &[255, 0, 0, 255]);
        assert_eq!(&result.image.data[20..24], &[255, 0, 0, 255]);
        assert_eq!(diff(&before, &after, 0.0).unwrap().changed_pixels, 3);
    }

    #[test]
    fn size_mismatch_is_an_error() {
        assert!(diff(&solid(2, 2, [0; 4]), &solid(3, 2, [0; 4]), 0.1).is_err());
    }

    #[test]
    fn png_round_trip() {
        let image = solid(3, 2, [1, 2, 3, 4]);
        let decoded = decode_png(&encode_png(&image).unwrap()).unwrap();
        assert_eq!((decoded.width, decoded.height), (3, 2));
        assert_eq!(decoded.data, image.data);
    }
}
