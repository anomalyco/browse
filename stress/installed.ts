// What users hit, with installed artifacts: the binary the curl installer (or npm) put in a throwaway $HOME, Chrome for
// Testing with the release zip as the store extension, paired through install's link. Each scenario injects one
// fault a user meets (relay crash, browser restart, extension reload or update, the machine sleeping, the network
// dropping, a second browser or relay, an upgrade, many agents, a long idle) and measures how long browse takes to
// work again and whether the user had to do anything.
//   node stress/installed.ts [--only a,b] [--user curl] [--extension ~/u/ext-0.0.8-store] [--sleep-minutes 3]
//                            [--idle-minutes 20] [--agents 16] [--keep]
// Needs: the user's install (stress/exe/installed-setup.sh), Xvfb on $DISPLAY, Chrome for Testing, sudo for iptables.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { fixturePort, runDir, sleep } from "./lib/env.ts"
import { startFixtures, type Fixtures } from "./lib/fixtures.ts"
import { spawnSync } from "node:child_process"
import {
  Chrome, cli, dropRelayPort, extensionConnected, extensionLog, formatExtensionLog, mcp, pairViaLink,
  pairViaSettings, pairingCode, relayLogSince, relayLogSize, relayPid, replaceExtension, status, swConsole, user,
  userEnv, waitFor, type User,
} from "./lib/installed.ts"
import { exec, McpClient } from "./lib/mcp.ts"
import { Jsonl, mdEscape, oneLine } from "./lib/results.ts"

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    user: { type: "string", default: "curl" },
    extension: { type: "string", default: path.join(os.homedir(), "u/ext-0.0.8-store") },
    "old-extension": { type: "string", default: path.join(os.homedir(), "u/ext-0.0.5-store") },
    "sleep-minutes": { type: "string", default: "3" },
    "idle-minutes": { type: "string", default: "20" },
    "drop-seconds": { type: "string", default: "60" },
    agents: { type: "string", default: "16" },
    keep: { type: "boolean", default: false },
    port: { type: "string", default: "19988" },
    "debug-port": { type: "string", default: "9222" },
  },
})

const u = user(values.user!, { port: Number(values.port), debugPort: Number(values["debug-port"]) })
const dir = runDir("installed")
const records = new Jsonl(dir, "scenarios.jsonl")
const rows: { name: string; ok: boolean; ms: number; recoverMs?: number; manual: string; note: string }[] = []
console.log(`installed: user ${u.name} (${u.binary}), extension ${values.extension}, results ${dir}`)

type Ctx = {
  u: User
  fx: Fixtures
  chrome: Chrome
  /** Replaces the browser (after a restart or crash). */
  setChrome: (chrome: Chrome) => void
  extension: string
  artifact: (name: string, text: string) => void
  /** A connected MCP client on the user's binary with an established session on the fixture site. */
  agent: () => Promise<{ client: McpClient; session: string; go: (p?: string) => Promise<string> }>
  note: (text: string) => void
}

type Outcome = { recoverMs?: number; manual?: string; note?: string }
type Scenario = { name: string; run: (ctx: Ctx) => Promise<Outcome | void> }

/** Keeps calling `fn` until it succeeds: how long after a fault browse works again, from the user's point of view. */
async function recovery(fn: () => Promise<unknown>, timeoutMs = 180_000, everyMs = 500): Promise<{ ms: number; attempts: number; lastError?: string }> {
  const started = Date.now()
  let attempts = 0
  let lastError: string | undefined
  while (Date.now() - started < timeoutMs) {
    attempts++
    try {
      await fn()
      return { ms: Date.now() - started, attempts, ...(lastError ? { lastError } : {}) }
    } catch (error) {
      lastError = oneLine(error)
    }
    await sleep(everyMs)
  }
  throw new Error(`no recovery within ${timeoutMs} ms after ${attempts} attempts; last: ${lastError}`)
}

async function freshAgent(ctx: Ctx, name: string) {
  const client = mcp(ctx.u)
  await client.initialize()
  const session = `${name}-${Date.now().toString(36)}`
  const created = await client.call("session_new", { id: session }, 60_000)
  if (created.isError) throw new Error(`session_new: ${created.text.slice(0, 300)}`)
  const go = async (p = "/form") => String(await exec(client, session, `await page.goto(${JSON.stringify(ctx.fx.url(p))}); return await page.title()`, 60_000))
  await go()
  return { client, session, go }
}

/** The extension's reconnect, as its own log shows: the first `open` (or status connected) after `since`. */
async function extensionReconnectMs(ctx: Ctx, since: number): Promise<number | undefined> {
  await sleep(1500) // the extension flushes its log to chrome.storage.session a second after writing
  const cdp = await ctx.chrome.cdp().catch(() => undefined)
  if (!cdp) return undefined
  try {
    const entries = await extensionLog(cdp).catch(() => [])
    const connected = entries.find((e) => e.t >= since && e.event === "status" && e.to === "connected")
    return connected ? connected.t - since : undefined
  } finally {
    cdp.close()
  }
}

function manifestVersion(folder: string): string {
  return (JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")) as { version: string }).version
}

const scenarios: Scenario[] = [
  {
    // A new user: the binary is installed, the relay runs, the browser has the store extension but no pairing.
    name: "first-pairing",
    async run(ctx) {
      const before = status(ctx.u)
      if (before.extension?.connected) ctx.note(`already connected before pairing (${before.extension.pairingState})`)
      const code = pairingCode(ctx.u)
      const cdp = await ctx.chrome.cdp()
      const t = Date.now()
      try {
        // Install's link reaches the default port; another port is what the user types on the settings page.
        if (ctx.u.port === 19988) await pairViaLink(cdp, code)
        else await pairViaSettings(cdp, code, `localhost:${ctx.u.port}`)
        const paired = await waitFor(() => extensionConnected(ctx.u), { timeoutMs: 60_000, label: "extension connected after the pairing link" })
        const after = status(ctx.u)
        ctx.artifact("first-pairing-extension.log", formatExtensionLog(await extensionLog(cdp), t - 60_000))
        const agent = await freshAgent(ctx, "first")
        await agent.client.call("session_delete", { id: agent.session })
        await agent.client.close()
        return { recoverMs: paired.ms, note: `paired as ${after.extension?.browsers?.map((b) => b.id).join(",")} v${after.extension?.version} origin ${after.extension?.origin}` }
      } finally {
        cdp.close()
      }
    },
  },
  {
    // A code typed into the settings page, after `pair --revoke` unpaired the browser (the other manual path).
    name: "repair-after-revoke",
    async run(ctx) {
      const browsers = status(ctx.u).extension?.browsers ?? []
      const target = browsers[0]
      if (!target) throw new Error("no paired browser to revoke")
      const revoke = cli(ctx.u, ["pair", "--revoke", target.id])
      if (revoke.status !== 0) throw new Error(`pair --revoke: ${(revoke.stdout + revoke.stderr).slice(0, 300)}`)
      await waitFor(() => !extensionConnected(ctx.u), { timeoutMs: 20_000, label: "disconnected after revoke" })
      const code = pairingCode(ctx.u)
      const cdp = await ctx.chrome.cdp()
      const t = Date.now()
      try {
        await pairViaSettings(cdp, code)
        const paired = await waitFor(() => extensionConnected(ctx.u), { timeoutMs: 60_000, label: "connected after typing the code" })
        ctx.artifact("repair-extension.log", formatExtensionLog(await extensionLog(cdp), t - 30_000))
        const agent = await freshAgent(ctx, "repair")
        await agent.client.call("session_delete", { id: agent.session })
        await agent.client.close()
        return { recoverMs: paired.ms, manual: "yes: run `browse pair`, type the code (by design after a revoke)" }
      } finally {
        cdp.close()
      }
    },
  },
  {
    // The relay dies (OOM-killed, `kill -9`, a crash): the next tool call must bring it back and the browser reconnect.
    name: "relay-kill9",
    async run(ctx) {
      const agent = await ctx.agent()
      const pid = relayPid(ctx.u)
      if (!pid) throw new Error("no relay pid")
      const logAt = relayLogSize(ctx.u)
      const t = Date.now()
      process.kill(pid, "SIGKILL")
      const sameSession = await recovery(() => agent.go("/form")).catch((error) => ({ ms: -1, attempts: 0, lastError: oneLine(error) }))
      let note = `same session after kill: ${sameSession.ms >= 0 ? `${sameSession.ms} ms (${sameSession.attempts} calls)` : `never (${sameSession.lastError})`}`
      let recoverMs = sameSession.ms
      let manual = "no"
      if (sameSession.ms < 0) {
        const fresh = await recovery(async () => { const a = await freshAgent(ctx, "afterkill"); await a.client.call("session_delete", { id: a.session }); await a.client.close() })
        recoverMs = fresh.ms + 0
        note += `; new session works after ${fresh.ms} ms`
        manual = "agent must start a new session"
      }
      const ext = await extensionReconnectMs(ctx, t)
      ctx.artifact("relay-kill9-relay.log", relayLogSince(ctx.u, logAt))
      await agent.client.call("session_delete", { id: agent.session }).catch(() => undefined)
      await agent.client.close()
      return { recoverMs, manual, note: `${note}; first call saw: ${sameSession.lastError ?? "no error"}; extension connected again after ${ext ?? "?"} ms; new relay pid ${relayPid(ctx.u)}` }
    },
  },
  {
    // `browse relay restart` (what install/update run) while an agent has a page open.
    name: "relay-restart",
    async run(ctx) {
      const agent = await ctx.agent()
      const t = Date.now()
      const restart = cli(ctx.u, ["relay", "restart"], { timeoutMs: 60_000 })
      if (restart.status !== 0) throw new Error(`relay restart exited ${restart.status}: ${(restart.stdout + restart.stderr).slice(0, 300)}`)
      const same = await recovery(() => agent.go("/form"), 60_000).catch((error) => ({ ms: -1, attempts: 0, lastError: oneLine(error) }))
      const ext = await extensionReconnectMs(ctx, t)
      await agent.client.call("session_delete", { id: agent.session }).catch(() => undefined)
      await agent.client.close()
      return { recoverMs: same.ms >= 0 ? same.ms : undefined, manual: same.ms >= 0 ? "no" : `session lost: ${same.lastError}`, note: `restart command took ${restart.ms} ms; extension reconnected after ${ext ?? "?"} ms` }
    },
  },
  {
    // The user quits and reopens the browser (or it updates itself).
    name: "chrome-restart",
    async run(ctx) {
      const agent = await ctx.agent()
      await ctx.chrome.stop()
      const t = Date.now()
      ctx.setChrome(await Chrome.launch(ctx.u, { extension: ctx.extension }))
      const connected = await waitFor(() => extensionConnected(ctx.u), { timeoutMs: 60_000, label: "extension connected after browser restart" })
      const same = await recovery(() => agent.go("/form"), 60_000).catch((error) => ({ ms: -1, attempts: 0, lastError: oneLine(error) }))
      const fresh = await recovery(async () => { const a = await freshAgent(ctx, "afterchrome"); await a.client.call("session_delete", { id: a.session }); await a.client.close() })
      await agent.client.call("session_delete", { id: agent.session }).catch(() => undefined)
      await agent.client.close()
      return { recoverMs: connected.ms, manual: same.ms >= 0 ? "no (old session still works)" : "agent must start a new session (its tab went with the browser)", note: `old session: ${same.ms >= 0 ? `${same.ms} ms` : same.lastError}; new session after ${fresh.ms} ms; launched at +${Date.now() - t} ms` }
    },
  },
  {
    // The browser crashes (every process at once).
    name: "chrome-crash",
    async run(ctx) {
      const agent = await ctx.agent()
      ctx.chrome.kill9()
      await sleep(1000)
      ctx.setChrome(await Chrome.launch(ctx.u, { extension: ctx.extension }))
      const connected = await waitFor(() => extensionConnected(ctx.u), { timeoutMs: 60_000, label: "extension connected after browser crash" })
      const fresh = await recovery(async () => { const a = await freshAgent(ctx, "aftercrash"); await a.client.call("session_delete", { id: a.session }); await a.client.close() })
      await agent.client.call("session_delete", { id: agent.session }).catch(() => undefined)
      await agent.client.close()
      return { recoverMs: connected.ms, manual: "agent must start a new session", note: `new session after ${fresh.ms} ms` }
    },
  },
  {
    // Chrome stops an idle service worker; the next event (alarm, 30 s) must bring the link back.
    name: "sw-stop",
    async run(ctx) {
      const agent = await ctx.agent()
      const cdp = await ctx.chrome.cdp()
      const t = Date.now()
      let how: string
      try {
        how = await cdp.stopExtensionWorker()
      } finally {
        cdp.close()
      }
      const same = await recovery(() => agent.go("/form"), 90_000)
      const ext = await extensionReconnectMs(ctx, t)
      await agent.client.call("session_delete", { id: agent.session }).catch(() => undefined)
      await agent.client.close()
      return { recoverMs: same.ms, manual: "no", note: `stopped via ${how}; extension connected again after ${ext ?? "?"} ms; ${same.attempts} calls; first call saw: ${same.lastError ?? "no error"}` }
    },
  },
  {
    // The user reloads the extension (chrome://extensions) or the store pushes the same build again.
    name: "extension-reload",
    async run(ctx) {
      const agent = await ctx.agent()
      const cdp = await ctx.chrome.cdp()
      const t = Date.now()
      try {
        await cdp.evalInExtension("setTimeout(() => chrome.runtime.reload(), 50); true")
      } finally {
        cdp.close()
      }
      const connected = await waitFor(() => extensionConnected(ctx.u), { timeoutMs: 60_000, label: "connected after reload" })
      const same = await recovery(() => agent.go("/form"), 60_000).catch((error) => ({ ms: -1, attempts: 0, lastError: oneLine(error) }))
      const ext = await extensionReconnectMs(ctx, t)
      await agent.client.call("session_delete", { id: agent.session }).catch(() => undefined)
      await agent.client.close()
      return { recoverMs: connected.ms, manual: same.ms >= 0 ? "no" : `session lost: ${same.lastError}`, note: `extension log: connected after ${ext ?? "?"} ms; same session ${same.ms >= 0 ? `${same.ms} ms` : "failed"}` }
    },
  },
  {
    // A store update: the extension's files change under it and Chrome reloads it (old build -> this build).
    name: "extension-update",
    async run(ctx) {
      const folder = ctx.extension
      const agent = await ctx.agent()
      replaceExtension(folder, values["old-extension"]!)
      let cdp = await ctx.chrome.cdp()
      try {
        await cdp.evalInExtension("setTimeout(() => chrome.runtime.reload(), 50); true")
      } finally {
        cdp.close()
      }
      const oldVersion = manifestVersion(values["old-extension"]!)
      const oldConnected = await waitFor(() => { const s = status(ctx.u); return s.extension?.connected && s.extension.version === oldVersion }, { timeoutMs: 60_000, label: `old build ${oldVersion} connected` }).catch((error) => ({ ms: -1, value: oneLine(error) }))
      const oldWorks = await recovery(() => agent.go("/form"), 60_000).catch((error) => ({ ms: -1, attempts: 0, lastError: oneLine(error) }))
      replaceExtension(folder, values.extension!)
      const t = Date.now()
      cdp = await ctx.chrome.cdp()
      try {
        await cdp.evalInExtension("setTimeout(() => chrome.runtime.reload(), 50); true")
      } finally {
        cdp.close()
      }
      const updated = await waitFor(() => { const s = status(ctx.u); return s.extension?.connected && s.extension.version !== oldVersion }, { timeoutMs: 60_000, label: "new build connected" })
      const newVersion = status(ctx.u).extension?.version
      const same = await recovery(() => agent.go("/form"), 60_000).catch((error) => ({ ms: -1, attempts: 0, lastError: oneLine(error) }))
      await agent.client.call("session_delete", { id: agent.session }).catch(() => undefined)
      await agent.client.close()
      return { recoverMs: updated.ms, manual: same.ms >= 0 ? "no" : `session lost: ${same.lastError}`, note: `old build ${oldVersion} ${oldConnected.ms >= 0 ? `connected after ${oldConnected.ms} ms` : `never connected (${oldConnected.value})`}, ${oldWorks.ms >= 0 ? `worked with this relay after ${oldWorks.ms} ms` : `never worked: ${oldWorks.lastError}`} -> ${newVersion}; +${Date.now() - t} ms` }
    },
  },
  {
    // The laptop sleeps: browser and relay get no CPU for minutes, then everything resumes at once.
    name: "sleep",
    async run(ctx) {
      const minutes = Number(values["sleep-minutes"])
      const agent = await ctx.agent()
      const pid = relayPid(ctx.u)
      if (!pid) throw new Error("no relay pid")
      ctx.chrome.freeze()
      process.kill(pid, "SIGSTOP")
      await sleep(minutes * 60_000)
      const t = Date.now()
      process.kill(pid, "SIGCONT")
      ctx.chrome.thaw()
      const same = await recovery(() => agent.go("/form"), 180_000)
      const connectedNow = extensionConnected(ctx.u)
      const ext = await extensionReconnectMs(ctx, t)
      await agent.client.call("session_delete", { id: agent.session }).catch(() => undefined)
      await agent.client.close()
      return { recoverMs: same.ms, manual: "no", note: `${minutes} min frozen; ${same.attempts} calls; extension ${connectedNow ? "connected" : "NOT connected"}; reconnect logged after ${ext ?? "none (link survived)"} ms; relay pid ${pid} -> ${relayPid(ctx.u)}` }
    },
  },
  {
    // Only the browser's computer sleeps (the relay is on a devbox that stays up): the relay's liveness probe drops the
    // link while the browser is away; it must come back when the laptop wakes.
    name: "sleep-chrome-only",
    async run(ctx) {
      const minutes = Number(values["sleep-minutes"])
      const agent = await ctx.agent()
      const logAt = relayLogSize(ctx.u)
      ctx.chrome.freeze()
      await sleep(minutes * 60_000)
      const duringSleep = status(ctx.u).extension?.connected
      const t = Date.now()
      ctx.chrome.thaw()
      const same = await recovery(() => agent.go("/form"), 180_000).catch((error) => ({ ms: -1, attempts: 0, lastError: oneLine(error) }))
      const fresh = same.ms >= 0 ? same : await recovery(async () => { const a = await freshAgent(ctx, "afterwake"); await a.client.call("session_delete", { id: a.session }); await a.client.close() })
      const ext = await extensionReconnectMs(ctx, t)
      ctx.artifact("sleep-chrome-only-relay.log", relayLogSince(ctx.u, logAt))
      await agent.client.call("session_delete", { id: agent.session }).catch(() => undefined)
      await agent.client.close()
      return { recoverMs: fresh.ms, manual: same.ms >= 0 ? "no" : `old session: ${same.lastError}`, note: `${minutes} min browser frozen; relay saw it ${duringSleep ? "still connected" : "disconnected"} meanwhile; ${fresh.attempts} calls; extension reconnect logged after ${ext ?? "none"} ms` }
    },
  },
  {
    // Only the relay's host sleeps from the browser's point of view (a devbox suspended; the browser stays awake).
    name: "sleep-relay-only",
    async run(ctx) {
      const minutes = Number(values["sleep-minutes"])
      const agent = await ctx.agent()
      const pid = relayPid(ctx.u)
      if (!pid) throw new Error("no relay pid")
      const logAt = relayLogSize(ctx.u)
      process.kill(pid, "SIGSTOP")
      await sleep(minutes * 60_000)
      const t = Date.now()
      process.kill(pid, "SIGCONT")
      const same = await recovery(() => agent.go("/form"), 180_000)
      const ext = await extensionReconnectMs(ctx, t)
      ctx.artifact("sleep-relay-only-relay.log", relayLogSince(ctx.u, logAt))
      await agent.client.call("session_delete", { id: agent.session }).catch(() => undefined)
      await agent.client.close()
      return { recoverMs: same.ms, manual: "no", note: `${minutes} min relay frozen; ${same.attempts} calls; extension reconnect after ${ext ?? "none"} ms; relay pid ${pid} -> ${relayPid(ctx.u)}` }
    },
  },
  {
    // The relay's port goes dark for a while (VPN flap, firewall): the link must notice and come back.
    name: "network-drop",
    async run(ctx) {
      const seconds = Number(values["drop-seconds"])
      const agent = await ctx.agent()
      const logAt = relayLogSize(ctx.u)
      dropRelayPort(ctx.u, true)
      await sleep(seconds * 1000)
      const t = Date.now()
      dropRelayPort(ctx.u, false)
      const same = await recovery(() => agent.go("/form"), 180_000)
      const ext = await extensionReconnectMs(ctx, t - seconds * 1000)
      ctx.artifact("network-drop-relay.log", relayLogSince(ctx.u, logAt))
      await agent.client.call("session_delete", { id: agent.session }).catch(() => undefined)
      await agent.client.close()
      return { recoverMs: same.ms, manual: "no", note: `${seconds} s port drop; ${same.attempts} calls; extension status connected logged ${ext ?? "never"} ms after the drop began` }
    },
  },
  {
    // Two browsers (profiles) paired with one relay: agents name the browser.
    name: "two-browsers",
    async run(ctx) {
      const second = user(`${ctx.u.name}-b`, { port: ctx.u.port, debugPort: ctx.u.debugPort + 1, binary: ctx.u.binary })
      fs.mkdirSync(second.home, { recursive: true })
      const chromeB = await Chrome.launch({ ...second, home: ctx.u.home }, { extension: ctx.extension, freshProfile: true })
      try {
        const code = pairingCode(ctx.u)
        const cdp = await chromeB.cdp()
        try {
          await pairViaLink(cdp, code)
        } finally {
          cdp.close()
        }
        const two = await waitFor(() => (status(ctx.u).extension?.browsers?.length ?? 0) >= 2, { timeoutMs: 60_000, label: "two browsers paired" })
        const browsers = status(ctx.u).extension?.browsers ?? []
        const results: string[] = []
        for (const browser of browsers) {
          const client = mcp(ctx.u)
          await client.initialize()
          const session = `two-${browser.id}-${Date.now().toString(36)}`
          const created = await client.call("session_new", { id: session, browser: browser.id }, 60_000)
          if (created.isError) results.push(`${browser.id}: session_new failed: ${created.text.slice(0, 200)}`)
          else {
            const title = await exec(client, session, `await page.goto(${JSON.stringify(ctx.fx.url("/form"))}); return await page.title()`, 60_000).catch((error) => `error ${oneLine(error)}`)
            results.push(`${browser.id}: ${title}`)
          }
          await client.call("session_delete", { id: session }).catch(() => undefined)
          await client.close()
        }
        // The second browser goes away: the first must keep working, status must drop to one.
        await chromeB.stop()
        const one = await waitFor(() => (status(ctx.u).extension?.browsers?.length ?? 0) === 1 && extensionConnected(ctx.u), { timeoutMs: 60_000, label: "back to one connected browser" })
        const agent = await freshAgent(ctx, "twoafter")
        await agent.client.call("session_delete", { id: agent.session })
        await agent.client.close()
        return { recoverMs: two.ms, manual: "no", note: `${results.join("; ")}; after closing B: one browser after ${one.ms} ms` }
      } finally {
        if (chromeB.alive()) await chromeB.stop()
        const revoked = status(ctx.u).extension?.browsers?.filter((b) => !b.name.includes(ctx.u.name)) ?? []
        void revoked
      }
    },
  },
  {
    // `browse install --remote`: the relay opens to other computers; a browser elsewhere pairs with its address and
    // the code. Here the "other computer" is a second profile talking to the box's network address, not loopback.
    name: "remote-pairing",
    async run(ctx) {
      const install = cli(ctx.u, ["install", "--remote", "--no-open", "--no-wait", "--agent", "none"], { timeoutMs: 120_000 })
      const out = install.stdout + install.stderr
      const code = /([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(out)?.[1]
      const address = /(\d+\.\d+\.\d+\.\d+(?::\d+)?)/.exec(out)?.[1]
      ctx.artifact("remote-install.txt", out)
      if (install.status !== 0 || !code || !address) throw new Error(`install --remote exited ${install.status}, address ${address}, code ${code}: ${out.slice(0, 400)}`)
      const second = user(`${ctx.u.name}-remote`, { port: ctx.u.port, debugPort: ctx.u.debugPort + 2, binary: ctx.u.binary })
      fs.mkdirSync(second.home, { recursive: true })
      const chromeR = await Chrome.launch({ ...second, home: ctx.u.home }, { extension: ctx.extension, freshProfile: true })
      try {
        const cdp = await chromeR.cdp()
        const t = Date.now()
        try {
          await pairViaSettings(cdp, code, address)
          const paired = await waitFor(() => (status(ctx.u).extension?.browsers?.length ?? 0) >= 2, { timeoutMs: 60_000, label: `remote browser paired at ${address}` })
          ctx.artifact("remote-extension.log", formatExtensionLog(await extensionLog(cdp), t - 10_000))
          const remote = status(ctx.u).extension?.browsers?.find((b) => b.id !== ctx.u.name && !b.default) ?? status(ctx.u).extension?.browsers?.[1]
          if (!remote) throw new Error("no second browser in status")
          const client = mcp(ctx.u)
          await client.initialize()
          const session = `remote-${Date.now().toString(36)}`
          const created = await client.call("session_new", { id: session, browser: remote.id }, 60_000)
          if (created.isError) throw new Error(`session_new on ${remote.id}: ${created.text.slice(0, 300)}`)
          const title = await exec(client, session, `await page.goto(${JSON.stringify(ctx.fx.url("/form"))}); return await page.title()`, 60_000)
          // The remote browser's link drops (its network goes): the local one must be unaffected.
          chromeR.freeze()
          const localAgent = await freshAgent(ctx, "localwhileremotefrozen")
          await localAgent.client.call("session_delete", { id: localAgent.session })
          await localAgent.client.close()
          chromeR.thaw()
          const back = await recovery(() => exec(client, session, "return await page.title()", 30_000), 120_000)
          await client.call("session_delete", { id: session }).catch(() => undefined)
          await client.close()
          return { recoverMs: paired.ms, manual: "yes (by design): type the address and code once", note: `address ${address}; remote browser ${remote.id} (${remote.name}) title ${title}; after a freeze its session answered again in ${back.ms} ms (${back.attempts} calls)` }
        } finally {
          cdp.close()
        }
      } finally {
        await chromeR.stop()
        cli(ctx.u, ["set", "hostname", "127.0.0.1"], { timeoutMs: 60_000 })
      }
    },
  },
  {
    // An npm install takes over one $HOME; then the user runs the curl installer in the same $HOME. The agent configs
    // move to the binary, the relay restarts on it, the pairing stays, and an agent still running the old npm entry
    // keeps working.
    name: "npm-to-binary",
    async run(ctx) {
      const oldEntry = ctx.u.binary
      if (!fs.existsSync(oldEntry)) throw new Error(`${oldEntry} missing: run installed-setup.sh npm for this user first`)
      const oldAgent = mcp(ctx.u, {}, oldEntry)
      await oldAgent.initialize()
      const oldSession = `npm-${Date.now().toString(36)}`
      const created = await oldAgent.call("session_new", { id: oldSession }, 60_000)
      if (created.isError) throw new Error(`session_new over the npm entry: ${created.text.slice(0, 300)}`)
      await exec(oldAgent, oldSession, `await page.goto(${JSON.stringify(ctx.fx.url("/form"))}); return 1`, 60_000)
      const before = status(ctx.u, { binary: oldEntry })
      const t = Date.now()
      const install = spawnSync("bash", ["-c", "curl -fsSL https://opencode.ai/browse/install | bash -s -- --no-wait"], { encoding: "utf8", env: userEnv(ctx.u), cwd: ctx.u.home, timeout: 300_000 })
      ctx.artifact("npm-to-binary-install.txt", install.stdout + install.stderr)
      if (install.status !== 0) throw new Error(`curl installer exited ${install.status}: ${(install.stdout + install.stderr).slice(-400)}`)
      const installMs = Date.now() - t
      const settings = JSON.parse(fs.readFileSync(path.join(ctx.u.configDir, "settings.json"), "utf8")) as { entry: string; version: string }
      const opencode = fs.readFileSync(path.join(ctx.u.home, ".config/opencode/opencode.json"), "utf8")
      const after = status(ctx.u)
      const connected = await waitFor(() => extensionConnected(ctx.u), { timeoutMs: 60_000, label: "extension connected after the migration" })
      const oldStill = await recovery(() => exec(oldAgent, oldSession, "return await page.title()", 30_000), 60_000).catch((error) => ({ ms: -1, attempts: 0, lastError: oneLine(error) }))
      const fresh = await recovery(async () => { const a = await freshAgent(ctx, "binary"); await a.client.call("session_delete", { id: a.session }); await a.client.close() })
      await oldAgent.call("session_delete", { id: oldSession }).catch(() => undefined)
      await oldAgent.close()
      return {
        recoverMs: connected.ms,
        manual: "no",
        note: `installer ${installMs} ms; entry ${settings.entry.endsWith("/browse") ? "binary" : settings.entry}; opencode.json ${opencode.includes(".local/bin/browse") ? "points at the binary" : "UNCHANGED"}; relay ${before.relay.buildId} -> ${after.relay.buildId} (${after.relay.running ? "running" : "down"}); old npm agent ${oldStill.ms >= 0 ? `still works (${oldStill.ms} ms)` : `broken: ${oldStill.lastError}`}; new binary agent ${fresh.ms} ms`,
      }
    },
  },
  {
    // Many agents at once (an opencode with many sessions, or several agents): 16 MCP servers, one session each.
    name: "many-agents",
    async run(ctx) {
      const n = Number(values.agents)
      const t = Date.now()
      const clients = Array.from({ length: n }, () => mcp(ctx.u))
      const outcomes = await Promise.allSettled(clients.map(async (client, i) => {
        const t0 = Date.now()
        await client.initialize()
        const session = `many-${i}-${Date.now().toString(36)}`
        const created = await client.call("session_new", { id: session }, 120_000)
        if (created.isError) throw new Error(`session_new: ${created.text.slice(0, 200)}`)
        const title = await exec(client, session, `await page.goto(${JSON.stringify(ctx.fx.url("/form"))}); await page.getByLabel('Name').fill('agent ${i}'); return await page.title()`, 120_000)
        const snapshot = await exec(client, session, "return (await snapshot()).length", 120_000)
        await client.call("session_delete", { id: session }, 60_000)
        return { ms: Date.now() - t0, title, snapshot }
      }))
      await Promise.all(clients.map((client) => client.close()))
      const ok = outcomes.filter((o) => o.status === "fulfilled").length
      const times = outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value.ms] : []))
      const failures = outcomes.flatMap((o) => (o.status === "rejected" ? [oneLine(o.reason)] : []))
      ctx.artifact("many-agents.json", JSON.stringify(outcomes, null, 2))
      if (ok < n) throw new Error(`${ok}/${n} agents succeeded: ${failures.slice(0, 3).join(" | ")}`)
      return { recoverMs: Date.now() - t, manual: "no", note: `${ok}/${n} ok; per-agent ${Math.min(...times)}-${Math.max(...times)} ms; relay sessions left: ${status(ctx.u).sessions.length}` }
    },
  },
  {
    // Every MCP server dies at once (the agent host quits): the relay must clean up and a new agent must work.
    name: "agents-die",
    async run(ctx) {
      const n = 8
      const clients = Array.from({ length: n }, () => mcp(ctx.u))
      const sessions: string[] = []
      await Promise.all(clients.map(async (client, i) => {
        await client.initialize()
        const { tools } = await client.request("tools/list")
        if (!tools.length) throw new Error(`MCP server ${i} listed no tools right after initialize (registered later; a client that lists once sees none)`)
        const session = `die-${i}-${Date.now().toString(36)}`
        sessions.push(session)
        await client.call("session_new", { id: session }, 120_000)
        await exec(client, session, `await page.goto(${JSON.stringify(ctx.fx.url("/form"))}); return 1`, 120_000)
      }))
      const before = status(ctx.u).sessions.length
      for (const client of clients) process.kill(client.pid!, "SIGKILL")
      const t = Date.now()
      const fresh = await recovery(async () => { const a = await freshAgent(ctx, "afterdie"); await a.client.call("session_delete", { id: a.session }); await a.client.close() })
      const left = status(ctx.u).sessions.filter((s: any) => sessions.includes(s.id)).length
      return { recoverMs: fresh.ms, manual: "no", note: `${before} sessions before; ${left} still listed ${Date.now() - t} ms after the kill (the relay reaps idle ones later)` }
    },
  },
  {
    // Nothing happens for a long time (Chrome stops the worker, tabs idle out); then an agent calls.
    name: "idle",
    async run(ctx) {
      const minutes = Number(values["idle-minutes"])
      const agent = await ctx.agent()
      const sinceLog = Date.now()
      await sleep(minutes * 60_000)
      const cdp = await ctx.chrome.cdp()
      let workerAlive: boolean
      let log: string
      try {
        workerAlive = !!(await cdp.extensionWorker())
        log = formatExtensionLog(await extensionLog(cdp), sinceLog)
      } finally {
        cdp.close()
      }
      ctx.artifact("idle-extension.log", log)
      const connected = extensionConnected(ctx.u)
      const same = await recovery(() => agent.go("/form"), 120_000).catch((error) => ({ ms: -1, attempts: 0, lastError: oneLine(error) }))
      const fresh = await recovery(async () => { const a = await freshAgent(ctx, "afteridle"); await a.client.call("session_delete", { id: a.session }); await a.client.close() })
      await agent.client.call("session_delete", { id: agent.session }).catch(() => undefined)
      await agent.client.close()
      return { recoverMs: fresh.ms, manual: same.ms >= 0 ? "no" : "agent must start a new session (idle cleanup closed the tab, by design)", note: `${minutes} min idle; worker ${workerAlive ? "alive" : "stopped"} at the end; relay saw extension ${connected ? "connected" : "disconnected"}; old session ${same.ms >= 0 ? `${same.ms} ms` : same.lastError}; new ${fresh.ms} ms; reconnects logged: ${(log.match(/ status .*to=connected/g) ?? []).length}` }
    },
  },
]

const only = values.only?.split(",").map((s) => s.trim()).filter(Boolean)
const selected = only ? scenarios.filter((s) => only.includes(s.name)) : scenarios.filter((s) => !["sleep-relay-only", "sleep-chrome-only", "idle", "repair-after-revoke", "remote-pairing", "npm-to-binary"].includes(s.name))
if (only) for (const name of only) if (!scenarios.some((s) => s.name === name)) throw new Error(`unknown scenario ${name}`)

const fx = await startFixtures(fixturePort)
// The browser loads a working copy, so an update scenario can replace its files without touching the sources.
const extension = path.join(u.home, "extension")
replaceExtension(extension, values.extension!)
let chrome = await Chrome.launch(u, { extension, freshProfile: !only || only.includes("first-pairing") })
const ctx: Ctx = {
  u,
  fx,
  get chrome() { return chrome },
  setChrome: (next) => { chrome = next },
  extension,
  artifact: (name, text) => fs.writeFileSync(path.join(dir, "artifacts", name), text),
  agent: () => freshAgent(ctx, "agent"),
  note: (text) => console.log(`  note: ${text}`),
}

// A console collector on the worker, restarted when the worker or browser changes; what it caught goes to artifacts.
const consoleLines: string[] = []
async function collectConsole() {
  try {
    const cdp = await chrome.cdp()
    const collector = await swConsole(cdp)
    const check = setInterval(async () => {
      if (cdp.closed || !chrome.alive()) { clearInterval(check); consoleLines.push(...collector.lines); cdp.close() }
    }, 2000)
    check.unref()
  } catch {}
}
await collectConsole()

for (const scenario of selected) {
  console.log(`== ${scenario.name}`)
  // Each scenario starts from a connected browser (a previous one may have left it reconnecting); how long that took
  // is part of the record.
  if (scenario.name !== "first-pairing") {
    const ready = await waitFor(() => extensionConnected(u), { timeoutMs: 45_000, label: "extension connected before the scenario" }).catch(() => undefined)
    if (ready && ready.ms > 1000) console.log(`  note: browser reconnected ${ready.ms} ms into the scenario's start`)
  }
  const t = Date.now()
  try {
    const outcome = (await scenario.run(ctx)) ?? {}
    const row = { name: scenario.name, ok: true, ms: Date.now() - t, recoverMs: outcome.recoverMs, manual: outcome.manual ?? "", note: outcome.note ?? "" }
    rows.push(row)
    records.write(row)
    console.log(`PASS ${scenario.name} ${row.ms} ms${outcome.recoverMs !== undefined ? ` (recovered in ${outcome.recoverMs} ms)` : ""} ${outcome.note ?? ""}`)
  } catch (error) {
    const row = { name: scenario.name, ok: false, ms: Date.now() - t, manual: "?", note: oneLine(error) }
    rows.push(row)
    records.write(row)
    console.log(`FAIL ${scenario.name}: ${oneLine(error)}`)
    try {
      const cdp = await chrome.cdp()
      ctx.artifact(`${scenario.name}-extension.log`, formatExtensionLog(await extensionLog(cdp), t - 60_000))
      cdp.close()
    } catch {}
    ctx.artifact(`${scenario.name}-relay.log`, relayLogSince(u, Math.max(0, relayLogSize(u) - 20_000)))
    if (!chrome.alive()) chrome = await Chrome.launch(u, { extension })
  }
  await collectConsole()
}

ctx.artifact("sw-console.log", consoleLines.join("\n"))
const passed = rows.filter((r) => r.ok).length
const summary = [
  "# Installed artifacts",
  "",
  `${passed}/${rows.length} passed. User ${u.name}: ${cli(u, ["--version"]).stdout.trim()} at ${u.binary}; extension ${values.extension}. ${new Date().toISOString()}`,
  "",
  "| Scenario | Result | Recovery (ms) | User action needed | Note |",
  "| --- | --- | ---: | --- | --- |",
  ...rows.map((r) => `| ${r.name} | ${r.ok ? "pass" : "FAIL"} | ${r.recoverMs ?? ""} | ${mdEscape(r.manual)} | ${mdEscape(r.note)} |`),
  "",
]
fs.writeFileSync(path.join(dir, "summary.md"), summary.join("\n"))
console.log(summary.join("\n"))
if (!values.keep) await chrome.stop()
await fx.close()
process.exit(passed === rows.length ? 0 : 1)
