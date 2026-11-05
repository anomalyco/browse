// One ordinary stdio client (or the nightly npx client); the fixture assertion isn't a CLI status proxy.
import assert from "node:assert/strict"
import { exec, McpClient } from "../lib/mcp.ts"
import { fixturePort, relayJson } from "../lib/env.ts"
import { startFixtures } from "../lib/fixtures.ts"
import { knownNpxSkew } from "./npx.ts"

const probe = process.argv.includes("--probe"), site = process.argv.includes("--site")
const fx = probe || site ? undefined : await startFixtures(fixturePort), session = `canary-${Date.now()}`
const npx = process.argv.includes("--npx")
// A second install format is a client here; it must never replace the binary canary's relay during an outage.
const client = new McpClient(npx ? ["npx", "--yes", "@opencode/browse@dev", "mcp"] : undefined, npx || process.argv.includes("--no-autostart") ? { OPENCODE_BROWSER_AUTOSTART: "false" } : {})
let created = false
async function task() {
  const hello = await client.initialize()
  const fresh = await client.call("session_new", { id: session }, 30_000)
  if (npx && fresh.isError && await knownNpxSkew(fresh.text, hello.serverInfo?.version, await relayJson("/version"))) {
    console.error(fresh.text)
    process.exitCode = 54
    return
  }
  assert(!fresh.isError, fresh.text)
  created = true
  if (probe) {
    assert.equal(await exec(client, session, "return await page.title().then(() => 1)", 15_000), 1)
  } else if (site) {
    const title = await exec(client, session, `await page.goto('https://example.com', {timeout:20000}); return await page.title()`, 30_000)
    assert.equal(title, "Example Domain")
  } else {
    const value = await exec(client, session, `await page.goto(${JSON.stringify(fx!.url("/form"))}); await page.getByLabel('Name').fill('${session}'); await page.getByRole('button',{name:'Save'}).click(); return await page.locator('output').textContent()`, 30_000)
    assert.equal(value, session)
  }
  console.log("MCP session_new → navigate → verify: pass")
}
try { await task() } finally {
  try { if (created) { const del = await client.call("session_delete", { id: session }, 10_000); assert(!del.isError, del.text) } }
  finally { await client.close(); await fx?.close() }
}
