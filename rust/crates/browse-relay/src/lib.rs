//! The browse relay: the extension's WebSocket (pairing, CDP through chrome.debugger, tab groups, handoffs), the agent
//! tabs (each addressed by its id) and the local tool API the MCP proxy and CLI call.
//!
//! The binary runs `serve(ServeOptions::default(), tools)` with every crate's tools (this crate's from `tools()`),
//! and talks to a running relay with `client::resolve` / `client::call_tool`.

pub mod client;
pub mod domain;
pub mod guardrails;
pub mod log;
pub mod origins;
pub mod pairing;
pub mod paths;
pub mod port;
pub mod protocol;
pub mod registry;
pub mod secrets;
pub mod settings;
pub mod surface;

mod browser;
mod cdp;
mod demonstrate;
mod extension;
mod handshake;
mod link;
mod presentation;
mod relay;
mod serve;
mod tabs;
mod tools;
mod util;
mod watchdog;

pub use browser::RelayBrowser;
pub use client::Endpoint;
pub use relay::{AutoUpdateStatus, Relay};
pub use serve::{RelayHandle, ServeOptions, call_tool, serve, serve_until, start};
pub use tools::tools;

#[cfg(test)]
mod tests;
