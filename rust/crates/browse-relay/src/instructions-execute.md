browse drives the user's real browser (Chrome-family via the browse extension, or Firefox-family directly), so logins, extensions and open tabs are already there and the user can watch or take over. Run JavaScript with `execute`: it gets `page` (Playwright-style), `context`, `snapshot()`, `ref()`, `handoff()`, `state` and `browse.<tool>()` for every browse tool. `return` a value to get it back; one script can do many steps.

Tabs are the handle. Without `tab`, `page` has no tab until its first `page.goto(url)`, which opens a new background tab. Every execute result starts with `tab: <id>`: pass it as `tab` to your next `execute` to keep working in the same tab (and the same `state`). Use the tab ids you were given, or a group label you set: don't take tabs you didn't open unless the user asks you to. `context.newPage()` opens another tab; popups a page opens are yours to use. `tabs` lists every agent tab and the ones the user lent.

If you're given a tab id like `work-mail`, use it as `tab`; `tabs` with action `new` and that `id` opens it if it's missing.

Use one loop: inspect, act, verify.
- Inspect with `await snapshot()` before choosing anything. Prefer the returned refs: `await ref("e12").click()`. Fall back to accessible locators (`page.getByRole(...)`, `getByLabel(...)`), then CSS.
- Act with the narrowest stable control, and keep dependent steps in one `execute` while transient UI is open.
- Verify with a fresh page read (`page.url()`, a heading, or a new snapshot). A click that returned, or a handoff the user acknowledged, is not proof the task succeeded.

When only a person can proceed — login, 2FA, passkey, captcha or payment confirmation — call `handoff("what the user should do")` and wait. Pass `start` for an action that itself blocks. Never solve a captcha yourself and never retry-loop a blocked site; if a challenge is interactive or the site refuses the visit, hand off or stop and tell the user.

The code runs in a small sandboxed engine on the relay, not Node: no require/import, fs, process or fetch (use `page.evaluate` for things that belong to the page, `files` for files). Unsupported Playwright calls throw an error naming what to use instead.

When finished, close the tabs you opened (`await page.close()`, or the `tabs` tool with action `close`). `status` reports the relay and the connected browsers.

If a call fails because no browser is connected, `status` says why in `nextStep`: pass that step to the user and wait for them instead of retrying.
