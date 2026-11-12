import { expect, test } from "bun:test"
import { extensionConnectedCheck } from "../src/doctor.ts"
import type { ConnectedBrowser, ExtensionStatus } from "../src/relay/schema.ts"

function status(overrides: Partial<ExtensionStatus>): ExtensionStatus {
  return { connected: false, version: null, activeTargets: 0, ...overrides }
}

function browser(id: string, overrides: Partial<ConnectedBrowser> = {}): ConnectedBrowser {
  return { id, name: id, default: false, connected: true, version: null, tabs: 0, ...overrides }
}

function check(value: ExtensionStatus) {
  return extensionConnectedCheck({ ok: true, value })
}

test("a connected browser with a healthy default is ok", () => {
  const result = check(status({ connected: true, version: "1.2.3", browsers: [browser("chrome-mac", { default: true })] }))
  expect(result).toMatchObject({ id: "extension-connected", status: "ok", message: "connected (1.2.3)" })
})

test("a connected browser notes another browser that isn't answering", () => {
  const result = check(status({
    connected: true,
    version: "1.2.3",
    browsers: [browser("chrome-mac", { default: true }), browser("chrome-windows", { connected: false, unresponsive: true })],
  }))
  expect(result).toMatchObject({
    status: "warn",
    message: "connected (1.2.3); chrome-windows isn't answering (busy or asleep)",
  })
})

test("an unresponsive browser with nothing connected warns instead of failing", () => {
  const result = check(status({ browsers: [browser("chrome-windows", { connected: false, unresponsive: true })] }))
  expect(result).toMatchObject({ status: "warn", message: "connected but not answering (busy or asleep)" })
})

test("no connected or unresponsive browser is a failure", () => {
  expect(check(status({ browsers: [] }))).toMatchObject({ status: "fail", message: "disconnected" })
  expect(check(status({}))).toMatchObject({ status: "fail", message: "disconnected" })
})

test("a failed status probe fails with its error", () => {
  const result = extensionConnectedCheck({ ok: false, error: "relay unreachable" })
  expect(result).toMatchObject({ status: "fail", message: "relay unreachable" })
})
