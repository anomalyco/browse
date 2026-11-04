import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cliCommand, devExtension, installCommand, npxCommand, type DevExtension } from "../src/paths.ts"

/** A reference like the one build.ts bakes into a dev build: the unpacked extension zip published to the release service. */
const baked = (overrides: Partial<DevExtension> = {}): DevExtension => ({
  file: "browse-extension-dev.zip",
  sha256: "a".repeat(64),
  size: 1024,
  ...overrides,
})

// bun test shares one process across files, so put the baked value back exactly as it was.
let previous: DevExtension | undefined
beforeEach(() => {
  previous = globalThis.__OPENCODE_BROWSER_EXTENSION__
})
afterEach(() => {
  globalThis.__OPENCODE_BROWSER_EXTENSION__ = previous
})

describe("npx command", () => {
  test("stable builds run the released package", () => {
    globalThis.__OPENCODE_BROWSER_EXTENSION__ = undefined
    expect(devExtension()).toBeUndefined()
    expect(npxCommand("install")).toBe("npx @opencode/browse install")
    expect(npxCommand("pair")).toBe("npx @opencode/browse pair")
  })

  test("a build with a dev extension runs the dev channel", () => {
    const extension = baked()
    globalThis.__OPENCODE_BROWSER_EXTENSION__ = extension
    expect(devExtension()).toEqual(extension)
    expect(npxCommand("doctor")).toBe("npx @opencode/browse@dev doctor")
    // The args are appended verbatim, install included.
    expect(npxCommand("install")).toBe("npx @opencode/browse@dev install")
  })

  test("a baked value that isn't the build's extension falls back to the released package", () => {
    globalThis.__OPENCODE_BROWSER_EXTENSION__ = baked({ file: "../evil.zip" })
    expect(npxCommand("install")).toBe("npx @opencode/browse install")
    globalThis.__OPENCODE_BROWSER_EXTENSION__ = baked({ file: "browse-extension-dev.tar.gz" })
    expect(npxCommand("install")).toBe("npx @opencode/browse install")
    globalThis.__OPENCODE_BROWSER_EXTENSION__ = baked({ sha256: "not-a-sha256" })
    expect(npxCommand("install")).toBe("npx @opencode/browse install")
  })

  test("never asks for @latest", () => {
    globalThis.__OPENCODE_BROWSER_EXTENSION__ = baked()
    expect(npxCommand("install")).not.toContain("@latest")
    globalThis.__OPENCODE_BROWSER_EXTENSION__ = undefined
    expect(npxCommand("install")).not.toContain("@latest")
  })
})

describe("checkout commands", () => {
  test("a checkout runs its own bundle and setup, even from a dev build", () => {
    globalThis.__OPENCODE_BROWSER_EXTENSION__ = baked()

    const cli = cliCommand("doctor")
    expect(cli.startsWith("node ")).toBe(true)
    expect(cli).toContain("dist/cli.mjs")
    expect(cli.endsWith(" doctor")).toBe(true)
    expect(cli).not.toContain("npx")
    expect(cli).not.toContain("@dev")

    const install = installCommand()
    expect(install.startsWith("cd ")).toBe(true)
    expect(install.endsWith(" && bun run setup")).toBe(true)
    expect(install).not.toContain("npx")
  })
})
