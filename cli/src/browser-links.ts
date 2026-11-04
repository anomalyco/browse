// The browsers connected to the relay, one link each (an extension's WebSocket). Chrome numbers tabs per browser, so
// two browsers can both have tab 7: every tab id the relay works with is its own, translated at the link's edge (events
// in, commands out). The rest of the relay keeps treating tab ids as unique. Each link has its own generation, from one
// counter, so a browser reconnecting invalidates only its own in-flight work.
//
// A browser is known by its profile (the extension's stable random id) and gets a short id agents can name, such as
// "chrome-macbook", kept in the data root so it stays the same across relay restarts and persisted sessions.
import dns from "node:dns/promises"
import fs from "node:fs"
import type http from "node:http"
import os from "node:os"
import path from "node:path"
import type { WebSocket } from "ws"
import { ExtensionRpc } from "./extension-rpc.ts"
import { writePrivateJsonFileSync } from "./fs-durability.ts"
import { dataRoot } from "./paths.ts"
import { isLocalPeer } from "./relay-config.ts"

/** "Daxs-MacBook-Pro.local" or "macbook.tail1234.ts.net" -> "Daxs-MacBook-Pro" / "macbook". */
const shortHost = (host: string) => host.replace(/\.$/, "").split(".")[0] || host

/**
 * The computer a browser runs on, for its name: this machine's hostname for a browser here, else the name the network
 * gives the other computer's address (Tailscale's MagicDNS answers for its peers), else the address.
 */
export async function computerName(request: Pick<http.IncomingMessage, "socket">): Promise<string> {
  if (isLocalPeer(request.socket)) return shortHost(os.hostname())
  const address = request.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "another computer"
  const names = await Promise.race([
    dns.reverse(address).catch(() => [] as string[]),
    new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 1_500)),
  ])
  return names[0] ? shortHost(names[0]) : address
}

export type BrowserLink = {
  /** The extension's profile id: one Chrome profile with Browse. */
  readonly key: string
  /** What agents name it: a slug of the name, unique among known browsers. */
  readonly id: string
  /** "Chrome on MacBook", or the name set on the extension's status page. */
  readonly name: string
  readonly rpc: ExtensionRpc
  readonly socket: WebSocket
  readonly generation: number
  readonly connectedAt: number
  build?: string | undefined
  origin?: string | undefined
  /** Tabs (relay ids) the extension announced since it connected; ready drops roots it didn't. */
  readonly announcedRootTabIds: Set<number>
  /** Of those, the ones it says an agent opened. */
  readonly announcedAgentTabIds: Set<number>
  /** The status page settings this browser sent. */
  cursor: boolean
  humanInput: boolean | undefined
  /** It runs on this computer (not over the network), so its unpacked extension is this computer's folder. */
  local: boolean
}

type Known = Record<string, { readonly id: string; readonly name: string }>

/** "Chrome on Dax's MacBook Pro" -> "chrome-daxs-macbook-pro". */
function browserSlug(name: string): string {
  const slug = name.toLowerCase().replace(/['’]/g, "").replace(/\bon\b/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return slug.slice(0, 40).replace(/-+$/, "") || "browser"
}

export class BrowserLinks {
  /** Connected browsers, in the order they connected: the first is the default. */
  private readonly links = new Map<string, BrowserLink>()
  private readonly bySocket = new Map<WebSocket, BrowserLink>()
  private generation = 0
  private nextTabId = 1_000_000_000
  private readonly toRelay = new Map<string, number>()
  private readonly fromRelay = new Map<number, { readonly key: string; readonly tabId: number }>()
  private known: Known | undefined

  constructor(private readonly options: { readonly root?: string } = {}) {}

  private get file() {
    return path.join(this.options.root ?? dataRoot(), "browsers.json")
  }

  private load(): Known {
    if (this.known) return this.known
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown
      this.known = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Known) : {}
    } catch {
      this.known = {}
    }
    return this.known
  }

  /** The browser's id: the one it had before, else a new slug of its name, unique among the browsers ever seen. */
  private identify(key: string, name: string): string {
    const known = this.load()
    const previous = known[key]
    if (previous && previous.name === name) return previous.id
    const taken = new Set(Object.entries(known).filter(([other]) => other !== key).map(([, entry]) => entry.id))
    const base = browserSlug(name)
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    known[key] = { id, name }
    try {
      writePrivateJsonFileSync(this.file, known, { ensureParent: true })
    } catch {
      // The id still works for this relay's life.
    }
    return id
  }

  /**
   * A browser that paired. The same profile connecting again (its service worker restarted) replaces its old link,
   * which is returned so the relay can clear what it held; another profile is added beside the others.
   */
  connect(options: { readonly key: string; readonly name: string; readonly socket: WebSocket }): { readonly link: BrowserLink; readonly replaced?: BrowserLink } {
    const replaced = this.links.get(options.key)
    if (replaced) this.disconnect(replaced.socket)
    const link: BrowserLink = {
      key: options.key,
      id: this.identify(options.key, options.name),
      name: options.name,
      rpc: new ExtensionRpc(),
      socket: options.socket,
      generation: ++this.generation,
      connectedAt: Date.now(),
      announcedRootTabIds: new Set(),
      announcedAgentTabIds: new Set(),
      cursor: false,
      humanInput: undefined,
      local: false,
    }
    link.rpc.replaceSocket(options.socket)
    this.links.set(options.key, link)
    this.bySocket.set(options.socket, link)
    return replaced ? { link, replaced } : { link }
  }

  /** The link this socket was, if it's still current; it's removed. */
  disconnect(socket: WebSocket): BrowserLink | undefined {
    const link = this.bySocket.get(socket)
    if (!link) return undefined
    this.bySocket.delete(socket)
    if (this.links.get(link.key) === link) this.links.delete(link.key)
    link.rpc.disconnectIfCurrent(socket)
    return link
  }

  ofSocket(socket: WebSocket): BrowserLink | undefined {
    const link = this.bySocket.get(socket)
    return link && this.links.get(link.key) === link ? link : undefined
  }

  /** Connected browsers, the default first. */
  list(): BrowserLink[] {
    return Array.from(this.links.values())
  }

  /** The browser agents use when they don't name one: the first that connected and is ready. */
  defaultLink(): BrowserLink | undefined {
    return this.list().find((link) => link.rpc.connected) ?? this.list()[0]
  }

  byId(id: string): BrowserLink | undefined {
    const wanted = id.trim().toLowerCase()
    return this.list().find((link) => link.id === wanted) ?? this.list().find((link) => link.name.toLowerCase() === wanted)
  }

  byKey(key: string): BrowserLink | undefined {
    return this.links.get(key)
  }

  /** Recover a pre-affinity catalog entry only when the stored id (or a single known profile) identifies it. */
  knownBrowser(id: string | undefined): Pick<BrowserLink, "key" | "id"> | undefined {
    const entries = Object.entries(this.load())
    const known = id ? entries.find(([, entry]) => entry.id === id) : entries.length === 1 ? entries[0] : undefined
    return known && { key: known[0], id: known[1].id }
  }

  get connected(): boolean {
    return this.list().some((link) => link.rpc.connected)
  }

  /**
   * The relay's id for a browser's tab, given the first time it's seen: the browser's own id, unless another browser
   * already has a tab with it (then one from far above Chrome's range). With one browser, ids are Chrome's.
   */
  relayTabId(link: Pick<BrowserLink, "key">, tabId: number): number {
    const key = `${link.key}:${tabId}`
    let id = this.toRelay.get(key)
    if (id === undefined) {
      id = this.fromRelay.has(tabId) ? this.nextTabId++ : tabId
      while (this.fromRelay.has(id)) id = this.nextTabId++
      this.toRelay.set(key, id)
      this.fromRelay.set(id, { key: link.key, tabId })
    }
    return id
  }

  /** The browser a relay tab id belongs to, while it's connected, and the tab's id there. */
  browserTab(relayTabId: number): { readonly link: BrowserLink; readonly tabId: number } | undefined {
    const entry = this.fromRelay.get(relayTabId)
    const link = entry && this.links.get(entry.key)
    return entry && link ? { link, tabId: entry.tabId } : undefined
  }

  /** The browser a relay tab id belongs to, connected or not. */
  ownerKey(relayTabId: number): string | undefined {
    return this.fromRelay.get(relayTabId)?.key
  }

  /** The generation that current work on a tab belongs to; -1 for a tab of no connected browser. */
  generationOf(relayTabId: number): number {
    return this.browserTab(relayTabId)?.link.generation ?? -1
  }

  isCurrentGeneration(generation: number): boolean {
    return this.list().some((link) => link.generation === generation)
  }
}
