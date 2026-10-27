# Chrome Web Store listing

Copy these into the developer dashboard. Upload `release/opencode-browser-<version>.zip` from `bun run package`.

## Store listing

**Name:** OpenCode Browser

**Summary (132 chars max):**
Let your OpenCode agents use your browser: open and drive tabs, take screenshots, and hand logins back to you.

**Category:** Developer Tools

**Description:**
OpenCode Browser lets OpenCode, the open source AI coding agent running on your computer, use your real browser through its browse tools.

- Agents open their own tabs in the background of your window, grouped at the start of your tab strip and collapsed so they stay out of your way. Prefer a separate window, one shared group or no groups? Choose it on the status page. Idle agent tabs close by themselves after 10 minutes, or the time you set.
- Want an agent to use a tab you have open? Click the toolbar button on it. Click again to take it back, even while the agent is working.
- Hand off when it's your turn: logins, 2FA, passkeys, and payments stay with you, then the agent continues.
- Agents use Playwright, take screenshots, capture network traffic, and record the tab when you ask. Recordings show only the page.

Requires OpenCode on your computer and the OpenCode Browser CLI from https://github.com/anomalyco/browse: clone it and run `bun run setup` once to add the browse tools, then paste the code from `node cli/dist/cli.mjs pair` on the extension's status page. The extension only obeys the relay that knows that code.

Everything stays between your browser and the OpenCode tools on your computer. The extension has no server of its own.

## Privacy

**Single purpose:**
Let OpenCode, an AI agent running on the user's computer, use the user's browser tabs at their request.

**Permission justifications:**
- `debugger`: Lets the user's OpenCode agent drive tabs it opened or the user shared (click, type, navigate, screenshot, read the page), the same as browser automation tools. The toolbar badge shows which tabs are in use.
- `tabs`, `tabGroups`: Open and list tabs for the agent, and group the agent's tabs so the user can see them.
- `storage`: Remember which tabs agents opened, the agent tab groups and window, the user's settings from the status page (where agent tabs open and how they're grouped, when idle ones close, the agent cursor, human-like input, handoff notifications), and the pairing code the user entered.
- `alarms`: Keep the connection to the local OpenCode relay alive, reconnect, and close agent tabs left idle.
- `offscreen`, `tabCapture`: Record a tab when the user asks an agent for a screen recording.
- `scripting`: Add the extension's handoff card only to tabs agents use (not to every page), so the user can finish a login or payment step and hand the tab back.
- `webNavigation`: Notice when an agent's click opens a new tab or popup, so it joins the agent's tab group (and the agent's own window, if the user chose one), the user's current tab stays in front, and it closes with the agent's other tabs.
- `notifications`: Tell the user an agent needs them while it records a tab (a recording must not show the in-page card), or on every handoff if the user chose that on the status page. Clicking the notification shows the tab. When notifications are turned off, the card is shown instead. Used for nothing else.
- Host permission `<all_urls>`: Agents work on whatever site the user asks for, and the page shows a card when an agent waits for the user there.

**Remote code:** No. All extension code ships in the package.

**Data usage:** Check "Website content" and "User activity" (agents read and interact with pages). Certify: not sold, not used for unrelated purposes, not used for credit decisions. Data goes only to the OpenCode tools on the user's computer.

**Privacy policy URL:** host `privacy-policy.md` (for example at opencode.ai/browser/privacy).
