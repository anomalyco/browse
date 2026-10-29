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
npx @opencode/browse install
```

`install` puts the relay in your data folder (`~/.local/share/opencode-browser`), adds the `browse` MCP server to
opencode, and connects the extension:

1. **Add the extension.** `install` opens Browse in the Chrome Web Store; add it to your browser. If it's
   already there, `install` opens its status page with the pairing code, so it pairs without copying anything.
2. **Restart opencode.**

That's it. Ask an agent to *"open news.ycombinator.com and tell me the top story"*. Or paste this into opencode:
*"Install browse with `npx @opencode/browse install`."*

Requirements: Node.js 22.19+, a Chromium browser, and [opencode](https://opencode.ai) or another MCP client.

**Updates are automatic.** The relay checks npm once a day and installs a new version in the background; it switches
over when no agent is using the browser, without changing opencode's config or restarting it. Choose *Only tell me* or
*Don't check* under **Updates** on the extension's status page (or `settings set autoUpdate=notify`, or
`OPENCODE_BROWSER_AUTO_UPDATE=off`). `npx @opencode/browse update` updates now, and `npx @opencode/browse rollback` goes
back to the previous version. The Chrome Web Store updates the extension. Betas: `npx @opencode/browse@beta install`.

There's nothing to sign in to. The extension only obeys a relay that proves it knows this computer's pairing code (see
[Security](#security)). If pairing didn't happen by itself, run `npx @opencode/browse pair` and paste the code on the
extension's status page (right-click the toolbar button, then **Options**).

### From source

For contributors, or before a release you need is on npm:

```sh
git clone https://github.com/anomalyco/browse.git && cd browse && bun run setup
```

`setup` builds the extension and the CLI, adds the `browse` MCP server to opencode, and pairs the extension with the
local relay. Two steps are left for you:

1. **Load the extension.** `setup` opens your browser's extensions page, shows the `browse/dist` folder and copies its
   path. Turn on **Developer mode**, click **Load unpacked** and choose that folder (on macOS, press Cmd+Shift+G in the
   picker and paste), or drag the folder onto the page. `setup` waits until the extension connects.
2. **Restart opencode.**

This needs [Bun](https://bun.sh) as well. A checkout never updates itself: run `node cli/dist/cli.mjs update` in your
`browse` folder (or ask your agent to update browse), then restart opencode. It pulls the new commits (fast-forward
only, and never over local changes), rebuilds, and reloads the extension for you. The manual equivalent is
`git pull && bun run setup`. When there's an update, `status`, `doctor`, the extension's status page and the agent (once
per session) say so; browse checks the clone's remote at most every six hours. Set `OPENCODE_BROWSER_UPDATE_CHECK=0` to
turn the check off.

### Other MCP clients

`install` writes the server into opencode's config. For other clients, add an stdio server that runs the installed
shim, which always runs the current version (from a checkout, use `/path/to/browse/cli/dist/cli.mjs` instead):

```json
{
  "browse": { "command": "node", "args": ["/Users/you/.local/share/opencode-browser/bin/opencode-browser.mjs", "mcp"] }
}
```

## Using it

- **Agents open their own tabs** in the background of the window you last used, grouped at the start of your tab strip
  under the agent's session name and collapsed unless you're looking at one. Agents can't switch you to their tabs or
  bring a window to the front; popups an agent opens join its group, and if one takes over your window you get your
  tab back. Tabs nobody touches for 10 minutes close by themselves (never while a script runs on them).
- **Settings** (the extension's options page; each applies right away, to new tabs for window and grouping):
  - **Where agents open their tabs:** in your window (default), or *in a separate window* of their own that opens
    unfocused beside yours (on another display when there's no room on yours); their popups move there too.
  - **Grouping:** one collapsed group per agent session (default), *one shared group* for every agent ("Agents · 3",
    one per window, popups included; a handoff opens it), or *don't group* (agent tabs sit in the background of your
    tab strip; pin one to keep it). Tabs already grouped stay where they are when you switch.
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
  it back. While an agent works the badge reads **RUN**, and **WAIT** when it needs you. The button always works: a
  click while a script runs takes the tab back and stops the script. Agents can't close a tab you lent them.
- **Handoffs:** the page shows a small card with the site's origin. Do the human part, then click **Continue** on the
  card or the toolbar button.
- **Recordings show only the page.** Nothing from Browse is drawn while a tab is recorded: no cursor, no
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
| `session_allowlist` | Limit a session's tabs to the sites you name (also `allowedOrigins` on `session_new`) |
| `network_start`, `network_status`, `network_stop`, `network_cancel` | Capture traffic to a redacted HAR |
| `recording_start`, `recording_stop`, `recording_status`, `recording_cancel` | Record a tab to MP4 or WebM (`cursor: true` draws the ghost cursor) |
| `flight_recorder_start`, `flight_recorder_save_last`, … | Keep the last minute of video, save it when something breaks |
| `secrets_list` | Site secrets you stored, and the Deadbolt logins you granted, for the session's sites; agents type them with `secrets.type()` only on their sites, without seeing them |
| `signin` | Sign in to a site with a Deadbolt login you granted, in one step, without the agent seeing any value |
| `secrets_status`, `secrets_refresh`, `secrets_run` | Reuse captured credentials while keeping their values out of transcripts and artifacts |
| `tabs_cleanup` | Close the agent's idle tabs |
| `settings` | Read or change the settings below when the user asks (never the security switches); the options page updates live |
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
  tabs in collapsed groups (or their own window), closes idle ones, and shows the toolbar badge and the handoff card.
- **Quiet in the page.** `execute` uses [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), which hides
  the usual automation tells (`navigator.webdriver`, the `Runtime.enable` leak), and the relay drops Patchright's media
  emulation overrides. The extension adds nothing to pages you browse; in agent tabs it adds nothing to the DOM except
  the handoff card while a handoff waits (and the ghost cursor when asked for). Both live in a closed shadow root on an
  anonymous element, drawn from an isolated world. Input moves like a person: curved mouse paths, paced typing,
  gliding scroll (turn *Human-like input* off on the options page, or `OPENCODE_BROWSER_HUMAN_INPUT=0`, for full speed). This makes an agent hard to spot, not impossible: the
  browser shows its "started debugging" bar while the debugger is attached, focus emulation keeps background agent tabs
  "visible", the card and cursor elements exist while shown, and `fillInput`'s fallback dispatches synthetic events
  (it warns when it does).

Permissions: `debugger`, `tabs`, `tabGroups`, `storage`, `alarms`, `offscreen` and `tabCapture` (recordings),
`scripting` (to add the handoff script only to tabs agents use, never to every page), `webNavigation` (to keep popups
agents open with their other tabs), `notifications` (to tell you an agent needs you while it records a tab), and access to
all sites so agents can work wherever you ask. Nothing leaves your computer except what your agent sends to its model
provider; see the [privacy policy](store/privacy-policy.md).

## Security

Browse drives the browser you're signed in to, so it assumes that what an agent reads (a web page, an email)
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
  to the temp directory, not Browse's data. The sandbox is a defense in depth, not a hard security boundary:
  treat code an agent runs as code running as you. The relay starts with an allowlisted environment (the basics plus
  `OPENCODE_BROWSER_*`, proxy variables and CA certificate paths), so your API keys aren't in it.
- **CDP guardrails.** Cookie reads return only cookies for the session's own pages; cookie writes are limited to
  those hosts. Clearing cookies, cache or site data, and closing the browser, are always refused. `page.bringToFront()`
  is refused so agents can't raise windows over your work.
- **Domain allowlists (opt-in).** `session new <name> --allow-origin example.com` (or `session allow`, or
  `allowedOrigins` on `session_new` / `session_allowlist`) limits where a session's tabs go. The relay refuses agent
  navigations and new tabs to other hosts, stops or blanks links, redirects and script navigations that leave the
  list, and closes popups that open elsewhere. Private, loopback and link-local addresses need an entry naming that
  exact host; names are resolved first and the document's real remote IP is checked, against DNS rebinding.
  Subresources (images, fetch, iframes, workers) are not blocked: request interception is shared with Playwright's
  `page.route()`, so the relay can't own it reliably. Browsing through a local proxy makes every document look like
  it came from the proxy's address, so name the hosts you need exactly.
- **Site secrets.** `opencode-browser secrets add <name> --origin https://example.com` stores a password, key or (with
  `--totp`) a TOTP seed, read from stdin or a hidden prompt, in `~/.local/share/opencode-browser/site-secrets/`
  (0700/0600). An agent types it with `secrets.type(locator, "<name>")`: the relay checks the field's frame URL from
  the browser's frame tree against the secret's origins (and the session's allowlist) right before it inserts the
  value, so a cross-origin iframe or a redirect gets nothing. The value never enters the execute sandbox, results,
  logs, journals or HARs. Once typed it is in the page, where page script could read it, so pair secrets with an
  allowlist (execute warns when you don't). A stored TOTP seed makes 2FA one factor; keep handing 2FA to yourself
  when you can. `secrets list` and `secrets remove` manage them.
- **Deadbolt sign-ins.** With [Deadbolt](https://github.com/anomalyco/deadbolt), agents can sign in unattended with
  the logins you allow, and never see a value. Connect once with `opencode-browser deadbolt connect` (it runs
  `deadbolt agents add-client browse`, which asks for Touch ID or your passphrase and refuses AI agents) and allow
  logins in Deadbolt: `deadbolt agents allow github.com` lets agents use that site's logins (username, password,
  one-time code and passkeys, unless you narrow it with `--login <username>`, `--fields`, `--no-passkeys` or
  `--expires 30d`), and
  `deadbolt agents allow --all` lets them use every login. Only you can grant; `deadbolt agents grants` and `deadbolt
  agents revoke <id>` manage grants, and every fill is in `deadbolt activity`. Agents then call the `signin` tool (or
  `secrets.signIn()` in execute): the relay does the whole sign-in inside one call (username, submit, password, an
  authenticator code including split code boxes, "Use password instead", and Sign in with Google when a Google login
  is granted) and returns only `{status, step, reason}`. It stops with `needs_user` for captchas, codes sent by SMS or
  email, push approvals and new-device checks, for you to finish after a handoff. One value can also be typed with
  `secrets.type(locator, "deadbolt:<site>[/<username>]", { field })`. In tabs agents opened, a site's passkey request
  (`navigator.credentials.get`) is answered by Deadbolt when a grant covers the site's passkeys (user presence only,
  never user verification, so sites that require verification fall back); otherwise it fails as if you dismissed it.
  With several passkeys for a site the agent names the account (`signin` with `username`, or
  `secrets.usePasskey({ site, username })`); without one, `signin` returns `needs_choice` with the accounts, and
  agents can't use the browser's WebAuthn debugging methods at all. **Trust model:** the relay checks each field's
  frame origin from the browser's frame tree (and the session allowlist) before it asks Deadbolt, which checks the
  grant and the login's URLs against that origin again; values are redacted from everything the agent gets, like
  site secrets. The client token is stored 0600 in `~/.local/share/opencode-browser/deadbolt-client.json`: any
  program running as you that can read it can use the logins you granted (never anything else), which is the price of
  unattended use, so keep grants small and pair them with a session allowlist. Locking Deadbolt pauses all agent
  sign-ins. `opencode-browser deadbolt status` shows the connection; `deadbolt disconnect` removes it. The relay finds
  Deadbolt's socket by Deadbolt's own rules (`$XDG_RUNTIME_DIR/deadbolt…/agent.sock`, else
  `$TMPDIR/deadbolt…-<uid>/agent.sock`, with `DEADBOLT_HOME` taken into account) or
  `OPENCODE_BROWSER_DEADBOLT_SOCKET`.
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
| `OPENCODE_BROWSER_EXECUTE_SLICE_MS=2000` | Longest `execute` JavaScript may run without yielding before it is stopped (50 to 60000; every session waits meanwhile) |
| `OPENCODE_BROWSER_GHOST_CURSOR=1` | Show the agent cursor on every agent tab outside recordings (pages can see it); `0` keeps it off. Overrides the options page's *Agent cursor* |
| `OPENCODE_BROWSER_AUTO_UPDATE=notify` | npm installs: only show new versions (`off`: don't check; `on`: install them when idle, the default). Overrides the status page's *Updates* |
| `OPENCODE_BROWSER_HUMAN_INPUT=0` | Send input at full speed instead of human-like paths and pacing; `1` keeps them on. Overrides the options page's *Human-like input* |
| `OPENCODE_BROWSER_CHALLENGE_WAIT_MS=15000` | How long `execute` waits for a bot check the browser clears by itself (0 to 60000; 0 reports it without waiting) |

## Troubleshooting

- `node cli/dist/cli.mjs status` shows the relay, the extension and every tab agents can use.
- `node cli/dist/cli.mjs doctor` checks the install.
- Logs: `~/.local/share/opencode-browser/logs/relay.log`.
- Extension says another browser is connected: only one browser profile can be connected at a time. Close the other
  one, then click **Reconnect** on the status page.
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
[RELEASING.md](RELEASING.md) has the release flow (`bun run release <version>`, then push the tag).

## License

[MIT](LICENSE)
