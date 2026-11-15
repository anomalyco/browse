import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cargoLockMemberVersions, cargoWorkspaceVersion, setVersion } from "../scripts/version"

// A Windows checkout (core.autocrlf) hands scripts/version.ts CRLF files. Reading and stamping must work there, and
// must leave the checkout's line endings alone, or the dev release's Windows build fails where Linux and macOS pass.

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const CARGO_TOML = `[workspace]
resolver = "3"
members = ["crates/*"]

[workspace.package]
version = "0.0.17"
edition = "2024"
`
const CARGO_LOCK = `version = 4

[[package]]
name = "browse-core"
version = "0.0.17"

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "browse-relay"
version = "0.0.17"
`

const crlf = (text: string) => text.replace(/\n/g, "\r\n")

function checkout(eol: "\n" | "\r\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-version-"))
  tempDirs.push(dir)
  const files: Record<string, string> = {
    "cli/package.json": `{\n  "name": "browse",\n  "version": "0.0.17"\n}\n`,
    "package.json": `{\n  "name": "browse",\n  "version": "0.0.17"\n}\n`,
    "public/manifest.json": `{\n  "manifest_version": 3,\n  "name": "browse",\n  "version": "0.0.17"\n}\n`,
    "rust/Cargo.toml": CARGO_TOML,
    "rust/Cargo.lock": CARGO_LOCK,
  }
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), eol === "\r\n" ? crlf(content) : content)
  }
  return dir
}

const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8")
const stamped = ["cli/package.json", "package.json", "public/manifest.json", "rust/Cargo.toml", "rust/Cargo.lock"]

describe("version stamping", () => {
  test("reads and stamps a CRLF checkout without changing its line endings", async () => {
    const dir = checkout("\r\n")
    await setVersion("0.0.18-dev.197", dir)

    for (const file of stamped) {
      const text = read(dir, file)
      expect(text, file).toContain("\r\n")
      expect(text.replace(/\r\n/g, ""), file).not.toContain("\n")
    }

    expect(JSON.parse(read(dir, "cli/package.json")).version).toBe("0.0.18-dev.197")
    expect(JSON.parse(read(dir, "package.json")).version).toBe("0.0.18-dev.197")
    expect(JSON.parse(read(dir, "public/manifest.json"))).toMatchObject({ version: "0.0.18.197", version_name: "0.0.18-dev.197" })
    expect(cargoWorkspaceVersion(read(dir, "rust/Cargo.toml"))).toBe("0.0.18-dev.197")
    expect(cargoLockMemberVersions(read(dir, "rust/Cargo.lock"))).toEqual([
      { name: "browse-core", version: "0.0.18-dev.197" },
      { name: "browse-relay", version: "0.0.18-dev.197" },
    ])
    expect(read(dir, "rust/Cargo.lock"), "registry crate").toContain('name = "serde"\r\nversion = "1.0.0"')
  })

  test("stamps an LF checkout without adding CRLF", async () => {
    const dir = checkout("\n")
    await setVersion("0.0.18-dev.197", dir)
    for (const file of stamped) expect(read(dir, file), file).not.toContain("\r")
    expect(read(dir, "rust/Cargo.lock"), "registry crate").toContain('name = "serde"\nversion = "1.0.0"')
  })

  test("reads the cargo versions from LF and CRLF alike", () => {
    for (const text of [CARGO_TOML, crlf(CARGO_TOML)]) expect(cargoWorkspaceVersion(text)).toBe("0.0.17")
    for (const text of [CARGO_LOCK, crlf(CARGO_LOCK)])
      expect(cargoLockMemberVersions(text)).toEqual([
        { name: "browse-core", version: "0.0.17" },
        { name: "browse-relay", version: "0.0.17" },
      ])
  })
})
