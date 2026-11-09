import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  launchWindowsRelay,
  quoteWindowsArgument,
  resolveWindowsExecutable,
  windowsCommandLine,
  windowsEnvironmentBlock,
  windowsLaunchProblem,
} from "../src/relay/windows-launch.ts"

describe("windows relay command line", () => {
  test("quotes arguments the way CommandLineToArgvW parses them back", () => {
    expect(quoteWindowsArgument("browse.exe")).toBe('"browse.exe"')
    expect(quoteWindowsArgument("C:\\Program Files\\browse.exe")).toBe('"C:\\Program Files\\browse.exe"')
    expect(quoteWindowsArgument("")).toBe('""')
    expect(quoteWindowsArgument("a b")).toBe('"a b"')
    expect(quoteWindowsArgument("a\\b")).toBe('"a\\b"')
    // Backslashes before the closing quote must be doubled, or they would escape it.
    expect(quoteWindowsArgument("a\\")).toBe('"a\\\\"')
    expect(quoteWindowsArgument('say "hi"')).toBe('"say \\"hi\\""')
    // Backslashes before a literal quote are doubled, and the quote itself gets one more escape backslash.
    expect(quoteWindowsArgument('a\\"b')).toBe('"a\\\\\\"b"')
  })

  test("puts the executable first and joins it with the arguments", () => {
    expect(windowsCommandLine("C:\\browse\\browse.exe", ["serve"])).toBe('"C:\\browse\\browse.exe" "serve"')
    expect(windowsCommandLine("bun.exe", ["C:\\a b\\main.ts", "serve"])).toBe('"bun.exe" "C:\\a b\\main.ts" "serve"')
  })
})

describe("windows relay executable resolution", () => {
  const files = new Set([
    "C:\\bin\\browse.exe",
    "C:\\bin\\tool.com",
    "C:\\Program Files\\bun\\bun.exe",
    "D:\\tools\\bun.exe",
  ])
  const exists = (candidate: string) => files.has(candidate)

  test("keeps a fully qualified path, including UNC", () => {
    expect(resolveWindowsExecutable("C:\\bin\\browse.exe", {}, () => false)).toBe("C:\\bin\\browse.exe")
    expect(resolveWindowsExecutable("C:/bin/browse.exe", {}, () => false)).toBe("C:/bin/browse.exe")
    expect(resolveWindowsExecutable("\\\\server\\share\\browse.exe", {}, () => false)).toBe("\\\\server\\share\\browse.exe")
  })

  test("resolves a bare name only through the absolute directories in PATH", () => {
    expect(resolveWindowsExecutable("browse", { Path: "relative;D:\\tools;C:\\bin" }, exists)).toBe("C:\\bin\\browse.exe")
    expect(resolveWindowsExecutable("tool", { PATH: "C:\\bin" }, exists)).toBe("C:\\bin\\tool.com")
    expect(resolveWindowsExecutable("bun", { PATH: "D:\\tools" }, exists)).toBe("D:\\tools\\bun.exe")
  })

  test("matches PATH case-insensitively and uses the last duplicate", () => {
    expect(resolveWindowsExecutable("bun", { Path: "C:\\missing", PATH: "D:\\tools" }, exists)).toBe("D:\\tools\\bun.exe")
  })

  test("handles quoted PATH entries", () => {
    expect(resolveWindowsExecutable("bun", { PATH: '"C:\\Program Files\\bun";' }, exists)).toBe("C:\\Program Files\\bun\\bun.exe")
  })

  test("does not append .exe to a name that already has an extension", () => {
    const seen: string[] = []
    resolveWindowsExecutable("browse.exe", { PATH: "C:\\bin" }, (candidate) => {
      seen.push(candidate)
      return true
    })
    expect(seen).toEqual(["C:\\bin\\browse.exe"])
  })

  test("rejects relative paths, drive-relative paths and names missing from PATH", () => {
    expect(resolveWindowsExecutable(".\\browse.exe", { PATH: "C:\\bin" }, () => true)).toBeUndefined()
    expect(resolveWindowsExecutable("bin\\browse.exe", { PATH: "C:\\bin" }, () => true)).toBeUndefined()
    expect(resolveWindowsExecutable("C:browse.exe", { PATH: "C:\\bin" }, () => true)).toBeUndefined()
    expect(resolveWindowsExecutable("browse", { PATH: "relative" }, () => true)).toBeUndefined()
    expect(resolveWindowsExecutable("browse", {}, () => true)).toBeUndefined()
  })
})

describe("windows relay environment block", () => {
  test("sorts entries case-insensitively and terminates every string and the block", () => {
    expect(windowsEnvironmentBlock({ Path: "C:\\bin", APPDATA: "C:\\Users\\me\\AppData", ZED: "1", home: "C:\\Users\\me" }))
      .toBe("APPDATA=C:\\Users\\me\\AppData\0home=C:\\Users\\me\0Path=C:\\bin\0ZED=1\0\0")
  })

  test("omits variables that are not set", () => {
    expect(windowsEnvironmentBlock({ PATH: "C:\\bin", OPENAI_API_KEY: undefined })).toBe("PATH=C:\\bin\0\0")
  })

  test("skips names that are empty or contain = or NUL", () => {
    expect(windowsEnvironmentBlock({ "": "empty", "A=B": "equals", "BAD\0NAME": "nul", OK: "1" })).toBe("OK=1\0\0")
  })

  test("keeps the last value for names that differ only by case", () => {
    expect(windowsEnvironmentBlock({ opencode_browser_managed_relay: "0", PATH: "C:\\bin", OPENCODE_BROWSER_MANAGED_RELAY: "1" }))
      .toBe("OPENCODE_BROWSER_MANAGED_RELAY=1\0PATH=C:\\bin\0\0")
  })

  test("terminates an empty environment with two NULs", () => {
    expect(windowsEnvironmentBlock({})).toBe("\0\0")
  })
})

describe("windows relay launch validation", () => {
  test("accepts a clean launch", () => {
    expect(windowsLaunchProblem({ executable: "C:\\bin\\browse.exe", args: ["serve"] }, { PATH: "C:\\bin" })).toBeUndefined()
  })

  test("rejects NUL in the executable, an argument or an environment value", () => {
    expect(windowsLaunchProblem({ executable: "C:\\bin\0browse.exe", args: [] }, {})).toMatch(/NUL/)
    expect(windowsLaunchProblem({ executable: "C:\\bin\\browse.exe", args: ["a\0b"] }, {})).toMatch(/NUL/)
    expect(windowsLaunchProblem({ executable: "C:\\bin\\browse.exe", args: [] }, { PATH: "C:\\bin", BAD: "a\0b" })).toMatch(/NUL/)
  })

  test("does not reject environment names that the block skips", () => {
    expect(windowsLaunchProblem({ executable: "C:\\bin\\browse.exe", args: [] }, { "": "empty", "A=B": "equals", "BAD\0NAME": "nul" }))
      .toBeUndefined()
  })
})

const inlineMarkerScript = (marker: string) =>
  `const fs = require("node:fs"); const tmp = ${JSON.stringify(`${marker}.tmp`)}; `
  + `fs.writeFileSync(tmp, JSON.stringify({ value: process.env.BROWSE_TEST_LAUNCH_VALUE, leaked: process.env.BROWSE_TEST_LEAKED_VALUE ?? null, argv: process.argv.slice(1) })); `
  + `fs.renameSync(tmp, ${JSON.stringify(marker)});`

// The launch integration test only proves some launcher worked; these call the CreateProcessW path directly.
test.skipIf(process.platform !== "win32")("launches a process with CreateProcessW, its environment and its arguments", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "browse-create-process-"))
  const leaked = "BROWSE_TEST_LEAKED_VALUE"
  const previous = process.env[leaked]
  process.env[leaked] = `only in the test process ${Date.now()}`
  try {
    const marker = path.join(dir, "marker.json")
    const value = `value with spaces and "quotes" ${Date.now()}`
    const argv = ["argument with a space", 'quote " and a trailing backslash \\']
    const env: NodeJS.ProcessEnv = { ...process.env, BROWSE_TEST_LAUNCH_VALUE: value }
    for (const name of Object.keys(env)) if (name.toUpperCase() === leaked) delete env[name]
    expect(launchWindowsRelay({ executable: process.execPath, args: ["-e", inlineMarkerScript(marker), ...argv] }, env)).toBe(true)
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(100)
    expect(existsSync(marker)).toBe(true)
    const written = JSON.parse(readFileSync(marker, "utf8")) as { value: string; leaked: string | null; argv: string[] }
    expect(written.value).toBe(value)
    expect(written.leaked).toBeNull()
    expect(written.argv).toEqual(argv)
  } finally {
    if (previous === undefined) delete process.env[leaked]
    else process.env[leaked] = previous
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 15_000)

test.skipIf(process.platform !== "win32")("resolves a bare executable name through the launch environment's PATH", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "browse-create-process-path-"))
  try {
    const marker = path.join(dir, "marker.json")
    const value = `resolved bun ${Date.now()}`
    const inheritedPath = Object.entries(process.env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? ""
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${inheritedPath}`,
      BROWSE_TEST_LAUNCH_VALUE: value,
    }
    expect(launchWindowsRelay({ executable: "bun", args: ["-e", inlineMarkerScript(marker)] }, env)).toBe(true)
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(100)
    expect(existsSync(marker)).toBe(true)
    expect((JSON.parse(readFileSync(marker, "utf8")) as { value: string }).value).toBe(value)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 15_000)
