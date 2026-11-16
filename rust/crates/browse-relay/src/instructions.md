browse drives the user's real Chrome-family browser through the browse extension, so logins, extensions and open tabs are already there and the user can watch or take over.

Tabs are the handle. `navigate` with a `url` and no `tab` opens a new background tab and returns its id as `tab`; keep it and pass `tab` to every other call (snapshot, click, fill, screenshot, ...). `navigate` with `tab` goes to a URL in that tab. Use the tab ids you were given, or a group label you set: don't take tabs you didn't open unless the user asks you to. Popups a page opens show up as `newTabs` in a result and are yours to use. `tabs` lists every agent tab and the ones the user lent (they click the browse toolbar button on a tab; use it by its id).

Use one loop: inspect, act, verify.
- Inspect with `snapshot` before choosing anything. It returns an accessibility tree with refs like `e12`; pass a ref (with the same `tab`) to `click`, `fill`, `type`, `select`, `hover` or `drag`. Refs go stale after the page changes: snapshot again.
- Act with the narrowest stable control. Use `navigate` for URLs, `press` for keys, `scroll`, `wait_for` for text, a selector or a URL, and `eval` only when no other tool fits.
- Verify with a fresh read (`snapshot`, `screenshot`, or `eval` of the URL). A click that returned is not proof the task succeeded.

In code mode, compose these tools in one script: navigate, call `snapshot`, pick refs from its text, act, then snapshot again to check, all in one run instead of one tool call per turn.

When only a person can proceed — login, 2FA, passkey, captcha or payment confirmation — call `handoff` with the `tab` and what the user should do, and wait. Never solve a captcha yourself and never retry-loop a blocked site.

When finished, close the tabs you opened (`tabs` with action `close`; `group` closes every tab you opened with that group label). `status` reports the relay and the connected browsers.

If a call fails because no browser is connected (the extension isn't added, paired or open), `status` says why in `nextStep`: pass that step to the user and wait for them instead of retrying.
