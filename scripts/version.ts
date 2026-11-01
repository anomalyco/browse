// The one release version: cli/package.json, the root package.json and the extension manifest move together.
// npm takes the version as is (0.1.0, or 0.1.1-dev.42 for a dev build). Chrome's manifest `version` must be one to four
// dot-separated integers of at most 65535, so a dev build becomes 0.1.1.42 with `version_name` "0.1.1-dev.42" for
// display. Dev builds go to their own private store item (RELEASING.md), so a dev build's four-part version never has to
// sort below the stable release that follows it.
//
//   bun scripts/version.ts set <version>                       writes the version into the three files
//   bun scripts/version.ts dev --run <n> [--attempt <n>]       writes the dev version of this run and prints it
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
  // A rerun (.<attempt>) keeps the run's store version: the store already has it, or gets it from this attempt.
  return { version, channel: "dev", manifest: { version: `${core}.${run}`, version_name: version } }
}

/**
 * The dev build of a workflow run: the next patch after the stable version in cli/package.json, with -dev.<run number>,
 * and .<attempt> on a rerun so no npm version is ever reused. Run numbers only grow and the base only moves forward with
 * releases, so every dev build sorts above the one before it, on npm (auto-update) and in the store (0.1.1.42).
 */
export function devVersion(current: string, run: number, attempt = 1) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
  if (!match) throw new Error(`cli/package.json version ${JSON.stringify(current)} isn't a stable release`)
  if (!Number.isSafeInteger(run) || run < 1 || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error(`Invalid run ${run} (attempt ${attempt})`)
  if (run > MANIFEST_PART_MAX) throw new Error(`Run ${run} doesn't fit a Chrome manifest version (at most ${MANIFEST_PART_MAX})`)
  const [, major, minor, patch] = match
  return `${major}.${minor}.${Number(patch) + 1}-dev.${run}${attempt > 1 ? `.${attempt}` : ""}`
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

export const currentVersion = async () => (JSON.parse(await readFile(path.join(root, "cli", "package.json"), "utf8")) as { version: string }).version

if (import.meta.main) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { run: { type: "string" }, attempt: { type: "string" } } })
  const [command, argument] = positionals
  try {
    if (command === "set" && argument) {
      parseReleaseVersion(argument)
      await setVersion(argument)
      console.log(argument)
    } else if (command === "dev" && values.run) {
      const version = devVersion(await currentVersion(), Number(values.run), Number(values.attempt ?? 1))
      await setVersion(version)
      console.log(version)
    } else {
      console.error("usage: bun scripts/version.ts set <version> | dev --run <n> [--attempt <n>]")
      process.exit(2)
    }
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`)
    process.exit(1)
  }
}
