import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

test.skipIf(process.platform === "win32")("the streamed installer accepts POSIX sh and preserves setup arguments", () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse installer-"))
  try {
    const stub = path.join(home, "test binary")
    writeFileSync(stub, `#!/bin/sh\nprintf '<%s>\\n' "$@"\n`)
    for (const shell of ["sh", "dash", "bash", "zsh"].filter(name => Bun.which(name))) {
      const run = spawnSync(shell, ["-s", "--", "--remote", "--binary", stub, "two words", "", "*"], {
        env: { PATH: process.env.PATH, HOME: home }, input: readFileSync(path.join(import.meta.dir, "../../install")), encoding: "utf8",
      })
      expect(run.status, `${shell}: ${run.stderr}`).toBe(0)
      expect(run.stdout).toEndWith("<install>\n<--remote>\n<two words>\n<>\n<*>\n")
      expect(existsSync(path.join(home, ".local/bin/browse"))).toBe(true)
      expect(existsSync(path.join(home, ".browse"))).toBe(false)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("the installer honours XDG_BIN_HOME and still never creates ~/.browse", () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse installer-xdg-"))
  try {
    const stub = path.join(home, "test binary")
    writeFileSync(stub, "#!/bin/sh\nexit 0\n")
    const bin = path.join(home, "custom bin")
    const run = spawnSync("sh", ["-s", "--", "--no-setup", "--binary", stub], {
      env: { ...process.env, PATH: process.env.PATH, HOME: home, XDG_BIN_HOME: bin },
      input: readFileSync(path.join(import.meta.dir, "../../install")), encoding: "utf8",
    })
    expect(run.status, run.stderr).toBe(0)
    expect(existsSync(path.join(bin, "browse"))).toBe(true)
    expect(existsSync(path.join(home, ".browse"))).toBe(false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("the installed PATH line works in sh with spaces and shell metacharacters", () => {
  const home = mkdtempSync(path.join(tmpdir(), "Jane O'Neil $home-"))
  const dir = path.join(home, ".local/bin"), binary = path.join(dir, "browse")
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
