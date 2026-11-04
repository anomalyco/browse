import { describe, expect, test } from "bun:test"
import {
  extensionConnectionCheck,
  formatBrowserList,
  formatBrowserSummary,
  formatDoctorReport,
  type DoctorReport,
} from "../src/doctor.ts"
import type { ConnectedBrowser, ExtensionStatus } from "../src/relay/schema.ts"

const browser = (overrides: Partial<ConnectedBrowser> = {}): ConnectedBrowser => ({
  id: "chrome-laptop",
  name: "Chrome",
  default: false,
  connected: true,
  version: "0.0.5",
  tabs: 3,
  ...overrides,
})

const status = (overrides: Partial<ExtensionStatus> = {}): ExtensionStatus => ({
  connected: true,
  version: "0.0.5",
  activeTargets: 0,
  ...overrides,
})

const report = (browsers: DoctorReport["extension"]["browsers"]): DoctorReport => ({
  status: "ok",
  endpoint: "http://127.0.0.1:19988",
  cli: { version: "0.0.5", buildId: "build-1" },
  package: {
    path: "/browse/package.json",
    name: "@opencode/browse",
    version: "0.0.5",
    bin: { opencodeBrowser: true },
    error: null,
  },
  relay: { reachable: true, version: "0.0.5", buildId: "build-1", buildMatches: true, error: null },
  extension: {
    connected: true,
    version: "0.0.5",
    expectedVersion: "0.0.5",
    versionMatches: true,
    protocolVersion: 2,
    expectedProtocolVersion: 2,
    protocolCompatible: true,
    protocolLegacy: false,
    rejectedConnections: 0,
    browsers,
    error: null,
  },
  targets: { active: 0, child: 0, relayOwned: [], unhealthy: [], all: [], error: null },
  sessions: { current: null, staleCurrent: false, possibleLeaked: [], all: [], error: null },
  artifacts: [],
  update: null,
  checks: [],
  recommendations: [],
})

describe("formatBrowserList", () => {
  test("an absent or empty browser list prints nothing", () => {
    expect(formatBrowserList(undefined)).toEqual([])
    expect(formatBrowserList([])).toEqual([])
  })

  test("one unmarked browser is printed as the default", () => {
    expect(formatBrowserList([browser()])).toEqual([
      "Browsers:",
      "- chrome-laptop (Chrome, default) 3 tabs",
    ])
  })

  test("a browser the relay marks default wins over the first entry", () => {
    const browsers = [
      browser(),
      browser({ id: "brave-home", name: "Brave Home", default: true, tabs: 0 }),
    ]
    expect(formatBrowserList(browsers)).toEqual([
      "Browsers:",
      "- chrome-laptop (Chrome) 3 tabs",
      "- brave-home (Brave Home, default) 0 tabs",
    ])
  })

  test("two marked defaults keep only the first", () => {
    const lines = formatBrowserList([
      browser({ default: true }),
      browser({ id: "brave-home", name: "Brave Home", default: true }),
    ])
    expect(lines.filter((line) => line.includes(", default"))).toEqual([
      "- chrome-laptop (Chrome, default) 3 tabs",
    ])
  })

  test("tab counts are pluralized and omitted when unreported", () => {
    expect(formatBrowserList([browser({ tabs: 1 })])[1]).toBe("- chrome-laptop (Chrome, default) 1 tab")
    expect(formatBrowserList([browser({ tabs: 0 })])[1]).toBe("- chrome-laptop (Chrome, default) 0 tabs")
    expect(formatBrowserList([{ id: "chrome-laptop", name: "Chrome" }])[1]).toBe(
      "- chrome-laptop (Chrome, default)",
    )
  })

  test("a starting browser is marked and an empty name falls back to the id", () => {
    expect(formatBrowserList([browser({ connected: false })])[1]).toBe(
      "- chrome-laptop (Chrome, default, starting) 3 tabs",
    )
    expect(formatBrowserList([browser({ name: "" })])[1]).toBe(
      "- chrome-laptop (chrome-laptop, default) 3 tabs",
    )
  })
})

describe("formatBrowserSummary", () => {
  test("an absent or empty browser list has no summary", () => {
    expect(formatBrowserSummary(undefined)).toBe("")
    expect(formatBrowserSummary([])).toBe("")
  })

  test("one browser names it as the default", () => {
    expect(formatBrowserSummary([browser()])).toBe("1 browser (default chrome-laptop)")
  })

  test("several browsers count them and name the same default the list marks", () => {
    const browsers = [
      browser({ id: "chrome-laptop", name: "Chrome" }),
      browser({ id: "work-chrome", name: "Work Chrome", default: true }),
      browser({ id: "brave-home", name: "Brave Home", tabs: 0 }),
    ]
    expect(formatBrowserSummary(browsers)).toBe("3 browsers (default work-chrome)")
    const marked = formatBrowserList(browsers).filter((line) => line.includes(", default"))
    expect(marked).toHaveLength(1)
    expect(marked[0]?.startsWith("- work-chrome (")).toBe(true)
  })

  test("without a marked default the first entry is named", () => {
    expect(formatBrowserSummary([browser(), browser({ id: "work-chrome", name: "Work Chrome" })])).toBe(
      "2 browsers (default chrome-laptop)",
    )
  })
})

describe("extensionConnectionCheck", () => {
  test("an unreachable relay fails with its error", () => {
    expect(extensionConnectionCheck({ ok: false, error: "relay unreachable" })).toEqual({
      id: "extension-connected",
      label: "extension connection",
      status: "fail",
      message: "relay unreachable",
    })
  })

  test("a disconnected extension fails", () => {
    const check = extensionConnectionCheck({ ok: true, value: status({ connected: false }) })
    expect(check.status).toBe("fail")
    expect(check.message).toBe("disconnected")
  })

  test("the message counts browsers and names the default", () => {
    const check = extensionConnectionCheck({
      ok: true,
      value: status({
        browsers: [
          browser({ id: "chrome-laptop", name: "Chrome" }),
          browser({ id: "work-chrome", name: "Work Chrome", default: true }),
        ],
      }),
    })
    expect(check.status).toBe("ok")
    expect(check.message).toBe("connected (0.0.5), 2 browsers (default work-chrome)")
  })

  test("no browsers leaves the message as it was", () => {
    const check = extensionConnectionCheck({ ok: true, value: status({ version: null }) })
    expect(check.message).toBe("connected")
  })
})

describe("formatDoctorReport browsers", () => {
  test("the block sits between the extension summary and the targets", () => {
    const lines = formatDoctorReport(
      report([
        browser({ id: "chrome-laptop", name: "Chrome" }),
        browser({ id: "work-chrome", name: "Work Chrome", default: true, tabs: 1 }),
      ]),
    ).split("\n")
    const block = lines.indexOf("Browsers:")
    expect(block).toBeGreaterThan(0)
    expect(lines[block - 1]?.startsWith("Extension: ")).toBe(true)
    expect(lines[block + 1]).toBe("- chrome-laptop (Chrome) 3 tabs")
    expect(lines[block + 2]).toBe("- work-chrome (Work Chrome, default) 1 tab")
    expect(lines[block + 3]?.startsWith("Targets: ")).toBe(true)
  })

  test("no browsers keeps today's output", () => {
    expect(formatDoctorReport(report([])).split("\n")).not.toContain("Browsers:")
  })
})
