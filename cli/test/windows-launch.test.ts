import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { freePort } from "./support/ports.ts"

// Capture the *outer* shell's output. Waiting for the CLI's exit alone misses a relay holding a copy of its pipe.
for (const shell of ["cmd", "powershell", "closed console"]) {
  test.skipIf(process.platform !== "win32")(`managed relay outlives ${shell} without holding its output open`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "browse-launch-"))
    const port = Number(process.env.BROWSE_TEST_LAUNCH_PORT) || await freePort()
    const url = `http://127.0.0.1:${port}/version`
    const version = () => fetch(url, { signal: AbortSignal.timeout(1000) }).then(r => r.json()) as Promise<{ pid: number; managed: boolean; instanceId: string }>
    const binary = process.env.BROWSE_TEST_BINARY
    const npm = process.env.BROWSE_TEST_NPM_CLI
    const launch = binary ? [binary] : npm ? ["node", npm] : [process.execPath, path.join(import.meta.dir, "../src/main.ts")]
    const command = launch.map(arg => `"${arg}"`).join(" ")
    writeFileSync(path.join(home, "launch.cmd"), `@${command} session list --json ${shell === "closed console" ? ">console.txt " : ""}2>&1\r\n`)
    const script = shell === "cmd" ? `cmd /d /c launch.cmd | Out-String; exit $LASTEXITCODE` : shell === "powershell"
      ? `powershell.exe -NoProfile -Command $env:TEST_PS | Out-String`
      : `$p = Start-Process cmd.exe -ArgumentList '/d /c launch.cmd' -PassThru -WindowStyle Hidden; $p.WaitForExit(); exit $p.ExitCode`
    const ps = `& ${launch.map(s => `'${s.replaceAll("'", "''")}'`).join(" ")} session list --json`
    expect(await version().catch(() => undefined)).toBeUndefined()
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, OPENCODE_BROWSER_HOME: home,
        OPENCODE_BROWSER_PORT: String(port), OPENCODE_BROWSER_UPDATE_CHECK: "0", TEST_PS: ps },
      cwd: home, stdout: "pipe", stderr: "pipe",
    })
    try {
      const result = await Promise.race([
        Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
        Bun.sleep(8000).then(() => { throw new Error(`${shell} did not close its output pipe`) }),
      ])
      expect(result[0], result.slice(1).join("\n")).toBe(0)
      if (shell === "closed console") await Bun.sleep(3000)
      expect((await version()).managed).toBe(true)
    } finally {
      const relay = await version().catch(() => undefined)
      const audit = path.join(home, "relays", String(port), "lifecycle.jsonl")
      if (relay?.managed && existsSync(audit) && readFileSync(audit, "utf8").includes(relay.instanceId)) process.kill(relay.pid)
      proc.kill()
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 15_000)
}
