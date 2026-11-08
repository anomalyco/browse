import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

// PowerShell 6+ validates -UserAgent as RFC 7231 product tokens, so the release protocol's two-slash User-Agents need
// -SkipHeaderValidation; Windows PowerShell 5.1 has no such parameter (and doesn't validate), so the splat is empty.
const script = readFileSync(path.join(import.meta.dir, "../../install.ps1"), "utf8")
const lines = script.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("#"))

test("install.ps1 splats header validation past the protocol User-Agents", () => {
  const calls = lines.filter((line) => line.includes("-UserAgent"))
  expect(calls.map((line) => line.match(/-UserAgent\s+"([^"]+)"/)?.[1])).toEqual(["browse/$channel/install", "browse/$channel/$version/cli"])
  for (const line of calls) expect(line).toContain("@lenient")
})

test("header validation is only skipped on PowerShell 6+", () => {
  const definition = lines.find((line) => line.includes("$lenient ="))
  expect(definition).toContain("$PSVersionTable.PSVersion.Major -ge 6")
  expect(definition).toContain("@{ SkipHeaderValidation = $true }")
  expect(definition).toContain("else { @{} }")
})
