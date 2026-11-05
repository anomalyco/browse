import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

test.skipIf(process.platform === "win32")("the installed PATH line works in sh with spaces and shell metacharacters", () => {
  const home = mkdtempSync(path.join(tmpdir(), "Jane O'Neil $home-"))
  const dir = path.join(home, ".browse/bin"), binary = path.join(dir, "browse")
  mkdirSync(dir, { recursive: true }); writeFileSync(binary, "")
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SHELL: "/bin/sh", TEST_BINARY: binary, GITHUB_ACTIONS: "false" }
  const run = (action: string) => spawnSync(process.execPath, ["-e", `import { addToPath, removeBinaryInstall } from './src/setup/binary.ts'; Object.defineProperty(process,'execPath',{value:process.env.TEST_BINARY}); ${action}`], { cwd: path.join(import.meta.dir, ".."), env })
  try {
    expect(run("addToPath()").status).toBe(0)
    const shell = spawnSync("/bin/sh", ["-c", `. "$HOME/.profile" && printf '%s' "$PATH"`], { env, encoding: "utf8" })
    expect(shell.stdout).toBe(`${dir}:${env.PATH}`)
    expect(run("removeBinaryInstall(process.execPath)").status).toBe(0)
    expect(readFileSync(path.join(home, ".profile"), "utf8")).not.toContain("# browse")
  } finally { rmSync(home, { recursive: true, force: true }) }
})
