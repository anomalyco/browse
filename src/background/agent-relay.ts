// The link to the OpenCode Browser relay (ws://127.0.0.1:19988/extension). The relay runs agent sessions
// for the browse MCP server and the opencode-browser CLI (Playwright `execute`, recordings, handoffs) and drives tabs
// through this extension; this module runs its commands. The wire protocol is in ../agent-relay/protocol.ts,
// the relay itself in cli/src/relay.ts.
import {
  defaultRelayPort,
  encodeRecordingFrame,
  extensionProtocolVersion,
  extensionReconnectAlarmPeriodMs,
  isJsonObject,
  pageStatusFromJson,
  parseExtensionCommand,
  type ExtensionCommand,
  type JsonObject,
  type PageStatus,
} from "../agent-relay/protocol"
import type {
  OffscreenCancelRecordingResult,
  OffscreenOutgoingMessage,
  OffscreenStartRecordingResult,
  OffscreenStatusRecordingResult,
  OffscreenStopRecordingResult,
} from "../agent-relay/recording-types"
import {
  AGENT_CURSOR_KEY,
  agentCursor,
  HUMAN_INPUT_KEY,
  humanInput,
  type AgentRelayState,
  type AgentRelayStatus,
  type AgentRelayUpdate,
  type AutoUpdateMode,
  type PairingSource,
  type ProtocolSkew,
  type RelayAutoUpdate,
  type RelayOverrides,
  type RelaySettings,
  autoUpdateMode,
} from "../shared/protocol"
import { createAgentRelayLog, formatAgentRelayLog } from "./agent-relay-log"
import { AgentGroups } from "./agent-groups"
import { AgentWindow } from "./agent-window"
import { DebuggerHub } from "./debugger-hub"
import { HandoffNotice } from "./handoff-notice"
import { normalizePairingCode, pairingProof, pairingTicketKey, randomNonce, sameSecret, unwrapPairingCode } from "./pairing"
import { PageScripts } from "./page-scripts"
import { TabCleanup } from "./tab-cleanup"
import { UserSettings } from "./user-settings"

/** Badge text the relay asked for, by tab. */
export type AgentBadge = { text: string; title?: string }

const OWNER = "relay"
/** Overrides the relay port, for development and isolated tests. */
const PORT_KEY = "agentRelayPort"
const PROFILE_KEY = "agentRelayProfile"
/** chrome.storage.local: each agent session's tab group, so a worker restart keeps a session's tabs in one group. */
const SESSION_GROUPS_KEY = "agentSessionGroups"
/** chrome.storage.local: the pairing code typed on the status page (Chrome Web Store builds). */
export const PAIRING_KEY = "agentRelayPairingCode"
/** Written next to the manifest by `install` for unpacked builds (cli/src/relay-secrets.ts). */
const PAIRING_FILE = "relay-pairing.json"
const ALARM = "opencode-browser-relay"
// Relay tab groups end with this marker, which Chrome renders without width: they read like the session
// groups ("opencode", or the agent session's name) but stay distinguishable for cleanup. The shared group (the
// "One shared group for all agents" setting) ends with it twice.
const GROUP_MARKER = "\u2063"
const SHARED_MARKER = GROUP_MARKER + GROUP_MARKER
const GROUP_COLOR = "grey"
const MAX_RECORDING_BUFFER = 16 * 1024 * 1024
/** The largest message the relay accepts, in bytes (256 MiB, as Playwright's CDP client); kept a little under. */
const MAX_MESSAGE = 255 * 1024 * 1024
const CONNECT_TIMEOUT = 10_000
const KEEPALIVE = 20_000
const BACKOFF_BASE = 500
const BACKOFF_CAP = 15_000
/** A connection that lasted this long was healthy; the next failure starts the backoff over. */
const STABLE_AFTER = 5_000
/** CDP commands are frequent; only slow or failed ones go to the log. */
const SLOW_CDP = 2_000
// Another extension's frame in the page (1Password, LastPass, Bitwarden) makes Chrome refuse commands or
// drop the debugger; evicting the frame and re-attaching recovers.
const FOREIGN_FRAME = /Cannot access a chrome-extension:\/\/ URL|Debugger is not attached to the tab/i
const CLOSE_CODES: Record<number, string> = {
  1000: "normal",
  1001: "going away",
  1006: "abnormal (no relay, or the connection dropped)",
  1011: "handshake failed",
  4001: "replaced by a newer connection",
  4002: "hello missing or liveness probe failed",
  4003: "protocol incompatible",
  4004: "another browser or profile is connected",
  4005: "relay requires pairing (this extension is too old)",
  4006: "pairing failed",
}

export function createAgentRelay(input: { changed: (state: AgentRelayState) => void; badgesChanged: () => void }) {
  const log = createAgentRelayLog()
  let socket: WebSocket | undefined
  let starting: Promise<void> | undefined
  let generation = 0
  let status: AgentRelayStatus = "offline"
  let port = defaultRelayPort
  let attempts = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  let keepalive: ReturnType<typeof setInterval> | undefined
  let connectedAt: number | undefined
  let offscreen: Promise<void> | undefined
  const cdp = { count: 0, errors: 0 }
  const relayTabs = new Set<number>()
  let reloading = false
  /** Tabs with a recording in progress; cleanup leaves them open. */
  const recordingTabs = new Set<number>()
  /**
   * Each agent session's tab group, so a session keeps one group while its display name changes. Stored, so a service
   * worker restart doesn't put a session's next tab in a second group. Group ids don't survive a browser restart.
   */
  const sessionGroups = new Map<string, number>()
  let sessionGroupsRestored: Promise<void> | undefined
  const restoreSessionGroups = () =>
    (sessionGroupsRestored ??= chrome.storage.local
      .get(SESSION_GROUPS_KEY)
      .then((stored) => {
        const saved = stored[SESSION_GROUPS_KEY]
        if (!isJsonObject(saved)) return
        for (const [key, groupId] of Object.entries(saved))
          if (typeof groupId === "number" && !sessionGroups.has(key)) sessionGroups.set(key, groupId)
      })
      .catch(() => undefined))
  const setSessionGroup = (key: string, groupId: number) => {
    if (sessionGroups.get(key) === groupId) return
    sessionGroups.set(key, groupId)
    void chrome.storage.local.set({ [SESSION_GROUPS_KEY]: Object.fromEntries(sessionGroups) }).catch(() => undefined)
  }
  const pageStatuses = new Map<number, PageStatus>()
  /** Each tab's page status deliveries, in order (see deliverPageStatus). */
  const pageDeliveries = new Map<number, Promise<void>>()
  const badges = new Map<number, AgentBadge>()
  /** Tabs the user let agents use while the relay was not connected; announced once it is. */
  const pendingAttach = new Set<number>()
  /** Sockets whose relay proved it knows the pairing code; nothing else is obeyed. */
  const trusted = new WeakSet<WebSocket>()
  /** The handshake in flight on a socket: this extension's nonce and the code it proves with. */
  const handshakes = new WeakMap<WebSocket, { nonce: string; code: string; port: number; ticket?: boolean }>()
  /** A one-time pairing ticket from install's URL (welcome.html#ticket=…), used on the next connection only. */
  let ticket: string | undefined
  /** The code a ticket just brought in: storing it must not restart the connection it arrived on. */
  let adopting: string | undefined
  /** The socket that carried a ticket, and whether the relay refused it (expired or already used). */
  let ticketSocket: WebSocket | undefined
  let ticketRejected = false
  let pairing: PairingSource = "none"
  let update: AgentRelayUpdate | undefined
  /** Settings the connected relay's environment fixes, as it reported them (`relay.settings`). */
  let overrides: RelayOverrides | undefined
  /** The connected relay's update state (`relay.settings`). */
  let autoUpdate: RelayAutoUpdate | undefined
  /** Which side to update when the relay's protocol doesn't match this extension's. */
  let skew: ProtocolSkew | undefined
  let bundledPairing: Promise<string | undefined> | undefined

  const snapshot = (): AgentRelayState => ({
    status,
    pairing,
    tabs: Array.from(relayTabs, (tabId) => {
      const page = pageStatuses.get(tabId)
      return page ? { tabId, status: page } : { tabId }
    }),
    ...(update ? { update } : {}),
    ...(overrides ? { overrides } : {}),
    ...(autoUpdate ? { autoUpdate } : {}),
    ...(skew && status === "incompatible" ? { skew } : {}),
    ...(ticketRejected ? { ticketRejected: true } : {}),
  })
  const notify = () => input.changed(snapshot())
  const setStatus = (next: AgentRelayStatus) => {
    if (status === next) return
    log.add("status", { from: status, to: next })
    status = next
    notify()
  }

  /** The connection, once its relay has paired; events and data never go to an unpaired one. */
  const open = () => (socket?.readyState === WebSocket.OPEN && trusted.has(socket) ? socket : undefined)
  const send = (message: JsonObject) => {
    const data = serialize(message)
    // The relay drops a connection that sends more than it accepts; a lost event is better than a reconnect loop.
    if (data === undefined) return log.add("event.dropped", { method: String(message.method) })
    open()?.send(data)
  }
  /**
   * Brings the tab's page (and its handoff notification) up to date with its latest status. Deliveries run one at a
   * time per tab and each sends whatever is latest when its turn comes: they await notifications and messaging, and
   * when they ran side by side an earlier "running" could reach the page after the "waiting" that followed it, which
   * removed the handoff card (about one handoff in ten with eight agents busy) and left the agent waiting for a
   * Continue nobody could see.
   */
  const deliverPageStatus = (tabId: number): Promise<void> => {
    const run = (pageDeliveries.get(tabId) ?? Promise.resolve()).then(async () => {
      const page = pageStatuses.get(tabId)
      if (!page) {
        await HandoffNotice.clear(tabId)
        // Restricted pages have no content script; the status is best-effort there.
        await chrome.tabs.sendMessage(tabId, { action: "page-status.clear" }).catch(() => undefined)
        return
      }
      // A recorded tab gets no card; the user hears about the handoff from a notification instead (or sees the
      // card after all when no notification can be shown).
      await HandoffNotice.sync(tabId, page, sessionName)
      // A newer status arrived meanwhile; its own delivery, queued behind this one, sends it.
      if (pageStatuses.get(tabId) !== page) return
      await PageScripts.send(tabId, { action: "page-status.set", status: HandoffNotice.forPage(tabId, page) })
    })
    const settled = run.catch(() => undefined)
    pageDeliveries.set(tabId, settled)
    void settled.then(() => {
      if (pageDeliveries.get(tabId) === settled) pageDeliveries.delete(tabId)
    })
    return run
  }
  const forget = (tabId: number) => {
    const known = relayTabs.delete(tabId)
    pageStatuses.delete(tabId)
    void HandoffNotice.clear(tabId)
    if (known) notify()
  }

  /**
   * The pairing code: the one `install` wrote into this unpacked build, else the one typed on the status page. A store
   * build has no file. A missing file is looked for again on every connection attempt (install may write it while the
   * worker runs), and a found one again on Reconnect or a pairing change (install may have written a new code).
   */
  const pairingCode = async () => {
    const reading = (bundledPairing ??= fetch(chrome.runtime.getURL(PAIRING_FILE))
      .then((response) => (response.ok ? (response.json() as Promise<unknown>) : undefined))
      .then((value) => normalizePairingCode(isJsonObject(value) ? value.code : undefined))
      .catch(() => undefined))
    const bundled = await reading
    if (bundled === undefined && bundledPairing === reading) bundledPairing = undefined
    const stored = bundled === undefined ? normalizePairingCode((await chrome.storage.local.get(PAIRING_KEY))[PAIRING_KEY]) : undefined
    const source: PairingSource = bundled !== undefined ? "bundled" : stored !== undefined ? "stored" : "none"
    if (source !== pairing) {
      pairing = source
      notify()
    }
    return bundled ?? stored
  }

  const connect = (reason: string) => {
    starting ??= start(reason).finally(() => {
      starting = undefined
    })
    return starting
  }

  const start = async (reason: string) => {
    if (socket && socket.readyState <= WebSocket.OPEN) return
    clearTimeout(retry)
    retry = undefined
    port = Number((await chrome.storage.local.get(PORT_KEY))[PORT_KEY]) || defaultRelayPort
    if (socket && socket.readyState <= WebSocket.OPEN) return
    // Without a pairing code there is no relay to trust; wait for one (install, or the status page).
    if ((await pairingCode()) === undefined && ticket === undefined) {
      if (status !== "unpaired") log.add("pairing.missing")
      setStatus("unpaired")
      return
    }
    if (socket && socket.readyState <= WebSocket.OPEN) return
    const url = `ws://127.0.0.1:${port}/extension`
    const mine = ++generation
    // While no relay runs, attempts repeat until one starts; log the first ones of a streak, not every poll.
    const quiet = status === "offline" && attempts > 1
    if (!quiet) log.add("connect", { port, attempt: attempts, reason, generation: mine })
    const current = new WebSocket(url)
    socket = current
    let openedAt: number | undefined
    // A relay that accepts the TCP connection but never answers would otherwise hold this attempt forever.
    const timeout = setTimeout(() => {
      if (current.readyState !== WebSocket.CONNECTING) return
      log.add("connect.timeout", { port, ms: CONNECT_TIMEOUT })
      current.close()
    }, CONNECT_TIMEOUT)
    current.onopen = () => {
      clearTimeout(timeout)
      openedAt = Date.now()
      log.add("open", { port, generation: mine })
      void hello(current).catch((error: unknown) => {
        log.add("hello.error", { error: text(error) })
        current.close(1011, "Handshake failed")
      })
    }
    current.onmessage = (event) => {
      if (typeof event.data !== "string") return
      if (trusted.has(current)) void handle(current, event.data)
      else void verify(current, event.data).catch((error: unknown) => {
        log.add("pairing.error", { error: text(error) })
        current.close(4006, "Relay failed pairing")
      })
    }
    current.onclose = (event) => {
      clearTimeout(timeout)
      current.onopen = current.onmessage = current.onclose = null
      if (socket !== current) return
      socket = undefined
      connectedAt = undefined
      clearInterval(keepalive)
      keepalive = undefined
      const lasted = openedAt === undefined ? undefined : Date.now() - openedAt
      if (lasted !== undefined && lasted >= STABLE_AFTER) attempts = 0
      if (!quiet || openedAt !== undefined) log.add("close", {
        code: event.code,
        meaning: CLOSE_CODES[event.code],
        reason: event.reason || undefined,
        clean: event.wasClean,
        opened: openedAt !== undefined,
        ms: lasted,
      })
      void chrome.runtime.sendMessage({ action: "recording.cancelAll" }).catch(() => undefined)
      overrides = undefined
      autoUpdate = undefined
      if (ticketSocket === current) {
        ticketSocket = undefined
        ticketRejected = !trusted.has(current)
      }
      if (event.code === 4003) {
        // A newer relay names the side that's behind: "Extension protocol incompatible: extension-newer".
        skew = /extension-newer/.test(event.reason) ? "update-cli" : /extension-older/.test(event.reason) ? "update-extension" : undefined
        setStatus("incompatible")
      }
      else if (event.code === 4004) setStatus("conflict")
      else if (event.code === 4006) setStatus("untrusted")
      // A missing relay is normal until an agent's browse tools (or the opencode-browser CLI) start one.
      else setStatus(openedAt === undefined ? "offline" : "connecting")
      schedule(quiet && openedAt === undefined)
    }
  }

  /** Capped exponential backoff with jitter; the alarm keeps trying while the worker sleeps. */
  const schedule = (quiet = false) => {
    clearTimeout(retry)
    const base = Math.min(BACKOFF_CAP, BACKOFF_BASE * 2 ** attempts)
    const delay = Math.round(base * (0.75 + Math.random() * 0.5))
    attempts = Math.min(attempts + 1, 16)
    if (!quiet) log.add("retry", { ms: delay, attempt: attempts })
    retry = setTimeout(() => {
      retry = undefined
      void connect("backoff")
    }, delay)
  }

  /**
   * Opens the pairing handshake: the hello carries a fresh nonce, and nothing the relay sends is obeyed until it
   * answers with a proof over that nonce (`verify`).
   */
  const hello = async (current: WebSocket) => {
    const stored = (await chrome.storage.local.get(PROFILE_KEY))[PROFILE_KEY] as { id: string; name?: string } | undefined
    const profile = stored ?? { id: crypto.randomUUID() }
    if (!stored) await chrome.storage.local.set({ [PROFILE_KEY]: profile })
    // A ticket goes first (and only once): it's how a store build without the right code gets it.
    const usingTicket = ticket
    ticket = undefined
    const code = usingTicket !== undefined ? await pairingTicketKey(usingTicket) : await pairingCode()
    if (socket !== current || current.readyState !== WebSocket.OPEN) return
    if (code === undefined) return current.close(4006, "Not paired")
    const nonce = randomNonce()
    // The proofs are bound to the port this socket dialled (see pairing.ts).
    handshakes.set(current, { nonce, code, port: Number(new URL(current.url).port), ...(usingTicket !== undefined ? { ticket: true } : {}) })
    if (usingTicket !== undefined) ticketSocket = current
    // An older relay waits for commands it never gets; one that doesn't pair in time isn't ours.
    setTimeout(() => {
      if (socket === current && current.readyState === WebSocket.OPEN && !trusted.has(current)) {
        log.add("pairing.rejected", { reason: "no challenge" })
        current.close(4006, "Relay did not pair")
      }
    }, CONNECT_TIMEOUT)
    current.send(
      JSON.stringify({
        method: "hello",
        params: {
          version: chrome.runtime.getManifest().version,
          build: __OPENCODE_BROWSER_BUILD__,
          protocolVersion: extensionProtocolVersion,
          profileId: profile.id,
          profileName: profile.name ?? "OpenCode Browser",
          pairing: { nonce, ...(usingTicket !== undefined ? { ticket: true } : {}) },
        },
      }),
    )
  }

  /** Checks the relay's proof, answers with this extension's, and only then starts working for it. */
  const verify = async (current: WebSocket, data: string) => {
    const pending = handshakes.get(current)
    handshakes.delete(current)
    const message = (() => {
      try {
        const parsed: unknown = JSON.parse(data)
        return isJsonObject(parsed) ? parsed : undefined
      } catch {
        return undefined
      }
    })()
    const params = isJsonObject(message?.params) ? message.params : undefined
    const relayNonce = typeof params?.nonce === "string" ? params.nonce : undefined
    const ok =
      pending !== undefined &&
      message?.method === "auth.challenge" &&
      relayNonce !== undefined &&
      /^[A-Za-z0-9_-]{22,128}$/.test(relayNonce) &&
      sameSecret(await pairingProof(pending.code, "relay", pending.port, relayNonce, pending.nonce), params?.proof)
    if (socket !== current || current.readyState !== WebSocket.OPEN) return
    if (!ok || !pending || !relayNonce) {
      // An older relay, or a program posing as one on this port: it gets nothing.
      log.add("pairing.rejected", { reason: message?.method === "auth.challenge" ? "wrong proof" : `unexpected ${String(message?.method ?? message?.id ?? "message")}` })
      current.close(4006, "Relay failed pairing")
      return
    }
    // With a ticket, the relay proved it holds it and sent the real code masked with it: keep that code and prove it.
    let proven = pending.code
    if (pending.ticket) {
      const code = await unwrapPairingCode(pending.code, params?.wrapped, pending.port, pending.nonce, relayNonce)
      if (socket !== current || current.readyState !== WebSocket.OPEN) return
      if (code === undefined) {
        log.add("pairing.rejected", { reason: "ticket without a code" })
        current.close(4006, "Relay failed pairing")
        return
      }
      adopting = code
      ticketSocket = undefined
      ticketRejected = false
      await chrome.storage.local.set({ [PAIRING_KEY]: code })
      log.add("pairing.ticket")
      proven = code
    }
    current.send(JSON.stringify({ method: "auth.response", params: { proof: await pairingProof(proven, "extension", pending.port, pending.nonce, relayNonce) } }))
    // The protocols the relay speaks (newer relays say): outside them, the relay keeps this connection but sends no
    // work, so show which side to update instead of "connected".
    const range = isJsonObject(params?.protocol) ? params.protocol : undefined
    skew =
      typeof range?.version === "number" && extensionProtocolVersion > range.version
        ? "update-cli"
        : typeof range?.min === "number" && extensionProtocolVersion < range.min
          ? "update-extension"
          : undefined
    trusted.add(current)
    log.add("pairing.ok", { source: pairing })
    // Tabs an agent opened say so: one the relay no longer knows after a reconnect is closed, not handed to the user.
    for (const tabId of Array.from(relayTabs)) {
      const agent = await TabCleanup.isTracked(tabId)
      if (socket !== current) return
      current.send(JSON.stringify({ method: "debugger.attached", params: { tabId, ...(agent ? { agent: true } : {}) } }))
    }
    current.send(JSON.stringify({ method: "ready" }))
    log.add("hello", { tabs: relayTabs.size, protocol: extensionProtocolVersion })
    // The status page's relay-side settings; an older relay ignores the event and keeps its defaults.
    void sendSettings()
    clearInterval(keepalive)
    keepalive = setInterval(() => {
      if (socket === current) send({ method: "pong" })
    }, KEEPALIVE)
    connectedAt = Date.now()
    setStatus(skew ? "incompatible" : "connected")
    pendingAttach.forEach((tabId) => send({ method: "toolbar.clicked", params: { tabId } }))
    pendingAttach.clear()
    void ungroupStale().catch((error: unknown) => log.add("ungroupStale.error", { error: text(error) }))
  }

  const handle = async (current: WebSocket, data: string) => {
    const command = (() => {
      try {
        return parseExtensionCommand(data)
      } catch (error) {
        log.add("command.invalid", { error: text(error), data: data.slice(0, 200) })
        current.send(JSON.stringify({ method: "log", params: { level: "error", message: text(error) } }))
        // A command this build doesn't know (an older or newer relay) still gets an answer, so the relay
        // doesn't wait for its timeout.
        const id = (() => {
          try {
            const parsed: unknown = JSON.parse(data)
            return isJsonObject(parsed) && typeof parsed.id === "number" ? parsed.id : undefined
          } catch {
            return undefined
          }
        })()
        if (id !== undefined) current.send(JSON.stringify({ id, error: text(error) }))
        return undefined
      }
    })()
    if (!command) return
    const begin = performance.now()
    const reply = await run(command, current).then(
      (result) => ({ id: command.id, result }),
      (error: unknown) => ({ id: command.id, error: text(error) }),
    )
    const ms = Math.round(performance.now() - begin)
    const failed = "error" in reply
    const cdpMethod = command.method === "debugger.sendCommand" ? command.params?.method : undefined
    if (cdpMethod !== undefined) {
      cdp.count++
      if (failed) cdp.errors++
    }
    if (cdpMethod === undefined || failed || ms >= SLOW_CDP)
      log.add("command", {
        method: command.method,
        cdp: typeof cdpMethod === "string" ? cdpMethod : undefined,
        id: command.id,
        tabId: typeof command.params?.tabId === "number" ? command.params.tabId : undefined,
        ms,
        ok: !failed,
        error: failed ? reply.error : undefined,
      })
    if (socket !== current || current.readyState !== WebSocket.OPEN) return
    // A result larger than the relay accepts (a huge screenshot or response body) fails that one command instead of
    // closing the connection, which would fail every command in flight and make the relay reconnect.
    const serialized = serialize(reply)
    if (serialized === undefined) {
      log.add("command.tooLarge", { method: command.method, id: command.id })
      current.send(JSON.stringify({ id: command.id, error: `Result too large to send (the limit is ${Math.floor(MAX_MESSAGE / 1048576)} MB). Request less data, for example a viewport screenshot instead of a full page.` }))
      return
    }
    current.send(serialized)
  }

  const run = async (command: ExtensionCommand, current: WebSocket): Promise<JsonObject> => {
    const params = command.params
    switch (command.method) {
      case "ping":
        return {}
      case "debugger.attach": {
        const tabId = number(params, "tabId")
        TabCleanup.touch(tabId)
        await DebuggerHub.attach(tabId, OWNER)
        relayTabs.add(tabId)
        notify()
        return {}
      }
      case "debugger.detach": {
        const tabId = number(params, "tabId")
        forget(tabId)
        await DebuggerHub.detach(tabId, OWNER)
        await ungroup(tabId, { finished: true })
        return {}
      }
      case "debugger.sendCommand":
        TabCleanup.touch(number(params, "tabId"))
        return sendCommand(params)
      case "tabs.create": {
        // In the background of the user's window (or the agents' own unfocused window, by setting), never in front
        // of the user's tabs.
        const url = typeof params?.url === "string" ? params.url : "about:blank"
        const creating = await TabCleanup.beginCreate(url)
        const tab = await AgentWindow.open(url, {
          active: params?.active === true,
          ...(AgentWindow.isPlacement(params?.window) ? { override: params.window } : {}),
        }).catch(async (error: unknown) => {
          await TabCleanup.endCreate(creating)
          throw error
        })
        if (tab.id === undefined) {
          void TabCleanup.endCreate(creating)
          throw new Error("Created tab has no id")
        }
        TabCleanup.track(tab.id)
        await TabCleanup.endCreate(creating)
        // A discarded tab loses the debugger and the agent's page.
        await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => undefined)
        return { tabId: tab.id }
      }
      case "tabs.remove":
        await chrome.tabs.remove(number(params, "tabId"))
        return {}
      case "tabs.group":
        return {
          groupId: await group(
            number(params, "tabId"),
            typeof params?.sessionId === "string" ? params.sessionId : undefined,
            current,
          ),
        }
      case "tabs.ungroup":
        await ungroup(number(params, "tabId"))
        return {}
      case "action.setAttached": {
        const tabId = number(params, "tabId")
        if (params?.attached === true) badges.set(tabId, { text: "ON", title: ATTACHED_TITLE })
        if (params?.attached !== true) badges.delete(tabId)
        input.badgesChanged()
        return {}
      }
      case "action.setBadge": {
        const tabId = number(params, "tabId")
        const value = typeof params?.text === "string" ? params.text : ""
        if (!value) badges.delete(tabId)
        // "ON" keeps our title, which says the toolbar button stops agents.
        if (value)
          badges.set(tabId, {
            text: value,
            ...(value === "ON"
              ? { title: ATTACHED_TITLE }
              : typeof params?.title === "string"
                ? { title: params.title }
                : {}),
          })
        input.badgesChanged()
        return {}
      }
      case "pageStatus.set": {
        const tabId = number(params, "tabId")
        const page = pageStatusFromJson(params?.status)
        if (!page) throw new Error("Invalid page status")
        const wasWaiting = pageStatuses.get(tabId)?.state === "waiting"
        pageStatuses.set(tabId, page)
        // An execute starting or ending counts as use, so idle time runs from the end of the last one.
        TabCleanup.touch(tabId)
        notify()
        // A handoff opens the agent's group so the user can find the tab; it folds up again afterwards.
        if (page.state === "waiting") void AgentGroups.expandTab(tabId)
        else if (wasWaiting) void AgentGroups.settleTab(tabId)
        await deliverPageStatus(tabId)
        return {}
      }
      case "pageStatus.clear": {
        const tabId = number(params, "tabId")
        const wasWaiting = pageStatuses.get(tabId)?.state === "waiting"
        pageStatuses.delete(tabId)
        if (wasWaiting) void AgentGroups.settleTab(tabId)
        notify()
        await deliverPageStatus(tabId)
        return {}
      }
      case "runtime.reload":
        log.add("runtime.reload")
        // Reloading detaches every tab. Keep the stored attachments (the new worker re-attaches them) and don't
        // tell the relay, which would otherwise drop its sessions' tabs; it gets them back on the next hello.
        reloading = true
        DebuggerHub.freeze()
        setTimeout(() => {
          // Browsers only let pages close with 1000 or 3000-4999; any other code throws and the reload never runs.
          socket?.close(1000, "Extension reloading")
          chrome.runtime.reload()
        }, 50)
        return {}
      case "tabs.cleanup": {
        const minutes = typeof params?.idleMinutes === "number" ? Math.max(0, params.idleMinutes) : undefined
        const closed = await TabCleanup.cleanup(minutes === undefined ? {} : { minutes })
        return { closed: closed.map((tab) => ({ tabId: tab.tabId, title: tab.title, idleMinutes: tab.idleMinutes })) }
      }
      case "relay.settings": {
        // What the relay's environment fixes, shown on the status page. Only known values; anything else is dropped.
        const fixed = isJsonObject(params?.overrides) ? params.overrides : {}
        const next: RelayOverrides = {
          ...(fixed.agentWindow === "current" || fixed.agentWindow === "separate" ? { agentWindow: fixed.agentWindow } : {}),
          ...(fixed.cursor === "off" || fixed.cursor === "always" ? { cursor: fixed.cursor } : {}),
          ...(fixed.humanInput === "on" || fixed.humanInput === "off" ? { humanInput: fixed.humanInput } : {}),
        }
        overrides = Object.keys(next).length ? next : undefined
        autoUpdate = relayAutoUpdate(params?.autoUpdate)
        notify()
        return {}
      }
      // The relay's settings tool: the status page's settings, read or written through storage like the page's own.
      case "settings.get":
        return UserSettings.read()
      case "settings.set":
        return UserSettings.write(isJsonObject(params?.values) ? params.values : undefined)
      case "update.notice": {
        const summary = typeof params?.summary === "string" ? params.summary.slice(0, 200) : undefined
        const command = typeof params?.command === "string" ? params.command.slice(0, 1000) : undefined
        update = summary && command ? { summary, command } : undefined
        notify()
        return {}
      }
      case "recording.start": {
        const result = await startRecording(params)
        if (result.success === true) recordingTabs.add(number(params, "tabId"))
        return result
      }
      case "recording.stop":
        recordingTabs.delete(number(params, "tabId"))
        return recordingCall<OffscreenStopRecordingResult>("recording.stop", number(params, "tabId")).then((result) =>
          result.success ? { success: true, tabId: result.tabId, duration: result.duration } : result,
        )
      case "recording.status": {
        const tabId = number(params, "tabId")
        const result = await recordingCall<OffscreenStatusRecordingResult>("recording.status", tabId)
        return {
          isRecording: result.isRecording,
          tabId,
          ...(result.startedAt === undefined ? {} : { startedAt: result.startedAt }),
        }
      }
      case "recording.cancel":
        recordingTabs.delete(number(params, "tabId"))
        return recordingCall<OffscreenCancelRecordingResult>("recording.cancel", number(params, "tabId")).then((result) =>
          result.success ? { success: true } : result,
        )
    }
  }

  const sendCommand = async (params: JsonObject | undefined): Promise<JsonObject> => {
    const tabId = number(params, "tabId")
    const method = string(params, "method")
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined
    const cdpParams = isJsonObject(params?.params) ? params.params : undefined
    const debuggee = sessionId ? { tabId, sessionId } : { tabId }
    const call = async () => {
      const result = await chrome.debugger.sendCommand(debuggee, method, cdpParams)
      return isJsonObject(result) ? result : {}
    }
    try {
      return await call()
    } catch (error) {
      if (!FOREIGN_FRAME.test(text(error))) throw error
      for (let attempt = 0; attempt < 2; attempt++) {
        log.add("cdp.recover", { tabId, cdp: method, attempt, error: text(error) })
        await evictForeignFrames(tabId)
        await sleep(45)
        if (sessionId === undefined) await reattach(tabId)
        try {
          return await call()
        } catch (retryError) {
          if (!FOREIGN_FRAME.test(text(retryError))) throw retryError
        }
      }
      // The page keeps a frame the debugger cannot get past; navigating without it still works.
      if (sessionId === undefined && method === "Page.navigate" && typeof cdpParams?.url === "string") {
        log.add("cdp.navigateFallback", { tabId })
        await chrome.tabs.update(tabId, { url: cdpParams.url })
        return { frameId: String(tabId) }
      }
      throw error
    }
  }

  /** Re-attaches the relay to a tab whose debugger dropped; true when it is attached again. */
  const reattach = (tabId: number) =>
    DebuggerHub.attach(tabId, OWNER).then(
      () => {
        // A new attachment starts without the relay's focus emulation, which keeps a background tab from throttling.
        void chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined)
        if (!relayTabs.has(tabId)) {
          relayTabs.add(tabId)
          notify()
        }
        return true
      },
      (error: unknown) => {
        log.add("reattach.error", { tabId, error: text(error) })
        return false
      },
    )

  const evictForeignFrames = async (tabId: number) => {
    const result: unknown = await chrome.tabs
      .sendMessage(tabId, { action: "evict-extension-frames" })
      .catch(() => undefined)
    const removed = isJsonObject(result) && typeof result.removed === "number" ? result.removed : 0
    if (removed) log.add("evict", { tabId, removed })
  }

  /**
   * Chrome reports a foreign extension frame taking over as target_closed, the same as a closed tab. While
   * the tab still exists, evict the frame and attach again; the relay then verifies the tab is still usable.
   */
  const recover = async (tabId: number, reason: string) => {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    let kept = false
    if (tab) {
      await evictForeignFrames(tabId)
      await sleep(45)
      kept = await reattach(tabId)
    }
    if (!kept) forget(tabId)
    log.add("debugger.recovered", { tabId, ok: kept })
    // A new attachment starts with no domains enabled: the relay sets the tab up again when it's told so.
    send({ method: "debugger.detached", params: { tabId, reason, ...(kept ? { reattached: true } : {}) } })
  }

  const startRecording = async (params: JsonObject | undefined): Promise<JsonObject> => {
    const tabId = number(params, "tabId")
    await ensureOffscreen()
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }).catch((error: unknown) => {
      const message = text(error)
      throw new Error(
        /invoked|activeTab/i.test(message)
          ? `${message.replace(/\.+$/, "")}. Click the OpenCode Browser toolbar icon on this tab once before recording.`
          : message,
      )
    })
    const result = (await chrome.runtime.sendMessage({
      action: "recording.start",
      tabId,
      streamId,
      frameRate: typeof params?.frameRate === "number" ? params.frameRate : 30,
      videoBitsPerSecond: typeof params?.videoBitsPerSecond === "number" ? params.videoBitsPerSecond : 2_500_000,
      audioBitsPerSecond: typeof params?.audioBitsPerSecond === "number" ? params.audioBitsPerSecond : 128_000,
      audio: params?.audio === true,
    })) as OffscreenStartRecordingResult
    if (!result.success) return { success: false, error: result.error }
    return { success: true, tabId: result.tabId, startedAt: result.startedAt, mimeType: result.mimeType }
  }

  const recordingCall = async <Result>(action: string, tabId: number) =>
    (await chrome.runtime.sendMessage({ action, tabId })) as Result

  const ensureOffscreen = async () => {
    const url = chrome.runtime.getURL("offscreen.html")
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [url],
    })
    if (existing.length) return
    offscreen ??= chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Record tabs for agents with chrome.tabCapture and MediaRecorder",
      })
      .finally(() => {
        offscreen = undefined
      })
    await offscreen
  }

  const sendRecordingChunk = async (data: Uint8Array) => {
    const current = open()
    if (!current) throw new Error("The OpenCode Browser relay is not connected")
    const deadline = Date.now() + 30_000
    while (current.bufferedAmount + data.byteLength > MAX_RECORDING_BUFFER) {
      await sleep(10)
      if (socket !== current || current.readyState !== WebSocket.OPEN)
        throw new Error("The OpenCode Browser relay disconnected while receiving recording data")
      if (Date.now() >= deadline) throw new Error("Timed out sending recording data to the OpenCode Browser relay")
    }
    current.send(new Uint8Array(data))
  }

  /**
   * Puts an agent's tab in its group, by the Grouping setting: the session's group (the default), the window's shared
   * group, or none. A tab already in an agent group of another kind (the setting changed since) stays where it is:
   * new tabs follow the new setting, and tabs aren't moved around under the user.
   */
  const group = async (tabId: number, sessionId: string | undefined, current: WebSocket) => {
    const tab = await chrome.tabs.get(tabId)
    const mode = await AgentGroups.mode()
    const existing = tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE ? undefined : await chrome.tabGroups.get(tab.groupId).catch(() => undefined)
    if (existing && ownedGroup(existing.title) && (mode === "none" || sharedGroup(existing.title) !== (mode === "shared"))) {
      await AgentGroups.adopt(existing.id)
      return existing.id
    }
    if (mode === "none") return chrome.tabGroups.TAB_GROUP_ID_NONE
    if (mode === "shared") return serially(() => groupShared(tabId, current))
    const title = groupTitle(sessionId, tab.url)
    const key = sessionId ?? ""
    await restoreSessionGroups()
    const known = sessionGroups.get(key)
    let target = known === undefined ? undefined : await chrome.tabGroups.get(known).catch(() => undefined)
    // The tab is already in a session group of ours the session has no record of (a worker restart lost it): it is
    // the session's group, so its other tabs join it rather than a new one.
    if ((!target || target.windowId !== tab.windowId) && existing && ownedGroup(existing.title) && !sharedGroup(existing.title)) {
      target = existing
      setSessionGroup(key, existing.id)
    }
    if (target && target.windowId === tab.windowId && ownedGroup(target.title)) {
      if (tab.groupId !== target.id) await chrome.tabs.group({ tabIds: [tabId], groupId: target.id })
      if (target.title !== title) await chrome.tabGroups.update(target.id, { title, color: GROUP_COLOR })
      await AgentGroups.adopt(target.id)
      return target.id
    }
    if (socket !== current) throw new Error("The relay reconnected while grouping the tab")
    const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } })
    // chrome.tabs.group changes the tab before it resolves, so a stale command undoes its anonymous group.
    if (socket !== current) {
      await chrome.tabs.ungroup(tabId).catch(() => undefined)
      throw new Error("The relay reconnected while grouping the tab")
    }
    await chrome.tabGroups.update(groupId, { title, color: GROUP_COLOR })
    setSessionGroup(key, groupId)
    await AgentGroups.adopt(groupId)
    return groupId
  }

  /**
   * The shared group: one per window ("Agents · 3"), for every agent session's tabs, collapsed like a session's group.
   * Run one at a time so concurrent sessions find the group the first one made instead of each making one.
   */
  const groupShared = async (tabId: number, current: WebSocket) => {
    const tab = await chrome.tabs.get(tabId)
    const target = (await chrome.tabGroups.query({ windowId: tab.windowId })).find(
      (item) => item.windowId === tab.windowId && sharedGroup(item.title),
    )
    let groupId = target?.id
    if (groupId !== undefined) {
      if (tab.groupId !== groupId) await chrome.tabs.group({ tabIds: [tabId], groupId })
    } else {
      if (socket !== current) throw new Error("The relay reconnected while grouping the tab")
      groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } })
      if (socket !== current) {
        await chrome.tabs.ungroup(tabId).catch(() => undefined)
        throw new Error("The relay reconnected while grouping the tab")
      }
      await chrome.tabGroups.update(groupId, { title: sharedTitle(1), color: GROUP_COLOR })
    }
    await countShared(groupId)
    await AgentGroups.adopt(groupId)
    return groupId
  }
  let groupQueue: Promise<unknown> = Promise.resolve()
  const serially = <T>(run: () => Promise<T>): Promise<T> => {
    const next = groupQueue.then(run, run)
    groupQueue = next.catch(() => undefined)
    return next
  }

  /** Keeps a shared group's title counting its tabs. */
  const countShared = async (groupId: number) => {
    const item = await chrome.tabGroups.get(groupId).catch(() => undefined)
    if (!item || !sharedGroup(item.title)) return
    const count = (await chrome.tabs.query({ groupId }).catch(() => [])).length
    if (count && item.title !== sharedTitle(count)) await chrome.tabGroups.update(groupId, { title: sharedTitle(count) }).catch(() => undefined)
  }
  let recount: ReturnType<typeof setTimeout> | undefined
  /** Recounts every shared group soon: tabs closed, moved, or left or joined a group. */
  const recountShared = () => {
    clearTimeout(recount)
    recount = setTimeout(() => {
      void chrome.tabGroups.query({}).then(async (groups) => {
        for (const item of groups) if (sharedGroup(item.title)) await countShared(item.id)
      }).catch(() => undefined)
    }, 100)
  }

  /** Auto-named sessions take their group name from the site the agent is on, so it follows navigation. */
  const renameForPage = async (tabId: number, url: string | undefined) => {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!tab || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return
    await restoreSessionGroups()
    const sessionId = Array.from(sessionGroups).find(([, id]) => id === tab.groupId)?.[0]
    if (sessionId === undefined || !autoNamed(sessionId)) return
    const current = await chrome.tabGroups.get(tab.groupId).catch(() => undefined)
    const title = groupTitle(sessionId, url)
    if (current && ownedGroup(current.title) && current.title !== title)
      await chrome.tabGroups.update(current.id, { title }).catch(() => undefined)
  }

  /**
   * The relay is done with a tab. A tab an agent opened closes with its group rather than spilling into the
   * user's tabs; a tab the user lent an agent just leaves the group. With grouping off an agent's tab has no group:
   * it closes when the relay detaches it (`finished`, the toolbar button on it) like a grouped one does. A tab in a
   * group of the user's own is theirs and stays.
   */
  const ungroup = async (tabId: number, options: { finished?: boolean } = {}) => {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!tab) return
    const grouped = tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
    if (!grouped && !options.finished) return
    const current = grouped ? await chrome.tabGroups.get(tab.groupId).catch(() => undefined) : undefined
    if (grouped && !ownedGroup(current?.title)) return
    if (!reloading && (await TabCleanup.isTracked(tabId))) {
      log.add("tab.closed", { tabId, reason: "agent finished with it" })
      await chrome.tabs.remove(tabId).catch(() => undefined)
      return
    }
    if (grouped) await chrome.tabs.ungroup(tabId).catch(() => undefined)
  }

  /**
   * After a restart, relay groups may hold tabs the relay no longer uses. Tabs an agent opened stay in their group
   * (the relay reclaims a named session's tabs, and idle cleanup closes the rest), so a restart never leaves loose
   * agent tabs behind; a tab the user lent an agent goes back to being an ordinary tab.
   */
  const ungroupStale = async () => {
    const groups = (await chrome.tabGroups.query({})).filter((item) => ownedGroup(item.title))
    for (const item of groups)
      for (const tab of await chrome.tabs.query({ groupId: item.id }))
        if (tab.id !== undefined && !relayTabs.has(tab.id) && !(await TabCleanup.isTracked(tab.id)))
          await chrome.tabs.ungroup(tab.id).catch(() => undefined)
  }

  // Listeners live as long as the worker, not a connection, so reconnects never add more.
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined || !relayTabs.has(source.tabId)) return
    send({
      method: "debugger.event",
      params: {
        tabId: source.tabId,
        method,
        params: isJsonObject(params) ? params : {},
        ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
      },
    })
  })
  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId
    if (reloading || tabId === undefined || !relayTabs.has(tabId)) return
    const sessionId = (source as chrome.debugger.DebuggerSession).sessionId
    log.add("debugger.detached", { tabId, reason, sessionId })
    if (sessionId !== undefined) {
      send({ method: "debugger.detached", params: { tabId, reason, sessionId } })
      return
    }
    if (reason === "target_closed") {
      void recover(tabId, reason)
      return
    }
    forget(tabId)
    send({ method: "debugger.detached", params: { tabId, reason } })
  })
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url && relayTabs.has(tabId)) void renameForPage(tabId, change.url)
    if (change.groupId !== undefined) recountShared()
  })
  chrome.tabs.onAttached.addListener(() => recountShared())
  chrome.tabGroups.onRemoved.addListener((removed) => {
    void restoreSessionGroups().then(() => {
      const keys = Array.from(sessionGroups).filter(([, groupId]) => groupId === removed.id).map(([key]) => key)
      if (!keys.length) return
      keys.forEach((key) => sessionGroups.delete(key))
      void chrome.storage.local.set({ [SESSION_GROUPS_KEY]: Object.fromEntries(sessionGroups) }).catch(() => undefined)
    })
  })
  // Group ids don't survive a browser restart.
  chrome.runtime.onStartup.addListener(() => {
    sessionGroups.clear()
    void chrome.storage.local.remove(SESSION_GROUPS_KEY)
  })
  chrome.tabs.onDetached.addListener(() => recountShared())
  // Never close a tab while its agent runs a script on it, waits for the user there, or records it.
  TabCleanup.guard((tabId) => {
    const state = pageStatuses.get(tabId)?.state
    return recordingTabs.has(tabId) || state === "waiting" || state === "running"
  })
  AgentGroups.keepOpenWhile((tabId) => pageStatuses.get(tabId)?.state === "waiting")
  chrome.tabs.onRemoved.addListener((tabId) => {
    recordingTabs.delete(tabId)
    void chrome.runtime.sendMessage({ action: "recording.cancel", tabId }).catch(() => undefined)
    if (relayTabs.has(tabId)) log.add("tab.removed", { tabId })
    forget(tabId)
    pendingAttach.delete(tabId)
    if (badges.delete(tabId)) input.badgesChanged()
    send({ method: "tabs.removed", params: { tabId } })
    recountShared()
  })
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM && !retry) void connect("alarm")
  })
  // The relay-side settings apply as soon as they change; the relay answers with what its environment fixes.
  const sendSettings = async () => {
    if (!open()) return
    const stored = await chrome.storage.local.get([AGENT_CURSOR_KEY, HUMAN_INPUT_KEY])
    const settings: RelaySettings = { cursor: agentCursor(stored[AGENT_CURSOR_KEY]), humanInput: humanInput(stored[HUMAN_INPUT_KEY]) }
    log.add("settings", settings)
    send({ method: "settings", params: settings })
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (AGENT_CURSOR_KEY in changes || HUMAN_INPUT_KEY in changes)) void sendSettings()
  })
  // A code typed on the status page (or removed) takes effect on a fresh connection.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(PAIRING_KEY in changes)) return
    if (adopting !== undefined && changes[PAIRING_KEY]?.newValue === adopting) {
      adopting = undefined
      bundledPairing = undefined
      return
    }
    log.add("pairing.changed")
    bundledPairing = undefined
    attempts = 0
    clearTimeout(retry)
    retry = undefined
    socket?.close(1000, "Pairing changed")
    void connect("pairing")
  })
  /** The active tab of each window and the one before it, to give a window back its tab after an agent popup. */
  const activeTabs = new Map<number, { current: number; previous?: number }>()
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    const entry = activeTabs.get(windowId)
    if (entry?.current !== tabId) activeTabs.set(windowId, { current: tabId, ...(entry ? { previous: entry.current } : {}) })
  })
  chrome.windows.onRemoved.addListener((windowId) => activeTabs.delete(windowId))
  /** The focused window and the one focused before it, to tell whether an agent's popup took focus. */
  const focus: { current?: number; previous?: number; at: number } = { at: 0 }
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE || windowId === focus.current) return
    focus.previous = focus.current
    focus.current = windowId
    focus.at = Date.now()
  })
  void chrome.tabs.query({ active: true }).then((tabs) => {
    for (const tab of tabs) if (tab.id !== undefined && !activeTabs.has(tab.windowId)) activeTabs.set(tab.windowId, { current: tab.id })
  })
  /**
   * A tab an agent's page opened (target=_blank, window.open): it belongs with the agent's tabs. It closes when idle
   * like them and joins the opener's group. If it took over a window's active tab, the user gets their tab back there.
   * It stays in the window it opened in, unless its opener is in the agent window (agent tabs in a separate window):
   * then it moves there. A popup window can't be moved, so it only gives up focus, as does the agent window when the
   * popup's activation focused it. (The opener comes from webNavigation: a tab's openerTabId names the window's active
   * tab, not the background agent tab that clicked the link.)
   */
  const adoptOpened = async (tabId: number, opener: number) => {
    if (!(await TabCleanup.isTracked(opener))) return
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!tab) return
    void chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => undefined)
    const [agentWindow, openerWindow] = await Promise.all([
      AgentWindow.id(),
      chrome.tabs.get(opener).then((openerTab) => openerTab.windowId, () => undefined),
    ])
    const window = await chrome.windows.get(tab.windowId).catch(() => undefined)
    const separate = agentWindow !== undefined && openerWindow === agentWindow
    log.add("tab.opened", { tabId, opener, window: window?.type, agentWindow: tab.windowId === agentWindow, separate })
    // Focus that just moved to the agent window came from the popup, not from the user going there.
    const justFocused = focus.current !== agentWindow || Date.now() - focus.at < 2_000
    if (window?.focused && tab.windowId === agentWindow && justFocused) {
      await chrome.windows.update(tab.windowId, { focused: false }).catch(() => undefined)
    }
    if (window && tab.windowId !== agentWindow) {
      if (window.type === "normal") {
        const entry = activeTabs.get(tab.windowId)
        const previous = entry?.current === tabId ? entry.previous : entry?.current
        if (separate) await chrome.tabs.move(tabId, { windowId: agentWindow, index: -1 }).catch(() => undefined)
        if (tab.active && previous !== undefined && previous !== tabId)
          await chrome.tabs.update(previous, { active: true }).catch(() => undefined)
      } else if (window.focused) {
        await chrome.windows.update(tab.windowId, { focused: false }).catch(() => undefined)
      }
    }
    const [current, openerTab] = await Promise.all([chrome.tabs.get(tabId).catch(() => undefined), chrome.tabs.get(opener).catch(() => undefined)])
    if (
      current &&
      openerTab &&
      openerTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE &&
      openerTab.windowId === current.windowId &&
      current.groupId !== openerTab.groupId
    )
      await chrome.tabs.group({ tabIds: [tabId], groupId: openerTab.groupId }).then(
        () => countShared(openerTab.groupId),
        () => undefined,
      )
    // After the move and grouping, which would otherwise read as the user claiming the tab.
    TabCleanup.track(tabId)
  }
  chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
    void adoptOpened(tabId, sourceTabId)
      .catch((error: unknown) => log.add("tab.opened.error", { error: text(error) }))
      // Once it's moved and grouped: the relay attaches it as a page of the opener's session, so the agent's
      // Playwright sees it (page.waitForEvent("popup"), context.pages()).
      .finally(() => {
        if (relayTabs.has(sourceTabId)) send({ method: "tabs.opened", params: { tabId, openerTabId: sourceTabId } })
      })
  })
  void chrome.alarms.create(ALARM, { periodInMinutes: extensionReconnectAlarmPeriodMs / 60_000 })
  void DebuggerHub.restore()
    .then(async () => {
      DebuggerHub.tabsOwnedBy(OWNER).forEach((tabId) => relayTabs.add(tabId))
      // Tabs the previous worker was opening for an agent when it stopped (never tracked, or tracked but never
      // attached): the relay doesn't know them, so nothing would use them again. Close them.
      const orphans = [
        ...(await TabCleanup.reconcileCreates((tabId) => relayTabs.has(tabId)).catch(() => [])),
        ...(await TabCleanup.closeUnattached((tabId) => relayTabs.has(tabId)).catch(() => [])),
      ]
      log.add("worker.start", { restoredTabs: relayTabs.size, ...(orphans.length ? { closedOrphans: orphans.length } : {}) })
    })
    .then(() => connect("startup"))

  return {
    state: snapshot,
    badge: (tabId: number) => badges.get(tabId),
    /** The user lets agents use this tab, or stops them (the toolbar button); toggles. */
    attachTab(tabId: number) {
      log.add("attach.requested", { tabId, connected: !!open() })
      if (open() && status === "connected") return send({ method: "toolbar.clicked", params: { tabId } })
      // No relay yet: the click is queued until one starts; a second click takes it back.
      if (pendingAttach.delete(tabId)) return
      pendingAttach.add(tabId)
      attempts = 0
      void connect("attach")
    },
    /**
     * Content-script and offscreen messages. Returns undefined when the message isn't for the relay link, true when
     * the answer comes later through sendResponse (keep the channel open), and false when it was handled.
     */
    runtimeMessage(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) {
      if (!isJsonObject(message)) return undefined
      const tabId = sender.tab?.id
      if (message.action === "page-status.ready") {
        if (typeof tabId === "number" && relayTabs.has(tabId)) {
          const page = pageStatuses.get(tabId)
          if (page)
            void chrome.tabs
              .sendMessage(tabId, { action: "page-status.set", status: HandoffNotice.forPage(tabId, page) })
              .catch(() => undefined)
          send({ method: "pageStatus.requested", params: { tabId } })
        }
        return false
      }
      if (message.action === "handoff.complete") {
        if (typeof tabId === "number" && typeof message.handoffId === "string") {
          log.add("handoff.completed", { tabId, from: "page" })
          send({ method: "handoff.completed", params: { tabId, handoffId: message.handoffId } })
        }
        return false
      }
      const offscreenMessage = message as unknown as OffscreenOutgoingMessage
      if (offscreenMessage.action === "recording.chunk") {
        // The recording document waits for this answer before it sends the next chunk.
        void sendRecordingChunk(
          encodeRecordingFrame({
            tabId: offscreenMessage.tabId,
            sequence: offscreenMessage.sequence,
            final: offscreenMessage.final,
            payload: offscreenMessage.final
              ? new Uint8Array()
              : Uint8Array.from(atob(offscreenMessage.dataBase64), (char) => char.charCodeAt(0)),
          }),
        ).then(
          () => sendResponse({ success: true }),
          (error: unknown) => {
            log.add("recording.chunk.error", { tabId: offscreenMessage.tabId, error: text(error) })
            sendResponse({ success: false, error: text(error) })
          },
        )
        return true
      }
      if (offscreenMessage.action === "recording.cancelled") {
        log.add("recording.cancelled", { tabId: offscreenMessage.tabId })
        recordingTabs.delete(offscreenMessage.tabId)
        send({ method: "recording.cancelled", params: { tabId: offscreenMessage.tabId } })
        return false
      }
      return undefined
    },
    /** Stores a pairing code typed on the status page; false when it isn't one. Reconnects through storage.onChanged. */
    async pair(input: string) {
      const code = normalizePairingCode(input)
      if (code === undefined) return false
      await chrome.storage.local.set({ [PAIRING_KEY]: code })
      return true
    },
    /** The status page's update setting; the relay keeps it (an older relay ignores it). */
    setAutoUpdate(mode: AutoUpdateMode) {
      if (!open()) return
      log.add("settings", { autoUpdate: mode })
      send({ method: "settings", params: { autoUpdate: mode } })
    },
    /**
     * A one-time pairing ticket from install (welcome.html#ticket=…). Ignored while this extension works with the relay,
     * so a stray link can't replace a working pairing; false then, or when it isn't a ticket.
     */
    pairTicket(input: string) {
      const value = normalizePairingCode(input)
      if (value === undefined || status === "connected") return false
      ticket = value
      log.add("pairing.ticket.received")
      // A connection in progress (with the old code) closes; the next one carries the ticket.
      socket?.close(1000, "Pairing with a ticket")
      attempts = 0
      clearTimeout(retry)
      retry = undefined
      setTimeout(() => void connect("ticket"), 200)
      return true
    },
    /** Reconnects now, for example after the user fixed what blocked the connection. */
    reconnect() {
      log.add("reconnect.requested")
      bundledPairing = undefined
      attempts = 0
      clearTimeout(retry)
      retry = undefined
      void connect("user")
    },
    /** A plain-text report for bug reports: versions, connection state, tabs, and the recent log. */
    async diagnostics() {
      const entries = await log.entries()
      const manifest = chrome.runtime.getManifest()
      return [
        "OpenCode Browser diagnostics",
        `extension: ${manifest.version} (${chrome.runtime.id})`,
        `browser: ${navigator.userAgent}`,
        `relay: ws://127.0.0.1:${port}/extension, protocol ${extensionProtocolVersion}`,
        `pairing: ${pairing}`,
        `status: ${status}${connectedAt ? ` since ${new Date(connectedAt).toISOString()}` : ""}`,
        `reconnect attempts: ${attempts}${retry ? " (retry scheduled)" : ""}`,
        `cdp commands: ${cdp.count} (${cdp.errors} failed)`,
        `agent tabs: ${
          Array.from(relayTabs, (tabId) => {
            const page = pageStatuses.get(tabId)
            return page ? `${tabId} ${page.state}${page.readOnly ? " read-only" : ""}` : String(tabId)
          }).join(", ") || "none"
        }`,
        `generated: ${new Date().toISOString()}`,
        "",
        `log (last ${entries.length}):`,
        formatAgentRelayLog(entries),
      ].join("\n")
    },
  }
}

declare const __OPENCODE_BROWSER_BUILD__: string

/**
 * JSON for the relay, or undefined when it's larger than the relay accepts (or too large for V8 to serialize at
 * all). Measuring UTF-8 is costly, so it only happens when the text could be over the limit.
 */
function serialize(message: JsonObject) {
  const data = (() => {
    try {
      return JSON.stringify(message)
    } catch {
      return undefined
    }
  })()
  if (data === undefined) return undefined
  // Each UTF-16 unit is 1-3 UTF-8 bytes, so only the window in between needs measuring.
  if (data.length * 3 <= MAX_MESSAGE) return data
  if (data.length > MAX_MESSAGE) return undefined
  return new TextEncoder().encode(data).byteLength <= MAX_MESSAGE ? data : undefined
}

const ATTACHED_TITLE = "OpenCode Browser · Agents can use this tab. Click to stop."

/** How a handoff notification names the agent: its session's chosen name, else "An agent". */
function sessionName(sessionId?: string) {
  return autoNamed(sessionId) ? "An agent" : `Agent “${sessionId!.trim()}”`
}

/** Session ids the relay or MCP server made up (mcp-1a2b3c4d, quiet-falcon-333), rather than an agent's chosen name. */
function autoNamed(sessionId: string | undefined) {
  return !sessionId || /^mcp-[0-9a-f]{6,}$/i.test(sessionId) || /^[a-z]+-[a-z]+-\d{3}$/.test(sessionId)
}

/**
 * The tab group's name: the session's name when an agent chose one ("github"), else "Agent · <site>" for the
 * page it is on, else "Agent". The trailing marker identifies the relay's groups.
 */
function groupTitle(sessionId: string | undefined, url?: string) {
  const host = url && /^https?:/.test(url) ? new URL(url).hostname.replace(/^www\./, "") : undefined
  // Never ending in the marker itself, which would read as the shared group.
  const name = autoNamed(sessionId) ? (host ? `Agent · ${host}` : "Agent") : sessionId!.trim().replace(/\u2063+$/, "")
  return `${name.length > 28 ? `${name.slice(0, 27)}…` : name}${GROUP_MARKER}`
}

function ownedGroup(title: string | undefined) {
  return !!title?.endsWith(GROUP_MARKER)
}

/** The shared group's title: "Agents · 3", for every agent's tabs in its window. */
function sharedTitle(count: number) {
  return `Agents · ${count}${SHARED_MARKER}`
}

function sharedGroup(title: string | undefined) {
  return !!title?.endsWith(SHARED_MARKER)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function text(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function number(params: JsonObject | undefined, key: string) {
  const value = params?.[key]
  if (typeof value !== "number") throw new Error(`Missing number param: ${key}`)
  return value
}

function string(params: JsonObject | undefined, key: string) {
  const value = params?.[key]
  if (typeof value !== "string") throw new Error(`Missing string param: ${key}`)
  return value
}

/** The relay's update state from `relay.settings`, keeping only known fields and values. */
function relayAutoUpdate(input: unknown): RelayAutoUpdate | undefined {
  if (!isJsonObject(input)) return undefined
  const install = input.install === "npm" || input.install === "checkout" ? input.install : "other"
  const mode = autoUpdateMode(input.mode)
  const effective = autoUpdateMode(input.effective)
  if (!mode || !effective) return undefined
  const text = (value: unknown) => (typeof value === "string" && value.length <= 100 ? value : undefined)
  const optional = { overriddenBy: text(input.overriddenBy), version: text(input.version), channel: text(input.channel), latest: text(input.latest), pending: text(input.pending), previous: text(input.previous) }
  return { install, mode, effective, ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)) }
}
