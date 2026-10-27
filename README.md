<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <img src="assets/banner-light.png" alt="browse: let your AI agents use your real browser. An isometric desk computer whose screen shows a web browser with an agent's tab group, cabled to a small relay box.">
</picture>

Let your AI agents use your real browser: your tabs, your logins, your extensions. An MCP server and a Chromium
extension, for [opencode](https://opencode.ai) and any other MCP client.

---

Agents get a `browse` MCP server. They open and drive tabs with Playwright, take screenshots, capture network
traffic and record the screen, in a browser window of their own that opens unfocused, beside yours. When it's your turn (a login,
a 2FA prompt, a payment), they hand the tab back to you and continue once you click **Continue**.

It works in Chrome, Edge, Brave, Arc, Helium, Vivaldi, Opera and Chromium.

## Install

You need [Bun](https://bun.sh), Node.js 22+, and [opencode](https://opencode.ai).

**1. Build it and add the `browse` tools to opencode**

```sh
git clone https://github.com/anomalyco/browse.git
cd browse
bun run setup
```

**2. Load the extension**

Open `chrome://extensions` (or your browser's extensions page), turn on **Developer mode**, click **Load unpacked**
and choose the `browse/dist` folder.

**3. Restart opencode**

That's it. Ask an agent to *"open news.ycombinator.com and tell me the top story"*.

There's nothing to sign in to. `setup` pairs the unpacked extension with the local relay for you: it writes a pairing
code into `dist/`, and the extension only obeys a relay that proves it knows that code (see [Security](#security)).
`bun run setup` is safe to re-run after `git pull`; it updates the tools and reloads the extension for you.

A Chrome Web Store build has no pairing file: run `node cli/dist/cli.mjs pair` and paste the code it prints on the
extension's status page (right-click the toolbar button, then **Options**).

> **Coming soon:** a Chrome Web Store listing and an npm package, so you can skip the clone.

### Other MCP clients

`setup` writes the server into opencode's config. For other clients, add an stdio server that runs the built CLI:

```json
{
  "browse": { "command": "node", "args": ["/path/to/browse/cli/dist/cli.mjs", "mcp"] }
}
```

## Using it

- **Agents open their own tabs** in a separate browser window that opens unfocused, placed beside the window you last
  used (on another display when there's no room on yours), and agents can't bring it to the front. Tabs are grouped under the agent's session name; popups an agent opens move into its window. Tabs nobody
  touches for 10 minutes close by themselves (never while a script runs on them).
- **Hand an agent one of your tabs** by clicking the toolbar button on it. The badge shows **ON**; click again to take
  it back. While an agent works the badge reads **RUN**, and **WAIT** when it needs you. The button always works: a
  click while a script runs takes the tab back and stops the script. Agents can't close a tab you lent them.
- **Handoffs:** the page shows a small card with the site's origin. Do the human part, then click **Continue** on the
  card or the toolbar button.
- **Recordings show only the page.** Nothing from OpenCode Browser is drawn while a tab is recorded: no cursor, no
  labels, no handoff card (you get a system notification instead; click it to go to the tab). If notifications are
  turned off for the extension, the card is shown after all, and the recording includes it. For a demo video, ask for
  the ghost cursor with `cursor: true` on `recording_start` (`--cursor` on the CLI).
- **Status:** the extension's options page shows whether the relay is connected and paired, and can copy diagnostics.

## Tools

| Tool | What it does |
| --- | --- |
| `execute` | Run Playwright code against the session's page (`page`, `context`, `snapshot()`, `handoff()`, …) |
| `session_new`, `session_list`, `session_use`, `session_current`, `session_reset`, `session_delete` | Named sessions, each with its own tabs; they survive restarts |
| `session_adopt` | Take over a tab you handed over with the toolbar button |
| `network_start`, `network_status`, `network_stop`, `network_cancel` | Capture traffic to a redacted HAR |
| `recording_start`, `recording_stop`, `recording_status`, `recording_cancel` | Record a tab to MP4 or WebM (`cursor: true` draws the ghost cursor) |
| `flight_recorder_start`, `flight_recorder_save_last`, … | Keep the last minute of video, save it when something breaks |
| `secrets_status`, `secrets_refresh`, `secrets_run` | Reuse captured credentials while keeping their values out of transcripts and artifacts |
| `tabs_cleanup` | Close the agent's idle tabs |
| `status`, `skill` | Connection status, and the full agent guide |

The agent guide is [`cli/skills/browse/SKILL.md`](cli/skills/browse/SKILL.md). Everything is also a CLI:
`node cli/dist/cli.mjs --help`.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/how-dark.png">
  <img src="assets/how-light.png" alt="Three machines on one bench, cabled in a line: the agent's terminal calling browse.execute, the relay box in the middle, and the computer whose browser the agent drives.">
</picture>

The agent talks to the `browse` MCP server over stdio. The server hands each command to the relay on
`127.0.0.1:19988`, and the extension, connected to the relay over a WebSocket, runs it in your browser through
`chrome.debugger`.

- **The relay** (`cli/`) is a local Chrome DevTools endpoint backed by the extension. It keeps named sessions,
  handoffs, recordings, network capture and a journal, and starts on demand.
- **The extension** (`src/`) connects to the relay and runs its commands through `chrome.debugger`. It keeps agent
  tabs in their own window and groups, closes idle ones, and shows the toolbar badge and the handoff card.
- **Quiet in the page.** `execute` uses [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), which hides
  the usual automation tells (`navigator.webdriver`, the `Runtime.enable` leak), and the relay drops Patchright's media
  emulation overrides. The extension adds nothing to pages you browse; in agent tabs it adds nothing to the DOM except
  the handoff card while a handoff waits (and the ghost cursor when asked for). Both live in a closed shadow root on an
  anonymous element, drawn from an isolated world. Input moves like a person: curved mouse paths, paced typing,
  gliding scroll (`OPENCODE_BROWSER_HUMAN_INPUT=0` for full speed). This makes an agent hard to spot, not impossible: the
  browser shows its "started debugging" bar while the debugger is attached, focus emulation keeps background agent tabs
  "visible", the card and cursor elements exist while shown, and `fillInput`'s fallback dispatches synthetic events
  (it warns when it does).

Permissions: `debugger`, `tabs`, `tabGroups`, `storage`, `alarms`, `offscreen` and `tabCapture` (recordings),
`scripting` (to add the handoff script only to tabs agents use, never to every page), `webNavigation` (to move popups
agents open into their window), `notifications` (to tell you an agent needs you while it records a tab), and access to
all sites so agents can work wherever you ask. Nothing leaves your computer except what your agent sends to its model
provider; see the [privacy policy](store/privacy-policy.md).

## Security

OpenCode Browser drives the browser you're signed in to, so it assumes that what an agent reads (a web page, an email)
may try to steer it, and that other programs on your computer may try to use the relay.

- **Relay token.** Every HTTP request and CDP connection to the relay needs the token in
  `~/.local/share/opencode-browser/relay-token` (readable only by you): an `Authorization: Bearer` header, or
  `?opencodeBrowserToken=` on the CDP WebSocket URL. The MCP server and CLI read it for you. The relay listens on
  `127.0.0.1` only and refuses cross-site browser requests and foreign `Host` headers.
- **Pairing.** The extension and the relay prove to each other that they know the same pairing code (HMAC over fresh
  nonces) before the extension obeys anything, so a program that grabs the port first can't drive your browser. The
  relay accepts only the two published extension IDs (plus any listed in `OPENCODE_BROWSER_EXTENSION_ORIGINS`).
- **Sandboxed `execute`.** Agent code runs in a separate JavaScript realm that isolates it from Node: it isn't given
  `process`, `require`, `import()`, `fs` or network modules, only a `files` helper and Playwright file options limited
  to the temp directory, not OpenCode Browser's data. The sandbox is a defense in depth, not a hard security boundary:
  treat code an agent runs as code running as you. The relay starts with an allowlisted environment (the basics plus
  `OPENCODE_BROWSER_*`, proxy variables and CA certificate paths), so your API keys aren't in it.
- **CDP guardrails.** Cookie reads return only cookies for the session's own pages; cookie writes are limited to
  those hosts. Clearing cookies, cache or site data, and closing the browser, are always refused. `page.bringToFront()`
  is refused so agents can't raise windows over your work.
- **Your tabs stay yours.** Agents use only tabs they opened or you lent them. The toolbar button always takes a tab
  back; only a real click on the card or the toolbar button finishes a handoff, so a page can't fake it.
- **Less on disk.** Session journals are private (0700/0600), redact typed passwords, codes and tokens, and are pruned
  after 14 days (200 at most). HARs replace credentials with references; typed passwords and one-time codes are never
  stored. Secret profiles keep values out of transcripts and artifacts, but anything that runs with them (like
  `secrets_run`) can use them. `secrets_run` commands get the relay's allowlisted environment plus the profile's
  `BC_SECRET_N` values, not the environment you started opencode with: `PATH`, `HOME`, locale, `HTTP_PROXY`,
  `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR` and `NODE_EXTRA_CA_CERTS` pass through; other
  variables (API keys included) don't.

Escape hatches. Set them in the environment you start opencode (or your MCP client) from; the relay inherits
`OPENCODE_BROWSER_*` variables. Run `node cli/dist/cli.mjs relay restart` after changing them:

| Variable | Effect |
| --- | --- |
| `OPENCODE_BROWSER_ALLOW_NODE=1` | Run `execute` code with full Node access (`process`, `fs`, `import()`, any file path) |
| `OPENCODE_BROWSER_ALLOW_ALL_COOKIES=1` | Let sessions read and write every cookie in the profile |
| `OPENCODE_BROWSER_ALLOW_FOREGROUND=1` | Allow `page.bringToFront()` |
| `OPENCODE_BROWSER_EXECUTE_SLICE_MS=2000` | Longest `execute` JavaScript may run without yielding before it is stopped (50 to 60000; every session waits meanwhile) |
| `OPENCODE_BROWSER_GHOST_CURSOR=1` | Show the ghost cursor on every agent tab (pages can see it) |
| `OPENCODE_BROWSER_HUMAN_INPUT=0` | Send input at full speed instead of human-like paths and pacing |

## Troubleshooting

- `node cli/dist/cli.mjs status` shows the relay, the extension and every tab agents can use.
- `node cli/dist/cli.mjs doctor` checks the install.
- Logs: `~/.local/share/opencode-browser/logs/relay.log`.
- Extension says another browser is connected: only one browser profile can be connected at a time. Close the other
  one, then click **Reconnect** on the status page.

## Development

```sh
bun install && bun run dev       # rebuilds dist/ on change; reload the extension to pick it up
bun run typecheck
bun run test                     # the extension and cli/ test suites (bun test), no browser needed
cd cli && bun src/main.ts status # the CLI from source
bun run package                  # release/opencode-browser-<version>.zip for the Chrome Web Store
```

`cli/` is the npm package `opencode-browser-cli` with its own lockfile. To release: bump `cli/package.json`, run
`npm publish --access public` in `cli/`, then upload the zip from `bun run package`.

## License

[MIT](LICENSE)
