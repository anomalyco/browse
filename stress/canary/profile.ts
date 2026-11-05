// A new Chrome uses the bundled code left by the release installer. The second browser needs its own one-time
// code; relaunches of either must reconnect with their existing pairing, never auto-repair it.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { BrowserCdp } from "../lib/cdp.ts"
import { relayJson, sleep } from "../lib/env.ts"

const browser = process.argv[2]
assert((browser === "chrome" || browser === "brave") && process.env.HOME === "/home/canary" && process.env.OPENCODE_BROWSER_PORT === "19770")
const port = browser === "chrome" ? 19771 : 19773, id = `canary-${browser}`
const deadline = Date.now() + 65_000
let configured = false
while (Date.now() < deadline) {
  const cdp = await BrowserCdp.connect(1500, port).catch(() => undefined)
  try {
    if (cdp && !configured && await cdp.extensionWorker()) {
      const stored = await cdp.evalInExtension(`chrome.storage.local.get(['browserName','agentRelayAddress'])`)
      if (!stored.agentRelayAddress) {
        const settings: Record<string, string> = { browserName: id, agentRelayAddress: "127.0.0.1:19770" }
        if (browser === "brave") {
          const output = execFileSync(process.env.BROWSE_STRESS_BINARY!, ["pair"], { encoding: "utf8", timeout: 15_000 })
          const code = output.match(/Pairing code:\s*([0-9A-Z]{4}-[0-9A-Z]{4})/i)?.[1]
          assert(code, "pair did not return a one-time code")
          settings.agentRelayPairingCode = code
        }
        await cdp.evalInExtension(`chrome.storage.local.set(${JSON.stringify(settings)})`)
      }
      configured = true
    }
    // Keep primary Chrome alive even when the relay itself is broken. The daemon measures and recovers that
    // outage. Brave is started just for the nightly check, which must wait until the second lane is available.
    if (configured && (browser === "chrome" || (await relayJson("/extension/status", undefined, 2000).catch(() => ({}))).browsers?.some((b: { id: string; connected: boolean }) => b.id === id && b.connected))) process.exit(0)
  } finally { cdp?.close() }
  await sleep(1000)
}
throw new Error(`${browser} did not pair to the canary relay`)
