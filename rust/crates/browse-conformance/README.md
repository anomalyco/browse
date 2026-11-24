# browse-conformance

A cross-driver conformance sweep for browse's tools. The same deterministic scenarios run against Chromium (CDP over
`--remote-debugging-port`, one WebSocket per tab) and Firefox (WebDriver BiDi), each against its own pair of local
fixture sites (`127.0.0.1:<port>` and `localhost:<port>`). Every tool call is recorded, normalized structurally, checked
against ground truth (the fixture server's request log, files on disk, the browser's tab count), and Firefox's
transcript is diffed strictly against Chromium's. Genuine engine or protocol differences are pinned in
`src/divergences.rs` as strict expected failures: one that stops occurring fails the sweep.

Not published, and no production crate depends on it.

## Running

```sh
cd rust
BROWSE_CONFORMANCE_REQUIRE=chromium-cdp,firefox-bidi cargo test -p browse-conformance -- --nocapture
```

Without a browser installed the sweep skips that backend (unless it is required); a browser that is installed but
fails to start always fails. The browser-free tests (normalizer, comparator, stale-divergence detection, fixture
server) run everywhere.

| Variable | Meaning |
| --- | --- |
| `BROWSE_CONFORMANCE_REQUIRE` | Backends that must be found, e.g. `chromium-cdp,firefox-bidi`. |
| `BROWSE_CONFORMANCE_BACKENDS` | Only run these backends. |
| `BROWSE_CONFORMANCE_ONLY` | Only run these scenarios (the leak canary keeps its baseline). |
| `BROWSE_CONFORMANCE_OUT` | Write `<backend>.json` transcripts and `diff.json` to this folder. |
| `BROWSE_TEST_CHROME` / `BROWSE_TEST_FIREFOX` | The browser binaries (default: Playwright's Chrome for Testing, then system Chrome, then the headless shell; `/Applications/Firefox.app`, then `firefox` on PATH). |

Browsers run headless in throwaway profiles; downloads go to the profile, never `~/Downloads`.

## Out of scope

The extension transport (`cdp+extension`), the relay's guardrails and its `RelayBrowser`: the sweep's
`HarnessBrowser` stands in for the relay with a minimal policy (`readOnly`, `allowedOrigins`).

## Notes on the browsers

- Chromium 148's new headless mode on macOS can spin for good in AppKit's key-equivalent dispatch when keys are sent
  while a text field has a selection (Shift+Arrow, then Backspace), taking the whole browser down. The scenarios avoid
  keyboard selections; the headless shell and headful Chrome don't have the problem. On macOS the browser also runs
  with `--use-mock-keychain`, without which it can wait on the login keychain before opening its DevTools port.
- Firefox throttles a background tab's timers to one a second, so scenario tabs open with `keepVisible`. Headless
  Chromium keeps every page visible anyway, and its tabs always open in the background.
