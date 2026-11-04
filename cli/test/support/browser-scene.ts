// One isolated headless browser scene for the `*-browser.ts` integration harnesses: a temp data root with its
// own OPENCODE_BROWSER_HOME, a port-patched copy of the built extension, a paired relay on a free port, and a
// persistent Chromium context with that extension loaded.
//
// Pure Node (no `bun:test`) because CI runs each harness directly after `bun build.ts`:
//   bun run build && (cd cli && bun run build) && node --no-warnings test/execute-realm-browser.ts [--browser <chromium executable>]
//
// The caller parses `--browser` and passes it as `browser`; fixtures, API helpers and assertions stay in the
// caller. Ports come from BROWSE_TEST_RELAY_PORT and BROWSE_TEST_FIXTURE_PORT, or are free ports.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { chromium } from "patchright-core"
import { relayToken } from "../../src/relay/secrets.ts"
import { bundledPairingCodeTtlMs, mintPairingCode, writeExtensionPairing } from "../../src/relay/browser-pairing.ts"
import { portFromEnv } from "./ports.ts"

type BrowserContext = Awaited<ReturnType<typeof chromium.launchPersistentContext>>

/** What a setup hook sees: paths and env exist, the relay has not started. */
export type BrowserSceneSetup = {
  /** The scene's OPENCODE_BROWSER_HOME; write client and pairing files here before the relay reads them. */
  readonly home: string
  /** The relay's environment; mutate it to add anything the relay must see at startup. */
  readonly env: NodeJS.ProcessEnv
}

export type StartBrowserSceneOptions<T = undefined> = {
  /** Temp directory prefix under <tmp>/opencode, to recognise a failed run's files. */
  readonly name?: string
  /** Chromium executable; defaults to PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, then patchright-core's own. */
  readonly browser?: string
  /** Extra Chromium launch arguments, e.g. "--use-mock-keychain". */
  readonly extraArgs?: readonly string[]
  /** Environment overrides merged over the base contract (HOME, ports, update check). */
  readonly env?: NodeJS.ProcessEnv
  /** Runs after paths, env, the built copies and the pairing code exist, and before the relay spawns. */
  readonly setup?: (scene: BrowserSceneSetup) => T | Promise<T>
}

export type BrowserScene<T = undefined> = {
  readonly root: string
  readonly home: string
  readonly runtime: string
  readonly extension: string
  /** runtime/dist/cli.mjs: the relay and CLI entry point this scene's env points at. */
  readonly cli: string
  readonly port: number
  readonly base: string
  /** The fixture port from BROWSE_TEST_FIXTURE_PORT (else free); the caller serves it. */
  readonly fixturePort: number
  readonly fixtureUrl: string
  readonly env: NodeJS.ProcessEnv
  readonly executablePath: string
  /** The persistent context with the built extension loaded. */
  readonly browser: BrowserContext
  readonly relay: ChildProcess
  /** The relay log's file descriptor (root/relay.log, opened 0o600). */
  readonly log: number
  /** Whatever the setup hook returned. */
  readonly setupResult: T
  /** Closes the browser, SIGTERMs the relay (SIGKILL after 2s) and closes the log; the caller closes fixtures and may keep root. */
  readonly stop: () => Promise<void>
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function startBrowserScene<T = undefined>(options: StartBrowserSceneOptions<T> = {}): Promise<BrowserScene<T>> {
  const executablePath = options.browser || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()
  assert.ok(
    fs.existsSync(executablePath),
    `No Chromium at ${executablePath}: pass --browser, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or run \`node node_modules/patchright-core/cli.js install chromium\``,
  )

  const cliRoot = path.resolve(import.meta.dirname, "../..")
  const tmp = path.join(fs.realpathSync(os.tmpdir()), "opencode")
  fs.mkdirSync(tmp, { recursive: true })
  const root = fs.mkdtempSync(path.join(tmp, options.name ?? "browser-scene-"))
  const home = path.join(root, "home")
  const runtime = path.join(root, "runtime")
  const extension = path.join(home, "extension")
  const port = await portFromEnv("BROWSE_TEST_RELAY_PORT")
  const fixturePort = await portFromEnv("BROWSE_TEST_FIXTURE_PORT")
  const fixtureUrl = `http://127.0.0.1:${fixturePort}`
  const base = `http://127.0.0.1:${port}`

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    OPENCODE_BROWSER_HOME: home,
    OPENCODE_BROWSER_PORT: String(port),
    OPENCODE_BROWSER_UPDATE_CHECK: "0",
  }
  delete env.OPENCODE_BROWSER_ALLOW_NODE
  delete env.OPENCODE_BROWSER_ALLOW_FOREGROUND
  Object.assign(env, options.env)

  fs.mkdirSync(path.join(runtime, "dist"), { recursive: true })
  // The extension build (`bun run build` at the repo root); the npm package doesn't ship it.
  fs.cpSync(path.join(cliRoot, "..", "dist"), extension, { recursive: true })
  fs.cpSync(path.join(cliRoot, "dist"), path.join(runtime, "dist"), { recursive: true })
  fs.symlinkSync(path.join(cliRoot, "node_modules"), path.join(runtime, "node_modules"), "dir")
  for (const entry of fs.readdirSync(extension, { recursive: true })) {
    const file = path.join(extension, String(entry))
    if (/\.(js|json)$/.test(file) && fs.statSync(file).isFile()) {
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("19988", String(port)))
    }
  }
  const cli = path.join(runtime, "dist/cli.mjs")
  // A one-time code in the folder, as install leaves it: the extension exchanges it for its key.
  writeExtensionPairing(extension, mintPairingCode(home, { ttlMs: bundledPairingCodeTtlMs }))

  const setupResult = options.setup ? await options.setup({ home, env }) : (undefined as T)

  const log = fs.openSync(path.join(root, "relay.log"), "w", 0o600)
  const relay = spawn("node", [cli, "serve"], { env, stdio: ["ignore", log, log] })
  let browser: BrowserContext | undefined
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await browser?.close().catch(() => {})
    relay.kill("SIGTERM")
    await new Promise<void>(resolve => {
      if (relay.exitCode !== null || relay.signalCode !== null) return resolve()
      const timer = setTimeout(() => { relay.kill("SIGKILL"); resolve() }, 2_000)
      relay.once("exit", () => { clearTimeout(timer); resolve() })
    })
    fs.closeSync(log)
  }

  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/version`).then(response => response.ok, () => false)) { ready = true; break }
      await pause(50)
    }
    assert.ok(ready, `The relay never answered ${base}/version; see ${path.join(root, "relay.log")}`)
    const authorization = `Bearer ${relayToken(home)}`
    browser = await chromium.launchPersistentContext(path.join(root, "profile"), {
      executablePath,
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...(options.extraArgs ?? [])],
    })
    const context = browser
    const connected = async () => {
      const response = await fetch(`${base}/extension/status`, { headers: { authorization } }).catch(() => undefined)
      if (!response?.ok) return false
      return Boolean(((await response.json()) as { connected?: boolean }).connected)
    }
    let extensionReady = false
    for (let i = 0; i < 100; i++) {
      if (await connected()) { extensionReady = true; break }
      await pause(100)
    }
    assert.ok(extensionReady, `The extension never connected to ${base}/extension/status; see ${path.join(root, "relay.log")}`)
    return {
      root, home, runtime, extension, cli, port, base, fixturePort, fixtureUrl, env, executablePath,
      browser: context, relay, log, setupResult, stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}
