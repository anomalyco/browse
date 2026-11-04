import { describe, expect, test } from "bun:test"
import type { Page } from "patchright-core"
import {
  hasExplicitTargetSelection,
  pageTargetId,
  resolvePageTargetId,
  safePageUrl,
  selectPage,
  selectTarget,
  TargetSelectionError,
} from "../src/execute/target-selection.ts"

type Target = { readonly url: string }

const target = (url: string): Target => ({ url })

const select = (targets: readonly Target[], selection: { urlIncludes?: string; index?: number }) =>
  selectTarget({ targets, selection, getUrl: (candidate) => candidate.url })

const fakePage = (url: string, closed = false): Page => ({
  isClosed: () => closed,
  url: () => url,
} as unknown as Page)

function failure(run: () => unknown): TargetSelectionError {
  try {
    run()
  } catch (error) {
    if (error instanceof TargetSelectionError) return error
    throw error
  }
  throw new Error("Expected a TargetSelectionError")
}

describe("hasExplicitTargetSelection", () => {
  test("counts only a non-empty urlIncludes or an index", () => {
    expect(hasExplicitTargetSelection(undefined)).toBe(false)
    expect(hasExplicitTargetSelection({})).toBe(false)
    expect(hasExplicitTargetSelection({ urlIncludes: "" })).toBe(false)
    expect(hasExplicitTargetSelection({ urlIncludes: "x" })).toBe(true)
    expect(hasExplicitTargetSelection({ index: 0 })).toBe(true)
  })
})

describe("selectTarget", () => {
  test("returns the only target when nothing is selected", () => {
    expect(select([target("https://a/")], {})).toEqual(target("https://a/"))
  })

  test("reports no attached pages", () => {
    const error = failure(() => select([], {}))
    expect(error.reason).toBe("not-found")
    expect(error.message).toBe("No attached pages available. Attach the intended user tab with the Browse toolbar first.")
  })

  test("reports ambiguity with indexes", () => {
    const error = failure(() => select([target("https://a/"), target("https://b/")], {}))
    expect(error.reason).toBe("ambiguous")
    expect(error.message).toContain("Matches: [0] https://a/, [1] https://b/")
  })

  test("uses getIndex for candidate labels", () => {
    const error = failure(() => selectTarget({
      targets: [target("https://a/"), target("https://b/")],
      selection: {},
      getUrl: (candidate) => candidate.url,
      getIndex: (candidate, fallbackIndex) => candidate.url === "https://b/" ? 7 : fallbackIndex,
    }))
    expect(error.message).toContain("[7] https://b/")
  })

  test("matches urlIncludes", () => {
    expect(select([target("https://a/"), target("https://b/")], { urlIncludes: "b/" })).toEqual(target("https://b/"))
  })

  test("reports a urlIncludes miss", () => {
    const error = failure(() => select([target("https://a/")], { urlIncludes: "b/" }))
    expect(error.reason).toBe("not-found")
    expect(error.message).toContain("Target selectors do not navigate or open pages")
  })

  test("reports ambiguous urlIncludes", () => {
    const error = failure(() => select([target("https://a/x"), target("https://a/y")], { urlIncludes: "https://a/" }))
    expect(error.reason).toBe("ambiguous")
    expect(error.message).toContain("Matches: [0] https://a/x, [1] https://a/y")
  })

  test("rejects two selectors at once", () => {
    const error = failure(() => select([target("https://a/")], { urlIncludes: "a", index: 0 }))
    expect(error.reason).toBe("invalid")
    expect(error.message).toBe("Use only one target selector: --target-url or --target-index")
  })

  test("selects by index", () => {
    expect(select([target("https://a/"), target("https://b/")], { index: 1 })).toEqual(target("https://b/"))
  })

  test("rejects a negative index", () => {
    const error = failure(() => select([target("https://a/")], { index: -1 }))
    expect(error.reason).toBe("invalid")
    expect(error.message).toBe("Target index must be a non-negative integer")
  })

  test("reports an out-of-range index", () => {
    const error = failure(() => select([target("https://a/")], { index: 3 }))
    expect(error.reason).toBe("not-found")
    expect(error.message).toContain("Target selectors do not create pages.")
  })
})

describe("selectPage", () => {
  test("selects a fake page by urlIncludes", () => {
    const page = fakePage("https://b/")
    expect(selectPage({ pages: [fakePage("https://a/"), page], selection: { urlIncludes: "b/" } })).toBe(page)
  })
})

describe("safePageUrl", () => {
  test("returns the url of an open page", () => {
    expect(safePageUrl(fakePage("https://a/"))).toBe("https://a/")
  })

  test("returns null for a closed page", () => {
    expect(safePageUrl(fakePage("https://a/", true))).toBeNull()
  })

  test("returns null when url() throws", () => {
    const page = { isClosed: () => false, url: () => { throw new Error("detached") } } as unknown as Page
    expect(safePageUrl(page)).toBeNull()
  })
})

describe("pageTargetId", () => {
  test("rejects for a closed page", async () => {
    await expect(pageTargetId(fakePage("https://a/", true))).rejects.toThrow("Cannot identify the CDP target for a closed page")
  })

  test("resolvePageTargetId collapses that failure to undefined", async () => {
    expect(await resolvePageTargetId(fakePage("https://a/", true))).toBeUndefined()
  })
})

describe("TargetSelectionError", () => {
  test("tags the error and keeps its reason", () => {
    const error = new TargetSelectionError({ reason: "ambiguous", message: "Multiple attached pages" })
    expect(error._tag).toBe("Execute.TargetSelectionError")
    expect(error.reason).toBe("ambiguous")
  })
})
