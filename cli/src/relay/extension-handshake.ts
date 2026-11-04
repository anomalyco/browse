import crypto from "node:crypto"
import fs from "node:fs"
import type http from "node:http"
import { WebSocket, type RawData } from "ws"
import { computerName, type BrowserLink, type BrowserLinks } from "./browser-links.ts"
import {
  browserToken,
  consumePairingCode,
  ecdhExchange,
  issueBrowserToken,
  legacyPairingCode,
  legacyPairingProof,
  newBrowserToken,
  pairingProof,
  pairingSessionKey,
  pendingPairingCodeKeys,
  readBrowserPairings,
  recordPairingFailure,
  sessionProof,
  touchBrowserPairing,
  wrapToken,
  type HandshakeTranscript,
} from "./browser-pairing.ts"
import { installedDevExtension } from "../setup/dev-extension.ts"
import type { ExtensionRpc } from "./rpc.ts"
import { cliCommand, fromCheckout, installCommand, oldStoreMarker, storeUrl } from "../paths.ts"
import {
  checkoutReloadPrefix,
  extensionProtocolAdvice,
  extensionProtocolCompatibility,
  extensionProtocolVersion,
  isExtensionEvent,
  minExtensionProtocolVersion,
  parseJsonObject,
  type JsonObject,
} from "../protocol.ts"
import { decodeRecordingFrame, encodeRecordingFrame } from "../recording-relay/protocol.ts"
import { isLocalPeer } from "./config.ts"
import { getNumber, getObject, getString, headerValue, stableUnpackedExtensionOrigin } from "./helpers.ts"
import { relayLog } from "./log.ts"
import type { ExtensionStatus } from "./schema.ts"
import { secretsEqual } from "./secrets.ts"
import type { OpenCodeBrowserSession } from "./types.ts"
import type { TargetRegistry } from "../cdp/target-registry.ts"
import { opencodeBrowserBuildId } from "../version.ts"
import { rawDataToBuffer, relayProcessFaultSummary } from "./process-guard.ts"

type ExtensionCommandInput = Parameters<ExtensionRpc["send"]>[0]

type Challenge = {
  readonly mode: "token" | "code" | "legacy" | "old"
  readonly hello: JsonObject
  readonly key: string
  readonly extensionNonce: string
  readonly relayNonce: string
  expected?: string
  /** A code exchange waiting for the extension's auth.code. */
  code?: { readonly secret: Buffer; readonly transcript: HandshakeTranscript } | undefined
  /** The token a legacy upgrade hands over, stored once the extension proves it unmasked it. */
  readonly issue?: string
}

export class ExtensionHandshake {
  private readonly rejectedExtensionConnections = 0
  private pairingFailures = 0
  private mismatch: (ReturnType<typeof extensionProtocolCompatibility> & { origin: string | undefined }) | undefined
  private lastUnpaired = 0
  private lastRefused = 0
  private hasPairedBrowser = Object.keys(readBrowserPairings()).length > 0
  private legacyExtensionReloaded = false
  private devExtensionReloadedFor: string | undefined

  constructor(private readonly options: {
    readonly port: number
    readonly storeId: string | undefined
    readonly browsers: BrowserLinks
    readonly registry: TargetRegistry
    readonly sendExtensionBestEffort: (command: ExtensionCommandInput, link?: BrowserLink) => void
    readonly clearLiveExtensionState: (key: string, reason: string) => void
    readonly browsersChanged: () => void
    readonly cdpClientCount: () => number
  }) {}

  rejectedProtocol(): ReturnType<typeof extensionProtocolCompatibility> | undefined {
    return this.mismatch ?? (fs.existsSync(oldStoreMarker()) ? extensionProtocolCompatibility(2) : undefined)
  }

  mismatchAdvice(version: number | null | undefined): string {
    return extensionProtocolAdvice(
      version,
      { install: installCommand() },
      !this.mismatch || this.mismatch.origin === `chrome-extension://${this.options.storeId}`
        ? "store"
        : this.mismatch.origin === stableUnpackedExtensionOrigin
          ? "unpacked"
          : undefined,
    )
  }

  revokeBrowser(key: string): boolean {
    this.hasPairedBrowser = Object.keys(readBrowserPairings()).length > 0
    const links = this.options.browsers.list().filter((link) => link.key === key)
    for (const link of links) link.socket.close(4006, "Pairing revoked: run `pair` and enter the code to pair again")
    if (links.length) relayLog("extension.revoked", { browser: links.map((link) => link.id).join(", ") })
    return links.length > 0
  }

  reloadOutdatedDevExtension(link: BrowserLink): void {
    const folderBuild = installedDevExtension()?.build
    if (!folderBuild || !link.rpc.connected || link.origin !== stableUnpackedExtensionOrigin) return
    if (link.build === folderBuild || this.devExtensionReloadedFor === folderBuild) return
    this.devExtensionReloadedFor = folderBuild
    relayLog("extension.dev_reload", { browser: link.id, from: link.build, to: folderBuild })
    this.options.sendExtensionBestEffort({ method: "runtime.reload" }, link)
  }

  resolveSessionBrowser(requested?: string, session?: OpenCodeBrowserSession): BrowserLink | { error: string; unavailable?: true } {
    const { browsers } = this.options
    if (session) {
      const key = session.browser?.key
      if (!key) return { error: `Session ${session.id} has no identifiable browser in its saved catalog. Start a new session and select its browser.` }
      const bound = browsers.byKey(key)
      const belongs = `Session ${session.id} belongs to browser '${bound?.id ?? session.browser?.id ?? key}'`
      if (bound?.rpc.protocolCompatible === false) return { error: `${belongs}. ${extensionProtocolAdvice(bound.rpc.protocolVersion, { install: installCommand() })}` }
      if (!bound?.rpc.connected) {
        const recovery = browserToken(key) ? "which isn't connected. Reconnect it"
          : legacyPairingCode() ? "which isn't connected. Reconnect it (pair it again if revoked)" : "whose pairing was revoked. Pair it again"
        const rejected = !browsers.connected && this.rejectedProtocol()
        if (rejected) return { error: `${belongs}, which isn't connected. ${this.mismatchAdvice(rejected.version)}`, unavailable: true }
        return { error: `${belongs}, ${recovery} or start a new session.`, unavailable: true }
      }
      if (requested && browsers.byId(requested)?.key !== key) return { error: `${belongs}. Start a new session to use '${requested}'.` }
      return bound
    }
    const link = requested ? browsers.byId(requested) : browsers.defaultLink()
    if (link) return link
    const rejected = !browsers.connected && this.rejectedProtocol()
    if (rejected) return { error: this.mismatchAdvice(rejected.version), unavailable: true }
    if (!requested) return { error: "No browser is connected. Connect a browser before starting a session.", unavailable: true }
    const connected = browsers.list().map((browser) => `${browser.id} (${browser.name})`).join(", ")
    return { error: `No connected browser is called "${requested}". ${connected ? `Connected: ${connected}.` : "No browser is connected."}` }
  }

  extensionStatus(): Pick<ExtensionStatus,
    "connected" | "pairingState" | "nextStep" | "version" | "build" | "origin" | "protocolVersion" | "protocolCompatible" | "protocolLegacy" | "browsers" | "rejectedConnections" | "pairingFailures" | "cdpClients" | "processFaults"
  > {
    const { browsers, registry, storeId } = this.options
    const link = browsers.defaultLink()
    const rejected = link ? undefined : this.rejectedProtocol()
    const recent = Date.now() - 65_000
    const pairingState = browsers.connected ? "connected" : rejected ? "incompatible" : this.lastRefused > recent ? "refused" : this.lastUnpaired > recent ? "unpaired" : this.hasPairedBrowser ? "paired-offline" : "not-seen"
    const nextStep = pairingState === "connected" ? undefined
      : pairingState === "incompatible" ? this.mismatchAdvice(rejected?.version)
      : pairingState === "refused" || pairingState === "unpaired" ? `${pairingState === "refused" ? "Browse refused the pairing attempt" : "Browse is installed but not paired"}. Run \`${cliCommand("install")}\` again to pair it, or run \`${cliCommand("pair")}\` and enter the new code in Browse's Options.`
      : pairingState === "paired-offline" ? "Open the browser profile already paired with Browse and enable the extension; it reconnects automatically."
      : `No browser has contacted this relay yet. If Browse is installed, open that browser and run \`${cliCommand("install")}\` to pair it. Otherwise ${storeId ? `add Browse from ${storeUrl(storeId)}` : `follow the extension steps in \`${installCommand()}\``}.`
    return {
      connected: browsers.connected,
      pairingState,
      ...(nextStep ? { nextStep } : {}),
      version: link?.rpc.version ?? null,
      build: link?.build ?? null,
      origin: link?.origin ?? this.mismatch?.origin ?? null,
      protocolVersion: link?.rpc.protocolVersion ?? rejected?.version ?? null,
      protocolCompatible: link?.rpc.protocolCompatible ?? rejected?.compatible ?? null,
      protocolLegacy: link?.rpc.protocolLegacy ?? null,
      browsers: browsers.list().map((browser) => ({
        id: browser.id,
        name: browser.name,
        default: browser === link,
        connected: browser.rpc.connected,
        version: browser.rpc.version ?? null,
        tabs: registry.listRootTargets().filter((target) => browsers.ownerKey(target.tabId) === browser.key).length,
      })),
      rejectedConnections: this.rejectedExtensionConnections,
      pairingFailures: this.pairingFailures,
      cdpClients: this.options.cdpClientCount(),
      processFaults: relayProcessFaultSummary(),
    }
  }

  handleConnection(
    socket: WebSocket,
    request: http.IncomingMessage,
    handlers: {
      readonly onRecordingBinary: (frame: Buffer) => void
      readonly onMessage: (link: BrowserLink, raw: string) => void
    },
  ): void {
    const { browsers } = this.options
    let handshaken = false
    let link: BrowserLink | undefined
    const computer = computerName(request)
    let waiting: { readonly data: RawData; readonly isBinary: boolean }[] | undefined
    const handle = (data: RawData, isBinary: boolean) => {
      if (!link || browsers.ofSocket(socket) !== link || !link.rpc.acceptsEvents) return
      if (isBinary) {
        try {
          const frame = decodeRecordingFrame(rawDataToBuffer(data))
          handlers.onRecordingBinary(Buffer.from(encodeRecordingFrame({ ...frame, tabId: browsers.relayTabId(link, frame.tabId) })))
        } catch {
          socket.close(1002, "Invalid recording frame")
        }
        return
      }
      handlers.onMessage(link, data.toString())
    }
    let challenge: Challenge | undefined
    socket.on("message", (data, isBinary) => {
      try {
        if (waiting) {
          waiting.push({ data, isBinary })
          return
        }
        if (!handshaken) {
          if (socket.readyState !== WebSocket.OPEN) return
          const message = isBinary ? undefined : parseJsonObject(data.toString())
          if (!message || !isExtensionEvent(message)) {
            socket.close(4002, "Extension hello required")
            return
          }
          if (!challenge) {
            if (message.method === "protocol" || message.method === "hello") {
              const protocol = extensionProtocolCompatibility(message.params?.protocolVersion)
              if (!protocol.compatible) {
                const origin = headerValue(request.headers.origin)
                this.mismatch = { ...protocol, origin }
                const offerReload = message.method === "protocol" && protocol.version !== null && protocol.version < minExtensionProtocolVersion && origin === stableUnpackedExtensionOrigin && isLocalPeer(request.socket) && fromCheckout()
                socket.close(4003, offerReload ? checkoutReloadPrefix + opencodeBrowserBuildId : `Extension protocol incompatible: ${(protocol.version ?? 0) > extensionProtocolVersion ? "extension-newer" : "extension-older"}`)
                return
              }
              this.mismatch = undefined
              if (fs.existsSync(oldStoreMarker())) fs.rmSync(oldStoreMarker(), { force: true })
              if (message.method === "protocol") {
                if (message.params?.unpaired === true) {
                  this.lastUnpaired = Date.now()
                  socket.close(1000, "Waiting for pairing")
                }
                return
              }
            }
            challenge = this.challengeExtension(socket, message, headerValue(request.headers.origin))
            return
          }
          if (challenge.code) {
            this.exchangeCode(socket, challenge, message)
            return
          }
          const proof = message.method === "auth.response" ? getString(message.params, "proof") : undefined
          if (challenge.expected === undefined || !secretsEqual(challenge.expected, proof)) {
            this.pairingRefused()
            relayLog("extension.rejected", { reason: "pairing failed", mode: challenge.mode, profile: getString(getObject(challenge.hello.params), "profileName") })
            socket.close(4006, "Pairing failed: this browser isn't paired with this relay")
            return
          }
          if (challenge.issue) issueBrowserToken(challenge.key, undefined, Date.now(), challenge.issue)
          handshaken = true
          this.hasPairedBrowser = true
          this.lastUnpaired = this.lastRefused = 0
          const hello = challenge.hello
          waiting = []
          void computer.then((name) => {
            const queued = waiting ?? []
            waiting = undefined
            if (socket.readyState !== WebSocket.OPEN) return
            link = this.acceptExtensionHello(socket, hello, headerValue(request.headers.origin), name, isLocalPeer(request.socket))
            if (!link) {
              socket.close(4002, "Extension hello required")
              return
            }
            for (const queuedMessage of queued) {
              try {
                handle(queuedMessage.data, queuedMessage.isBinary)
              } catch (error) {
                console.error("Extension message handling failed", error)
              }
            }
          })
          return
        }
        handle(data, isBinary)
      } catch (error) {
        console.error("Extension message handling failed", error)
      }
    })
    socket.on("error", (error) => {
      relayLog("extension.error", { error: error.message, code: (error as NodeJS.ErrnoException).code })
    })
    socket.on("close", (code, reason) => {
      const gone = browsers.disconnect(socket)
      relayLog("extension.close", { code, reason: reason.toString() || undefined, browser: gone?.id, current: gone !== undefined })
      if (gone) {
        this.options.clearLiveExtensionState(gone.key, "Extension disconnected")
        this.options.browsersChanged()
      }
    })
  }

  private pairingRefused(): void {
    this.pairingFailures += 1
    this.lastRefused = Date.now()
  }

  private challengeExtension(socket: WebSocket, message: JsonObject, origin: string | undefined): Challenge | undefined {
    const { port } = this.options
    if (message.method !== "hello") {
      socket.close(4002, "Extension hello required")
      return undefined
    }
    const params = getObject(message.params)
    const pairing = getObject(params?.pairing)
    const extensionNonce = getString(pairing, "nonce")
    if (extensionNonce === undefined) {
      this.pairingRefused()
      relayLog("extension.rejected", { reason: "no pairing (extension too old)", version: getString(params, "version") })
      if (!this.legacyExtensionReloaded && origin === stableUnpackedExtensionOrigin) {
        this.legacyExtensionReloaded = true
        socket.send(JSON.stringify({ id: 0, method: "runtime.reload" }))
      }
      socket.close(4005, "Pairing required: update Browse")
      return undefined
    }
    if (!/^[A-Za-z0-9_-]{22,128}$/.test(extensionNonce)) {
      socket.close(4002, "Invalid pairing nonce")
      return undefined
    }
    const requested = getString(pairing, "mode")
    const mode = requested === "token" || requested === "code" || requested === "legacy" ? requested : "old"
    const key = getString(params, "profileId")
    if (mode !== "old" && (key === undefined || !/^[\w-]{1,64}$/.test(key))) {
      socket.close(4002, "Invalid profile id")
      return undefined
    }
    const refuse = (reason: string, text: string) => {
      this.pairingRefused()
      relayLog("extension.rejected", { reason, mode, profile: getString(params, "profileName") })
      socket.close(4006, text)
      return undefined
    }
    const relayNonce = crypto.randomBytes(32).toString("base64url")
    const protocol = { version: extensionProtocolVersion, min: minExtensionProtocolVersion }
    const base = { mode, hello: message, key: key ?? "", extensionNonce, relayNonce } as const
    if (mode === "token") {
      const token = browserToken(key!)
      if (token === undefined) return refuse("not paired", "Not paired: run `pair` on the relay's computer and enter the code")
      socket.send(JSON.stringify({ method: "auth.challenge", params: { nonce: relayNonce, proof: pairingProof(token, "relay", port, relayNonce, extensionNonce), protocol } }))
      return { ...base, expected: pairingProof(token, "extension", port, extensionNonce, relayNonce) }
    }
    if (mode === "old") {
      const code = legacyPairingCode()
      if (code === undefined) return refuse("old extension, no shared code", "Pairing failed: update Browse, then pair it with the code `pair` prints")
      socket.send(JSON.stringify({ method: "auth.challenge", params: { nonce: relayNonce, proof: legacyPairingProof(code, "relay", port, relayNonce, extensionNonce), protocol } }))
      return { ...base, expected: legacyPairingProof(code, "extension", port, extensionNonce, relayNonce) }
    }
    const exchange = ecdhExchange(getString(pairing, "ecdh") ?? "")
    if (!exchange) {
      socket.close(4002, "Invalid pairing key")
      return undefined
    }
    const transcript: HandshakeTranscript = { port, extensionNonce, relayNonce, extensionKey: getString(pairing, "ecdh")!, relayKey: exchange.publicKey }
    if (mode === "code") {
      socket.send(JSON.stringify({ method: "auth.challenge", params: { nonce: relayNonce, ecdh: exchange.publicKey, protocol } }))
      return { ...base, code: { secret: exchange.secret, transcript } }
    }
    const legacy = legacyPairingCode()
    if (legacy === undefined) return refuse("shared code retired", "The old pairing code is no longer accepted: run `pair` and enter the new code")
    const session = pairingSessionKey(legacy, exchange.secret, transcript)
    const token = newBrowserToken()
    relayLog("extension.pairing", { mode })
    socket.send(JSON.stringify({
      method: "auth.challenge",
      params: { nonce: relayNonce, ecdh: exchange.publicKey, proof: sessionProof(session, "relay"), wrapped: wrapToken(session, token), protocol },
    }))
    return { ...base, expected: pairingProof(token, "extension", port, extensionNonce, relayNonce), issue: token }
  }

  private exchangeCode(socket: WebSocket, challenge: Challenge, message: JsonObject): void {
    const exchange = challenge.code!
    challenge.code = undefined
    const proof = message.method === "auth.code" ? getString(getObject(message.params), "proof") : undefined
    const match = proof === undefined
      ? undefined
      : pendingPairingCodeKeys()
          .map((codeKey) => ({ codeKey, session: pairingSessionKey(codeKey, exchange.secret, exchange.transcript) }))
          .find(({ session }) => secretsEqual(sessionProof(session, "extension"), proof))
    if (!match) {
      this.pairingRefused()
      const exhausted = recordPairingFailure()
      relayLog("extension.rejected", { reason: "wrong pairing code", exhausted, profile: getString(getObject(challenge.hello.params), "profileName") })
      socket.close(4006, exhausted ? "Too many wrong codes: run `pair` for a new one" : "Pairing failed: that code is wrong, used or expired")
      return
    }
    const receipt = consumePairingCode(match.codeKey)
    const token = issueBrowserToken(challenge.key, undefined, Date.now(), undefined, receipt)
    relayLog("extension.paired", { profile: getString(getObject(challenge.hello.params), "profileName") })
    socket.send(JSON.stringify({ method: "auth.token", params: { proof: sessionProof(match.session, "relay"), wrapped: wrapToken(match.session, token) } }))
    challenge.expected = pairingProof(token, "extension", this.options.port, challenge.extensionNonce, challenge.relayNonce)
  }

  private acceptExtensionHello(socket: WebSocket, message: JsonObject, origin: string | undefined, computer: string, local: boolean): BrowserLink | undefined {
    if (!isExtensionEvent(message) || message.method !== "hello") {
      return undefined
    }
    const { browsers } = this.options
    const protocol = extensionProtocolCompatibility(message.params?.protocolVersion)
    const key = getString(message.params, "profileId") ?? crypto.randomUUID()
    const name = getString(message.params, "name")?.trim().slice(0, 60) || `${getString(message.params, "browser")?.trim() || "Browser"} on ${computer}`
    const { link, replaced } = browsers.connect({ key, name, socket })
    if (replaced) {
      replaced.socket.close(4001, "Extension replaced")
      this.options.clearLiveExtensionState(replaced.key, "Extension replaced")
    }
    link.rpc.markHandshake(getString(message.params, "version"), message.params?.protocolVersion)
    link.build = getString(message.params, "build")
    link.origin = origin
    link.local = local
    if (local) {
      setTimeout(() => {
        if (browsers.ofSocket(socket) === link) this.reloadOutdatedDevExtension(link)
      }, 2_000).unref()
    }
    relayLog("extension.connected", {
      browser: link.id,
      name: link.name,
      version: getString(message.params, "version"),
      build: link.build,
      protocol: protocol.version,
      generation: link.generation,
      browsers: browsers.list().length,
    })
    this.options.browsersChanged()
    try {
      touchBrowserPairing(key, { id: link.id, name: link.name })
    } catch {}
    return link
  }
}
