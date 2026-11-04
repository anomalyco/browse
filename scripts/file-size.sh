#!/usr/bin/env bash
# Checks TypeScript file sizes across tracked sources and tests.
#   warn  > 800 non-test lines
#   error > 1500 non-test lines unless listed in scripts/file-size-exceptions.txt ("<path> <ceiling>")
#   error > 1000 lines in a test file unless listed in scripts/file-size-exceptions.txt ("<path> <ceiling>")
# Ceilings in scripts/file-size-exceptions.txt only go down.
# Usage: scripts/file-size.sh [--warn-only] [--update-exceptions [--allow-raise]]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec node --input-type=module - "$@" <<'JS'
import { execFileSync } from "node:child_process"
import fs from "node:fs"

const SOFT = 800
const HARD = 1500
const TESTCAP = 1000
const EXC = "scripts/file-size-exceptions.txt"
const SOURCE = /\.(tsx?)$/
const SKIPPED =
  /(^|\/)(node_modules|vendor|vendored|third_party|target|dist|build|\.build|out|generated|__generated__|gen|fixtures?)\/|\.d\.ts$|\.(generated|gen|g|pb)\.tsx?$/
const TEST = /(^|\/)(tests?|benches|e2e|__tests__)\/|\.(test|spec)\.tsx?$/

const args = process.argv.slice(2)
const warnOnly = args.includes("--warn-only")
const update = args.includes("--update-exceptions")
const allowRaise = args.includes("--allow-raise")
for (const arg of args) {
  if (!["--warn-only", "--update-exceptions", "--allow-raise"].includes(arg)) {
    console.error(`unknown option: ${arg}`)
    process.exit(2)
  }
}

function countLines(file) {
  const content = fs.readFileSync(file, "utf8")
  if (content.length === 0) return 0
  const parts = content.split("\n")
  return content.endsWith("\n") ? parts.length - 1 : parts.length
}

function loadExceptions() {
  const map = new Map()
  if (!fs.existsSync(EXC)) return map
  for (const raw of fs.readFileSync(EXC, "utf8").split("\n")) {
    const line = raw.split("#")[0].trim()
    if (!line) continue
    const [file, ceiling] = line.split(/\s+/)
    if (file && ceiling) map.set(file, Number(ceiling))
  }
  return map
}

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => file && SOURCE.test(file) && !SKIPPED.test(file) && fs.existsSync(file))

const measured = tracked.map((file) => ({
  file,
  lines: countLines(file),
  isTest: TEST.test(file),
}))

const exceptions = loadExceptions()

if (update) {
  const next = []
  for (const { file, lines, isTest } of measured) {
    const cap = isTest ? TESTCAP : HARD
    if (lines <= cap) continue
    const old = exceptions.get(file)
    if (old === undefined) {
      if (allowRaise) next.push([file, lines])
      else console.error(`not listing new oversized file ${file} (${lines}); use --allow-raise`)
    } else if (lines > old && !allowRaise) {
      next.push([file, old])
    } else {
      next.push([file, lines])
    }
  }
  next.sort(([a], [b]) => a.localeCompare(b))
  const header = [
    `# <path> <ceiling>: line ceilings for source files above ${HARD} and test files above ${TESTCAP}. Ceilings only go down.`,
    "# Refresh with scripts/file-size.sh --update-exceptions.",
  ]
  const body = next.map(([file, ceiling]) => `${file} ${ceiling}`)
  fs.writeFileSync(EXC, [...header, ...body, ""].join("\n"))
  console.log(`wrote ${EXC} (${next.length} entries)`)
  process.exit(0)
}

const gh = process.env.GITHUB_ACTIONS === "true"
const annotate = (level, file, message) => {
  if (gh) console.log(`::${level} file=${file}::${message}`)
}

let errors = 0
let warns = 0
let overSoft = 0
let overHard = 0
const rows = []

for (const { file, lines, isTest } of measured) {
  if (isTest) {
    if (lines <= TESTCAP) continue
    const limit = exceptions.get(file) ?? TESTCAP
    if (lines > limit) {
      errors++
      rows.push({ lines, text: `${String(lines).padStart(6)}  ERROR  ${file} (test limit ${limit})` })
      annotate("error", file, `test file has ${lines} lines, limit ${limit}; split into focused suites`)
    } else {
      warns++
      rows.push({ lines, text: `${String(lines).padStart(6)}  tests  ${file} (exception, ceiling ${limit})` })
      annotate("warning", file, `test file has ${lines} lines (exception ceiling ${limit}, limit ${TESTCAP})`)
    }
    continue
  }
  if (lines <= SOFT) continue
  overSoft++
  if (lines > HARD) {
    overHard++
    const limit = exceptions.get(file) ?? HARD
    if (lines > limit) {
      errors++
      rows.push({ lines, text: `${String(lines).padStart(6)}  ERROR  ${file} (limit ${limit})` })
      annotate("error", file, `${lines} non-test lines, limit ${limit}; split a module out before adding more`)
    } else {
      warns++
      rows.push({ lines, text: `${String(lines).padStart(6)}  warn   ${file} (exception, ceiling ${limit})` })
      annotate("warning", file, `${lines} non-test lines (exception ceiling ${limit}, soft limit ${SOFT})`)
    }
  } else {
    warns++
    rows.push({ lines, text: `${String(lines).padStart(6)}  warn   ${file}` })
    annotate("warning", file, `${lines} non-test lines (soft limit ${SOFT})`)
  }
}

rows.sort((a, b) => b.lines - a.lines || a.text.localeCompare(b.text))
if (rows.length > 0) console.log(rows.map((row) => row.text).join("\n"))
console.log(`over ${SOFT}: ${overSoft}, over ${HARD}: ${overHard}, errors: ${errors}, warnings: ${warns}`)
process.exit(warnOnly || errors === 0 ? 0 : 1)
JS
