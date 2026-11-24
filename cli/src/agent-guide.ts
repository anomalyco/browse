/**
 * The agent guide, in one place: the MCP server's initialize instructions and `browse --help` use the same sentences,
 * so the two cannot drift. Keep the help version short and indented for a terminal.
 */
export const whatBrowseIs = `browse drives the user's real Chrome-family browser through the browse extension, so logins, extensions and open tabs are already there and the user can watch or take over.`

export const inspectActVerify = `Use one loop: inspect, act, verify.
- Inspect with \`await snapshot()\` before choosing anything. Prefer the returned refs: \`await ref("e12").click()\`. Fall back to accessible locators (\`page.getByRole(...)\`, \`getByLabel(...)\`), then CSS.
- Act with the narrowest stable control, and keep dependent steps in one \`execute\` while transient UI is open.
- Verify with a fresh page read (\`page.url()\`, a heading, or a new snapshot). A click that returned, or a handoff the user acknowledged, is not proof the task succeeded.`

export const handoffAdvice = `When only a person can proceed — login, 2FA, passkey or payment confirmation — call \`handoff("what the user should do")\` and wait. Pass \`start\` for an action that itself blocks. For a captcha or interactive challenge, try solving it first on the user's behalf, and hand it off if it doesn't clear. Never retry-loop a blocked site; if the site refuses the visit, stop and tell the user.`

export const sessionAdvice = `Each agent has its own current session when the client names the agent (OpenCode does), so bare calls don't land on another agent's page. When the client doesn't name agents, \`status\` reports \`sharedSession: true\` and all agents on this server share one current session, so when several (such as subagents) use it each should \`session_new\` its own and pass \`session\` on every call. When finished, \`session_reset\` (or \`session_delete\`) your own session; keep a session only when follow-up work is expected.`

/** The `browse --help` version of the guide: what browse is, one script, the loop, handoff, and cleanup. */
export const agentHelp = `AGENT GUIDE
  browse drives the user's real Chrome-family browser through the browse extension, so logins,
  extensions and open tabs are already there and the user can watch or take over. Agents normally
  use the MCP server (\`browse mcp\`); the same loop works from a terminal.

  Write one Playwright script to a file and run it:
    browse execute --file script.js
  It receives browser, context, page, state, snapshot(), ref() and handoff(). \`return\` a value to
  get it back.

  Inspect, act, verify:
  - \`await snapshot()\` before choosing anything; click the returned refs (\`await ref("e12").click()\`).
  - Fall back to accessible locators (\`page.getByRole(...)\`), then CSS.
  - Keep dependent steps in one script while transient UI is open.
  - Verify with a fresh page read (\`page.url()\`, a heading, a new snapshot); a click that returned
    proves nothing.

  When only a person can proceed (login, 2FA, passkey, payment), call
  \`handoff("what to do")\` and wait. For a captcha, try solving it first and hand off if it doesn't clear.

  Pass \`--session\` to keep one session across calls. \`browse session reset\` or \`browse session delete\`
  it when done; keep a session only for follow-up work.`
