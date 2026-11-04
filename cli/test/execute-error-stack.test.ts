import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { ExecuteRealm } from "../src/execute-realm.ts"
import { executeFilename, userCodeStack } from "../src/execute/code-runner.ts"

const message = "locator.click: Timeout 1000ms exceeded.\nCall log:\n  - waiting for locator('#nope')\n"

function expectOnlyUserFrames(text: string) {
  expect(text).toContain(message.trimEnd())
  expect(text).toMatch(/^ {4}at .*execute\.js:\d+:\d+\)?$/m)
  expect(text.split("\n").filter((line) => /^\s+at /.test(line)).every((line) => line.includes("execute.js:"))).toBe(true)
  expect(text).not.toContain("evalmachine")
  expect(text).not.toContain(import.meta.dir)
}

describe("userCodeStack", () => {
  test("keeps the message, call log and the agent's frame from a relay stack", () => {
    const error = new Error("locator.click: Timeout 1000ms exceeded.")
    error.stack = `${message}
    at Object.apply (/Users/me/.cache/@opencode/browse/dist/relay-ns525pms.mjs:8643:28)
    at execute.js:5:43
    at /Users/me/.cache/@opencode/browse/dist/relay-ns525pms.mjs:8391:36
    at evalmachine.<anonymous>:1:156
    at ExecuteRealm.run (/Users/me/.cache/@opencode/browse/dist/relay-ns525pms.mjs:8388:27)
    at runUserCode (/Users/me/.cache/@opencode/browse/dist/relay-ns525pms.mjs:10742:34)
    at node:internal/process/task_queues:105:5`
    expect(userCodeStack(error)).toBe(`${message}\n    at execute.js:5:43`)
  })

  test("keeps just the message and call log when no frame is the agent's", () => {
    const error = new Error("locator.click: Timeout 1000ms exceeded.")
    error.stack = `${message}\n    at Object.apply (/Users/me/dist/relay.mjs:8643:28)\n    at evalmachine.<anonymous>:1:156`
    expect(userCodeStack(error)).toBe(message.trimEnd())
  })

  test("a host error thrown into realm code keeps the execute.js frame", async () => {
    const host = { click: () => { throw new Error(message) } }
    const error = await new ExecuteRealm()
      .run({ source: `(async (host) => {\n"use strict";\nhost.click()\n})`, filename: executeFilename, args: [host] })
      .catch((cause: Error) => cause)
    expectOnlyUserFrames(userCodeStack(error as Error))
  })

  test("under Node: realm code and full-Node code both keep the execute.js frame", () => {
    const script = `
      const { ExecuteRealm } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute-realm.ts"))})
      const executeFilename = ${JSON.stringify(executeFilename)}
      const message = ${JSON.stringify(message)}
      const host = { click: () => { throw new Error(message) } }
      const realm = await new ExecuteRealm().run({ source: '(async (host) => {\\n"use strict";\\nhost.click()\\n})', filename: executeFilename, args: [host] }).catch((e) => e)
      const AsyncFunction = async function () {}.constructor
      const full = await new AsyncFunction("host", "await 1\\nhost.click()\\n//# sourceURL=" + executeFilename)(host).catch((e) => e)
      console.log(JSON.stringify([realm.stack, full.stack]))
    `
    const child = spawnSync("node", ["--input-type=module", "--no-warnings", "-e", script], { encoding: "utf8", timeout: 30_000 })
    if (child.status !== 0) throw new Error(`node failed: ${child.stderr}`)
    const stacks = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "[]") as string[]
    expect(stacks).toHaveLength(2)
    for (const stack of stacks) {
      const error = new Error(message)
      error.stack = stack
      expectOnlyUserFrames(userCodeStack(error))
    }
  })
})
