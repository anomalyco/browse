import { extensionProtocolVersion } from "../../../cli/src/protocol"
import { defaultRelayPort, isJsonObject, relayPortHint, relayPorts } from "../../agent-relay/protocol"
import {
  BROWSER_NAME_KEY,
  RELAY_ADDRESS_KEY,
  relayAddress,
  type AgentRelayState,
  type AgentRelayStatus,
  type PairingSource,
  type ProtocolSkew,
} from "../../shared/protocol"
import {
  ecdhKeyPair,
  normalizePairingCode,
  pairingCodeMaterial,
  pairingProof,
  pairingSessionKey,
  randomNonce,
  sameSecret,
  sessionProof,
  unwrapToken,
  type PairingCode,
} from "../pairing"
import { TabCleanup } from "../tab-cleanup"
import { codePort, relayTarget } from "./discovery"
import {
  browserBrand,
  browserName,
  CODE_PORT_KEY,
  CONNECT_TIMEOUT,
  DISCOVERED_KIND_KEY,
  DISCOVERED_PORT_KEY,
  PAIRING_FILE,
  PAIRING_KEY,
  PORT_KEY,
  PROFILE_KEY,
  SPENT_KEY,
  TOKENS_KEY,
  type AgentRelayLog,
  type Credential,
  type Handshake,
} from "./wire"

declare const __OPENCODE_BROWSER_BUILD__: string

type PairingFile = { readonly code?: PairingCode; readonly port?: number }

/**
 * The token a loopback relay on another port may still accept: the most recently stored loopback token for a port
 * browse can listen on. Storing a token moves its key to the end (rememberToken), so insertion order is recency.
 */
function loopbackToken(tokens: Record<string, unknown>): string | undefined {
  let found: string | undefined
  for (const [key, value] of Object.entries(tokens)) {
    if (!key.startsWith("127.0.0.1:") || typeof value !== "string") continue
    if (!relayPorts.includes(Number(key.slice("127.0.0.1:".length)))) continue
    found = value
  }
  return found
}

export function createRelayHandshake(deps: {
  readonly log: AgentRelayLog
  readonly relayTabs: Set<number>
  readonly currentSocket: () => WebSocket | undefined
  readonly hostPort: () => { readonly host: string; readonly port: number }
  /** The address is automatic: a pairing code may only go to the port it was given for (never a scanned one). */
  readonly automatic: () => boolean
  readonly status: () => AgentRelayStatus
  readonly snapshot: () => AgentRelayState
  readonly generation: () => number
  readonly notify: () => void
  readonly resetAndConnect: (reason: string, closeReason?: string) => void
  readonly onAuthenticated: (current: WebSocket, skew: ProtocolSkew | undefined) => void
}) {
  /** Sockets whose relay proved it holds this browser's token; nothing else is obeyed. */
  const trusted = new WeakSet<WebSocket>()
  /** What each socket pairs with, for its close to say what was refused. */
  const credentials = new WeakMap<WebSocket, Credential>()
  /** The handshake in flight on a socket: this extension's nonce, and the code exchange's state once it started. */
  const handshakes = new WeakMap<WebSocket, Handshake>()
  /** The relay (`host:port`) that refused this browser's token since the worker started: a code goes first there. */
  let tokenRefused: string | undefined
  /** The relay refused the last code (wrong, used, expired, or too many tries). */
  let codeRejected = false
  /** This worker is removing a used code from storage: that change mustn't restart the connection. */
  let clearingCode = false
  let pairing: PairingSource = "none"
  /** A code install wrote into this unpacked build was found. */
  let unpacked = false
  /** Which side to update when the relay's protocol doesn't match this extension's. */
  let skew: ProtocolSkew | undefined
  /** The pairing file read in flight, or its result once found. */
  let pairingFileRead: Promise<PairingFile | undefined> | undefined

  /**
   * Waiters for how the next connection attempt ends (`connectTo` on the status page), each with the generation it
   * waits past, so the close of the connection it replaced doesn't answer for the new one.
   */
  const outcomes = new Set<{ after: number; resolve: (status: AgentRelayStatus) => void }>()
  const settle = (attempt: number) => {
    const currentStatus = deps.status()
    for (const waiter of outcomes)
      if (attempt > waiter.after) {
        outcomes.delete(waiter)
        waiter.resolve(currentStatus)
      }
  }

  /**
   * The one-time code and relay port install wrote into this unpacked build, if any (cli/src/browser-pairing.ts
   * writeExtensionPairing). Looked for again until found (install may write it while the worker runs), and again on
   * Reconnect or a pairing change.
   */
  const pairingFile = async () => {
    const reading = (pairingFileRead ??= fetch(chrome.runtime.getURL(PAIRING_FILE))
      .then((response) => (response.ok ? (response.json() as Promise<unknown>) : undefined))
      .then((value): PairingFile | undefined => {
        if (!isJsonObject(value)) return undefined
        const code = normalizePairingCode(value.code)
        const port = relayPortHint(value.port)
        return code === undefined && port === undefined ? undefined : { ...(code ? { code } : {}), ...(port ? { port } : {}) }
      })
      .catch(() => undefined))
    const file = await reading
    if (file === undefined && pairingFileRead === reading) pairingFileRead = undefined
    return file
  }

  /**
   * An automatic connection takes the relay port install wrote next to the pairing file as its discovered port, so
   * an unspent code in that file is tried where it is valid instead of at 19988. This also replaces a port only a scan
   * found: a listener that mimics browse's /version must not capture the file's code. A port a link or the user named
   * stays, since that is already a deliberate hint.
   */
  const pairingHint = async () => {
    const stored = await chrome.storage.local.get([RELAY_ADDRESS_KEY, PORT_KEY, DISCOVERED_PORT_KEY, DISCOVERED_KIND_KEY, SPENT_KEY])
    if (!relayTarget(stored).automatic) return
    const discovered = relayPortHint(stored[DISCOVERED_PORT_KEY])
    if (discovered !== undefined && stored[DISCOVERED_KIND_KEY] === "hint") return
    const file = await pairingFile()
    if (file?.code === undefined) return
    const spent = new Set(Array.isArray(stored[SPENT_KEY]) ? (stored[SPENT_KEY] as unknown[]) : [])
    if (spent.has(file.code.code)) return
    const port = file.port ?? defaultRelayPort
    // Nothing to change when the file means the default and no other port was found: dialing already starts there.
    if (discovered === undefined && port === defaultRelayPort) return
    deps.log.add("pairing.port", { port })
    // The file's own code is tied to its port (credential reads it from there); a code the user entered keeps the
    // port it was given for, or 19988.
    await chrome.storage.local.set({
      [DISCOVERED_PORT_KEY]: port,
      [DISCOVERED_KIND_KEY]: "hint",
    })
  }

  /**
   * What the next connection pairs with: a code the user entered (or install's link brought), else this browser's
   * token for the relay, else the code install wrote into this unpacked build (only for this computer's relay, and
   * only once), else the token again even though the relay refused it (it may have been a relay that isn't ours).
   * A code only goes to the port it was given for: one found by scanning is a different relay, and its refusal would
   * burn the code. The token's proof is bound to the port, so trying one that moved ports is safe.
   */
  const credential = async (): Promise<Credential | undefined> => {
    const { host, port } = deps.hostPort()
    const address = `${host}:${port}`
    const local = host === "127.0.0.1"
    const automatic = deps.automatic()
    const stored = await chrome.storage.local.get([PAIRING_KEY, TOKENS_KEY, SPENT_KEY, CODE_PORT_KEY])
    const spent = new Set(Array.isArray(stored[SPENT_KEY]) ? (stored[SPENT_KEY] as unknown[]) : [])
    const tokens = isJsonObject(stored[TOKENS_KEY]) ? stored[TOKENS_KEY] : {}
    const own = typeof tokens[address] === "string" ? tokens[address] : undefined
    // A fallback only moves an automatic connection to a browse port; an explicit port's token is its own key only.
    const token = own ?? (local && automatic ? loopbackToken(tokens) : undefined)
    const entered = normalizePairingCode(stored[PAIRING_KEY])
    const file = local ? await pairingFile() : undefined
    const usable = (code: PairingCode | undefined, here: boolean) =>
      here && code !== undefined && !spent.has(code.code) && !(code.legacy && token !== undefined)
    const next: Credential | undefined =
      usable(entered, !automatic || port === codePort(stored[CODE_PORT_KEY])) ?
        { kind: "code", code: entered!, source: "entered" }
      : token !== undefined && tokenRefused !== address ? { kind: "token", token }
      : usable(file?.code, !automatic || port === (file?.port ?? defaultRelayPort)) ?
        { kind: "code", code: file!.code!, source: "bundled" }
      : token !== undefined ? { kind: "token", token }
      : undefined
    const source: PairingSource = next?.kind ?? "none"
    if (source !== pairing || unpacked !== (file?.code !== undefined)) {
      pairing = source
      unpacked = file?.code !== undefined
      deps.notify()
    }
    return next
  }

  /** A code that was tried is never tried again; one entered is removed (without restarting the connection). */
  const spendCode = async (code: string) => {
    const stored = await chrome.storage.local.get([PAIRING_KEY, SPENT_KEY])
    const spent = Array.isArray(stored[SPENT_KEY])
      ? (stored[SPENT_KEY] as unknown[]).filter((value) => typeof value === "string")
      : []
    await chrome.storage.local.set({ [SPENT_KEY]: [...spent.filter((value) => value !== code), code].slice(-20) })
    if (normalizePairingCode(stored[PAIRING_KEY])?.code === code) {
      clearingCode = true
      await chrome.storage.local.remove([PAIRING_KEY, CODE_PORT_KEY])
    }
  }

  /**
   * Opens the pairing handshake: the hello carries a fresh nonce (and, to exchange a code, an ECDH public key), and
   * nothing the relay sends is obeyed until it proved it holds this browser's token or knows the code (`verify`).
   */
  const hello = async (current: WebSocket) => {
    const stored = (await chrome.storage.local.get(PROFILE_KEY))[PROFILE_KEY] as { id: string; name?: string } | undefined
    const profile = stored ?? { id: crypto.randomUUID() }
    if (!stored) await chrome.storage.local.set({ [PROFILE_KEY]: profile })
    const using = await credential()
    const name = await browserName()
    const ecdh = using?.kind === "code" ? await ecdhKeyPair() : undefined
    if (deps.currentSocket() !== current || current.readyState !== WebSocket.OPEN) return
    if (using === undefined) return current.close(1000, "Not paired")
    const nonce = randomNonce()
    // The proofs are bound to the port this socket dialled (see pairing.ts).
    handshakes.set(current, {
      nonce,
      port: Number(new URL(current.url).port),
      credential: using,
      ...(ecdh ? { ecdh } : {}),
    })
    credentials.set(current, using)
    // An older relay waits for commands it never gets; one that doesn't pair in time isn't ours.
    setTimeout(() => {
      if (deps.currentSocket() === current && current.readyState === WebSocket.OPEN && !trusted.has(current)) {
        deps.log.add("pairing.rejected", { reason: "no challenge" })
        current.close(4006, "Relay did not pair")
      }
    }, CONNECT_TIMEOUT)
    const mode = using.kind === "token" ? "token" : using.code.legacy ? "legacy" : "code"
    if (using.kind === "code") deps.log.add("pairing.code", { source: using.source, legacy: using.code.legacy })
    current.send(
      JSON.stringify({
        method: "hello",
        params: {
          version: chrome.runtime.getManifest().version,
          build: __OPENCODE_BROWSER_BUILD__,
          protocolVersion: extensionProtocolVersion,
          profileId: profile.id,
          profileName: profile.name ?? "browse",
          // What agents call this browser: the name set on the status page, else the relay names it from these
          // and the computer ("Chrome on MacBook").
          browser: browserBrand(),
          ...(name ? { name } : {}),
          pairing: { nonce, mode, ...(ecdh ? { ecdh: ecdh.publicKey } : {}) },
        },
      }),
    )
  }

  /** Keeps the token a code was exchanged for, and spends the code. */
  const adoptToken = async (token: string, code: PairingCode) => {
    await rememberToken(token)
    await spendCode(code.code)
    tokenRefused = undefined
    codeRejected = false
    deps.log.add("pairing.token", { legacy: code.legacy })
  }

  /**
   * Stores this browser's token under the address it just connected to. The key moves to the end so the next
   * fallback prefers the token stored most recently. A relay found on a new port keeps the token it already proved;
   * the proof is bound to the port, so a wrong relay simply rejects it.
   */
  const rememberToken = async (token: string) => {
    const { host, port } = deps.hostPort()
    const address = `${host}:${port}`
    const stored = await chrome.storage.local.get(TOKENS_KEY)
    const tokens = isJsonObject(stored[TOKENS_KEY]) ? stored[TOKENS_KEY] : {}
    const keys = Object.keys(tokens)
    if (tokens[address] === token && keys[keys.length - 1] === address) return
    // Delete-then-set in one write: a plain overwrite keeps the old key position, which would misreport recency.
    const reordered = Object.fromEntries(Object.entries(tokens).filter(([key]) => key !== address))
    reordered[address] = token
    await chrome.storage.local.set({ [TOKENS_KEY]: reordered })
  }

  /**
   * Checks the relay's proof, answers with this extension's, and only then starts working for it. With a token that's
   * one round; a code takes two (auth.code, then auth.token brings the token masked); the old shared code one, with
   * the token in the challenge (cli/src/browser-pairing.ts).
   */
  const verify = async (current: WebSocket, data: string) => {
    const pending = handshakes.get(current)
    const message = (() => {
      try {
        const parsed: unknown = JSON.parse(data)
        return isJsonObject(parsed) ? parsed : undefined
      } catch {
        return undefined
      }
    })()
    const params = isJsonObject(message?.params) ? message.params : undefined
    const refuse = (reason: string) => {
      handshakes.delete(current)
      // An older relay, or a program posing as one on this port: it gets nothing.
      deps.log.add("pairing.rejected", { reason })
      if (deps.currentSocket() === current && current.readyState === WebSocket.OPEN)
        current.close(4006, "Relay failed pairing")
    }
    if (!pending) return refuse(`unexpected ${String(message?.method ?? message?.id ?? "message")}`)
    const using = pending.credential
    let token: string | undefined
    let relayNonce: string
    if (pending.session) {
      // A code exchange's second round: the relay proves the code and sends the token.
      if (message?.method !== "auth.token" || !sameSecret(await sessionProof(pending.session.key, "relay"), params?.proof))
        return refuse("wrong code proof")
      token = await unwrapToken(pending.session.key, params?.wrapped)
      relayNonce = pending.session.relayNonce
    } else {
      const nonce =
        typeof params?.nonce === "string" && /^[A-Za-z0-9_-]{22,128}$/.test(params.nonce) ? params.nonce : undefined
      if (message?.method !== "auth.challenge" || nonce === undefined)
        return refuse(`unexpected ${String(message?.method ?? message?.id ?? "message")}`)
      relayNonce = nonce
      if (isJsonObject(params?.protocol)) pending.protocol = params.protocol
      if (using.kind === "token") {
        if (!sameSecret(await pairingProof(using.token, "relay", pending.port, relayNonce, pending.nonce), params?.proof))
          return refuse("wrong proof")
        token = using.token
      } else {
        const secret = await pending.ecdh?.secret(params?.ecdh)
        if (!secret || !pending.ecdh) return refuse("no key exchange")
        const transcript = {
          port: pending.port,
          extensionNonce: pending.nonce,
          relayNonce,
          extensionKey: pending.ecdh.publicKey,
          relayKey: String(params?.ecdh),
        }
        const key = await pairingSessionKey(await pairingCodeMaterial(using.code), secret, transcript)
        if (!using.code.legacy) {
          // Prove the code; the relay finds which of its pending codes it is and answers with auth.token.
          if (deps.currentSocket() !== current || current.readyState !== WebSocket.OPEN) return
          pending.session = { key, relayNonce }
          current.send(JSON.stringify({ method: "auth.code", params: { proof: await sessionProof(key, "extension") } }))
          return
        }
        if (!sameSecret(await sessionProof(key, "relay"), params?.proof)) return refuse("wrong proof")
        token = await unwrapToken(key, params?.wrapped)
      }
    }
    handshakes.delete(current)
    if (deps.currentSocket() !== current || current.readyState !== WebSocket.OPEN) return
    if (token === undefined) return refuse("no token")
    if (using.kind === "code") await adoptToken(token, using.code)
    else await rememberToken(token)
    if (deps.currentSocket() !== current || current.readyState !== WebSocket.OPEN) return
    current.send(
      JSON.stringify({
        method: "auth.response",
        params: { proof: await pairingProof(token, "extension", pending.port, pending.nonce, relayNonce) },
      }),
    )
    // The protocols the relay speaks (newer relays say): outside them, the relay keeps this connection but sends no
    // work, so show which side to update instead of "connected".
    const range = pending.protocol
    skew =
      typeof range?.version === "number" && extensionProtocolVersion > range.version
        ? "update-cli"
        : typeof range?.min === "number" && extensionProtocolVersion < range.min
          ? "update-extension"
          : undefined
    trusted.add(current)
    tokenRefused = undefined
    codeRejected = false
    deps.log.add("pairing.ok", { source: using.kind })
    // Tabs an agent opened say so: one the relay no longer knows after a reconnect is closed, not handed to the user.
    for (const tabId of Array.from(deps.relayTabs)) {
      const agent = await TabCleanup.isTracked(tabId)
      if (deps.currentSocket() !== current) return
      current.send(
        JSON.stringify({ method: "debugger.attached", params: { tabId, ...(agent ? { agent: true } : {}) } }),
      )
    }
    current.send(JSON.stringify({ method: "ready" }))
    deps.log.add("hello", { tabs: deps.relayTabs.size, protocol: extensionProtocolVersion })
    deps.onAuthenticated(current, skew)
  }

  const onCloseRefusal = (current: WebSocket, code: number) => {
    const used = credentials.get(current)
    if (used && !trusted.has(current) && code === 4006) {
      const { host, port } = deps.hostPort()
      if (used.kind === "token") tokenRefused = `${host}:${port}`
      else {
        codeRejected = true
        void spendCode(used.code.code).catch(() => undefined)
      }
    }
  }

  const onPairingStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local" || !(PAIRING_KEY in changes || RELAY_ADDRESS_KEY in changes || BROWSER_NAME_KEY in changes))
      return
    if (
      !(RELAY_ADDRESS_KEY in changes) &&
      !(BROWSER_NAME_KEY in changes) &&
      clearingCode &&
      changes[PAIRING_KEY]?.newValue === undefined
    ) {
      clearingCode = false
      return
    }
    if (PAIRING_KEY in changes && changes[PAIRING_KEY]?.newValue !== undefined) codeRejected = false
    deps.log.add("pairing.changed")
    pairingFileRead = undefined
    deps.resetAndConnect("pairing", "Pairing changed")
  }

  const connectTo = async (
    addressInput: string,
    codeInput: string,
  ): Promise<{ status: AgentRelayStatus | "invalid-address" | "invalid-code"; address?: string }> => {
    const address = relayAddress(addressInput)
    if (address === undefined) return { status: "invalid-address" }
    const code = codeInput.trim() === "" ? undefined : normalizePairingCode(codeInput)
    if (codeInput.trim() !== "" && code === undefined) return { status: "invalid-code" }
    const before = await chrome.storage.local.get([
      RELAY_ADDRESS_KEY, PAIRING_KEY, PORT_KEY, DISCOVERED_PORT_KEY, DISCOVERED_KIND_KEY,
    ])
    const current = deps.hostPort()
    const automatic = deps.automatic()
    // Localhost with no port, or the automatic address the form shows for this computer while the connection is still
    // automatic, is this computer: saving it must not pin it. A loopback address with a browse port while automatic is
    // a hint for where the relay is, not a pin: a relay that later returns to 19988 is still found. An explicit stored
    // address re-saved stays explicit, even when its port happens to be the one now in use.
    const hinted = automatic && address.host === "127.0.0.1" && address.port !== undefined && relayPorts.includes(address.port)
      ? address.port
      : undefined
    const local = address.host === "127.0.0.1" &&
      (address.port === undefined || hinted !== undefined || (automatic && address.port === current.port))
    const value = local ? "" : address.port ? `${address.host}:${address.port}` : address.host
    // A code typed without a port must not ride on a port only a scan found: 19988 is where an unpaired extension
    // starts. A relay found by a scan is never given a pairing code (agent-relay/discovery.ts).
    const scannedOnly = automatic && hinted === undefined && code !== undefined && before[DISCOVERED_KIND_KEY] !== "hint"
    const codePort = hinted ?? (scannedOnly
      ? defaultRelayPort
      : relayTarget({
          [RELAY_ADDRESS_KEY]: value,
          [PORT_KEY]: before[PORT_KEY],
          [DISCOVERED_PORT_KEY]: before[DISCOVERED_PORT_KEY],
        }).port)
    const clearDiscovered = scannedOnly && relayPortHint(before[DISCOVERED_PORT_KEY]) !== undefined
    const beforeKind = before[DISCOVERED_KIND_KEY] === "hint" ? "hint" : "scan"
    const changed =
      (before[RELAY_ADDRESS_KEY] ?? "") !== value ||
      (code !== undefined && before[PAIRING_KEY] !== code.code) ||
      (hinted !== undefined && (relayPortHint(before[DISCOVERED_PORT_KEY]) !== hinted || beforeKind !== "hint")) ||
      clearDiscovered
    const outcome = new Promise<AgentRelayStatus>((resolve) => {
      const waiter = { after: deps.generation(), resolve }
      outcomes.add(waiter)
      setTimeout(() => {
        if (outcomes.delete(waiter)) resolve(deps.status())
      }, CONNECT_TIMEOUT + 2_000)
    })
    deps.log.add("relay.configure", { address: value || "this computer", code: code !== undefined })
    if (code !== undefined) {
      // Typed again after it was refused: the user wants it tried.
      const spent = (await chrome.storage.local.get(SPENT_KEY))[SPENT_KEY]
      if (Array.isArray(spent))
        await chrome.storage.local.set({ [SPENT_KEY]: spent.filter((entry) => entry !== code.code) })
    }
    // Removed before the write, so the reconnect the write triggers already dials 19988 instead of the scanned port.
    if (clearDiscovered) await chrome.storage.local.remove([DISCOVERED_PORT_KEY, DISCOVERED_KIND_KEY])
    // One write, so storage.onChanged reconnects once.
    if (changed)
      await chrome.storage.local.set({
        [RELAY_ADDRESS_KEY]: value,
        ...(hinted !== undefined
          ? { [DISCOVERED_PORT_KEY]: hinted, [DISCOVERED_KIND_KEY]: "hint" }
          : {}),
        ...(code !== undefined
          ? {
              [PAIRING_KEY]: code.code,
              // The port this save dials: a later scan must never carry the code to a different relay.
              [CODE_PORT_KEY]: codePort,
            }
          : {}),
      })
    else {
      pairingFileRead = undefined
      tokenRefused = undefined
      deps.resetAndConnect("user", "Checking the connection")
    }
    return { status: await outcome, address: deps.snapshot().relay.address }
  }

  /**
   * A one-time code from install's link (welcome.html#code=…, or `&port=` when the relay isn't on 19988). The port is
   * taken as the discovered port, and as the only port the code may ever be sent to.
   */
  const pairLink = async (input: string, hint?: number) => {
    const code = normalizePairingCode(input)
    if (code === undefined || code.legacy || deps.status() === "connected") return false
    const port = relayPortHint(hint)
    deps.log.add("pairing.link")
    // A link without a port is for 19988. Drop a port only a scan found first, so the reconnect this write triggers
    // dials 19988 with the code instead of carrying it to whatever answered a scan.
    if (port === undefined) await chrome.storage.local.remove([DISCOVERED_PORT_KEY, DISCOVERED_KIND_KEY])
    // Reconnects through storage.onChanged, or here after the write: a link press tries now even when these values
    // were already stored.
    await chrome.storage.local.set({
      [PAIRING_KEY]: code.code,
      // The port this code is for: never a later scan's, nor whatever port is in use when the code is tried.
      [CODE_PORT_KEY]: port ?? defaultRelayPort,
      ...(port !== undefined ? { [DISCOVERED_PORT_KEY]: port, [DISCOVERED_KIND_KEY]: "hint" } : {}),
    })
    deps.resetAndConnect("pairing", "Pairing changed")
    return true
  }

  const reconnect = () => {
    deps.log.add("reconnect.requested")
    pairingFileRead = undefined
    tokenRefused = undefined
    deps.resetAndConnect("user")
  }

  return {
    trusted,
    pairingState: () => ({ pairing, skew, codeRejected, unpacked }),
    setSkew: (next: ProtocolSkew | undefined) => {
      skew = next
    },
    settle,
    credential,
    pairingHint,
    hello,
    verify,
    onCloseRefusal,
    onPairingStorageChanged,
    connectTo,
    pairLink,
    reconnect,
  }
}
