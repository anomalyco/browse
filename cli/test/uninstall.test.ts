import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import { createServer, type AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { freePort } from "./support/ports.ts"

// HOME does not isolate HKCU. Never run the real uninstaller over someone's legacy native-host registration.
const legacyHost = process.platform === "win32" && ["Google\\Chrome", "Microsoft\\Edge"].some(browser =>
  spawnSync("reg", ["query", `HKCU\\Software\\${browser}\\NativeMessagingHosts\\ai.opencode.browser`, "/ve"]).status === 0)

/**
 * A child environment built from scratch: a host OPENCODE_BROWSER_PACKAGE makes uninstall run `npm uninstall -g`, and host
 * agent config variables (CLAUDE_CONFIG_DIR, OPENCODE_CONFIG_DIR, ...) would point it at real agent configs. Only PATH and
 * the Windows essentials Bun needs come from the host.
 */
function isolatedEnv(home: string, port: number, browseHome = true): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, "local-appdata"),
    APPDATA: path.join(home, "appdata"),
    CHROME_CONFIG_HOME: path.join(home, "config"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "xdg-data"),
    XDG_STATE_HOME: path.join(home, "xdg-state"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    XDG_BIN_HOME: path.join(home, "xdg-bin"),
    CLAUDE_CONFIG_DIR: path.join(home, "claude"),
    OPENCODE_CONFIG_DIR: path.join(home, "opencode"),
    OPENCODE_BROWSER_PORT: String(port),
    OPENCODE_BROWSER_UPDATE_CHECK: "0",
  }
  if (browseHome) env.OPENCODE_BROWSER_HOME = path.join(home, "data")
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "ComSpec", "TEMP", "TMP"]) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
  }
  return env
}

async function runUninstall(home: string, port: number, args: string[] = [], browseHome = true) {
  const cli = [process.execPath, path.join(import.meta.dir, "../src/main.ts"), "uninstall", ...args]
  const child = Bun.spawn(cli, { env: isolatedEnv(home, port, browseHome), stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, stdout, stderr }
}

test.skipIf(legacyHost)("uninstall stops its managed relay before removing its data", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-uninstall-")), root = path.join(home, "data")
  const port = await freePort(), url = `http://127.0.0.1:${port}/version`
  const env = isolatedEnv(home, port)
  const cli = [process.execPath, path.join(import.meta.dir, "../src/main.ts")]
  const relay = Bun.spawn([...cli, "serve"], { env: { ...env, OPENCODE_BROWSER_MANAGED_RELAY: "1" }, stdout: "ignore", stderr: "ignore" })
  const ready = () => fetch(url).then(r => r.ok, () => false)
  try {
    for (let n = 0; n < 100 && !await ready(); n++) await Bun.sleep(50)
    expect(await ready()).toBe(true)
    const uninstall = Bun.spawn([...cli, "uninstall", "--yes"], { env, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([uninstall.exited, new Response(uninstall.stdout).text(), new Response(uninstall.stderr).text()])
    expect(code, stderr || stdout).toBe(0)
    expect(await ready()).toBe(false)
    expect(existsSync(root)).toBe(false)
  } finally {
    relay.kill(); await relay.exited
    rmSync(home, { recursive: true, force: true })
  }
}, 25_000)

// A reset before the relay is known to be stopping could be another program holding the port: fail closed and keep the data.
test.skipIf(legacyHost)("uninstall leaves data in place when the first relay probe connection is reset", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-uninstall-reset-")), root = path.join(home, "data")
  const resetting = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve) => resetting.listen(0, "127.0.0.1", resolve))
  const port = (resetting.address() as AddressInfo).port
  const audit = path.join(root, "relays", String(port), "lifecycle.jsonl")
  mkdirSync(path.dirname(audit), { recursive: true })
  writeFileSync(audit, `${JSON.stringify({ _tag: "Ready", instanceId: "reset-fixture" })}\n`)
  try {
    const result = await runUninstall(home, port, ["--yes"])
    expect(result.code, result.stderr || result.stdout).not.toBe(0)
    expect(existsSync(root)).toBe(true)
  } finally {
    await new Promise<void>((resolve) => resetting.close(() => resolve()))
    rmSync(home, { recursive: true, force: true })
  }
}, 25_000)

// After /shutdown a managed relay closes its sockets, so a reset /version is still stopping, not gone.
test.skipIf(legacyHost)("uninstall keeps polling while the stopping relay resets the probe", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-uninstall-stopping-")), root = path.join(home, "data")
  const instanceId = "stopping-fixture"
  let stopping = false, resets = 0, closed = false
  const relay = http.createServer((request, response) => {
    if (request.url === "/shutdown") {
      stopping = true
      response.end(JSON.stringify({ stopping: true }))
      return
    }
    if (stopping) {
      if (resets < 2) {
        resets++
        request.socket.destroy()
        return
      }
      closed = true
      relay.close()
      relay.closeAllConnections()
      request.socket.destroy()
      return
    }
    response.end(JSON.stringify({ version: "0.0.0", instanceId, managed: true, shutdownProtocol: 2 }))
  })
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
  const port = (relay.address() as AddressInfo).port
  const audit = path.join(root, "relays", String(port), "lifecycle.jsonl")
  mkdirSync(path.dirname(audit), { recursive: true })
  writeFileSync(audit, `${JSON.stringify({ _tag: "Ready", instanceId })}\n`)
  try {
    const result = await runUninstall(home, port, ["--yes"])
    expect(result.code, result.stderr || result.stdout).toBe(0)
    expect(existsSync(root)).toBe(false)
    expect(resets).toBeGreaterThan(0)
    expect(closed).toBe(true)
  } finally {
    if (relay.listening) await new Promise<void>((resolve) => relay.close(() => resolve()))
    rmSync(home, { recursive: true, force: true })
  }
}, 25_000)
