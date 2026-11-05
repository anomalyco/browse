<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <img src="assets/banner-light.png" alt="browse: let your AI agents use your real browser. An isometric desk computer whose screen shows a web browser with an agent's tab group, cabled to a small relay box.">
</picture>

browse lets your AI agents use your real browser, with your tabs, logins and extensions. Agents work in background
tabs, and hand the tab back to you for logins, 2FA and payments.

```sh
curl -fsSL https://opencode.ai/browse/install | bash
```

On Windows, run `irm https://opencode.ai/browse/install.ps1 | iex` in PowerShell. With Node.js 22.19+, you can use
`npx @opencode/browse install` instead.

The installer then:

1. Asks which agents to set browse up in.
2. Opens browse in the Chrome Web Store so you can add it to your browser.
3. Pairs the extension with your computer. There's nothing to copy or sign in to.

**Try it:** ask your agent to *"open news.ycombinator.com and tell me the top story"*.

Works in Chrome, Edge, Brave, Arc, Helium, Vivaldi, Opera and Chromium, with [opencode](https://opencode.ai) and
[29 other agents](#supported-agents).

## Install

Run the install line above. It puts the `browse` command on your PATH (in `~/.browse/bin`) and runs `browse install`.
You can also ask opencode to do it: *"Install browse with `curl -fsSL https://opencode.ai/browse/install | bash`."*

Commands in this README are written `browse <command>`. After an npx install, run `npx @opencode/browse <command>`
instead.

**Choosing agents.** The picker starts with the agents found on your computer checked. Type to search, use ↑/↓ to
move, Tab to toggle and Enter to confirm. Your next install starts with the same selection. Inside an agent, install
sets up that agent without asking.

**Any other agent.** Install always prints an `mcpServers` entry with the right command for your install. Add it to
any stdio MCP client.

**Pairing.** Each browser pairs once and gets a key of its own. If pairing didn't happen by itself, run
`browse install` again. To pair by hand, run `browse pair`, then enter the printed code on the
[settings page](#settings) under **Advanced** and click **Connect**.

### Install options

Pass these to `browse install`. With the install script, add them after `bash -s --`, for example
`curl -fsSL https://opencode.ai/browse/install | bash -s -- --agent claude`.

| Option | What it does |
| --- | --- |
| `-a, --agent <names...>` | Set up these agents and skip the picker. `'*'` (or `--all-agents`) picks every supported agent |
| `--agent none` | Set up no agent; just print the MCP entry to add yourself |
| `-y, --yes` | Skip the picker: set up the calling agent, or else every agent found on this computer |
| `--remote` | For a browser on another computer (see [below](#agent-on-another-computer)) |
| `--no-modify-path` | Don't add `browse` to your PATH |
| `--no-open` | Print the steps without opening anything |
| `--no-wait` | Don't wait for the extension to connect |
| `--wait-seconds <n>` | How long to wait for it (default 180 in a terminal, 90 otherwise) |

Running install again only adds: an agent you uncheck is skipped, not removed. Without a terminal (a script or CI),
install sets up every agent it finds. `browse uninstall` removes everything install set up; in agent
configs, it removes only the entries browse wrote.

### Supported agents

<details><summary>All 30 agents, with the config file install edits for each</summary>

`CONFIG` is `$XDG_CONFIG_HOME` or `~/.config`. `APP` is `~/Library/Application Support` on macOS, `%APPDATA%` on
Windows, or `CONFIG` on Linux. These are defaults; a client's existing config or location override can apply.

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
| [Qoder CLI](https://docs.qoder.com/cli/mcp-reference) (`qoder`) | `~/.qoder/settings.json` | JSON · `mcpServers` |
| [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/) (`qwen-code`) | `~/.qwen/settings.json` | JSON · `mcpServers` |
| [Roo Code (VS Code)](https://docs.roocode.com/features/mcp/using-mcp-in-roo) (`roo`) | `APP/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` | JSON · `mcpServers` |
| [Warp](https://docs.warp.dev/agents/capabilities/mcp) (`warp`) | `~/.warp/.mcp.json` | JSON · `mcpServers` |
| [Zed](https://zed.dev/docs/ai/mcp) (`zed`) | macOS: `~/.config/zed/settings.json`; Linux: `CONFIG/zed/settings.json`; Windows: `APP/Zed/settings.json` | JSONC · `context_servers` |

</details>

## Using it

- **Agents open their own tabs** in the background of your window. They're grouped at the start of your tab strip
  under the agent's session name, and collapsed unless you're looking at one.
- **Agents stay out of your way.** They can't switch you to their tabs or bring a window to the front. Popups they
  open join their group; if one takes over your window, you get your tab back.
- **Idle agent tabs close** after 10 minutes (you can change this). Tabs a script runs on, a recording records or a
  handoff waits on stay open.
- **Lend a tab** by clicking the browse toolbar button on it. Click again to take it back, even mid-script (that stops
  the script). Agents can't close a tab you lent them.
- **Handoffs:** when an agent needs you, the page shows a small card with the site's origin. Do the human part, then
  click **Continue** on the card or the toolbar button.
- **Recordings show only the page:** no cursor, labels or card. You get a system notification instead; click it to go
  to the tab. If notifications are off for the extension, the card shows after all, and the recording includes it.
  For a demo video, ask for the agent cursor (`cursor: true` on `recording_start`).

The toolbar badge shows what's happening on a tab:

| Badge | Meaning |
| --- | --- |
| **ON** | You lent this tab to an agent |
| **RUN** | An agent is working in it |
| **WAIT** | An agent needs you |

**Several browsers.** Every browser or profile you pair can be connected at once. Agents use the first one that
connected unless they ask for another by name; set each browser's name on the settings page.

## Settings

Open the settings page by right-clicking the browse toolbar button and choosing **Options**. Changes apply right away
(where tabs open and how they're grouped apply to new tabs).

| Setting | Options | Environment override |
| --- | --- | --- |
| Name for agents | Any name; agents pick a browser by it | |
| Where agents open their tabs | **Your window** (default), or **Own window**, opened unfocused beside yours | `OPENCODE_BROWSER_AGENT_WINDOW` |
| Group tabs | **Per session** (default), **All agents** in one group, or **None** | |
| Close idle tabs after | **10 min** (default), 30 min, 1 hour, Never | |
| Show the agent cursor | Off (default). Pages can see it while it's shown | `OPENCODE_BROWSER_GHOST_CURSOR` |
| Human-like input | On (default). Off is faster, but easier for sites to flag as a bot | `OPENCODE_BROWSER_HUMAN_INPUT` |
| Notify me on every handoff | Off (default): notify only on recorded tabs | |
| When a new version is published | **Install** (default), Tell me, Off | `OPENCODE_BROWSER_AUTO_UPDATE` |

When an environment variable sets one, the page shows the value in effect and which variable set it. Agents can read
and change these settings with their `settings` tool when you ask, and so can you: `browse settings get`,
`browse settings set grouping=shared`. Security switches are never settings; they're
[environment variables](#environment-variables) only.

**Advanced** holds the relay address and pairing code, plus **Reconnect**, **Close agent tabs** and
**Copy diagnostics**.

## Agent on another computer

If your agent runs on a server, a dev box or another laptop, the relay runs next to the agent and your browser
connects to it over the network.

1. **On the agent's computer**, run:

   ```sh
   curl -fsSL https://opencode.ai/browse/install | bash -s -- --remote
   ```

   If browse is already there, run `browse install --remote`. It sets up the agents, opens the relay to other
   computers, and prints a relay address and a one-time pairing code.
2. **In your browser**, open the settings page, then **Advanced**. Enter the **Relay address** and **Pairing code**,
   and click **Connect**. The page tells you whether the relay answered and accepted the code. (The setup guide's
   **Agent on another computer?** link shows the same form.)

The code works once, within 10 minutes; `browse pair` on the agent's computer prints a new one. To go back:

- `browse set hostname 127.0.0.1` makes the relay reachable from its own computer only.
- Set **Relay address** back to `localhost:19988` to use a relay on the browser's computer.

Other computers reach only the extension link; the relay's API and CDP still answer on `127.0.0.1` only. Both sides
prove they hold the browser's key on every connection, so anyone else who reaches the port gets nothing. browse
doesn't encrypt the connection itself, so use a network that does (Tailscale or WireGuard), never the open internet.

## Updates

browse keeps itself up to date. Once a day the relay checks for a new version, installs it in the background, and
switches over when no agent is using the browser. It doesn't touch your agents' config or restart them.

- `browse update` updates now; `browse rollback` goes back to the previous version.
- To stop automatic updates, choose **Tell me** or **Off** under **When a new version is published** on the settings
  page, run `browse settings set autoUpdate=notify` (or `off`), or set `OPENCODE_BROWSER_AUTO_UPDATE=off`.
- The extension updates itself from the Chrome Web Store.

## Troubleshooting

- `browse status` shows the relay, the extension and every tab agents can use.
- `browse doctor` checks the install.
- Logs are in `~/.local/share/opencode-browser/logs/` (`%LOCALAPPDATA%\opencode-browser\logs` on Windows).
- **Not paired, or the relay didn't accept this browser:** run `browse install` again, or run `browse pair` and enter
  the code on the settings page under **Advanced**.
- **The extension and the relay don't match:** run `browse update`. The extension updates from the Chrome Web Store;
  reload it on your browser's extensions page if it's behind.
- **Anything else:** click **Copy diagnostics** under **Advanced** on the settings page, and paste it into a bug
  report.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/how-dark.png">
  <img src="assets/how-light.png" alt="Three machines on one bench, cabled in a line: the agent's terminal calling browse.execute, the relay box in the middle, and the computer whose browser the agent drives.">
</picture>

Your agent talks to the `browse` MCP server over stdio. The server hands each command to the relay on
`127.0.0.1:19988`. The extension, connected to the relay over a WebSocket, runs it in your browser through
`chrome.debugger`.

- **The relay** (`cli/`) is a local Chrome DevTools endpoint backed by the extension. It keeps named sessions,
  handoffs, recordings, network capture and a journal, and starts on demand.
- **The extension** (`src/`) runs the relay's commands, keeps agent tabs grouped (or in their own window), closes idle
  ones, and shows the toolbar badge and the handoff card.

**Quiet in the page.** `execute` uses [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), which hides
the usual automation tells (`navigator.webdriver`, the `Runtime.enable` leak), and the relay drops Patchright's media
emulation overrides. Input moves like a person: curved mouse paths, paced typing, gliding scroll. The extension adds
nothing to pages you browse. In agent tabs it adds only the handoff card while a handoff waits (and the agent cursor
when asked), in a closed shadow root on an anonymous element, drawn from an isolated world.

This makes an agent hard to spot, not impossible:

- the browser shows its "started debugging" bar while the debugger is attached
- focus emulation keeps background agent tabs "visible"
- the card and cursor elements exist while they're shown
- `fillInput`'s fallback dispatches synthetic events (it warns when it does)

<details><summary>Extension permissions</summary>

- `debugger`, `tabs`, `tabGroups`, `storage`, `alarms`: drive and organize agent tabs, and keep settings.
- `offscreen`, `tabCapture`: recordings.
- `scripting`: add the handoff script only to tabs agents use, never to every page.
- `webNavigation`: keep popups agents open with their other tabs.
- `notifications`: tell you an agent needs you while it records a tab, or on every handoff if you ask.
- Access to all sites, so agents can work wherever you ask.

</details>

Nothing leaves your computer except what your agent sends to its model provider. See the
[privacy policy](store/privacy-policy.md).

## Security

browse drives the browser you're signed in to. It assumes that what an agent reads (a web page, an email) may try to
steer it, and that other programs on your computer may try to use the relay.

- **Only your browser, only your relay.** The relay needs a token for every request, and each browser proves it holds
  its own paired key on every connection.
- **Agent code is sandboxed** away from Node, your files and your API keys. It's defense in depth, not a hard
  boundary: treat code an agent runs as code running as you.
- **Cookies and site data stay scoped** to the sites a session is on. Agents can't clear your cookies or close your
  browser.
- **Your tabs stay yours.** Agents use only tabs they opened or you lent them, and only a real click finishes a
  handoff.
- **Optional guards:** limit a session to the sites you name, and store site secrets agents can type but never see.

<details><summary>The full security model</summary>

- **Relay token.** Every HTTP request and CDP connection to the relay needs the token in `relay-token` in the data
  folder (`~/.local/share/opencode-browser`, or `%LOCALAPPDATA%\opencode-browser` on Windows; readable only by you):
  an `Authorization: Bearer` header, or `?opencodeBrowserToken=` on the CDP WebSocket URL. The MCP server and CLI
  read it for you. The relay listens on `127.0.0.1` by default and refuses cross-site browser requests and foreign
  `Host` headers. Opened to other computers, they reach only the extension link.
- **Pairing.** `browse pair` prints a short code (`XXXX-XXXX`) that works once, within 10 minutes; five wrong codes in
  a row void every pending one. A browser exchanges it for a random key of its own, kept by the relay
  (`browser-tokens.json` in the data folder, readable only by you) and in the extension's storage. The exchange runs
  over a fresh key agreement (ECDH), so neither the code nor the key crosses the connection, and each side proves it
  knows the code before the other gives anything away. On every later connection both sides prove they hold the key
  (HMAC over fresh nonces) before the extension obeys anything, so a program that grabs the port first can't drive
  your browser. `browse pair --list` shows paired browsers and when each was last seen; `browse pair --revoke
  <browser>` deletes a browser's key and disconnects it. The relay accepts only the two published extension IDs (plus
  any listed in `OPENCODE_BROWSER_EXTENSION_ORIGINS`). Browsers paired by an earlier version with its shared code
  switch to a key of their own the next time they connect; `browse pair --revoke legacy` retires that code once they
  all have.
- **Sandboxed `execute`.** Agent code runs in a separate JavaScript realm, isolated from Node: no `process`,
  `require`, `import()`, `fs` or network modules, only a `files` helper and Playwright file options limited to the
  temp directory (plus any `OPENCODE_BROWSER_FILE_ROOTS`), never browse's data. The sandbox is defense in depth, not a
  hard security boundary: treat code an agent runs as code running as you. The relay starts with an allowlisted
  environment (the basics plus `OPENCODE_BROWSER_*`, proxy variables and CA certificate paths), so your API keys
  aren't in it.
- **CDP guardrails.** Cookie reads return only cookies for the session's own pages, and cookie writes are limited to
  those hosts. Site storage (IndexedDB, Cache Storage, DOM storage and the like) is limited the same way. Clearing
  cookies, cache or site data, and closing the browser, are always refused. Agents can't navigate to `file:`,
  `chrome:` and other browser-internal pages. `page.bringToFront()` is refused so agents can't raise windows over your
  work.
- **Domain allowlists (opt-in).** `browse session new <name> --allow-origin example.com` (or `browse session allow`,
  or `allowedOrigins` on `session_new` / `session_allowlist`) limits where a session's tabs go. The relay refuses
  agent navigations and new tabs to other hosts, stops or blanks links, redirects and script navigations that leave
  the list, and closes popups that open elsewhere. Private, loopback and link-local addresses need an entry naming
  that exact host; names are resolved first and the document's real remote IP is checked, against DNS rebinding.
  Subresources (images, fetch, iframes, workers) are not blocked: request interception is shared with Playwright's
  `page.route()`, so the relay can't own it reliably. Browsing through a local proxy makes every document look like
  it came from the proxy's address, so name the hosts you need exactly.
- **Site secrets.** `browse secrets add <name> --origin https://example.com` stores a password, key or (with
  `--totp`) a TOTP seed, read from stdin or a hidden prompt, in `site-secrets/` in the data folder (0700/0600). An
  agent types it with `secrets.type(locator, "<name>")`: right before inserting the value, the relay checks the
  field's frame URL from the browser's frame tree against the secret's origins (and the session's allowlist), so a
  cross-origin iframe or a redirect gets nothing. The value never enters the execute sandbox, results, logs, journals
  or HARs. Once typed it's in the page, where page script could read it, so pair secrets with an allowlist (execute
  warns when you don't). A stored TOTP seed makes 2FA one factor; keep handing 2FA to yourself when you can.
  `browse secrets list` and `browse secrets remove` manage them.
- **Bot challenges.** After a navigation, execute reports Cloudflare, Akamai, DataDome, PerimeterX, Imperva, AWS WAF,
  captcha walls and "access denied" pages in `aftermath.challenge`. It waits up to 15 s
  (`OPENCODE_BROWSER_CHALLENGE_WAIT_MS`) for checks the browser clears by itself, and tells the agent to hand
  interactive ones to you. It never solves them.
- **Your tabs stay yours.** Agents use only tabs they opened or you lent them. The toolbar button always takes a tab
  back; only a real click on the card or the toolbar button finishes a handoff, so a page can't fake it.
- **Less on disk.** Session journals are private (0700/0600), redact typed passwords, codes and tokens, and are
  pruned after 14 days (200 at most). HARs replace credentials with references; typed passwords and one-time codes
  are never stored. Secret profiles keep values out of transcripts and artifacts, but anything that runs with them
  (like `secrets_run`) can use them. `secrets_run` commands get the relay's allowlisted environment plus the
  profile's `BC_SECRET_N` values, not the environment you started your agent with: `PATH`, `HOME`, locale,
  `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR` and `NODE_EXTRA_CA_CERTS` pass
  through; other variables (API keys included) don't.

</details>

### Environment variables

Set these in the environment you start your agent from; the relay inherits `OPENCODE_BROWSER_*` variables. Run
`browse relay restart` after changing them.

<details><summary>Security switches and other variables</summary>

Security switches (environment only, never settings):

| Variable | Effect |
| --- | --- |
| `OPENCODE_BROWSER_ALLOW_NODE=1` | Run `execute` code with full Node access (`process`, `fs`, `import()`, any file path) |
| `OPENCODE_BROWSER_ALLOW_ALL_COOKIES=1` | Let sessions read and write every cookie in the profile |
| `OPENCODE_BROWSER_ALLOW_ALL_STORAGE=1` | Let sessions use every site's storage, not just their own pages' |
| `OPENCODE_BROWSER_ALLOW_FILE_URLS=1` | Let agents open `file:` URLs |
| `OPENCODE_BROWSER_ALLOW_FOREGROUND=1` | Allow `page.bringToFront()` |

Other variables:

| Variable | Effect |
| --- | --- |
| `OPENCODE_BROWSER_AGENT_WINDOW=separate` | Open agent tabs in their own window (`current`: in your window). Overrides *Where agents open their tabs* |
| `OPENCODE_BROWSER_GHOST_CURSOR=1` | Show the agent cursor on agent tabs outside recordings (pages can see it); `0` keeps it off. Overrides *Show the agent cursor* |
| `OPENCODE_BROWSER_HUMAN_INPUT=0` | Send input at full speed; `1` keeps human-like input on. Overrides *Human-like input* |
| `OPENCODE_BROWSER_AUTO_UPDATE=notify` | Only show new versions (`off`: don't check; `on`: install them when idle, the default). Overrides *When a new version is published* |
| `OPENCODE_BROWSER_EXECUTE_SLICE_MS=2000` | Longest `execute` JavaScript may run without yielding before it's stopped (50 to 60000; every session waits meanwhile) |
| `OPENCODE_BROWSER_CHALLENGE_WAIT_MS=15000` | How long `execute` waits for a bot check the browser clears by itself (0 to 60000; 0 reports it without waiting) |
| `OPENCODE_BROWSER_FILE_ROOTS` | More folders `execute` code may read and write, besides the temp directory (absolute paths, separated like `PATH`) |
| `OPENCODE_BROWSER_PORT=19988` | The relay's port |
| `OPENCODE_BROWSER_HOME` | Use another data folder |

</details>

## Tools

| Tool | What it does |
| --- | --- |
| `execute` | Run Playwright code against the session's page (`page`, `context`, `snapshot()`, `handoff()`, …) |
| `session_new`, `session_list`, `session_use`, `session_current`, `session_reset`, `session_delete` | Named sessions, each with its own tabs and browser; they survive restarts |
| `session_adopt` | Take over a tab you lent with the toolbar button |
| `session_allowlist` | Limit a session's tabs to the sites you name (also `allowedOrigins` on `session_new`) |
| `network_start`, `network_status`, `network_stop`, `network_cancel` | Capture traffic to a redacted HAR |
| `recording_start`, `recording_stop`, `recording_status`, `recording_cancel` | Record a tab to MP4 or WebM (`cursor: true` draws the agent cursor) |
| `flight_recorder_start`, `flight_recorder_save_last`, … | Keep the last minute of video, save it when something breaks |
| `secrets_list` | Site secrets stored for the session's sites; agents type them with `secrets.type()` only on those sites, without seeing them |
| `secrets_status`, `secrets_refresh`, `secrets_run` | Reuse captured credentials while keeping their values out of transcripts and artifacts |
| `tabs_cleanup` | Close the agent's idle tabs |
| `settings` | Read or change [settings](#settings) when you ask (never the security switches) |
| `status`, `skill` | Connection status, and the full agent guide |

The agent guide is [`cli/skills/browse/SKILL.md`](cli/skills/browse/SKILL.md). Everything is also a CLI command:
`browse --help`.

## Development

<details><summary>Install from source</summary>

For contributors, or before a release you need is out. This needs [Bun](https://bun.sh) and Node.js 22.19+.

```sh
git clone https://github.com/anomalyco/browse.git && cd browse && bun run setup
```

`setup` builds the extension and the CLI, sets up your selected agents, and puts a one-time pairing code in
`browse/dist` (good for an hour), which the extension exchanges for its own key when it first connects. Install
points at the Chrome Web Store build; to use your checkout's build instead, run `node cli/dist/cli.mjs extension`,
which shows the `browse/dist` folder to load unpacked. Load `browse/dist`, not `browse` or `browse/public`.

A checkout never updates itself. Run `node cli/dist/cli.mjs update` in your `browse` folder (or ask your agent to
update browse): it pulls new commits (fast-forward only, never over local changes), rebuilds, and asks the extension
to reload. If the old extension can't, reload browse on your browser's extensions page. The manual equivalent is
`git pull && bun run setup`. `status`, `doctor`, the settings page and the agent (once per session) say when there's
an update; browse checks the clone's remote at most every six hours. `OPENCODE_BROWSER_UPDATE_CHECK=0` turns the
check off.

If the extension says it's not paired, run `bun run setup` again, then reload the extension.

</details>

<details><summary>Dev builds</summary>

Every push to `dev` publishes a dev build. `npx @opencode/browse@dev install` follows the dev channel: it downloads
that build's extension into `<data folder>/extension`, which you load unpacked once (`npx @opencode/browse@dev
extension` shows the folder). Each update refreshes the folder and reloads the extension. The zip is also at
https://anoma.ly/release/browse/extension/dev/chromium.

</details>

```sh
bun install && bun run dev       # rebuilds dist/ on change; reload the extension to pick it up
bun run typecheck
bun run test                     # the extension and cli/ test suites (bun test), no browser needed
cd cli && bun src/main.ts status # the CLI from source
bun run release:check            # the store zip and npm tarball a release would publish, with its checks
```

`cli/` is the npm package `@opencode/browse`, with its own lockfile. The extension and the package share one version.
[RELEASING.md](RELEASING.md) has the release flow: dev builds from every push to `dev`, stable releases only from the
Release workflow in GitHub Actions.

## License

[MIT](LICENSE)
