// The one release version: cli/package.json, the root package.json, the extension manifest and the Rust workspace
// (rust/Cargo.toml and its lockfile; the browse binary also gets it as BROWSE_VERSION at build time) move together.
// npm takes the version as is (0.1.0, or 0.1.1-dev.42 for a dev build). Chrome's manifest `version` must be one to four
// dot-separated integers of at most 65535, so a dev build becomes 0.1.1.42 with `version_name` "0.1.1-dev.42" for
// display. Dev builds never go to the Chrome Web Store (they're loaded unpacked from the release service), so a dev
// build's four-part version never has to sort below the stable release that follows it.
//
//   bun scripts/version.ts set <version>    writes the version into those files (the Release workflow's build jobs
//                                           stamps a dev build's version, which its plan job computes, this way)
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

/** A stable release (1.2.3) or a dev build (1.2.4-dev.42, .2 on a rerun); nothing else ships. */
export const RELEASE_VERSION = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})(?:-dev\.([1-9]\d{0,4})(?:\.([1-9]\d{0,4}))?)?$/
/** Chrome's limit for each part of a manifest version. */
const MANIFEST_PART_MAX = 65535

export type Channel = "latest" | "dev"
export type ReleaseVersion = { version: string; channel: Channel; manifest: { version: string; version_name?: string } }

export function parseReleaseVersion(version: string): ReleaseVersion {
  const match = RELEASE_VERSION.exec(version)
  if (!match) throw new Error(`Not a release version: ${JSON.stringify(version)} (use 1.2.3)`)
  const [, major, minor, patch, run] = match
  if ([major, minor, patch, run].some((part) => part !== undefined && Number(part) > MANIFEST_PART_MAX))
    throw new Error(`${version}: every part must be at most ${MANIFEST_PART_MAX} (Chrome's manifest version limit)`)
  const core = `${major}.${minor}.${patch}`
  if (!run) return { version, channel: "latest", manifest: { version } }
  // A rerun (.<attempt>) keeps the run's manifest version; version_name tells the attempts apart.
  return { version, channel: "dev", manifest: { version: `${core}.${run}`, version_name: version } }
}

/** The manifest fields for a package version; a development version (0.0.0-dev) maps to 0.0.0. */
export function manifestVersionFields(version: string): ReleaseVersion["manifest"] {
  if (RELEASE_VERSION.test(version)) return parseReleaseVersion(version).manifest
  const base = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  return { version: base ? `${base[1]}.${base[2]}.${base[3]}` : "0.0.0", version_name: version }
}

/** Sets version (and version_name, or removes a stale one) on a parsed manifest. */
export function applyManifestVersion(manifest: Record<string, unknown>, version: string) {
  const fields = manifestVersionFields(version)
  manifest.version = fields.version
  delete manifest.version_name
  if (!fields.version_name) return manifest
  // Keep version_name next to version, where people look for it.
  const entries = Object.entries(manifest)
  const at = entries.findIndex(([key]) => key === "version") + 1
  entries.splice(at, 0, ["version_name", fields.version_name])
  for (const key of Object.keys(manifest)) delete manifest[key]
  return Object.assign(manifest, Object.fromEntries(entries))
}

const root = path.resolve(import.meta.dir, "..")
export const VERSION_FILES = ["cli/package.json", "package.json", "public/manifest.json", "rust/Cargo.toml", "rust/Cargo.lock"] as const

/** The line endings a checkout gave a file: CRLF on Windows (core.autocrlf), LF everywhere else. */
function lineEnding(text: string) {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

/** Text with CRLF folded to LF, so the parsers below read the same file from every checkout. */
function lf(text: string) {
  return text.replace(/\r\n/g, "\n")
}

/** Applies an edit written for LF text, and writes it back with the line endings the file already had. */
function editText(text: string, edit: (source: string) => string) {
  const eol = lineEnding(text)
  return edit(lf(text)).replace(/\n/g, eol)
}

async function updateJson(at: string, file: string, update: (data: Record<string, unknown>) => void) {
  const full = path.join(at, file)
  const text = await readFile(full, "utf8")
  const data = JSON.parse(text) as Record<string, unknown>
  update(data)
  await writeFile(full, JSON.stringify(data, null, 2).concat("\n").replace(/\n/g, lineEnding(text)))
}

const WORKSPACE_VERSION = /^(\[workspace\.package\]\n(?:(?!\[)[^\n]*\n)*?version = ")([^"]+)(")/m

/** The Rust workspace version (rust/Cargo.toml `[workspace.package] version`), which every crate inherits. */
export function cargoWorkspaceVersion(toml: string) {
  return WORKSPACE_VERSION.exec(lf(toml))?.[2]
}

/** The versions Cargo.lock records for the workspace's own crates (the packages without a `source`). */
export function cargoLockMemberVersions(lock: string) {
  return lf(lock)
    .split(/\n(?=\[\[package\]\])/)
    .filter((block) => block.startsWith("[[package]]") && !/^source = /m.test(block))
    .map((block) => ({ name: /^name = "([^"]+)"/m.exec(block)?.[1] ?? "?", version: /^version = "([^"]+)"/m.exec(block)?.[1] ?? "?" }))
}

/**
 * The Rust workspace takes the release version too, so `cargo build --locked` builds it as is: rust/Cargo.toml's
 * workspace version and, in rust/Cargo.lock, every workspace crate (the packages without a `source`).
 */
async function setCargoVersion(at: string, version: string) {
  const toml = path.join(at, "rust", "Cargo.toml")
  const text = await readFile(toml, "utf8")
  if (!cargoWorkspaceVersion(text)) throw new Error("rust/Cargo.toml has no [workspace.package] version")
  await writeFile(
    toml,
    editText(text, (source) => source.replace(WORKSPACE_VERSION, (_, head: string, _old: string, tail: string) => `${head}${version}${tail}`)),
  )
  const lock = path.join(at, "rust", "Cargo.lock")
  const lockText = await readFile(lock, "utf8")
  await writeFile(
    lock,
    editText(lockText, (source) =>
      source
        .split(/\n(?=\[\[package\]\])/)
        .map((block) =>
          block.startsWith("[[package]]") && !/^source = /m.test(block) ? block.replace(/^version = "[^"]+"/m, `version = "${version}"`) : block,
        )
        .join("\n"),
    ),
  )
}

/** Writes one version into cli/package.json, package.json, public/manifest.json and the Rust workspace. */
export async function setVersion(version: string, at = root) {
  await updateJson(at, "cli/package.json", (data) => void (data.version = version))
  await updateJson(at, "package.json", (data) => void (data.version = version))
  await updateJson(at, "public/manifest.json", (data) => void applyManifestVersion(data, version))
  await setCargoVersion(at, version)
}

if (import.meta.main) {
  const { positionals } = parseArgs({ allowPositionals: true })
  const [command, argument] = positionals
  try {
    if (command === "set" && argument) {
      parseReleaseVersion(argument)
      await setVersion(argument)
      console.log(argument)
    } else {
      console.error("usage: bun scripts/version.ts set <version>")
      process.exit(2)
    }
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`)
    process.exit(1)
  }
}
