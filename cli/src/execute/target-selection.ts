import { Effect, Schema } from "effect"
import type { Page } from "patchright-core"
import { playwrightCloseTimeoutMs, runPlaywrightOperation } from "./page-recovery.ts"

export type ExecuteTargetSelection = {
  readonly urlIncludes?: string
  readonly index?: number
}

export class TargetSelectionError extends Schema.TaggedError<TargetSelectionError>()(
  "Execute.TargetSelectionError",
  {
    message: Schema.String,
    reason: Schema.Literals(["invalid", "not-found", "ambiguous"]),
  },
) {}

export function hasExplicitTargetSelection(selection: ExecuteTargetSelection | undefined): boolean {
  return Boolean(selection?.urlIncludes) || selection?.index !== undefined
}

export function selectTarget<T>({
  targets,
  selection,
  getUrl,
  getIndex,
}: {
  readonly targets: readonly T[]
  readonly selection: ExecuteTargetSelection
  readonly getUrl: (target: T) => string
  readonly getIndex?: (target: T, fallbackIndex: number) => number
}): T | undefined {
  if (selection.urlIncludes && selection.index !== undefined) {
    throw new TargetSelectionError({ reason: "invalid", message: "Use only one target selector: --target-url or --target-index" })
  }
  if (selection.urlIncludes) {
    const matches = targets.filter((candidate) => {
      return getUrl(candidate).includes(selection.urlIncludes ?? "")
    })
    if (matches.length === 0) {
      throw new TargetSelectionError({
        reason: "not-found",
        message: `No existing attached page URL includes ${selection.urlIncludes}. Target selectors do not navigate or open pages: use page.goto() in the session page, or attach the intended user tab with the Browse toolbar first.`,
      })
    }
    if (matches.length > 1) {
      const candidates = targets.flatMap((candidate, index) => matches.includes(candidate) ? [`[${getIndex ? getIndex(candidate, index) : index}] ${getUrl(candidate)}`] : [])
      throw new TargetSelectionError({
        reason: "ambiguous",
        message: `Multiple attached pages (${matches.length}) match URL ${selection.urlIncludes}; use a more specific --target-url or --target-index. Matches: ${candidates.join(", ")}`,
      })
    }
    return matches[0]
  }
  if (selection.index !== undefined) {
    if (selection.index < 0) {
      throw new TargetSelectionError({ reason: "invalid", message: "Target index must be a non-negative integer" })
    }
    const target = targets[selection.index]
    if (!target) {
      throw new TargetSelectionError({
        reason: "not-found",
        message: `No existing attached page at index ${selection.index}; ${targets.length} page(s) available. Target selectors do not create pages.`,
      })
    }
    return target
  }
  if (targets.length === 0) {
    throw new TargetSelectionError({
      reason: "not-found",
      message: "No attached pages available. Attach the intended user tab with the Browse toolbar first.",
    })
  }
  if (targets.length > 1) {
    const candidates = targets.map((candidate, index) => `[${getIndex ? getIndex(candidate, index) : index}] ${getUrl(candidate)}`)
    throw new TargetSelectionError({
      reason: "ambiguous",
      message: `Multiple attached pages (${targets.length}); use --target-url or --target-index to choose one. Matches: ${candidates.join(", ")}`,
    })
  }
  return targets[0]
}

export function selectPage({ pages, selection }: { readonly pages: readonly Page[]; readonly selection: ExecuteTargetSelection }): Page | undefined {
  return selectTarget({ targets: pages, selection, getUrl: (page) => page.url() })
}

export async function resolvePageTargetId(page: Page): Promise<string | undefined> {
  return await Effect.runPromise(
    runPlaywrightOperation({
      label: "Resolve session page target id",
      timeoutMs: playwrightCloseTimeoutMs,
      run: () => pageTargetId(page),
    }).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (targetId) => targetId,
      }),
    ),
  )
}

export async function pageTargetId(page: Page): Promise<string> {
  if (page.isClosed()) {
    throw new Error("Cannot identify the CDP target for a closed page")
  }
  const session = await page.context().newCDPSession(page)
  try {
    const result = await session.send("Target.getTargetInfo")
    const targetId = result.targetInfo?.targetId
    if (!targetId) {
      throw new Error("Target.getTargetInfo did not return a target id for the handoff page")
    }
    return targetId
  } finally {
    await session.detach()
  }
}

export function safePageUrl(page: Page): string | null {
  try {
    return page.isClosed() ? null : page.url()
  } catch {
    return null
  }
}
