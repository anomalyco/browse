<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <img src="assets/banner-light.png" alt="browse: let your AI agents use your real browser. An isometric desk computer whose screen shows a web browser with an agent's tab group, cabled to a small relay box.">
</picture>

Let your AI agents use your real browser: your tabs, your logins, your extensions. A small native MCP server and a
Chromium extension, for [OpenCode](https://opencode.ai), Claude Code, Codex, Cursor and any other MCP client.

---

Agents get a `browse` MCP server. They open tabs in the background, read pages, click, type, take screenshots,
capture network traffic and record the screen, in tabs grouped out of your way. When it's your turn (a login, a 2FA
prompt, a payment), they hand the tab back to you and continue once you click **Continue**.

It works in Chrome, Edge, Brave, Arc, Helium, Vivaldi, Opera and Chromium.

## Install

```sh
curl -fsSL https://opencode.ai/browse/install | bash
```

Or paste this into your agent: *"Set up browse so you can use my Chrome: run
`curl -fsSL https://opencode.ai/browse/install | bash`"*. It sets browse up for the agent that ran it.

Other ways to install, all of which end in the same `browse install`:

| How | Command | Where `browse` lives, and what updates it |
| --- | --- | --- |
| Install script (macOS, Linux) | `curl -fsSL https://opencode.ai/browse/install \| bash` | `~/.local/bin/browse` (`$XDG_BIN_HOME` when set); updates itself |
| Install script (Windows) | `irm https://opencode.ai/browse/install.ps1 \| iex` in PowerShell | `%USERPROFILE%\.local\bin\browse.exe`; updates itself |
| npx, bunx | `npx @opencode/browse install` | copied to `~/.local/bin/browse` once; updates itself from then on |
| npm | `npm i -g @opencode/browse`, then `browse install` | npm's global `browse`; browse runs `npm install -g` to update |
| bun | `bun add -g @opencode/browse`, then `browse install` | `~/.bun/bin/browse`; browse runs `bun add -g` to update |
| pnpm, yarn, volta | `pnpm add -g` / `yarn global add` / `volta install @opencode/browse`, then `browse install` | that manager's `browse`; updated with the same manager |

There's always exactly one `browse`: a global package install is left to its package manager (nothing is copied next
to it, and a leftover `~/.local/bin/browse` from an earlier install is removed), and agents run the same `browse` your
terminal does. If `browse install` finds another `browse` on your PATH it tells you which one and how to remove it.

The install script reads the channel's manifest from [Anomaly's release service](https://anoma.ly/release), downloads
the binary for this computer and checks its size and SHA-256 before installing it. `--channel stable|beta|dev` picks
the channel (`stable` by default); `--version <version>` installs a specific version from npm, checked against npm's
published SHA-512 integrity. With npm, `@opencode/browse@dev` is the dev channel. The npm package is a small Node
launcher (Node 22+) that runs the native binary npm installed for your platform.

### What `browse install` does

1. **Puts browse in place** (see above) and adds `~/.local/bin` to your PATH when it copied browse there
   (`--no-modify-path` skips that).
2. **Adds the browse MCP server to your agents.** In a terminal you get a picker: OpenCode and the agents found on this
   computer start checked (your last choice next time). Type to search all supported agents, ↑/↓ to move, Space or Tab
   to toggle, Enter to confirm. An agent running `browse install` sets up itself. Without a terminal OpenCode is the
   default. Edits keep the comments and formatting of each agent's config.
3. **Connects the extension.** If no browser has browse yet, install opens it in the Chrome Web Store; add it, and
   install pairs it once it's there. If a browser already has it, install opens its setup page with a one-time pairing
   code in the link, so it pairs without copying anything. Over SSH or without a display it prints a code instead.

Then ask your agent to *"open news.ycombinator.com and tell me the top story"*. An agent that was already running
needs a restart (or an MCP reload) to load browse.

```sh
browse install -a claude codex   # these agents, without asking (--agent; names below)
browse install -a '*'            # every supported agent, installed or not
browse install -y                # every agent found on this computer
browse install --agent none      # no agent: print the MCP entry to add by hand
```

<details><summary>Supported agents and their user-level config files</summary>

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
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md) (`dsh`) | `$DSH_HOME/cordis.patch.yml` (default `~/.dsh/cordis.patch.yml`) | YAML · `insert` patch row |
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
| Trae CN (`trae-cn`) | `APP/Trae CN/User/mcp.json` | JSON · `mcpServers` |
| [Warp](https://docs.warp.dev/agents/capabilities/mcp) (`warp`) | `~/.warp/.mcp.json` | JSON · `mcpServers` |
| WorkBuddy (`workbuddy`) | `~/.workbuddy/mcp.json` | JSON · `mcpServers` |
| [Zed](https://zed.dev/docs/ai/mcp) (`zed`) | macOS: `~/.config/zed/settings.json`; Linux: `CONFIG/zed/settings.json`; Windows: `APP/Zed/settings.json` | JSONC · `context_servers` |

</details>

For any other stdio MCP client, run `browse mcp`:

```json
{ "mcpServers": { "browse": { "command": "/home/you/.local/bin/browse", "args": ["mcp"] } } }
```

(`browse install --agent none` prints this with your path.) Re-running install updates the entries it wrote and
leaves servers named browse that it didn't write alone.

### Pairing

There's nothing to sign in to. Each browser pairs with browse once and gets a key of its own (see
[Security](#security)). If pairing didn't happen by itself, run `browse install` again, or run `browse pair`: it
prints a one-time code (`XXXX-XXXX`, good for 10 minutes) and waits. Open **Extensions → browse → Options**, expand
**advanced** (or click **Pair with a code**), enter the code under **Pairing code** and click **Connect**. `browse pair
--list` shows paired browsers; `browse pair --revoke <browser>` unpairs one.

### Browser on another computer

When your agent runs on one machine and your browser on another (over Tailscale, say), browse runs next to the agent
and the extension connects to it across the network:

1. On the agent's machine run `browse install --remote` (or `browse set hostname 0.0.0.0` after installing). browse
   then listens on every network, restarting the relay if it runs, and prints this machine's address and a pairing
   code. Other computers reach only the extension link; the HTTP API answers on `127.0.0.1` only.
2. In the browser, open browse's setup page, choose **Connect an agent on another computer** and enter the address and
   code (or use **Relay address** and **Pairing code** under **advanced** on the options page).

The connection isn't encrypted by browse; use a network that is (Tailscale or WireGuard), not the open internet.
`browse set hostname 127.0.0.1` goes back to this computer only.

### Updates

**Updates are automatic.** Every relay checks at launch and then hourly, whatever the update setting, and installs the
channel's release when it isn't the one running (a rollback reaches everyone too):

- every install reads its channel's manifest from the release service (`stable`, or `dev`/`beta` for those builds),
  with `browse/<channel>/<version>/cli/<install kind>` as the User-Agent;
- the install script's binary replaces `~/.local/bin/browse` with the manifest's tarball after checking its size and
  SHA-256;
- global installs run the package manager that installed them (`npm install -g`, `bun add -g`, `pnpm add -g`,
  `yarn global add`, `volta install`) to install `@opencode/browse@<the manifest's version>` into the same place. A
  release reaches the service a few minutes before npm, so a package manager that doesn't have the version yet is
  retried quietly;
- `npx`, `bunx`, `pnpm dlx` and `yarn dlx` runs resolve the package themselves: they only tell you another release is
  out.

A relay browse started restarts on the new version when it's idle (one you run with `browse serve` in a terminal keeps
running until you restart it); agent tabs stay open and come back. A running MCP server keeps
working with the newer relay until the agent restarts it. `browse update` updates now and `browse update --check` only
looks. Choose **Tell me** or **Off** under **updates** on the extension's options page, or run `browse update --mode
notify|off` (`OPENCODE_BROWSER_AUTO_UPDATE=off` in the environment overrides both). Off still checks hourly, and
installs nothing. To go back, rerun the install
script with `--channel <channel>` or `--version <version>`, or install `@opencode/browse@<version>` with your package
manager. The Chrome Web Store updates the extension.

**Dev builds**: every push to `dev` publishes one: `curl -fsSL https://opencode.ai/browse/install | bash -s --
--channel dev`, or `npx @opencode/browse@dev install`. The store extension works with dev builds. To try the dev
extension too, download https://anoma.ly/release/browse/extension/dev/chromium, unzip it, turn on **Developer mode** on
your browser's extensions page, click **Load unpacked**, pick the folder and run `browse pair` (`browse extension`
prints these steps on the dev channel). Remove the store extension first so only one browse runs in that profile.

### Uninstall

```sh
browse uninstall
```

It removes browse from every agent config it was added to, stops the relay, deletes `~/.local/bin/browse` (for the
install script and npx installs), the PATH line it added and browse's files. A global package stays with its package
manager: uninstall prints the command (`npm rm -g @opencode/browse`, `bun remove -g @opencode/browse`, ...). Remove the
extension from your browser to finish.

## Using it

- **Tabs are the handle.** `navigate` without a `tab` opens a new background tab and returns its id; every other call
  passes that `tab`. Agents use the tab ids they opened or were given, and leave other tabs alone unless you ask.
  Tabs can be opened with options that stick: `group` (the tab group's title, and a handle to close them together),
  `allowedOrigins`, `readOnly`, `keepVisible`, `keepOpen` (never close it as idle) and `browser`. Popups a page opens
  become agent tabs too.
- **Tabs keep their ids, and an agent can name one.** `tabs` with `action: "new"` and an `id` like `work-mail` opens
  that tab once: asking again returns the same tab without navigating it, and every tool takes `work-mail` as `tab`.
  The id lasts while the tab stays open: a relay restart or extension reload keeps it, and a browser restart loses it
  (opening that id again is a fresh tab). `tabs` lists each tab's id, url, title, group, last use and whether a call is
  running in it. A tab opened with `keepOpen: true` stays until an agent or you close it; every other tab closes when
  idle like the rest.
- **Agents open their own tabs** in the background of the window you last used, grouped together and collapsed unless
  you're looking at one (you can turn that off). Agents can't switch you to their tabs or bring a window to the front.
  Tabs nobody touches for 10 minutes close by themselves (never while something runs on them). Closing agent tabs never
  quits the browser: on Windows and Linux, browse leaves a new tab (or window) behind when it would close the last one.
- **Relay restarts keep agent tabs.** The relay saves the tabs agents opened and their options, and takes them back
  when it starts again (after an update, say).
- **Hand an agent one of your tabs** by clicking the toolbar button on it. The badge shows **ON**; click again to take
  it back. While an agent works the badge reads **RUN**, and **WAIT** when it needs you. The button always works: a
  click while an agent runs takes the tab back. The browser's debugging bar (**Cancel**, or **OK** in some browsers)
  disconnects browse from every tab; browse shows a notification when that happens, and clicking the browse button on a
  tab lends it again. Chrome's own pages, the Web Store included, can't be lent.
- **Handoffs:** the page shows a small card with the site's origin. Do the human part, then click **Continue** on the
  card or the toolbar button. While a tab is recorded you get a system notification instead of the card.
- **Uploads.** Large files, or sites that reject copied files, work when the browser is on the same computer and the
  extension has "Allow access to file URLs" turned on in the browser's extensions page (browse → Details): browse hands
  the input the paths and the browser reads them itself. Otherwise browse copies the files in, up to 50 MB per call.
- **Several browsers at once.** Each connected browser has an id (like `chrome-macbook`); `status` lists them, and new
  tabs open in the default browser unless `browser` names another.
- **Settings** (the extension's options page, applied right away): where agent tabs open (your window or their own),
  grouping (one shared group, one per task, or none), whether browse collapses agent groups by itself or leaves them
  as you set them (a handoff still opens its group so you can find the tab), when idle tabs close (10, 30, 60 minutes
  or never), whether agent tabs open muted, human-like input, and handoff notifications. Agents can read and change
  these with the `settings` tool when you ask them to.

## Tools

OpenCode, which composes tools in code mode, gets the plain tools. Every other MCP client gets `execute`, `status` and
`tabs`; `execute` runs JavaScript that can call all of them. The relay decides by the client's name
(`OPENCODE_BROWSER_TOOLS=plain|execute|all` on the relay overrides it).

| Tool | What it does |
| --- | --- |
| `navigate` | Open a page: without `tab`, in a new background tab whose id it returns |
| `snapshot` | A compact outline of the page with refs (`e12`) for the other tools, iframes included; scopes to the page's main area when there's exactly one and says what it left out |
| `click`, `fill`, `type`, `press`, `select`, `hover`, `drag`, `scroll` | Act on a ref, selector or point, with human-like input |
| `wait_for`, `dialog`, `upload`, `eval` | Wait for text, a URL or an element; answer dialogs; set files; run JavaScript in the page |
| `screenshot`, `screenshot_diff` | The viewport, full page, an element or a rectangle; compare with a baseline |
| `network`, `console` | Capture a tab's traffic (credentials redacted) or its console messages and errors |
| `recording` | Record a tab to a video file |
| `emulate`, `webmcp` | Viewport, color scheme, user agent, geolocation and more; tools a page offers through WebMCP |
| `tabs` | List, open or close tabs (`group` closes a whole group; an `id` names a tab for good, and opens it if it's missing) |
| `handoff`, `demonstrate` | Ask you to do something only a person can do; ask you to show a flow while it records your steps |
| `settings`, `status` | Read or change your settings when you ask; the relay, browsers, pairing state and what to do next |
| `execute` | For other clients: JavaScript with a Playwright-style `page`, `snapshot()`, `ref()`, `handoff()`, `state` and `browse.<tool>()`. Each result starts with the tab it ended in, to pass back as `tab` |

Everything is a CLI too: `browse navigate https://example.com` prints the new tab's id, then `browse snapshot --tab
<id>`, `browse click e12 --tab <id>`, `browse execute --file script.js`. `browse tools` lists them and `browse <tool>
--help` shows a tool's options.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/how-dark.png">
  <img src="assets/how-light.png" alt="Three machines on one bench, cabled in a line: the agent's terminal calling browse, the relay box in the middle, and the computer whose browser the agent drives.">
</picture>

The agent starts `browse mcp`, a small stdio proxy, which starts the relay on demand and forwards each call to it on
`127.0.0.1:19988` (or the next free port from 19990–19997 when another program holds it). The extension connects to
the relay over a WebSocket and runs its commands in your browser through `chrome.debugger`.

- **The relay** (`browse serve`, in `rust/`) keeps agent tabs, handoffs, recordings and network captures, talks the
  Chrome DevTools Protocol to each tab, and runs `execute` scripts in an embedded JavaScript engine (QuickJS). It
  runs until it's stopped (`browse restart`, `browse uninstall`, a signal) or restarts onto an update.
- **The extension** (`src/`) runs the relay's commands through `chrome.debugger`, keeps agent tabs in collapsed groups
  by default (or their own window), closes idle ones, and shows the toolbar badge and the handoff card.
- **Quiet in the page.** browse doesn't enable the CDP domains pages can detect, runs its own code in isolated worlds
  and leaves no globals behind. Input moves like a person: curved mouse paths, paced typing, gliding scroll (turn
  *Human-like input* off for full speed). This makes an agent hard to spot, not impossible: the browser shows its
  "started debugging" bar while the debugger is attached.

Permissions: `debugger`, `tabs`, `tabGroups`, `storage`, `alarms`, `scripting` (to add the handoff card only to tabs
agents use), `webNavigation` (to keep popups agents open with their other tabs), `notifications` (to tell you an agent
needs you while it records a tab), and access to all sites so agents can work wherever you ask. Nothing leaves your
computer except what your agent sends to its model provider; see the [privacy policy](store/privacy-policy.md).

## Security

browse drives the browser you're signed in to, so it assumes that what an agent reads (a web page, an email) may try
to steer it, and that other programs on your computer may try to use the relay.

- **Relay token.** Every request to the relay needs the token in `~/.local/share/browse/relay-token` (readable only by
  you). The MCP server and CLI read it for you. The relay listens on `127.0.0.1` only (unless you open it with `set
  hostname`, and then only the extension link) and refuses cross-site browser requests and foreign `Host` headers.
- **Pairing.** A pairing code works once, within 10 minutes; five wrong codes in a row void every pending one. A
  browser exchanges it for a random key of its own over a fresh key agreement (ECDH), so neither the code nor the key
  crosses the connection. On every later connection both sides prove they hold the key before the extension obeys
  anything, so a program that grabs the port first can't drive your browser. The relay accepts only the published
  extension IDs (plus any listed in `OPENCODE_BROWSER_EXTENSION_ORIGINS`).
- **`execute` is sandboxed, not a boundary.** Scripts run in QuickJS inside the relay with CPU, memory and time
  limits, no Node, network or file access beyond the file roots (temp folders and `OPENCODE_BROWSER_FILE_ROOTS`).
  Treat code an agent runs as code running as you. The relay starts with an allowlisted environment, so your API keys
  aren't in it.
- **CDP guardrails.** Clearing cookies, cache or site data, closing the browser and changing site permissions are
  refused. Closing a page is handled like closing a target: a tab you lent is released, not closed. Cookie and storage
  access is limited to the hosts of the tab's own pages. Agents can't open browser-internal pages, other extensions or
  local files, or raise windows over your work.
- **Guardrails, not a data boundary.** `allowedOrigins` limits navigations, top-level documents and the tabs and popups
  an agent opens; requests a page makes itself (fetch, XHR, images, scripts, iframes) are not filtered. `readOnly`
  refuses clicks, hover, drag, typing, key presses, filling, selecting, uploads and navigation commands after the tab
  opens. Scrolling to an element or to the page's edges still works. `eval` and `webmcp` still run JavaScript in the
  page: they can read everything the page can, make requests as the page, and change it (click, submit, navigate).
  Snapshots, screenshots and the cookies the page itself can see stay readable. These keep an agent from wandering: for
  pages you don't want an agent to read, don't open them in browse.
- **What output is masked.** `fill` hides values only for password and one-time-code fields. Snapshots leave out what's
  typed in editable fields, but not other page text. Network capture redacts credentials by name and shape (auth and
  API-key headers, cookie values, secret-named fields, token-like path segments), so a value under an ordinary name can
  still come through. `eval` results, console messages, page text and screenshots are returned as they are.
- **WebMCP tools come from the page.** Their names, titles, descriptions, schemas, annotations, `origin` and results are
  whatever a page supplies; browse doesn't verify them, and an annotation like `readOnly` is only the page's word. Treat
  them like any other page text, not as instructions from the user.
- **Bot challenges.** After a navigation browse reports Cloudflare, captcha walls and "access denied" pages and tells
  the agent to hand interactive ones to you. It never solves them.
- **Your tabs stay yours.** Agents use only tabs they opened or you lent them. Only a real click on the card or the
  toolbar button finishes a handoff, so a page can't fake it.

Escape hatches, set in the environment you start your agent from. The relay inherits `OPENCODE_BROWSER_*` variables
when it starts: it stops after 30 minutes without use, or run `browse restart` from a shell with the same variables:

| Variable | Effect |
| --- | --- |
| `OPENCODE_BROWSER_ALLOW_ALL_COOKIES=1` | Let tabs read and write every cookie in the profile |
| `OPENCODE_BROWSER_ALLOW_ALL_STORAGE=1` | Let tabs use every site's storage, and load resources from any host with your credentials |
| `OPENCODE_BROWSER_ALLOW_FOREGROUND=1` | Allow bringing a tab's window to the front |
| `OPENCODE_BROWSER_ALLOW_FILE_URLS=1` | Allow `file:` URLs |
| `OPENCODE_BROWSER_FILE_ROOTS` | More folders tools may read and write (path-list separated) |
| `OPENCODE_BROWSER_AGENT_WINDOW=separate` | Open agent tabs in a separate window (`current`: in yours), overriding the options page |
| `OPENCODE_BROWSER_HUMAN_INPUT=0` | Send input at full speed; overrides the options page |
| `OPENCODE_BROWSER_AUTO_UPDATE=notify` | Only tell about new versions (`off`: check, but never install or tell; `on`: install them, the default) |
| `OPENCODE_BROWSER_CHALLENGE_WAIT_MS=15000` | How long to wait for a bot check the browser clears by itself |
| `OPENCODE_BROWSER_EXTENSION_TIMEOUT_MS=30000` | How long the relay waits for the extension to answer a command |
| `OPENCODE_BROWSER_PING_TIMEOUT_MS=10000` | How long a ping may go unanswered before the browser counts as asleep |
| `OPENCODE_BROWSER_PORT=20000` | Pin the relay's port, with no fallback. The extension finds only browse's own ports (19988, 19990–19997) by itself, so enter `localhost:<port>` as its relay address when you pair |
| `OPENCODE_BROWSER_TOOLS=plain\|execute\|all` | Which tools every client gets |

## Troubleshooting

- `browse status` shows the install, the agents browse is set up in, updates, the relay, the extension and agent tabs,
  and says what to do when the extension is missing, unpaired, closed or out of date. Agents get the same from the
  `status` tool.
- After the relay restarts, the extension reconnects by itself within about half a minute; calls made in the meantime
  wait for it.
- An agent says browse's tools are missing: restart the agent (or reload its MCP servers) after `browse install`.
- "The browser isn't answering" while the computer is very busy: raise `OPENCODE_BROWSER_EXTENSION_TIMEOUT_MS` and
  `OPENCODE_BROWSER_PING_TIMEOUT_MS`.
- Logs: `~/.local/state/browse/logs/relay.log`.
- Another program's server on port 19988: browse takes the next free port from 19990–19997 and the extension finds it
  there. A port held by something that doesn't answer HTTP stops it; stop that program or set `OPENCODE_BROWSER_PORT`.
- The extension says it's not paired, or the relay refused it: run `browse install` again, or `browse pair` and enter
  the code in the extension's options.
- An agent says browse was updated and its MCP server must restart: an MCP server started before an update to this
  version can't talk to the new relay. Restart the agent.

## Development

```sh
bun install && bun run dev       # rebuilds the extension into dist/ on change; load it unpacked, reload to pick it up
bun run typecheck && bun test ./test
cd rust && cargo test --workspace && cargo run -p browse -- status
```

A build from a checkout (`cargo run -p browse -- install`) is used in place and never updates itself. The extension in
`dist/` keeps the manifest key, so it loads with the unpacked ID the relay trusts; run `browse pair` to pair it.
[RELEASING.md](RELEASING.md) has the release flow (dev builds from every push to `dev`; stable releases only from the
Release workflow in GitHub Actions), and [rust/PLAN.md](rust/PLAN.md) the layout of the Rust crates. `cli/` is the
earlier TypeScript implementation, kept as a reference.

## Contributing

We don't take pull requests. [Open an issue](https://github.com/anomalyco/browse/issues)
describing the bug or idea, and our agents usually turn it around fast.

## License

[MIT](LICENSE)
