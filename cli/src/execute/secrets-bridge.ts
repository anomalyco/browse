import { Effect } from "effect"
import type { ElementHandle, Locator, Page } from "patchright-core"
import { checkUrl, parseOriginPatterns } from "../auth/domain-policy.ts"
import type * as NetworkCapture from "../network-capture.ts"
import type { ExecuteAftermath, ExecuteLogEntry } from "../relay/schema.ts"
import * as SiteSecrets from "../auth/site-secrets.ts"
import type { TypeSecretOptions, TypeSecretResult } from "./code-runner.ts"

const isOpaqueDocumentUrl = (url: string): boolean => /^(?:about|data|blob):/i.test(url)

const frameOrigin = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return url.slice(0, 200)
  }
}

const elementHasFocus = (handle: ElementHandle): Promise<boolean> =>
  handle.evaluate((node) => {
    const element = node as Element
    return element.ownerDocument.activeElement === element || element.contains(element.ownerDocument.activeElement)
  })

export class ExecuteSecretsBridge {
  /** Values typed with secrets.type() in this sandbox, mapped to their secret's name, for redaction. */
  private readonly typedSecrets = new Map<string, string>()

  constructor(private readonly deps: {
    readonly networkCapture: NetworkCapture.Recorder
    readonly allowedOrigins: () => readonly string[] | undefined
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
  async typeSecret(page: Page, target: Locator | string, name: string, options: TypeSecretOptions = {}): Promise<TypeSecretResult> {
    if (typeof name !== "string" || !name) throw new Error("secrets.type(target, name): name must be the name of a stored secret")
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
        const origin = frameOrigin(url)
        const decision = checkUrl(url, secretRules, { httpsOnlyWithoutScheme: true })
        if (!decision.allowed || isOpaqueDocumentUrl(url)) {
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
      if (!(await elementHasFocus(handle))) {
        throw new Error("secrets.type: target_not_editable: the field did not keep focus. Nothing was typed.")
      }
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
}
