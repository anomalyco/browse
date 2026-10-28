// Smoke test over MCP stdio, the way an agent uses browse: initialize, tools/list, status, then one session through
// navigate, snapshot, fill, click, screenshot, network capture, a recording and session_delete.
//   node stress/smoke.ts                                   # on the box (spawns `node cli/dist/cli.mjs mcp`)
//   node stress/smoke.ts --remote browse-stress.exe.xyz    # from a Mac: the MCP server runs on the box over wssh
// --remote only lists tools and calls status (the fixture site lives on the box).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { fixturePort } from "./lib/env.ts"
import { startFixtures } from "./lib/fixtures.ts"
import { exec, McpClient } from "./lib/mcp.ts"

const { values } = parseArgs({ options: { remote: { type: "string" }, ssh: { type: "string", default: "wssh" }, "remote-cli": { type: "string", default: "/home/exedev/browse/cli/dist/cli.mjs" } } })
const steps: { step: string; ok: boolean; ms: number; detail?: string }[] = []
async function step<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
  const t = Date.now()
  try {
    const value = await run()
    steps.push({ step: name, ok: true, ms: Date.now() - t, detail: JSON.stringify(value)?.slice(0, 160) })
    console.log(`PASS ${name} ${Date.now() - t}ms`)
    return value
  } catch (e) {
    steps.push({ step: name, ok: false, ms: Date.now() - t, detail: String(e).slice(0, 300) })
    console.log(`FAIL ${name}: ${String(e).slice(0, 300)}`)
    return undefined
  }
}
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }

const command = values.remote ? [values.ssh!, values.remote, "/usr/local/bin/node", values["remote-cli"]!, "mcp"] : undefined
const client = new McpClient(command)
await step("initialize", async () => (await client.initialize()).serverInfo)
await step("tools/list", async () => {
  const { tools } = await client.request("tools/list")
  const names = tools.map((t: any) => t.name)
  for (const required of ["execute", "session_new", "network_start", "recording_start", "status"]) check(names.includes(required), `missing tool ${required}`)
  return names.length
})
await step("status", async () => {
  const result = await client.call("status")
  check(!result.isError, result.text)
  check(/connected/i.test(result.text), `extension not connected: ${result.text.slice(0, 200)}`)
  return result.text.split("\n").slice(0, 3).join(" | ")
})

if (!values.remote) {
  const fx = await startFixtures(fixturePort)
  const session = `smoke-${Date.now().toString(36)}`
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "browse-smoke-"))
  const run = (code: string) => exec(client, session, code)
  await step("session_new", async () => { const r = await client.call("session_new", { id: session }); check(!r.isError, r.text); return r.data?.session?.id ?? session })
  await step("execute: navigate + snapshot", async () => { const s = await run(`await page.goto(${JSON.stringify(fx.url("/form"))}); return await snapshot()`); check(String(s).includes("Save"), s); return s })
  await step("execute: fill + click", async () => { const v = await run(`await page.getByLabel('Name').fill('smoke'); await page.getByRole('button', {name: 'Save'}).click(); return await page.locator('output').textContent()`); check(v === "smoke", v); return v })
  await step("execute: screenshot", async () => { const n = await run(`return (await page.screenshot()).length`); check(n > 1000, n); return n })
  await step("network capture", async () => {
    check(!(await client.call("network_start", { session })).isError, "network_start")
    await run(`await page.goto(${JSON.stringify(fx.url("/network"))}); await page.locator('#out', {hasText: '3 rows'}).waitFor()`)
    const har = path.join(out, "smoke.har")
    const stop = await client.call("network_stop", { session, outputPath: har })
    check(!stop.isError, stop.text)
    const entries = JSON.parse(fs.readFileSync(har, "utf8")).log.entries.length
    check(entries >= 3, `${entries} entries`)
    return entries
  })
  await step("recording", async () => {
    await run(`await page.goto(${JSON.stringify(fx.url("/animate"))})`)
    const file = path.join(out, "smoke.webm")
    const start = await client.call("recording_start", { session, outputPath: file })
    check(!start.isError, start.text)
    await run(`await page.waitForTimeout(2500)`)
    const stop = await client.call("recording_stop", { session }, 60_000)
    check(!stop.isError, stop.text)
    const size = fs.statSync(file).size
    check(size > 10_000, `${size} bytes`)
    return size
  })
  await step("session_delete", async () => { const r = await client.call("session_delete", { session }); check(!r.isError && r.data?.deleted === true, r.text); return r.data })
  fs.rmSync(out, { recursive: true, force: true })
  await fx.close()
}
await client.close()
const passed = steps.filter((s) => s.ok).length
console.log(`\n${passed}/${steps.length} smoke steps passed`)
process.exit(passed === steps.length ? 0 : 1)
