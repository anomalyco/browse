import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import WebSocket from "ws"
import { bundleCli } from "../bundle.ts"
import { processAlive, readCurrent, readState, runtimeLayout, versionEntry, writeCurrent, writeShim, type Layout } from "../src/auto-update.ts"
import { relayToken } from "../src/relay-secrets.ts"

// An npm install's runtime in a temporary data root, with two real versions of this CLI (bundled from source as 0.0.1
// and 0.0.2), a relay running 0.0.1, and a fake registry whose tarball download never finishes. Node runs the relay, as
// in a real install. No browser.

const cliRoot = path.resolve(import.meta.dir, "..")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-autoupdate-it-"))
const layout = runtimeLayout(root)
const node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim() || "node"
let relayPort = 0
let registry: ReturnType<typeof Bun.serve> | undefined
let relay: ChildProcess | undefined
const started: number[] = []

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** One installed version: the bundle, its package.json, and the CLI's dependencies linked beside it. */
async function installFake(target: Layout, version: string) {
  const entry = versionEntry(target, version)
  await bundleCli({ outdir: path.dirname(entry), version })
  fs.writeFileSync(path.join(path.dirname(path.dirname(entry)), "package.json"), JSON.stringify({ name: "@opencode/browse", version, type: "module" }))
  const modules = path.join(target.versions, version, "node_modules")
  for (const name of fs.readdirSync(path.join(cliRoot, "node_modules"))) {
    if (name.startsWith(".") || name === "@opencode") continue
    fs.symlinkSync(path.join(cliRoot, "node_modules", name), path.join(modules, name), "dir")
  }
}

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  HOME: root,
  OPENCODE_BROWSER_HOME: root,
  OPENCODE_BROWSER_PORT: String(relayPort),
  OPENCODE_BROWSER_UPDATE_CHECK: "",
  OPENCODE_BROWSER_NPM_REGISTRY: `http://127.0.0.1:${registry!.port}`,
  npm_config_cache: path.join(root, "npm-cache"),
  ...extra,
})

const version = async () => (await fetch(`http://127.0.0.1:${relayPort}/version`, { signal: AbortSignal.timeout(2_000) }).then((response) => response.json())) as { version: string; pid: number }

async function until<T>(check: () => T | Promise<T>, timeoutMs: number): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await Promise.resolve(check()).catch(() => undefined)
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(100)
  }
}

function cdp(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/devtools/browser/test`, { headers: { authorization: `Bearer ${relayToken(root)}` } })
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
  })
}

function cdpCall(socket: WebSocket, id: number, method: string) {
  return new Promise<{ result?: Record<string, unknown> }>((resolve) => {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as { id?: number }
      if (message.id === id) resolve(message as { result?: Record<string, unknown> })
    })
    socket.send(JSON.stringify({ id, method }))
  })
}

beforeAll(async () => {
  relayPort = await freePort()
  // The registry offers 0.0.3, and its tarball never arrives: the install stays in progress.
  registry = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.includes("/-/")) return new Promise<Response>(() => {})
      return Response.json({
        name: "@opencode/browse",
        "dist-tags": { latest: "0.0.3" },
        versions: { "0.0.3": { name: "@opencode/browse", version: "0.0.3", dist: { tarball: `http://127.0.0.1:${registry!.port}/@opencode/browse/-/browse-0.0.3.tgz`, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` } } },
      })
    },
  })
  await installFake(layout, "0.0.1")
  await installFake(layout, "0.0.2")
  writeCurrent(layout, { version: "0.0.1", channel: "latest" })
  writeShim(layout)
  relay = spawn(node, [versionEntry(layout, "0.0.1"), "serve"], {
    env: env({ OPENCODE_BROWSER_MANAGED_RELAY: "1", OPENCODE_BROWSER_AUTO_UPDATE_TICK_MS: "200", OPENCODE_BROWSER_AUTO_UPDATE_INTERVAL_MS: "600000" }),
    stdio: "ignore",
  })
  await until(() => version().then((answer) => answer.version === "0.0.1"), 20_000)
}, 60_000)

afterAll(async () => {
  const installing = readState(layout).installing
  if (installing && processAlive(installing.pid)) process.kill(-installing.pid, "SIGKILL")
  for (const pid of started) if (processAlive(pid)) process.kill(pid, "SIGKILL")
  relay?.kill("SIGKILL")
  await registry?.stop(true)
  await Bun.sleep(200)
  fs.rmSync(root, { recursive: true, force: true })
})

describe("auto-update in a running relay", () => {
  test("installs in its own process: the relay keeps answering /version and CDP meanwhile", async () => {
    const installing = await until(() => {
      const state = readState(layout).installing
      return state && processAlive(state.pid) ? state : undefined
    }, 15_000)
    expect(installing.version).toBe("0.0.3")
    expect(installing.pid).not.toBe(relay!.pid)
    // npm is stuck on the tarball, and the relay still answers at once, several times over.
    for (let round = 0; round < 5; round++) {
      const before = performance.now()
      expect((await version()).version).toBe("0.0.1")
      expect(performance.now() - before).toBeLessThan(500)
      const socket = await cdp()
      const call = performance.now()
      const answer = await cdpCall(socket, 1, "Browser.getVersion")
      expect(performance.now() - call).toBeLessThan(500)
      expect(answer.result?.protocolVersion).toBeDefined()
      socket.close()
      await Bun.sleep(200)
    }
    expect(processAlive(installing.pid)).toBe(true)
    expect(readState(layout).pending).toBeUndefined()
  }, 30_000)

  test("a refused switch changes nothing; once allowed, the relay restarts as the new version and then current.json moves", async () => {
    // A raw CDP client keeps the relay busy, so it refuses to drain.
    const busy = await cdp()
    const refused = spawnSync(node, [versionEntry(layout, "0.0.1"), "runtime-switch", "0.0.2"], { env: env(), encoding: "utf8", timeout: 60_000 })
    expect(refused.status).toBe(1)
    expect(refused.stdout).toContain("refused")
    expect(readCurrent(layout)?.version).toBe("0.0.1")
    expect((await version()).version).toBe("0.0.1")
    busy.close()
    await Bun.sleep(300)
    const allowed = spawnSync(node, [versionEntry(layout, "0.0.1"), "runtime-switch", "0.0.2"], { env: env(), encoding: "utf8", timeout: 60_000 })
    expect(allowed.status).toBe(0)
    const now = await version()
    started.push(now.pid)
    expect(now.version).toBe("0.0.2")
    expect(readCurrent(layout)).toMatchObject({ version: "0.0.2", previous: "0.0.1" })
  }, 90_000)
})

describe("the shim's MCP supervisor", () => {
  // Stub MCP servers: each answers initialize, and `whoami` with its version and the identity the shim gave it.
  const stub = (stubVersion: string) => `
import { createInterface } from "node:readline"
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const result = message.method === "initialize"
    ? { capabilities: { tools: { listChanged: true } }, serverInfo: { name: "browse", version: ${JSON.stringify(stubVersion)} } }
    : { version: ${JSON.stringify(stubVersion)}, session: process.env.OPENCODE_BROWSER_MCP_SESSION, clientPid: process.env.OPENCODE_BROWSER_CLIENT_PID, ppid: String(process.ppid) }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n")
})
`

  test("swaps to a new version only once the relay runs it, keeping the session identity", async () => {
    const shimRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browse-shim-it-"))
    const shimLayout = runtimeLayout(shimRoot)
    for (const stubVersion of ["9.0.1", "9.0.2"]) {
      fs.mkdirSync(path.dirname(versionEntry(shimLayout, stubVersion)), { recursive: true })
      fs.writeFileSync(versionEntry(shimLayout, stubVersion), stub(stubVersion))
    }
    writeCurrent(shimLayout, { version: "9.0.1", channel: "latest" })
    writeShim(shimLayout)
    // A stand-in relay whose /version says what the test wants.
    let relayVersion = "9.0.1"
    const fakeRelay = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ version: relayVersion }) })
    const shim = spawn(node, [shimLayout.shim, "mcp"], { env: { PATH: process.env.PATH ?? "", OPENCODE_BROWSER_HOME: shimRoot, OPENCODE_BROWSER_PORT: String(fakeRelay.port) }, stdio: ["pipe", "pipe", "inherit"] })
    const answers = new Map<number, Record<string, string>>()
    const notifications: string[] = []
    createInterface({ input: shim.stdout! }).on("line", (line) => {
      const message = JSON.parse(line) as { id?: number; method?: string; result?: Record<string, string> }
      if (message.id !== undefined) answers.set(message.id, message.result ?? {})
      else if (message.method) notifications.push(message.method)
    })
    let id = 0
    const call = async (method: string) => {
      const mine = ++id
      shim.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: mine, method }) + "\n")
      return until(() => answers.get(mine), 5_000)
    }
    try {
      await call("initialize")
      const first = await call("whoami")
      expect(first.version).toBe("9.0.1")
      expect(first.session).toMatch(/^mcp-[0-9a-f]{8}$/)
      expect(first.clientPid).toBe(String(shim.pid))

      // current.json moves, but the relay still runs 9.0.1 (a switch not finished, or refused): no swap.
      writeCurrent(shimLayout, { version: "9.0.2", previous: "9.0.1", channel: "latest" })
      await Bun.sleep(3_000)
      expect((await call("whoami")).version).toBe("9.0.1")

      // The relay now runs 9.0.2: the next server is 9.0.2, with the same session and client pid.
      relayVersion = "9.0.2"
      const swapped = await until(async () => {
        const answer = await call("whoami")
        return answer.version === "9.0.2" ? answer : undefined
      }, 10_000)
      expect(swapped.session).toBe(first.session)
      expect(swapped.clientPid).toBe(String(shim.pid))
      expect(swapped.ppid).toBe(String(shim.pid))
      expect(notifications).toContain("notifications/tools/list_changed")
    } finally {
      shim.kill("SIGKILL")
      await fakeRelay.stop(true)
      fs.rmSync(shimRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
