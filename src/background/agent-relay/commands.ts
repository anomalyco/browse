import {
  isJsonObject,
  pageStatusFromJson,
  parseExtensionCommand,
  type ExtensionCommand,
  type JsonObject,
  type PageStatus,
} from "../../agent-relay/protocol"
import type {
  OffscreenCancelRecordingResult,
  OffscreenStatusRecordingResult,
  OffscreenStopRecordingResult,
} from "../../agent-relay/recording-types"
import type { AgentRelayUpdate, RelayAutoUpdate, RelayOverrides } from "../../shared/protocol"
import { AgentGroups } from "./groups"
import { AgentWindow } from "./window"
import { DebuggerHub } from "../debugger-hub"
import { HandoffNotice } from "../handoff-notice"
import { PageScripts } from "../page-scripts"
import { TabCleanup } from "../tab-cleanup"
import { UserSettings } from "../user-settings"
import {
  ATTACHED_TITLE,
  MAX_MESSAGE,
  number,
  OWNER,
  relayAutoUpdate,
  serialize,
  sessionName,
  SLOW_CDP,
  text,
  type AgentBadge,
  type AgentRelayLog,
} from "./wire"

export function createRelayCommands(deps: {
  readonly log: AgentRelayLog
  readonly cdp: { count: number; errors: number }
  readonly relayTabs: Set<number>
  readonly recordingTabs: Set<number>
  readonly pageStatuses: Map<number, PageStatus>
  readonly badges: Map<number, AgentBadge>
  readonly currentSocket: () => WebSocket | undefined
  readonly notify: () => void
  readonly badgesChanged: () => void
  readonly forget: (tabId: number) => void
  readonly reload: () => void
  readonly setRelayInfo: (info: {
    readonly overrides: RelayOverrides | undefined
    readonly autoUpdate: RelayAutoUpdate | undefined
    readonly browser: { id: string; name: string } | undefined
  }) => void
  readonly setUpdateNotice: (notice: AgentRelayUpdate | undefined) => void
  readonly sendCommand: (params: JsonObject | undefined) => Promise<JsonObject>
  readonly group: (tabId: number, sessionId: string | undefined, current: WebSocket) => Promise<number>
  readonly ungroup: (tabId: number, options?: { finished?: boolean }) => Promise<void>
  readonly startRecording: (params: JsonObject | undefined) => Promise<JsonObject>
  readonly recordingCall: <Result>(action: string, tabId: number) => Promise<Result>
}) {
  /** Each tab's page status deliveries, in order (see deliverPageStatus). */
  const pageDeliveries = new Map<number, Promise<void>>()

  /**
   * Brings the tab's page (and its handoff notification) up to date with its latest status. Deliveries run one at a
   * time per tab and each sends whatever is latest when its turn comes: they await notifications and messaging, and
   * when they ran side by side an earlier "running" could reach the page after the "waiting" that followed it, which
   * removed the handoff card (about one handoff in ten with eight agents busy) and left the agent waiting for a
   * Continue nobody could see.
   */
  const deliverPageStatus = (tabId: number): Promise<void> => {
    const run = (pageDeliveries.get(tabId) ?? Promise.resolve()).then(async () => {
      const page = deps.pageStatuses.get(tabId)
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
      if (deps.pageStatuses.get(tabId) !== page) return
      await PageScripts.send(tabId, { action: "page-status.set", status: HandoffNotice.forPage(tabId, page) })
    })
    const settled = run.catch(() => undefined)
    pageDeliveries.set(tabId, settled)
    void settled.then(() => {
      if (pageDeliveries.get(tabId) === settled) pageDeliveries.delete(tabId)
    })
    return run
  }

  const run = async (command: ExtensionCommand, current: WebSocket): Promise<JsonObject> => {
    const params = command.params
    switch (command.method) {
      case "ping":
        // Invoking an extension API resets Chromium's 30 s MV3 service worker idle timer.
        if (typeof chrome.runtime.getPlatformInfo === "function") {
          await chrome.runtime.getPlatformInfo().catch(() => undefined)
        }
        return {}
      case "debugger.attach": {
        const tabId = number(params, "tabId")
        TabCleanup.touch(tabId)
        await DebuggerHub.attach(tabId, OWNER)
        deps.relayTabs.add(tabId)
        deps.notify()
        return {}
      }
      case "debugger.detach": {
        const tabId = number(params, "tabId")
        deps.forget(tabId)
        await DebuggerHub.detach(tabId, OWNER)
        await deps.ungroup(tabId, { finished: true })
        return {}
      }
      case "debugger.sendCommand":
        TabCleanup.touch(number(params, "tabId"))
        return deps.sendCommand(params)
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
          groupId: await deps.group(
            number(params, "tabId"),
            typeof params?.sessionId === "string" ? params.sessionId : undefined,
            current,
          ),
        }
      case "tabs.ungroup":
        await deps.ungroup(number(params, "tabId"))
        return {}
      case "action.setAttached": {
        const tabId = number(params, "tabId")
        if (params?.attached === true) deps.badges.set(tabId, { text: "ON", title: ATTACHED_TITLE })
        if (params?.attached !== true) deps.badges.delete(tabId)
        deps.badgesChanged()
        return {}
      }
      case "action.setBadge": {
        const tabId = number(params, "tabId")
        const value = typeof params?.text === "string" ? params.text : ""
        if (!value) deps.badges.delete(tabId)
        // "ON" keeps our title, which says the toolbar button stops agents.
        if (value)
          deps.badges.set(tabId, {
            text: value,
            ...(value === "ON"
              ? { title: ATTACHED_TITLE }
              : typeof params?.title === "string"
                ? { title: params.title }
                : {}),
          })
        deps.badgesChanged()
        return {}
      }
      case "pageStatus.set": {
        const tabId = number(params, "tabId")
        const page = pageStatusFromJson(params?.status)
        if (!page) throw new Error("Invalid page status")
        const wasWaiting = deps.pageStatuses.get(tabId)?.state === "waiting"
        deps.pageStatuses.set(tabId, page)
        // An execute starting or ending counts as use, so idle time runs from the end of the last one.
        TabCleanup.touch(tabId)
        deps.notify()
        // A handoff opens the agent's group so the user can find the tab; it folds up again afterwards.
        if (page.state === "waiting") void AgentGroups.expandTab(tabId)
        else if (wasWaiting) void AgentGroups.settleTab(tabId)
        await deliverPageStatus(tabId)
        return {}
      }
      case "pageStatus.clear": {
        const tabId = number(params, "tabId")
        const wasWaiting = deps.pageStatuses.get(tabId)?.state === "waiting"
        deps.pageStatuses.delete(tabId)
        if (wasWaiting) void AgentGroups.settleTab(tabId)
        deps.notify()
        await deliverPageStatus(tabId)
        return {}
      }
      case "runtime.reload":
        deps.log.add("runtime.reload")
        deps.reload()
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
          ...(fixed.agentWindow === "current" || fixed.agentWindow === "separate"
            ? { agentWindow: fixed.agentWindow }
            : {}),
          ...(fixed.cursor === "off" || fixed.cursor === "always" ? { cursor: fixed.cursor } : {}),
          ...(fixed.humanInput === "on" || fixed.humanInput === "off" ? { humanInput: fixed.humanInput } : {}),
        }
        const named = isJsonObject(params?.browser) ? params.browser : undefined
        deps.setRelayInfo({
          overrides: Object.keys(next).length ? next : undefined,
          autoUpdate: relayAutoUpdate(params?.autoUpdate),
          browser:
            typeof named?.id === "string" && typeof named.name === "string"
              ? { id: named.id, name: named.name }
              : undefined,
        })
        deps.notify()
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
        deps.setUpdateNotice(summary && command ? { summary, command } : undefined)
        deps.notify()
        return {}
      }
      case "recording.start": {
        const result = await deps.startRecording(params)
        if (result.success === true) deps.recordingTabs.add(number(params, "tabId"))
        return result
      }
      case "recording.stop":
        deps.recordingTabs.delete(number(params, "tabId"))
        return deps.recordingCall<OffscreenStopRecordingResult>("recording.stop", number(params, "tabId")).then((result) =>
          result.success ? { success: true, tabId: result.tabId, duration: result.duration } : result,
        )
      case "recording.status": {
        const tabId = number(params, "tabId")
        const result = await deps.recordingCall<OffscreenStatusRecordingResult>("recording.status", tabId)
        return {
          isRecording: result.isRecording,
          tabId,
          ...(result.startedAt === undefined ? {} : { startedAt: result.startedAt }),
        }
      }
      case "recording.cancel":
        deps.recordingTabs.delete(number(params, "tabId"))
        return deps.recordingCall<OffscreenCancelRecordingResult>("recording.cancel", number(params, "tabId")).then((result) =>
          result.success ? { success: true } : result,
        )
    }
  }

  const handle = async (current: WebSocket, data: string) => {
    const command = (() => {
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
        return parseExtensionCommand(parsed)
      } catch (error) {
        deps.log.add("command.invalid", { error: text(error), data: data.slice(0, 200) })
        current.send(JSON.stringify({ method: "log", params: { level: "error", message: text(error) } }))
        // A command this build doesn't know (an older or newer relay) still gets an answer, so the relay
        // doesn't wait for its timeout.
        if (isJsonObject(parsed) && typeof parsed.id === "number") {
          current.send(JSON.stringify({ id: parsed.id, error: text(error) }))
        }
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
      deps.cdp.count++
      if (failed) deps.cdp.errors++
    }
    if ((command.method !== "ping" && cdpMethod === undefined) || failed || ms >= SLOW_CDP)
      deps.log.add("command", {
        method: command.method,
        cdp: typeof cdpMethod === "string" ? cdpMethod : undefined,
        id: command.id,
        tabId: typeof command.params?.tabId === "number" ? command.params.tabId : undefined,
        ms,
        ok: !failed,
        error: failed ? reply.error : undefined,
      })
    if (deps.currentSocket() !== current || current.readyState !== WebSocket.OPEN) return
    // A result larger than the relay accepts (a huge screenshot or response body) fails that one command instead of
    // closing the connection, which would fail every command in flight and make the relay reconnect.
    const serialized = serialize(reply)
    if (serialized === undefined) {
      deps.log.add("command.tooLarge", { method: command.method, id: command.id })
      current.send(
        JSON.stringify({
          id: command.id,
          error: `Result too large to send (the limit is ${Math.floor(MAX_MESSAGE / 1048576)} MB). Request less data, for example a viewport screenshot instead of a full page.`,
        }),
      )
      return
    }
    current.send(serialized)
  }

  return { handle }
}
