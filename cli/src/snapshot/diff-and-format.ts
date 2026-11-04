import { Predicate } from "effect"
import type { Page } from "patchright-core"
import type { SnapshotRenderedEntry } from "./types.ts"

export function snapshotRefIdentity(entry: SnapshotRenderedEntry): string | undefined {
  if (!entry.selector || !entry.role) return undefined
  return JSON.stringify([entry.selector, entry.role, entry.identityName ?? null])
}

export function findSnapshotLines(lines: readonly string[], query: string | RegExp, requestedContext: number | undefined): string {
  const context = Math.max(0, Math.min(10, Math.floor(requestedContext ?? 2)))
  const matches: number[] = []
  for (const [index, line] of lines.entries()) {
    const matched = Predicate.isString(query)
      ? line.toLowerCase().includes(query.toLowerCase())
      : (() => {
          query.lastIndex = 0
          return query.test(line)
        })()
    if (matched) matches.push(index)
  }
  if (matches.length === 0) {
    return `No snapshot lines matched ${Predicate.isString(query) ? JSON.stringify(query) : query.toString()}.`
  }
  const included = new Set<number>()
  for (const index of matches) {
    for (let candidate = Math.max(0, index - context); candidate <= Math.min(lines.length - 1, index + context); candidate++) {
      included.add(candidate)
    }
  }
  const output: string[] = []
  let previous = -2
  for (const index of [...included].sort((left, right) => left - right)) {
    if (index > previous + 1) output.push("...")
    output.push(lines[index]!)
    previous = index
  }
  return [`${matches.length} matching snapshot ${matches.length === 1 ? "line" : "lines"}:`, ...output].join("\n")
}

export function formatSnapshotLine(entry: SnapshotRenderedEntry, id?: string): string {
  const suffix = [id ? `ref=${id}` : undefined, entry.details].filter(Boolean).join(" ")
  return `${entry.prefix}${suffix ? ` [${suffix}]` : ""}`
}

export function formatSnapshotDiffLine(marker: "+" | "-", entry: SnapshotRenderedEntry, id?: string): string {
  const line = formatSnapshotLine(entry, id)
  const bullet = /^(\s*)- (.*)$/.exec(line)
  return bullet ? `${marker} ${bullet[1]}${bullet[2]}` : `${marker} ${line}`
}

export function diffSnapshotEntries(
  previous: readonly SnapshotRenderedEntry[],
  current: readonly SnapshotRenderedEntry[],
): readonly (
  | { readonly kind: "unchanged"; readonly entry: SnapshotRenderedEntry }
  | { readonly kind: "removed"; readonly entry: SnapshotRenderedEntry }
  | { readonly kind: "added"; readonly entry: SnapshotRenderedEntry }
)[] {
  const previousLines = previous.map((entry) => formatSnapshotLine(entry))
  const currentLines = current.map((entry) => formatSnapshotLine(entry))
  const lengths = Array.from({ length: previous.length + 1 }, () => Array<number>(current.length + 1).fill(0))
  for (let previousIndex = previous.length - 1; previousIndex >= 0; previousIndex--) {
    for (let currentIndex = current.length - 1; currentIndex >= 0; currentIndex--) {
      lengths[previousIndex]![currentIndex] = previousLines[previousIndex] === currentLines[currentIndex]
        ? lengths[previousIndex + 1]![currentIndex + 1]! + 1
        : Math.max(lengths[previousIndex + 1]![currentIndex]!, lengths[previousIndex]![currentIndex + 1]!)
    }
  }

  const operations: Array<
    | { readonly kind: "unchanged"; readonly entry: SnapshotRenderedEntry }
    | { readonly kind: "removed"; readonly entry: SnapshotRenderedEntry }
    | { readonly kind: "added"; readonly entry: SnapshotRenderedEntry }
  > = []
  let previousIndex = 0
  let currentIndex = 0
  while (previousIndex < previous.length || currentIndex < current.length) {
    if (
      previousIndex < previous.length &&
      currentIndex < current.length &&
      previousLines[previousIndex] === currentLines[currentIndex]
    ) {
      operations.push({ kind: "unchanged", entry: current[currentIndex]! })
      previousIndex++
      currentIndex++
      continue
    }
    if (
      previousIndex < previous.length &&
      (currentIndex >= current.length || lengths[previousIndex + 1]![currentIndex]! >= lengths[previousIndex]![currentIndex + 1]!)
    ) {
      operations.push({ kind: "removed", entry: previous[previousIndex]! })
      previousIndex++
      continue
    }
    operations.push({ kind: "added", entry: current[currentIndex]! })
    currentIndex++
  }
  return operations
}

export function snapshotRefAriaRole(role: string): Parameters<Page["getByRole"]>[0] | undefined {
  switch (role) {
    case "button":
    case "checkbox":
    case "combobox":
    case "link":
    case "listbox":
    case "menuitem":
    case "menuitemcheckbox":
    case "menuitemradio":
    case "option":
    case "radio":
    case "searchbox":
    case "slider":
    case "spinbutton":
    case "switch":
    case "tab":
    case "textbox":
    case "treeitem":
      return role
    default:
      return undefined
  }
}
