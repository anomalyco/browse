// Artifact smoke: bun script/compile.ts <host-target>, then bun test/compiled-relay.ts <path-to-binary>.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { relayAuthorization } from "../src/relay/secrets.ts"
import { FakeExtension, until } from "./relay-harness.ts"
import { portFromEnv } from "./support/ports.ts"

const binary = process.argv[2]
assert.ok(binary, "Pass the host's compiled browse executable")
const port = await portFromEnv("BROWSE_TEST_RELAY_PORT")
const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-compiled-relay-"))
const base = `http://127.0.0.1:${port}`
const relay = Bun.spawn([path.resolve(binary), "serve"], {
  cwd: home, stdout: "ignore", stderr: "inherit",
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: home, HOME: home,
    OPENCODE_BROWSER_HOME: home, OPENCODE_BROWSER_PORT: String(port), OPENCODE_BROWSER_UPDATE_CHECK: "0", OPENCODE_BROWSER_MANAGED_RELAY: "1" },
})
const log = () => fs.readFileSync(path.join(home, "logs/relay.log"), "utf8")
const execute = (sessionId: string) => fetch(`${base}/cli/execute`, {
  method: "POST", headers: { authorization: relayAuthorization(home), "content-type": "application/json" },
  body: JSON.stringify({ sessionId, createIfMissing: true, code: "return page.url()" }), signal: AbortSignal.timeout(10_000),
})
const url = "https://example.com/"
const extension = (tabId: number) => {
  const id = `TARGET-${tabId}`
  return new FakeExtension(home, port)
    .on("tabs.create", () => ({ tabId }))
    .on("Target.getTargetInfo", () => ({ targetInfo: { targetId: id, type: "page", title: "Test", url, attached: true, browserContextId: "CTX" } }))
    .on("Page.getFrameTree", () => ({ frameTree: { frame: { id, loaderId: "L", url, securityOrigin: "https://example.com", mimeType: "text/html" } } }))
}

try {
  const version = () => fetch(`${base}/version`).then(r => r.json() as Promise<{ pid: number }>)
  for (let i = 0; i < 100 && relay.exitCode === null; ++i) {
    if (await version().then(v => v.pid === relay.pid, () => false)) break
    await Bun.sleep(50)
  }
  assert.equal((await version()).pid, relay.pid)
  const first = extension(7)
  first.on("Network.setCacheDisabled", () => first.close())
  assert.ok(await first.pair())
  // The racing execute itself may fail. What matters is the unawaited command and the relay that owns it.
  const racing = execute("disconnect").catch(() => undefined)
  assert.ok(await until(() => first.closeCode !== undefined))
  await until(() => relay.exitCode !== null || log().includes("process.benignRejections"))
  assert.equal(relay.exitCode, null, "disconnect killed the compiled relay")
  assert.match(log(), /process\.benignRejections .*Network\.setCacheDisabled.*Extension disconnected/i)

  // The fake's empty DOM.getDocument result also makes Patchright's async _onFrameNavigated throw a TypeError.
  const next = extension(8).on("DOM.getDocument", () => ({}))
  assert.ok(await next.pair())
  const result = await (await execute("reconnected")).json() as { isError: boolean; value: string }
  assert.equal(result.isError, false)
  assert.equal(result.value, url)
  assert.ok(await until(() => log().includes("keeping relay alive")))
  assert.match(log(), /TypeError:[^\n]*\n[^\n]*_onFrameNavigated[^\n]*coreBundle-/)
  assert.equal((await version()).pid, relay.pid)
  next.close()
  await racing
  console.log(log().split("\n").find(line => line.includes("process.benignRejections")))
} finally {
  relay.kill()
  await relay.exited
  fs.rmSync(home, { recursive: true, force: true })
}
