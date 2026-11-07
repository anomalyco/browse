import { afterEach, describe, expect, test } from "bun:test"
import type { Frame, Page } from "patchright-core"
import { createWebMcpHelper } from "../src/execute/webmcp.ts"

type PageTool = { readonly name: string; readonly description?: string }
type ModelContext = {
  readonly getTools: () => Promise<PageTool[]>
  readonly executeTool?: (tool: PageTool, input: unknown) => Promise<unknown>
  readonly invokeTool?: (name: string, input: unknown) => Promise<unknown>
}

const tools: PageTool[] = [{ name: "search", description: "Search the catalog" }]
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")

/** Runs the injected in-page function against a fake `document.modelContext`, as frame.evaluate would. */
function installModelContext(context: ModelContext): void {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { modelContext: context } })
}

function fakePage(): Page {
  const frame = {
    url: () => "https://example.com/",
    evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => await fn(arg),
  }
  return { frames: () => [frame as unknown as Frame] } as unknown as Page
}

afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument)
  else delete (globalThis as { document?: unknown }).document
})

describe("webmcp.call input encoding", () => {
  test("passes the input as a plain object and parses the result", async () => {
    const received: unknown[] = []
    installModelContext({
      getTools: async () => tools,
      executeTool: async (_tool, input) => {
        received.push(input)
        if (typeof input !== "object" || input === null) {
          throw new TypeError("Failed to execute 'executeTool' on 'ModelContext': parameter 2 is not of type 'object'.")
        }
        return JSON.stringify({ echoed: input })
      },
    })

    const result = await createWebMcpHelper(fakePage()).call("search", { query: "adapter" })

    expect(received).toEqual([{ query: "adapter" }])
    expect(result).toEqual({ echoed: { query: "adapter" } })
  })

  test("drops undefined values from the input, as JSON did", async () => {
    const received: unknown[] = []
    installModelContext({
      getTools: async () => tools,
      executeTool: async (_tool, input) => {
        received.push(input)
        return input
      },
    })

    await createWebMcpHelper(fakePage()).call("search", { query: "adapter", limit: undefined })

    expect(received).toEqual([{ query: "adapter" }])
  })

  test("retries once with the JSON string on pre-155 Chromium", async () => {
    const received: unknown[] = []
    installModelContext({
      getTools: async () => tools,
      executeTool: async (_tool, input) => {
        received.push(input)
        if (typeof input !== "string") throw new Error("Failed to parse input arguments")
        return JSON.stringify({ parsed: JSON.parse(input) })
      },
    })

    const result = await createWebMcpHelper(fakePage()).call("search", { query: "adapter" })

    expect(received).toEqual([{ query: "adapter" }, '{"query":"adapter"}'])
    expect(result).toEqual({ parsed: { query: "adapter" } })
  })

  // The fake rejects the object with the 155+ binding TypeError, to exercise that matcher path.
  test("retries once on the 155+ 'parameter 2 is not of type object' TypeError", async () => {
    const received: unknown[] = []
    installModelContext({
      getTools: async () => tools,
      executeTool: async (_tool, input) => {
        received.push(input)
        if (typeof input === "object") {
          throw new TypeError("Failed to execute 'executeTool' on 'ModelContext': parameter 2 is not of type 'object'.")
        }
        return "ok"
      },
    })

    const result = await createWebMcpHelper(fakePage()).call("search", {})

    expect(received).toEqual([{}, "{}"])
    expect(result).toBe("ok")
  })

  test("rethrows a bare 'not of type object' message without retrying", async () => {
    let calls = 0
    installModelContext({
      getTools: async () => tools,
      executeTool: async () => {
        calls += 1
        throw new Error("value is not of type 'object'")
      },
    })

    const rejection = await createWebMcpHelper(fakePage()).call("search", {}).then(() => undefined, (error: unknown) => error)

    expect((rejection as Error).message).toBe("value is not of type 'object'")
    expect(calls).toBe(1)
  })

  test("rethrows the retry's error when the fallback also fails", async () => {
    const received: unknown[] = []
    installModelContext({
      getTools: async () => tools,
      executeTool: async (_tool, input) => {
        received.push(input)
        throw new Error(typeof input === "string" ? "fallback failed" : "Failed to parse input arguments")
      },
    })

    const rejection = await createWebMcpHelper(fakePage()).call("search", {}).then(() => undefined, (error: unknown) => error)

    expect((rejection as Error).message).toBe("fallback failed")
    expect(received).toEqual([{}, "{}"])
  })

  test("passes the object to invokeTool", async () => {
    const received: unknown[] = []
    installModelContext({
      getTools: async () => tools,
      invokeTool: async (name, input) => {
        received.push({ name, input })
        return { name, input }
      },
    })

    const result = await createWebMcpHelper(fakePage()).call("search", { query: "adapter" })

    expect(received).toEqual([{ name: "search", input: { query: "adapter" } }])
    expect(result).toEqual({ name: "search", input: { query: "adapter" } })
  })
})
