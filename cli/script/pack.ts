// Packs every compiled binary in dist-bin/ (script/compile.ts) into its npm tarball, opencode-browse-<target>-<version>.tgz,
// and checks it (scripts/check-artifacts.ts):
//   bun script/pack.ts [--out <dir>]    default dist-bin/npm
// npm pack gives every entry a fixed mtime and normalizes modes, so the binary is made executable first: GitHub artifact
// downloads lose execute bits, and the install script runs package/bin/browse straight from the tarball.
import { $ } from "bun"
import { chmod, cp, mkdir, readdir, rm, utimes } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { checkBinaryTarball } from "../../scripts/check-artifacts.ts"

const here = path.resolve(import.meta.dir, "..")
const dist = path.join(here, "dist-bin")
const { values } = parseArgs({ options: { out: { type: "string" } } })
const out = path.resolve(values.out ?? path.join(dist, "npm"))
const version: string = (await Bun.file(path.join(here, "package.json")).json()).version
const epoch = new Date("1980-01-01T00:00:00Z")

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
const names = (await readdir(dist)).filter((name) => name.startsWith("browse-")).sort()
if (!names.length) throw new Error(`No binaries in ${dist}; run script/compile.ts first`)

const problems: string[] = []
for (const name of names) {
  const directory = path.join(dist, name)
  const target = name.slice("browse-".length)
  const binary = path.join(directory, "bin", target.startsWith("windows-") ? "browse.exe" : "browse")
  const pkg = await Bun.file(path.join(directory, "package.json")).json()
  if (pkg.version !== version) throw new Error(`${name} is version ${pkg.version}, expected ${version}`)
  if (!Bun.file(binary).size) throw new Error(`Missing binary ${binary}`)
  await chmod(binary, 0o755)
  await utimes(binary, epoch, epoch)
  await cp(path.join(here, "..", "LICENSE"), path.join(directory, "LICENSE"))
  const packed = JSON.parse(await $`npm pack --json --ignore-scripts --pack-destination ${out}`.cwd(directory).quiet().text()) as { filename: string }[]
  const tarball = path.join(out, packed[0]!.filename.replace(/^@/, "").replace("/", "-"))
  problems.push(...(await checkBinaryTarball(tarball, version, target)))
  console.log(`${path.basename(tarball)} (${(Bun.file(tarball).size / 1024 / 1024).toFixed(1)} MB)`)
}
if (problems.length) {
  for (const problem of problems) console.error(`✗ ${problem}`)
  process.exit(1)
}
