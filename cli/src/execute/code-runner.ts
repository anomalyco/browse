import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import os from "node:os"
import * as acorn from "acorn"
import type { Browser, BrowserContext, ConsoleMessage, Frame, Locator, Page } from "patchright-core"
import { classifyChallenge, probePageScript, probeSelectors, type ChallengeOutcome, type ChallengeProbe } from "./challenge-detection.ts"
import type { DemonstrationResult } from "./demonstration.ts"
import { pageVisibleApiWarningForName, sandboxModules, type ExecuteFiles, type ExecuteRealm } from "../execute-realm.ts"
import type {
  GhostCursorCalloutOptions,
  GhostCursorCaptionOptions,
  GhostCursorClientOptions,
  GhostCursorSpotlightOptions,
  GhostCursorZoomOptions,
} from "../ghost-cursor.ts"
import type * as NetworkCapture from "../network-capture.ts"
import { PageConsole } from "./console.ts"
import type { ExecuteAftermath, ExecuteLogEntry, ExecuteLogSummary } from "../relay/schema.ts"
import type { ScreenshotDiffOptions, ScreenshotDiffResult } from "../snapshot/screenshot-diff.ts"
import type * as SiteSecrets from "../auth/site-secrets.ts"
import type {
  AriaSnapshotHelper,
  InputField,
  InputTarget,
  ScreenshotWithLabelsOptions,
  ScreenshotWithLabelsResult,
  SnapshotHelper,
  SnapshotRefHelper,
} from "../snapshot.ts"
import type { WebMcpHelper } from "./webmcp.ts"
import { createExecuteLogCapture, createSandboxConsole } from "./log-capture.ts"
import { delay, timedOut, withTimeout } from "./page-recovery.ts"
import { safePageUrl } from "./target-selection.ts"

// Full Node modules, only with OPENCODE_BROWSER_ALLOW_NODE=1. Sandboxed execute code gets sandboxModules.
export const nodeModules = { ...sandboxModules, fs, os, http, https }

export type TypeSecretOptions = {
  /** Clear the field first (default true). */
  readonly clear?: boolean
  /** How long to wait for the target element, in milliseconds (default 10000). */
  readonly timeout?: number
}

export type TypeSecretResult = { readonly typed: true; readonly name: string; readonly origin: string; readonly kind: SiteSecrets.SiteSecretKind }

export type HandoffCallOptions = {
  readonly timeoutMs?: number
  readonly page?: Page
  readonly start?: () => unknown | Promise<unknown>
}

export type ShowGhostCursorOptions = GhostCursorClientOptions & {
  readonly page?: Page
}

export type HideGhostCursorOptions = {
  readonly page?: Page
}

export type SandboxGlobals = {
  readonly browser: Browser
  readonly context: BrowserContext
  readonly page: Page
  readonly state: Record<string, unknown>
  readonly modules: Readonly<Record<string, unknown>>
  readonly files: ExecuteFiles
  readonly fillInput: (target: InputTarget, value: string) => Promise<void>
  readonly fillInputs: (page: Page, fields: ReadonlyArray<InputField>) => Promise<void>
  readonly screenshotWithLabels: (options?: ScreenshotWithLabelsOptions) => Promise<ScreenshotWithLabelsResult>
  readonly screenshotDiff: (options: ScreenshotDiffOptions) => Promise<ScreenshotDiffResult>
  readonly ariaSnapshot: AriaSnapshotHelper
  readonly snapshot: SnapshotHelper
  readonly ref: SnapshotRefHelper
  readonly webmcp: WebMcpHelper
  readonly showGhostCursor: (options?: ShowGhostCursorOptions) => Promise<void>
  readonly hideGhostCursor: (options?: HideGhostCursorOptions) => Promise<void>
  readonly ghostCursor: {
    readonly show: (options?: ShowGhostCursorOptions) => Promise<void>
    readonly hide: (options?: HideGhostCursorOptions) => Promise<void>
    readonly caption: (title: string | null, options?: GhostCursorCaptionOptions & { readonly page?: Page }) => Promise<void>
    readonly clearCaption: (options?: { readonly page?: Page }) => Promise<void>
    readonly callout: (target: Locator | string, label: string, options?: GhostCursorCalloutOptions & { readonly page?: Page }) => Promise<void>
    readonly clearCallouts: (options?: { readonly page?: Page }) => Promise<void>
    readonly zoom: (target: Locator | string | { readonly x: number; readonly y: number } | null, options?: GhostCursorZoomOptions & { readonly page?: Page }) => Promise<void>
    readonly resetZoom: (options?: { readonly durationMs?: number; readonly page?: Page }) => Promise<void>
    readonly spotlight: (target: Locator | string | null, options?: GhostCursorSpotlightOptions & { readonly page?: Page }) => Promise<void>
    readonly clearSpotlight: (options?: { readonly page?: Page }) => Promise<void>
    readonly keys: (keys: string | readonly string[], label?: string, options?: { readonly page?: Page }) => Promise<void>
  }
  readonly handoff: (message?: string, options?: HandoffCallOptions) => Promise<void>
  readonly demonstrate: (message?: string, options?: HandoffCallOptions) => Promise<DemonstrationResult>
  readonly network: {
    readonly start: (options?: NetworkCapture.NetworkCaptureOptions) => Promise<NetworkCapture.NetworkCaptureStatus>
    readonly status: () => NetworkCapture.NetworkCaptureStatus
    readonly stop: (options?: NetworkCapture.NetworkCaptureStopOptions) => Promise<NetworkCapture.NetworkCaptureResult>
    readonly cancel: () => Promise<{ readonly cancelled: boolean }>
  }
  readonly pageConsole: {
    readonly start: (page?: Page) => Promise<{ readonly capturing: boolean }>
    readonly stop: (page?: Page) => Promise<{ readonly capturing: boolean }>
  }
  readonly secrets: {
    readonly type: (target: Locator | string, name: string, options?: TypeSecretOptions) => Promise<TypeSecretResult>
  }
  readonly handoffTracker: { count: number }
}

export class ExecuteCodeError extends Error {
  constructor(
    readonly originalError: Error,
    readonly logs: readonly ExecuteLogEntry[],
    readonly logSummary: ExecuteLogSummary,
    readonly aftermath?: ExecuteAftermath,
  ) {
    super(originalError.message, { cause: originalError })
    this.name = originalError.name
    if (originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export const executeFilename = "execute.js"

const stackFramePattern = /^\s+at /
const userStackFramePattern = new RegExp(`[\\s(]${executeFilename.replace(".", "\\.")}:\\d+:\\d+\\)?$`)

/** The error's stack with only the frames in the agent's code: Browse's own frames are noise and leak install paths. */
export function userCodeStack(error: Error): string {
  if (!error.stack) return error.message
  return error.stack
    .split("\n")
    .filter((line) => !stackFramePattern.test(line) || userStackFramePattern.test(line))
    .join("\n")
    .trimEnd()
}

const challengeProbeTimeoutMs = 2_000
const challengePollMs = 1_000
const defaultChallengeWaitMs = 15_000
const maxTrackedNavigations = 25

/** How long execute waits for a non-interactive challenge to clear (OPENCODE_BROWSER_CHALLENGE_WAIT_MS, 0 to 60000). */
export function challengeWaitMs(): number {
  const value = Number(process.env.OPENCODE_BROWSER_CHALLENGE_WAIT_MS)
  return Number.isInteger(value) && value >= 0 && value <= 60_000 && process.env.OPENCODE_BROWSER_CHALLENGE_WAIT_MS !== "" ? value : defaultChallengeWaitMs
}

async function probeChallengePage(page: Page): Promise<ChallengeProbe | undefined> {
  if (page.isClosed()) return undefined
  const url = page.url()
  if (!/^https?:/i.test(url)) return undefined
  // Patchright evaluates in an isolated world: the page's scripts can't see the probe.
  const probed = await withTimeout(page.evaluate(probePageScript, [...probeSelectors]), challengeProbeTimeoutMs)
  if (probed === timedOut) return undefined
  return { ...probed, url: page.url(), frameUrls: page.frames().map((frame) => frame.url()).slice(0, 50) }
}

/** Classify the page; wait out a non-interactive challenge for up to `waitMs`. Undefined when there's none. */
export async function detectChallenge(page: Page, options: { readonly waitMs: number }): Promise<ChallengeOutcome | undefined> {
  const first = await probeChallengePage(page).catch(() => undefined)
  const detected = first && classifyChallenge(first)
  if (!first || !detected) return undefined
  const started = Date.now()
  let current = detected
  let url = first.url
  while (current.kind === "non-interactive" && Date.now() - started < options.waitMs) {
    await delay(Math.min(challengePollMs, Math.max(0, options.waitMs - (Date.now() - started))))
    if (page.isClosed()) return undefined
    // A probe that fails mid-navigation (the challenge often clears by navigating) counts as still waiting.
    const probe = await probeChallengePage(page).catch(() => null)
    if (probe === null) continue
    if (probe === undefined) return { ...current, status: "cleared", url, waitedMs: Date.now() - started, recommendation: "continue" }
    const next = classifyChallenge(probe)
    url = probe.url
    if (!next) return { ...current, status: "cleared", url, waitedMs: Date.now() - started, recommendation: "continue" }
    current = next
  }
  const waitedMs = current === detected && detected.kind !== "non-interactive" ? 0 : Date.now() - started
  return {
    ...current,
    status: "blocked",
    url,
    waitedMs,
    recommendation: current.kind === "block" ? "stop" : "handoff",
  }
}

/** Full-Node execute code bypasses the realm's call observer, so look for the page-visible APIs in its source. */
export function pageVisibleApiSourceWarnings(code: string): readonly string[] {
  const warnings: string[] = []
  for (const name of ["addInitScript", "exposeFunction", "exposeBinding"]) {
    if (new RegExp(`\\.${name}\\s*\\(`).test(code)) {
      const warning = pageVisibleApiWarningForName(name)
      if (warning) warnings.push(warning)
    }
  }
  return warnings
}

const sandboxGlobalKeys = [
  "browser",
  "context",
  "page",
  "state",
  "modules",
  "files",
  "fillInput",
  "fillInputs",
  "screenshotWithLabels",
  "screenshotDiff",
  "ariaSnapshot",
  "snapshot",
  "ref",
  "webmcp",
  "showGhostCursor",
  "hideGhostCursor",
  "ghostCursor",
  "handoff",
  "demonstrate",
  "network",
  "pageConsole",
  "secrets",
] as const satisfies readonly (keyof Omit<SandboxGlobals, "handoffTracker">)[]

export async function runUserCode({ code, globals, realm }: { readonly code: string; readonly globals: SandboxGlobals; readonly realm?: ExecuteRealm }): Promise<{
  readonly result: unknown
  readonly logs: readonly ExecuteLogEntry[]
  readonly logSummary: ExecuteLogSummary
  readonly aftermath: ExecuteAftermath
}> {
  const logCapture = createExecuteLogCapture()
  const navigations: string[] = []
  const onConsole = (message: ConsoleMessage) => {
    logCapture.add({
      source: "page",
      type: message.type(),
      text: message.text(),
      location: message.location(),
    })
  }
  const onPageError = (error: Error) => {
    logCapture.add({
      source: "page",
      type: "pageerror",
      text: error.stack ?? error.message,
    })
  }
  const onFrameNavigated = (frame: Frame) => {
    if (frame !== globals.page.mainFrame() || navigations.length >= maxTrackedNavigations) {
      return
    }
    navigations.push(frame.url())
  }
  const sandboxConsole = createSandboxConsole({ addLog: logCapture.add })
  const startUrl = safePageUrl(globals.page)
  globals.page.on("console", onConsole)
  globals.page.on("pageerror", onPageError)
  const stopListening = PageConsole.listen(globals.page, logCapture.add)
  globals.page.on("framenavigated", onFrameNavigated)
  const buildResultMetadata = () => {
    const captured = logCapture.snapshot()
    return {
      logs: captured.logs,
      logSummary: captured.summary,
      aftermath: {
        startUrl,
        endUrl: safePageUrl(globals.page),
        navigations,
        consoleErrorCount: captured.consoleErrorCount,
        pageErrorCount: captured.pageErrorCount,
        handoffs: globals.handoffTracker.count,
      },
    } satisfies { readonly logs: readonly ExecuteLogEntry[]; readonly logSummary: ExecuteLogSummary; readonly aftermath: ExecuteAftermath }
  }
  try {
    const values = [sandboxConsole, ...sandboxGlobalKeys.map((key) => globals[key])]
    if (realm) {
      const stateIndex = sandboxGlobalKeys.indexOf("state") + 1
      const result = await realm.run({
        source: `(async function (console, ${sandboxGlobalKeys.join(", ")}) {\n"use strict";\n${wrapCodeWithModuleAliases(code, Object.keys(sandboxModules))}\n})`,
        filename: executeFilename,
        args: values,
        sandboxArgs: new Map([[stateIndex, globals.state]]),
      })
      return { result, ...buildResultMetadata() }
    }
    const AsyncFunction = async function () {}.constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>
    const fn = new AsyncFunction("console", ...sandboxGlobalKeys, `${wrapCodeWithModuleAliases(code, Object.keys(nodeModules))}\n//# sourceURL=${executeFilename}`)
    const result = await fn(...values)
    return { result, ...buildResultMetadata() }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error("execute sandbox code", { cause })
    const metadata = buildResultMetadata()
    throw new ExecuteCodeError(error, metadata.logs, metadata.logSummary, metadata.aftermath)
  } finally {
    globals.page.off("console", onConsole)
    globals.page.off("pageerror", onPageError)
    globals.page.off("framenavigated", onFrameNavigated)
    stopListening()
  }
}

export function getAutoReturnExpression(code: string): string | null {
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: "latest",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      sourceType: "script",
    })
    if (ast.body.length !== 1) {
      return null
    }
    const statement = ast.body[0]
    if (statement?.type !== "ExpressionStatement") {
      return null
    }
    const expression = statement.expression
    if (expression.type === "AssignmentExpression" || expression.type === "UpdateExpression") {
      return null
    }
    if (expression.type === "UnaryExpression" && expression.operator === "delete") {
      return null
    }
    if (expression.type === "SequenceExpression" && expression.expressions.some((item) => {
      return item.type === "AssignmentExpression"
    })) {
      return null
    }
    return code.slice(expression.start, expression.end)
  } catch {
    return null
  }
}

export function wrapCode(code: string): string {
  const expression = getAutoReturnExpression(code)
  if (expression) {
    return `return await (${expression})`
  }
  return code
}

function wrapCodeWithModuleAliases(code: string, aliases: readonly string[]): string {
  return `const { ${aliases.join(", ")} } = modules;\n{\n${wrapCode(code)}\n}`
}
