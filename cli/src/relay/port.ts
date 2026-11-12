// Where the relay listens, and where the CLI finds it.
//
// The configured port is OPENCODE_BROWSER_PORT, else 19988. Everything an install keeps by port (the session catalog,
// the lifecycle log, the current-session key) stays on the configured port, so a fallback never moves data. Only the
// listen port changes: another product (Playwriter) also uses 19988, and an unpinned relay steps to the next free
// browse port instead of failing onboarding. The extension learns the listen port when it pairs.
//
// <state root>/relays/<configured port>/relay.json records the port the running relay actually bound. Clients resolve
// through it so a CLI or MCP server started after a fallback finds the relay. It never holds the relay token.
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { writePrivateJsonFileSync } from "../fs-durability.ts"
import { stateRoot } from "../paths.ts"
import { defaultPort } from "./helpers.ts"

/** The ports an unpinned relay falls back to after 19988. Not 19989: that is Browser Control's (helpers.ts). */
export const fallbackPorts = [19990, 19991, 19992, 19993, 19994, 19995, 19996, 19997] as const

export const endpointForPort = (port: number): string => `http://127.0.0.1:${port}`

function envPort(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.OPENCODE_BROWSER_PORT
  if (raw === undefined || raw.trim() === "") return undefined
  const port = Number(raw)
  return Number.isSafeInteger(port) && port > 0 && port < 65_536 ? port : undefined
}

/** The port this install is configured for: OPENCODE_BROWSER_PORT, else 19988. State paths and keys use this one. */
export const configuredRelayPort = (env: NodeJS.ProcessEnv = process.env): number => envPort(env) ?? defaultPort

/** Whether OPENCODE_BROWSER_PORT pins the relay to one port, with no fallback. */
export const relayPortPinned = (env: NodeJS.ProcessEnv = process.env): boolean => envPort(env) !== undefined

const isPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 65_536

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0

/** What the running relay recorded in <state root>/relays/<configured port>/relay.json. */
export type RelayState = {
  /** The port the relay actually bound. */
  readonly port: number
  /** The port this install is configured for, which the file must match to be believed. */
  readonly configuredPort: number
  readonly pid: number
  readonly instanceId: string
  readonly startedAt: string
}

export const relayStatePath = (root = stateRoot(), configuredPort = configuredRelayPort()): string =>
  path.join(root, "relays", String(configuredPort), "relay.json")

/** The last port this configured install listened on, kept across shutdowns (unlike relay.json). Never a token. */
export const lastRelayPortPath = (root = stateRoot(), configuredPort = configuredRelayPort()): string =>
  path.join(root, "relays", String(configuredPort), "last-port.json")

export function readLastRelayPort(root = stateRoot(), configuredPort = configuredRelayPort()): number | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(lastRelayPortPath(root, configuredPort), "utf8")) as { port?: unknown } | null
    return typeof value === "object" && value !== null && !Array.isArray(value) && isPort(value.port) ? value.port : undefined
  } catch {
    return undefined
  }
}

export function writeLastRelayPort(port: number, root = stateRoot(), configuredPort = configuredRelayPort()): void {
  writePrivateJsonFileSync(lastRelayPortPath(root, configuredPort), { port }, { ensureParent: true })
}

export function readRelayState(
  root = stateRoot(),
  configuredPort = configuredRelayPort(),
): RelayState | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(relayStatePath(root, configuredPort), "utf8")) as Partial<RelayState> | null
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    if (!isPort(value.port) || value.configuredPort !== configuredPort || !isPositiveInt(value.pid)) return undefined
    if (typeof value.instanceId !== "string" || value.instanceId === "" || typeof value.startedAt !== "string") return undefined
    return {
      port: value.port,
      configuredPort: value.configuredPort,
      pid: value.pid,
      instanceId: value.instanceId,
      startedAt: value.startedAt,
    }
  } catch {
    return undefined
  }
}

export function writeRelayState(state: RelayState, root = stateRoot()): void {
  writePrivateJsonFileSync(relayStatePath(root, state.configuredPort), state, { ensureParent: true })
}

/** Removes the file only when it still describes the instance that is shutting down. */
export function removeRelayState(
  instanceId: string,
  root = stateRoot(),
  configuredPort = configuredRelayPort(),
): void {
  const state = readRelayState(root, configuredPort)
  if (!state || state.instanceId !== instanceId) return
  try {
    fs.rmSync(relayStatePath(root, state.configuredPort), { force: true })
  } catch {}
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // Our relay is always this user's process: EPERM means another user's, which this install never wrote.
    return false
  }
}

/**
 * The port clients should dial. A pinned OPENCODE_BROWSER_PORT wins; otherwise the relay.json a live relay wrote for
 * this install; otherwise 19988. Cheap: an environment read, a small file read and one `kill(pid, 0)`.
 */
export function resolveRelayPort(root = stateRoot()): number {
  const pinned = envPort()
  if (pinned !== undefined) return pinned
  const state = readRelayState(root)
  if (state && state.configuredPort === configuredRelayPort() && processAlive(state.pid)) return state.port
  return defaultPort
}

/** The ports an unpinned relay tries, in order: the configured port, then 19990–19997. */
export function relayPortCandidates(configuredPort = configuredRelayPort()): number[] {
  return [...new Set([configuredPort, ...fallbackPorts])]
}

export type RelayPortOwner = "browse" | "other" | "nobody"

type BrowseVersion = { readonly version: string; readonly instanceId: string }

const browseVersion = (body: unknown): body is BrowseVersion =>
  typeof body === "object" && body !== null &&
  typeof (body as { version?: unknown }).version === "string" &&
  typeof (body as { instanceId?: unknown }).instanceId === "string"

const relayStarting = (body: unknown): boolean =>
  typeof body === "object" && body !== null && (body as { code?: unknown }).code === "relay-starting"

/**
 * Who holds a port, from the open `/version` probe: a browse relay (current, or answering 503 while it starts), some
 * other program, or nothing answering. Sent without credentials: whoever holds the port must never see the token.
 */
export async function probeRelayPort(port: number, timeoutMs = 500): Promise<RelayPortOwner> {
  try {
    const response = await fetch(`${endpointForPort(port)}/version`, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body: unknown = await response.json().catch(() => undefined)
    if (response.status === 200 && browseVersion(body)) return "browse"
    if (response.status === 503 && relayStarting(body)) return "browse"
    return "other"
  } catch {
    return "nobody"
  }
}

/** A browse relay's own `/version` answer on `port`, or undefined for anything else. Never carries credentials. */
async function browseVersionAt(port: number, timeoutMs: number): Promise<BrowseVersion | undefined> {
  try {
    const response = await fetch(`${endpointForPort(port)}/version`, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status !== 200) return undefined
    const body: unknown = await response.json().catch(() => undefined)
    return browseVersion(body) ? body : undefined
  } catch {
    return undefined
  }
}

/**
 * The running browse relay, proven before any caller attaches the relay token: its open `/version` must have browse's
 * shape and, when a live relay.json exists for this configured port, the same port and instanceId. A live relay.json
 * naming another port means the endpoint under test is not trusted, not that there is no relay.
 */
export async function verifiedRelay(
  options: { readonly root?: string; readonly timeoutMs?: number } = {},
): Promise<{ readonly endpoint: string; readonly instanceId: string } | undefined> {
  const root = options.root ?? stateRoot()
  const configuredPort = configuredRelayPort()
  const state = readRelayState(root, configuredPort)
  const live = state !== undefined && state.configuredPort === configuredPort && processAlive(state.pid)
    ? state
    : undefined
  // This one read decides the port: a pinned port stays pinned, otherwise a live relay.json names it, else 19988.
  const port = envPort() ?? live?.port ?? defaultPort
  const version = await browseVersionAt(port, options.timeoutMs ?? 3_000)
  if (!version) return undefined
  // The record must not have changed while /version was in flight. A live record when the probe started must still be
  // the same; one that appears during the probe is allowed only when it describes exactly this reply.
  const reread = readRelayState(root, configuredPort)
  const after = reread !== undefined && reread.configuredPort === configuredPort && processAlive(reread.pid)
    ? reread
    : undefined
  const same = live === undefined
    ? true
    : after !== undefined && after.port === live.port && after.instanceId === live.instanceId
  if (!same) return undefined
  if (after && (after.port !== port || version.instanceId !== after.instanceId)) return undefined
  return { endpoint: endpointForPort(port), instanceId: version.instanceId }
}

/** The endpoint of `verifiedRelay`, for callers that only need where to send. */
export async function verifiedRelayEndpoint(
  options: { readonly root?: string; readonly timeoutMs?: number } = {},
): Promise<string | undefined> {
  return (await verifiedRelay(options))?.endpoint
}

/** A live relay recorded in relay.json for `configuredPort`, still answering as the same browse instance. */
async function liveRecordedRelay(
  configuredPort: number,
  root: string,
  timeoutMs: number,
): Promise<RelayState | undefined> {
  const state = readRelayState(root, configuredPort)
  if (!state || state.configuredPort !== configuredPort || !processAlive(state.pid)) return undefined
  const version = await browseVersionAt(state.port, timeoutMs)
  return version?.instanceId === state.instanceId ? state : undefined
}

/**
 * The port a live relay recorded in relay.json, proven by its open /version. Undefined when no relay has recorded
 * itself, or when the recorded instance no longer answers: a pairing file must not name a port nothing is listening on.
 */
export async function liveRelayPort(
  options: { readonly root?: string; readonly timeoutMs?: number } = {},
): Promise<number | undefined> {
  const root = options.root ?? stateRoot()
  const state = await liveRecordedRelay(configuredRelayPort(), root, options.timeoutMs ?? 800)
  return state?.port
}

/** "19988, 19990-19997" */
function portListText(ports: readonly number[]): string {
  const groups: string[] = []
  const sorted = [...ports].sort((left, right) => left - right)
  for (let index = 0; index < sorted.length; index++) {
    const first = sorted[index]!
    let last = first
    while (sorted[index + 1] === last + 1) last = sorted[++index]!
    groups.push(first === last ? String(first) : `${first}-${last}`)
  }
  return groups.join(", ")
}

/** Whether `port` can be bound on `host` right now. Errors other than EADDRINUSE go to the real listen. */
function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once("error", (error) => resolve((error as NodeJS.ErrnoException).code !== "EADDRINUSE"))
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/** A non-loopback listen must also be free on 127.0.0.1, the address clients and CDP use. */
async function canListen(host: string, port: number): Promise<boolean> {
  if (!(await canBind(host, port))) return false
  return loopbackHost(host) || canBind("127.0.0.1", port)
}

export type ChooseRelayPortOptions = {
  readonly configuredPort?: number
  /** An explicit port (or OPENCODE_BROWSER_PORT): bind only it, with no fallback. */
  readonly pinned?: boolean
  readonly host?: string
  /** Replaces the built-in list. Tests pass free ports so they never touch the real 19988–19997 range. */
  readonly candidates?: readonly number[]
  readonly probeTimeoutMs?: number
  readonly root?: string
}

const alreadyInUse = (host: string, port: number) =>
  new Error(`listen EADDRINUSE: address already in use ${host}:${port}`)

const loopbackHost = (host: string) =>
  host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host)

/**
 * The listen port for this relay. Pinned returns the configured port untouched (the listen then fails as before when
 * it is taken). Unpinned first refuses to run beside the relay.json instance that is still live here, then tries each
 * candidate: a free one wins; one held by a browse relay stops the start, so an install never runs a second relay
 * elsewhere; one held by another HTTP server moves on. A port that can't be bound but doesn't answer HTTP is in use by
 * something else: the start stops there too, rather than racing a slow relay with a second one.
 */
export async function chooseRelayPort(options: ChooseRelayPortOptions = {}): Promise<number> {
  const configuredPort = options.configuredPort ?? configuredRelayPort()
  const pinned = options.pinned ?? relayPortPinned()
  if (pinned) return configuredPort
  const host = options.host ?? "127.0.0.1"
  const root = options.root ?? stateRoot()
  const candidates = options.candidates ?? relayPortCandidates(configuredPort)
  const probeTimeoutMs = options.probeTimeoutMs ?? 500
  const recorded = await liveRecordedRelay(configuredPort, root, probeTimeoutMs)
  if (recorded) throw alreadyInUse(host, recorded.port)
  // Remote browsers enter the printed address by hand and don't scan for a move. Keep the last port this install
  // listened on while it is free, even across shutdowns (relay.json is deleted then; last-port.json is not).
  const last = !loopbackHost(host) ? readLastRelayPort(root, configuredPort) : undefined
  if (last !== undefined && await canListen(host, last)) return last
  for (const port of candidates) {
    if (await canListen(host, port)) return port
    const owner = await probeRelayPort(port, probeTimeoutMs)
    if (owner === "browse") throw alreadyInUse(host, port)
    // A definite non-browse HTTP server leaves the port to it. No answer at all is a port something holds that isn't
    // HTTP: starting a relay elsewhere would leave two relays with two sets of state.
    if (owner === "nobody") throw alreadyInUse(host, port)
  }
  throw new Error(
    `browse relay ports ${portListText(candidates)} are all in use. Set OPENCODE_BROWSER_PORT to a free port, or stop the program holding them.`,
  )
}
