import { expect, test } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { extensionProtocolVersion, unpackedExtensionId } from "../src/protocol.ts"
import { pairWithCode } from "./relay-harness.ts"
import { freePort } from "./support/ports.ts"

// A built bundle in a temp package: `fromSource` sees src/main.ts, and no extension folder sits beside it for install to
// write a bundled code into. CI builds cli/dist before the tests; without it this end-to-end check has nothing to run.
const built = path.resolve(import.meta.dir, "../dist/cli.mjs")
const node = Bun.which("node")

function runtime(root: string) {
  const dir = path.join(root, "runtime")
  cpSync(path.dirname(built), path.join(dir, "dist"), { recursive: true })
  mkdirSync(path.join(dir, "src"), { recursive: true })
  writeFileSync(path.join(dir, "src", "main.ts"), "")
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.0.11" }))
  symlinkSync(path.resolve(import.meta.dir, "../node_modules"), path.join(dir, "node_modules"), "dir")
  return path.join(dir, "dist", "cli.mjs")
}

const env = (home: string, port: number): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  OPENCODE_BROWSER_HOME: home,
  OPENCODE_BROWSER_PORT: String(port),
  OPENCODE_BROWSER_UPDATE_CHECK: "0",
})

async function startRelay(entry: string, home: string, port: number): Promise<ChildProcess> {
  const relay = spawn(node!, [entry, "serve"], { env: env(home, port), stdio: "ignore" })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await fetch(`http://127.0.0.1:${port}/version`).then((response) => response.ok, () => false)) return relay
    await Bun.sleep(100)
  }
  relay.kill("SIGKILL")
  await new Promise<void>((resolve) => relay.once("exit", () => resolve()))
  throw new Error("The relay didn't start")
}

/** What the extension does without a credential: announce its protocol and that it needs pairing, then close. */
async function unpairedPresence(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: `chrome-extension://${unpackedExtensionId}` })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
  })
  socket.send(JSON.stringify({ method: "protocol", params: { unpaired: true, protocolVersion: extensionProtocolVersion } }))
  await new Promise<void>((resolve) => socket.once("close", () => resolve()))
}

test.skipIf(process.platform === "win32" || !node || !existsSync(built))(
  "a non-TTY install gives a code to a browser that contacted the relay unpaired",
  async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "browse-install-unpaired-"))
    const entry = runtime(home)
    const port = await freePort()
    const relay = await startRelay(entry, home, port)
    try {
      await unpairedPresence(port)
      // No TTY and SSH, like the report: install can't open a page, but the browser already opened its own.
      const install = spawnSync(node!, [entry, "install", "--agent", "none", "--no-open"], {
        env: { ...env(home, port), SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 2" },
        encoding: "utf8",
        timeout: 60_000,
      })
      expect(install.status, install.stderr).toBe(0)
      expect(install.stdout).toContain("browse is installed in a browser but isn't paired with this relay yet.")
      // The extension is installed: sending the user back to the store is the bug.
      expect(install.stdout).not.toContain("Chrome Web Store")
      expect(install.stdout).toContain("click Pair.")
      const shown = /enter ([0-9A-Z]{4}-[0-9A-Z]{4}) as the pairing code/.exec(install.stdout)?.[1]
      expect(shown).toBeDefined()
      // The code it printed is the one the waiting onboarding page can redeem.
      const paired = await pairWithCode(port, shown!.replace("-", ""), "unpaired-test")
      expect(paired).toMatchObject({ open: true })
      expect(paired.token).toBeDefined()
    } finally {
      relay.kill("SIGKILL")
      await new Promise<void>((resolve) => relay.once("exit", () => resolve()))
      rmSync(home, { recursive: true, force: true })
    }
  },
  60_000,
)
