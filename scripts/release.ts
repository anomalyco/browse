// Cuts a stable release: `bun run release [patch|minor|major|<version>]` (default patch), on an up-to-date dev.
// Work lands on dev, and every push to dev publishes a dev build. production holds what was released and moves only by
// a fast-forward from dev. Tags trigger nothing: the Release workflow tags v<version> itself once everything published
// (.github/workflows/release.yml).
// 1. Without changelog/<version>.md it writes a draft from the commits since the last tag and stops, so a person
//    rewrites it for users (scripts/changelog.ts). Run the same command again once it's ready.
// 2. Sets the version in cli/package.json, package.json and public/manifest.json (scripts/version.ts).
// 3. Builds and checks both artifacts (scripts/release-check.ts) unless --skip-check.
// 4. Commits "release: v<version>" on dev.
// 5. Asks, then pushes that commit to dev and production in one atomic push, which refuses anything but a fast-forward
//    of each (--yes skips the question, --no-push stops before it), and dispatches Release from production with
//    channel stable (gh workflow run). It prints the run, which waits for the npm and chrome-web-store approvals.
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

/** Orders two stable versions. */
export function compareVersions(left: string, right: string) {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1
  return 0
}

export function bumpVersion(current: string, bump: "major" | "minor" | "patch") {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
  if (!match) throw new Error(`cli/package.json version ${JSON.stringify(current)} isn't a stable release`)
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (bump === "major") return `${major + 1}.0.0`
  if (bump === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const WORKFLOW = "release.yml"

/** The dispatched run: the newest stable dispatch on production for this commit, once GitHub lists it. */
async function findRun(sha: string, since: number) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const listed = await $`gh run list --workflow ${WORKFLOW} --branch production --event workflow_dispatch --limit 10 --json url,headSha,createdAt`.cwd(root).quiet().nothrow()
    if (listed.exitCode === 0) {
      const runs = JSON.parse(listed.text()) as { url: string; headSha: string; createdAt: string }[]
      const run = runs.find((candidate) => candidate.headSha === sha && Date.parse(candidate.createdAt) >= since - 60_000)
      if (run) return run.url
    }
    await Bun.sleep(2_000)
  }
  return undefined
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "skip-check": { type: "boolean" }, "no-push": { type: "boolean" }, yes: { type: "boolean", short: "y" } },
  })
  const usage = "usage: bun run release [patch|minor|major|<version>] [--skip-check] [--no-push] [--yes]   (<version>: 1.2.3)"
  if (positionals.length > 1) fail(usage)
  const current = await currentVersion()
  const requested = positionals[0] ?? "patch"
  let version = requested
  try {
    if (requested === "major" || requested === "minor" || requested === "patch") version = bumpVersion(current, requested)
  } catch (error) {
    fail((error as Error).message)
  }
  let channel
  try {
    channel = parseReleaseVersion(version).channel
  } catch (error) {
    fail(`${(error as Error).message}\n  ${usage}`)
  }
  if (channel === "dev") fail("dev builds come from every push to dev; release a stable version")
  const tag = `v${version}`
  const changelog = changelogFile(version)
  const relative = path.relative(root, changelog)
  // Only the changelog may be new or changed: the release commit holds exactly the version bump and its entry.
  const dirty = (await git("status", "--porcelain", "--untracked-files=all")).text().split("\n").filter(Boolean).filter((line) => line.slice(3) !== relative)
  if (dirty.length) fail(`the working tree has other changes; commit or stash them first:\n  ${dirty.join("\n  ")}`)
  const branch = (await git("branch", "--show-current")).text().trim()
  if (branch !== "dev") fail(`releases are cut on dev, not ${branch || "a detached HEAD"}`)
  if ((await git("fetch", "--quiet", "--tags", "origin", "dev", "production")).exitCode !== 0)
    fail("git fetch origin dev production failed (production must exist on origin: RELEASING.md)")
  if ((await git("merge-base", "--is-ancestor", "origin/dev", "HEAD")).exitCode !== 0) fail("dev is behind origin/dev; pull first")
  // The release commit goes on top of HEAD, so production fast-forwards to it only if it's already in HEAD's history.
  if ((await git("merge-base", "--is-ancestor", "origin/production", "HEAD")).exitCode !== 0)
    fail("origin/production has commits that aren't on dev, so it can't fast-forward to the release; reconcile them first")
  if ((await git("rev-parse", "-q", "--verify", `refs/tags/${tag}`)).exitCode === 0) fail(`tag ${tag} already exists`)
  if (compareVersions(version, current) < 0 || (compareVersions(version, current) === 0 && (await git("tag", "--list", "v*")).text().includes(`v${current}\n`)))
    fail(`${version} isn't newer than the current version ${current}`)

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
  const sha = (await git("rev-parse", "HEAD")).text().trim()
  console.log(`✓ Committed release: ${tag} (${sha.slice(0, 7)}) on dev.`)

  // No --force: the push fails unless both dev and production fast-forward, and then neither moves.
  const refs = ["HEAD:refs/heads/dev", "HEAD:refs/heads/production"]
  const pushCommand = `git push --atomic origin ${refs.join(" ")}`
  const dispatchCommand = `gh workflow run ${WORKFLOW} --ref production -f ref=production -f channel=stable`
  const ask = () => {
    if (!process.stdin.isTTY) return false
    const answer = prompt(`Push ${sha.slice(0, 7)} to dev and production and start the stable release? [y/N]`)?.trim().toLowerCase()
    return answer === "y" || answer === "yes"
  }
  if (values["no-push"] || !(values.yes || ask())) {
    console.log("")
    console.log("Not pushed. To release, push dev and fast-forward production, then dispatch the stable run:")
    console.log(`  ${pushCommand}`)
    console.log(`  ${dispatchCommand}`)
    process.exit(0)
  }
  const pushed = await $`git push --atomic origin ${refs}`.cwd(root).nothrow()
  if (pushed.exitCode !== 0) fail(`push failed (production must fast-forward to dev); the commit is local. Fix it, then:\n  ${pushCommand}\n  ${dispatchCommand}`)
  console.log(`✓ Pushed ${sha.slice(0, 7)} to dev and production.`)

  const since = Date.now()
  const dispatched = await $`gh workflow run ${WORKFLOW} --ref production -f ref=production -f channel=stable`.cwd(root).nothrow()
  if (dispatched.exitCode !== 0) fail(`couldn't dispatch the release; run it yourself:\n  ${dispatchCommand}`)
  const url = await findRun(sha, since)
  console.log(`✓ Dispatched Release (stable) from production${url ? `: ${url}` : " (Actions → Release)"}`)
  console.log("")
  console.log("  Approvals pending: the run waits for the npm and chrome-web-store environments. Once verify, build and")
  console.log(`  attest pass, approve both; it publishes npm latest and the Chrome Web Store item, then tags ${tag} and`)
  console.log("  creates the GitHub release. If either publish fails there's no tag: fix it and rerun the failed jobs.")
  if (url) console.log(`  Follow it with: gh run watch ${url.split("/").pop()}`)
}
