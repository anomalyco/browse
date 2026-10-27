import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { installedRuntime, locateExtension, waitForExtension, type Browser, type Detection, type LocateOptions } from "../src/setup.ts"

const browser = (name: string): Browser => ({ name, userData: `/data/${name}`, manifests: [], defaultIDs: [], executables: [] })
const chrome = browser("Google Chrome")
const edge = browser("Microsoft Edge")
const none = (target: Browser): Detection => ({ browser: target, blocked: false, enabled: [], disabled: [] })
const folder = "/src/browse/dist"

/** Runs locateExtension with recording effects: nothing real is opened, revealed or copied. */
function run(overrides: Partial<LocateOptions> = {}, results: { open?: boolean } = {}) {
  const calls: { open: [string, string][]; reveal: string[]; copy: string[] } = { open: [], reveal: [], copy: [] }
  const lines: string[] = []
  const options: LocateOptions = {
    allowOpen: true,
    connected: false,
    folder,
    detections: [none(chrome)],
    preferred: chrome,
    env: { ssh: false, display: true, tty: true, platform: "darwin" },
    storeListed: false,
    ...overrides,
  }
  const outcome = locateExtension(options, {
    open: (target, url) => (calls.open.push([target.name, url]), results.open ?? true),
    reveal: (dir) => (calls.reveal.push(dir), true),
    copy: (text) => (calls.copy.push(text), true),
    log: (line) => lines.push(line),
  })
  return { outcome, calls, output: lines.join("\n") }
}

describe("install without the extension, before the store listing", () => {
  test("opens the extensions page, reveals the folder and copies its path", () => {
    const { outcome, calls, output } = run()
    expect(outcome).toBe("guided")
    expect(calls).toEqual({ open: [["Google Chrome", "chrome://extensions"]], reveal: [folder], copy: [folder] })
    expect(output).toContain("Open chrome://extensions in Google Chrome (opened)")
    expect(output).toContain("Developer mode")
    expect(output).toContain("Load unpacked")
    expect(output).toContain(`${folder} (shown in Finder)`)
    expect(output).toContain("Cmd+Shift+G")
    expect(output).toContain("Restart opencode")
    expect(output).not.toContain("chromewebstore")
  })

  test("uses the browser's own scheme for its extensions page", () => {
    const { calls, output } = run({ detections: [none(chrome), none(edge)], preferred: edge })
    expect(calls.open).toEqual([["Microsoft Edge", "edge://extensions"]])
    expect(output).toContain("Open edge://extensions in Microsoft Edge (opened)")
  })

  test("falls back to the first detected browser when the default isn't a known Chromium", () => {
    expect(run({ preferred: undefined }).calls.open).toEqual([["Google Chrome", "chrome://extensions"]])
  })

  test("doesn't claim the page opened when the browser couldn't be launched", () => {
    const { output } = run({}, { open: false })
    expect(output).toContain("Open chrome://extensions in Google Chrome")
    expect(output).not.toContain("(opened)")
  })

  test.each([
    ["--no-open", { allowOpen: false }],
    ["no terminal", { env: { ssh: false, display: true, tty: false, platform: "darwin" as const } }],
    ["no display", { env: { ssh: false, display: false, tty: true, platform: "linux" as const } }],
  ])("only prints the steps with %s", (_, overrides) => {
    const { outcome, calls, output } = run(overrides)
    expect(outcome).toBe("guided")
    expect(calls).toEqual({ open: [], reveal: [], copy: [] })
    expect(output).toContain(folder)
    expect(output).not.toContain("(opened)")
    expect(output).not.toContain("copied")
  })

  test("over SSH, prints the steps without scanning or opening anything", () => {
    const { calls, output } = run({ env: { ssh: true, display: true, tty: true, platform: "linux" } })
    expect(calls).toEqual({ open: [], reveal: [], copy: [] })
    expect(output).not.toContain("Default browser")
    expect(output).toContain("Load unpacked")
    expect(output).toContain(folder)
  })

  test("doesn't open anything when a browser couldn't be checked and may already have it", () => {
    const { calls, output } = run({ detections: [none(chrome), { ...none(edge), blocked: true }] })
    expect(calls).toEqual({ open: [], reveal: [], copy: [] })
    expect(output).toContain("Already loaded in Microsoft Edge?")
  })

  test("with no Chromium browser found, names the page without opening it", () => {
    const { calls, output } = run({ detections: [], preferred: undefined })
    expect(calls.open).toEqual([])
    expect(output).toContain("Open chrome://extensions (or your browser's extensions page)")
  })
})

describe("install with the extension", () => {
  test("a connected extension is ready", () => {
    const { outcome, calls } = run({ connected: true })
    expect(outcome).toBe("ready")
    expect(calls).toEqual({ open: [], reveal: [], copy: [] })
  })

  test("an installed extension is ready even before the relay runs", () => {
    const match = { browser: chrome, profile: { dir: "Default", name: "Person 1" }, id: "afeafocngkodbmaipcngoamamfmekgfo" }
    const { outcome, output } = run({ detections: [{ ...none(chrome), enabled: [match] }] })
    expect(outcome).toBe("ready")
    expect(output).toContain("Person 1 (unpacked)")
  })

  test("a turned-off extension is reported, not reinstalled", () => {
    const match = { browser: chrome, profile: { dir: "Default", name: "Person 1" }, id: "afeafocngkodbmaipcngoamamfmekgfo" }
    const { outcome, calls, output } = run({ detections: [{ ...none(chrome), disabled: [match] }] })
    expect(outcome).toBe("off")
    expect(calls.open).toEqual([])
    expect(output).toContain("turned off in Google Chrome (Person 1)")
  })
})

test("once the store listing is live, opens the listing instead", () => {
  const { calls, output } = run({ storeListed: true })
  expect(calls.open).toHaveLength(1)
  expect(calls.open[0]![1]).toStartWith("https://chromewebstore.google.com/")
  expect(calls.reveal).toEqual([])
  expect(output).toContain("Chrome Web Store (opened in Google Chrome)")
})

describe("waiting for the extension", () => {
  const instant = async () => {}

  test("returns as soon as it connects", async () => {
    let polls = 0
    const connected = await waitForExtension({ connected: async () => ++polls === 3, timeoutMs: 10_000, intervalMs: 1_000, sleep: instant })
    expect(connected).toBe(true)
    expect(polls).toBe(3)
  })

  test("gives up after the timeout", async () => {
    let polls = 0
    const connected = await waitForExtension({ connected: async () => (polls++, false), timeoutMs: 5_000, intervalMs: 1_000, sleep: instant })
    expect(connected).toBe(false)
    expect(polls).toBe(6)
  })
})

describe("status recognises the install", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-setup-"))
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  const checkout = path.join(root, "browse", "cli")
  const entry = path.join(checkout, "dist", "cli.mjs")
  fs.mkdirSync(path.join(checkout, "dist"), { recursive: true })
  fs.mkdirSync(path.join(checkout, "src"), { recursive: true })
  fs.writeFileSync(entry, "")
  fs.writeFileSync(path.join(checkout, "src", "main.ts"), "")
  fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ version: "1.2.3" }))
  const server = { type: "local", command: ["/usr/bin/node", entry, "mcp"] }

  test("a checkout whose settings have no version, from the MCP server entry", () => {
    expect(installedRuntime({ opencode: "/bin/opencode" }, server)).toEqual({ entry, version: "1.2.3", source: true })
  })

  test("the version install recorded", () => {
    expect(installedRuntime({ entry, version: "0.0.9" }, undefined)).toEqual({ entry, version: "0.0.9", source: true })
  })

  test("nothing installed", () => {
    expect(installedRuntime(undefined, undefined)).toBeUndefined()
    expect(installedRuntime({ opencode: "/bin/opencode" }, { command: ["/usr/bin/node", path.join(root, "gone", "cli.mjs"), "mcp"] })).toBeUndefined()
  })
})
