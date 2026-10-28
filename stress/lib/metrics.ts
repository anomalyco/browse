// Samples the relay, Chrome and the extension on the box: memory, CPU, file descriptors, tabs, groups, debugger
// attachments and journal size. Linux only (/proc).
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import type { BrowserCdp } from "./cdp.ts"
import { dataDir, relayBase, relayJson } from "./env.ts"

const CLK_TCK = 100

export async function relayPid(): Promise<number | undefined> {
  try {
    const version = await fetch(`${relayBase}/version`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()) as { pid?: number }
    return version.pid
  } catch {
    return undefined
  }
}

function procStat(pid: number): { cpuTicks: number; rssKb: number; fds: number; threads: number } | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const cpuTicks = Number(fields[11]) + Number(fields[12])
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8")
    const rssKb = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0)
    const threads = Number(status.match(/Threads:\s+(\d+)/)?.[1] ?? 0)
    const fds = fs.readdirSync(`/proc/${pid}/fd`).length
    return { cpuTicks, rssKb, fds, threads }
  } catch {
    return undefined
  }
}

function dirBytes(dir: string): number {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) total += dirBytes(file)
      else try { total += fs.statSync(file).size } catch {}
    }
  } catch {}
  return total
}

function chromeProcesses(): { count: number; rssMb: number; byType: Record<string, { count: number; rssMb: number }> } {
  const out = execFileSync("ps", ["-eo", "rss=,args="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  const byType: Record<string, { count: number; rssMb: number }> = {}
  let count = 0
  let rssKb = 0
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!match || !match[2]!.includes("chrome-for-testing") || match[2]!.includes("chrome_crashpad_handler")) continue
    const kb = Number(match[1])
    const type = match[2]!.match(/--type=([\w-]+)/)?.[1] ?? "browser"
    count++
    rssKb += kb
    byType[type] ??= { count: 0, rssMb: 0 }
    byType[type]!.count++
    byType[type]!.rssMb += kb / 1024
  }
  for (const entry of Object.values(byType)) entry.rssMb = Math.round(entry.rssMb)
  return { count, rssMb: Math.round(rssKb / 1024), byType }
}

export type Sample = Record<string, number | string | boolean | null | object>

export class Sampler {
  private last?: { pid: number; ticks: number; at: number }

  async sample(cdp: BrowserCdp | undefined): Promise<Sample> {
    const at = Date.now()
    const pid = await relayPid()
    const sample: Sample = { relayPid: pid ?? null }
    const stat = pid ? procStat(pid) : undefined
    if (pid && stat) {
      sample.relayRssMb = Math.round(stat.rssKb / 1024)
      sample.relayFds = stat.fds
      sample.relayThreads = stat.threads
      if (this.last && this.last.pid === pid) sample.relayCpuPct = Math.round((((stat.cpuTicks - this.last.ticks) / CLK_TCK) / ((at - this.last.at) / 1000)) * 1000) / 10
      this.last = { pid, ticks: stat.cpuTicks, at }
    }
    try {
      const status = await relayJson("/extension/status", undefined, 5000)
      sample.extensionConnected = status.connected === true
      sample.relayTargets = status.activeTargets ?? null
      sample.relayChildTargets = status.childTargets ?? null
      sample.relaySessions = Array.isArray(status.sessions) ? status.sessions.length : null
      sample.cdpClients = status.cdpClients ?? null
      sample.processFaults = status.processFaults?.suppressed ?? null
    } catch {
      sample.extensionConnected = false
    }
    try {
      const chrome = chromeProcesses()
      sample.chromeProcesses = chrome.count
      sample.chromeRssMb = chrome.rssMb
      sample.chromeByType = chrome.byType
    } catch {}
    if (cdp && !cdp.closed) {
      try {
        const targets = await cdp.targets()
        sample.swAlive = targets.some((t) => t.type === "service_worker" && t.url.includes("afeafocngkodbmaipcngoamamfmekgfo"))
        const pages = targets.filter((t) => t.type === "page")
        sample.pageTargets = pages.length
        sample.debuggerAttached = pages.filter((t) => t.attached).length
        const view = await cdp.extensionView()
        sample.tabs = view.tabs.length
        sample.groupedTabs = view.tabs.filter((t) => t.groupId !== -1).length
        sample.groups = view.groups.length
        sample.windows = view.windows
        // Leak accounting: every tab a session holds is tracked for idle cleanup, and no tab is left that neither a
        // session holds nor a window shows (agent tabs are opened in the background, so the active ones are users').
        const tracked = new Set(await cdp.evalInExtension<number[]>(`chrome.storage.local.get("tabCleanup").then((s) => Object.keys(s.tabCleanup ?? {}).map(Number))`))
        const held = new Set((await relayJson<any[]>("/json/list", undefined, 5000)).filter((t) => t.opencodeBrowserSessionId).map((t) => t.tabId as number))
        const existing = new Set(view.tabs.map((t) => t.id))
        sample.trackedTabs = [...tracked].filter((id) => existing.has(id)).length
        sample.sessionTabs = [...held].filter((id) => existing.has(id)).length
        sample.untrackedSessionTabs = [...held].filter((id) => existing.has(id) && !tracked.has(id)).length
        sample.orphanTabs = view.tabs.filter((t) => !t.active && !held.has(t.id)).length
      } catch (error) {
        sample.cdpError = String(error).slice(0, 120)
      }
    }
    sample.journalBytes = dirBytes(path.join(dataDir, "sessions"))
    sample.dataDirBytes = dirBytes(dataDir)
    try { sample.relayLogBytes = fs.statSync(path.join(dataDir, "logs/relay.log")).size } catch {}
    return sample
  }
}
