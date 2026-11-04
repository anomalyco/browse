import { isJsonObject, type JsonObject } from "../../agent-relay/protocol"
import { DebuggerHub } from "../debugger-hub"
import { FOREIGN_FRAME, number, OWNER, sleep, string, text, type AgentRelayLog } from "./wire"

export function createRelayDebugger(deps: {
  readonly log: AgentRelayLog
  readonly relayTabs: Set<number>
  readonly notify: () => void
  readonly forget: (tabId: number) => void
  readonly send: (message: JsonObject) => void
}) {
  /** Re-attaches the relay to a tab whose debugger dropped; true when it is attached again. */
  const reattach = (tabId: number) =>
    DebuggerHub.attach(tabId, OWNER).then(
      () => {
        // A new attachment starts without the relay's focus emulation, which keeps a background tab from throttling.
        void chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined)
        if (!deps.relayTabs.has(tabId)) {
          deps.relayTabs.add(tabId)
          deps.notify()
        }
        return true
      },
      (error: unknown) => {
        deps.log.add("reattach.error", { tabId, error: text(error) })
        return false
      },
    )

  const evictForeignFrames = async (tabId: number) => {
    const result: unknown = await chrome.tabs
      .sendMessage(tabId, { action: "evict-extension-frames" })
      .catch(() => undefined)
    const removed = isJsonObject(result) && typeof result.removed === "number" ? result.removed : 0
    if (removed) deps.log.add("evict", { tabId, removed })
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
        deps.log.add("cdp.recover", { tabId, cdp: method, attempt, error: text(error) })
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
        deps.log.add("cdp.navigateFallback", { tabId })
        await chrome.tabs.update(tabId, { url: cdpParams.url })
        return { frameId: String(tabId) }
      }
      throw error
    }
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
    if (!kept) deps.forget(tabId)
    deps.log.add("debugger.recovered", { tabId, ok: kept })
    // A new attachment starts with no domains enabled: the relay sets the tab up again when it's told so.
    deps.send({ method: "debugger.detached", params: { tabId, reason, ...(kept ? { reattached: true } : {}) } })
  }

  return { sendCommand, reattach, evictForeignFrames, recover }
}
