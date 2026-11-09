import { describe, expect, test } from "bun:test"
import { quoteWindowsArgument, windowsCommandLine, windowsEnvironmentBlock } from "../src/relay/windows-launch.ts"

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

describe("windows relay environment block", () => {
  test("sorts entries case-insensitively and terminates every string and the block", () => {
    expect(windowsEnvironmentBlock({ Path: "C:\\bin", APPDATA: "C:\\Users\\me\\AppData", ZED: "1", home: "C:\\Users\\me" }))
      .toBe("APPDATA=C:\\Users\\me\\AppData\0home=C:\\Users\\me\0Path=C:\\bin\0ZED=1\0\0")
  })

  test("omits variables that are not set", () => {
    expect(windowsEnvironmentBlock({ PATH: "C:\\bin", OPENAI_API_KEY: undefined })).toBe("PATH=C:\\bin\0\0")
  })

  test("terminates an empty environment", () => {
    expect(windowsEnvironmentBlock({})).toBe("\0")
  })
})
