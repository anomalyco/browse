//! PNG resampling for screenshots taken at a scale the browser can't capture at directly.

use browse_core::DriverResult;
use browse_core::image::{decode_png, encode_png, resample};

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
    use browse_core::image::Rgba;

    #[test]
    fn rescale_keeps_or_resizes() {
        let data = (0..6u32).flat_map(|y| (0..10u32).flat_map(move |x| [x as u8 * 20, y as u8 * 40, 7, 255])).collect();
        let bytes = encode_png(&Rgba { width: 10, height: 6, data }).unwrap();
        let scaled = decode_png(&rescale_png(&bytes, 0.5).unwrap()).unwrap();
        assert_eq!((scaled.width, scaled.height), (5, 3));
        let doubled = decode_png(&rescale_png(&bytes, 2.0).unwrap()).unwrap();
        assert_eq!((doubled.width, doubled.height), (20, 12));
        assert_eq!(&doubled.data[..4], &[0, 0, 7, 255]);
        assert_eq!(rescale_png(&bytes, 1.0).unwrap(), bytes);
    }
}
