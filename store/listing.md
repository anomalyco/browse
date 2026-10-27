# Chrome Web Store listing

Copy these into the developer dashboard. Upload `release/opencode-browser-<version>.zip` from `bun run package`.

## Store listing

**Name:** OpenCode Browser

**Summary (132 chars max):**
Let your OpenCode agents use your browser: open and drive tabs, take screenshots, and hand logins back to you.

**Category:** Developer Tools

**Description:**
OpenCode Browser lets OpenCode, the open source AI coding agent running on your computer, use your real browser through its browse tools.

- Agents open their own tabs in a window of their own that never takes focus, grouped so you can see them. Idle agent tabs close by themselves.
- Want an agent to use a tab you have open? Click the toolbar button on it. Click again to take it back, even while the agent is working.
- Hand off when it's your turn: logins, 2FA, passkeys, and payments stay with you, then the agent continues.
- Agents use Playwright, take screenshots, capture network traffic, and record the tab when you ask. Recordings show only the page.

Requires OpenCode on your computer. Run `npx opencode-browser-cli install` once to add the browse tools, then paste the code from `npx opencode-browser-cli pair` on the extension's status page. The extension only obeys the relay that knows that code.

Everything stays between your browser and the OpenCode tools on your computer. The extension has no server of its own.

## Privacy

**Single purpose:**
Let OpenCode, an AI agent running on the user's computer, use the user's browser tabs at their request.

**Permission justifications:**
- `debugger`: Lets the user's OpenCode agent drive tabs it opened or the user shared (click, type, navigate, screenshot, read the page), the same as browser automation tools. The toolbar badge shows which tabs are in use.
- `tabs`, `tabGroups`: Open and list tabs for the agent, and group the agent's tabs so the user can see them.
- `storage`: Remember which tabs agents opened, the agent tab groups and window, and the pairing code the user entered.
- `alarms`: Keep the connection to the local OpenCode relay alive, reconnect, and close agent tabs left idle.
- `offscreen`, `tabCapture`: Record a tab when the user asks an agent for a screen recording.
- `scripting`: Add the extension's handoff card only to tabs agents use (not to every page), so the user can finish a login or payment step and hand the tab back.
- `webNavigation`: Notice when an agent's click opens a new tab or popup, so it moves into the agent's own window and group instead of the user's window, and closes with the agent's other tabs.
- `notifications`: Tell the user an agent needs them while it records a tab (a recording must not show the in-page card). Clicking the notification shows the tab. Used for nothing else.
- Host permission `<all_urls>`: Agents work on whatever site the user asks for, and the page shows a card when an agent waits for the user there.

**Remote code:** No. All extension code ships in the package.

**Data usage:** Check "Website content" and "User activity" (agents read and interact with pages). Certify: not sold, not used for unrelated purposes, not used for credit decisions. Data goes only to the OpenCode tools on the user's computer.

**Privacy policy URL:** host `privacy-policy.md` (for example at opencode.ai/browser/privacy).
