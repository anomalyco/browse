/**
 * Passkeys in agent tabs, signed by Deadbolt.
 *
 * In tabs an agent session opened (never the user's own or lent tabs), and only while Browse is connected to Deadbolt,
 * the relay adds a CDP binding (Runtime.addBinding, under a random name) and a page-world script
 * (Page.addScriptToEvaluateOnNewDocument) to the tab's root target. Without Runtime.enable (which pages can detect)
 * Chrome adds a binding only to the documents that exist when it is added, so the relay adds it again after every
 * main-frame navigation. The script runs before any page script in every frame of that target: it takes the binding
 * off the global object once it shows up, and in the top frame only wraps `navigator.credentials.get`. Page scripts
 * can still reach the binding in the moment between a navigation and that, so the relay trusts nothing it receives. A request with `publicKey` (and no conditional mediation) goes to the
 * relay; everything else goes to the browser as before.
 *
 * The page can call the binding (through the wrapper), so everything it sends is untrusted: the relay validates the
 * payload's shape and sizes, takes the origin from CDP (Page.getFrameTree, the top frame's security origin), checks that
 * the call came from the top frame's main world, the tab's session allowlist and the rpId against that origin, and only
 * then asks Deadbolt (`agent-passkey-get`). Deadbolt builds the client data from that origin and signs only with a
 * grant that allows passkeys for the site (UP set, UV not set: no biometric happened). Without a grant, while locked,
 * or on any failure the page's promise rejects with NotAllowedError, so the site falls back to other sign-in methods.
 *
 * Agents can't drive WebAuthn themselves: cdp-guardrails.ts refuses every WebAuthn.* method. The wrapper is visible to
 * pages that look for it (Function.prototype.toString), like any page-world hook.
 */
import { checkUrl, parseOriginPatterns } from "./domain-policy.ts"
import * as Deadbolt from "./deadbolt.ts"
import type { JsonObject } from "./protocol.ts"

type Install = { readonly binding: string; readonly reply: string }

/** A passkey account to offer the agent: never the ref. */
export type PasskeyChoice = { readonly username?: string; readonly displayName?: string }

/** How long a preselected account waits for the tab's next passkey request. */
const selectionTtlMs = 2 * 60_000

export type PasskeyBridgeOptions = {
  /** Sends a CDP command to a tab's root target. */
  readonly send: (tabId: number, method: string, params: JsonObject) => Promise<JsonObject>
  /** The tab's Browse session allowlist (undefined: none). */
  readonly allowedOrigins: (tabId: number) => readonly string[] | undefined
  /** Deadbolt, as this install's client; throws DeadboltError (`not_connected` when there is none). */
  readonly deadbolt?: () => Deadbolt.DeadboltConnection
  /** Whether Browse is connected to Deadbolt at all (default: a client file exists). */
  readonly connected?: () => boolean
  readonly log?: (event: string, fields: Record<string, unknown>) => void
}

const maxPayloadBytes = 64 * 1024

/** The page-world script. `binding` and `reply` are random per tab. */
export function hookSource(binding: string, reply: string): string {
  return `(() => {
  const BINDING = ${JSON.stringify(binding)};
  const REPLY = ${JSON.stringify(reply)};
  // Chrome adds a binding only to the documents that exist when it is added (without Runtime.enable, which pages can
  // detect), so the relay adds it again after every navigation. Take it off the global object as soon as it shows up.
  let send = null;
  const capture = () => {
    if (send) return send;
    const binding = globalThis[BINDING];
    if (typeof binding === "function") {
      send = binding;
      try { delete globalThis[BINDING]; } catch {}
    }
    return send;
  };
  capture();
  document.addEventListener("readystatechange", capture);
  if (window !== window.top) return;
  const container = globalThis.CredentialsContainer && CredentialsContainer.prototype;
  if (!container || typeof container.get !== "function" || globalThis[REPLY]) return;
  const originalGet = container.get;
  const pending = new Map();
  let nextId = 1;
  const toBytes = (value) => value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  const encode = (value) => {
    const bytes = toBytes(value);
    if (!bytes) return null;
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  };
  const decode = (text) => {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  };
  const assertion = (result) => {
    const value = (v) => ({ value: v, enumerable: true });
    const response = Object.create(AuthenticatorAssertionResponse.prototype, {
      clientDataJSON: value(decode(result.client_data_json)),
      authenticatorData: value(decode(result.authenticator_data)),
      signature: value(decode(result.signature)),
      userHandle: value(result.user_handle ? decode(result.user_handle) : null),
    });
    const json = {
      id: result.credential_id, rawId: result.credential_id, type: "public-key", authenticatorAttachment: "platform",
      response: { clientDataJSON: result.client_data_json, authenticatorData: result.authenticator_data, signature: result.signature, ...(result.user_handle ? { userHandle: result.user_handle } : {}) },
      clientExtensionResults: {},
    };
    return Object.create(PublicKeyCredential.prototype, {
      id: value(result.credential_id),
      rawId: value(decode(result.credential_id)),
      type: value("public-key"),
      authenticatorAttachment: value("platform"),
      response: value(response),
      getClientExtensionResults: { value: () => ({}) },
      toJSON: { value: () => json },
    });
  };
  Object.defineProperty(globalThis, REPLY, {
    value: (id, result) => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (result && result.ok) {
        try { entry.resolve(assertion(result.assertion)); } catch (error) { entry.reject(new DOMException("The passkey answer was malformed.", "NotAllowedError")); }
      } else {
        entry.reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
      }
    },
  });
  const get = { get(options) {
    const publicKey = options && options.publicKey;
    if (!publicKey || options.mediation === "conditional" || options.password || options.federated || options.identity || options.otp) return originalGet.call(this, options);
    const challenge = encode(publicKey.challenge);
    if (!challenge) return Promise.reject(new TypeError("publicKey.challenge must be a BufferSource"));
    const allowCredentials = Array.isArray(publicKey.allowCredentials) ? publicKey.allowCredentials.map((credential) => encode(credential && credential.id)).filter(Boolean) : [];
    const signal = options.signal;
    if (signal && signal.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    return new Promise(async (resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      if (signal) signal.addEventListener("abort", () => { if (pending.delete(id)) reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError")); }, { once: true });
      for (let tries = 0; tries < 60 && !capture(); tries++) await new Promise((wake) => setTimeout(wake, 50));
      if (!send) {
        pending.delete(id);
        return reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
      }
      send(JSON.stringify({ id, challenge, rpId: typeof publicKey.rpId === "string" ? publicKey.rpId : undefined, allowCredentials, userVerification: typeof publicKey.userVerification === "string" ? publicKey.userVerification : "preferred" }));
    });
  } }.get;
  Object.defineProperty(container, "get", { value: get, writable: true, configurable: true, enumerable: true });
})();`
}

type PasskeyRequest = {
  readonly id: number
  readonly challenge: string
  readonly rpId?: string
  readonly allowCredentials: readonly string[]
  readonly userVerification: string
}

/** Parses what the page sent; undefined when anything is off. */
export function parsePasskeyRequest(payload: unknown): PasskeyRequest | undefined {
  if (typeof payload !== "string" || payload.length > maxPayloadBytes) return undefined
  let value: Record<string, unknown>
  try {
    value = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  const { id, challenge, rpId, allowCredentials, userVerification } = value
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return undefined
  if (!Deadbolt.isBase64Url(challenge, 1024) || challenge.length < 16) return undefined
  if (rpId !== undefined && (typeof rpId !== "string" || rpId.length > 253 || !/^[a-z0-9.-]+$/i.test(rpId))) return undefined
  if (!Array.isArray(allowCredentials) || allowCredentials.length > 64 || !allowCredentials.every((entry) => Deadbolt.isBase64Url(entry, 1400))) return undefined
  const verification = typeof userVerification === "string" && ["required", "preferred", "discouraged"].includes(userVerification) ? userVerification : "preferred"
  return { id, challenge, ...(rpId ? { rpId: rpId.toLowerCase() } : {}), allowCredentials: allowCredentials as string[], userVerification: verification }
}

/** Whether `rpId` may be used by a page at `origin`: its host, or a parent domain of it (Deadbolt checks the PSL). */
export function rpIdAllowed(origin: string, rpId: string | undefined): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  // WebAuthn needs a secure context: https, or http on a loopback host.
  const secure = url.protocol === "https:" || (url.protocol === "http:" && (host === "localhost" || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host) || host === "[::1]"))
  if (!secure) return false
  if (rpId === undefined) return true
  return host === rpId || (rpId.includes(".") && host.endsWith(`.${rpId}`))
}

export class PasskeyBridge {
  private readonly installs = new Map<number, Install>()
  /** The account the agent chose for a tab's next passkey request (secrets.usePasskey, secrets.signIn). */
  private readonly selections = new Map<number, { readonly site: string; readonly username: string; readonly expiresAt: number }>()
  /** The last time a tab's passkey request found several accounts and none was chosen. */
  private readonly choices = new Map<number, { readonly at: number; readonly choices: readonly PasskeyChoice[] }>()
  private readonly options: PasskeyBridgeOptions

  constructor(options: PasskeyBridgeOptions) {
    this.options = options
  }

  /** Adds the binding and hook to an agent tab's root target, when Browse is connected to Deadbolt. */
  async install(tabId: number): Promise<boolean> {
    const connected = this.options.connected ?? (() => Deadbolt.readClient() !== undefined)
    if (!connected()) return false
    const install = { binding: Deadbolt.randomName("__b"), reply: Deadbolt.randomName("__r") }
    this.installs.set(tabId, install)
    try {
      await this.options.send(tabId, "Runtime.addBinding", { name: install.binding })
      await this.options.send(tabId, "Page.addScriptToEvaluateOnNewDocument", { source: hookSource(install.binding, install.reply), runImmediately: true })
      this.options.log?.("passkey.install", { tabId })
      return true
    } catch (error) {
      this.installs.delete(tabId)
      this.options.log?.("passkey.install.failed", { tabId, error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /** The tab's main frame committed a new document: add the binding to it (see the module comment). */
  navigated(tabId: number): void {
    const install = this.installs.get(tabId)
    if (!install) return
    void this.options.send(tabId, "Runtime.addBinding", { name: install.binding }).catch(() => {})
  }

    /** Preselects the account for the tab's next passkey request on `site` (a host or origin). */
  select(tabId: number, site: string, username: string, now = Date.now()): void {
    this.selections.set(tabId, { site, username, expiresAt: now + selectionTtlMs })
  }

  /** Drops a preselected account that wasn't used. */
  clearSelection(tabId: number): void {
    this.selections.delete(tabId)
  }

  /** The accounts offered when a passkey request in the tab needed a choice at or after `since`. */
  choiceSince(tabId: number, since: number): readonly PasskeyChoice[] | undefined {
    const event = this.choices.get(tabId)
    return event && event.at >= since ? event.choices : undefined
  }

  forget(tabId: number): void {
    this.installs.delete(tabId)
    this.selections.delete(tabId)
    this.choices.delete(tabId)
  }

  /**
   * A debugger event of a tab's root target. Returns true when it is this bridge's binding call (never forward those
   * to clients); the call is answered asynchronously.
   */
  handleEvent(tabId: number, method: string, params: JsonObject | undefined, fromRoot: boolean): boolean {
    if (method !== "Runtime.bindingCalled") return false
    const install = this.installs.get(tabId)
    if (!install || params?.name !== install.binding) return false
    // A binding call from another target (an out-of-process frame) can't happen for a root binding; drop it if it does.
    this.options.log?.("passkey.request", { tabId, fromRoot })
    if (!fromRoot) return true
    const contextId = params.executionContextId
    if (typeof contextId !== "number") return true
    void this.answer(tabId, install, contextId, params.payload)
    return true
  }

  private async answer(tabId: number, install: Install, contextId: number, payload: unknown): Promise<void> {
    const request = parsePasskeyRequest(payload)
    if (!request) {
      this.options.log?.("passkey.refused", { tabId, reason: "malformed request" })
      return
    }
    let result: { ok: true; assertion: Record<string, string> } | { ok: false }
    try {
      result = { ok: true, assertion: await this.assert(tabId, contextId, request) }
      this.options.log?.("passkey.signed", { tabId })
    } catch (error) {
      result = { ok: false }
      this.options.log?.("passkey.refused", { tabId, reason: error instanceof Deadbolt.DeadboltError ? error.code : error instanceof Error ? error.message : "failed" })
    }
    await this.options.send(tabId, "Runtime.evaluate", {
      expression: `globalThis[${JSON.stringify(install.reply)}]?.(${request.id}, ${JSON.stringify(result)})`,
      contextId,
      returnByValue: true,
    }).catch(() => {})
  }

  private async assert(tabId: number, contextId: number, request: PasskeyRequest): Promise<Record<string, string>> {
    // The caller must be the top frame's main world: `window` and `top` are unforgeable, so page script can't fake it.
    const top = await this.options.send(tabId, "Runtime.evaluate", { expression: "window === top", contextId, returnByValue: true })
    if ((top.result as JsonObject | undefined)?.value !== true) throw new Error("not the top frame")
    const tree = await this.options.send(tabId, "Page.getFrameTree", {})
    const frame = (tree.frameTree as JsonObject | undefined)?.frame as JsonObject | undefined
    const url = typeof frame?.url === "string" ? frame.url : ""
    let origin = typeof frame?.securityOrigin === "string" ? frame.securityOrigin : ""
    try {
      if (!origin || origin === "null") origin = new URL(url).origin
    } catch {
      throw new Error("no origin")
    }
    if (!rpIdAllowed(origin, request.rpId)) throw new Error("rpId not allowed for the origin")
    const patterns = this.options.allowedOrigins(tabId)
    if (patterns && patterns.length > 0 && !checkUrl(url, parseOriginPatterns(patterns)).allowed) throw new Error("outside the session allowlist")
    const deadbolt = (this.options.deadbolt ?? (() => Deadbolt.connect()))()
    // An account the agent chose for this tab, on this site, is used once.
    const selection = this.selections.get(tabId)
    this.selections.delete(tabId)
    let login: unknown
    if (selection && selection.expiresAt >= Date.now() && Deadbolt.originOnSite(origin, selection.site)) {
      const passkey = Deadbolt.pickPasskey((await deadbolt.site(origin)).passkeys, selection.username)
      if (!passkey) throw new Deadbolt.DeadboltError("not_granted", `No granted passkey for ${selection.username} on ${selection.site}`)
      login = passkey.ref
    }
    const assertion = await deadbolt.passkeyGet({
      origin,
      ...(request.rpId ? { rpId: request.rpId } : {}),
      challenge: request.challenge,
      allowCredentials: request.allowCredentials,
      userVerification: request.userVerification,
      ...(login !== undefined ? { login } : {}),
    }).catch((error: unknown) => {
      if (error instanceof Deadbolt.DeadboltError && error.code === "choose_passkey") {
        const offered = (error.detail.choices ?? []).map((choice) => ({
          ...(choice.username ? { username: choice.username } : {}),
          ...(choice.displayName ? { displayName: choice.displayName } : {}),
        }))
        this.choices.set(tabId, { at: Date.now(), choices: offered })
      }
      throw error
    })
    for (const value of [assertion.credentialId, assertion.clientDataJson, assertion.authenticatorData, assertion.signature, assertion.userHandle ?? ""]) {
      if (!Deadbolt.isBase64Url(value, 16_384)) throw new Error("Deadbolt's assertion isn't base64url")
    }
    return {
      credential_id: assertion.credentialId,
      client_data_json: assertion.clientDataJson,
      authenticator_data: assertion.authenticatorData,
      signature: assertion.signature,
      ...(assertion.userHandle ? { user_handle: assertion.userHandle } : {}),
    }
  }
}
