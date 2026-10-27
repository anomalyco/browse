<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <img src="assets/banner-light.png" alt="browse: let your AI agents use your real browser. An isometric desk computer whose screen shows a web browser with an agent's tab group, cabled to a small relay box.">
</picture>

Let your AI agents use your real browser: your tabs, your logins, your extensions. An MCP server and a Chromium
extension, for [opencode](https://opencode.ai) and any other MCP client.

---

Agents get a `browse` MCP server. They open and drive tabs with Playwright, take screenshots, capture network
traffic and record the screen. When it's your turn (a login, a 2FA prompt, a payment), they hand the tab back to you
and continue once you click **Continue**.

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

There's nothing to pair or sign in to: the extension only talks to a relay on `127.0.0.1`, which only accepts this
extension. `bun run setup` is safe to re-run after `git pull`; it updates the tools and reloads the extension for you.

> **Coming soon:** a Chrome Web Store listing and `npx opencode-browser-cli install`, so you can skip the clone.

### Other MCP clients

`setup` writes the server into opencode's config. For other clients, add an stdio server that runs the built CLI:

```json
{
  "browse": { "command": "node", "args": ["/path/to/browse/cli/dist/cli.mjs", "mcp"] }
}
```

## Using it

- **Agents open their own tabs.** They're grouped at the top of your tab strip under the agent's session name and
  stay collapsed unless you're looking at one. Tabs nobody touches for 10 minutes close by themselves.
- **Hand an agent one of your tabs** by clicking the toolbar button on it. The badge shows **ON**; click again to take
  it back. While an agent works the badge reads **RUN**, and **WAIT** when it needs you.
- **Handoffs:** the page shows a banner. Do the human part, then click **Continue**.
- **Status:** the extension's options page shows whether the relay is connected and can copy diagnostics.

## Tools

| Tool | What it does |
| --- | --- |
| `execute` | Run Playwright code against the session's page (`page`, `context`, `snapshot()`, `handoff()`, …) |
| `session_new`, `session_list`, `session_use`, `session_current`, `session_reset`, `session_delete` | Named sessions, each with its own tabs; they survive restarts |
| `session_adopt` | Take over a tab you handed over with the toolbar button |
| `network_start`, `network_status`, `network_stop`, `network_cancel` | Capture traffic to a redacted HAR |
| `recording_start`, `recording_stop`, `recording_status`, `recording_cancel` | Record a tab to MP4 or WebM |
| `flight_recorder_start`, `flight_recorder_save_last`, … | Keep the last minute of video, save it when something breaks |
| `secrets_status`, `secrets_refresh`, `secrets_run` | Reuse an authenticated session's credentials without exposing them |
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
- **The extension** (`src/`) connects to the relay and runs its commands through `chrome.debugger`. It groups agent
  tabs, closes idle ones, shows the toolbar badge and the in-page handoff banner.
- **Hard to tell from a person.** `execute` uses [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), so
  pages can't see the debugger, and input moves like a person: curved mouse paths, paced typing, gliding scroll. Set
  `OPENCODE_BROWSER_HUMAN_INPUT=0` for full speed.

Permissions: `debugger`, `tabs`, `tabGroups`, `storage`, `alarms`, `offscreen` and `tabCapture` (recordings), and
access to all sites so agents can work wherever you ask. Nothing leaves your computer except what your agent sends
to its model provider; see the [privacy policy](store/privacy-policy.md).

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
cd cli && bun src/main.ts status # the CLI from source
bun run package                  # release/opencode-browser-<version>.zip for the Chrome Web Store
```

`cli/` is the npm package `opencode-browser-cli` with its own lockfile. To release: bump `cli/package.json`, run
`npm publish --access public` in `cli/`, then upload the zip from `bun run package`.

## License

[MIT](LICENSE)
