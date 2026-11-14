import { Data } from "effect"
import type { CdpEvent, JsonObject } from "../protocol.ts"
import type { ChildTarget, ConnectedTarget } from "../relay/types.ts"

type ClientCdpSessionAlias = Data.TaggedEnum<{
  Browser: {}
  Target: { readonly tabId: number; readonly targetId: string; readonly chromeSessionId?: string }
}>
export const ClientCdpSessionAlias = Data.taggedEnum<ClientCdpSessionAlias>()

type AnnouncedTarget = {
  readonly tabId: number
  readonly targetId: string
  readonly sessionId: string
  readonly parentSessionId?: string
}

type CdpClientState = {
  readonly aliases: Map<string, ClientCdpSessionAlias>
  readonly announcements: Map<string, AnnouncedTarget>
  readonly opencodeBrowserSessionId?: string
  readonly kind: "raw" | "sandbox"
  autoAttachParams?: JsonObject
}

export class CdpClientPool<Client extends object> implements Iterable<Client> {
  private readonly states = new Map<Client, CdpClientState>()
  /** Per tab, the clients that enabled Fetch on its root or a child session, keyed by routed session. */
  private readonly interceptionOwners = new Map<number, Map<string | undefined, Set<Client>>>()
  private nextAliasId = 1
  private connectionGeneration = 0

  constructor(
    private readonly send: (client: Client, event: CdpEvent) => void,
    /** Observe every canonical session this client stops seeing, announced or silent. */
    private readonly retired: (client: Client, sessionId: string) => void,
    /** A tab's last Fetch-interception owner went away and no client can answer its paused requests any more. */
    private readonly onInterceptionEmpty: (tabId: number) => void = () => {},
  ) {}

  register(client: Client, opencodeBrowserSessionId?: string, kind: "raw" | "sandbox" = "raw"): void {
    if (this.states.has(client)) throw new Error("CDP client is already registered")
    this.states.set(client, {
      aliases: new Map(),
      announcements: new Map(),
      kind: opencodeBrowserSessionId ? kind : "raw",
      ...(opencodeBrowserSessionId ? { opencodeBrowserSessionId } : {}),
    })
    this.connectionGeneration += 1
  }

  unregister(client: Client): number | undefined {
    const registered = this.states.delete(client)
    this.dropClientInterceptions(client)
    if (!registered || this.states.size !== 0) return undefined
    return ++this.connectionGeneration
  }

  /** Records a client that enabled Fetch on the tab's root (`sessionId` undefined) or a child session. */
  markInterceptionOwner(client: Client, tabId: number, sessionId?: string): void {
    if (!this.states.has(client)) return
    const sessions = this.interceptionOwners.get(tabId) ?? new Map<string | undefined, Set<Client>>()
    const owners = sessions.get(sessionId) ?? new Set<Client>()
    owners.add(client)
    sessions.set(sessionId, owners)
    this.interceptionOwners.set(tabId, sessions)
  }

  /** Whether a client still owns the tab's Fetch interception on this routed session. */
  hasInterceptionOwner(tabId: number, sessionId?: string): boolean {
    return (this.interceptionOwners.get(tabId)?.get(sessionId)?.size ?? 0) > 0
  }

  /** Whether any client still owns Fetch interception on any session of the tab. */
  hasInterceptionOwners(tabId: number): boolean {
    const sessions = this.interceptionOwners.get(tabId)
    if (!sessions) return false
    for (const owners of sessions.values()) if (owners.size > 0) return true
    return false
  }

  /**
   * Drops a client's ownership of one routed session after it forwarded Fetch.disable. `releaseTab` is false there:
   * the disable itself is the release, and a tab-wide release would send it again for the session.
   */
  clearInterceptionOwner(client: Client, tabId: number, sessionId: string | undefined, releaseTab = true): void {
    const sessions = this.interceptionOwners.get(tabId)
    const owners = sessions?.get(sessionId)
    if (!sessions || !owners?.delete(client)) return
    if (owners.size === 0) sessions.delete(sessionId)
    if (sessions.size > 0) return
    if (releaseTab) this.dropInterceptionTab(tabId)
    else this.interceptionOwners.delete(tabId)
  }

  get size(): number {
    return this.states.size
  }

  has(client: Client): boolean {
    return this.states.has(client)
  }

  [Symbol.iterator](): IterableIterator<Client> {
    return this.states.keys()
  }

  sessionId(client: Client): string | undefined {
    return this.states.get(client)?.opencodeBrowserSessionId
  }

  isSandbox(client: Client): boolean {
    return this.states.get(client)?.kind === "sandbox"
  }

  hasSession(client: Client, sessionId: string): boolean {
    return this.states.get(client)?.announcements.has(sessionId) ?? false
  }

  announce(client: Client, target: ConnectedTarget | ChildTarget): void {
    const state = this.requireState(client)
    const targetId = target.targetInfo.targetId
    const existing = Array.from(state.announcements.values()).find((entry) => entry.targetId === targetId)
    if (existing?.sessionId === target.sessionId) return
    if (existing) this.detachSession(client, state, existing.sessionId)
    this.detachSession(client, state, target.sessionId)
    const parent = "parentSessionId" in target ? { parentSessionId: target.parentSessionId } : {}
    state.announcements.set(target.sessionId, { tabId: target.tabId, targetId, sessionId: target.sessionId, ...parent })
    this.send(client, {
      ...(parent.parentSessionId === undefined ? {} : { sessionId: parent.parentSessionId }),
      method: "Target.attachedToTarget",
      params: {
        sessionId: target.sessionId,
        targetInfo: { ...target.targetInfo, attached: true },
        waitingForDebugger: "waitingForDebugger" in target ? target.waitingForDebugger : false,
      },
    })
  }

  detach(client: Client, sessionId: string): void {
    const state = this.requireState(client)
    if (state.aliases.delete(sessionId)) return
    this.detachSession(client, state, sessionId, { notify: false })
  }

  detachTab(tabId: number, options: { readonly destroyed?: boolean } = {}): void {
    for (const [client, state] of this.states) {
      this.removeTargetAliases(state, (alias) => alias.tabId === tabId)
      for (const announced of state.announcements.values()) {
        if (announced.tabId === tabId) this.detachSession(client, state, announced.sessionId, options)
      }
    }
    this.dropInterceptionTab(tabId)
  }

  detachTarget(target: ChildTarget, options: { readonly notify?: boolean } = {}): void {
    for (const [client, state] of this.states) {
      this.removeTargetAliases(state, (alias) => alias.targetId === target.targetInfo.targetId)
      this.detachSession(client, state, target.sessionId, options)
    }
    this.dropInterceptionSession(target.tabId, target.sessionId)
  }

  pruneInvisible(client: Client, canSeeTab: (tabId: number) => boolean): void {
    const state = this.requireState(client)
    this.removeTargetAliases(state, (alias) => !canSeeTab(alias.tabId))
    for (const announced of state.announcements.values()) {
      if (!canSeeTab(announced.tabId)) this.detachSession(client, state, announced.sessionId)
    }
  }

  sendToViewers(rootSessionId: string, event: CdpEvent, canSeeTab: (client: Client, tabId: number) => boolean): void {
    for (const [client, state] of this.states) {
      const announced = state.announcements.get(rootSessionId)
      if (!announced) continue
      if (!canSeeTab(client, announced.tabId)) {
        this.pruneInvisible(client, (tabId) => canSeeTab(client, tabId))
        continue
      }
      this.send(client, event)
    }
  }

  setAutoAttachParams(client: Client, params: JsonObject | undefined): void {
    const state = this.requireState(client)
    if (params === undefined) delete state.autoAttachParams
    else state.autoAttachParams = params
  }

  autoAttachParams(client: Client): JsonObject | undefined {
    return this.states.get(client)?.autoAttachParams
  }

  isCurrentIdleGeneration(generation: number): boolean {
    return this.states.size === 0 && this.connectionGeneration === generation
  }

  createBrowserAlias(client: Client): string {
    const aliasId = this.nextAlias("browser")
    this.requireState(client).aliases.set(aliasId, ClientCdpSessionAlias.Browser())
    return aliasId
  }

  createTargetAlias(client: Client, target: ConnectedTarget | ChildTarget): string {
    const aliasId = this.nextAlias("session")
    this.requireState(client).aliases.set(aliasId, ClientCdpSessionAlias.Target({
      tabId: target.tabId,
      targetId: target.targetInfo.targetId,
      ...("parentSessionId" in target ? { chromeSessionId: target.sessionId } : {}),
    }))
    return aliasId
  }

  alias(client: Client, aliasId: string): ClientCdpSessionAlias | undefined {
    return this.states.get(client)?.aliases.get(aliasId)
  }

  private detachSession(client: Client, state: CdpClientState, sessionId: string, options: {
    readonly notify?: boolean
    readonly destroyed?: boolean
  } = {}): void {
    const announced = state.announcements.get(sessionId)
    if (!announced) return
    state.announcements.delete(sessionId)
    // Without its root announcement the client no longer gets the tab's events, so it cannot answer its paused
    // requests. Dropping the root drops every session this client owned there; child announcements come and go
    // without affecting ownership, because events are delivered through the root.
    if (announced.parentSessionId === undefined) this.dropClientTabInterception(client, announced.tabId)
    this.removeTargetAliases(state, (alias) => alias.targetId === announced.targetId)
    // Descendants must disappear before their parent, including on replacement.
    for (const child of state.announcements.values()) {
      if (child.parentSessionId === sessionId) this.detachSession(client, state, child.sessionId, options)
    }
    this.retired(client, sessionId)
    if (options.notify === false) return
    if (options.destroyed && announced.parentSessionId === undefined) {
      this.send(client, { method: "Target.targetDestroyed", params: { targetId: announced.targetId } })
    }
    this.send(client, {
      ...(announced.parentSessionId === undefined ? {} : { sessionId: announced.parentSessionId }),
      method: "Target.detachedFromTarget",
      params: { sessionId, targetId: announced.targetId },
    })
  }

  private dropClientTabInterception(client: Client, tabId: number): void {
    const sessions = this.interceptionOwners.get(tabId)
    if (!sessions) return
    for (const [sessionId, owners] of sessions) {
      owners.delete(client)
      if (owners.size === 0) sessions.delete(sessionId)
    }
    if (sessions.size === 0) this.dropInterceptionTab(tabId)
  }

  private dropClientInterceptions(client: Client): void {
    for (const tabId of Array.from(this.interceptionOwners.keys())) this.dropClientTabInterception(client, tabId)
  }

  private dropInterceptionSession(tabId: number, sessionId: string): void {
    const sessions = this.interceptionOwners.get(tabId)
    if (!sessions?.delete(sessionId)) return
    if (sessions.size === 0) this.dropInterceptionTab(tabId)
  }

  private dropInterceptionTab(tabId: number): void {
    if (!this.interceptionOwners.delete(tabId)) return
    this.onInterceptionEmpty(tabId)
  }

  private removeTargetAliases(state: CdpClientState, matches: (alias: Data.TaggedEnum.Value<ClientCdpSessionAlias, "Target">) => boolean): void {
    for (const [aliasId, alias] of state.aliases) {
      if (ClientCdpSessionAlias.$is("Target")(alias) && matches(alias)) state.aliases.delete(aliasId)
    }
  }

  private nextAlias(kind: "browser" | "session"): string {
    return `bc-client-${kind}-${this.nextAliasId++}`
  }

  private requireState(client: Client): CdpClientState {
    const state = this.states.get(client)
    if (!state) throw new Error("CDP client is not registered")
    return state
  }
}
