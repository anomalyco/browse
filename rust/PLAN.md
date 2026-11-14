# browse in Rust

A rewrite of the browse CLI/relay (`cli/`) in Rust, for OpenCode only. The Chrome extension (`src/`) stays as is and
the Rust relay must speak its exact protocol, so the store extension keeps working unchanged.

## Decisions

- **No `execute` tool and no Playwright.** OpenCode has code mode, so browse exposes plain, typed tools and OpenCode
  composes them. No embedded JS engine on the host.
- **Talk CDP directly** through the extension's chrome.debugger relay. Inject Playwright's in-page script
  (`injectedScriptSource`, Apache-2.0, from `cli/node_modules/patchright-core`) into an isolated world for selectors,
  `getByRole`-style lookups and `ariaSnapshot`, so snapshot quality matches today.
- **Stealth like Patchright:** never call `Runtime.enable` or `Console.enable` by default; run browse code in
  `Page.createIsolatedWorld` worlds; leave no globals, bindings or `sourceURL` markers in the page.
- **One process per agent session is a thin proxy.** `browse mcp` is a stdio MCP server that forwards `tools/list`
  and `tools/call` to the relay over local HTTP (`GET /tools`, `POST /tools/call` with `browse_core::ToolCallRequest`).
  No update supervisor process: the proxy reconnects to whatever relay is running.
- **Goals:** small binary (single-digit MB), low memory (a few MB per MCP proxy, tens of MB for the relay).
- Only OpenCode is configured by `browse install`. Other agents are out of scope.

## Layout (`rust/`, cargo workspace)

| Crate | Owns |
|---|---|
| `browse-core` | Shared contracts: `Cdp`, `Browser`, `Secrets`, `Tool`, `ToolContext`, `ToolOutput`, wire types. Change only with care; other crates depend on it. |
| `browse-relay` | Relay server: extension WebSocket protocol and handshake, pairing and browser tokens, CDP routing per tab (incl. child targets), sessions, tab groups and cleanup, handoff, site secrets, settings sync, the HTTP API (`/version`, `/tools`, `/tools/call`), data paths (XDG), relay logging. Implements `Browser`, `Cdp`, `Secrets`. Tools: sessions, tabs, handoff, demonstrate, secrets, status, settings, tabs_cleanup. |
| `browse-page` | Page interaction over CDP: isolated worlds, frames, injected script, refs, snapshots, actionability, human-like input, stealth. Tools: navigate, snapshot, click, fill, type, press, select, hover, drag, scroll, eval, wait_for, dialog, upload, emulate, webmcp. |
| `browse-capture` | Screenshots (labels, ref, full page, diff), network capture (start/status/stop/cancel, redacted exchanges), page console capture, screen recording (MJPEG → Matroska). |
| `browse` | The binary: CLI commands (`serve`, `mcp`, `install`, `pair`, `update`, `doctor`, `status`, `extension`, and `browse <tool> --arg ...` for any tool), the MCP stdio proxy, starting the relay on demand, OpenCode setup, self-update from the release service. |

Each crate exposes `pub fn tools() -> Vec<Arc<dyn browse_core::Tool>>`. The binary concatenates them and passes the
registry to the relay.

## Reference

The TypeScript implementation is the spec: `cli/src/**` (relay, cdp, snapshot, execute helpers, network capture,
recording, setup, update) and `src/background/**` + `src/agent-relay/**` (the extension side of the protocol).
