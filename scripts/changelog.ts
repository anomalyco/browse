// changelog/<version>.md, one file per release in the Anomaly changelog format:
//   ---
//   date: 2026-10-28
//   summary: One line about the release.
//   ---
//   ## Major
//   ### Title
//   A sentence or two.
//   Icon: icons/<slug>.svg
//   ## Improvements
//   - One line each.
//   ## Fixes
//   - What works now.
// `bun scripts/changelog.ts check <version>` lints one; `notes <version>` prints the GitHub release body.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
export const changelogFile = (version: string) => path.join(root, "changelog", `${version}.md`)
const SECTIONS = ["Major", "Improvements", "Fixes"]
export const PLACEHOLDER = "TODO"

export function parseChangelog(text: string) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"))
  const front = Object.fromEntries(
    (match?.[1] ?? "").split("\n").map((line) => /^(\w+):\s*(.*)$/.exec(line)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1]!, m[2]!.trim()]),
  )
  return { front, body: (match?.[2] ?? text).trim(), hasFrontmatter: !!match }
}

/** What's wrong with a release's changelog file, in words; empty when it's ready to ship. */
export function changelogProblems(text: string, version: string): string[] {
  const { front, body, hasFrontmatter } = parseChangelog(text)
  const problems: string[] = []
  const file = `changelog/${version}.md`
  if (!hasFrontmatter) return [`${file}: starts without the --- frontmatter (date, summary)`]
  if (!/^\d{4}-\d{2}-\d{2}$/.test(front.date ?? "")) problems.push(`${file}: date must be YYYY-MM-DD`)
  if (!front.summary) problems.push(`${file}: summary is empty`)
  if (front.version && front.version !== version) problems.push(`${file}: version ${front.version} doesn't match the file name`)
  if (text.includes(PLACEHOLDER)) problems.push(`${file}: still has ${PLACEHOLDER} placeholders`)
  const sections = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim())
  for (const section of sections) if (!SECTIONS.includes(section)) problems.push(`${file}: unknown section "## ${section}" (use ${SECTIONS.join(", ")})`)
  if (!sections.length) problems.push(`${file}: has no ## Major, ## Improvements or ## Fixes section`)
  for (const icon of body.matchAll(/^Icon:\s*(\S+)/gm))
    if (!existsSync(path.join(root, "changelog", icon[1]!))) problems.push(`${file}: icon ${icon[1]} doesn't exist`)
  return problems
}

/** The GitHub release body: the summary, then the entry without its frontmatter or icon lines. */
export function releaseNotes(text: string): string {
  const { front, body } = parseChangelog(text)
  const entry = body.split("\n").filter((line) => !/^(Icon|Media):/.test(line)).join("\n").trim()
  return `${front.summary ? `${front.summary}\n\n` : ""}${entry}\n`
}

/** A first draft from commit subjects (conventional prefixes sorted into sections), with placeholders to replace. */
export function draftChangelog(options: { date: string; subjects: string[] }) {
  const clean = (subject: string) => subject.replace(/^\w+(\([^)]*\))?!?:\s*/, "").replace(/^./, (c) => c.toUpperCase())
  const fixes = options.subjects.filter((s) => /^fix(\(|:|!)/.test(s)).map(clean)
  const improvements = options.subjects.filter((s) => /^(feat|perf)(\(|:|!)/.test(s)).map(clean)
  const lines = [
    "---",
    `date: ${options.date}`,
    `summary: ${PLACEHOLDER} one line for the whole release.`,
    "---",
    "## Major",
    `### ${PLACEHOLDER} title, or delete this section`,
    `${PLACEHOLDER} a sentence or two for the person using it.`,
    "## Improvements",
    ...(improvements.length ? improvements : [PLACEHOLDER]).map((line) => `- ${line}`),
    "## Fixes",
    ...(fixes.length ? fixes : [PLACEHOLDER]).map((line) => `- ${line}`),
    "",
    `<!-- ${PLACEHOLDER}: rewrite each line as what the user sees now, drop internal ones, delete empty sections. -->`,
  ]
  return lines.join("\n") + "\n"
}

if (import.meta.main) {
  const [command, version] = process.argv.slice(2)
  if (!version || (command !== "check" && command !== "notes")) {
    console.error("usage: bun scripts/changelog.ts check|notes <version>")
    process.exit(2)
  }
  const file = changelogFile(version)
  if (!existsSync(file)) {
    console.error(`✗ changelog/${version}.md is missing`)
    process.exit(1)
  }
  const text = readFileSync(file, "utf8")
  if (command === "notes") process.stdout.write(releaseNotes(text))
  else {
    const problems = changelogProblems(text, version)
    for (const problem of problems) console.error(`✗ ${problem}`)
    if (problems.length) process.exit(1)
    console.log(`✓ changelog/${version}.md`)
  }
}
