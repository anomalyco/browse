browse controls the user's real browser (Chrome-family through the browse extension, or Firefox-family directly). Logins, extensions and open tabs are real, and the user can watch or take over.

- `navigate` with a `url` and no `tab` opens a background tab and returns its id as `tab`. Pass that `tab` to every other tool. `navigate` with `tab` loads a URL in that tab.
- Use only tabs you opened, tabs you were given (an id, or a name like `work-mail`), and tabs the user lent (`tabs` lists them). Popups a page opens arrive as `newTabs` and are yours.
- Call `snapshot` before acting. Act on its refs (like `e12`) with `click`, `fill`, `type`, `select`, `hover` or `drag`. Refs expire when the page changes: snapshot again.
- Use the most specific tool: `navigate` for URLs, `press` for keys, `scroll`, `wait_for`. Use `eval` only when nothing else fits.
- Verify each step with a fresh `snapshot`, `screenshot` or `eval`. A click that returned is not proof.
- In code mode, run navigate, snapshot, act and snapshot in one script.
- Logins, 2FA, passkeys, captchas and payment confirmations are for the user: call `handoff` with the `tab` and what to do, and wait. Never solve a captcha. Never retry a blocked site in a loop.
- When finished, close the tabs you opened: `tabs` with action `close` and the `tab`, or a `group`.
- If no browser is connected, `status` explains why in `nextStep`. Tell the user and wait.
