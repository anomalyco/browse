# OpenCode Browser privacy policy

_Last updated: October 28, 2026_

OpenCode Browser is a browser extension that lets OpenCode, running on your own computer, use your browser. This policy explains what it handles and where that goes.

## What the extension handles
- **Page content, screenshots, network traffic, and actions** in tabs an agent opened, or tabs you let agents use with the toolbar button.
- **Recordings** of a tab, when you ask an agent for one.
- Which tabs agents opened, kept in your browser's extension storage so idle ones can be closed.
- The pairing code you enter on the status page (or that the installer put in the extension's folder), kept in extension storage. It never leaves your computer.
- A system notification, shown only when an agent needs you while it records a tab.
- **Site secrets** you choose to store with the `opencode-browser secrets add` command (a password, key or one-time-code seed, and the sites it may be typed on). They stay in a file on your computer that only your user account can read, and are typed only into fields on those sites. The extension never stores them; they are never sent anywhere except into the page you allowed, and your agent never receives them.

## Where it goes
- To **the OpenCode tools on your computer**, over a local connection (127.0.0.1). The extension only obeys a local relay that proves it knows your pairing code, and the relay only answers programs that hold its token, a file only your user account can read.
- OpenCode may send it to the AI model provider **you** configured in OpenCode, under that provider's terms. The extension itself doesn't choose or contact any provider.

Anomaly, the maker of OpenCode, doesn't run a server for this extension and doesn't receive, sell, or share your data. There's no analytics or tracking.

## Your choices
- Agents can't use your tabs unless you click the toolbar button on them. Click again to take a tab back.
- Remove the extension and run `npx @opencode/browse uninstall` (`node cli/dist/cli.mjs uninstall` from a checkout) to delete everything it set up.

## Contact
Questions: open an issue at https://github.com/anomalyco/browse.
