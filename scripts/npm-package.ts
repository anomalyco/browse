// Packs the npm packages of the Rust browse (rust/):
//   bun scripts/npm-package.ts main --out <dir>
//       @opencode/browse: opencode-browse-<version>.tgz, the launcher (rust/npm/browse.mjs as dist/cli.mjs, the bin the
//       TypeScript package had) with an optional dependency on each platform package, which npm installs by os, cpu and
//       libc
//   bun scripts/npm-package.ts platforms --binaries <dir> --out <dir>
//       @opencode/browse-<target>: opencode-browse-<target>-<version>.tgz for every install script target, from
//       <dir>/<build>/browse[.exe] (rust/script/release.sh's layout). package/bin/browse, package.json and LICENSE,
//       which the install script (../install) and npm both read. The -baseline targets carry the same binary as their
//       base target: Rust's x86-64 target doesn't use AVX2.
// The version is cli/package.json's (scripts/version.ts), like the extension zip's.
import { $ } from "bun"
import { chmod, cp, mkdir, mkdtemp, readFile, rm, utimes } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { checkBinaryTarball } from "./check-artifacts.ts"

const root = path.resolve(import.meta.dir, "..")
const epoch = new Date("1980-01-01T00:00:00Z")

export type Target = {
  /** The install script's and npm package's name (darwin, not the release service's macos). */
  readonly name: string
  /** The Rust build it ships (rust/script/release.sh). */
  readonly build: string
  readonly os: "linux" | "darwin" | "win32"
  readonly cpu: "x64" | "arm64"
  readonly libc?: "glibc" | "musl"
}

const target = (name: string, build = name): Target => {
  const [system, cpu] = name.split("-") as [string, Target["cpu"]]
  const npmOs = system === "windows" ? "win32" : (system as Target["os"])
  return { name, build, os: npmOs, cpu, ...(npmOs === "linux" ? { libc: name.endsWith("-musl") ? "musl" : "glibc" } : {}) }
}

/** Every target the install script picks from; keep in step with .github/release/publish-*.sh and the release workflow. */
export const TARGETS: readonly Target[] = [
  target("linux-x64"),
  target("linux-x64-baseline", "linux-x64"),
  target("linux-arm64"),
  target("linux-x64-musl"),
  target("linux-x64-baseline-musl", "linux-x64-musl"),
  target("linux-arm64-musl"),
  target("darwin-arm64"),
  target("darwin-x64"),
  target("darwin-x64-baseline", "darwin-x64"),
  target("windows-x64"),
  target("windows-x64-baseline", "windows-x64"),
]

/** The platform packages @opencode/browse depends on: one per build (a baseline package is the same binary). */
export const LAUNCHER_TARGETS = TARGETS.filter((item) => item.name === item.build)

export const BUILDS = [...new Set(TARGETS.map((item) => item.build))]

export async function releaseVersion() {
  return (JSON.parse(await readFile(path.join(root, "cli", "package.json"), "utf8")) as { version: string }).version
}

async function npmPack(directory: string, out: string) {
  const packed = JSON.parse(await $`npm pack --json --ignore-scripts --pack-destination ${out}`.cwd(directory).quiet().text()) as { filename: string }[]
  return path.join(out, packed[0]!.filename.replace(/^@/, "").replace("/", "-"))
}

async function staging<T>(use: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browse-npm-"))
  try {
    return await use(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** @opencode/browse at `version`, packed into `out`. */
export async function packMain(version: string, out: string) {
  await mkdir(out, { recursive: true })
  const template = JSON.parse(await readFile(path.join(root, "rust", "npm", "package.json"), "utf8")) as Record<string, unknown>
  const { name, ...rest } = template
  const pkg = {
    name,
    version,
    ...rest,
    optionalDependencies: Object.fromEntries(LAUNCHER_TARGETS.map((item) => [`@opencode/browse-${item.name}`, version])),
  }
  return staging(async (directory) => {
    await mkdir(path.join(directory, "dist"))
    await cp(path.join(root, "rust", "npm", "browse.mjs"), path.join(directory, "dist", "cli.mjs"))
    await chmod(path.join(directory, "dist", "cli.mjs"), 0o755)
    await cp(path.join(root, "LICENSE"), path.join(directory, "LICENSE"))
    await Bun.write(path.join(directory, "package.json"), JSON.stringify(pkg, null, 2) + "\n")
    return npmPack(directory, out)
  })
}

/** What the binary for `item` must be: its format, CPU and, on Linux, its C library. */
export function binaryProblems(bytes: Uint8Array, item: Target, label: string): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const problems: string[] = []
  if (bytes.length < 64) return [`${label}: is ${bytes.length} bytes, not an executable`]
  if (item.os === "linux") {
    if (view.getUint32(0) !== 0x7f454c46) return [`${label}: isn't an ELF executable`]
    const machine = view.getUint16(18, true)
    if (machine !== (item.cpu === "x64" ? 0x3e : 0xb7)) problems.push(`${label}: is for ELF machine 0x${machine.toString(16)}, not ${item.cpu}`)
    const text = Buffer.from(bytes).toString("latin1")
    const dynamic = text.includes("ld-linux")
    if (item.libc === "musl" && dynamic) problems.push(`${label}: links glibc's loader; the musl build must be static`)
    if (item.libc === "glibc") {
      if (!dynamic) problems.push(`${label}: doesn't load glibc's ld-linux; is it the musl build?`)
      // The gnu builds target glibc 2.17 (cargo zigbuild --target <triple>.2.17), so they run on any current distro.
      const newest = Math.max(0, ...[...text.matchAll(/GLIBC_2\.(\d+)/g)].map((match) => Number(match[1])))
      if (newest > 17) problems.push(`${label}: needs GLIBC_2.${newest}; build it against glibc 2.17`)
    }
  } else if (item.os === "darwin") {
    if (view.getUint32(0, true) !== 0xfeedfacf) return [`${label}: isn't a 64-bit Mach-O executable`]
    const cpu = view.getUint32(4, true)
    if (cpu !== (item.cpu === "x64" ? 0x01000007 : 0x0100000c)) problems.push(`${label}: is for Mach-O CPU 0x${cpu.toString(16)}, not ${item.cpu}`)
  } else {
    if (view.getUint16(0) !== 0x4d5a) return [`${label}: isn't a PE executable`]
    const pe = view.getUint32(0x3c, true)
    const machine = pe + 6 <= bytes.length ? view.getUint16(pe + 4, true) : 0
    if (machine !== 0x8664) problems.push(`${label}: is for PE machine 0x${machine.toString(16)}, not x64`)
    // Windows doesn't always have the Visual C++ runtime; the build links it statically (+crt-static).
    if (/vcruntime140\.dll/i.test(Buffer.from(bytes).toString("latin1"))) problems.push(`${label}: needs vcruntime140.dll; build with -C target-feature=+crt-static`)
  }
  return problems
}

/** Every platform package at `version`, from the Rust builds in `binaries`, packed into `out` and checked. */
export async function packPlatforms(binaries: string, version: string, out: string, only?: readonly string[]) {
  await mkdir(out, { recursive: true })
  const problems: string[] = []
  const tarballs: string[] = []
  for (const item of TARGETS.filter((entry) => !only || only.includes(entry.name))) {
    const executable = item.os === "win32" ? "browse.exe" : "browse"
    const source = path.join(binaries, item.build, executable)
    const bytes = new Uint8Array(await readFile(source).catch(() => Buffer.alloc(0)))
    if (!bytes.length) {
      problems.push(`missing ${source}`)
      continue
    }
    const binaryIssues = binaryProblems(bytes, item, `${item.build}/${executable}`)
    if (binaryIssues.length) {
      problems.push(...binaryIssues)
      continue
    }
    const tarball = await staging(async (directory) => {
      await mkdir(path.join(directory, "bin"))
      const binary = path.join(directory, "bin", executable)
      await cp(source, binary)
      // GitHub artifact downloads lose execute bits, and the install script runs package/bin/browse straight from the tarball.
      await chmod(binary, 0o755)
      await utimes(binary, epoch, epoch)
      await cp(path.join(root, "LICENSE"), path.join(directory, "LICENSE"))
      const pkg = {
        name: `@opencode/browse-${item.name}`,
        version,
        description: `The browse binary for ${item.name}.`,
        license: "MIT",
        repository: { type: "git", url: "git+https://github.com/anomalyco/browse.git", directory: "rust" },
        os: [item.os],
        cpu: [item.cpu],
        ...(item.libc ? { libc: [item.libc] } : {}),
        publishConfig: { access: "public" },
      }
      await Bun.write(path.join(directory, "package.json"), JSON.stringify(pkg, null, 2) + "\n")
      return npmPack(directory, out)
    })
    problems.push(...(await checkBinaryTarball(tarball, version, item.name)))
    tarballs.push(tarball)
    console.log(`${path.basename(tarball)} (${(Bun.file(tarball).size / 1024 / 1024).toFixed(1)} MB)`)
  }
  return { tarballs, problems }
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string" }, binaries: { type: "string" }, version: { type: "string" }, target: { type: "string", multiple: true } },
  })
  const version = values.version ?? (await releaseVersion())
  const [command] = positionals
  if (command === "main" && values.out) {
    console.log(await packMain(version, path.resolve(values.out)))
  } else if (command === "platforms" && values.out && values.binaries) {
    const { problems } = await packPlatforms(path.resolve(values.binaries), version, path.resolve(values.out), values.target)
    for (const problem of problems) console.error(`✗ ${problem}`)
    if (problems.length) process.exit(1)
  } else {
    console.error("usage: bun scripts/npm-package.ts main --out <dir> | platforms --binaries <dir> --out <dir> [--target <name>]... [--version <v>]")
    process.exit(2)
  }
}
