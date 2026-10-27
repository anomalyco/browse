#!/usr/bin/env node
// opencode-browser: one command for OpenCode Browser.
//   Setup (setup.ts): install, extension, pair, uninstall.
//   Driving the browser (cli.ts): serve, relay, execute, session, network, secrets, recording, journal,
//   doctor, skill, mcp, status. The relay is the local server agents use; the extension connects to it.
// `opencode-browser mcp` runs the MCP server over stdio (as does the bundle invoked as `opencode-browser-mcp`).
import path from "node:path"

const setupCommands = new Set(["install", "uninstall", "extension", "pair"])
const command = process.argv[2]
const invokedAs = path.basename(process.argv[1] ?? "")

if (invokedAs === "opencode-browser-mcp") {
  const { NodeRuntime } = await import("@effect/platform-node")
  const { runMcpServer } = await import("./mcp.ts")
  runMcpServer.pipe(NodeRuntime.runMain)
} else if (command && setupCommands.has(command)) {
  const { runSetup } = await import("./setup.ts")
  await runSetup(command, process.argv.slice(3))
} else {
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`SETUP
  install [--opencode <path>]    Install OpenCode Browser: add the browse MCP server to opencode, pair
                                 the extension, and check which browsers have it (when none does, open
                                 the extensions page, show the folder to load unpacked and wait for it)
    --no-open                    Print the steps without opening anything or copying the path
    --no-wait                    Don't wait for the extension to connect
  extension                      Show the unpacked extension folder (for "Load unpacked")
  pair                           Print the pairing code the Chrome Web Store extension asks for
  uninstall [--yes]              Remove everything install set up (--yes skips confirming that stored
                                 secret profiles are deleted)

`)
  }
  if (command === "status") {
    const { printSetupStatus } = await import("./setup.ts")
    printSetupStatus()
  }
  await import("./cli.ts")
}
