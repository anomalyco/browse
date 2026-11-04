import { Effect } from "effect"
import type { ElementHandle, Locator, Page } from "patchright-core"
import * as Deadbolt from "../deadbolt.ts"
import { checkUrl, parseOriginPatterns } from "../domain-policy.ts"
import type * as NetworkCapture from "../network-capture.ts"
import type { PasskeyChoice } from "../passkey-bridge.ts"
import type { ExecuteAftermath, ExecuteLogEntry } from "../relay-schema.ts"
import * as SignIn from "../sign-in.ts"
import * as SiteSecrets from "../site-secrets.ts"
import { challengeWaitMs, detectChallenge, type TypeDeadboltResult, type TypeSecretOptions, type TypeSecretResult } from "./code-runner.ts"
import { pageTargetId } from "./page-recovery.ts"

export class ExecuteSecretsBridge {
  /** Values typed with secrets.type() in this sandbox, mapped to their secret's name, for redaction. */
  private readonly typedSecrets = new Map<string, string>()
  private deadboltConnection: Deadbolt.DeadboltConnection | undefined
  /** Request interception, page scripts or raw CDP this sandbox's code set up (pageHookCall); Deadbolt values aren't typed then. */
  readonly pageHooks = new Set<string>()

  constructor(private readonly deps: {
    readonly networkCapture: NetworkCapture.Recorder
    readonly allowedOrigins: () => readonly string[] | undefined
    readonly passkeys?: {
      readonly select: (targetId: string, site: string, username: string) => void
      readonly choiceSince: (targetId: string, since: number) => readonly PasskeyChoice[] | undefined
    }
    readonly addWarningOnce: (warning: string | undefined) => void
  }) {}

  private redactTypedSecrets(text: string): string {
    let output = text
    for (const [value, name] of [...this.typedSecrets].sort(([left], [right]) => right.length - left.length)) {
      output = output.split(value).join(`[secret ${name}]`)
    }
    return output
  }

  redactOutputText(text: string): string {
    return this.redactTypedSecrets(this.deps.networkCapture.redactText(text))
  }

  redactOutputUrl(url: string): string {
    return this.redactTypedSecrets(this.deps.networkCapture.redactUrl(url))
  }

  redactOutputValue(value: unknown): unknown {
    const redacted = this.deps.networkCapture.redactValue(value)
    if (this.typedSecrets.size === 0) return redacted
    const visit = (item: unknown, depth: number): unknown => {
      if (typeof item === "string") return this.redactTypedSecrets(item)
      if (typeof item === "number" && this.typedSecrets.has(String(item))) return `[secret ${this.typedSecrets.get(String(item))}]`
      if (depth > 32 || item === null || typeof item !== "object" || Buffer.isBuffer(item)) return item
      if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1))
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) return item
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry, depth + 1)]))
    }
    return visit(redacted, 0)
  }

  redactCaptureLogs(logs: readonly ExecuteLogEntry[]): readonly ExecuteLogEntry[] {
    return logs.map((log) => ({
      ...log,
      text: this.redactOutputText(log.text),
      ...(log.location ? {
        location: { ...log.location, url: this.redactOutputUrl(log.location.url) },
      } : {}),
    }))
  }

  redactCaptureAftermath(aftermath: ExecuteAftermath): ExecuteAftermath {
    return {
      ...aftermath,
      startUrl: aftermath.startUrl ? this.redactOutputUrl(aftermath.startUrl) : aftermath.startUrl,
      endUrl: aftermath.endUrl ? this.redactOutputUrl(aftermath.endUrl) : aftermath.endUrl,
      navigations: aftermath.navigations.map((url) => this.redactOutputUrl(url)),
      ...(aftermath.challenge ? { challenge: { ...aftermath.challenge, url: this.redactOutputUrl(aftermath.challenge.url) } } : {}),
    }
  }

  /**
   * secrets.type(target, name): type a stored site secret into a field without the value entering the realm. The
   * field's frame URL (Playwright's frame tree, fed by CDP, not page script) must match the secret's allowed origins,
   * and the session's allowlist when it has one, right before the value is inserted.
   */
  async typeSecret(page: Page, target: Locator | string, name: string, options: TypeSecretOptions = {}): Promise<TypeSecretResult | TypeDeadboltResult> {
    if (typeof name !== "string" || !name) throw new Error("secrets.type(target, name): name must be the name of a stored secret")
    const deadboltSpec = Deadbolt.parseDeadboltName(name)
    if (deadboltSpec) return await this.typeDeadboltSecret(page, target, name, deadboltSpec, options)
    const secret = await Effect.runPromise(SiteSecrets.readSecret(name)).catch((error: unknown) => {
      throw new Error(`secrets.type: ${error instanceof Error ? error.message : "could not read the secret"}`)
    })
    const secretRules = parseOriginPatterns(secret.allowedOrigins)
    const sessionPatterns = this.deps.allowedOrigins()
    const sessionRules = sessionPatterns && sessionPatterns.length > 0 ? parseOriginPatterns(sessionPatterns) : undefined
    const locator = typeof target === "string" ? page.locator(target) : target
    if (!locator || typeof (locator as Locator).elementHandle !== "function") {
      throw new Error("secrets.type(target, name): target must be a selector string or a Locator")
    }
    const handle = await locator.elementHandle({ timeout: options.timeout ?? 10_000 })
    try {
      const frame = await handle.ownerFrame()
      if (!frame) throw new Error(`secrets.type: target_not_editable: the element for ${JSON.stringify(name)} is not in a frame`)
      const checkOrigin = (): string => {
        const url = frame.url()
        let origin: string
        try {
          origin = new URL(url).origin
        } catch {
          origin = url.slice(0, 200)
        }
        const decision = checkUrl(url, secretRules, { httpsOnlyWithoutScheme: true })
        if (!decision.allowed || /^(?:about|data|blob):/i.test(url)) {
          throw new Error(`secrets.type: domain_not_allowed: the field's frame is ${origin}, which is not an allowed origin of secret ${JSON.stringify(name)} (${secret.allowedOrigins.join(", ")}). Nothing was typed.`)
        }
        if (sessionRules && !checkUrl(url, sessionRules).allowed) {
          throw new Error(`secrets.type: domain_not_allowed: the field's frame is ${origin}, which is outside this session's domain allowlist. Nothing was typed.`)
        }
        return origin
      }
      checkOrigin()
      if (!(await handle.isEditable().catch(() => false))) {
        throw new Error(`secrets.type: target_not_editable: the target is not an editable field. Nothing was typed.`)
      }
      if (options.clear !== false) await handle.fill("")
      await handle.focus()
      const focused = await handle.evaluate((element) => element.ownerDocument.activeElement === element || element.contains(element.ownerDocument.activeElement))
      if (!focused) throw new Error("secrets.type: target_not_editable: the field did not keep focus. Nothing was typed.")
      const origin = checkOrigin()
      const urlBefore = frame.url()
      const text = SiteSecrets.secretText(secret)
      // Register first, so a capture or result that sees the value already redacts it.
      this.typedSecrets.set(text, name)
      this.deps.networkCapture.addRedaction(text)
      await frame.page().keyboard.insertText(text)
      if (frame.url() !== urlBefore) {
        this.deps.addWarningOnce(`secrets.type: the field's frame navigated while ${JSON.stringify(name)} was typed; check where it went before submitting.`)
      }
      if (!sessionRules) {
        this.deps.addWarningOnce(`secrets.type typed ${JSON.stringify(name)} in a session without a domain allowlist. A prompt-injected page could steer this session elsewhere after the value is in the page: set one with session_allowlist (or \`session allow\`) before using secrets.`)
      }
      return { typed: true, name, origin, kind: secret.kind }
    } finally {
      await handle.dispose().catch(() => {})
    }
  }

  /**
   * Deadbolt passwords and codes aren't typed into a session whose code set up request interception, request
   * listeners, init scripts, exposed functions or a raw CDP session: those would see the value in the page or on the
   * wire. (Listeners added with page.evaluate can't be told apart from normal page reads; that limit is documented.)
   */
  private refuseWithPageHooks(label: string): void {
    if (this.pageHooks.size === 0) return
    throw new Error(`${label}: page_hooks: this session's code used ${[...this.pageHooks].sort().join(", ")}, which could capture what is typed, so Deadbolt passwords and codes aren't typed here. Reset the session (session_reset) and sign in before setting those up. Nothing was typed.`)
  }

  /** This install's Deadbolt client, reconnected when `deadbolt connect` stored another one. */
  private deadbolt(): Deadbolt.DeadboltConnection {
    const client = Deadbolt.readClient()
    if (!this.deadboltConnection || !client || this.deadboltConnection.client.id !== client.id || this.deadboltConnection.client.token !== client.token) {
      this.deadboltConnection = Deadbolt.connect(client ? { client } : {})
    }
    return this.deadboltConnection
  }

  private sessionAllows(url: string): boolean {
    const patterns = this.deps.allowedOrigins()
    return !patterns || patterns.length === 0 || checkUrl(url, parseOriginPatterns(patterns)).allowed
  }

  /**
   * Types one value of a Deadbolt login into a field, or one character per box into split code boxes. The fields'
   * frame origin (Playwright's CDP-fed frame tree) must be on the login's site and in the session's allowlist; Deadbolt
   * checks the grant and the login's URLs against that origin before it answers. The value is registered for
   * redaction before it is typed and dropped right after.
   */
  private async typeDeadbolt(handles: readonly ElementHandle[], spec: SignIn.LoginSpec, field: Deadbolt.DeadboltField, label: string): Promise<{ readonly origin: string; readonly login: Deadbolt.DeadboltLogin }> {
    if (!["username", "password", "totp"].includes(field)) throw new Error(`${label}: field must be "username", "password" or "totp"`)
    if (handles.length === 0) throw new Error(`${label}: target_not_editable: no field to type into`)
    if (field !== "username") this.refuseWithPageHooks(label)
    const frame = await handles[0]!.ownerFrame()
    if (!frame) throw new Error(`${label}: target_not_editable: the field is not in a frame`)
    for (const handle of handles.slice(1)) {
      if ((await handle.ownerFrame()) !== frame) throw new Error(`${label}: target_not_editable: the code boxes are in different frames`)
    }
    const checkOrigin = (): string => {
      const url = frame.url()
      let origin: string
      try {
        origin = new URL(url).origin
      } catch {
        origin = url.slice(0, 200)
      }
      if (/^(?:about|data|blob):/i.test(url) || !Deadbolt.originOnSite(origin, spec.site)) {
        throw new Error(`${label}: domain_not_allowed: the field's frame is ${origin}, which is not on ${spec.site}. Nothing was typed.`)
      }
      if (!this.sessionAllows(url)) {
        throw new Error(`${label}: domain_not_allowed: the field's frame is ${origin}, which is outside this session's domain allowlist. Nothing was typed.`)
      }
      return origin
    }
    const origin = checkOrigin()
    for (const handle of handles) {
      if (!(await handle.isEditable().catch(() => false))) throw new Error(`${label}: target_not_editable: the target is not an editable field. Nothing was typed.`)
    }
    const connection = this.deadbolt()
    const login = Deadbolt.pickLogin(await connection.logins(origin), spec.site, spec.username, field)
    const values = await connection.fill(origin, login, [field])
    let value = values[field]
    if (!value) throw new Deadbolt.DeadboltError("not_found", `The Deadbolt login for ${spec.site} has no ${field}.`)
    const name = `deadbolt:${spec.site}${login.username ? `/${login.username}` : ""} ${field}`
    try {
      // Register first, so a capture or result that sees the value already redacts it. Usernames aren't secret
      // (secrets_list shows them), so they aren't redacted.
      if (field !== "username") {
        this.typedSecrets.set(value, name)
        this.deps.networkCapture.addRedaction(value)
      }
      const characters = handles.length === 1 ? [value] : Array.from(value)
      if (handles.length > 1 && characters.length !== handles.length) {
        throw new Error(`${label}: target_not_editable: ${handles.length} code boxes for a ${characters.length}-character code. Nothing was typed.`)
      }
      for (const [index, handle] of handles.entries()) {
        await handle.fill("")
        await handle.focus()
        const focused = await handle.evaluate((node) => {
          const element = node as Element
          return element.ownerDocument.activeElement === element || element.contains(element.ownerDocument.activeElement)
        })
        if (!focused) throw new Error(`${label}: target_not_editable: the field did not keep focus.`)
        checkOrigin()
        await frame.page().keyboard.insertText(characters[index]!)
      }
    } finally {
      value = undefined
    }
    if (!this.deps.allowedOrigins()?.length) {
      this.deps.addWarningOnce(`A Deadbolt login was typed in a session without a domain allowlist. A prompt-injected page could steer this session elsewhere after the value is in the page: set one with session_allowlist (or \`session allow\`) before signing in.`)
    }
    return { origin, login }
  }

  /**
   * secrets.type with a Deadbolt login. A username may be typed on its own; a password or code only with
   * `{submit: true}`: typed, submitted (the form's submit control, else Enter) and waited on in the same call, after
   * which password and code inputs left in that frame are emptied, so the value isn't sitting in a page the agent's
   * next call can read. Prefer secrets.signIn().
   */
  private async typeDeadboltSecret(page: Page, target: Locator | string, name: string, spec: SignIn.LoginSpec, options: TypeSecretOptions): Promise<TypeDeadboltResult> {
    const field = options.field ?? "password"
    if (field !== "username" && options.submit !== true) {
      throw new Error(`secrets.type: submit_required: a Deadbolt ${field} is typed only with { submit: true }, which submits the form in the same call and clears the field afterwards. Prefer secrets.signIn(). Nothing was typed.`)
    }
    const locator = typeof target === "string" ? page.locator(target) : target
    if (!locator || typeof (locator as Locator).elementHandle !== "function") {
      throw new Error("secrets.type(target, name): target must be a selector string or a Locator")
    }
    const handle = await locator.elementHandle({ timeout: options.timeout ?? 10_000 })
    const frame = await handle.ownerFrame()
    let typed = false
    try {
      const { origin } = await this.typeDeadbolt([handle], spec, field, "secrets.type").catch((error: unknown) => {
        if (error instanceof Deadbolt.DeadboltError) throw new Error(`secrets.type: ${error.code}: ${error.message} Nothing was typed.`)
        throw error
      })
      typed = true
      if (options.submit !== true) return { typed: true, name, origin, field }
      const submitControl = await handle.evaluateHandle((node) => {
        const form = (node as HTMLInputElement).form
        if (!form) return null
        return form.querySelector("button[type=submit], input[type=submit], button:not([type])")
      })
      const button = submitControl.asElement()
      if (button) await button.click({ timeout: 5_000 }).catch(() => handle.press("Enter"))
      else await handle.press("Enter")
      const progressed = await SignIn.waitForProgress(frame?.page() ?? page, handle, 15_000)
      return { typed: true, name, origin, field, submitted: true, progressed }
    } finally {
      if (typed && field !== "username") await SignIn.clearSecretInputs(frame ? [frame] : [], [handle])
      await handle.dispose().catch(() => {})
    }
  }

  /**
   * secrets.usePasskey({site, username}): the account for the next passkey request (navigator.credentials.get) in
   * the page's tab, used once, for two minutes. Deadbolt still checks the grant; the ref stays in the relay.
   */
  async usePasskey(page: Page, options: { readonly site: string; readonly username: string }): Promise<{ readonly selected: true; readonly site: string; readonly username: string }> {
    const site = typeof options?.site === "string" ? options.site.trim().toLowerCase() : ""
    const username = typeof options?.username === "string" ? options.username.trim() : ""
    if (!site || !username) throw new Error("secrets.usePasskey({ site, username }): site and username are required")
    if (!this.deps.passkeys) throw new Error("secrets.usePasskey: passkeys aren't available in this relay")
    this.deps.passkeys.select(await pageTargetId(page), site, username)
    return { selected: true, site, username }
  }

  /** secrets.signIn(): the whole sign-in in the relay (sign-in.ts); only {status, step, reason} comes back. */
  async signIn(page: Page, options: SignIn.SignInOptions = {}): Promise<SignIn.SignInResult> {
    if (options !== null && typeof options !== "object") throw new Error("secrets.signIn(options): options must be an object like { site, username }")
    const site = typeof options?.site === "string" ? options.site : undefined
    const username = typeof options?.username === "string" ? options.username : undefined
    const timeoutMs = typeof options?.timeoutMs === "number" && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 300_000) : undefined
    return await SignIn.signIn({
      page,
      context: page.context(),
      type: async (handles, spec, field) => (await this.typeDeadbolt(handles, spec, field, "secrets.signIn")).login,
      logins: (origin) => this.deadbolt().logins(origin),
      passkeyAccounts: async (origin) => (await this.deadbolt().site(origin)).passkeys,
      challenge: async (target) => {
        const outcome = await detectChallenge(target, { waitMs: challengeWaitMs() }).catch(() => undefined)
        return outcome && outcome.status === "blocked" ? outcome : undefined
      },
      allowed: (url) => this.sessionAllows(url),
      ...(this.deps.passkeys ? {
        passkeys: {
          select: async (target, passkeySite, passkeyUsername) => this.deps.passkeys!.select(await pageTargetId(target), passkeySite, passkeyUsername),
          choiceSince: async (target, since) => this.deps.passkeys!.choiceSince(await pageTargetId(target), since),
        },
      } : {}),
    }, { ...(site ? { site } : {}), ...(username ? { username } : {}), ...(timeoutMs ? { timeoutMs } : {}) })
  }
}
