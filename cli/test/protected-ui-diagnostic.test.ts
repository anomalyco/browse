import { expect, test } from "bun:test"
import { isMaskedProtectedUiFailure } from "../src/execute/page-recovery.ts"

const destroyed = new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation")
const aftermath = (startUrl: string, endUrl: string, navigations: string[] = []) => ({
  startUrl,
  endUrl,
  navigations,
  consoleErrorCount: 0,
  pageErrorCount: 0,
  handoffs: 0,
})

test("a lost context on a page that stayed put is put down to the protected extension UI", () => {
  expect(isMaskedProtectedUiFailure(destroyed, aftermath("https://app.deel.com/login", "https://app.deel.com/login"))).toBe(true)
  expect(isMaskedProtectedUiFailure(destroyed)).toBe(true)
})

test("a lost context after the page redirected is the redirect, not the protected extension UI", () => {
  expect(isMaskedProtectedUiFailure(destroyed, aftermath("https://app.deel.com/benefits", "https://app.deel.com/login", ["https://app.deel.com/login"]))).toBe(false)
})
