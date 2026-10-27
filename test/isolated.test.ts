import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

// Files in isolated/ install globals (a relay with chrome listeners and a WebSocket, DOM classes) that would meet the
// other files' (bun runs every test file in one process), so each runs in a bun test process of its own.
const directory = path.join(import.meta.dir, "isolated")
for (const file of fs.readdirSync(directory).filter((name) => name.endsWith(".ts")).sort()) {
  test(`isolated/${file}`, () => {
    const result = spawnSync(process.execPath, ["test", path.join(directory, file)], { encoding: "utf8", timeout: 60_000 })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stderr).toMatch(/ 0 fail/)
  }, 70_000)
}
