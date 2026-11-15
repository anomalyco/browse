# browse in Rust

A rewrite of the browse CLI/relay (`cli/`) in Rust, for OpenCode only. The Chrome extension (`src/`) stays as is and
the Rust relay must speak its exact protocol, so the store extension keeps working unchanged.

## Decisions

- **No Playwright; plain tools for OpenCode.** OpenCode has code mode, so it gets plain, typed tools and composes
  them itself. Other MCP clients get `execute` (plus `status` and `tabs`) instead: JavaScript run in an embedded
  QuickJS (`browse-script`) that calls the same tools in-process, with a Playwright-style `page` shim on top. The
  relay picks by the client's `clientInfo.name`, which the MCP proxy forwards in the `OpenCode-Browser-Client`
  header on `/tools`, `/instructions` and `/tools/call` (`OPENCODE_BROWSER_TOOLS=plain|execute|all` overrides,
  relay-side).
- **Tabs are the handle; there are no sessions.** `navigate` without `tab` (or `tabs new`) opens a background agent
  tab and returns its id; every other page and capture tool requires `tab`. Options are fixed when a tab opens:
  `group` (the Chrome tab group's title and a handle for bulk close), `allowedOrigins`, `readOnly`, `keepVisible`,
  `browser`; popups a page opens become agent tabs with the opener's options. A tab is either opened by browse (an
  agent tab) or lent by the user (toolbar button); agents can't touch any other tab. Everything tools keep (refs,
  captures, emulation, execute `state`, busy flags, handoffs, focus) is per tab. No caller identity is needed, so
  every client behaves the same and the MCP proxy is a dumb pipe; calls are still tagged with the client pid so a
  dead client's calls and handoffs stop. Agent tabs (ids, options, group) persist in `<data>/relays/<port>/tabs.json`
  and are reattached after a relay restart.
- **Talk CDP directly** through the extension's chrome.debugger relay. Inject Playwright's in-page script
  (`injectedScriptSource`, Apache-2.0, from `cli/node_modules/patchright-core`) into an isolated world for selectors,
  `getByRole`-style lookups and `ariaSnapshot`, so snapshot quality matches today.
- **Stealth like Patchright:** never call `Runtime.enable` or `Console.enable` by default; run browse code in
  `Page.createIsolatedWorld` worlds; leave no globals, bindings or `sourceURL` markers in the page.
- **The MCP server is a thin proxy.** `browse mcp` is a stdio MCP server that forwards `initialize` (instructions),
  `tools/list` and `tools/call` to the relay over local HTTP (`GET /instructions`, `GET /tools`, `POST /tools/call`
  with `browse_core::ToolCallRequest`). No update supervisor process: the proxy reconnects to whatever relay is
  running.
- **Goals:** small binary (single-digit MB), low memory (a few MB per MCP proxy, tens of MB for the relay).
- Only OpenCode is configured by `browse install`. Other agents are out of scope.

## Layout (`rust/`, cargo workspace)

| Crate | Owns |
|---|---|
| `browse-core` | Shared contracts: `Cdp`, `Browser`, `Tool`, `ToolContext`, `ToolOutput`, wire types. Change only with care; other crates depend on it. |
| `browse-relay` | Relay server: extension WebSocket protocol and handshake, pairing and browser tokens, CDP routing per tab (incl. child targets), agent and lent tabs and their registry, tab groups and idle cleanup, handoff, settings sync, the HTTP API (`/version`, `/tools`, `/instructions`, `/tools/call`) and which tools and instructions each client gets, data paths (XDG), relay logging. Implements `Browser`, `Cdp`. Tools: tabs, handoff, demonstrate, status, settings. |
| `browse-page` | Page interaction over CDP: isolated worlds, frames, injected script, refs, snapshots, actionability, human-like input, stealth. Tools: navigate, snapshot, click, fill, type, press, select, hover, drag, scroll, eval, wait_for, dialog, upload, emulate, webmcp. |
| `browse-capture` | Screenshots (labels, ref, full page, diff), network capture (start/status/stop/cancel, redacted exchanges), page console capture, screen recording (MJPEG → Matroska). |
| `browse-script` | The `execute` tool for non-OpenCode clients: QuickJS on its own thread per run, `browse.<tool>()` bindings, a Playwright-style `page`/`locator` shim bound to the `tab` passed in (or opened by its first `goto`), TS-compatible helpers (`snapshot`, `ref`, `handoff`, `files`, `state` kept per tab, ...), CPU/memory/time limits. Every result names the tab to continue in. |
| `browse` | The binary: CLI commands (`serve`, `mcp`, `execute`, `install`, `pair`, `update`, `status`, `extension`, and `browse <tool> --arg ...` for any tool, `--tab <id>` to name the tab), the MCP stdio proxy (forwards the client name; the relay decides its tools), starting the relay on demand, OpenCode setup, self-update (from the release service, or with npm for an npm install). |

Each crate exposes `pub fn tools() -> Vec<Arc<dyn browse_core::Tool>>`. The binary concatenates them and passes the
registry to the relay.

## Reference

The TypeScript implementation is the spec: `cli/src/**` (relay, cdp, snapshot, execute helpers, network capture,
recording, setup, update) and `src/background/**` + `src/agent-relay/**` (the extension side of the protocol).
