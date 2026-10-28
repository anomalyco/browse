// Runs the scenario suite once, serially, over one MCP stdio server; each scenario gets its own session.
//   node stress/run-scenarios.ts [--only name,name] [--tag core] [--repeat N]
// Writes scenarios.jsonl and summary.md under ~/stress-results/<stamp>-scenarios/.
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { BrowserCdp } from "./lib/cdp.ts"
import { fixturePort, runDir } from "./lib/env.ts"
import { startFixtures } from "./lib/fixtures.ts"
import { exec, McpClient } from "./lib/mcp.ts"
import { Jsonl, mdEscape, oneLine } from "./lib/results.ts"
import { scenarios, type Scenario } from "./scenarios.ts"

const { values } = parseArgs({ options: { only: { type: "string" }, tag: { type: "string" }, repeat: { type: "string", default: "1" } } })
const only = values.only?.split(",")
const selected = scenarios.filter((s) => (!only || only.includes(s.name)) && (!values.tag || s.tags.includes(values.tag)))
const dir = runDir("scenarios")
const out = new Jsonl(dir, "scenarios.jsonl")
const fx = await startFixtures(fixturePort)
const cdp = await BrowserCdp.connect()
let client = new McpClient()
await client.initialize()

async function runOne(scenario: Scenario, round: number) {
  const session = `sc-${scenario.name}-${round}`.slice(0, 60)
  const started = Date.now()
  let ok = false
  let error: string | undefined
  let extra: unknown
  try {
    if (client.exited !== undefined) { client = new McpClient(); await client.initialize() }
    const created = await client.call("session_new", { id: session })
    if (created.isError && !/exists/i.test(created.text)) throw new Error(`session_new: ${created.text}`)
    const ctx = { client, session, fx, cdp, artifacts: path.join(dir, "artifacts"), exec: (code: string, timeoutMs?: number) => exec(client, session, code, timeoutMs) }
    const timeout = scenario.timeoutMs ?? 90_000
    extra = await Promise.race([
      scenario.run(ctx),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`scenario timed out after ${timeout} ms`)), timeout)),
    ])
    ok = true
  } catch (e) {
    error = oneLine(e)
  } finally {
    await client.call("session_delete", { session }, 30_000).catch(() => undefined)
  }
  const ms = Date.now() - started
  out.write({ scenario: scenario.name, round, ok, ms, ...(error ? { error } : {}), ...(extra === undefined ? {} : { extra }) })
  console.log(`${ok ? "PASS" : "FAIL"} ${scenario.name} ${ms}ms${error ? `  ${error}` : ""}`)
  return { name: scenario.name, ok, ms, error }
}

const rows: { name: string; ok: boolean; ms: number; error?: string | undefined }[] = []
for (let round = 1; round <= Number(values.repeat); round++)
  for (const scenario of selected) rows.push(await runOne(scenario, round))

await client.close()
cdp.close()
await fx.close()
const passed = rows.filter((r) => r.ok).length
const summary = [
  `# Scenario suite`,
  ``,
  `${passed}/${rows.length} passed (${new Date().toISOString()})`,
  ``,
  `| Scenario | Result | ms | Error |`,
  `| --- | --- | ---: | --- |`,
  ...rows.map((r) => `| ${r.name} | ${r.ok ? "pass" : "**FAIL**"} | ${r.ms} | ${mdEscape(r.error ?? "")} |`),
].join("\n")
fs.writeFileSync(path.join(dir, "summary.md"), `${summary}\n`)
console.log(`\n${passed}/${rows.length} passed. Results: ${dir}`)
process.exit(passed === rows.length ? 0 : 1)
