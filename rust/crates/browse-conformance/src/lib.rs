//! A deterministic cross-driver conformance sweep for browse's tools.
//!
//! The same scenarios run against every available backend (Chromium over CDP, Firefox over WebDriver BiDi), each
//! against its own pair of local fixture sites. Every tool call is recorded, normalized structurally (only origins,
//! file roots, timings, ids and image bytes are scrubbed), checked against per-driver ground truth, and then diffed
//! strictly against the Chromium reference. Differences that are genuinely the engines' own are pinned in
//! [`divergences`] as strict expected failures: one that stops occurring fails the sweep too.
//!
//! Nothing here is used by the shipped crates.

pub mod browser;
pub mod cdp_ws;
pub mod compare;
pub mod divergences;
pub mod launch;
pub mod scenario;
pub mod sites;
pub mod transcript;
