#!/usr/bin/env node
// browse: one command for setup, updates and driving the browser.
//   Setup (setup.ts): install, extension, pair, uninstall. Updating (update.ts): update.
//   Driving the browser (cli.ts): serve, relay, execute, session, network, recording, journal,
//   doctor, skill, mcp, status. The relay is the local server agents use; the extension connects to it.
// `browse mcp` runs the MCP server over stdio (as does the bundle invoked as `opencode-browser-mcp`).
import path from "node:path"
import { legacyRootsLeft, legacyRuntime, legacyRuntimeActive, settleLegacyHome } from "./setup/legacy.ts"

const embeddedVersion = globalThis.__OPENCODE_BROWSER_VERSION__
const setupCommands = new Set(["install", "uninstall", "extension", "pair", "set"])
const command = process.argv[2]
const args = process.argv.slice(3)
const invokedAs = path.basename(process.argv[1] ?? "")
// Setup commands and update run before the Effect CLI parses arguments (below), so they would act on --help instead of
// printing it. This mirrors the help check in cli.ts's quiet-JSON handling, but stops at `--`: everything after it belongs
// to another program, so it is not a help request for browse.
const separator = args.indexOf("--")
const options = separator === -1 ? args : args.slice(0, separator)
const askedForHelp = command === "--help" || command === "-h" || options.some((arg) => arg === "--help" || arg === "-h")
/** Help for a command that never reaches the Effect CLI: print the top-level help instead. */
const preCliHelp = askedForHelp && (command === "update" || (command !== undefined && setupCommands.has(command)))

// The old self-managed runtime (setup/legacy.ts): a relay started from this install takes it over once it owns the port
// (setup/legacy-runtime.ts). Every other process shares its folder while it's active, and stops treating that folder as
// OPENCODE_BROWSER_HOME once it's taken over.
const oldRuntime = legacyRuntime()
const takingOver = command === "serve" && !askedForHelp && legacyRuntimeActive(oldRuntime) &&
  (await import("./setup/legacy-runtime.ts").then((module) => module.prepareLegacyTakeover(oldRuntime)).catch(() => false))
if (!takingOver) settleLegacyHome(process.env, oldRuntime)

// Credentials left by removed features (site secrets, captured secret profiles) are deleted on every start.
if (command !== "--version" && command !== "-v" && !askedForHelp && !takingOver) {
  const { removeStoredSecrets } = await import("./setup/remove-stored-secrets.ts")
  removeStoredSecrets()
}

// Earlier layouts (~/.browse, and the old opencode-browser data root) move to the XDG folders on the first run.
// opencode briefly shows the update, and no other command pays for the import.
// A takeover migrates once its relay owns the port.
if (command !== "--version" && command !== "-v" && !askedForHelp && !takingOver && !process.env.OPENCODE_BROWSER_HOME && legacyRootsLeft()) {
  try {
    const { migrateLegacy } = await import("./setup/migrate.ts")
    migrateLegacy()
  } catch {
    // Migration must never stop browse from starting; the next run tries again.
  }
}

if (command === "--version" || command === "-v") {
  const opencodeBrowserVersion = embeddedVersion ?? (await import("./version.ts")).opencodeBrowserVersion
  process.stdout.write(`${opencodeBrowserVersion}\n`)
} else if (command === "mcp" && process.env.OPENCODE_BROWSER_MCP_DIRECT !== "1" && (await import("./mcp/supervisor.ts")).supervisesMcp()) {
  // An installed binary or npm global package: supervise the server so updates swap it (mcp/supervisor.ts).
  const { runBinaryMcp } = await import("./mcp/supervisor.ts")
  await runBinaryMcp(process.argv.slice(3))
} else if (invokedAs === "opencode-browser-mcp" || (command === "mcp" && process.argv.length === 3)) {
  const { NodeRuntime } = await import("@effect/platform-node")
  const { defaultTeardown } = await import("effect/Runtime")
  const { runMcpServer } = await import("./mcp.ts")
  // An MCP client shuts a stdio server down by closing its stdin. A 2026-07-28 client's open `subscriptions/listen`
  // keeps the RPC server from ending on its own, so mcp.ts interrupts it once stdin closes and the tool calls still
  // running have answered. The default teardown reads an interrupt-only exit as 130, SIGINT's code; that EOF is a clean
  // shutdown here, so exit 0 instead. A real SIGINT or SIGTERM still exits 130. `process.exit` doesn't wait for a
  // background update check's git calls that would otherwise hold the event loop open.
  let stdinGone = false
  const onStdinGone = () => {
    stdinGone = true
  }
  process.stdin.once("end", onStdinGone)
  process.stdin.once("close", onStdinGone)
  process.stdin.once("error", onStdinGone)
  let signalled = false
  const onSignal = () => {
    signalled = true
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  runMcpServer.pipe(NodeRuntime.runMain({
    teardown: (exit, onExit) =>
      defaultTeardown(exit, (code) => {
        if (stdinGone && !signalled && code === 130) return process.exit(0)
        onExit(code)
      }),
  }))
} else if (command === "self-update" || command === "runtime-switch") {
  // The relay's auto-update children (auto-update.ts); not for people.
  const { runSelfUpdate, runRuntimeSwitch } = await import("./update/runtime-update.ts")
  await (command === "self-update" ? runSelfUpdate : runRuntimeSwitch)(process.argv.slice(3))
} else if (command === "update" && !askedForHelp) {
  const { runUpdateCommand } = await import("./update.ts")
  await runUpdateCommand(process.argv.slice(3))
} else if (command && setupCommands.has(command) && !askedForHelp) {
  const { runSetup } = await import("./setup.ts")
  await runSetup(command, process.argv.slice(3))
} else {
  if (preCliHelp || !command || command === "--help" || command === "-h") {
    process.stdout.write(`SETUP
  install [--opencode <path>]    Install browse: choose agents for the browse MCP server, check which browsers
                                 have the extension and pair it (when none does, say to add it from the Chrome
                                 Web Store, open its page, and wait for it)
    --remote                     For a browser on another computer: open the relay to other computers and print
                                 its address and a one-time pairing code instead of pairing a browser here
    --no-open                    Print the steps without opening anything
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
  update [--check]               Update now: rerun whatever installed browse (the install script for a binary
                                 install, npm install -g for an npm one); --check only says whether there's an
                                 update. A git clone pulls the newer commits and runs setup again.
  uninstall                      Remove everything install set up

browse keeps its files in $XDG_CONFIG_HOME/browse, $XDG_DATA_HOME/browse, $XDG_STATE_HOME/browse and
$XDG_CACHE_HOME/browse (defaults under ~/.config, ~/.local/share, ~/.local/state and ~/.cache), and the
executable in ~/.local/bin (or $XDG_BIN_HOME).

`)
  }
  if (command === "status" && !askedForHelp && !process.argv.includes("--json")) {
    const { printSetupStatus } = await import("./setup.ts")
    printSetupStatus()
  }
  const { runCli } = await import("./cli.ts")
  runCli(preCliHelp ? ["--help"] : undefined)
}
