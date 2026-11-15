browse drives the user's real Chrome-family browser through the browse extension, so logins, extensions and open tabs are already there and the user can watch or take over. Run JavaScript with `execute`: it gets `page` (Playwright-style, for your session's current tab), `context`, `snapshot()`, `ref()`, `handoff()`, `state` and `browse.<tool>()` for every browse tool. `return` a value to get it back; one script can do many steps.

Use one loop: inspect, act, verify.
- Inspect with `await snapshot()` before choosing anything. Prefer the returned refs: `await ref("e12").click()`. Fall back to accessible locators (`page.getByRole(...)`, `getByLabel(...)`), then CSS.
- Act with the narrowest stable control, and keep dependent steps in one `execute` while transient UI is open.
- Verify with a fresh page read (`page.url()`, a heading, or a new snapshot). A click that returned, or a handoff the user acknowledged, is not proof the task succeeded.

When only a person can proceed — login, 2FA, passkey, captcha or payment confirmation — call `handoff("what the user should do")` and wait. Pass `start` for an action that itself blocks. Never solve a captcha yourself and never retry-loop a blocked site; if a challenge is interactive or the site refuses the visit, hand off or stop and tell the user.

The code runs in a small sandboxed engine on the relay, not Node: no require/import, fs, process or fetch (use `page.evaluate` for things that belong to the page, `files` for files). Unsupported Playwright calls throw an error naming what to use instead.

All agents on this server share one current session, so subagents should each create their own with `session` (action `new`) and pass its id as `session` to every `execute`. When finished, close the tabs you opened (`page.close()`) or reset your session; keep a session only when follow-up work is expected. `status` reports the relay, the connected browsers and your session.
