import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import WebSocket from "ws"
import { bundleCli } from "../bundle.ts"
import { processAlive, readCurrent, readState, runtimeLayout, updateState, versionEntry, writeCurrent, writeShim, type Layout } from "../src/update/auto-update.ts"
import { relayToken } from "../src/relay/secrets.ts"
import { freePort } from "./support/ports.ts"

// An npm install's runtime in a temporary data root, with two real versions of this CLI (bundled from source as 0.0.1
// and 0.0.2), two whose relay crashes on startup (0.0.4 always, 0.0.5 only as the managed relay, so it passes the check
// before a switch), one whose managed relay is slow to start (0.0.7), a relay running 0.0.1, and a fake registry whose
// 0.0.3 tarball never finishes downloading and whose 0.0.6 crashes on `serve`. Node runs the relay, as in a real
// install. No browser.

const cliRoot = path.resolve(import.meta.dir, "..")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-autoupdate-it-"))
const layout = runtimeLayout(root)
const node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim() || "node"
let relayPort = 0
let registry: ReturnType<typeof Bun.serve> | undefined
let relay: ChildProcess | undefined
const started: number[] = []

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

/** Puts `code` at the top of a bundled entry, which runs before the CLI does anything. */
function prepend(entry: string, code: string) {
  const [first = "", ...rest] = fs.readFileSync(entry, "utf8").split("\n")
  fs.writeFileSync(entry, (first.startsWith("#!") ? [first, code, ...rest] : [code, first, ...rest]).join("\n"))
}

const crash = (when: string) => `if (process.argv[2] === "serve" && ${when}) throw new SyntaxError("The requested module '@effect/platform-node-shared' does not provide an export named 'NodeWS'")`

/** A version whose `serve` crashes the way a release with a missing dependency export does (`--version` still works). */
async function installBroken(target: Layout, version: string, when: string) {
  await installFake(target, version)
  prepend(versionEntry(target, version), crash(when))
}

/** 0.0.6 as the registry's tarball: a package whose `serve` crashes, for runtime-install to install. */
let brokenTarball: { bytes: Buffer; integrity: string } | undefined
async function packBroken() {
  const staging = path.join(root, "pack-0.0.6")
  await bundleCli({ outdir: path.join(staging, "package", "dist"), version: "0.0.6" })
  prepend(path.join(staging, "package", "dist", "cli.mjs"), crash("true"))
  fs.writeFileSync(path.join(staging, "package", "package.json"), JSON.stringify({ name: "@opencode/browse", version: "0.0.6", type: "module" }))
  const file = path.join(staging, "browse-0.0.6.tgz")
  spawnSync("tar", ["czf", file, "-C", staging, "package"])
  const bytes = fs.readFileSync(file)
  brokenTarball = { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` }
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
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data)) as { id?: number }
      if (message.id === id) {
        socket.off("message", onMessage)
        resolve(message as { result?: Record<string, unknown> })
      }
    }
    socket.on("message", onMessage)
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
      if (url.pathname.endsWith("/browse-0.0.6.tgz")) return new Response(new Uint8Array(brokenTarball!.bytes))
      if (url.pathname.includes("/-/")) return new Promise<Response>(() => {})
      const tarball = (published: string) => `http://127.0.0.1:${registry!.port}/@opencode/browse/-/browse-${published}.tgz`
      return Response.json({
        name: "@opencode/browse",
        "dist-tags": { latest: "0.0.3" },
        versions: {
          "0.0.3": { name: "@opencode/browse", version: "0.0.3", dist: { tarball: tarball("0.0.3"), integrity: `sha512-${Buffer.alloc(64).toString("base64")}` } },
          "0.0.6": { name: "@opencode/browse", version: "0.0.6", dist: { tarball: tarball("0.0.6"), integrity: brokenTarball!.integrity } },
        },
      })
    },
  })
  await installFake(layout, "0.0.1")
  await installFake(layout, "0.0.2")
  await installBroken(layout, "0.0.4", "true")
  await installBroken(layout, "0.0.5", `process.env.OPENCODE_BROWSER_MANAGED_RELAY === "1"`)
  // 0.0.7's managed relay is slow: still starting when the switch gives up on it.
  await installFake(layout, "0.0.7")
  prepend(versionEntry(layout, "0.0.7"), `if (process.argv[2] === "serve" && process.env.OPENCODE_BROWSER_MANAGED_RELAY === "1") { process.getBuiltinModule("node:fs").writeFileSync(process.env.OPENCODE_BROWSER_HOME + "/late.pid", String(process.pid)); await new Promise((resolve) => setTimeout(resolve, 20_000)) }`)
  await packBroken()
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

  test("a version whose relay doesn't start never stops the running relay, and is skipped from then on", async () => {
    const before = await version()
    updateState(layout, (state) => ({ ...state, pending: "0.0.4" }))
    const result = spawnSync(node, [versionEntry(layout, before.version), "runtime-switch", "0.0.4"], { env: env(), encoding: "utf8", timeout: 60_000 })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("0.0.4 didn't start: SyntaxError: The requested module '@effect/platform-node-shared' does not provide an export named 'NodeWS'")
    expect(result.stdout).toContain("skipping 0.0.4 until a newer version is published")
    expect(await version()).toMatchObject({ version: before.version, pid: before.pid })
    expect(readCurrent(layout)?.version).toBe(before.version)
    expect(readState(layout)).toMatchObject({ skipped: "0.0.4", lastError: { version: "0.0.4" } })
    expect(readState(layout).pending).toBeUndefined()
  }, 60_000)

  test("when the new relay fails after the old one stopped, the old version's relay is back before the switch ends", async () => {
    const before = await version()
    const result = spawnSync(node, [versionEntry(layout, before.version), "runtime-switch", "0.0.5"], { env: env(), encoding: "utf8", timeout: 60_000 })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("skipping 0.0.5 until a newer version is published")
    // Restarted by the switch itself, not by the next agent's call.
    const now = await version()
    started.push(now.pid)
    expect(now.version).toBe(before.version)
    expect(now.pid).not.toBe(before.pid)
    expect(readCurrent(layout)).toMatchObject({ version: before.version })
    expect(readState(layout).skipped).toBe("0.0.5")
  }, 60_000)

  test("a new relay still starting when the switch gives up on it is stopped before the old version comes back", async () => {
    const before = await version()
    const result = spawnSync(node, [versionEntry(layout, before.version), "runtime-switch", "0.0.7"], { env: env(), encoding: "utf8", timeout: 60_000 })
    const now = await version()
    started.push(now.pid)
    const late = Number(fs.readFileSync(path.join(root, "late.pid"), "utf8"))
    started.push(late)
    expect(result.status).toBe(1)
    expect(processAlive(late)).toBe(false)
    expect(now.version).toBe(before.version)
    expect(readCurrent(layout)).toMatchObject({ version: before.version })
  }, 60_000)

  test("runtime-install removes a version that doesn't start and skips it, rather than leaving it pending", async () => {
    const running = (await version()).version
    // Not spawnSync: the registry answers npm from this process.
    const child = spawn(node, [versionEntry(layout, running), "runtime-install", "0.0.6"], { env: env(), stdio: ["ignore", "pipe", "inherit"] })
    let stdout = ""
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => void (stdout += chunk))
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve))
    const result = { status, stdout }
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("install of 0.0.6 failed (0.0.6 didn't start: SyntaxError: The requested module '@effect/platform-node-shared' does not provide an export named 'NodeWS')")
    expect(fs.existsSync(path.join(layout.versions, "0.0.6"))).toBe(false)
    expect(readState(layout)).toMatchObject({ skipped: "0.0.6", lastError: { version: "0.0.6" } })
    expect(readState(layout).pending).toBeUndefined()
  }, 150_000)
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

  test("swaps to a new version only once the relay runs it, holding requests meanwhile and keeping the session identity", async () => {
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

      // current.json moves while the relay still runs 9.0.1 (a switch not finished): no swap, and a new request waits
      // rather than reaching a server whose relay is going away.
      writeCurrent(shimLayout, { version: "9.0.2", previous: "9.0.1", channel: "latest" })
      const held = ++id
      shim.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: held, method: "whoami" }) + "\n")
      await Bun.sleep(2_500)
      expect(answers.has(held)).toBe(false)
      // The switch is called off (current.json back to 9.0.1): the held request goes to the 9.0.1 server.
      writeCurrent(shimLayout, { version: "9.0.1", channel: "latest" })
      expect((await until(() => answers.get(held), 5_000)).version).toBe("9.0.1")

      // The switch happens: current.json moves and the relay runs 9.0.2. The next server is 9.0.2, same session and pid.
      writeCurrent(shimLayout, { version: "9.0.2", previous: "9.0.1", channel: "latest" })
      relayVersion = "9.0.2"
      const swapped = await call("whoami")
      expect(swapped.version).toBe("9.0.2")
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

  // With no relay (the switch stopped it), and with a relay that reports the new version while its MCP server crashes.
  for (const reported of [undefined, "9.0.2"] as const)
  test(`goes back to the old server when the new version's server exits on startup, rather than exiting itself (relay ${reported ?? "gone"})`, async () => {
    const shimRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browse-shim-it-"))
    const shimLayout = runtimeLayout(shimRoot)
    const launches = path.join(shimRoot, "launches")
    for (const [stubVersion, source] of [["9.0.1", stub("9.0.1")], ["9.0.2", `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(launches)}, "x"); process.exit(1)`]] as const) {
      fs.mkdirSync(path.dirname(versionEntry(shimLayout, stubVersion)), { recursive: true })
      fs.writeFileSync(versionEntry(shimLayout, stubVersion), source)
    }
    writeCurrent(shimLayout, { version: "9.0.1", channel: "latest" })
    writeShim(shimLayout)
    const fakeRelay = reported ? Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ version: reported }) }) : undefined
    const shim = spawn(node, [shimLayout.shim, "mcp"], { env: { PATH: process.env.PATH ?? "", OPENCODE_BROWSER_HOME: shimRoot, OPENCODE_BROWSER_PORT: String(fakeRelay?.port ?? (await freePort())) }, stdio: ["pipe", "pipe", "inherit"] })
    const answers = new Map<number, Record<string, string>>()
    createInterface({ input: shim.stdout! }).on("line", (line) => {
      const message = JSON.parse(line) as { id?: number; result?: Record<string, string> }
      if (message.id !== undefined) answers.set(message.id, message.result ?? {})
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
      writeCurrent(shimLayout, { version: "9.0.2", previous: "9.0.1", channel: "latest" })
      await until(() => fs.existsSync(launches), 10_000)
      // While current.json still names 9.0.2, calls go to the 9.0.1 server at once, not after a held window.
      const during = await call("whoami")
      expect(during.version).toBe("9.0.1")
      expect(during.session).toBe(first.session)
      await Bun.sleep(4_000)
      expect(shim.exitCode).toBeNull()
      // Tried once, not again on every check, whatever the relay reports.
      expect(fs.readFileSync(launches, "utf8")).toBe("x")
      expect((await call("whoami")).version).toBe("9.0.1")
      // The switch is undone: the agent's calls carry on, in the same session.
      writeCurrent(shimLayout, { version: "9.0.1", channel: "latest" })
      const after = await call("whoami")
      expect(after.version).toBe("9.0.1")
      expect(after.session).toBe(first.session)
    } finally {
      shim.kill("SIGKILL")
      await fakeRelay?.stop(true)
      fs.rmSync(shimRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
