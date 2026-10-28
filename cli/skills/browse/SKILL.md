---
name: browse
description: Browse with the user's existing Chromium-family browser (OpenCode Browser) using deterministic Playwright. Use when asked to inspect, automate, test, or interact with a visible browser tab; continue an authenticated browser workflow; handle 2FA, passkeys, CAPTCHAs, or payment confirmation; record browser behavior; or capture an authenticated network flow.
---

# browse (OpenCode Browser)

The `browse` tools (MCP server `browse`; the same commands as the `opencode-browser`
CLI) drive the user's browser through the OpenCode Browser extension.
OpenCode Browser is a **driver**, not an agent. The calling agent decides what to
do; OpenCode Browser runs deterministic Playwright code in the user's visible
browser.

Use one loop throughout: **inspect, act, verify**. Inspect the real page before
choosing locators, act through the narrowest stable control, then verify the
result through a URL or fresh page read. Never treat a successful click or human
acknowledgment as proof that the task succeeded.

## Core Workflow

### 1. Run The Task Directly

Start with the requested browser work. Relay-backed commands start the detached
relay and wait for the extension; do not start `opencode-browser serve` first.

```bash
opencode-browser execute 'return { url: page.url(), title: await page.title() }'
```

Use `opencode-browser doctor` only when setup or runtime behavior is unclear.
`status` and `doctor` are observational and never start the relay.

MCP startup, tool discovery, `skill`, and `session_current` do not contact the
relay. The first operational tool call starts it if needed; relay-backed
observational tools report unavailability instead of starting it.

For an externally supervised relay, set `OPENCODE_BROWSER_AUTOSTART=false` to
make ordinary calls fail when that relay is absent instead of launching another
process. Existing relay connections and explicit `relay restart` still work.

Ordinary CLI/MCP/SDK calls never replace a running relay. On a build mismatch,
coordinate with other agents before running `opencode-browser relay restart`.
It preserves browser tabs and durable sessions but resets JavaScript state and
snapshot refs. A busy or timed-out drain leaves the old relay running; finish
recordings/captures and disconnect raw CDP clients rather than forcing a stop.

```bash
opencode-browser doctor
opencode-browser status --json
```

Completion: one execute returns a page result and a readable session id, or
`doctor` identifies the concrete setup failure.

### 2. Choose The Page Deliberately

DevTools-attached tabs
are excluded from OpenCode Browser's inventory. `page.title()` reads time out
after five seconds if the page execution context remains unavailable; the read
timeout does not close or replace the tab.

A bare CLI execute creates a fresh session-owned page and prints the exact
`--session <id>` continuation command, or you can pass a descriptive session
name (including an optional emoji, which appears directly on the browser tab
group). Every later CLI call must pass that id or set
`OPENCODE_BROWSER_SESSION`; bare execute never guesses from human-shell current
state.

```bash
opencode-browser session new "🎙️ elevenlabs"
opencode-browser execute --session "🎙️ elevenlabs" 'return page.url()'
opencode-browser execute 'return page.url()'
```

MCP keeps one implicit process session. Omit `session` for that normal path, or
call `session_new` and pass an explicit id when one MCP process needs multiple
sessions.

Tabs you open live in the background of the user's window, in your session's
tab group, collapsed at the start of their tab strip, so the user keeps working
undisturbed; popups your clicks open join your group. The user can change this
on the extension's options page: a separate agent window that opens unfocused
beside theirs, one shared "Agents" group for every agent's tabs, or no groups at
all. Nothing you do depends on which. Don't
ask the user to watch a tab unless you hand it off. Popups (`target=_blank`,
`window.open`) are ordinary pages of your session: use
`page.waitForEvent("popup")` or `context.waitForEvent("page")`, and they show
up in `context.pages()`.

To render your own HTML, use `page.setContent(html)`. `page.goto("data:...")`
works too, but Chromium doesn't let an extension open data: URLs, so the
content is written into an `about:blank` page (`page.url()` is `about:blank`).

To work in a tab the user already has open, ask them to click the OpenCode
Browser toolbar button on it (the badge shows ON; another click takes it back).
A click while your script runs takes the tab back and stops the script with an
error saying so: stop using that tab and ask how to continue. `page.close()` on
a lent tab only releases it.
`status` then lists it with `owner=user` and its `tab=` id. Select it for one
execute, or adopt it for sticky reuse with `session_adopt({ tabId })` (omit the
selector when only one user tab is attached):

```bash
opencode-browser session adopt --tab-id 123 --session github
opencode-browser session adopt --target-url github.com --session github
opencode-browser execute --target-url github.com 'return page.url()'
```

`execute --target-url` selects a page for that call only. Continuing with just
`--session` uses the session's default page, which may still be `about:blank`.
For a multi-step task in an existing user tab, adopt it first. Always include
`page.url()` when diagnosing an empty snapshot. Snapshot labels are compact
descriptions; use `ref()` for actions rather than assuming their text is an
exact Playwright accessible name.

`targetUrl` and `targetIndex` select existing attached pages; they never
navigate. A URL selector must match exactly one page, and URL and index selectors
cannot be combined. Adoption makes that tab the session default, closes the
session's previous relay-created page, and is exclusive to one OpenCode Browser
session. Reset or delete releases an adopted user tab without closing it.

Adoption binds ownership and exact target identity before initializing automation.
Until the first execute resolves the page, session status reports `connected:
false` and `pageUrl: null`; `adoptedUrl` is the registry-selected URL, not a fresh
page read. A busy page can produce `session-page/adopted-initialization-timeout`
on execute: user code did not run, and the exact adopted target is retained.
Retry after the page settles; do not reset or adopt a different tab to recover.

Prefer adoption for authenticated browser state rather than reproducing login
in a fresh page.

Each relay controls one browser/profile at a time. A second extension connection
cannot replace a healthy active connection. If `status` or `doctor` reports
rejected competing connections, keep the extension enabled only in the intended
browser/profile. To switch browsers, disconnect the incumbent extension first;
creating a new execute session does not switch browsers.

Completion: the selected page URL is the intended page, and later work either
retains the returned session id or intentionally uses the MCP process session.

### 3. Inspect, Act, Verify

Inspect before guessing roles or selectors:

```js
return await snapshot()
```

Then act from the returned structure and verify the destination:

```js
await ref("e12").click()
await page.getByRole("heading", { name: "Settings" }).waitFor()
if (!page.url().includes("/settings")) {
  throw new Error(`Unexpected destination: ${page.url()}`)
}
return { url: page.url(), heading: await page.getByRole("heading").first().innerText() }
```

Use normal Playwright first. Keep dependent interactions in one execute when
they rely on transient UI such as an open menu, selected rows, hover state, or
an in-progress form.

Clicks, hovers and key presses already move and pace like a person (curved
mouse paths, a short settle before pressing, human key gaps), so don't add your
own `steps` or delays. (The user can turn this off on the options page, or with
`OPENCODE_BROWSER_HUMAN_INPUT=0`, for speed; don't ask them to.) `fill()` pastes text in one go; on sites that watch
typing (sign-ups, logins behind bot protection), type with
`locator.pressSequentially(text)` instead.

If native `locator.fill()` hangs because a browser extension interferes with
focus, use the explicit input, textarea, or contenteditable fallback. It is a
last resort: it sets the value with synthetic input events (no key presses,
`isTrusted: false`) that pages can tell apart from typing, and the execute
result carries a warning saying so:

```js
await fillInput(page.getByPlaceholder("Username"), "standard_user")
```

Completion: the final return value contains evidence of the requested outcome,
not merely evidence that an action was attempted.

### 4. Continue Or Finish Cleanly

Named sessions preserve their default page across short-lived CLI and MCP
processes. They also survive relay restarts: OpenCode Browser restores the id,
read-only mode, and exact default target. JavaScript `state` and snapshot refs
are process-local and reset after a relay restart with an explicit warning.

```bash
opencode-browser session list
opencode-browser session reset github
opencode-browser session delete github
```

Deletion is idempotent for an explicit session id, so cleanup can be safely
retried when that session is already absent.

Give a session a short, meaningful id (`github`, `checkout-test`): the tabs it
opens are grouped in the browser under that name (unless the user chose one
shared group, or none). Unnamed sessions are grouped as "Agent · <site>".

Tabs agents open close by themselves after about 10 minutes without use (no
command and not visited by the user; the user can set 30 or 60 minutes, or
never); tabs the user shared, pinned, or is looking at stay open. When a task is done, tidy up right away:

```bash
opencode-browser tabs cleanup --idle-minutes 0   # MCP: tabs_cleanup { idleMinutes: 0 }
```

Every execute is journaled under
`<data root>/sessions/<id>/journal.jsonl` (`~/.local/share/opencode-browser` on
macOS and Linux). The journal records code,
status, duration, URL movement, warnings, handoffs, and bounded diagnostics.
Never place credentials directly in execute source.

```bash
opencode-browser journal --session github --limit 50
```

Completion: retain the session only when follow-up work is expected; otherwise
reset or delete session-owned pages and report any warnings that affect later
work.

## Canonical Authenticated Flow

The distinguishing OpenCode Browser workflow is an authenticated tab plus a
human-only prompt:

Attach and adopt the existing tab, inspect its real UI, fill ordinary fields,
then register `handoff` before triggering WebAuthn, 2FA, CAPTCHA, or payment UI.
After the user completes it, verify the authenticated destination. The same
session can continue after an MCP process or relay restart.

When the prompt-triggering action may itself block, put only that action in
`start`. OpenCode Browser presents and acknowledges WAIT before invoking it:

```js
await handoff("Complete the security-key prompt, then continue", {
  timeoutMs: 600_000,
  start: () => page
    .getByRole("button", { name: /passkey|security key|sign in/i })
    .click({ timeout: 600_000 }),
})

await page.waitForURL((url) => !url.pathname.startsWith("/login"))
await page.getByRole("heading", { name: /account|dashboard/i }).waitFor()
return { authenticatedUrl: page.url(), title: await page.title() }
```

After a resolved handoff, OpenCode Browser waits through transient destination
context replacement before returning, so this verification can remain in the
same execute.

With `start`, the handoff deadline and target cancellation remain active until
the action settles, even if the user has already pressed Continue. An early
acknowledgment does not authorize an indefinitely pending action.

For a handoff on another page, pass `{ page: otherPage }`. Readiness checks that
page, not the session default. If a non-default page was replaced or closed,
inspect the remaining pages rather than assuming an old Playwright reference
now identifies its replacement.

Tell the user what action is waiting. Human acknowledgment is not verification:
always assert the expected URL or stable element after `handoff`. If the action
was already completed and only the human step remains, call `handoff(message)`
without `start`. The default timeout is ten minutes.

Completion: the prompt was presented only after WAIT was registered, the action
settled, and the authenticated result was independently verified.

To turn a user-demonstrated flow into reusable Playwright, use `demonstrate()`.
It uses the same exact-tab handoff, records clicks, edits, checkbox/select
changes, and same-tab navigations, then returns editable code:

```ts
return await demonstrate("Perform the workflow once, then continue")
```

Password fields become explicit secret-source comments rather than copied
values. Review selectors and add outcome assertions before reusing generated
code; a demonstration records actions, not proof that the workflow succeeded.

### Password Manager Prompts

Ordinary webpage fields and accessible open-shadow-root controls remain usable.
1Password's inline menus are extension-owned iframes, not ordinary webpage DOM.
Chromium blocks one extension from debugging another extension's pages; toolbar
popups and native unlock, Touch ID, and Windows Hello prompts are not supported
Playwright control surfaces.

Focusing or filling a card-number or credential field can open the inline menu
by itself, even inside a third-party payment iframe. While it is open, Chrome
rejects every automation command for that tab; Playwright shows this as
"Execution context was destroyed" or a locator timeout, so the execute result
carries the `target/cross-extension-page` diagnostic and warning, and
`opencode-browser status` marks the tab `protected-ui=true`.

`target/cross-extension-page` means a permission boundary. Ask the user to finish
or dismiss the prompt and retry; do not reset the page, read vault contents, or
weaken browser security to get around it. The page itself is healthy: do not
treat the failure as an unresponsive tab or create a new page. Register `handoff` on the originating
webpage before triggering a human-only prompt when possible. If the prompt
already prevents attachment, give the user the required action directly rather
than assuming an in-page handoff can be displayed. Verify the intended webpage
state after the prompt is completed.

## Inspection Tools

Use the least expensive view that answers the question:

- `snapshot()` is the compact read-before-act default. It prioritizes semantic
  groups, alerts, lists, tables, headings, links, and controls. Text input and
  textarea values are omitted.
- The default snapshot scopes to a single visible modal when present; portal
  dialogs outside `main` remain discoverable. Use an explicit `within` scope
  when you intentionally need background content. Repeated list wrappers have
  a bounded reservation so product links can still fit in a dense page.
- Native number/search inputs are `spinbutton`/`searchbox`. Native disclosure
  controls are labeled `summary`, which is an element kind rather than an ARIA
  role; use the returned `ref()` to operate them.
- `ref("e12")` resolves a control from the latest snapshot. Refs fail closed
  after navigation or incompatible DOM drift. Compatible refs keep the same id
  across repeated same-document captures.
- `snapshot({ diff: true })` reports semantic changes from the compatible prior
  baseline. `snapshot({ delta: true })` returns a full first baseline and compact
  deltas afterward. Existing compatible refs remain usable.
- `snapshot({ find: "checkout", context: 2 })` searches the bounded semantic
  snapshot and returns matching lines with nearby context and actionable refs.
- `ariaSnapshot(target?, { timeout })` returns Playwright's detailed YAML aria
  tree when the compact snapshot omits needed structure. Native text-control
  values, custom ARIA range values, and editable content are omitted so they do
  not enter tool output. Await it separately; do not run other operations on
  the same page concurrently.
- `screenshotWithLabels({ page?, path? })` adds visual labels and metadata when
  layout matters, and registers its `e1..eN` labels for `ref()`.
- `screenshotDiff({ baseline, path?, threshold?, fullPage? })` compares a saved
  PNG (absolute path inside the execute file roots, or Buffer) with the current
  session page at CSS-pixel scale.
  It returns `matches`, `changedPixels`, `changedRatio` (0..1), dimensions, and a
  red-highlighted PNG. Omit `path` to return the image as execute media; otherwise
  supply a fresh absolute `.png` path. Existing output files are never overwritten.

```js
return await snapshot({ within: "main", maxItems: 200 })
return await snapshot({ find: /checkout|payment/i, context: 2 })
return await snapshot({ delta: true })
// When layout matters, return the image through MCP so it can be inspected.
return await screenshotWithLabels({ page })
```

Saving an image and returning only `"ok"` proves file creation, not visual
correctness. Return screenshot buffers through MCP when visual evidence matters.

For visual regression checks, save a baseline before changing the UI:

```ts
await page.screenshot({ path: files.path("before.png"), scale: "css" })
// After the intended UI change, in the same viewport:
return await screenshotDiff({ baseline: files.path("before.png") })
```

The threshold defaults to 0.1 and controls per-pixel color tolerance, not the
allowed changed area. Set it to 0 for exact pixels. Antialiasing changes count.
Settle animations yourself and use the same viewport and `fullPage` setting for
both captures. Dimension mismatches fail explicitly; images are never resized.
Comparisons are limited to PNGs of 32 MiB / 16 megapixels each. Screenshots and
diffs include visible page content: inspect for private information before sharing.

## Execute Interface

Execute code can use `page`, `context`, `browser`, persistent `state`, the
`files` helper, compute-only Node modules through `modules` and the aliases
`path`, `url`, `util`, `crypto`, `buffer`, `zlib`, `events` and `stream`, plus
the OpenCode Browser helpers documented here. Timers, `URL`, `TextEncoder`,
`Buffer`, `structuredClone` and `crypto.randomUUID()` are available. Use
`page.evaluate` for `window`, `document`, storage, and same-origin `fetch`
with page cookies. `page.evaluate` runs in an isolated world, whose `fetch`
skips the page's service worker; pass `false` as its fourth argument
(`page.evaluate(fn, arg, undefined, false)`) to run in the page's own world
when the worker's response matters. Single expressions auto-return;
multi-statement scripts need `return`. Use `--file` for longer scripts:

```bash
opencode-browser execute --session github --file ./perform-flow.js
```

### Writing execute code

Execute code runs in strict mode (`"use strict"`), so:

- Declare variables with `const`/`let`; assigning an undeclared name
  (`count = 1`) throws a `ReferenceError` instead of creating a global. Keep
  values between calls on `state` (`state.count = 1`).
- Writing a read-only or getter-only property, or adding one to a frozen
  object, throws instead of being ignored.
- `with`, octal literals (`010`) and duplicate parameter names are syntax
  errors, and `this` is `undefined` in plain function calls.

Long synchronous work stalls every session on the relay, so a single run
without an `await` is stopped after about 2 seconds, and callbacks or timers
that keep it busy more than half the time are stopped too. Split heavy loops
with `await new Promise(r => setTimeout(r, 0))`, or do the work in the page
with `page.evaluate()`.

Execute code runs in a sandbox on the relay, because a page can try to
prompt-inject the agent writing it. It has no `process`, `require`,
`import()`, `eval`, `fs`, `os`, `child_process`, `http`/`https` or Node-side
`fetch`, and Playwright internals (`_`-prefixed members), `page.request`,
`context.request` and `browser.browserType()` are unavailable. Files go through
`files` and Playwright file options (`path`, `setInputFiles`, `saveAs`, ...),
which accept only absolute paths inside the execute file roots: the system
temp directory, `/tmp`, and directories listed in
`OPENCODE_BROWSER_FILE_ROOTS`:

```js
const saved = await files.write("report.csv", csvText)  // relative names go to files.dir
const bytes = await files.read(saved)                     // Buffer; files.read(p, "utf8") for text
await page.screenshot({ path: files.path("page.png") })   // absolute path inside a root
```

Cookie access through CDP is limited to the hosts of the session's pages:
`context.cookies()` returns only their cookies, `context.addCookies()` accepts
only cookies for them, and clearing or deleting cookies is refused.
`page.bringToFront()` is refused because it raises the user's window; use
`handoff()` when the user needs to act. The user can lift these limits on the
relay with `OPENCODE_BROWSER_ALLOW_NODE=1` (full Node in execute),
`OPENCODE_BROWSER_ALLOW_ALL_COOKIES=1` and `OPENCODE_BROWSER_ALLOW_FOREGROUND=1`;
never ask for them to work around a page.

A waiting `handoff` shows the user a small card with the page's origin (or, on a
tab being recorded, a system notification) and the WAIT badge. Only the user's
own click on Continue or the toolbar button completes it; page script can't.

Human CLI output includes logs, warnings, and a concise aftermath. Logs hold your
own `console.log` output; the page's console messages and uncaught errors are
off by default, because capturing them lets the page detect a debugger (bot
checks look for it). When you need them, for example to debug a broken page,
turn them on for that page; they then appear in each execute's logs:

```js
await pageConsole.start()   // or pageConsole.start(otherPage)
await pageConsole.stop()    // when done, so the page looks undebugged again
```

 Use `--json`
when another command needs to branch on `ok`, `value`, `error`, `warnings`, or
`aftermath`:

```bash
opencode-browser execute --json --session github '({ url: page.url() })' | jq .value.url
```

Playwright downloads are unavailable through extension-backed tabs because
Chromium blocks download artifact control through `chrome.debugger`. If the
page exposes the payload through fetch or an API response, read the bytes in the
page and save them with `files.write()`. Do not retry `page.waitForEvent("download")`.

Pages with WebMCP enabled can expose structured page tools. Discover and call
them through the execute helper; names, descriptions, schemas, and results come
from the page:

```ts
const tools = await webmcp.list()
const result = await webmcp.call("search_catalog", { query: "adapter" })
return { tools, result }
```

Discovery covers all frames. If the same name appears in multiple frames, pass
the exact reported frame label as `{ frame }`. OpenCode Browser re-discovers the
tool immediately before invoking it, so stale registrations fail directly.

## Safety

OpenCode Browser blocks CDP commands that would destroy shared browser state,
including browser close and cookie/cache clearing. Never work around those
guardrails. Cookies and site storage (IndexedDB, Cache Storage, local storage,
quota) are limited to the hosts of your session's pages, and navigations to
`file:`, `chrome:`, `chrome-extension:`, `devtools:` and `view-source:` URLs
are refused.

For inspect-only work, use a read-only session:

```bash
opencode-browser session new inspect-prod --read-only
opencode-browser execute --session inspect-prod 'await page.goto("https://example.com"); return page.title()'
```

Read-only sessions reject `Input.*`, so they cannot click or type through
Playwright. `page.evaluate` can still mutate the DOM; read-only prevents trusted
mistakes, not malicious code.

For destructive UI work, use a two-phase **read, confirm, verify** flow:

1. Read candidates and return exact stable identifiers or row text.
2. Obtain user approval for those exact items.
3. Re-select only approved items and assert the selected count.
4. Read the confirmation dialog and throw unless it matches the approved action.
5. Confirm, then verify through a fresh page read or independent CLI/API path.

Do not discover and confirm destructive candidates in one script unless the
user already approved exact stable identifiers. Never globally auto-accept
native dialogs; wait for the expected dialog and assert its type and message
before accepting it.

## TypeScript Client

Applications and CLI tools can use `OpenCodeBrowserClient.origin()` for direct
same-origin JSON requests authenticated by a session page (with optional default
headers and automatic in-page `handoff` recovery when a session expires or
redirects to login):

```ts
import { OpenCodeBrowserClient } from "opencode-browser-cli"

const ubereats = OpenCodeBrowserClient.origin("https://www.ubereats.com", {
  session: "🥤 karma-cafe",
  startUrl: "/feed",
  headers: { "x-csrf-token": "x" },
  handoffOnAuthFailure: true,
})

const store = await ubereats.post("/_p/api/getStoreV1", {
  storeUuid: "78cb1602-9f58-57bb-ad08-f6b8f80bb788",
  diningMode: "DELIVERY",
})
```

For Effect-native applications with schema decoding or `sensitive: true`
`Redacted` responses, use `OpenCodeBrowserClient.Service`:

```ts
import { OpenCodeBrowserClient } from "opencode-browser-cli"

const sensitive = yield* origin.json({
  path: "/api/session",
  method: "POST",
  body: {},
  response: SessionResponse,
  sensitive: true,
})
const session = OpenCodeBrowserClient.reveal(sensitive)
```

## Authenticated Network Capture

Use network capture when the browser is needed to authenticate or discover a
workflow, but repeated direct HTTP calls would be faster and more reliable.
Capture each flow at least twice with different inputs so constants and
parameters can be distinguished.

```bash
opencode-browser network start --session github --url /api/ \
  --resource-type fetch --resource-type xhr
opencode-browser execute --session github --file ./perform-flow.js
opencode-browser network status --session github
opencode-browser network stop --session github \
  --output ./github.har --secrets github
```

Written artifacts replace credential-bearing headers, cookies, query fields,
OAuth fragment fields, and structured body fields with stable references such as `${BC_SECRET_1}`.
`--secrets github` stores lossless values separately in a mode-`0600` Secret
Profile. Passwords and one-time codes typed during capture are redacted as
`${BC_REDACTED_N}` and never stored. Never copy profile values into source,
output, diagnostics, or journals, and never deliberately return or log
credentials.

Inspect the redacted artifact offline, generate one typed function per observed
flow, then verify each function with a harmless live request. Run generated
clients with the values injected, so they stay out of the transcript:

```bash
opencode-browser secrets status github
opencode-browser secrets run github -- ./github-cli repositories
```

Generated TypeScript applications can own that wrapper internally through the
public SDK:

```ts
import { SecretProfile } from "opencode-browser-cli"
import { Effect } from "effect"

const result = await Effect.runPromise(SecretProfile.run({
  name: "github",
  command: process.execPath,
  args: ["./github-cli.js", "repositories"],
}))
```

The trusted worker receives `BC_SECRET_N` variables and its bounded output is
redacted. The public SDK exposes profile metadata but never raw profile values.
Redaction keeps values out of transcripts and artifacts by accident; it does not
protect them from a command that deliberately sends, encodes or writes them,
because that command receives the real values. Only run commands you wrote or
trust. Execute code isn't given access to Secret Profile files. Commands run
with a profile get the relay's allowlisted environment (`PATH`, `HOME`, locale,
proxy variables, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`) plus
the `BC_SECRET_N` values, not the user's full shell environment.

Refresh credentials normally renewed by a page reload with:

```bash
opencode-browser secrets refresh github --session github --url /api/
```

If refresh requires login or a human prompt, reauthenticate in the adopted tab
and repeat capture with the same profile. MCP exposes equivalent `network_*`
and `secrets_*` tools.

Completion: the artifact contains references rather than credential values, the
generated operation passes a harmless live check, and no secret value appears
in source or output.

## Recording

Record an attached or session-owned tab with:

```bash
opencode-browser recording start ./tmp/demo.mp4 --session github --mode cdp   # add --cursor for a demo video
opencode-browser recording status --session github
opencode-browser recording stop --session github
```

Start, stop, and status accept `--json`. CDP stop/status results include a
`quality` receipt: output dimensions/rate, source and retained-image counts/rates,
coalesced/dropped frames, and `screenshotFallback`. The fallback means no
compositor frames arrived and the video holds one stop-time screenshot; do not
present that as recorded motion. Source counters count compositor events, not
visually distinct frames. Low rates can be normal on a static page. Tab capture
and older relays omit quality telemetry rather than inventing measurements.

Explicit frame rates must be integers from 1 through 60 in either mode; invalid
values fail instead of silently clamping. The start result reports the chosen rate.

`--mode auto` uses tab capture for user-owned tabs and CDP for relay-owned tabs.
Tab capture can include audio; CDP requires `ffmpeg` and has no audio. Use the
command's `--help` for format options.

Recordings are clean by default: nothing from OpenCode Browser is drawn in the
recorded page. The ghost cursor stays off, `screenshotWithLabels` draws its
labels onto the returned image instead of the page, and a handoff on a tab being
recorded shows no in-page card: the user gets a system notification and the
toolbar badge says WAIT (the card appears if the recording stops first, or
right away if notifications are turned off for the extension, in which case
the recording shows it).

The on-page Ghost Cursor (`distance-glide` motion + `tactile-bloom` click
shockwave) is off by default, because pages can detect an element added to their
DOM. Turn it on for demo videos with `--cursor` (`cursor: true` on the
`recording_start` and `flight_recorder_start` tools); it then follows Playwright
mouse actions while that recording runs. `showGhostCursor()` shows it on a tab
until `hideGhostCursor()`. The user's *Agent cursor* setting on the options page
(or `OPENCODE_BROWSER_GHOST_CURSOR=1` on the relay) shows it on every agent tab
outside recordings; a recording without `cursor: true` still leaves it out. When recording a user-facing proof or PR walkthrough
video, opt into the `ghostCursor` helpers inside `execute` to focus attention on
key steps and verified postconditions (captions, zoom and spotlights are drawn
only when you call them):

```ts
await showGhostCursor()
await ghostCursor.caption("Verify cluster & promote release", { step: "01", tone: "neutral" })
await ghostCursor.zoom("#release-card", { scale: 1.45 })
await page.locator("#promote-btn").click()
await ghostCursor.keys("⌘+⇧+P", "Promote Release")
await ghostCursor.resetZoom()
await ghostCursor.spotlight("#status-badge", { label: "Verified", detail: "200 OK", tone: "success" })
```

CDP recordings preserve the starting CSS viewport (not a fixed 720p canvas),
use high-quality source frames, and default to 60 fps. Use `--frame-rate 30`
for smaller files. Actual motion still depends on Chrome delivering new frames;
60 fps output does not guarantee 60 distinct frames. Larger viewports cost more
CPU, transport bandwidth, and storage. Set the viewport before recording and do
not change viewport/emulation mid-recording. Odd dimensions round down to even.

For failures that are hard to reproduce, keep a rolling CDP frame buffer and
save recent history after the problem occurs:

```bash
opencode-browser flight-recorder start --session github --retention-ms 60000
opencode-browser flight-recorder status --session github
opencode-browser flight-recorder save-last ./tmp/failure.mp4 --session github --duration-ms 30000
opencode-browser flight-recorder cancel --session github
```

Saving does not stop buffering. The recorder is memory-bounded, reports retained
duration/frame/byte/drop counters, writes a JSON receipt beside each clip, and is
mutually exclusive with ordinary recording on the same tab. CLI recording and
flight-recorder lifecycle operations are also available as MCP tools.

Inspect an encoded frame at native size before sharing: the whole viewport must
fill the frame, small text must be readable, and motion must not be a repeated
still image. Do not crop and upscale a low-resolution capture to call it HD.
On an older installed relay that shrinks the page into a padded corner, record
the defect and coordinate a recorder update; changing the file's resolution is
not a repair.

Completion: stop the recorder, inspect the resulting media rather than only its
existence, and report the viewport, state, and interaction path actually tested.

## Changing settings

Use the `settings` tool (CLI: `opencode-browser settings get` / `settings set
key=value …`) only when the user asks to change how browse behaves: where your
tabs open (`window`: current, separate), how they're grouped (`grouping`:
session, shared, none), when untouched agent tabs close (`idleMinutes`: 10, 30,
60, never), the agent cursor (`cursor`: off, always), human-like input
(`humanInput`: on, off) and handoff notifications (`handoffNotifications`:
recording, always). Never change them on your own initiative, for example to
speed up a task. Without `set` it reports each setting's value, the value in
effect and the environment variable overriding it, if any.

```js
// MCP: settings { set: { grouping: "shared" } }
```

The change applies at once and the options page shows it. Tell the user what you
changed (the result's `message` says what). A setting a relay environment
variable fixes isn't changed; pass that on with the variable's name. Security
switches (`OPENCODE_BROWSER_ALLOW_*`, `OPENCODE_BROWSER_UPDATE_CHECK`) are not
settings: they exist only in the relay's environment and no tool changes them.

## Updating browse

When a tool result or `status` says browse has an update, tell the user once,
with the command it names. If the user asks you to update browse, run that
command yourself (`node <browse>/cli/dist/cli.mjs update`): it fast-forwards the
git clone and reruns setup, and refuses with the fix when the clone has local
changes or has diverged. Pass its refusal on rather than resolving git state
yourself. The update takes effect after the user restarts opencode, so finish
browser work first and tell them to restart.

## Troubleshooting

1. Run `opencode-browser doctor`; it checks package metadata, CLI/relay build
   identity, extension protocol compatibility, sessions, targets, and artifacts.
2. Use `status --json` to inspect exact sessions and target ownership.
3. Reproduce once with the smallest execute before changing code.

Common diagnoses:

- `session-page/context-read-timeout; operation=page.title; timeoutMs=5000`:
  the title read did not finish within its budget. The execution context may be
  unavailable or busy; this does not prove a frozen renderer. The watchdog does
  not cancel the underlying read or trigger page replacement. A cached
  `page.url()` read can still work; retry the page read after the page settles.
  Ordinary missing-locator timeouts do not receive this diagnostic.
- `connected:false`: run a relay-backed command and allow the extension startup
  or alarm wake-up to reconnect. A sleeping extension wakes on a 30-second
  alarm, so the command waits up to 35 seconds. Reload the unpacked extension
  only if that loop does not recover.
- Incompatible extension protocol: update either the extension or npm package;
  exact extension and relay release versions do not need to match.
- Competing browser/profile connections: the active browser is preserved and
  additional connections are rejected. Use one browser/profile per relay;
  repeatedly creating sessions or resetting tabs does not switch browsers.
- Stale relay build: inspect `doctor`, then coordinate an explicit
  `opencode-browser relay restart`. It requires an exact managed instance and
  safe shutdown protocol 2. Legacy relays need a one-time coordinated manual
  stop; foreground/source or newer relays are never force-killed or downgraded.
  MCP observational tools remain available on a mismatch.
- Unexpected restart: inspect private endpoint-scoped
  `~/.local/share/opencode-browser/relays/<port>/lifecycle.jsonl` (under the
  data root) for requester/build/instance metadata. When developing OpenCode
  Browser itself, test against an isolated relay (`OPENCODE_BROWSER_PORT` and
  `OPENCODE_BROWSER_HOME`), not the user's running one.
- `Target not found`: attach the intended tab, then select or adopt it using a
  unique URL substring or explicit index.
- All targets disappeared: dismissing Chromium's debugging banner detaches every
  tab. Ask the user to click the toolbar button on it again.
- Extension not connecting, status page says "Not paired" or "didn't pair": the
  extension and relay must share a pairing code. Unpacked installs are paired by
  `opencode-browser install` (or `bun run setup`); a Chrome Web Store build needs
  the code from `opencode-browser pair` pasted on its status page.
- HTTP 401 from the relay: clients need the relay token from the data root
  (`relay-token`); the CLI and MCP server send it, other CDP clients must add
  `Authorization: Bearer <token>` or `?opencodeBrowserToken=<token>`.
- Relay restarted: named sessions reclaim exact targets, but JavaScript `state`
  and snapshot refs reset. Continue after the warning.
- Reset/delete after an extension update may wait briefly for target
  re-announcement; if the old relay-owned target is absent from the completed
  inventory, OpenCode Browser forgets the dead identity without closing a
  guessed tab.
- Repeated execution-context errors: run one short follow-up so OpenCode Browser
  can health-check the page. A live page is kept: OpenCode Browser reconnects and
  re-resolves the same tab once, then fails with a `session-page/*-unresponsive`
  diagnosis if the page still does not answer. Blank or unknown URLs are preserved:
  they can contain unsaved content. Only a crashed or
  `chrome-error://` relay-owned page is closed and recreated. It never replaces
  an adopted user tab. Main-frame navigation clears an earlier crash diagnosis;
  child-frame navigation does not. When a page stays unresponsive (bot-protected sites can
  stall the main world for automation while rendering normally for the human),
  open a fresh tab with `context.newPage()` or hand the tab to the user.
- Handoff ends with "page execution context did not become available": the user
  finished; only OpenCode Browser's view of the tab is stale. Run a short
  follow-up execute so the page is re-checked instead of assuming it was lost.
- Fill timeout on login fields: inspect first, then try `fillInput` after
  confirming the selector or locator resolves. String selectors search open
  shadow roots recursively; closed shadow roots remain unavailable.
- Click blocked by a verified dialog backdrop: inspect the exact target and
  blocker first. If the target is the approved action and Playwright actionability
  alone is stale, dispatch `await locator.evaluate((element) => element.click())`,
  then verify the result. Do not make dispatched clicks the default.
- Hidden checkbox/radio input: click its visible associated label or wrapper,
  then verify `isChecked()`. Do not force-click an invisible input or infer an
  arbitrary ancestor.
- Download wait fails: use fetch plus `files.write()`; extension-backed Playwright cannot
  retain a native download artifact.
- Hover on an infinitely animated target: Playwright may never consider the
  element stable. Read its current `getBoundingClientRect()` and use
  `page.mouse.move()` when coordinate input is appropriate.
- Chromium-protected pages such as the Chrome Web Store developer dashboard may
  detach `chrome.debugger`. Do not retry or bypass that boundary; open the page
  for manual operation.

For deeper relay diagnosis, restart with `OPENCODE_BROWSER_DEBUG=1`. Debug traces
must never include expressions, arguments, results, headers, cookies, or form
values.

Whenever OpenCode Browser fails, wedges, replaces a page/session, or behaves
unexpectedly, create or update a `opencode-browser` project todo with the Browser
Control version, safe session/page context, exact error, deterministic
reproduction, expected versus actual behavior, and recovery attempted. Never
include credentials, form values, or private account data.
