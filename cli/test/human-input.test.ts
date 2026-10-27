import { afterEach, describe, expect, test } from "bun:test"
import { beforeInput, humanInputEnabled, setHumanInput } from "../src/human-input.ts"

// Human-like input follows the extension's setting from the next input, without a relay restart, and
// OPENCODE_BROWSER_HUMAN_INPUT overrides it either way.

const original = process.env.OPENCODE_BROWSER_HUMAN_INPUT
afterEach(() => {
  setHumanInput(undefined)
  if (original === undefined) delete process.env.OPENCODE_BROWSER_HUMAN_INPUT
  else process.env.OPENCODE_BROWSER_HUMAN_INPUT = original
})

let nextTab = 1
/** Two clicks' worth of pointer moves far apart; returns the extra events human-like input sent and how long it took. */
async function move() {
  const tabId = nextTab++
  const sent: string[] = []
  const send = async (method: string) => {
    sent.push(method)
    return {}
  }
  const started = Date.now()
  await beforeInput(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 10 }, true, send)
  await beforeInput(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 400 }, true, send)
  return { sent: sent.length, ms: Date.now() - started }
}

describe("human-like input", () => {
  test("is on by default: a move becomes a path of intermediate moves", async () => {
    delete process.env.OPENCODE_BROWSER_HUMAN_INPUT
    expect(humanInputEnabled()).toBe(true)
    expect((await move()).sent).toBeGreaterThan(5)
  })

  test("turned off at runtime, the next move goes straight through, and back on it paces again", async () => {
    delete process.env.OPENCODE_BROWSER_HUMAN_INPUT
    setHumanInput(false)
    const off = await move()
    expect(off.sent).toBe(0)
    expect(off.ms).toBeLessThan(50)
    setHumanInput(true)
    expect((await move()).sent).toBeGreaterThan(5)
  })

  test("OPENCODE_BROWSER_HUMAN_INPUT overrides the setting both ways", async () => {
    process.env.OPENCODE_BROWSER_HUMAN_INPUT = "0"
    setHumanInput(true)
    expect(humanInputEnabled()).toBe(false)
    expect((await move()).sent).toBe(0)
    process.env.OPENCODE_BROWSER_HUMAN_INPUT = "1"
    setHumanInput(false)
    expect(humanInputEnabled()).toBe(true)
    expect((await move()).sent).toBeGreaterThan(5)
  })
})
