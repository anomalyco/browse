import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

function isolatedEnv(home: string, port: number) {
  const root = path.join(home, "data")
  return { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, APPDATA: home, CHROME_CONFIG_HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "xdg-data"), XDG_STATE_HOME: path.join(home, "xdg-state"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"), XDG_BIN_HOME: path.join(home, "xdg-bin"), OPENCODE_BROWSER_HOME: root,
    OPENCODE_BROWSER_PORT: String(port), OPENCODE_BROWSER_UPDATE_CHECK: "0" }
}

async function runUninstall(home: string, port: number, ...args: string[]) {
  const cli = [process.execPath, path.join(import.meta.dir, "../src/main.ts"), "uninstall", ...args]
  const child = Bun.spawn(cli, { env: isolatedEnv(home, port), stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, stdout, stderr }
}

test.skipIf(legacyHost)("uninstall asks before deleting site secrets, and --yes removes them", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-uninstall-site-secrets-")), root = path.join(home, "data")
  const siteSecrets = path.join(root, "site-secrets"), secret = path.join(siteSecrets, "prod.json")
  mkdirSync(siteSecrets, { recursive: true })
  writeFileSync(secret, '{"version":1,"name":"prod"}\n')
  const port = await freePort()
  try {
    const refused = await runUninstall(home, port)
    expect(refused.code, refused.stderr || refused.stdout).toBe(1)
    expect(refused.stderr).toContain(`Uninstalling deletes 1 site secret in ${siteSecrets}. Re-run with --yes to confirm.`)
    expect(existsSync(secret)).toBe(true)

    const confirmed = await runUninstall(home, port, "--yes")
    expect(confirmed.code, confirmed.stderr || confirmed.stdout).toBe(0)
    expect(existsSync(siteSecrets)).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 25_000)

test.skipIf(legacyHost)("uninstall's confirmation names both stored secret profiles and site secrets", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-uninstall-site-secrets-")), root = path.join(home, "data")
  const secrets = path.join(root, "secrets"), siteSecrets = path.join(root, "site-secrets")
  mkdirSync(secrets, { recursive: true })
  mkdirSync(siteSecrets, { recursive: true })
  writeFileSync(path.join(secrets, "work.json"), '{"token":"keep"}\n')
  writeFileSync(path.join(siteSecrets, "one.json"), '{"version":1}\n')
  writeFileSync(path.join(siteSecrets, "two.json"), '{"version":1}\n')
  const port = await freePort()
  try {
    const refused = await runUninstall(home, port)
    expect(refused.code, refused.stderr || refused.stdout).toBe(1)
    expect(refused.stderr).toContain(
      `Uninstalling deletes 1 stored secret profile in ${secrets} and 2 site secrets in ${siteSecrets}. Re-run with --yes to confirm.`,
    )
    expect(existsSync(secrets)).toBe(true)
    expect(existsSync(siteSecrets)).toBe(true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 25_000)

test.skipIf(legacyHost)("uninstall without stored secrets needs no confirmation", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-uninstall-site-secrets-")), root = path.join(home, "data")
  const port = await freePort()
  try {
    const result = await runUninstall(home, port)
    expect(result.code, result.stderr || result.stdout).toBe(0)
    expect(existsSync(root)).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 25_000)
