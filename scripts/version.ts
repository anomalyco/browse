// The one release version: cli/package.json, the root package.json and the extension manifest move together.
// npm takes the version as is (0.1.0, or 0.1.1-dev.42 for a dev build). Chrome's manifest `version` must be one to four
// dot-separated integers of at most 65535, so a dev build becomes 0.1.1.42 with `version_name` "0.1.1-dev.42" for
// display. Dev builds never go to the Chrome Web Store (they're loaded unpacked from the release service), so a dev
// build's four-part version never has to sort below the stable release that follows it.
//
//   bun scripts/version.ts set <version>    writes the version into the three files (the Release workflow's build job
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
export const VERSION_FILES = ["cli/package.json", "package.json", "public/manifest.json"] as const

async function updateJson(file: string, update: (data: Record<string, unknown>) => void) {
  const full = path.join(root, file)
  const data = JSON.parse(await readFile(full, "utf8")) as Record<string, unknown>
  update(data)
  await writeFile(full, JSON.stringify(data, null, 2) + "\n")
}

/** Writes one version into cli/package.json, package.json and public/manifest.json. */
export async function setVersion(version: string) {
  await updateJson("cli/package.json", (data) => void (data.version = version))
  await updateJson("package.json", (data) => void (data.version = version))
  await updateJson("public/manifest.json", (data) => void applyManifestVersion(data, version))
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
