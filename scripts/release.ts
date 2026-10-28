// Cuts a release locally: `bun run release <version>` (1.2.3 for stable, 1.2.3-beta.4 for beta).
// 1. Without changelog/<version>.md it writes a draft from the commits since the last tag and stops, so a person
//    rewrites it for users (scripts/changelog.ts). Run the same command again once it's ready.
// 2. Sets the version in cli/package.json, package.json and public/manifest.json (scripts/version.ts).
// 3. Builds and checks both artifacts (scripts/release-check.ts) unless --skip-check.
// 4. Commits "release: v<version>" and makes the annotated tag v<version>, locally. Pushing the tag starts the release
//    workflow (.github/workflows/release.yml), which publishes after the npm and chrome-web-store environments approve.
// It never pushes.
import { $ } from "bun"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { changelogFile, changelogProblems, draftChangelog, parseChangelog } from "./changelog.ts"
import { applyManifestVersion, parseReleaseVersion } from "./version.ts"

const root = path.resolve(import.meta.dir, "..")
const git = (...args: string[]) => $`git ${args}`.cwd(root).quiet().nothrow()

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/** Orders two release versions: a beta sorts below its stable release. */
export function compareVersions(left: string, right: string) {
  const parts = (value: string) => {
    const [core, beta] = value.split("-beta.")
    return [...core!.split(".").map(Number), beta === undefined ? Number.POSITIVE_INFINITY : Number(beta)]
  }
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < 4; index++) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1
  return 0
}

async function setVersion(file: string, update: (data: Record<string, unknown>) => void) {
  const full = path.join(root, file)
  const data = JSON.parse(await readFile(full, "utf8")) as Record<string, unknown>
  update(data)
  await writeFile(full, JSON.stringify(data, null, 2) + "\n")
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { "skip-check": { type: "boolean" } } })
  const version = positionals[0] ?? fail("usage: bun run release <version> [--skip-check]   (1.2.3, or 1.2.3-beta.4)")
  let release
  try {
    release = parseReleaseVersion(version)
  } catch (error) {
    fail((error as Error).message)
  }
  const current = JSON.parse(await readFile(path.join(root, "cli", "package.json"), "utf8")).version as string
  const tag = `v${version}`
  if ((await git("rev-parse", "-q", "--verify", `refs/tags/${tag}`)).exitCode === 0) fail(`tag ${tag} already exists`)
  if (compareVersions(version, current) < 0 || (compareVersions(version, current) === 0 && (await git("tag", "--list", "v*")).text().includes(`v${current}\n`)))
    fail(`${version} isn't newer than the current version ${current}`)
  const changelog = changelogFile(version)
  const relative = path.relative(root, changelog)
  // Only the changelog may be new or changed: the release commit holds exactly the version bump and its entry.
  const dirty = (await git("status", "--porcelain", "--untracked-files=all")).text().split("\n").filter(Boolean).filter((line) => line.slice(3) !== relative)
  if (dirty.length) fail(`the working tree has other changes; commit or stash them first:\n  ${dirty.join("\n  ")}`)
  const branch = (await git("branch", "--show-current")).text().trim()
  if (release.channel === "latest" && branch !== "main") console.warn(`! Releasing ${version} from ${branch || "a detached HEAD"}, not main.`)

  if (!existsSync(changelog)) {
    const lastTag = (await git("describe", "--tags", "--abbrev=0", "--match", "v*")).text().trim()
    const subjects = (await git("log", "--no-merges", "--format=%s", ...(lastTag ? [`${lastTag}..HEAD`] : ["-n", "50"]))).text().split("\n").filter(Boolean)
    await mkdir(path.dirname(changelog), { recursive: true })
    await writeFile(changelog, draftChangelog({ date: new Date().toISOString().slice(0, 10), subjects }))
    console.log(`Wrote a draft ${relative} from ${subjects.length} commit${subjects.length === 1 ? "" : "s"}${lastTag ? ` since ${lastTag}` : ""}.`)
    console.log(`Rewrite it for users (replace every TODO), then run \`bun run release ${version}\` again.`)
    process.exit(1)
  }
  const problems = changelogProblems(await readFile(changelog, "utf8"), version)
  if (problems.length) fail(problems.join("\n  "))

  await setVersion("cli/package.json", (data) => void (data.version = version))
  await setVersion("package.json", (data) => void (data.version = version))
  await setVersion("public/manifest.json", (data) => void applyManifestVersion(data, version))
  console.log(`✓ ${current} → ${version} in cli/package.json, package.json and public/manifest.json`)

  if (!values["skip-check"]) {
    const check = await $`bun scripts/release-check.ts --tag ${tag} --require-changelog`.cwd(root).nothrow()
    if (check.exitCode !== 0) fail(`release checks failed; the version bump is left uncommitted. Fix it, or \`git checkout -- cli/package.json package.json public/manifest.json\` to undo.`)
  }

  const summary = parseChangelog(await readFile(changelog, "utf8")).front.summary ?? ""
  const files = ["cli/package.json", "package.json", "public/manifest.json", relative]
  if ((await git("add", "--", ...files)).exitCode !== 0) fail("git add failed")
  if ((await git("commit", "-m", `release: ${tag}`, "-m", summary, "--", ...files)).exitCode !== 0) fail("git commit failed")
  if ((await git("tag", "-a", tag, "-m", `${tag}: ${summary}`)).exitCode !== 0) fail(`git tag ${tag} failed`)
  console.log(`✓ Committed release: ${tag} and tagged it ${tag} (${release.channel === "beta" ? "beta: npm dist-tag beta, the beta store item" : "stable: npm latest, the store listing"}).`)
  console.log("")
  console.log("Push to start the release workflow (it waits for approval before publishing):")
  console.log(`  git push origin ${branch || "HEAD"} ${tag}`)
}
