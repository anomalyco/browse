import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { freePort } from "./support/ports.ts"

// HOME does not isolate HKCU. Never run the real uninstaller over someone's legacy native-host registration.
const legacyHost = process.platform === "win32" && ["Google\\Chrome", "Microsoft\\Edge"].some(browser =>
  spawnSync("reg", ["query", `HKCU\\Software\\${browser}\\NativeMessagingHosts\\ai.opencode.browser`, "/ve"]).status === 0)

// Uninstall must never print what it deletes: a fixture value is easier to grep for than a secret-shaped key.
const secretValue = "super-secret-value-129"
const secretJson = () => `${JSON.stringify({ version: 1, name: "prod", value: secretValue })}\n`
const leaked = ({ stdout, stderr }: { stdout: string; stderr: string }) => `${stdout}${stderr}`.includes(secretValue)

/**
 * A child environment built from scratch: a host OPENCODE_BROWSER_PACKAGE makes uninstall run `npm uninstall -g`, and host
 * agent config variables (CLAUDE_CONFIG_DIR, OPENCODE_CONFIG_DIR, ...) would point it at real agent configs. Only PATH and
 * the Windows essentials Bun needs come from the host.
 */
function isolatedEnv(home: string, port: number, browseHome = true): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, "local-appdata"),
    APPDATA: path.join(home, "appdata"),
    CHROME_CONFIG_HOME: path.join(home, "config"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "xdg-data"),
    XDG_STATE_HOME: path.join(home, "xdg-state"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    XDG_BIN_HOME: path.join(home, "xdg-bin"),
    CLAUDE_CONFIG_DIR: path.join(home, "claude"),
    OPENCODE_CONFIG_DIR: path.join(home, "opencode"),
    OPENCODE_BROWSER_PORT: String(port),
    OPENCODE_BROWSER_UPDATE_CHECK: "0",
  }
  if (browseHome) env.OPENCODE_BROWSER_HOME = path.join(home, "data")
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "ComSpec", "TEMP", "TMP"]) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
  }
  return env
}

async function runUninstall(home: string, port: number, args: string[] = [], browseHome = true) {
  const cli = [process.execPath, path.join(import.meta.dir, "../src/main.ts"), "uninstall", ...args]
  const child = Bun.spawn(cli, { env: isolatedEnv(home, port, browseHome), stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, stdout, stderr }
}

test.skipIf(legacyHost)("uninstall stops its managed relay before removing its data", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-uninstall-")), root = path.join(home, "data")
  const port = await freePort(), url = `http://127.0.0.1:${port}/version`
  const env = isolatedEnv(home, port)
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

test.skipIf(legacyHost)("uninstall asks before deleting site secrets, and --yes removes them", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-uninstall-site-secrets-")), root = path.join(home, "data")
  const siteSecrets = path.join(root, "site-secrets"), secret = path.join(siteSecrets, "prod.json")
  mkdirSync(siteSecrets, { recursive: true })
  writeFileSync(secret, secretJson())
  const port = await freePort()
  try {
    const refused = await runUninstall(home, port)
    expect(refused.code, refused.stderr || refused.stdout).toBe(1)
    expect(refused.stderr).toContain(`Uninstalling deletes 1 site secret in ${siteSecrets}. Re-run with --yes to confirm.`)
    expect(leaked(refused)).toBe(false)
    expect(existsSync(secret)).toBe(true)

    const confirmed = await runUninstall(home, port, ["--yes"])
    expect(confirmed.code, confirmed.stderr || confirmed.stdout).toBe(0)
    expect(leaked(confirmed)).toBe(false)
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
  writeFileSync(path.join(secrets, "work.json"), secretJson())
  writeFileSync(path.join(siteSecrets, "one.json"), '{"version":1}\n')
  writeFileSync(path.join(siteSecrets, "two.json"), '{"version":1}\n')
  const port = await freePort()
  try {
    const refused = await runUninstall(home, port)
    expect(refused.code, refused.stderr || refused.stdout).toBe(1)
    expect(refused.stderr).toContain(
      `Uninstalling deletes 1 stored secret profile in ${secrets} and 2 site secrets in ${siteSecrets}. Re-run with --yes to confirm.`,
    )
    expect(leaked(refused)).toBe(false)
    expect(existsSync(secrets)).toBe(true)
    expect(existsSync(siteSecrets)).toBe(true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 25_000)

// paths.ts dataRoot(): OPENCODE_BROWSER_HOME when set, else $XDG_DATA_HOME/browse, so an everyday install lands in xdg-data.
test.skipIf(legacyHost)("uninstall asks before deleting site secrets at the XDG data root", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-uninstall-site-secrets-"))
  const data = path.join(home, "xdg-data", "browse"), siteSecrets = path.join(data, "site-secrets"), secret = path.join(siteSecrets, "prod.json")
  mkdirSync(siteSecrets, { recursive: true })
  writeFileSync(secret, secretJson())
  const port = await freePort()
  try {
    const refused = await runUninstall(home, port, [], false)
    expect(refused.code, refused.stderr || refused.stdout).toBe(1)
    expect(refused.stderr).toContain(`Uninstalling deletes 1 site secret in ${siteSecrets}. Re-run with --yes to confirm.`)
    expect(leaked(refused)).toBe(false)
    expect(existsSync(secret)).toBe(true)

    const confirmed = await runUninstall(home, port, ["--yes"], false)
    expect(confirmed.code, confirmed.stderr || confirmed.stdout).toBe(0)
    expect(leaked(confirmed)).toBe(false)
    expect(existsSync(data)).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 25_000)

test.skipIf(legacyHost)("uninstall without stored secrets needs no confirmation", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-uninstall-site-secrets-")), root = path.join(home, "data")
  const siteSecrets = path.join(root, "site-secrets")
  mkdirSync(path.join(root, "secrets"), { recursive: true })
  mkdirSync(siteSecrets, { recursive: true })
  writeFileSync(path.join(root, "settings.json"), '{"entry":"/keep"}\n')
  writeFileSync(path.join(siteSecrets, "x.json.lock"), "")
  writeFileSync(path.join(siteSecrets, "x.json.123.tmp"), "")
  const port = await freePort()
  try {
    expect(existsSync(root)).toBe(true)
    const result = await runUninstall(home, port)
    expect(result.code, result.stderr || result.stdout).toBe(0)
    expect(existsSync(root)).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 25_000)
