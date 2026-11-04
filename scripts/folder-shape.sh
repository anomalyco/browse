#!/usr/bin/env bash
# Checks folder shape for tracked TypeScript sources.
#   prefix family  x.ts or x/ plus 2+ x-*.ts siblings, or 3+ x-*.ts alone: error, "move into x/"
#   folder breadth > 40 non-test source files in one folder: warn; > 60: error
# Test files (test/, cli/test/, *.test.ts, *.spec.ts), generated and vendored files are excluded.
# Existing violations are listed in scripts/folder-shape-exceptions.txt ("<key> [ceiling]", where key is
# "<dir>/<prefix>-*" or "<dir>/"); ceilings only go down.
# Usage: scripts/folder-shape.sh [--warn-only] [--update-exceptions [--allow-raise]]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec node --input-type=module - "$@" <<'JS'
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const WARN = 40
const HARD = 60
const EXC = "scripts/folder-shape-exceptions.txt"
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

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)

const dirs = new Set()
for (const file of files) {
  const parts = file.split("/").slice(0, -1)
  for (let i = 0; i < parts.length; i++) {
    dirs.add(parts.slice(0, i + 1).join("/"))
  }
}

const byFolder = new Map()
for (const file of files) {
  if (SOURCE.test(file) && !SKIPPED.test(file) && !TEST.test(file)) {
    const folder = path.posix.dirname(file) || "."
    const list = byFolder.get(folder) ?? []
    list.push(file)
    byFolder.set(folder, list)
  }
}

const found = new Map() // key -> { count, hint }
for (const [folder, paths] of byFolder.entries()) {
  if (paths.length > WARN) {
    found.set(`${folder}/`, { count: paths.length, hint: "group into capability subfolders" })
  }
  const stems = paths.map((file) => path.posix.basename(file).replace(/\.tsx?$/, ""))
  const members = new Map()
  for (const stem of stems) {
    const at = stem.search(/[_-]/)
    if (at > 0 && at < stem.length - 1) {
      const prefix = stem.slice(0, at)
      members.set(prefix, (members.get(prefix) ?? 0) + 1)
    }
  }
  for (const [prefix, count] of members.entries()) {
    const base = folder === "." ? prefix : `${folder}/${prefix}`
    const anchored = dirs.has(base) || stems.includes(prefix)
    if (count >= (anchored ? 2 : 3)) {
      found.set(`${base}-*`, { count, hint: `move into ${prefix}/` })
    }
  }
}

function loadExceptions() {
  const map = new Map()
  if (!fs.existsSync(EXC)) return map
  for (const raw of fs.readFileSync(EXC, "utf8").split("\n")) {
    const line = raw.split("#")[0].trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    const key = parts[0].endsWith("*") || parts[0].endsWith("/") ? parts[0] : `${parts[0]}/`
    const ceiling = parts[1] ? Number(parts[1]) : 1e9
    map.set(key, ceiling)
  }
  return map
}

const exc = loadExceptions()
if (update) {
  const next = []
  for (const [key, { count }] of found.entries()) {
    if (!(key.endsWith("*") || count > HARD)) continue
    const old = exc.get(key)
    if (old === undefined) {
      if (allowRaise) next.push([key, count])
      else console.error(`not listing new violation ${key} (${count}); use --allow-raise`)
    } else {
      next.push([key, count <= old || allowRaise ? count : old])
    }
  }
  next.sort(([a], [b]) => a.localeCompare(b))
  const header = [
    "# <key> <ceiling>: existing folder-shape violations (see scripts/folder-shape.sh). Ceilings only go down.",
    "# Refresh with scripts/folder-shape.sh --update-exceptions.",
  ]
  const body = next.map(([key, ceiling]) => `${key} ${ceiling}`)
  fs.writeFileSync(EXC, [...header, ...body, ""].join("\n"))
  console.log(`wrote ${EXC} (${next.length} entries)`)
  process.exit(0)
}

let errors = 0
let warns = 0
const gh = process.env.GITHUB_ACTIONS === "true"
const entries = [...found.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
const rows = []

for (const [key, { count, hint }] of entries) {
  const isFamily = key.endsWith("*")
  if (isFamily || count > HARD) {
    const limit = exc.get(key)
    if (limit !== undefined && count <= limit) {
      warns++
      rows.push(`${String(count).padStart(6)}  warn   ${key} (${hint}; exception, ceiling ${limit})`)
    } else {
      errors++
      const limitNote = limit !== undefined && limit < 1e9 ? `; limit ${limit}` : ""
      rows.push(`${String(count).padStart(6)}  ERROR  ${key} (${hint}${limitNote})`)
      if (gh) console.log(`::error file=${key}::${count} files: ${hint}`)
    }
  } else {
    warns++
    rows.push(`${String(count).padStart(6)}  warn   ${key} (${hint}, soft limit ${WARN})`)
  }
}

if (rows.length > 0) console.log(rows.join("\n"))
const families = [...found.keys()].filter((key) => key.endsWith("*")).length
console.log(
  `folder shape: families: ${families}, folders over ${WARN}: ${found.size - families}, errors: ${errors}, warnings: ${warns}`,
)
process.exit(warnOnly || errors === 0 ? 0 : 1)
JS
