// Checks the two release artifacts before anything is published, the same way locally (`bun run release:check`) and in
// the release workflow:
//   extension zip  no `update_url`, no relay-pairing.json, no source maps, no test-only hooks, the default relay port,
//                  the release version, and exactly the capabilities in store/permissions.json; the store zip (stable)
//                  has no manifest `key`, the dev zip (loaded unpacked) has the checkout's key and a build.json
//   npm tarball    @opencode/browse at the release version, only dist/, skills/ and package metadata (no extension: npm
//                  installs get it from the store or, for a dev build, the release service), no install scripts, no
//                  source maps, and it installs with npm and starts its relay and MCP server
//   bun scripts/check-artifacts.ts --version 0.1.0 --zip release/opencode-browser-0.1.0.zip --tarball release/opencode-browse-0.1.0.tgz
import { $ } from "bun"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
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

/** Problems in the extension's files: pairing code, source maps, development markers. */
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

/** The manifest key that pins the unpacked ID the relay trusts (public/manifest.json). */
async function unpackedKey() {
  return (JSON.parse(await readFile(path.join(root, "public", "manifest.json"), "utf8")) as { key?: string }).key
}

/**
 * The extension zip: the store zip for a stable release, or for a dev build (`unpacked`) the zip dev installs load
 * unpacked, which must carry the checkout's manifest key (the ID the relay trusts) and passes every other check.
 */
export async function checkStoreZip(zip: string, version: string, allowlist?: Allowlist, unpacked = false): Promise<string[]> {
  const key = unpacked ? await unpackedKey() : undefined
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
    if (unpacked) {
      if (!key || manifest.key !== key) problems.push(`${label}: manifest \`key\` isn't public/manifest.json's, so it wouldn't load with the unpacked ID the relay trusts`)
      if (!names.includes("build.json")) problems.push(`${label}: missing build.json (the relay reloads a dev extension by its build)`)
    } else if ("key" in manifest) problems.push(`${label}: manifest has \`key\` (the store assigns the ID and rejects it)`)
    if ("update_url" in manifest) problems.push(`${label}: manifest has \`update_url\` (the store rejects it)`)
    if (manifest.manifest_version !== 3) problems.push(`${label}: manifest_version is not 3`)
    for (const name of names) if (!STORE_FILE_TYPES.test(name)) problems.push(`${label}: unexpected file type ${name}`)
    for (const required of ["background.js", "content.js", "welcome.html", "onboarding.html", "settings.html"]) if (!names.includes(required)) problems.push(`${label}: missing ${required}`)
    problems.push(...versionProblems(manifest, version, label), ...capabilityProblems(manifest, allowed, label))
    return problems
  })
}

/** `extensionSha256`: a dev build's CLI must carry the sha256 of the extension zip published with it. */
export async function checkPackageTarball(tarball: string, version: string, extensionSha256?: string): Promise<string[]> {
  const label = path.basename(tarball)
  return extracted("browse-tgz-", async (directory) => void (await $`tar -xzf ${tarball} -C ${directory}`.quiet()), async (directory) => {
    const packageDir = path.join(directory, "package")
    const structure = await structureProblems(directory, label)
    if (structure.some((problem) => !problem.includes("source map"))) return structure
    const names = await files(packageDir)
    const problems: string[] = [...structure]
    const allowedFile = (name: string) => /^(dist|skills)\//.test(name) || ["package.json", "LICENSE", "README.md"].includes(name)
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
    const distTexts: string[] = []
    for (const name of names.filter((file) => file.startsWith("dist/") && /\.[mc]?js$/.test(file))) {
      const text = await readFile(path.join(packageDir, name), "utf8")
      distTexts.push(text)
      for (const marker of TEST_ONLY_MARKERS) if (text.includes(marker)) problems.push(`${label}: ${name} contains the development/test marker ${JSON.stringify(marker)}`)
    }
    if (!names.includes("dist/cli.mjs")) problems.push(`${label}: missing dist/cli.mjs`)
    else {
      const cli = await readFile(path.join(packageDir, "dist", "cli.mjs"), "utf8")
      if (!cli.startsWith("#!/usr/bin/env node")) problems.push(`${label}: dist/cli.mjs has no node shebang`)
      if (!cli.includes(JSON.stringify(version))) problems.push(`${label}: dist/cli.mjs doesn't carry version ${version}`)
      if (cli.includes("sourceMappingURL")) problems.push(`${label}: dist/cli.mjs references a source map`)
      if (extensionSha256 && !distTexts.some((text) => text.includes(extensionSha256))) {
        problems.push(`${label}: dist/ doesn't carry the dev extension zip's sha256 ${extensionSha256}`)
      }
    }
    return problems
  })
}

/**
 * The tarball installed the way users get it (`npm install`, resolving dependency ranges fresh, no lockfile), then its
 * relay started on a free port with a throwaway home and its MCP server asked for its tools, as the binaries are in
 * the release workflow. Catches a dependency that resolves to a version the build doesn't work with, which the file
 * checks above can't see.
 */
export async function checkPackageInstall(tarball: string, version: string): Promise<string[]> {
  const file = path.resolve(tarball)
  const label = path.basename(file)
  const directory = await mkdtemp(path.join(os.tmpdir(), "browse-install-"))
  try {
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ private: true }))
    const env = smokeEnv(directory)
    const install = await $`npm install --ignore-scripts --no-audit --no-fund --no-package-lock file:${file}`.cwd(directory).env(env).quiet().nothrow()
    if (install.exitCode !== 0) return [`${label}: npm install failed:\n${tail(install.stderr.toString())}`]
    const cli = path.join(directory, "node_modules", PACKAGE_NAME, "dist", "cli.mjs")
    return await checkCliRuntime(["node", cli], directory, version)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const tail = (text: string) => text.trim().split("\n").slice(-8).join("\n")

/** Don't inherit a developer's agent configuration, relay settings, NODE_PATH or npm credentials. */
export function smokeEnv(home: string): Record<string, string> {
  const system = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SystemRoot|ComSpec|WINDIR|PROCESSOR_ARCHITECTURE|PROGRAMFILES)$/i.test(key))) as Record<string, string>
  return { ...system, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TMPDIR: home, TEMP: home, TMP: home,
    OPENCODE_BROWSER_HOME: path.join(home, "relay"), OPENCODE_BROWSER_UPDATE_CHECK: "0", OPENCODE_BROWSER_AUTOSTART: "false" }
}

/** Same contract for an installed npm CLI, the naked binary and the install script's output. */
export async function checkCliRuntime(command: string[], cwd: string, version: string, withMcp = true): Promise<string[]> {
  const port = await freeSmokePort()
  const env = { ...smokeEnv(cwd), OPENCODE_BROWSER_PORT: String(port) }
  const actual = await $`${command} --version`.cwd(cwd).env(env).quiet().text()
  if (actual.trim() !== version) return [`--version printed ${JSON.stringify(actual.trim())}, expected ${version}`]
  const relay = Bun.spawn([...command, "serve"], { cwd, env, stdout: "ignore", stderr: "pipe" })
  const errors = new Response(relay.stderr).text()
  try {
    const running = await relayVersion(port, relay)
    if (running === undefined) {
      relay.kill("SIGKILL")
      return [`browse serve didn't start on ${port}:\n${tail(await errors)}`]
    }
    if (running !== version) return [`/version reported ${running}, expected ${version}`]
    if (!withMcp) return []
    const tools = await mcpTools(command, cwd, env)
    return typeof tools === "number" && tools > 0 ? [] : [`browse mcp listed no tools:\n${tail(String(tools))}`]
  } finally {
    relay.kill("SIGKILL")
    await relay.exited
  }
}

/** The version a relay reports once it answers /version, or undefined if it exits or 30 seconds pass first. */
async function relayVersion(port: number, relay: Bun.Subprocess) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && relay.exitCode === null) {
    const response = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined)
    if (response?.ok) return String(((await response.json()) as { version?: unknown }).version)
    await Bun.sleep(250)
  }
  return undefined
}

/** How many tools the MCP server lists after initialize, or what it printed when it didn't answer in 30 seconds. */
async function mcpTools(command: string[], cwd: string, env: Record<string, string | undefined>): Promise<number | string> {
  const mcp = Bun.spawn([...command, "mcp"], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(mcp.stderr).text()
  const reader = mcp.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  type Response = { id?: number; result?: { protocolVersion?: string; tools?: unknown[] } }
  const response = async (id: number): Promise<Response | undefined> => {
    for (;;) {
      for (const line of output.split("\n")) {
        try {
          const message = JSON.parse(line) as Response
          if (message.id === id) return message
        } catch {}
      }
      const chunk = await reader.read()
      if (chunk.done) return undefined
      output += decoder.decode(chunk.value, { stream: true })
    }
  }
  const send = (message: object) => mcp.stdin.write(`${JSON.stringify(message)}\n`)
  const timeout = Promise.withResolvers<undefined>()
  const timer = setTimeout(() => timeout.resolve(undefined), 30_000)
  try {
    const listed = await Promise.race([
      (async () => {
        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-check", version: "0" } } })
        if (!(await response(1))?.result?.protocolVersion) return undefined
        send({ jsonrpc: "2.0", method: "notifications/initialized" })
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
        return (await response(2))?.result?.tools?.length
      })(),
      timeout.promise,
    ])
    if (listed !== undefined) return listed
    mcp.kill("SIGKILL")
    return `${output}\n${await errors}`
  } finally {
    clearTimeout(timer)
    mcp.kill("SIGKILL")
    await mcp.exited
  }
}

export async function freeSmokePort(exclude?: number) {
  const start = Math.floor(Math.random() * 100)
  for (let i = 0; i < 100; i++) {
    const port = 19600 + (start + i) % 100
    if (port === exclude) continue
    const free = await new Promise<boolean>((resolve, reject) => {
      const server = net.createServer().once("error", (e: NodeJS.ErrnoException) => e.code === "EADDRINUSE" ? resolve(false) : reject(e))
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error("No free eval port in 19600–19699")
}

/**
 * A platform package (cli/script/pack.ts): @opencode/browse-<target> at the release version with exactly
 * package/bin/browse (browse.exe on Windows, mode 755), package.json and LICENSE, the os/cpu/libc npm installs by, and
 * no install scripts. The install script (../install) downloads it from npm and runs package/bin/browse.
 */
export async function checkBinaryTarball(tarball: string, version: string, target: string): Promise<string[]> {
  const label = path.basename(tarball)
  const [os, arch, ...rest] = target.split("-")
  const musl = rest.includes("musl")
  const executable = `package/bin/${os === "windows" ? "browse.exe" : "browse"}`
  const problems: string[] = []
  const listing = (await $`tar -tvzf ${tarball}`.quiet().text()).split("\n").filter(Boolean)
  const entries = new Map(listing.map((line) => [line.split(/\s+/).pop()!, line.slice(0, 10)]))
  const expected = ["package/package.json", "package/LICENSE", executable]
  for (const name of entries.keys()) if (!expected.includes(name)) problems.push(`${label}: unexpected entry ${name}`)
  for (const name of expected) if (!entries.has(name)) problems.push(`${label}: missing ${name}`)
  if (entries.has(executable) && entries.get(executable) !== "-rwxr-xr-x") problems.push(`${label}: ${executable} has mode ${entries.get(executable)}, expected -rwxr-xr-x`)
  if (problems.length) return problems
  const pkg = JSON.parse(await $`tar -xzOf ${tarball} package/package.json`.quiet().text()) as {
    name?: string
    version?: string
    os?: string[]
    cpu?: string[]
    libc?: string[]
    bin?: unknown
    scripts?: Record<string, string>
    publishConfig?: Record<string, unknown>
  }
  const want = { name: `@opencode/browse-${target}`, version, os: [os === "windows" ? "win32" : os], cpu: [arch], libc: os === "linux" ? [musl ? "musl" : "glibc"] : undefined }
  for (const key of ["name", "version", "os", "cpu", "libc"] as const)
    if (JSON.stringify(pkg[key]) !== JSON.stringify(want[key])) problems.push(`${label}: ${key} is ${JSON.stringify(pkg[key])}, expected ${JSON.stringify(want[key])}`)
  if (pkg.scripts && Object.keys(pkg.scripts).length) problems.push(`${label}: has scripts; installs must not run code`)
  if (pkg.bin !== undefined) problems.push(`${label}: has bin; the install script runs package/bin directly`)
  if (Object.keys(pkg.publishConfig ?? {}).some((key) => key !== "access")) problems.push(`${label}: sets publishConfig beyond access`)
  const head = Buffer.from(await $`tar -xzOf ${tarball} ${executable} | head -c 4`.quiet().nothrow().arrayBuffer())
  const magic = os === "windows" ? "4d5a" : os === "darwin" ? "cffaedfe" : "7f454c46"
  if (!head.toString("hex").startsWith(magic)) problems.push(`${label}: ${executable} isn't a ${os} executable`)
  return problems
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { version: { type: "string" }, zip: { type: "string" }, tarball: { type: "string" } } })
  if (!values.version || (!values.zip && !values.tarball)) {
    console.error("usage: bun scripts/check-artifacts.ts --version <version> [--zip <file>] [--tarball <file>]")
    process.exit(2)
  }
  const problems = [
    ...(values.zip ? await checkStoreZip(values.zip, values.version, undefined, values.version.includes("-dev.")) : []),
    ...(values.tarball ? await checkPackageTarball(values.tarball, values.version) : []),
    ...(values.tarball ? await checkPackageInstall(values.tarball, values.version) : []),
  ]
  for (const problem of problems) console.error(`✗ ${problem}`)
  if (problems.length) process.exit(1)
  console.log(`✓ ${[values.zip, values.tarball].filter(Boolean).map((file) => path.basename(file!)).join(" and ")} passed the release checks for ${values.version}`)
}
