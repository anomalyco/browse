#!/usr/bin/env node
// opencode-browser: one command for Browse.
//   Setup (setup.ts): install, extension, pair, uninstall. Updating (update.ts): update.
//   Driving the browser (cli.ts): serve, relay, execute, session, network, secrets, recording, journal,
//   doctor, skill, mcp, status. The relay is the local server agents use; the extension connects to it.
// `opencode-browser mcp` runs the MCP server over stdio (as does the bundle invoked as `opencode-browser-mcp`).
import path from "node:path"

const setupCommands = new Set(["install", "uninstall", "extension", "pair", "rollback"])
const command = process.argv[2]
const invokedAs = path.basename(process.argv[1] ?? "")

if (command === "--version" || command === "-v") {
  const { opencodeBrowserVersion } = await import("./version.ts")
  process.stdout.write(`${opencodeBrowserVersion}\n`)
} else if (invokedAs === "opencode-browser-mcp") {
  const { NodeRuntime } = await import("@effect/platform-node")
  const { runMcpServer } = await import("./mcp.ts")
  runMcpServer.pipe(NodeRuntime.runMain)
} else if (command === "runtime-install" || command === "runtime-switch") {
  // The relay's auto-update children (auto-update.ts); not for people.
  const { runRuntimeInstall, runRuntimeSwitch } = await import("./runtime-update.ts")
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
  install [--opencode <path>]    Install Browse: add the browse MCP server to opencode, pair
                                 the extension, and check which browsers have it (when none does, open
                                 the extensions page, show the folder to load unpacked and wait for it)
    --no-open                    Print the steps without opening anything or copying the path
    --no-wait                    Don't wait for the extension to connect
  extension                      Show the unpacked extension folder (for "Load unpacked")
  pair                           Print the pairing code the Chrome Web Store extension asks for
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
  await import("./cli.ts")
}
