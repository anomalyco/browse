import { describe, expect, test } from "bun:test"
import path from "node:path"
import { cliCommand, cliPrefix } from "../src/paths.ts"

describe("the command people type to run browse", () => {
  const binary = path.join("/home/u/.browse/bin", "browse")

  test("a binary install on PATH is just browse", () => {
    const pathEnv = ["/usr/bin", path.dirname(binary)].join(path.delimiter)
    expect(cliCommand("rollback", { kind: "binary", binary, pathEnv })).toBe("browse rollback")
  })

  test("a binary install off PATH names the executable", () => {
    expect(cliPrefix({ kind: "binary", binary, pathEnv: "/usr/bin" })).toBe(binary)
  })

  test("an npm install runs through npx, on its channel", () => {
    expect(cliCommand("pair", { kind: "npm", version: "0.0.8" })).toBe("npx @opencode/browse pair")
    expect(cliCommand("pair", { kind: "npm", version: "0.0.9-dev.12" })).toBe("npx @opencode/browse@dev pair")
  })
})
