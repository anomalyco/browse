#!/usr/bin/env node
// The `browse` command of the npm package @opencode/browse: finds the native browse binary npm installed for this
// computer (the optional dependency @opencode/browse-<target>) and runs it with the same arguments, stdio and exit
// code. Shipped as dist/cli.mjs, the path installs of the TypeScript CLI wrote into agent configs
// (`node .../dist/cli.mjs mcp`), so those keep working after `npm install -g` moves them to this package.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)
const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform]
// Windows on ARM64 runs the x64 build.
const arch = process.platform === "win32" ? "x64" : { x64: "x64", arm64: "arm64" }[process.arch]

function musl() {
  if (process.platform !== "linux") return false
  try {
    return !process.report.getReport().header.glibcVersionRuntime
  } catch {
    return existsSync("/etc/alpine-release")
  }
}

function binary() {
  if (!os || !arch) return undefined
  const executable = os === "windows" ? "browse.exe" : "browse"
  const base = `@opencode/browse-${os}-${arch}`
  // The libc npm picked may not be the one detected (npm before 10.4 ignores `libc`), so the other is a fallback.
  const names = os === "linux" ? (musl() ? [`${base}-musl`, base] : [base, `${base}-musl`]) : [base]
  for (const name of names) {
    try {
      const file = path.join(path.dirname(require.resolve(`${name}/package.json`)), "bin", executable)
      if (existsSync(file)) return file
    } catch {}
  }
  return undefined
}

const file = binary()
if (!file) {
  console.error(
    `browse: no browse binary for ${process.platform}-${process.arch} is installed. Reinstall without --omit=optional ` +
      "or --no-optional, or install the binary instead: curl -fsSL https://opencode.ai/browse/install | bash",
  )
  process.exit(1)
}

const child = spawn(file, process.argv.slice(2), { stdio: "inherit", windowsHide: true })
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  })
}
child.on("error", (error) => {
  console.error(`browse: couldn't start ${file}: ${error.message}`)
  process.exit(1)
})
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
