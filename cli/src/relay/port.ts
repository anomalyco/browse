// Where the relay listens, and where the CLI finds it.
//
// The configured port is OPENCODE_BROWSER_PORT, else 19988. Everything an install keeps by port (the session catalog,
// the lifecycle log, the current-session key) stays on the configured port, so a fallback never moves data. Only the
// listen port changes: another product (Playwriter) also uses 19988, and an unpinned relay steps to the next free
// browse port instead of failing onboarding. The extension learns the listen port when it pairs.
//
// <state root>/relay.json records the port the running relay actually bound. Clients resolve through it so a CLI or
// MCP server started after a fallback finds the relay. It never holds the relay token.
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { writePrivateJsonFileSync } from "../fs-durability.ts"
import { stateRoot } from "../paths.ts"
import { defaultPort } from "./helpers.ts"

/** The ports an unpinned relay falls back to after 19988. Not 19989: that is Browser Control's (helpers.ts). */
export const fallbackPorts = [19990, 19991, 19992, 19993, 19994, 19995, 19996, 19997] as const

export const endpointForPort = (port: number): string => `http://127.0.0.1:${port}`

function envPort(): number | undefined {
  const raw = process.env.OPENCODE_BROWSER_PORT
  if (raw === undefined || raw.trim() === "") return undefined
  const port = Number(raw)
  return Number.isSafeInteger(port) && port > 0 && port < 65_536 ? port : undefined
}

/** The port this install is configured for: OPENCODE_BROWSER_PORT, else 19988. State paths and keys use this one. */
export const configuredRelayPort = (): number => envPort() ?? defaultPort

/** Whether OPENCODE_BROWSER_PORT pins the relay to one port, with no fallback. */
export const relayPortPinned = (): boolean => envPort() !== undefined

const isPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 65_536

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0

/** What the running relay recorded in <state root>/relay.json. */
export type RelayState = {
  /** The port the relay actually bound. */
  readonly port: number
  /** The port this install is configured for, which the file must match to be believed. */
  readonly configuredPort: number
  readonly pid: number
  readonly instanceId: string
  readonly startedAt: string
}

export const relayStatePath = (root = stateRoot()): string => path.join(root, "relay.json")

export function readRelayState(root = stateRoot()): RelayState | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(relayStatePath(root), "utf8")) as Partial<RelayState> | null
    if (!value || !isPort(value.port) || !isPort(value.configuredPort) || !isPositiveInt(value.pid)) return undefined
    if (typeof value.instanceId !== "string" || typeof value.startedAt !== "string") return undefined
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
  writePrivateJsonFileSync(relayStatePath(root), state, { ensureParent: true })
}

/** Removes the file only when it still describes the instance that is shutting down. */
export function removeRelayState(instanceId: string, root = stateRoot()): void {
  const state = readRelayState(root)
  if (!state || state.instanceId !== instanceId) return
  try {
    fs.rmSync(relayStatePath(root), { force: true })
  } catch {}
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
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

const isFallbackPort = (port: number): boolean => port === defaultPort || (fallbackPorts as readonly number[]).includes(port)

/** The ports an unpinned relay tries, in order: the last fallback (sticky), then 19988, then 19990–19997. */
export function relayPortCandidates(configuredPort = configuredRelayPort(), root = stateRoot()): number[] {
  const state = readRelayState(root)
  const sticky = state && state.configuredPort === configuredPort && isFallbackPort(state.port) ? [state.port] : []
  return [...new Set([...sticky, configuredPort, ...fallbackPorts])]
}

export type RelayPortOwner = "browse" | "other" | "nobody"

const browseVersion = (body: unknown): boolean =>
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
function canListen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once("error", (error) => resolve((error as NodeJS.ErrnoException).code !== "EADDRINUSE"))
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

export type ChooseRelayPortOptions = {
  readonly configuredPort?: number
  /** An explicit port (or OPENCODE_BROWSER_PORT): bind only it, with no fallback. */
  readonly pinned?: boolean
  readonly host?: string
  /** Replaces the built-in list. Tests pass free ports so they never touch the real 19988–19997 range. */
  readonly candidates?: readonly number[]
  readonly probeTimeoutMs?: number
}

/**
 * The listen port for this relay. Pinned returns the configured port untouched (the listen then fails as before when
 * it is taken). Unpinned tries each candidate: a free one wins; one held by a browse relay stops the start, so an
 * install never runs a second relay elsewhere; one held by another program moves on.
 */
export async function chooseRelayPort(options: ChooseRelayPortOptions = {}): Promise<number> {
  const configuredPort = options.configuredPort ?? configuredRelayPort()
  const pinned = options.pinned ?? relayPortPinned()
  if (pinned) return configuredPort
  const host = options.host ?? "127.0.0.1"
  const candidates = options.candidates ?? relayPortCandidates(configuredPort)
  for (const port of candidates) {
    if (await canListen(host, port)) return port
    if (await probeRelayPort(port, options.probeTimeoutMs) === "browse") {
      throw new Error(`listen EADDRINUSE: address already in use ${host}:${port}`)
    }
  }
  throw new Error(
    `browse relay ports ${portListText(candidates)} are all in use. Set OPENCODE_BROWSER_PORT to a free port, or stop the program holding them.`,
  )
}
