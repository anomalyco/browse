import { describe, expect, test } from "bun:test"
import { extractExecuteMedia } from "../src/execute/result-formatting.ts"
import { toolResultForValue } from "../src/mcp/schema.ts"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")

describe("toolResultForValue", () => {
  test("results with images carry text and image content without structuredContent", () => {
    const extracted = extractExecuteMedia(png)
    expect(extracted.media).toHaveLength(1)
    const result = toolResultForValue({ text: "ok", value: extracted.value, media: extracted.media, isError: false })
    expect(result.content.map((item) => item.type)).toEqual(["text", "image"])
    expect(result.structuredContent).toBeUndefined()
    expect(result.isError).toBe(false)
  })

  test("results without images keep structuredContent", () => {
    const value = { text: "ok", value: { title: "Example" }, isError: false }
    const result = toolResultForValue(value)
    expect(result.content.map((item) => item.type)).toEqual(["text"])
    expect(result.structuredContent).toEqual(value)
  })
})
