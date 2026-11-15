//! Human-like pointer and keyboard timing (cli/src/execute/human-input.ts).
//!
//! A naive driver teleports the mouse: one mouseMoved straight to the exact center of the target, then a press and
//! release a few milliseconds apart. Behavioral bot detection scores exactly that. With human input on, every move
//! travels a curved, eased path from the pointer's last position (a cubic Bezier with a perpendicular bow,
//! minimum-jerk velocity, ~60-120 Hz samples, sub-pixel tremor, an occasional overshoot), its duration growing with
//! distance (Fitts' law); presses land a few pixels off center, settle before pressing and hold 60-140 ms; key
//! presses are spaced 30-110 ms; wheel scrolls glide in eased ~60 Hz bursts.

use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy)]
struct Aim {
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
}

/// Per-tab pointer and keyboard state.
#[derive(Debug, Default)]
pub struct InputState {
    pub pointer: Option<Point>,
    /// Mouse buttons held, as CDP's `buttons` bitmask.
    pub buttons: i64,
    aim: Option<Aim>,
    arrived_at: Option<Instant>,
    pressed_at: Option<Instant>,
    last_key_at: Option<Instant>,
}

/// OPENCODE_BROWSER_HUMAN_INPUT, when set, wins over the extension's setting (0/false/off/no: off).
pub fn override_from_env() -> Option<bool> {
    let value = std::env::var("OPENCODE_BROWSER_HUMAN_INPUT").ok()?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(!matches!(value.to_ascii_lowercase().as_str(), "0" | "false" | "off" | "no"))
}

// A small xorshift generator: timing jitter needs no cryptographic randomness, and no extra dependency.
fn next_u64() -> u64 {
    use std::cell::Cell;
    thread_local! {
        static STATE: Cell<u64> = Cell::new({
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0x9e37_79b9);
            (nanos ^ 0x2545_f491_4f6c_dd1d) | 1
        });
    }
    STATE.with(|state| {
        let mut x = state.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        state.set(x);
        x
    })
}

pub fn unit() -> f64 {
    (next_u64() >> 11) as f64 / (1u64 << 53) as f64
}

pub fn random(min: f64, max: f64) -> f64 {
    min + unit() * (max - min)
}

/// Normal-ish noise (sum of uniforms).
fn noise(scale: f64) -> f64 {
    (unit() + unit() + unit() - 1.5) * scale
}

/// Minimum-jerk position profile: slow start, fast middle, slow arrival.
fn minimum_jerk(t: f64) -> f64 {
    t * t * t * (10.0 - 15.0 * t + 6.0 * t * t)
}

fn bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: f64) -> Point {
    let u = 1.0 - t;
    Point {
        x: u * u * u * p0.x + 3.0 * u * u * t * p1.x + 3.0 * u * t * t * p2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3.0 * u * u * t * p1.y + 3.0 * u * t * t * p2.y + t * t * t * p3.y,
    }
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Points (with the delay before each, in ms) for one human-looking movement from `from` to `to`, excluding `to`.
pub fn trajectory(from: Point, to: Point) -> Vec<(Point, f64)> {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let distance = dx.hypot(dy);
    if distance < 2.0 {
        return Vec::new();
    }
    let duration = ((70.0 + 90.0 * (distance / 40.0 + 1.0).log2()) * random(0.85, 1.2)).min(700.0);
    let normal = Point { x: -dy / distance, y: dx / distance };
    let bow = if unit() < 0.5 { -1.0 } else { 1.0 } * random(0.04, 0.18) * distance;
    let c1 = Point { x: from.x + dx * random(0.2, 0.35) + normal.x * bow, y: from.y + dy * random(0.2, 0.35) + normal.y * bow };
    let c2 = Point { x: from.x + dx * random(0.65, 0.8) + normal.x * bow * 0.6, y: from.y + dy * random(0.65, 0.8) + normal.y * bow * 0.6 };
    let overshoot = distance > 250.0 && unit() < 0.25;
    let end = if overshoot {
        Point { x: to.x + (dx / distance) * random(4.0, 12.0), y: to.y + (dy / distance) * random(4.0, 12.0) }
    } else {
        to
    };
    let mut points = Vec::new();
    let mut elapsed = 0.0;
    while elapsed < duration {
        let step = random(8.0, 17.0);
        elapsed = (elapsed + step).min(duration);
        let s = minimum_jerk(elapsed / duration);
        let p = bezier(from, c1, c2, end, s);
        let tremor = (1.0 - s) * 0.9;
        points.push((Point { x: p.x + noise(tremor), y: p.y + noise(tremor) }, step));
    }
    if overshoot {
        let back = random(4.0, 7.0).round().max(3.0) as usize;
        for i in 1..=back {
            let s = minimum_jerk(i as f64 / back as f64);
            points.push((Point { x: end.x + (to.x - end.x) * s, y: end.y + (to.y - end.y) * s }, random(10.0, 18.0)));
        }
    }
    // The caller's own event lands exactly on the target.
    points.pop();
    points.into_iter().map(|(p, d)| (Point { x: round1(p.x), y: round1(p.y) }, d)).collect()
}

/// Keeps a pointer position on screen: never negative, inside the viewport when it's known.
pub fn clamp_point(point: Point, bounds: Option<(f64, f64)>) -> Point {
    let clamp = |value: f64, max: Option<f64>| {
        let upper = max.map(|m| (m - 1.0).max(0.0)).unwrap_or(f64::INFINITY);
        value.max(0.0).min(upper)
    };
    Point { x: clamp(point.x, bounds.map(|b| b.0)), y: clamp(point.y, bounds.map(|b| b.1)) }
}

/// Per-frame wheel deltas for one scroll gesture: a quick start that eases out, at ~60 Hz.
pub fn glide(dx: f64, dy: f64) -> Vec<Point> {
    let distance = dx.hypot(dy);
    if distance < 40.0 {
        return vec![Point { x: dx, y: dy }];
    }
    let frames = (((140.0 + distance * 0.45).min(650.0) * random(0.85, 1.15)) / 16.7).round().max(4.0) as usize;
    let ease = |t: f64| 1.0 - (1.0 - t).powi(3);
    (0..frames)
        .map(|i| {
            let a = ease((i + 1) as f64 / frames as f64) - ease(i as f64 / frames as f64);
            Point { x: dx * a, y: dy * a }
        })
        .collect()
}

pub async fn sleep_ms(ms: f64) {
    if ms > 0.0 {
        tokio::time::sleep(Duration::from_micros((ms * 1000.0) as u64)).await;
    }
}

fn since_ms(instant: Option<Instant>) -> f64 {
    instant.map(|i| i.elapsed().as_secs_f64() * 1000.0).unwrap_or(f64::INFINITY)
}

impl InputState {
    /// A target point with a person's small, consistent offset from the exact center.
    pub fn aim(&mut self, target: Point) -> Point {
        let reuse = self.aim.map(|aim| (aim.x - target.x).hypot(aim.y - target.y) < 1.0).unwrap_or(false);
        if !reuse {
            self.aim = Some(Aim { x: target.x, y: target.y, dx: noise(2.2), dy: noise(1.6) });
        }
        let aim = self.aim.unwrap();
        Point { x: round1(target.x + aim.dx), y: round1(target.y + aim.dy) }
    }

    /// Where a first movement on the page starts: somewhere plausible near the target, not the corner.
    pub fn start_point(&self, to: Point, bounds: Option<(f64, f64)>) -> Point {
        clamp_point(self.pointer.unwrap_or(Point { x: to.x + random(-260.0, 260.0), y: to.y + random(-180.0, 180.0) }), bounds)
    }

    pub fn arrived(&mut self) {
        self.arrived_at = Some(Instant::now());
    }

    /// People settle on a target for a moment before pressing.
    pub async fn before_press(&mut self) {
        sleep_ms(random(45.0, 130.0) - since_ms(self.arrived_at).min(1000.0)).await;
        self.pressed_at = Some(Instant::now());
    }

    /// A press is held 60-140 ms.
    pub async fn before_release(&mut self) {
        if self.pressed_at.is_some() {
            sleep_ms(random(60.0, 140.0) - since_ms(self.pressed_at)).await;
            self.pressed_at = None;
        }
    }

    /// Consecutive key presses are 30-110 ms apart.
    pub async fn before_key(&mut self) {
        let since = since_ms(self.last_key_at);
        if since < 1000.0 {
            sleep_ms(random(30.0, 110.0) - since).await;
        }
        self.last_key_at = Some(Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trajectory_moves_toward_the_target_and_stays_short_of_it() {
        let from = Point { x: 10.0, y: 10.0 };
        let to = Point { x: 400.0, y: 300.0 };
        let path = trajectory(from, to);
        assert!(path.len() > 5);
        let last = path.last().unwrap().0;
        assert!((last.x - to.x).abs() < 40.0 && (last.y - to.y).abs() < 40.0);
        assert!(path.iter().all(|(_, delay)| *delay >= 8.0 && *delay <= 18.0));
        assert!(trajectory(from, Point { x: 11.0, y: 10.0 }).is_empty());
    }

    #[test]
    fn glide_sums_to_the_requested_delta() {
        let frames = glide(0.0, 600.0);
        let total: f64 = frames.iter().map(|p| p.y).sum();
        assert!((total - 600.0).abs() < 1e-6);
        assert_eq!(glide(0.0, 10.0).len(), 1);
    }

    #[test]
    fn clamp_keeps_points_on_screen() {
        let p = clamp_point(Point { x: -5.0, y: 900.0 }, Some((800.0, 600.0)));
        assert_eq!(p, Point { x: 0.0, y: 599.0 });
    }
}
