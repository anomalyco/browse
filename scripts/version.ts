// The one release version: cli/package.json, the root package.json and the extension manifest move together.
// npm takes the version as is (0.1.0, 0.1.0-beta.2). Chrome's manifest `version` must be one to four dot-separated
// integers, so a beta becomes 0.1.0.2 with `version_name` "0.1.0-beta.2" for display. Betas go to their own unlisted
// store item (RELEASING.md), so a beta's four-part version never has to sort below the stable release that follows it.

/** A stable release (1.2.3) or a beta (1.2.3-beta.4); nothing else is released. */
export const RELEASE_VERSION = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})(?:-beta\.([1-9]\d{0,4}))?$/

export type ReleaseVersion = { version: string; channel: "latest" | "beta"; manifest: { version: string; version_name?: string } }

export function parseReleaseVersion(version: string): ReleaseVersion {
  const match = RELEASE_VERSION.exec(version)
  if (!match) throw new Error(`Not a release version: ${JSON.stringify(version)} (use 1.2.3 or 1.2.3-beta.4)`)
  const [, major, minor, patch, beta] = match
  if (!beta) return { version, channel: "latest", manifest: { version } }
  return { version, channel: "beta", manifest: { version: `${major}.${minor}.${patch}.${beta}`, version_name: version } }
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
