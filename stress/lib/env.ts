// Where the box's browse install, relay data and harness-only Chrome debugging port are. Every value can be
// overridden by an environment variable so the runners also work against another install.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const repo = process.env.BROWSE_REPO ?? path.join(os.homedir(), "browse")
export const cli = path.join(repo, "cli/dist/cli.mjs")
export const dataDir = process.env.OPENCODE_BROWSER_HOME ?? path.join(os.homedir(), ".local/share/opencode-browser")
export const relayPort = Number(process.env.OPENCODE_BROWSER_PORT) || 19988
export const relayBase = `http://127.0.0.1:${relayPort}`
/** Chrome's --remote-debugging-port, used only by the harness (handoff clicks, SW stops, ground-truth tab counts). */
export const chromeDebugPort = Number(process.env.BROWSE_STRESS_CHROME_PORT) || 9222
export const fixturePort = Number(process.env.BROWSE_STRESS_FIXTURE_PORT) || 4510
export const resultsRoot = process.env.BROWSE_STRESS_RESULTS ?? path.join(os.homedir(), "stress-results")

export function relayToken(): string {
  return fs.readFileSync(path.join(dataDir, "relay-token"), "utf8").trim()
}

export function runDir(kind: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dir = path.join(resultsRoot, `${stamp}-${kind}`)
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true })
  return dir
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function relayFetch(route: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init
  return await fetch(`${relayBase}${route}`, {
    ...rest,
    headers: { authorization: `Bearer ${relayToken()}`, "content-type": "application/json", ...(rest.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
}

export async function relayJson<T = any>(route: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  const response = await relayFetch(route, body === undefined ? { timeoutMs } : { method: "POST", body: JSON.stringify(body), timeoutMs })
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
  return (await response.json()) as T
}
