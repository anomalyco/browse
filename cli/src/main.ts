#!/usr/bin/env node
// opencode-browser: one command for Browse.
//   Setup (setup.ts): install, extension, pair, uninstall. Updating (update.ts): update.
//   Driving the browser (cli.ts): serve, relay, execute, session, network, secrets, recording, journal,
//   doctor, skill, mcp, status. The relay is the local server agents use; the extension connects to it.
// `opencode-browser mcp` runs the MCP server over stdio (as does the bundle invoked as `opencode-browser-mcp`).
import path from "node:path"

const embeddedVersion = globalThis.__OPENCODE_BROWSER_VERSION__
const setupCommands = new Set(["install", "uninstall", "extension", "pair", "rollback", "set"])
const command = process.argv[2]
const invokedAs = path.basename(process.argv[1] ?? "")

if (command === "--version" || command === "-v") {
  const opencodeBrowserVersion = embeddedVersion ?? (await import("./version.ts")).opencodeBrowserVersion
  process.stdout.write(`${opencodeBrowserVersion}\n`)
} else if (invokedAs === "opencode-browser-mcp" || (command === "mcp" && process.argv.length === 3)) {
  const { NodeRuntime } = await import("@effect/platform-node")
  const { runMcpServer } = await import("./mcp.ts")
  runMcpServer.pipe(NodeRuntime.runMain)
} else if (command === "runtime-install" || command === "runtime-switch") {
  // The relay's auto-update children (auto-update.ts); not for people.
  const { runRuntimeInstall, runRuntimeSwitch } = await import("./update/runtime-update.ts")
  await (command === "runtime-install" ? runRuntimeInstall : runRuntimeSwitch)(process.argv.slice(3))
} else if (command === "update") {
  const { runUpdateCommand } = await import("./update.ts")
  await runUpdateCommand(process.argv.slice(3))
} else if (command && setupCommands.has(command)) {
  const { runSetup } = await import("./setup.ts")
  await runSetup(command, process.argv.slice(3))
} else {
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`SETUP
  install [--opencode <path>]    Install Browse: choose agents for the browse MCP server, check which browsers
                                 have the extension and pair it (when none does, open its Chrome Web Store
                                 page, or from a checkout or a dev install show the folder to load unpacked,
                                 and wait for it)
    --no-open                    Print the steps without opening anything or copying the path
    --no-wait                    Don't wait for the extension to be added or connect
    --wait-seconds <seconds>     How long to wait for a connection (default 180 in a terminal, 90 otherwise)
    -a, --agent <names...>       Configure named agents (repeatable); '*' or --all-agents selects every supported agent
    -y, --yes                    Skip the picker; use the calling agent or detected agents
  extension                      Show where to get the extension (the unpacked folder of a checkout or a dev
                                 install, or the store page)
  pair [--wait-seconds <seconds>] Start the relay, print a one-time code (valid 10 minutes) and wait for the
                                 browser that redeems it (default 180 seconds)
    --list                       Show paired browsers: id, name, profile, when paired and last seen
    --revoke <browser>           Unpair a browser (its id, name or profile) and disconnect it;
                                 \`--revoke legacy\` retires the shared code of earlier versions
  set hostname <address>         Where the relay listens: 127.0.0.1 (this computer, the default) or 0.0.0.0
                                 (browsers on other computers can connect too, after pairing)
  update [--check]               Update now. A git clone install pulls the newer commits (fast-forward only)
                                 and runs setup again; an npm install installs the newest version on its
                                 channel and switches to it; --check only says whether there's an update
  rollback [--force]             npm installs: go back to the version before the last update (and skip
                                 the one rolled back from until a newer one is published)
  uninstall [--yes]              Remove everything install set up (--yes skips confirming that stored
                                 secret profiles are deleted)

`)
  }
  if (command === "status" && !process.argv.includes("--json")) {
    const { printSetupStatus } = await import("./setup.ts")
    printSetupStatus()
  }
  const { runCli } = await import("./cli.ts")
  runCli()
}
