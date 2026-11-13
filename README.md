<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <img src="assets/banner-light.png" alt="browse: let your AI agents use your real browser. An isometric desk computer whose screen shows a web browser with an agent's tab group, cabled to a small relay box.">
</picture>

Let your AI agents use your real browser: your tabs, your logins, your extensions. An MCP server and a Chromium
extension, for [opencode](https://opencode.ai) and any other MCP client.

---

Agents get a `browse` MCP server. They open and drive tabs with Playwright, take screenshots, capture network
traffic and record the screen, in background tabs grouped out of your way. When it's your turn (a login,
a 2FA prompt, a payment), they hand the tab back to you and continue once you click **Continue**.

It works in Chrome, Edge, Brave, Arc, Helium, Vivaldi, Opera and Chromium.

## Install

```sh
curl -fsSL https://opencode.ai/browse/install | bash
```

On Windows, run `irm https://opencode.ai/browse/install.ps1 | iex` in PowerShell. With Node.js,
`npx @opencode/browse install` works too: it installs the package globally so agents run `browse` from PATH. The
installer puts the `browse` command in `~/.local/bin` (`$XDG_BIN_HOME` when set) and runs `browse install`. It reads
the channel's manifest from [Anomaly's release service](https://anoma.ly/release), downloads the binary for this
computer, and verifies its size and SHA-256 before installing it. `--channel stable|beta|dev` picks the channel
(`stable` by default); `--version <version>` installs a specific version from npm, checked against npm's published
SHA-512 integrity.

`install` keeps its files in the XDG folders (`~/.config/browse`, `~/.local/share/browse`, `~/.local/state/browse`
and `~/.cache/browse`; each honours its `XDG_*` variable), adds the `browse` MCP server to the agents you choose, and
connects the extension:

1. **Choose your agents.** Detected agents start checked. Type to filter, use ↑/↓ to move, Space to toggle and
   Enter to confirm. You can uncheck OpenCode, choose an agent you haven't installed yet, or choose none for CLI-only use.
   Your next interactive install starts with your last selection.
2. **Add the extension.** `install` opens browse in the Chrome Web Store; add it to your browser, and `install` pairs
   it once it's there. If it's already there, `install` opens its setup page with a one-time pairing code, so it
   pairs without copying anything.

That's it. Ask an agent to *"open news.ycombinator.com and tell me the top story"*. Or paste this into opencode:
*"Install browse with `npx @opencode/browse install`."*

Requirements: a Chromium browser, and [opencode](https://opencode.ai) or another MCP client. The npx install also needs
Node.js 22.19+.

**Updates are automatic.** A binary install reads its channel's manifest from Anomaly's release service at launch and
at least once an hour; an npm install checks npm's dist-tag once an hour. When the current release is a different build,
the relay reruns whatever installed browse in the background: a binary install reruns the install script that shipped
with the browse version it's running (not one downloaded at update time), which checks the file's size and SHA-256 and
replaces `~/.local/bin/browse`; an npm install runs `npm install -g @opencode/browse@<version>`. It restarts the relay
when no agent is using the browser, without changing opencode's config. Running MCP servers swap to the new build
between tool calls. Choose *Only tell me* or *Don't check* under **Updates** on the extension's
settings page (or `settings set autoUpdate=notify`, or `OPENCODE_BROWSER_AUTO_UPDATE=off`). Agents can read the current
value from `status`, but the MCP `settings` tool can't read or change update behaviour; it stays with you. `browse
update` updates now; to go back, rerun the installer with `--channel <channel>` (binary installs follow the channel) or
`--version <version>` / `npm install -g @opencode/browse@<version>` (both from npm). The Chrome Web Store updates the
extension.

**Dev builds**: every push to `dev` publishes one. `npx @opencode/browse@dev install` follows the dev channel: it
downloads that build's extension into `<cache root>/extension`, which you load unpacked once (`browse extension` shows
the folder), and each update refreshes the folder and reloads the extension. A binary install follows the same dev
channel with `curl -fsSL https://opencode.ai/browse/install | bash -s -- --channel dev`. The zip is also at
https://anoma.ly/release/browse/extension/dev/chromium and each binary at
https://anoma.ly/release/browse/cli/dev/<target>.

There's nothing to sign in to. Each browser pairs with the relay once and gets a key of its own (see
[Security](#security)). If pairing didn't happen by itself, run `browse install` again to open a
pairing link. To pair by hand, run `browse pair` (from a checkout: `node cli/dist/cli.mjs pair`).
It starts the relay and waits. Open **Extensions → browse → Options**, expand **advanced** (or click **Pair with a code**),
enter the printed code under **Pairing code**, and click **Connect**.
The command confirms which browser paired. `pair --list` shows paired browsers; `pair --revoke <browser>` unpairs one.

### From source

For contributors, or before a release you need is on npm:

```sh
git clone https://github.com/anomalyco/browse.git && cd browse && bun run setup
```

`setup` builds the extension and the CLI, adds the `browse` MCP server to your selected agents, and puts a one-time pairing code
in `browse/dist` (good for an hour), which the extension exchanges for its own key when it first connects. `install` points
every channel at the Chrome Web Store build; to use the build from your checkout instead, run
`node cli/dist/cli.mjs extension`, which shows the `browse/dist` folder to load unpacked.

This needs [Bun](https://bun.sh) as well. A checkout never updates itself: run `node cli/dist/cli.mjs update` in your
`browse` folder (or ask your agent to update browse). It pulls the new commits (fast-forward
only, and never over local changes), rebuilds, and requests an extension reload. If the old extension cannot accept
the request, **reload browse on your browser's extensions page (↻)**. The manual equivalent of `update` is
`git pull && bun run setup`. When there's an update, `status`, `doctor`, the extension's settings page and the agent (once
per session) say so; browse checks the clone's remote at most every six hours. Set `OPENCODE_BROWSER_UPDATE_CHECK=0` to
turn the check off.

### Other MCP clients

To skip the picker, name one or more agents. Explicit names take precedence over caller detection:

```sh
browse install -a claude cursor --agent gemini
browse install -a '*'   # every supported client, including those not installed (--all-agents)
browse install -y       # detected clients in an ordinary shell (--yes)
```

Inside a recognized agent, `install` targets that caller automatically. Without a terminal it configures the caller
if it recognizes it. If it can't tell which agent ran it, it configures nothing and prints the MCP entry to add by
hand, plus a `browse install --agent <name>` command for each agent it found. Outside a recognized agent, `-y` sets
up every detected agent instead of opening the picker, with or without a terminal. Re-running install is additive:
unchecking a client skips it, not a removal. `uninstall` removes the entries browse wrote, not unrelated servers or
conflicting entries.

<details><summary>Supported agents and user-level config files</summary>

`CONFIG` is `$XDG_CONFIG_HOME` or `~/.config`. `APP` is `~/Library/Application Support` on macOS, `%APPDATA%` on
Windows, or `CONFIG` on Linux. The paths below are defaults; a client's existing config or location override can apply.

| Agent (flag) | User config | Format / server key |
| --- | --- | --- |
| [OpenCode](https://opencode.ai/v2/docs/mcp-servers) (`opencode`) | `CONFIG/opencode/opencode.json` or `.jsonc` | JSONC · `mcp.servers` |
| [Claude Code](https://code.claude.com/docs/en/mcp-quickstart) (`claude`) | `~/.claude.json` | JSON · `mcpServers` |
| [Claude Desktop](https://modelcontextprotocol.io/docs/develop/build-server) (`claude-desktop`) | `APP/Claude/claude_desktop_config.json` | JSON · `mcpServers` |
| [Cursor](https://cursor.com/docs/context/mcp) (`cursor`) | `~/.cursor/mcp.json` | JSON · `mcpServers` |
| [Codex](https://developers.openai.com/codex/mcp) (`codex`) | `~/.codex/config.toml` | TOML · `mcp_servers` |
| [VS Code, including Copilot agent mode](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) (`vscode`) | `APP/Code/User/mcp.json` | JSONC · `servers` |
| [Windsurf](https://docs.windsurf.com/windsurf/cascade/mcp) (`windsurf`) | `~/.codeium/windsurf/mcp_config.json` or existing `CONFIG/devin/mcp_config.json` (`APP/devin` on Windows) | JSON · `mcpServers` |
| [Amp](https://ampcode.com/manual/mcp) (`amp`) | `~/.config/amp/settings.json` or `.jsonc` | JSONC · literal `amp.mcpServers` |
| [Antigravity](https://antigravity.google/docs/cli/mcp) (`antigravity`) | `~/.gemini/config/mcp_config.json` | JSON · `mcpServers` |
| [Augment (Auggie CLI)](https://docs.augmentcode.com/cli/integrations) (`augment`) | `~/.augment/settings.json` | JSON · `mcpServers` |
| [Cline](https://docs.cline.bot/mcp/configuring-mcp-servers) (`cline`) | `~/.cline/data/settings/cline_mcp_settings.json`; also recognizes the existing VS Code extension file in `APP/Code/User/globalStorage/saoudrizwan.claude-dev/settings/` | JSON · `mcpServers` |
| [CodeBuddy Code](https://www.codebuddy.ai/docs/cli/mcp) (`codebuddy`) | `~/.codebuddy/.mcp.json` (or existing `mcp.json`) | JSONC · `mcpServers` |
| [Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-mcp) (`cortex`) | `~/.snowflake/cortex/mcp.json` | JSON · `mcpServers` |
| [Factory Droid](https://docs.factory.ai/cli/configuration/mcp) (`droid`) | `~/.factory/mcp.json` | JSON · `mcpServers` |
| [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/) (`gemini`) | `~/.gemini/settings.json` | JSON · `mcpServers` |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) (`copilot`) | `~/.copilot/mcp-config.json` | JSON · `mcpServers` |
| [Goose](https://goose-docs.ai/docs/guides/config-file/) (`goose`) | `CONFIG/goose/config.yaml`; Windows: `APP/Block/goose/config/config.yaml` | YAML · `extensions` |
| [Grok Build](https://docs.x.ai/build/settings) (`grok`) | `~/.grok/config.toml` | TOML · `mcp_servers` |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) (`hermes`) | `~/.hermes/config.yaml` | YAML · `mcp_servers` |
| [Junie](https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html) (`junie`) | `~/.junie/mcp/mcp.json` | JSON · `mcpServers` |
| [Kilo Code](https://kilo.ai/docs/automate/mcp/using-in-cli) (`kilo`) | `CONFIG/kilo/kilo.json` (also `.jsonc`, `config.json`) | JSONC · `mcp` |
| [Kimi Code CLI](https://moonshotai.github.io/kimi-cli/en/customization/mcp.html) (`kimi`) | `~/.kimi/mcp.json` | JSON · `mcpServers` |
| [Kiro](https://kiro.dev/docs/mcp/configuration/) (`kiro`) | `~/.kiro/settings/mcp.json` | JSON · `mcpServers` |
| [LM Studio](https://lmstudio.ai/blog/lmstudio-v0.3.17) (`lm-studio`) | `~/.lmstudio/mcp.json` | JSON · `mcpServers` |
| [Mistral Vibe](https://docs.mistral.ai/vibe/code/cli/mcp-servers) (`vibe`) | `~/.vibe/config.toml` | TOML · `[[mcp_servers]]` |
| [Pi](https://pi.dev/docs/latest/mcp) (`pi`) | `~/.pi/agent/mcp.json` | JSON · `mcpServers` |
| [Qoder CLI](https://docs.qoder.com/cli/mcp-reference) (`qoder`) | `~/.qoder/settings.json` | JSON · `mcpServers` |
| [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/) (`qwen-code`) | `~/.qwen/settings.json` | JSON · `mcpServers` |
| [Roo Code (VS Code)](https://docs.roocode.com/features/mcp/using-mcp-in-roo) (`roo`) | `APP/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` | JSON · `mcpServers` |
| [Warp](https://docs.warp.dev/agents/capabilities/mcp) (`warp`) | `~/.warp/.mcp.json` | JSON · `mcpServers` |
| [Zed](https://zed.dev/docs/ai/mcp) (`zed`) | macOS: `~/.config/zed/settings.json`; Linux: `CONFIG/zed/settings.json`; Windows: `APP/Zed/settings.json` | JSONC · `context_servers` |

</details>

For another stdio MCP client, add the `browse` command with the `mcp` argument. That works for a binary install and a
global npm install, and keeps working when node changes under nvm/fnm:

```json
{ "mcpServers": { "browse": { "command": "browse", "args": ["mcp"] } } }
```

`browse install --agent '*'` writes this for every agent it knows. An npx-only client can run
`npx @opencode/browse mcp` instead, but that entry updates only when npx resolves a newer package.

### Browser on another computer

When opencode runs on one machine and your browser on another (over Tailscale, say), the relay runs next to opencode
and the extension connects to it across the network:

1. On the opencode machine, install browse, then run `browse set hostname 0.0.0.0`.
   The relay then listens on every network, restarting it if it runs (or starting it when it doesn't). Other
   computers reach only the extension link; the HTTP API and CDP answer on `127.0.0.1` only. The command prints the
   address (with its port when it isn't 19988) and a pairing code for step 2 (`browse pair` prints another; each works
   once, within 10 minutes).
   If another program holds 19988, enter the port printed after the address; the relay keeps its last port while it
   stays free, but it can change if that port is taken.
2. In the browser, open the extension's settings page (right-click the toolbar button, then **Options**). Under
   **advanced**, replace `localhost:19988` in **Relay address** with that machine's address and port (a Tailscale IP
   or name, `:port` added when it isn't 19988), enter the code under **Pairing code**, then click **Connect**. The
   page says right there whether the relay answered and accepted the code.

`browse set hostname 127.0.0.1` goes back to this computer only.

Pairing works as it does locally: the browser exchanges the code for a key of its own, and from then on both sides
prove they hold that key on every connection, so anyone else on the network who reaches the port gets nothing. The
connection itself isn't encrypted by browse; use a network that is (Tailscale or WireGuard), not the open internet. Set
**Relay** back to `localhost` (or clear it) to go back to a relay on the browser's computer.

## Using it

- **Agents open their own tabs** in the background of the window you last used, grouped together at the start of your
  tab strip and collapsed unless you're looking at one. Agents can't switch you to their tabs or bring a window to the
  front; popups an agent opens join its group, and if one takes over your window you get your tab back. Tabs nobody
  touches for 10 minutes close by themselves (never while a script runs on them).
- **What a page sees.** Between calls a page sees an agent's tab hidden and unfocused; only while an `execute` runs on
  it does browse emulate focus, so background work isn't throttled. Some apps pause or disconnect when hidden, so a
  session can be created with `browse session new live --keep-visible` (or `keepVisible: true` on `session_new`): the
  tabs that session opened itself stay visible and focused to the page between calls. Pages can notice either way, it
  never raises or focuses the window, tabs you lent the session behave as usual (released when the call ends), and it is
  released when the session is deleted or reset or the tab closes.
- **Several browsers at once.** Each connected browser has an id (like `chrome-macbook`) and a name; `browse status
  --json` lists them. New sessions open their tabs in the default browser, the first connected and ready, unless one is
  named: `browse session new work --browser "Home Brave"` (or `browser` on the `session_new` tool, or on the first
  `execute` that creates the session). A session stays in its browser, so start a new one to use another.
- **Settings** (the extension's options page; each applies right away, to new tabs for window and grouping):
  - **Where agents open their tabs:** in your window (default), or *in a separate window* of their own that opens
    unfocused beside yours (on another display when there's no room on yours); their popups move there too.
  - **Grouping:** one shared group for every agent (default; "Agents · 3", one per window, popups included; a handoff
    opens it), *one collapsed group per agent session*, or *don't group* (agent tabs sit in the background of your tab
    strip; pin one to keep it). Tabs already grouped stay where they are when you switch.
  - **Close tabs agents haven't touched for:** 10 minutes (default), 30, 60, or *never*. Tabs a script runs on, a
    handoff waits on or a recording records stay open regardless. With *never*, an agent's `tabs_cleanup` without a
    time still closes only tabs idle for 10 minutes.
  - **Agent cursor:** off (default) or *always show* it on agent tabs. Pages can detect it while it's shown.
    Recordings still leave it out unless they ask for it (`cursor: true`).
  - **Human-like input:** on (default), or *off*: faster, but easier for sites to flag as a bot.
  - **Handoff notifications:** only while the tab is recorded (default), or *on every handoff*, as well as the card.
  The relay's environment variables below override the window, cursor and input settings; the options page then
  shows the value in effect and which variable set it. Agents can read and change these settings with the `settings`
  tool when you ask them to (`node cli/dist/cli.mjs settings get`, `settings set grouping=shared` on the CLI); the
  options page follows at once. The security switches below are environment-only, never settings.
- **Hand an agent one of your tabs** by clicking the toolbar button on it. The badge shows **ON**; click again to take
  it back. While an agent works the badge reads **RUN**, and **WAIT** when it needs you. If the relay isn't running yet
  the badge shows **…** and the tab is handed over once an agent starts browse; click again to cancel. The button always
  works: a click while a script runs takes the tab back and stops the script. Agents can't close a tab you lent them. The
  browser's debugging bar button (**Cancel** in Chrome, **OK** in some browsers like Dia) disconnects browse from
  every tab: tabs you lent go back to you, and tabs agents opened stay open until idle cleanup closes them. File pages
  need **Allow access to file URLs** for browse on its details page in `chrome://extensions`, and Chrome's own pages,
  the Web Store included, can't be lent.
- **Handoffs:** the page shows a small card with the site's origin. Do the human part, then click **Continue** on the
  card or the toolbar button. While one waits, `browse session list --json` and `session_list` include it (message,
  tab and start time) so other tools can see what is waiting on you.
- **Recordings show only the page.** Nothing from browse is drawn while a tab is recorded: no cursor, no
  labels, no handoff card (you get a system notification instead; click it to go to the tab). If notifications are
  turned off for the extension, the card is shown after all, and the recording includes it. For a demo video, ask for
  the ghost cursor with `cursor: true` on the `recording` tool (`action: "start"`; `--cursor` on the CLI).
- **Status:** the extension's options page shows whether the relay is connected and paired, and can copy diagnostics.

## Tools

| Tool | What it does |
| --- | --- |
| `execute` | Run Playwright code against the session's page (`page`, `context`, `snapshot()`, `handoff()`, …). `snapshot()` and `ariaSnapshot()` outline the page and the content of its iframes, with refs that work inside frames |
| `session_new`, `session_list`, `session_use`, `session_reset`, `session_delete` | Named sessions, each with its own tabs; they survive restarts |
| `session_adopt` | Take over a tab you handed over with the toolbar button |
| `session_allowlist` | Limit a session's tabs to the sites you name (also `allowedOrigins` on `session_new`) |
| `network` (`action`: `start`, `status`, `stop`, `cancel`) | Capture traffic to a redacted HAR |
| `recording` (`action`: `start`, `stop`, `status`, `cancel`) | Record a tab to MP4 or WebM (`cursor: true` draws the ghost cursor) |
| `flight_recorder` (`action`: `start`, `status`, `save_last`, `cancel`) | Keep the last minute of video, save it when something breaks |
| `secrets_list` | Site secrets you stored for the session's sites; agents type them with `secrets.type()` only on their sites, without seeing them |
| `secrets_status`, `secrets_refresh`, `secrets_run` | Reuse captured credentials while keeping their values out of transcripts and artifacts |
| `tabs_cleanup` | Close idle agent tabs (`idleMinutes` applies to the calling agent's own sessions; other agents' wait for the idle setting) |
| `settings` | Read or change the settings below when the user asks (never the security switches or update behaviour); the options page updates live |
| `status` | Connection status |

`execute` takes an optional `timeoutMs` (`--timeout-ms` on the CLI), the budget for the whole script: 60000
milliseconds by default, 0 disables it, and time spent in `handoff()` doesn't count. It starts when the call does,
so time spent waiting behind another execute on the same session counts, and that other call's handoff doesn't
pause it. An explicit `timeoutMs` (or `OPENCODE_BROWSER_EXECUTE_TIMEOUT_MS`) is also how long Playwright actions
and navigations may take in that call, at least 30 seconds; without one they keep Playwright's 30-second default.
At 0 their timeout is off too, so a stuck wait only ends when the call is stopped.

`snapshot()` and `ariaSnapshot()` hide the values of editable fields and of password, one-time-code and card
fields (`autocomplete` `cc-number`, `cc-csc`, `cc-exp*`). Other readonly fields show their value, so a generated
address or code is readable; a field the page locks after you type into it counts as readonly.

`page.setViewportSize()` emulates a viewport inside the real window, so the tab is letterboxed while it is set; when
the script ends browse clears the override, retrying one Chrome drops, and the tab goes back to the window's size
within a couple of seconds.

Each agent has its own current session only when the client names the agent (OpenCode does; `status` reports
`sharedSession`). With other clients, agents on one server share one current session; when several use it, each
should `session_new` its own and pass `session` on every call.

The agent reference is [`cli/skills/browse/SKILL.md`](cli/skills/browse/SKILL.md)
(`browse skill` prints it). The MCP server also sends a short usage guide in its
initialize instructions. Everything is also a CLI:
`node cli/dist/cli.mjs --help`.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/how-dark.png">
  <img src="assets/how-light.png" alt="Three machines on one bench, cabled in a line: the agent's terminal calling browse.execute, the relay box in the middle, and the computer whose browser the agent drives.">
</picture>

The agent talks to the `browse` MCP server over stdio. The server hands each command to the relay on
`127.0.0.1:19988` (or the next free port from 19990–19997 when another program's HTTP server holds it), and the
extension, connected to the relay over a WebSocket, runs it in your browser through `chrome.debugger`.

- **The relay** (`cli/`) is a local Chrome DevTools endpoint backed by the extension. It keeps named sessions,
  handoffs, recordings, network capture and a journal, and starts on demand.
- **The extension** (`src/`) connects to the relay and runs its commands through `chrome.debugger`. It keeps agent
  tabs in collapsed groups (or their own window), closes idle ones, and shows the toolbar badge and the handoff card.
- **Quiet in the page.** `execute` uses [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), which hides
  the usual automation tells (`navigator.webdriver`, the `Runtime.enable` leak), and the relay drops Patchright's media
  emulation overrides. The extension adds nothing to pages you browse; in agent tabs it adds nothing to the DOM except
  the handoff card while a handoff waits (and the ghost cursor when asked for). Both live in a closed shadow root on an
  anonymous element, drawn from an isolated world. Input moves like a person: curved mouse paths, paced typing,
  gliding scroll (turn *Human-like input* off on the options page, or `OPENCODE_BROWSER_HUMAN_INPUT=0`, for full speed). This makes an agent hard to spot, not impossible: the
  browser shows its "started debugging" bar while the debugger is attached, focus emulation keeps background agent tabs
  "visible" while a script runs on them (and between calls for a `keepVisible` session), the card and cursor elements
  exist while shown, and `fillInput`'s fallback dispatches synthetic events (it warns when it does).

Permissions: `debugger`, `tabs`, `tabGroups`, `storage`, `alarms`, `offscreen` and `tabCapture` (recordings),
`scripting` (to add the handoff script only to tabs agents use, never to every page), `webNavigation` (to keep popups
agents open with their other tabs), `notifications` (to tell you an agent needs you while it records a tab), and access to
all sites so agents can work wherever you ask. Nothing leaves your computer except what your agent sends to its model
provider; see the [privacy policy](store/privacy-policy.md).

## Security

browse drives the browser you're signed in to, so it assumes that what an agent reads (a web page, an email)
may try to steer it, and that other programs on your computer may try to use the relay.

- **Relay token.** Every HTTP request and CDP connection to the relay needs the token in
  `~/.local/share/browse/relay-token` (readable only by you): an `Authorization: Bearer` header, or
  `?opencodeBrowserToken=` on the CDP WebSocket URL. The MCP server and CLI read it for you. The relay listens on
  `127.0.0.1` only and refuses cross-site browser requests and foreign `Host` headers.
- **Pairing.** `pair` prints a short code (`XXXX-XXXX`) that works once, within 10 minutes; five wrong codes in a row
  void every pending one. A browser exchanges it for a random key of its own, kept by the relay
  (`browser-tokens.json` in the data folder, readable only by you) and in the extension's storage. The exchange runs
  over a fresh key agreement (ECDH), so neither the code nor the key crosses the connection, and each side proves it
  knows the code before the other gives anything away. On every later connection both sides prove they hold the key
  (HMAC over fresh nonces) before the extension obeys anything, so a program that grabs the port first can't drive
  your browser. `pair --list` shows paired browsers and when each was last seen; `pair --revoke <browser>` deletes a
  browser's key and disconnects it. The relay accepts only the two published extension IDs (plus any listed in
  `OPENCODE_BROWSER_EXTENSION_ORIGINS`). Browsers paired by an earlier version with its shared code switch to a key of
  their own the next time they connect; `pair --revoke legacy` retires that code once they all have.
- **Restricted `execute`.** Agent code runs in a restricted JavaScript realm on the relay: it withholds Node
  APIs (`process`, `require`, `import()`, `fs`, network modules, Node fetch), limits files to the file roots, requires
  the folders and files below a root to be yours and not group/world writable (use `files.path()` or `files.dir`),
  checks the file paths in the raw CDP commands that take them, and stops synchronous code after about 2 seconds. It
  shares the relay's process, so it is not a security boundary: treat code an agent runs as code running as you. The
  relay starts with an allowlisted environment (the basics plus `OPENCODE_BROWSER_*`, proxy variables and CA
  certificate paths), so your API keys aren't in it.
- **CDP guardrails.** Cookie reads return only cookies for the session's own pages; cookie writes are limited to
  those hosts. Clearing cookies, cache or site data, and closing the browser, are always refused. Granting or
  changing site permissions (`context.grantPermissions()`, `context.clearPermissions()`, `Browser.setPermission`,
  `Browser.grantPermissions`, `Browser.resetPermissions`) is refused too. `page.bringToFront()` is refused so agents
  can't raise windows over your work.
- **Domain allowlists (opt-in).** `session new <name> --allow-origin example.com` (or `session allow`, or
  `allowedOrigins` on `session_new` / `session_allowlist`) limits where a session's tabs go. The relay refuses agent
  navigations and new tabs to other hosts, stops or blanks links, redirects and script navigations that leave the
  list, and closes popups that open elsewhere. Private, loopback and link-local addresses need an entry naming that
  exact host; names are resolved first and the document's real remote IP is checked, against DNS rebinding.
  Subresources (images, fetch, iframes, workers) are not blocked: request interception is shared with Playwright's
  `page.route()`, so the relay can't own it reliably. Browsing through a local proxy makes every document look like
  it came from the proxy's address, so name the hosts you need exactly.
- **Site secrets.** `browse secrets add <name> --origin https://example.com` stores a password, key or (with
  `--totp`) a TOTP seed, read from stdin or a hidden prompt, in `~/.local/share/browse/site-secrets/`
  (0700/0600). An agent types it with `secrets.type(locator, "<name>")`: the relay checks the field's frame URL from
  the browser's frame tree against the secret's origins (and the session's allowlist) right before it inserts the
  value, so a cross-origin iframe or a redirect gets nothing. The value never enters the execute realm, results,
  logs, journals or HARs. Once typed it is in the page, where page script could read it, so pair secrets with an
  allowlist (execute warns when you don't). A stored TOTP seed makes 2FA one factor; keep handing 2FA to yourself
  when you can. `secrets list` and `secrets remove` manage them.
- **Bot challenges.** After a navigation, execute reports Cloudflare, Akamai, DataDome, PerimeterX, Imperva, AWS WAF,
  captcha walls and "access denied" pages in `aftermath.challenge`. It waits up to 15 s
  (`OPENCODE_BROWSER_CHALLENGE_WAIT_MS`) for checks the browser clears by itself, and tells the agent to hand
  interactive ones to you. It never solves them.
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
| `OPENCODE_BROWSER_AGENT_WINDOW=separate` | Open agent tabs in a separate window (`current`: in the user's window), overriding the options page's *Where agents open their tabs* |
| `OPENCODE_BROWSER_EXECUTE_TIMEOUT_MS=120000` | When set, the default budget for an `execute` that passes no `timeoutMs`, plus Playwright's action and navigation timeout for it (at least 30 seconds; 0 removes both) |
| `OPENCODE_BROWSER_EXECUTE_SLICE_MS=2000` | Longest `execute` JavaScript may run without yielding before it is stopped (50 to 60000; every session waits meanwhile) |
| `OPENCODE_BROWSER_GHOST_CURSOR=1` | Show the agent cursor on every agent tab outside recordings (pages can see it); `0` keeps it off. Overrides the options page's *Agent cursor* |
| `OPENCODE_BROWSER_AUTO_UPDATE=notify` | Installs: only show new versions (`off`: don't check; `on`: install them when idle, the default). Overrides the status page's *Updates* |
| `OPENCODE_BROWSER_HUMAN_INPUT=0` | Send input at full speed instead of human-like paths and pacing; `1` keeps them on. Overrides the options page's *Human-like input* |
| `OPENCODE_BROWSER_CHALLENGE_WAIT_MS=15000` | How long `execute` waits for a bot check the browser clears by itself (0 to 60000; 0 reports it without waiting) |
| `OPENCODE_BROWSER_EXTENSION_TIMEOUT_MS=30000` | How long the relay waits for the extension to answer a command (15000 to 300000); raise it on a heavily loaded computer |
| `OPENCODE_BROWSER_PING_TIMEOUT_MS=10000` | How long a ping may go unanswered before the browser counts as asleep (1000 to 30000) |
| `OPENCODE_BROWSER_PORT=20000` | Pin the relay's port, with no fallback; clients dial it too (unset, browse uses 19988 and steps to the next free port of 19990–19997 when another program's HTTP server answers there) |

## Troubleshooting

- `node cli/dist/cli.mjs status` shows the relay, the extension and every tab agents can use.
- `node cli/dist/cli.mjs doctor` checks the install.
- Agents fail with "The browser isn't answering" while the computer is very busy: the browser may just be slow. Raise
  `OPENCODE_BROWSER_EXTENSION_TIMEOUT_MS` and `OPENCODE_BROWSER_PING_TIMEOUT_MS`, then run `browse relay restart`.
- Logs: `~/.local/state/browse/logs/relay.log`.
- Another program's HTTP server already on port 19988 (Playwriter's relay, say): browse picks the next free port from
  19990–19997 by itself; while the relay is running, install's pairing link or file tells the extension that port, and
  once paired it finds the relay again by itself, so both can run side by side. A port held by something that doesn't
  answer HTTP is treated as in use, so browse won't start a second relay elsewhere: stop that program or set
  `OPENCODE_BROWSER_PORT`.
- Stuck on 0.0.15 or earlier with `~/.local/share/opencode-browser` (`%LOCALAPPDATA%\opencode-browser` on Windows) still
  there: installs from before 0.0.11 download each update but keep running the old version. Run
  `npm install -g @opencode/browse@latest` (`@dev` on the dev channel), then `browse relay restart` once no agent is
  using the browser. Running agents move to the new version, and the old folder's files move to the folders above.
- Extension says another browser is connected: the relay is running an older browse that drives one browser profile at
  a time. Update browse on the computer running the relay (or close the other browser), then click **Reconnect** on the
  status page.
- Extension says it's not paired (or that the relay was refused): run `bun run setup` again, then reload the extension
  on your browser's extensions page.
- **Load unpacked** fails, or the extension shows errors: load the `browse/dist` folder (built by `setup`), not
  `browse` itself or `browse/public`. `node cli/dist/cli.mjs extension` shows the right folder.

## Development

```sh
bun install && bun run dev       # rebuilds dist/ on change; reload the extension to pick it up
bun run typecheck
bun run test                     # the extension and cli/ test suites (bun test), no browser needed
cd cli && bun src/main.ts status # the CLI from source
bun run release:check            # the store zip and npm tarball a release would publish, with its checks
```

`cli/` is the npm package `@opencode/browse` with its own lockfile. The extension and the package share one version;
[RELEASING.md](RELEASING.md) has the release flow (dev builds from every push to `dev`; stable releases only from the
Release workflow in GitHub Actions).

## Contributing

We don't take pull requests. [Open an issue](https://github.com/anomalyco/browse/issues)
describing the bug or idea, and our agents usually turn it around fast.

## License

[MIT](LICENSE)
