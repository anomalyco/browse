//! Screenshots of regions inside the viewport, taken without a `Page.captureScreenshot` clip.
//!
//! Chrome applies a clip by resizing the tab's view to the clip for the length of the capture, which a tab the user is
//! looking at shows as the page shrinking into its top-left corner. A region on screen is therefore taken from a
//! capture without a clip: as it is when it's the whole viewport at one image pixel per device pixel, otherwise cut out
//! of a PNG of the viewport, scaled and encoded here.

use browse_core::image::{Rgba, decode_png, encode_png, image_size, resample};
use browse_core::{DriverError, DriverResult, Image, ImageFormat};

/// A region to capture and the viewport it lies in, both in device-independent pixels relative to the viewport's
/// top-left corner.
#[derive(Debug, Clone, Copy)]
pub(crate) struct OnScreen {
    pub region: (f64, f64, f64, f64),
    pub viewport: (f64, f64),
    /// The device pixel ratio the page reports; the capture's own size decides when they disagree.
    pub ratio: f64,
    /// Image pixels per device pixel.
    pub scale: f64,
}

impl OnScreen {
    /// The region's size in device pixels at the page's ratio: the size of a capture of exactly the region.
    pub fn expected_whole(&self) -> (u32, u32) {
        let (_, _, width, height) = self.region;
        ((width * self.ratio).round().max(1.0) as u32, (height * self.ratio).round().max(1.0) as u32)
    }

    /// Whether a capture without a clip, as Chrome returns it, is already the image asked for: the region is the whole
    /// viewport and one image pixel is one device pixel. `image` is the capture's size.
    pub fn is_whole(&self, image: (u32, u32)) -> bool {
        let (x, y, width, height) = self.region;
        let covers = x.abs() < 1.0
            && y.abs() < 1.0
            && (width - self.viewport.0).abs() < 1.0
            && (height - self.viewport.1).abs() < 1.0;
        covers && (self.scale - 1.0).abs() < 1e-3 && image == self.expected_whole()
    }

    /// Device pixels per device-independent pixel in a capture of `width`x`height`. The page's ratio is used while the
    /// capture agrees with it (it may be larger by scrollbars); otherwise, as when Chrome didn't report it, the ratio
    /// is taken from the capture itself so the crop always lands on the right part of the page.
    fn ratio_in(&self, width: u32, height: u32) -> f64 {
        let (view_width, view_height) = (self.viewport.0.max(1.0), self.viewport.1.max(1.0));
        let measured = (width as f64 / view_width).min(height as f64 / view_height);
        // Classic scrollbars are at most about 20 CSS pixels; allow for them, and for rounding.
        let slack = |view: f64, image: u32| {
            let expected = view * self.ratio;
            image as f64 + 1.0 >= expected && image as f64 - expected <= 24.0 * self.ratio + 1.0
        };
        if slack(view_width, width) && slack(view_height, height) { self.ratio } else { measured }
    }
}

fn encode_jpeg(image: &Rgba, quality: i64) -> DriverResult<Vec<u8>> {
    let (Ok(width), Ok(height)) = (u16::try_from(image.width), u16::try_from(image.height)) else {
        return Err(DriverError::Refused("too large for a JPEG (over 65535 px per side)".into()));
    };
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, quality.clamp(1, 100) as u8)
        .encode(&image.data, width, height, jpeg_encoder::ColorType::Rgba)
        .map_err(|e| DriverError::Protocol(format!("JPEG encode failed: {e}")))?;
    Ok(out)
}

/// The rows `[top, top + height)` and columns `[left, left + width)` of `image`.
fn crop(image: &Rgba, left: u32, top: u32, width: u32, height: u32) -> Rgba {
    let stride = image.width as usize * 4;
    let mut data = Vec::with_capacity(width as usize * height as usize * 4);
    for row in top as usize..(top + height) as usize {
        let start = row * stride + left as usize * 4;
        data.extend_from_slice(&image.data[start..start + width as usize * 4]);
    }
    Rgba { width, height, data }
}

/// Whether bytes Chrome returned for a capture without a clip can be returned as they are.
pub(crate) fn as_is(bytes: &[u8], shot: &OnScreen) -> bool {
    image_size(bytes).is_some_and(|size| shot.is_whole(size))
}

/// Cuts the region out of the PNG viewport capture `png`, scales it and encodes it as `format`. The region is rounded
/// to whole device pixels, keeps its size and moves inside the capture where it overhangs it. There's no WebP encoder
/// here, so WebP comes back as PNG.
pub(crate) fn cut(png: Vec<u8>, shot: &OnScreen, format: ImageFormat, quality: Option<i64>) -> DriverResult<Image> {
    let image = decode_png(&png)?;
    if image.width == 0 || image.height == 0 {
        return Err(DriverError::Protocol("Chrome returned an empty screenshot".into()));
    }
    let ratio = shot.ratio_in(image.width, image.height);
    let (x, y, width, height) = shot.region;
    let crop_width = ((width * ratio).round().max(1.0) as u32).min(image.width);
    let crop_height = ((height * ratio).round().max(1.0) as u32).min(image.height);
    let left = (x * ratio).round().clamp(0.0, (image.width - crop_width) as f64) as u32;
    let top = (y * ratio).round().clamp(0.0, (image.height - crop_height) as f64) as u32;
    // `scale` is per device pixel at the page's ratio: keep the image size it asks for when the ratio was corrected.
    let per_pixel = shot.scale * shot.ratio / ratio;
    let out_width = (crop_width as f64 * per_pixel).round().max(1.0) as u32;
    let out_height = (crop_height as f64 * per_pixel).round().max(1.0) as u32;
    let whole = (left, top, crop_width, crop_height) == (0, 0, image.width, image.height);
    let resized = (out_width, out_height) != (crop_width, crop_height);
    if format == ImageFormat::Png && whole && !resized {
        return Ok(Image { bytes: png, format, note: None });
    }
    let mut region = if whole { image } else { crop(&image, left, top, crop_width, crop_height) };
    if resized {
        region = resample(&region, out_width, out_height);
    }
    match format {
        ImageFormat::Png => Ok(Image { bytes: encode_png(&region)?, format, note: None }),
        ImageFormat::Jpeg => Ok(Image { bytes: encode_jpeg(&region, quality.unwrap_or(80))?, format, note: None }),
        ImageFormat::Webp => Ok(Image {
            bytes: encode_png(&region)?,
            format: ImageFormat::Png,
            note: Some("returned as PNG (asked for webp)".into()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An image whose pixels carry their own coordinates: red and green are x and y.
    fn coordinates(width: u32, height: u32) -> Vec<u8> {
        let data = (0..height).flat_map(|y| (0..width).flat_map(move |x| [x as u8, y as u8, 0, 255])).collect();
        encode_png(&Rgba { width, height, data }).unwrap()
    }

    fn at(image: &Rgba, x: u32, y: u32) -> [u8; 4] {
        let i = (y * image.width + x) as usize * 4;
        image.data[i..i + 4].try_into().unwrap()
    }

    fn on_screen(region: (f64, f64, f64, f64), viewport: (f64, f64), ratio: f64, scale: f64) -> OnScreen {
        OnScreen { region, viewport, ratio, scale }
    }

    fn png(shot: &OnScreen, png: Vec<u8>) -> Rgba {
        decode_png(&cut(png, shot, ImageFormat::Png, None).unwrap().bytes).unwrap()
    }

    #[test]
    fn cuts_the_region_out_at_its_place() {
        let image = png(&on_screen((10.0, 20.0, 30.0, 15.0), (100.0, 80.0), 1.0, 1.0), coordinates(100, 80));
        assert_eq!((image.width, image.height), (30, 15));
        assert_eq!(at(&image, 0, 0), [10, 20, 0, 255]);
        assert_eq!(at(&image, 29, 14), [39, 34, 0, 255]);
    }

    #[test]
    fn an_overhanging_region_moves_inside_and_keeps_its_size() {
        let image = png(&on_screen((-0.4, 70.6, 30.0, 15.0), (100.0, 80.0), 1.0, 1.0), coordinates(100, 80));
        assert_eq!((image.width, image.height), (30, 15));
        assert_eq!(at(&image, 0, 0), [0, 65, 0, 255]);
    }

    #[test]
    fn scaling_averages_device_pixels() {
        // 2x: each output pixel averages a 2x2 block of the 100x80 device pixel capture.
        let image = png(&on_screen((5.0, 10.0, 20.0, 10.0), (50.0, 40.0), 2.0, 0.5), coordinates(100, 80));
        assert_eq!((image.width, image.height), (20, 10));
        assert_eq!(at(&image, 0, 0), [11, 21, 0, 255]);
        assert_eq!(at(&image, 1, 1), [13, 23, 0, 255]);
    }

    #[test]
    fn a_ratio_the_capture_contradicts_is_taken_from_the_capture() {
        // The page said 1x (as when Chrome doesn't report the ratio) but the capture is 2x: the crop still lands on
        // the region, and the image keeps the size asked for.
        let image = png(&on_screen((5.0, 10.0, 20.0, 10.0), (50.0, 40.0), 1.0, 1.0), coordinates(100, 80));
        assert_eq!((image.width, image.height), (20, 10));
        assert_eq!(at(&image, 0, 0), [11, 21, 0, 255]);
        // Scrollbars alone don't change the ratio.
        let image = png(&on_screen((5.0, 10.0, 20.0, 10.0), (85.0, 80.0), 1.0, 1.0), coordinates(100, 80));
        assert_eq!(at(&image, 0, 0), [5, 10, 0, 255]);
    }

    #[test]
    fn the_whole_capture_is_returned_as_is() {
        let shot = on_screen((0.2, -0.3, 16.0, 8.0), (16.0, 8.0), 1.0, 1.0);
        let bytes = coordinates(16, 8);
        assert!(as_is(&bytes, &shot));
        assert_eq!(cut(bytes.clone(), &shot, ImageFormat::Png, None).unwrap().bytes, bytes);
        // Not with scrollbars, a crop or a scale.
        assert!(!as_is(&coordinates(20, 8), &shot));
        assert!(!as_is(&bytes, &on_screen((0.0, 0.0, 10.0, 8.0), (16.0, 8.0), 1.0, 1.0)));
        assert!(!as_is(&bytes, &on_screen((0.0, 0.0, 16.0, 8.0), (16.0, 8.0), 1.0, 0.5)));
        // At 2x, CSS-pixel images are half the capture's size.
        let shot = on_screen((0.0, 0.0, 8.0, 4.0), (8.0, 4.0), 2.0, 0.5);
        assert!(!as_is(&bytes, &shot));
        assert!(as_is(&bytes, &OnScreen { scale: 1.0, ..shot }));
    }

    #[test]
    fn jpeg_is_encoded_and_webp_comes_back_as_png() {
        let shot = on_screen((0.0, 0.0, 20.0, 20.0), (40.0, 40.0), 1.0, 1.0);
        let jpeg = cut(coordinates(40, 40), &shot, ImageFormat::Jpeg, Some(50)).unwrap();
        assert_eq!((&jpeg.bytes[..2], jpeg.format), (&[0xFF, 0xD8][..], ImageFormat::Jpeg));
        let webp = cut(coordinates(40, 40), &shot, ImageFormat::Webp, None).unwrap();
        assert_eq!(webp.format, ImageFormat::Png);
        assert!(webp.note.unwrap().contains("webp"));
    }
}
