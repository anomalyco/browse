// Starts a stable release in GitHub Actions; nothing is built, tagged or published from this machine.
//   bun run release --draft [notes.md]                writes release notes drafted from the commits on origin/dev since
//                                                     the last v* tag (default release-notes.md), to rewrite for users
//   bun run release <patch|minor|major|1.2.3> notes.md
//                                                     gh workflow run release.yml --ref dev with the bump (or version)
//                                                     and the notes; the same as Actions → Release → Run workflow
// The run's plan job admits only repository admins and maintainers (.github/release/plan-release.sh), and the notes
// must be a summary line, then ## Major / ## Improvements / ## Fixes, with no TODO left.
import { $ } from "bun"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { draftNotes, PLACEHOLDER } from "./changelog.ts"
import { parseReleaseVersion } from "./version.ts"

const root = path.resolve(import.meta.dir, "..")
const usage = "usage: bun run release --draft [notes.md] | bun run release <patch|minor|major|1.2.3> <notes.md>"

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { draft: { type: "boolean" } } })

if (values.draft) {
  const file = positionals[0] ?? "release-notes.md"
  if (existsSync(file)) fail(`${file} already exists`)
  await $`git fetch --quiet --tags origin dev`.cwd(root).quiet().nothrow()
  const lastTag = (await $`git describe --tags --abbrev=0 --match v* origin/dev`.cwd(root).quiet().nothrow()).text().trim()
  const range = lastTag ? [`${lastTag}..origin/dev`] : ["-n", "50", "origin/dev"]
  const subjects = (await $`git log --no-merges --format=%s ${range}`.cwd(root).quiet().nothrow()).text().split("\n").filter(Boolean)
  await writeFile(file, draftNotes(subjects))
  console.log(`Wrote ${file} from ${subjects.length} commit${subjects.length === 1 ? "" : "s"}${lastTag ? ` since ${lastTag}` : ""}.`)
  console.log(`Rewrite it for users (replace every ${PLACEHOLDER}), then: bun run release <patch|minor|major> ${file}`)
  process.exit(0)
}

const [bump, notesFile] = positionals
if (!bump || !notesFile || positionals.length > 2) fail(usage)
const field = bump === "patch" || bump === "minor" || bump === "major" ? `bump=${bump}` : `version=${bump}`
if (field.startsWith("version=")) {
  try {
    if (parseReleaseVersion(bump).channel !== "latest") fail("dev builds come from every push to dev; release a stable version")
  } catch (error) {
    fail(`${(error as Error).message}\n  ${usage}`)
  }
}
const notes = await readFile(notesFile, "utf8").catch(() => fail(`can't read ${notesFile}`))
if (notes.includes(PLACEHOLDER)) fail(`${notesFile} still has ${PLACEHOLDER} placeholders`)

const dispatched = await $`gh workflow run release.yml --ref dev -f ${field} -F release_notes=@${notesFile}`.cwd(root).nothrow()
if (dispatched.exitCode !== 0) fail("couldn't dispatch the release (Actions → Release → Run workflow does the same)")
console.log("✓ Dispatched Release on dev. Follow it under Actions → Release (gh run watch).")
