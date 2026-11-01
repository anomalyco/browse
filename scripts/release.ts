// Cuts a stable or beta release: `bun run release [patch|minor|major|<version>]` (default patch; 1.2.3-beta.4 for a beta).
// Dev builds need nothing: every push to main publishes one (.github/workflows/release.yml).
// 1. Without changelog/<version>.md it writes a draft from the commits since the last tag and stops, so a person
//    rewrites it for users (scripts/changelog.ts). Run the same command again once it's ready.
// 2. Sets the version in cli/package.json, package.json and public/manifest.json (scripts/version.ts).
// 3. Builds and checks both artifacts (scripts/release-check.ts) unless --skip-check.
// 4. Commits "release: v<version>" and makes the annotated tag v<version>.
// 5. Asks, then pushes the branch and the tag in one atomic push (--yes skips the question, --no-push skips the push).
//    The tag starts the release workflow, which publishes after the npm and chrome-web-store environments approve.
import { $ } from "bun"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { changelogFile, changelogProblems, draftChangelog, parseChangelog } from "./changelog.ts"
import { currentVersion, parseReleaseVersion, setVersion, VERSION_FILES } from "./version.ts"

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

/** The version a bump names: from a beta, `patch` releases the beta's own version. */
export function bumpVersion(current: string, bump: "major" | "minor" | "patch") {
  const match = /^(\d+)\.(\d+)\.(\d+)(-beta\.\d+)?$/.exec(current)
  if (!match) throw new Error(`cli/package.json version ${JSON.stringify(current)} isn't a stable or beta release`)
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const beta = match[4] !== undefined
  if (bump === "major") return beta && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`
  if (bump === "minor") return beta && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`
  return beta ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "skip-check": { type: "boolean" }, "no-push": { type: "boolean" }, yes: { type: "boolean", short: "y" } },
  })
  const usage = "usage: bun run release [patch|minor|major|<version>] [--skip-check] [--no-push] [--yes]   (<version>: 1.2.3, or 1.2.3-beta.4)"
  if (positionals.length > 1) fail(usage)
  const current = await currentVersion()
  const requested = positionals[0] ?? "patch"
  let version = requested
  try {
    if (requested === "major" || requested === "minor" || requested === "patch") version = bumpVersion(current, requested)
  } catch (error) {
    fail((error as Error).message)
  }
  let release
  try {
    release = parseReleaseVersion(version)
  } catch (error) {
    fail(`${(error as Error).message}\n  ${usage}`)
  }
  if (release.channel === "dev") fail("dev builds come from every push to main; release a stable or beta version")
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
  if (release.channel === "latest") {
    // The workflow refuses a stable tag that isn't on main, and the push below must fast-forward origin/main.
    if (branch !== "main") fail(`stable releases come from main, not ${branch || "a detached HEAD"}`)
    if ((await git("fetch", "--quiet", "--no-tags", "origin", "main")).exitCode !== 0) fail("git fetch origin main failed")
    if ((await git("merge-base", "--is-ancestor", "origin/main", "HEAD")).exitCode !== 0) fail("main is behind origin/main; pull first")
  }

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

  await setVersion(version)
  console.log(`✓ ${current} → ${version} in ${VERSION_FILES.join(", ")}`)

  if (!values["skip-check"]) {
    const check = await $`bun scripts/release-check.ts --tag ${tag} --require-changelog`.cwd(root).nothrow()
    if (check.exitCode !== 0) fail(`release checks failed; the version bump is left uncommitted. Fix it, or \`git checkout -- ${VERSION_FILES.join(" ")}\` to undo.`)
  }

  const summary = parseChangelog(await readFile(changelog, "utf8")).front.summary ?? ""
  const files = [...VERSION_FILES, relative]
  if ((await git("add", "--", ...files)).exitCode !== 0) fail("git add failed")
  if ((await git("commit", "-m", `release: ${tag}`, "-m", summary, "--", ...files)).exitCode !== 0) fail("git commit failed")
  if ((await git("tag", "-a", tag, "-m", `${tag}: ${summary}`)).exitCode !== 0) fail(`git tag ${tag} failed`)
  console.log(`✓ Committed release: ${tag} and tagged it ${tag} (${release.channel === "beta" ? "beta: npm dist-tag beta, the beta store item" : "stable: npm latest, the store listing"}).`)

  // A beta from a detached HEAD has no branch to push; push the tag alone.
  const refs = branch ? [branch, tag] : [tag]
  const command = `git push --atomic origin ${refs.join(" ")}`
  const ask = () => {
    if (!process.stdin.isTTY) return false
    const answer = prompt(`Push ${refs.join(" and ")} to origin to start the release? [y/N]`)?.trim().toLowerCase()
    return answer === "y" || answer === "yes"
  }
  if (values["no-push"] || !(values.yes || ask())) {
    console.log("")
    console.log("Not pushed. Push to start the release workflow (it waits for approval before publishing):")
    console.log(`  ${command}`)
    process.exit(0)
  }
  const pushed = await $`git push --atomic origin ${refs}`.cwd(root).nothrow()
  if (pushed.exitCode !== 0) fail(`push failed; the commit and tag are local. Fix it, then: ${command}`)
  console.log(`✓ Pushed ${tag}. Approve npm and chrome-web-store under Actions → Release once verify, build and attest pass.`)
}
