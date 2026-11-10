import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const writer = path.join(import.meta.dir, "fixtures/setup-log-writer.ts")

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    OPENCODE_BROWSER_HOME: path.join(home, "browse"),
    OPENCODE_BROWSER_PORT: "29988",
    OPENCODE_BROWSER_AUTO_UPDATE: "off",
    OPENCODE_BROWSER_UPDATE_CHECK: "0",
  }
}

// Setup commands print before the Effect CLI loads, through the log helper: a reader that exits early (`| head -1`) must
// end that output quietly, not crash with EPIPE.
test.skipIf(process.platform === "win32")(
  "setup output ends quietly when its reader closes the pipe",
  async () => {
    const home = mkdtempSync(path.join(tmpdir(), "browse-setup-epipe-"))
    try {
      const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [writer], { env: isolatedEnv(home), stdio: ["ignore", "pipe", "pipe"] })
        let stderr = ""
        child.stderr.setEncoding("utf8")
        child.stderr.on("data", (chunk: string) => (stderr += chunk))
        // The writer waits for this close before its first line.
        child.stdout.destroy()
        child.on("error", reject)
        child.on("close", (status) => resolve({ status, stderr }))
      })
      expect(result.stderr).not.toContain("EPIPE")
      expect(result.stderr).toBe("")
      expect(result.status).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  },
  20_000,
)
