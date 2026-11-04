import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "..")
const fileSizeScript = path.join(repoRoot, "scripts", "file-size.sh")
const folderShapeScript = path.join(repoRoot, "scripts", "folder-shape.sh")

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function runScript(script: string, cwd: string, args: string[] = []) {
  return spawnSync("bash", [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "false" },
  })
}

function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-code-org-"))
  tempDirs.push(dir)
  spawnSync("git", ["init", "-q"], { cwd: dir })
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true })
  fs.copyFileSync(fileSizeScript, path.join(dir, "scripts", "file-size.sh"))
  fs.copyFileSync(folderShapeScript, path.join(dir, "scripts", "folder-shape.sh"))
  return dir
}

function writeTrackedLines(repo: string, relPath: string, lineCount: number) {
  const fullPath = path.join(repo, relPath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, "export const x = 1\n".repeat(lineCount))
  spawnSync("git", ["add", relPath], { cwd: repo })
}

describe("repository file-size and folder-shape checks", () => {
  test("tracked repository files stay within size and folder-shape ceilings", () => {
    const size = runScript(fileSizeScript, repoRoot)
    expect(size.status, `${size.stdout}\n${size.stderr}`).toBe(0)

    const shape = runScript(folderShapeScript, repoRoot)
    expect(shape.status, `${shape.stdout}\n${shape.stderr}`).toBe(0)
  })

  test("file-size check warns above 800, fails above 1500/1000, and ratchets ceilings down", () => {
    const repo = createTempGitRepo()
    writeTrackedLines(repo, "src/medium.ts", 850)
    const warnRun = runScript(path.join(repo, "scripts", "file-size.sh"), repo)
    expect(warnRun.status).toBe(0)
    expect(warnRun.stdout).toContain("warn   src/medium.ts")

    writeTrackedLines(repo, "src/oversized.ts", 1505)
    const failSource = runScript(path.join(repo, "scripts", "file-size.sh"), repo)
    expect(failSource.status).toBe(1)
    expect(failSource.stdout).toContain("ERROR  src/oversized.ts (limit 1500)")

    writeTrackedLines(repo, "test/oversized.test.ts", 1005)
    const failTest = runScript(path.join(repo, "scripts", "file-size.sh"), repo)
    expect(failTest.status).toBe(1)
    expect(failTest.stdout).toContain("ERROR  test/oversized.test.ts (test limit 1000)")

    // Ratchet ceilings in, verify pass, shrink, ratchet down, then verify growing above ratcheted ceiling fails.
    expect(runScript(path.join(repo, "scripts", "file-size.sh"), repo, ["--update-exceptions", "--allow-raise"]).status).toBe(0)
    expect(runScript(path.join(repo, "scripts", "file-size.sh"), repo).status).toBe(0)

    writeTrackedLines(repo, "src/oversized.ts", 1502)
    expect(runScript(path.join(repo, "scripts", "file-size.sh"), repo, ["--update-exceptions"]).status).toBe(0)

    writeTrackedLines(repo, "src/oversized.ts", 1504)
    const regressed = runScript(path.join(repo, "scripts", "file-size.sh"), repo)
    expect(regressed.status).toBe(1)
    expect(regressed.stdout).toContain("ERROR  src/oversized.ts (limit 1502)")
  })

  test("folder-shape check catches anchored prefix families, unanchored 3+ families, and folders over 60 files", () => {
    const repo = createTempGitRepo()
    writeTrackedLines(repo, "src/session.ts", 10)
    writeTrackedLines(repo, "src/session-store.ts", 10)
    writeTrackedLines(repo, "src/session-journal.ts", 10)
    const anchored = runScript(path.join(repo, "scripts", "folder-shape.sh"), repo)
    expect(anchored.status).toBe(1)
    expect(anchored.stdout).toContain("ERROR  src/session-* (move into session/)")

    const unanchoredRepo = createTempGitRepo()
    writeTrackedLines(unanchoredRepo, "src/cdp-a.ts", 5)
    writeTrackedLines(unanchoredRepo, "src/cdp-b.ts", 5)
    expect(runScript(path.join(unanchoredRepo, "scripts", "folder-shape.sh"), unanchoredRepo).status).toBe(0)
    writeTrackedLines(unanchoredRepo, "src/cdp-c.ts", 5)
    const unanchored = runScript(path.join(unanchoredRepo, "scripts", "folder-shape.sh"), unanchoredRepo)
    expect(unanchored.status).toBe(1)
    expect(unanchored.stdout).toContain("ERROR  src/cdp-* (move into cdp/)")

    const broadRepo = createTempGitRepo()
    for (let index = 0; index < 61; index++) {
      writeTrackedLines(broadRepo, `src/mod${index}.ts`, 5)
    }
    const broad = runScript(path.join(broadRepo, "scripts", "folder-shape.sh"), broadRepo)
    expect(broad.status).toBe(1)
    expect(broad.stdout).toContain("ERROR  src/ (group into capability subfolders)")
  })
})
