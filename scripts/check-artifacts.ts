// Checks the two release artifacts before anything is published, the same way locally (`bun run release:check`) and in
// the release workflow:
//   store zip   no manifest `key` or `update_url`, no relay-pairing.json, no source maps, no test-only hooks, the default
//               relay port, the release version, and exactly the capabilities in store/permissions.json
//   npm tarball @opencode/browse at the release version, only dist/, extension/, skills/ and package metadata, no install
//               scripts, no pairing code or source maps, and its bundled extension on the same allowlist
//   bun scripts/check-artifacts.ts --version 0.1.0 --zip release/opencode-browser-0.1.0.zip --tarball release/opencode-browse-0.1.0.tgz
import { $ } from "bun"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { manifestVersionFields } from "./version.ts"

const root = path.resolve(import.meta.dir, "..")
export const PACKAGE_NAME = "@opencode/browse"
const DEFAULT_RELAY_PORT = "19988"

/** Strings that only development or test builds contain. */
const TEST_ONLY_MARKERS = [
  "sourceMappingURL",
  "@vite/client",
  "import.meta.hot",
  "__vite_ping",
  "OPENCODE_BROWSER_TEST",
  "__OPENCODE_BROWSER_TEST",
  "BROWSE_TEST_",
  // The stress harness's hooks (vite.config.ts OPENCODE_BROWSER_TEST_HOOKS).
  "__opencodeBrowserTest",
]
const STORE_FILE_TYPES = /\.(js|css|html|json|png|svg)$/

type Allowlist = Record<"permissions" | "optional_permissions" | "host_permissions" | "optional_host_permissions" | "content_scripts" | "web_accessible_resources", unknown[]> & {
  externally_connectable: unknown
}

export async function readAllowlist(file = path.join(root, "store", "permissions.json")): Promise<Allowlist> {
  return JSON.parse(await readFile(file, "utf8")) as Allowlist
}

const sorted = (value: unknown) => (Array.isArray(value) ? [...value].map((item) => JSON.stringify(item)).sort() : value)

/** Every difference between a manifest's capabilities and the allowlist, in words. */
export function capabilityProblems(manifest: Record<string, unknown>, allowlist: Allowlist, label: string): string[] {
  const problems: string[] = []
  const lists = ["permissions", "optional_permissions", "host_permissions", "optional_host_permissions", "content_scripts", "web_accessible_resources"] as const
  for (const key of lists) {
    const actual = (sorted(manifest[key] ?? []) as string[])
    const allowed = (sorted(allowlist[key]) as string[])
    const added = actual.filter((item) => !allowed.includes(item))
    const removed = allowed.filter((item) => !actual.includes(item))
    if (added.length) problems.push(`${label}: ${key} adds ${added.join(", ")} (not in store/permissions.json; review it, then add it there and justify it in store/listing.md)`)
    if (removed.length) problems.push(`${label}: ${key} no longer has ${removed.join(", ")} (remove it from store/permissions.json)`)
  }
  if (JSON.stringify(manifest.externally_connectable ?? null) !== JSON.stringify(allowlist.externally_connectable ?? null))
    problems.push(`${label}: externally_connectable differs from store/permissions.json`)
  return problems
}

function versionProblems(manifest: Record<string, unknown>, version: string, label: string) {
  const expected = manifestVersionFields(version)
  const problems: string[] = []
  if (manifest.version !== expected.version) problems.push(`${label}: manifest version ${String(manifest.version)} should be ${expected.version} for ${version}`)
  if ((manifest.version_name ?? undefined) !== expected.version_name)
    problems.push(`${label}: manifest version_name ${String(manifest.version_name)} should be ${String(expected.version_name)}`)
  return problems
}

const relative = (directory: string, entry: { parentPath: string; name: string }) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")

async function files(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => relative(directory, entry))
}

/** What no artifact may contain anywhere: symbolic links (and anything else that isn't a file or folder) and source maps. */
async function structureProblems(directory: string, label: string): Promise<string[]> {
  const problems: string[] = []
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    const name = relative(directory, entry)
    if (entry.isSymbolicLink()) problems.push(`${label}: ${name} is a symbolic link`)
    else if (!entry.isFile() && !entry.isDirectory()) problems.push(`${label}: ${name} isn't a regular file`)
    else if (entry.isFile() && name.endsWith(".map")) problems.push(`${label}: contains source map ${name}`)
  }
  return problems
}

async function extracted<T>(prefix: string, extract: (directory: string) => Promise<void>, use: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    await extract(directory)
    return await use(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Problems shared by both copies of the extension: pairing code, source maps, development markers. */
async function extensionContentProblems(directory: string, label: string) {
  const problems: string[] = []
  const names = await files(directory)
  for (const name of names) {
    if (path.basename(name) === "relay-pairing.json") problems.push(`${label}: contains ${name}, this machine's pairing code`)
    if (name.endsWith(".map")) problems.push(`${label}: contains source map ${name}`)
  }
  for (const name of names.filter((file) => /\.(js|html|css)$/.test(file))) {
    const text = await readFile(path.join(directory, name), "utf8")
    for (const marker of TEST_ONLY_MARKERS) if (text.includes(marker)) problems.push(`${label}: ${name} contains the development/test marker ${JSON.stringify(marker)}`)
  }
  const scripts = await Promise.all(names.filter((file) => file.endsWith(".js")).map((file) => readFile(path.join(directory, file), "utf8")))
  if (!scripts.some((text) => text.includes(DEFAULT_RELAY_PORT))) problems.push(`${label}: no script uses the default relay port ${DEFAULT_RELAY_PORT} (a port-patched test build?)`)
  return { names, problems }
}

export async function checkStoreZip(zip: string, version: string, allowlist?: Allowlist): Promise<string[]> {
  const allowed = allowlist ?? (await readAllowlist())
  const label = path.basename(zip)
  const listing = (await $`unzip -Z1 ${zip}`.quiet().text()).split("\n").filter(Boolean)
  const unsafe = listing.filter((name) => name.startsWith("/") || name.split("/").includes(".."))
  if (unsafe.length) return [`${label}: unsafe entry paths ${unsafe.join(", ")}`]
  // Symbolic links, found in the archive listing (unzip would follow or refuse them).
  const links = (await $`unzip -Z ${zip}`.quiet().text()).split("\n").filter((line) => /^l[rwx-]{9}/.test(line)).map((line) => line.split(/\s+/).pop())
  if (links.length) return links.map((name) => `${label}: ${name} is a symbolic link`)
  return extracted("browse-zip-", async (directory) => void (await $`unzip -q ${zip} -d ${directory}`.quiet()), async (directory) => {
    const structure = await structureProblems(directory, label)
    if (structure.length) return structure
    const { names, problems } = await extensionContentProblems(directory, label)
    if (!names.includes("manifest.json")) return [...problems, `${label}: no manifest.json at the top level`]
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as Record<string, unknown>
    if ("key" in manifest) problems.push(`${label}: manifest has \`key\` (the store assigns the ID and rejects it)`)
    if ("update_url" in manifest) problems.push(`${label}: manifest has \`update_url\` (the store rejects it)`)
    if (manifest.manifest_version !== 3) problems.push(`${label}: manifest_version is not 3`)
    for (const name of names) if (!STORE_FILE_TYPES.test(name)) problems.push(`${label}: unexpected file type ${name}`)
    for (const required of ["background.js", "content.js", "welcome.html"]) if (!names.includes(required)) problems.push(`${label}: missing ${required}`)
    problems.push(...versionProblems(manifest, version, label), ...capabilityProblems(manifest, allowed, label))
    return problems
  })
}

export async function checkPackageTarball(tarball: string, version: string, allowlist?: Allowlist): Promise<string[]> {
  const allowed = allowlist ?? (await readAllowlist())
  const label = path.basename(tarball)
  return extracted("browse-tgz-", async (directory) => void (await $`tar -xzf ${tarball} -C ${directory}`.quiet()), async (directory) => {
    const packageDir = path.join(directory, "package")
    const structure = await structureProblems(directory, label)
    if (structure.some((problem) => !problem.includes("source map"))) return structure
    const names = await files(packageDir)
    const problems: string[] = [...structure]
    const allowedFile = (name: string) => /^(dist|extension|skills)\//.test(name) || ["package.json", "LICENSE", "README.md"].includes(name)
    for (const name of names) if (!allowedFile(name)) problems.push(`${label}: unexpected file ${name}`)
    for (const name of names) if (/(^|\/)\.env/.test(name) || /\.(pem|key|p12)$/.test(name)) problems.push(`${label}: looks like a secret: ${name}`)
    const pkg = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as {
      name?: string
      version?: string
      bin?: Record<string, string>
      scripts?: Record<string, string>
    }
    if (pkg.name !== PACKAGE_NAME) problems.push(`${label}: package name ${String(pkg.name)} should be ${PACKAGE_NAME}`)
    if (pkg.version !== version) problems.push(`${label}: package version ${String(pkg.version)} should be ${version}`)
    for (const hook of ["preinstall", "install", "postinstall", "prepare"])
      if (pkg.scripts?.[hook]) problems.push(`${label}: has a ${hook} script; installs must not run code`)
    for (const bin of ["browse", "opencode-browser"]) if (pkg.bin?.[bin] !== "dist/cli.mjs") problems.push(`${label}: bin ${bin} should be dist/cli.mjs`)
    // Every script in dist/, not just the entry.
    for (const name of names.filter((file) => file.startsWith("dist/") && /\.[mc]?js$/.test(file))) {
      const text = await readFile(path.join(packageDir, name), "utf8")
      for (const marker of TEST_ONLY_MARKERS) if (text.includes(marker)) problems.push(`${label}: ${name} contains the development/test marker ${JSON.stringify(marker)}`)
    }
    if (!names.includes("dist/cli.mjs")) problems.push(`${label}: missing dist/cli.mjs`)
    else {
      const cli = await readFile(path.join(packageDir, "dist", "cli.mjs"), "utf8")
      if (!cli.startsWith("#!/usr/bin/env node")) problems.push(`${label}: dist/cli.mjs has no node shebang`)
      if (!cli.includes(JSON.stringify(version))) problems.push(`${label}: dist/cli.mjs doesn't carry version ${version}`)
      if (cli.includes("sourceMappingURL")) problems.push(`${label}: dist/cli.mjs references a source map`)
    }
    const extension = path.join(packageDir, "extension")
    if (!names.includes("extension/manifest.json")) return [...problems, `${label}: missing extension/manifest.json`]
    const content = await extensionContentProblems(extension, `${label} extension/`)
    problems.push(...content.problems)
    const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8")) as Record<string, unknown>
    // The unpacked copy keeps `key`: it pins the unpacked ID the relay's allowed origins expect.
    if (typeof manifest.key !== "string") problems.push(`${label}: extension/manifest.json lost its \`key\` (the unpacked ID would change)`)
    problems.push(...versionProblems(manifest, version, `${label} extension/`), ...capabilityProblems(manifest, allowed, `${label} extension/`))
    return problems
  })
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { version: { type: "string" }, zip: { type: "string" }, tarball: { type: "string" } } })
  if (!values.version || (!values.zip && !values.tarball)) {
    console.error("usage: bun scripts/check-artifacts.ts --version <version> [--zip <file>] [--tarball <file>]")
    process.exit(2)
  }
  const problems = [
    ...(values.zip ? await checkStoreZip(values.zip, values.version) : []),
    ...(values.tarball ? await checkPackageTarball(values.tarball, values.version) : []),
  ]
  for (const problem of problems) console.error(`✗ ${problem}`)
  if (problems.length) process.exit(1)
  console.log(`✓ ${[values.zip, values.tarball].filter(Boolean).map((file) => path.basename(file!)).join(" and ")} passed the release checks for ${values.version}`)
}
