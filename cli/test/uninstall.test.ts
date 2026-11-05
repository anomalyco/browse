import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { freePort } from "./support/ports.ts"

// HOME does not isolate HKCU. Never run the real uninstaller over someone's legacy native-host registration.
const legacyHost = process.platform === "win32" && ["Google\\Chrome", "Microsoft\\Edge"].some(browser =>
  spawnSync("reg", ["query", `HKCU\\Software\\${browser}\\NativeMessagingHosts\\ai.opencode.browser`, "/ve"]).status === 0)
test.skipIf(legacyHost)("uninstall stops its managed relay before removing its data", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-uninstall-")), root = path.join(home, "data")
  const port = await freePort(), url = `http://127.0.0.1:${port}/version`
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, APPDATA: home, CHROME_CONFIG_HOME: home, XDG_CONFIG_HOME: path.join(home, "config"),
    OPENCODE_BROWSER_HOME: root, OPENCODE_BROWSER_PORT: String(port), OPENCODE_BROWSER_UPDATE_CHECK: "0" }
  const cli = [process.execPath, path.join(import.meta.dir, "../src/main.ts")]
  const relay = Bun.spawn([...cli, "serve"], { env: { ...env, OPENCODE_BROWSER_MANAGED_RELAY: "1" }, stdout: "ignore", stderr: "ignore" })
  const ready = () => fetch(url).then(r => r.ok, () => false)
  try {
    for (let n = 0; n < 100 && !await ready(); n++) await Bun.sleep(50)
    expect(await ready()).toBe(true)
    const uninstall = Bun.spawn([...cli, "uninstall", "--yes"], { env, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([uninstall.exited, new Response(uninstall.stdout).text(), new Response(uninstall.stderr).text()])
    expect(code, stderr || stdout).toBe(0)
    expect(await ready()).toBe(false)
    expect(existsSync(root)).toBe(false)
  } finally {
    relay.kill(); await relay.exited
    rmSync(home, { recursive: true, force: true })
  }
}, 25_000)
