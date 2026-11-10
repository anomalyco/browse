import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { configuredExecuteTimeoutMs } from "../src/relay.ts"

const read = (env: Record<string, string>): number | undefined =>
  Effect.runSync(Effect.provide(configuredExecuteTimeoutMs, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))

describe("the relay's execute timeout", () => {
  // The 60s default is session-manager's: an unset variable must not reach the hook as a chosen timeout, or every
  // execute would raise Playwright's 30s action timeout with it.
  test("is unset when OPENCODE_BROWSER_EXECUTE_TIMEOUT_MS is unset", () => {
    expect(read({})).toBeUndefined()
  })

  test("reads OPENCODE_BROWSER_EXECUTE_TIMEOUT_MS when the relay is given one", () => {
    expect(read({ OPENCODE_BROWSER_EXECUTE_TIMEOUT_MS: "120000" })).toBe(120_000)
    expect(read({ OPENCODE_BROWSER_EXECUTE_TIMEOUT_MS: "0" })).toBe(0)
  })
})
