import util from "node:util"
import { Predicate } from "effect"
import type { ExecuteAftermath, ExecuteLogEntry, ExecuteLogSummary } from "../relay-schema.ts"

const maxCapturedPageLogs = 50
const maxCapturedScriptLogs = 100

export type ExecuteLogCaptureSnapshot = {
  readonly logs: readonly ExecuteLogEntry[]
  readonly summary: ExecuteLogSummary
  readonly consoleErrorCount: number
  readonly pageErrorCount: number
}

export function createExecuteLogCapture(limits: {
  readonly page?: number
  readonly script?: number
} = {}): {
  readonly add: (entry: ExecuteLogEntry) => void
  readonly snapshot: () => ExecuteLogCaptureSnapshot
} {
  const pageLimit = limits.page ?? maxCapturedPageLogs
  const scriptLimit = limits.script ?? maxCapturedScriptLogs
  const logs: ExecuteLogEntry[] = []
  const pageEntryIndexes = new Map<string, number>()
  let pageEntries = 0
  let scriptEntries = 0
  let totalCount = 0
  let repeatedCount = 0
  let omittedCount = 0
  let consoleErrorCount = 0
  let pageErrorCount = 0

  const add = (entry: ExecuteLogEntry): void => {
    totalCount += 1
    if (entry.type === "error") {
      consoleErrorCount += 1
    } else if (entry.type === "pageerror") {
      pageErrorCount += 1
    }

    if (entry.source === "page") {
      const key = pageLogKey(entry)
      const existingIndex = pageEntryIndexes.get(key)
      if (existingIndex !== undefined) {
        const existing = logs[existingIndex]
        if (existing) {
          logs[existingIndex] = { ...existing, repeatCount: (existing.repeatCount ?? 0) + 1 }
          repeatedCount += 1
          return
        }
      }
      if (pageEntries >= pageLimit) {
        omittedCount += 1
        return
      }
      pageEntryIndexes.set(key, logs.length)
      pageEntries += 1
      logs.push(entry)
      return
    }

    if (scriptEntries >= scriptLimit) {
      omittedCount += 1
      return
    }
    scriptEntries += 1
    logs.push(entry)
  }

  return {
    add,
    snapshot: () => ({
      logs: [...logs],
      summary: {
        totalCount,
        returnedCount: logs.length,
        repeatedCount,
        omittedCount,
      },
      consoleErrorCount,
      pageErrorCount,
    }),
  }
}

function pageLogKey(entry: ExecuteLogEntry): string {
  const routineCategory = routinePageLogCategory(entry)
  if (routineCategory) {
    return JSON.stringify([entry.type, routineCategory])
  }
  return JSON.stringify([
    entry.type,
    entry.text,
    entry.location?.url ?? null,
    entry.location?.lineNumber ?? null,
    entry.location?.columnNumber ?? null,
  ])
}

function routinePageLogCategory(entry: ExecuteLogEntry): string | undefined {
  if (entry.source !== "page") return undefined
  const text = entry.text.toLowerCase()
  if (/^(?:error with permissions-policy header|permissions-policy header warning|permissions policy violation|\[violation\] potential permissions policy violation)/.test(text)) {
    return "browser-permissions-policy"
  }
  if (!text.includes("err_blocked_by_client")) return undefined
  const resource = entry.location?.url.toLowerCase() ?? ""
  const analyticsMarkers = [
    "google-analytics.com",
    "googletagmanager.com",
    "doubleclick.net",
    "connect.facebook.net",
    "/analytics",
    "analytics.",
  ]
  return analyticsMarkers.some((marker) => resource.includes(marker)) ? "blocked-analytics-resource" : undefined
}

export function emptyExecuteLogSummary(): ExecuteLogSummary {
  return {
    totalCount: 0,
    returnedCount: 0,
    repeatedCount: 0,
    omittedCount: 0,
  }
}

export function formatLogCompactionWarning(summary: ExecuteLogSummary): string | undefined {
  if (summary.repeatedCount === 0 && summary.omittedCount === 0) {
    return undefined
  }
  return `Captured ${summary.totalCount} console/page events: returned ${summary.returnedCount}, folded ${summary.repeatedCount} repeated page entries, and omitted ${summary.omittedCount} after limits (page=${maxCapturedPageLogs}, script=${maxCapturedScriptLogs}). Aftermath error counts include all events.`
}

const nodeOnlyGlobalPattern = /^(process|require|fs|os|http|https|child_process|fetch|module|__dirname|__filename) is not defined$/
const pageOnlyGlobalPattern = /^(window|document|localStorage|sessionStorage|location|navigator|getComputedStyle) is not defined$/

/** Explain failures caused by treating Node-side execute code as page code. */
export function formatNodeContextWarning(error: Error): string | undefined {
  const pageGlobal = error.name === "ReferenceError" ? pageOnlyGlobalPattern.exec(error.message)?.[1] : undefined
  if (pageGlobal) {
    return `Execute code runs in Node, where \`${pageGlobal}\` is undefined. Read page globals inside page.evaluate(() => ...).`
  }
  const nodeGlobal = error.name === "ReferenceError" ? nodeOnlyGlobalPattern.exec(error.message)?.[1] : undefined
  if (nodeGlobal) {
    return `Execute code runs in a sandbox without \`${nodeGlobal}\` (no process, require, fs, os, child_process, http/https or Node fetch). Save or read files with files.write(name, data) / files.read(path), fetch through page.evaluate(() => fetch(...)), or ask the user to set OPENCODE_BROWSER_ALLOW_NODE=1 on the relay for full Node access.`
  }
  if (error.name === "TypeError" && error.message.startsWith("Failed to parse URL from ")) {
    return "Execute code runs in Node, so fetch has no page origin or cookies. Use page.evaluate(() => fetch(...)) for same-origin requests."
  }
  if (error.name === "TypeError" && /The "cb" argument must be of type function/i.test(error.message)) {
    return "The execute `fs` alias is callback-style `node:fs`; use `await fs.promises.writeFile(...)` / `await fs.promises.readFile(...)` or `fs.writeFileSync(...)`."
  }
  return undefined
}

const pointerInterceptionPattern = /(<[a-zA-Z][^>\n]*>[^\n]*?)\s+intercepts pointer events/
const locatorFailurePattern = /waiting for locator\(|waiting for getBy|strict mode violation:/i

/** Extract the covering element when Playwright times out because another element intercepts pointer events. */
export function formatPointerInterceptionWarning(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const blocker = pointerInterceptionPattern.exec(error.message)?.[1]
  if (!blocker) return undefined
  return `Pointer action was blocked because ${blocker} intercepts pointer events. Dismiss the covering dialog/banner or scroll the target clear of sticky chrome instead of retrying the same click.`
}

function formatBoundedPageUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    return parsed.origin === "null" ? rawUrl.slice(0, 96) : `${parsed.origin}${parsed.pathname}`.slice(0, 120)
  } catch {
    return rawUrl.slice(0, 96)
  }
}

export function formatLocatorFailurePageWarning(
  error: unknown,
  aftermath: ExecuteAftermath | undefined,
  recreatedFromClosedUrl?: string,
): string | undefined {
  if (!(error instanceof Error) || !locatorFailurePattern.test(error.message)) return undefined
  const rawUrl = aftermath?.endUrl ?? aftermath?.startUrl
  if (rawUrl !== "about:blank") return undefined
  if (recreatedFromClosedUrl) {
    return `Locator failed on about:blank because the previous session page (${formatBoundedPageUrl(recreatedFromClosedUrl)}) was closed. Call page.goto(...) to reopen it before querying controls.`
  }
  return "Locator failed on page about:blank. Navigate with page.goto(...) or adopt an attached tab before querying controls."
}

export function createSandboxConsole(options: { readonly addLog: (entry: ExecuteLogEntry) => void }): Pick<Console, "debug" | "error" | "info" | "log" | "warn"> {
  const capture = (type: ExecuteLogEntry["type"], values: readonly unknown[]) => {
    options.addLog({
      source: "script",
      type,
      text: values.map(formatLogValue).join(" "),
    })
  }
  return {
    debug: (...values: readonly unknown[]) => {
      capture("debug", values)
    },
    error: (...values: readonly unknown[]) => {
      capture("error", values)
    },
    info: (...values: readonly unknown[]) => {
      capture("info", values)
    },
    log: (...values: readonly unknown[]) => {
      capture("log", values)
    },
    warn: (...values: readonly unknown[]) => {
      capture("warn", values)
    },
  }
}

function formatLogValue(value: unknown): string {
  if (Predicate.isString(value)) {
    return value
  }
  return util.inspect(value, { depth: 4, colors: false, maxArrayLength: 100, maxStringLength: 1000 })
}
