import { describe, expect, test } from "bun:test"
import { execFile, spawnSync } from "node:child_process"
import http from "node:http"
import type net from "node:net"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { promisify } from "node:util"
import { agentDefaultSessionId, exitCodeForError, hoistJsonFlag } from "../src/cli.ts"
import { ExitCode, failure } from "../src/cli/output.ts"
import { RelayUnreachable } from "../src/relay/client.ts"
import { opencodeBrowserBuildId, opencodeBrowserVersion } from "../src/version.ts"
import { freePort as unusedPort } from "./support/ports.ts"

const execFileAsync = promisify(execFile)

describe("CLI contract helpers", () => {
  test("hoistJsonFlag moves --json before -- and leaves operands after -- untouched", () => {
    expect(hoistJsonFlag(["--json", "status"])).toEqual({ json: true, argv: ["status", "--json"] })
    expect(hoistJsonFlag(["secrets", "run", "prod", "--", "cmd", "--json"])).toEqual({
      json: false,
      argv: ["secrets", "run", "prod", "--", "cmd", "--json"],
    })
    expect(hoistJsonFlag(["--json", "secrets", "run", "prod", "--", "cmd", "--json"])).toEqual({
      json: true,
      argv: ["secrets", "run", "prod", "--json", "--", "cmd", "--json"],
    })
  })

  test("agentDefaultSessionId lowercases OPENCODE_SESSION_ID and rejects unsafe ids", () => {
    expect(agentDefaultSessionId("ses_AbCdEf123")).toBe("oc-ses_abcdef123")
    expect(agentDefaultSessionId(undefined)).toBeUndefined()
    expect(agentDefaultSessionId("bad/path")).toBeUndefined()
    expect(agentDefaultSessionId("x".repeat(70))).toBeUndefined()
  })

  test("exitCodeForError maps relay/extension unavailability to ExitCode.host (4)", () => {
    expect(exitCodeForError(new RelayUnreachable({ message: "down", endpoint: "http://127.0.0.1:19988", path: "/version", cause: null }))).toBe(ExitCode.host)
    expect(exitCodeForError(new Error("boom"))).toBe(ExitCode.failure)
    expect(failure("browse status", "relay_unavailable", "down", { exitCode: ExitCode.host }).error.exitCode).toBe(4)
  })
})

describe("CLI process exit codes and session defaults", () => {
  const cliEntry = path.resolve(import.meta.dirname, "../src/main.ts")

  test("pair reports a running relay build mismatch, not a startup failure", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-pair-mismatch-"))
    const relay = Bun.serve({ hostname: "127.0.0.1", port: await unusedPort(), fetch: () =>
      Response.json({ version: "0.0.1", buildId: "2026-01-01T00:00:00Z" }) })
    try {
      const result = await execFileAsync(process.execPath, [cliEntry, "pair"], {
        env: { ...process.env, HOME: home, OPENCODE_BROWSER_HOME: home, OPENCODE_BROWSER_PORT: String(relay.port) }, timeout: 5000,
      }).catch((error: { code: number; stderr: string }) => error)
      expect(result).toMatchObject({ code: 1 })
      expect(result.stderr).toContain("Running relay build 2026-01-01")
      expect(result.stderr).toContain("relay restart")
      expect(result.stderr).not.toContain("Couldn't start")
    } finally { await relay.stop(true); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test("a silent listener fails status and session list without trying to start another relay", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-silent-"))
    const server = http.createServer(() => { /* accept the request but never send even the headers */ })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      await Promise.all([["status"], ["session", "list"]].map(async args => {
        const result = await execFileAsync(process.execPath, [cliEntry, ...args], {
          env: { ...process.env, OPENCODE_BROWSER_HOME: home, OPENCODE_BROWSER_PORT: String(port), OPENCODE_BROWSER_UPDATE_CHECK: "0" }, timeout: 9000,
        }).catch((error: { code: number; stderr: string }) => error)
        expect(result).toMatchObject({ code: ExitCode.host })
        expect(result.stderr).toContain(`relay on port ${port} isn't answering`)
      }))
    } finally {
      server.closeAllConnections()
      server.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 12_000)

  test("--json before status exits 4 with pure JSON stdout and stderr line when relay is stopped", async () => {
    const port = await unusedPort()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-cli-contract-"))
    try {
      const run = spawnSync(process.execPath, [cliEntry, "--json", "status"], {
        env: { ...process.env, OPENCODE_BROWSER_HOME: home, OPENCODE_BROWSER_PORT: String(port), OPENCODE_BROWSER_UPDATE_CHECK: "0" },
        encoding: "utf8",
      })
      expect(run.status).toBe(ExitCode.host)
      const parsed = JSON.parse(run.stdout) as { relay: { running: boolean } }
      expect(parsed.relay.running).toBe(false)
      expect(run.stderr).toContain("browse:")
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test("invalid CLI flags exit 2 with a JSON failure envelope in --json mode", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-cli-usage-"))
    try {
      const run = spawnSync(process.execPath, [cliEntry, "--json", "status", "--not-a-real-flag"], {
        env: { ...process.env, OPENCODE_BROWSER_HOME: home, OPENCODE_BROWSER_UPDATE_CHECK: "0" },
        encoding: "utf8",
      })
      expect(run.status).toBe(ExitCode.usage)
      const parsed = JSON.parse(run.stdout) as { ok: boolean; error: { code: string; exitCode: number } }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toMatchObject({ code: "usage", exitCode: 2 })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test("execute defaults to oc-$OPENCODE_SESSION_ID (lowercased) and supports --rm and --timeout-ms", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-cli-exec-"))
    fs.writeFileSync(path.join(home, "relay-token"), "test-token", { mode: 0o600 })
    const bodies: Array<Record<string, unknown>> = []
    const session = {
      id: "oc-ses_mixed123",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      connected: true,
      pageUrl: null,
      stateKeys: [],
    }
    const server = http.createServer((req, res) => {
      let raw = ""
      req.on("data", (chunk) => { raw += chunk })
      req.on("end", () => {
        res.setHeader("content-type", "application/json")
        if (req.url === "/version") {
          res.end(JSON.stringify({ version: opencodeBrowserVersion, buildId: opencodeBrowserBuildId }))
          return
        }
        if (req.url === "/extension/status") {
          res.end(JSON.stringify({ connected: true, version: opencodeBrowserVersion, activeTargets: 0 }))
          return
        }
        if (req.url === "/cli/execute") {
          bodies.push(JSON.parse(raw) as Record<string, unknown>)
          res.end(JSON.stringify({ text: "ok", value: "ok", isError: false, logs: [], session }))
          return
        }
        res.statusCode = 404
        res.end(JSON.stringify({ error: "not found" }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as net.AddressInfo).port
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_BROWSER_HOME: home,
      OPENCODE_BROWSER_PORT: String(port),
      OPENCODE_BROWSER_UPDATE_CHECK: "0",
      OPENCODE_SESSION_ID: "ses_Mixed123",
    }
    delete baseEnv.OPENCODE_BROWSER_SESSION
    try {
      const def = await execFileAsync(process.execPath, [cliEntry, "execute", "--timeout-ms", "15000", "return 1"], { env: baseEnv, encoding: "utf8" })
      expect(def.stdout.trim()).toBe("ok")
      expect(bodies[0]).toEqual({
        sessionId: "oc-ses_mixed123",
        code: "return 1",
        createIfMissing: true,
        timeoutMs: 15000,
      })

      const oneShot = await execFileAsync(process.execPath, [cliEntry, "execute", "--rm", "return 1"], { env: baseEnv, encoding: "utf8" })
      expect(oneShot.stdout.trim()).toBe("ok")
      expect(bodies[1]).toEqual({
        code: "return 1",
        createIfMissing: true,
        removeAfterExecute: true,
      })
      expect(oneShot.stderr).not.toContain("Continue with --session")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
