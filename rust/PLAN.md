# browse in Rust

A rewrite of the browse CLI/relay (`cli/`) in Rust, for OpenCode only. The Chrome extension (`src/`) stays as is and
the Rust relay must speak its exact protocol, so the store extension keeps working unchanged.

## Decisions

- **No Playwright; plain tools for OpenCode.** OpenCode has code mode, so it gets plain, typed tools and composes
  them itself. Other MCP clients get one `execute` tool instead: JavaScript run in an embedded QuickJS
  (`browse-script`) that calls the same tools in-process, with a Playwright-style `page` shim on top. The MCP proxy
  picks by `clientInfo.name` (`OPENCODE_BROWSER_TOOLS=plain|execute|all` overrides).
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
| `browse-core` | Shared contracts: `Cdp`, `Browser`, `Tool`, `ToolContext`, `ToolOutput`, wire types. Change only with care; other crates depend on it. |
| `browse-relay` | Relay server: extension WebSocket protocol and handshake, pairing and browser tokens, CDP routing per tab (incl. child targets), sessions, tab groups and cleanup, handoff, settings sync, the HTTP API (`/version`, `/tools`, `/tools/call`), data paths (XDG), relay logging. Implements `Browser`, `Cdp`. Tools: sessions, tabs, handoff, demonstrate, status, settings, tabs_cleanup. |
| `browse-page` | Page interaction over CDP: isolated worlds, frames, injected script, refs, snapshots, actionability, human-like input, stealth. Tools: navigate, snapshot, click, fill, type, press, select, hover, drag, scroll, eval, wait_for, dialog, upload, emulate, webmcp. |
| `browse-capture` | Screenshots (labels, ref, full page, diff), network capture (start/status/stop/cancel, redacted exchanges), page console capture, screen recording (MJPEG → Matroska). |
| `browse-script` | The `execute` tool for non-OpenCode clients: QuickJS on its own thread per run, `browse.<tool>()` bindings, a Playwright-style `page`/`locator` shim, TS-compatible helpers (`snapshot`, `ref`, `handoff`, `files`, `state`, ...), CPU/memory/time limits. |
| `browse` | The binary: CLI commands (`serve`, `mcp`, `execute`, `install`, `pair`, `update`, `status`, `extension`, and `browse <tool> --arg ...` for any tool), the MCP stdio proxy (plain tools for OpenCode, `execute` for other clients), starting the relay on demand, OpenCode setup, self-update (from the release service, or with npm for an npm install). |

Each crate exposes `pub fn tools() -> Vec<Arc<dyn browse_core::Tool>>`. The binary concatenates them and passes the
registry to the relay.

## Reference

The TypeScript implementation is the spec: `cli/src/**` (relay, cdp, snapshot, execute helpers, network capture,
recording, setup, update) and `src/background/**` + `src/agent-relay/**` (the extension side of the protocol).
