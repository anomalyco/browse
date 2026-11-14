import { afterAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { NodeHttpClient } from "@effect/platform-node"
import { Effect } from "effect"
import { bundleCli } from "../bundle.ts"
import * as RelayClient from "../src/relay/client.ts"
import { ensureRelay, olderMcpClientAdvice, relayBuildProblem } from "../src/relay/lifecycle.ts"
import { freePort } from "./support/ports.ts"

// After an automatic update the relay runs the new build while a running MCP server keeps its old one. The relay keeps
// serving the older client; only a request it can no longer decode asks the agent to reconnect browse.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-old-client-"))
const previous = {
  home: process.env.HOME,
  browseHome: process.env.OPENCODE_BROWSER_HOME,
  port: process.env.OPENCODE_BROWSER_PORT,
}
process.env.HOME = home
process.env.OPENCODE_BROWSER_HOME = home
let relay: ChildProcess | undefined

afterAll(() => {
  relay?.kill()
  for (const [name, value] of [["HOME", previous.home], ["OPENCODE_BROWSER_HOME", previous.browseHome], ["OPENCODE_BROWSER_PORT", previous.port]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(home, { recursive: true, force: true })
})

const NEW_BUILD = "2026-11-02T00:00:00.000Z"
const OLD_CLIENT = "2026-11-01T00:00:00.000Z"

describe("old MCP client against a newer relay", () => {
  test("the build check accepts a newer relay and the relay answers the old client", async () => {
    const port = await freePort()
    const entry = await bundleCli({ outdir: path.join(home, "dist"), version: "0.0.1", buildId: NEW_BUILD })
    fs.symlinkSync(path.join(import.meta.dir, "../node_modules"), path.join(home, "node_modules"), "junction")
    process.env.OPENCODE_BROWSER_PORT = String(port)
    relay = spawn(process.execPath, [entry, "serve"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        OPENCODE_BROWSER_HOME: home,
        OPENCODE_BROWSER_PORT: String(port),
        OPENCODE_BROWSER_UPDATE_CHECK: "0",
      },
      stdio: "ignore",
    })
    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await fetch(`http://127.0.0.1:${port}/version`).then((response) => response.ok, () => false)
      if (ready) break
      await Bun.sleep(100)
    }

    await Effect.runPromise(Effect.gen(function* () {
      const client = yield* RelayClient.make({ endpoint: `http://127.0.0.1:${port}` })
      // The MCP server this test speaks for was built before the relay it finds.
      const readiness = yield* ensureRelay({ relay: client, buildId: OLD_CLIENT, retryTimes: 1 })
      expect(readiness.buildProblem).toBeUndefined()
      expect(readiness.version.buildId).toBe(NEW_BUILD)
      // A normal request of that older build still works.
      expect(yield* client.sessions).toEqual([])
      // When a request no longer decodes, the tool call says to reconnect browse rather than repeat a wire error.
      const advice = olderMcpClientAdvice(readiness.version, new RelayClient.RelayDecodeFailed({
        message: "Relay returned an unreadable response for /tabs/cleanup",
        path: "/tabs/cleanup",
        cause: null,
      }), OLD_CLIENT)
      expect(advice).toContain("browse was updated")
      expect(advice).toContain("/mcps")
      // A semantic error is the tool's own, not an update.
      expect(olderMcpClientAdvice(readiness.version, new RelayClient.RelayRejected({
        message: "Session not found: x", status: 404, path: "/cli/execute", code: "session-not-found",
      }), OLD_CLIENT)).toBeUndefined()
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)))
  }, 30_000)

  test("build ids order the check: a newer relay is fine, an older one still asks for a restart", () => {
    expect(relayBuildProblem({ version: "1.0.0", buildId: NEW_BUILD }, OLD_CLIENT)).toBeUndefined()
    expect(relayBuildProblem({ version: "1.0.0", buildId: OLD_CLIENT }, NEW_BUILD)).toContain("does not match")
    expect(relayBuildProblem({ version: "1.0.0" }, OLD_CLIENT)).toContain("does not report a build id")
  })
})
