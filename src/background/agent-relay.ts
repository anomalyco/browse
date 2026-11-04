// The link to the Browse relay (ws://127.0.0.1:19988/extension). The relay runs agent sessions
// for the browse MCP server and the opencode-browser CLI (Playwright `execute`, recordings, handoffs) and drives tabs
// through this extension; this module runs its commands. The wire protocol is in ../agent-relay/protocol.ts,
// the relay itself in cli/src/relay.ts.
import { checkoutReloadPrefix, extensionProtocolVersion, unpackedExtensionId } from "../../cli/src/protocol"
import {
  defaultRelayPort,
  encodeRecordingFrame,
  extensionReconnectAlarmPeriodMs,
  isJsonObject,
  type JsonObject,
  type PageStatus,
} from "../agent-relay/protocol"
import type { OffscreenOutgoingMessage } from "../agent-relay/recording-types"
import {
  AGENT_CURSOR_KEY,
  agentCursor,
  HUMAN_INPUT_KEY,
  humanInput,
  RELAY_ADDRESS_KEY,
  relayAddress,
  type AgentRelayState,
  type AgentRelayStatus,
  type AgentRelayUpdate,
  type AutoUpdateMode,
  type RelayAutoUpdate,
  type RelayOverrides,
  type RelaySettings,
} from "../shared/protocol"
import { createAgentRelayLog, formatAgentRelayLog } from "./agent-relay/log"
import { AgentGroups } from "./agent-relay/groups"
import { createRelayCommands } from "./agent-relay/commands"
import { createRelayDebugger } from "./agent-relay/debugger"
import { createRelayGrouping } from "./agent-relay/grouping"
import { createRelayHandshake } from "./agent-relay/handshake"
import {
  ALARM,
  BACKOFF_BASE,
  BACKOFF_CAP,
  CLOSE_CODES,
  CONNECT_TIMEOUT,
  KEEPALIVE,
  OWNER,
  PAIRING_KEY,
  PORT_KEY,
  serialize,
  STABLE_AFTER,
  text,
  TOKENS_KEY,
  type AgentBadge,
} from "./agent-relay/wire"
import { installPopupAdoption } from "./agent-relay/popups"
import { createRelayRecording } from "./agent-relay/recording"
import { DebuggerHub } from "./debugger-hub"
import { HandoffNotice } from "./handoff-notice"
import { TabCleanup } from "./tab-cleanup"

export { PAIRING_KEY, TOKENS_KEY, type AgentBadge }

declare const __OPENCODE_BROWSER_BUILD__: string

export function createAgentRelay(input: { changed: (state: AgentRelayState) => void; badgesChanged: () => void }) {
  const log = createAgentRelayLog()
  let socket: WebSocket | undefined
  let starting: Promise<void> | undefined
  let generation = 0
  let status: AgentRelayStatus = "offline"
  let host = "127.0.0.1"
  let port = defaultRelayPort
  let attempts = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  let keepalive: ReturnType<typeof setInterval> | undefined
  let connectedAt: number | undefined
  const cdp = { count: 0, errors: 0 }
  const relayTabs = new Set<number>()
  let reloading = false
  /** Tabs with a recording in progress; cleanup leaves them open. */
  const recordingTabs = new Set<number>()
  const pageStatuses = new Map<number, PageStatus>()
  const badges = new Map<number, AgentBadge>()
  /** Tabs the user let agents use while the relay was not connected; announced once it is. */
  const pendingAttach = new Set<number>()
  let update: AgentRelayUpdate | undefined
  /** Settings the connected relay's environment fixes, as it reported them (`relay.settings`). */
  let overrides: RelayOverrides | undefined
  /** What the connected relay calls this browser (`relay.settings`): agents name it by `id`. */
  let browser: { id: string; name: string } | undefined
  /** The connected relay's update state (`relay.settings`). */
  let autoUpdate: RelayAutoUpdate | undefined

  const reload = () => {
    if (reloading) return
    // Preserve attached tabs for the next worker, and allow a paired RPC to send its reply first.
    reloading = true
    DebuggerHub.freeze()
    setTimeout(() => {
      socket?.close(1000, "Extension reloading")
      chrome.runtime.reload()
    }, 50)
  }

  // The socket was refused, not trusted. Only reload files already installed in *our own* folder,
  // and only once per target (also if a broken build never picks up the new worker).
  const reloadCheckout = async (reason: string, mine: number) => {
    if (chrome.runtime.id !== unpackedExtensionId || !reason.startsWith(checkoutReloadPrefix)) return
    const build = reason.slice(checkoutReloadPrefix.length)
    if (!(Date.parse(build) > Date.parse(__OPENCODE_BROWSER_BUILD__))) return
    const file = await fetch(chrome.runtime.getURL("build.json"), { cache: "no-store" })
    if (!file.ok || (await file.json()).build !== build) return
    const key = "agentRelayReloadBuild"
    if ((await chrome.storage.local.get(key))[key] === build || generation !== mine) return
    await chrome.storage.local.set({ [key]: build })
    if (generation === mine) reload()
  }

  const snapshot = (): AgentRelayState => {
    const { pairing, skew, codeRejected, unpacked } = handshake.pairingState()
    return {
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
      ...(codeRejected ? { codeRejected: true } : {}),
      ...(unpacked ? { unpacked: true } : {}),
      ...(browser && status === "connected" ? { browser } : {}),
      relay: { address: `${host === "127.0.0.1" ? "localhost" : host}:${port}`, remote: host !== "127.0.0.1" },
    }
  }

  const notify = () => input.changed(snapshot())
  const setStatus = (next: AgentRelayStatus) => {
    if (status === next) return
    log.add("status", { from: status, to: next })
    status = next
    notify()
  }

  /** The connection, once its relay has paired; events and data never go to an unpaired one. */
  const open = () => (socket?.readyState === WebSocket.OPEN && handshake.trusted.has(socket) ? socket : undefined)
  const send = (message: JsonObject) => {
    const data = serialize(message)
    // The relay drops a connection that sends more than it accepts; a lost event is better than a reconnect loop.
    if (data === undefined) return log.add("event.dropped", { method: String(message.method) })
    open()?.send(data)
  }

  const forget = (tabId: number) => {
    const known = relayTabs.delete(tabId)
    pageStatuses.delete(tabId)
    void HandoffNotice.clear(tabId)
    if (known) notify()
  }

  // The relay-side settings apply as soon as they change; the relay answers with what its environment fixes.
  const sendSettings = async () => {
    if (!open()) return
    const stored = await chrome.storage.local.get([AGENT_CURSOR_KEY, HUMAN_INPUT_KEY])
    const settings: RelaySettings = {
      cursor: agentCursor(stored[AGENT_CURSOR_KEY]),
      humanInput: humanInput(stored[HUMAN_INPUT_KEY]),
    }
    log.add("settings", settings)
    send({ method: "settings", params: settings })
  }

  const grouping = createRelayGrouping({
    log,
    relayTabs,
    currentSocket: () => socket,
    isReloading: () => reloading,
  })

  const debuggerOps = createRelayDebugger({
    log,
    relayTabs,
    notify,
    forget,
    send,
  })

  const recording = createRelayRecording({
    open,
    currentSocket: () => socket,
  })

  const resetAndConnect = (reason: string, closeReason?: string) => {
    attempts = 0
    clearTimeout(retry)
    retry = undefined
    if (closeReason !== undefined) socket?.close(1000, closeReason)
    void connect(reason)
  }

  const handshake = createRelayHandshake({
    log,
    relayTabs,
    currentSocket: () => socket,
    hostPort: () => ({ host, port }),
    status: () => status,
    snapshot,
    generation: () => generation,
    notify,
    resetAndConnect,
    onAuthenticated: (current, skew) => {
      // The status page's relay-side settings; an older relay ignores the event and keeps its defaults.
      void sendSettings()
      clearInterval(keepalive)
      keepalive = setInterval(() => {
        if (socket === current) send({ method: "pong" })
      }, KEEPALIVE)
      connectedAt = Date.now()
      setStatus(skew ? "incompatible" : "connected")
      // Only the newest connection gets this far (verify checks socket === current).
      handshake.settle(generation)
      pendingAttach.forEach((tabId) => send({ method: "toolbar.clicked", params: { tabId } }))
      pendingAttach.clear()
      void grouping.ungroupStale().catch((error: unknown) => log.add("ungroupStale.error", { error: text(error) }))
    },
  })

  const commands = createRelayCommands({
    log,
    cdp,
    relayTabs,
    recordingTabs,
    pageStatuses,
    badges,
    currentSocket: () => socket,
    notify,
    badgesChanged: input.badgesChanged,
    forget,
    reload,
    setRelayInfo: (info) => {
      overrides = info.overrides
      autoUpdate = info.autoUpdate
      browser = info.browser
    },
    setUpdateNotice: (notice) => {
      update = notice
    },
    sendCommand: debuggerOps.sendCommand,
    group: grouping.group,
    ungroup: grouping.ungroup,
    startRecording: recording.startRecording,
    recordingCall: recording.recordingCall,
  })

  const connect = (reason: string) => {
    starting ??= start(reason).finally(() => {
      starting = undefined
    })
    return starting
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

  const start = async (reason: string) => {
    if (socket && socket.readyState <= WebSocket.OPEN) return
    clearTimeout(retry)
    retry = undefined
    const stored = await chrome.storage.local.get([PORT_KEY, RELAY_ADDRESS_KEY])
    // A relay on another computer (the status page's relay address), else this one; an unusable value reads as unset.
    const address = relayAddress(stored[RELAY_ADDRESS_KEY]) ?? { host: "127.0.0.1" }
    const previous = `${host}:${port}`
    host = address.host
    port = address.port ?? (Number(stored[PORT_KEY]) || defaultRelayPort)
    if (`${host}:${port}` !== previous) notify()
    if (socket && socket.readyState <= WebSocket.OPEN) return
    // Without a credential announce only the protocol and that pairing is needed. No identity, tabs or
    // commands on this socket. A sleeping worker repeats this presence on the regular reconnect alarm.
    const presenceOnly = (await handshake.credential()) === undefined
    if (presenceOnly) {
      if (status !== "unpaired") log.add("pairing.missing")
      setStatus("unpaired")
    }
    if (socket && socket.readyState <= WebSocket.OPEN) return
    const url = `ws://${host}:${port}/extension`
    const mine = ++generation
    // While no relay runs, attempts repeat until one starts; log the first ones of a streak, not every poll.
    const quiet = status === "offline" && attempts > 1
    if (!quiet) log.add("connect", { host, port, attempt: attempts, reason, generation: mine })
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
      // Older relays require hello first. Detect them before either side tries an incompatible code exchange.
      current.send(
        JSON.stringify({
          method: "protocol",
          params: { protocolVersion: extensionProtocolVersion, ...(presenceOnly ? { unpaired: true } : {}) },
        }),
      )
      if (presenceOnly) {
        setTimeout(() => {
          if (current.readyState === WebSocket.OPEN) current.close(1000, "Presence sent")
        }, CONNECT_TIMEOUT)
        return
      }
      void handshake.hello(current).catch((error: unknown) => {
        log.add("hello.error", { error: text(error) })
        current.close(1011, "Handshake failed")
      })
    }
    current.onmessage = (event) => {
      if (presenceOnly || typeof event.data !== "string") return
      if (handshake.trusted.has(current)) void commands.handle(current, event.data)
      else
        void handshake.verify(current, event.data).catch((error: unknown) => {
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
      if (!quiet || openedAt !== undefined)
        log.add("close", {
          code: event.code,
          meaning: CLOSE_CODES[event.code],
          reason: event.reason || undefined,
          clean: event.wasClean,
          opened: openedAt !== undefined,
          ms: lasted,
        })
      if (!presenceOnly) void chrome.runtime.sendMessage({ action: "recording.cancelAll" }).catch(() => undefined)
      overrides = undefined
      autoUpdate = undefined
      browser = undefined
      // Only a refusal (4006) during pairing counts; a relay that wasn't there yet gets the same try next time.
      handshake.onCloseRefusal(current, event.code)
      if (event.code === 4002 && event.reason === "Extension hello required") {
        handshake.setSkew("update-cli")
        setStatus("incompatible")
      } else if (event.code === 4003) {
        // A newer relay names the side that's behind: "Extension protocol incompatible: extension-newer".
        handshake.setSkew(
          /extension-newer/.test(event.reason)
            ? "update-cli"
            : /extension-older/.test(event.reason)
              ? "update-extension"
              : undefined,
        )
        setStatus("incompatible")
        if (!handshake.trusted.has(current) && new URL(current.url).hostname === "127.0.0.1")
          void reloadCheckout(event.reason, mine).catch(() => {
            /* Missing or incomplete build: keep the manual step. */
          })
      } else if (presenceOnly) setStatus("unpaired")
      else if (event.code === 4004) setStatus("conflict")
      else if (event.code === 4006) setStatus("untrusted")
      // A missing relay is normal until an agent's browse tools (or the opencode-browser CLI) start one.
      else setStatus(openedAt === undefined ? "offline" : "connecting")
      handshake.settle(mine)
      if (!presenceOnly) schedule(quiet && openedAt === undefined)
    }
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
      void debuggerOps.recover(tabId, reason)
      return
    }
    forget(tabId)
    send({ method: "debugger.detached", params: { tabId, reason } })
  })
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url && relayTabs.has(tabId)) void grouping.renameForPage(tabId, change.url)
    if (change.groupId !== undefined) grouping.recountShared()
  })
  chrome.tabs.onAttached.addListener(() => grouping.recountShared())
  chrome.tabGroups.onRemoved.addListener(grouping.onGroupRemoved)
  // Group ids don't survive a browser restart.
  chrome.runtime.onStartup.addListener(grouping.onBrowserStartup)
  chrome.tabs.onDetached.addListener(() => grouping.recountShared())
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
    grouping.recountShared()
  })
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM && !retry) void connect("alarm")
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (AGENT_CURSOR_KEY in changes || HUMAN_INPUT_KEY in changes)) void sendSettings()
  })
  // A code entered on the status page, a new relay address or a new name takes effect on a fresh connection.
  chrome.storage.onChanged.addListener(handshake.onPairingStorageChanged)
  installPopupAdoption({
    log,
    relayTabs,
    send,
    countShared: grouping.countShared,
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
        void recording
          .sendRecordingChunk(
            encodeRecordingFrame({
              tabId: offscreenMessage.tabId,
              sequence: offscreenMessage.sequence,
              final: offscreenMessage.final,
              payload: offscreenMessage.final
                ? new Uint8Array()
                : Uint8Array.from(atob(offscreenMessage.dataBase64), (char) => char.charCodeAt(0)),
            }),
          )
          .then(
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
    /**
     * The status page's Connection form: saves the relay address (empty, localhost or 127.0.0.1: this computer) and the
     * pairing code when one is given, connects afresh (even with nothing changed, so the page can check the pairing)
     * and resolves with how the attempt ended, or with the current status if it takes longer than an attempt can.
     */
    connectTo: handshake.connectTo,
    /** The status page's update setting; the relay keeps it (an older relay ignores it). */
    setAutoUpdate(mode: AutoUpdateMode) {
      if (!open()) return
      log.add("settings", { autoUpdate: mode })
      send({ method: "settings", params: { autoUpdate: mode } })
    },
    /**
     * A one-time code from install's link (welcome.html#code=…). Ignored while this extension works with the relay, so
     * a stray link can't replace a working pairing; false then, or when it isn't a code.
     */
    pairLink: handshake.pairLink,
    /** Reconnects now, for example after the user fixed what blocked the connection. */
    reconnect: handshake.reconnect,
    /** A plain-text report for bug reports: versions, connection state, tabs, and the recent log. */
    async diagnostics() {
      const entries = await log.entries()
      const manifest = chrome.runtime.getManifest()
      const { pairing } = handshake.pairingState()
      return [
        "Browse diagnostics",
        `extension: ${manifest.version} (${chrome.runtime.id})`,
        `browser: ${navigator.userAgent}`,
        `relay: ws://${host}:${port}/extension, protocol ${extensionProtocolVersion}`,
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
