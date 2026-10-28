// Builds and checks the release artifacts exactly as the release workflow does, without publishing anything:
//   bun run release:check [--tag v0.1.0] [--require-changelog] [--versions-only]
// 1. the version is one release version everywhere: cli/package.json, package.json, public/manifest.json (and the tag)
// 2. release/opencode-browser-<version>.zip (scripts/package.ts) and release/opencode-browse-<version>.tgz (npm pack of
//    a fresh cli/ build, with the store item IDs from OPENCODE_BROWSER_STORE_ID / OPENCODE_BROWSER_BETA_STORE_ID baked in)
// 3. scripts/check-artifacts.ts on both, then release/SHA256SUMS
import { $ } from "bun"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { checkPackageTarball, checkStoreZip } from "./check-artifacts.ts"
import { manifestVersionFields, parseReleaseVersion } from "./version.ts"

const root = path.resolve(import.meta.dir, "..")
const release = path.join(root, "release")
const json = async (file: string) => JSON.parse(await readFile(path.join(root, file), "utf8")) as Record<string, unknown>

/** Everything that must agree before a release: the versions, the tag, and the changelog entry. */
export async function versionProblems(options: { tag?: string; requireChangelog?: boolean } = {}) {
  const cli = (await json("cli/package.json")).version as string
  const problems: string[] = []
  try {
    parseReleaseVersion(cli)
  } catch (error) {
    problems.push(`cli/package.json: ${(error as Error).message}`)
  }
  const rootVersion = (await json("package.json")).version
  if (rootVersion !== cli) problems.push(`package.json version ${String(rootVersion)} differs from cli/package.json ${cli}`)
  const manifest = await json("public/manifest.json")
  const expected = manifestVersionFields(cli)
  if (manifest.version !== expected.version || (manifest.version_name ?? undefined) !== expected.version_name)
    problems.push(`public/manifest.json version ${String(manifest.version)}${manifest.version_name ? ` (${String(manifest.version_name)})` : ""} should be ${expected.version}${expected.version_name ? ` (${expected.version_name})` : ""}`)
  if (options.tag !== undefined && options.tag !== `v${cli}`) problems.push(`tag ${options.tag} doesn't match cli/package.json version ${cli} (expected v${cli})`)
  if (options.requireChangelog && !existsSync(path.join(root, "changelog", `${cli}.md`))) problems.push(`changelog/${cli}.md is missing`)
  return { version: cli, problems }
}

async function sha256(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { tag: { type: "string" }, "require-changelog": { type: "boolean" }, "versions-only": { type: "boolean" } } })
  const fail = (problems: string[]) => {
    for (const problem of problems) console.error(`✗ ${problem}`)
    process.exit(1)
  }
  const { version, problems } = await versionProblems({ ...(values.tag ? { tag: values.tag } : {}), requireChangelog: values["require-changelog"] ?? false })
  if (problems.length) fail(problems)
  console.log(`✓ version ${version} agrees across cli/package.json, package.json and public/manifest.json${values.tag ? ` and ${values.tag}` : ""}`)
  if (values["versions-only"]) process.exit(0)

  await rm(release, { recursive: true, force: true })
  const zip = (await $`bun scripts/package.ts`.cwd(root).text()).trim().split("\n").pop()!
  await $`bun build.ts`.cwd(path.join(root, "cli"))
  const packed = JSON.parse(await $`npm pack --json --pack-destination ${release}`.cwd(path.join(root, "cli")).text()) as { filename: string }[]
  const tarball = path.join(release, packed[0]!.filename.replace(/^@/, "").replace("/", "-"))
  if (!existsSync(tarball)) fail([`npm pack didn't write ${tarball}`])

  const artifactProblems = [...(await checkStoreZip(zip, version)), ...(await checkPackageTarball(tarball, version))]
  if (artifactProblems.length) fail(artifactProblems)
  const sums = await Promise.all([zip, tarball].map(async (file) => `${await sha256(file)}  ${path.basename(file)}`))
  await writeFile(path.join(release, "SHA256SUMS"), sums.join("\n") + "\n")
  console.log(`✓ ${path.basename(zip)} and ${path.basename(tarball)} passed the release checks`)
  console.log(sums.join("\n"))
}
