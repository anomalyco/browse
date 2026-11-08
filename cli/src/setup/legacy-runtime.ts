// Taking over the self-managed runtime of releases before 0.0.11 (setup/legacy.ts). Its shim, bin/opencode-browser.mjs,
// starts runtime/versions/<current.json version>/node_modules/@opencode/browse/dist/cli.mjs, and an agent's running
// shim swaps its MCP server once current.json names another version and the relay reports that version. A relay
// started from a current install (the npm global package or the binary) while that runtime is active takes it over: it
// writes a forwarder for its own version that runs the current install, and points current.json at it, so running
// agents follow it to the new MCP server. main.ts then drops the old folder as OPENCODE_BROWSER_HOME and migrates it
// (setup/migrate.ts), which rewrites agents' entries to `browse mcp` and removes the folder after a grace period.
import fs from "node:fs"
import path from "node:path"
import { channelOf, installedRuntime, type Runtime } from "../update/auto-update.ts"
import { insidePath, legacyRuntimeActive, type LegacyRuntime } from "./legacy.ts"

/** Marks a version folder this module wrote, so it is rewritten rather than mistaken for a real package. */
const FORWARDER = "// browse: this old runtime folder runs the current install"

/** The CLI file the old shim starts for `version`. */
export const legacyEntry = (root: string, version: string) =>
  path.join(root, "runtime", "versions", version, "node_modules", "@opencode", "browse", "dist", "cli.mjs")

/** Takes the old runtime over for `runtime` (this process's install). False when there is nothing to take over. */
export function adoptLegacyRuntime(legacy: LegacyRuntime | undefined, runtime = installedRuntime(), now = Date.now()): boolean {
  if (!legacy || !legacyRuntimeActive(legacy) || !runtime || runtime.kind === "npx" || insidePath(runtime.entry, legacy.root)) return false
  const entry = legacyEntry(legacy.root, runtime.version)
  // Another copy of this exact version already sits there: the shim runs the same build, so it only needs the record.
  if (!fs.existsSync(entry) || fs.readFileSync(entry, "utf8").includes(FORWARDER)) writeForwarder(entry, runtime)
  writeAtomic(path.join(legacy.root, "runtime", "current.json"), JSON.stringify({
    version: runtime.version,
    previous: legacy.version,
    channel: channelOf(runtime.version),
    switchedAt: new Date(now).toISOString(),
    movedTo: runtime.entry,
  }, null, 2) + "\n", 0o600)
  return true
}

/** A package folder whose CLI runs `runtime`: a script in this process, an executable as a child with the same stdio. */
function writeForwarder(entry: string, runtime: Runtime) {
  const packageDir = path.dirname(path.dirname(entry))
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  writeAtomic(path.join(packageDir, "package.json"), JSON.stringify({ name: "@opencode/browse", version: runtime.version, private: true }) + "\n")
  const target = JSON.stringify(runtime.entry)
  const run = runtime.kind === "binary"
    ? [
        `import { spawn } from "node:child_process"`,
        `const child = spawn(${target}, process.argv.slice(2), { stdio: "inherit" })`,
        `for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal))`,
        `child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })`,
      ]
    : [`import { pathToFileURL } from "node:url"`, `process.argv[1] = ${target}`, `await import(pathToFileURL(${target}).href)`]
  writeAtomic(entry, ["#!/usr/bin/env node", `${FORWARDER} (${runtime.kind}). Don't edit.`, ...run, ""].join("\n"))
}

function writeAtomic(file: string, text: string, mode = 0o644) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, text, { mode })
  fs.renameSync(temporary, file)
}
