/**
 * secrets.signIn(): a whole sign-in with a Deadbolt login inside one execute call, so agent code never runs between a
 * fill and its submit (it can't read `input.value` there) and only `{status, step, reason}` comes back.
 *
 * Each round reads the page (the main frame and same-site frames, in Patchright's isolated world) and acts on the
 * first thing it finds:
 *
 *   captcha or interactive bot check             -> needs_user (hand it to the user with handoff())
 *   one-time code field                           -> the login's TOTP when the page asks for an authenticator code
 *                                                    (single field or split boxes); a code sent by SMS, email or a
 *                                                    call -> needs_user
 *   password field                                -> username (when the same form has an empty one) + password, submit
 *   username / email / identifier field           -> username, submit (identifier-first flows)
 *   "Use password instead" and similar            -> click it
 *   "Sign in with Google"                          -> only when Deadbolt grants a login on accounts.google.com: click,
 *                                                    and sign in there (same tab or popup)
 *   push approval, new-device or "verify it's you" -> needs_user
 *   "Sign in" link on a page without a form       -> click it (once)
 *   nothing left to fill after a submit           -> signed_in
 *
 * Field detection uses what the page declares (autocomplete, type, inputmode, maxlength) and the field's label, name,
 * id, placeholder and aria-label, through open shadow roots. It doesn't handle: closed shadow roots, canvas or
 * image-based keypads, forms that only accept real key events per character beyond split code boxes, security
 * questions, account pickers other than Google's, or SSO providers other than Google (those stop with needs_user).
 */
import type { BrowserContext, ElementHandle, Frame, JSHandle, Page } from "patchright-core"
import { DeadboltError, type DeadboltField, type DeadboltLogin, type DeadboltPasskey, originOnSite, pickPasskey } from "./deadbolt.ts"

export type SignInStatus = "signed_in" | "needs_user" | "needs_choice" | "not_granted" | "failed"
export type SignInStep = "start" | "identifier" | "password" | "code" | "passkey" | "provider" | "verify" | "done"
export type SignInResult = {
  readonly status: SignInStatus
  readonly step: SignInStep
  readonly reason: string
  /** With needs_choice: the passkey accounts to pick from; call again with `username`. */
  readonly choices?: readonly { readonly username?: string; readonly displayName?: string }[]
}

export type SignInOptions = {
  /** The site the login is saved for (a host like `github.com`, or an exact origin). Default: the page's site. */
  readonly site?: string
  /** Which login, when several are granted for the site. */
  readonly username?: string
  /** Overall limit in milliseconds (default 90000). */
  readonly timeoutMs?: number
}

export type LoginSpec = { readonly site: string; readonly username?: string }

export type SignInDeps = {
  readonly page: Page
  readonly context: BrowserContext
  /** Types a Deadbolt value into a field (or split boxes, one character each) after checking its frame origin. */
  readonly type: (handles: readonly ElementHandle[], spec: LoginSpec, field: DeadboltField) => Promise<DeadboltLogin>
  /** Logins granted on an origin (metadata only). */
  readonly logins: (origin: string) => Promise<readonly DeadboltLogin[]>
  /** Passkey accounts on an origin's site (no refs needed here). */
  readonly passkeyAccounts: (origin: string) => Promise<readonly DeadboltPasskey[]>
  /** An interactive bot challenge or block page on the page, if one is showing. */
  readonly challenge: (page: Page) => Promise<{ readonly vendor: string; readonly kind: string } | undefined>
  /** Origins the session may visit; undefined without an allowlist. */
  readonly allowed: (url: string) => boolean
  /** Passkey account choice for the page's tab (passkey-bridge.ts); absent where passkeys aren't answered. */
  readonly passkeys?: {
    readonly select: (page: Page, site: string, username: string) => Promise<void>
    readonly choiceSince: (page: Page, since: number) => Promise<readonly { readonly username?: string; readonly displayName?: string }[] | undefined>
  }
}

const googleSite = "accounts.google.com"
const handoffHint = "Hand it to the user with handoff(\"Finish signing in, then click Continue\"), then check the page."

/** What one read of a frame finds. Elements stay in the page (as handles), never their values. */
type PageState = {
  readonly captcha: string | null
  readonly hasPassword: boolean
  readonly hasUsername: boolean
  readonly usernameFilled: string
  readonly otpCount: number
  readonly hasPasswordToggle: boolean
  readonly hasGoogle: boolean
  readonly hasSignInLink: boolean
  readonly hasPasskeyButton: boolean
  readonly text: string
  readonly errorText: string
}

// Runs in the page (isolated world). Self-contained: no closures over module scope.
const readPageScript = () => {
  const limit = 20_000
  const all: Element[] = []
  const walk = (root: Document | ShadowRoot) => {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (all.length >= limit) return
      all.push(element)
      if (element.shadowRoot) walk(element.shadowRoot)
    }
  }
  walk(document)
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return false
    const style = getComputedStyle(element)
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 0.05) return false
    return !element.closest("[hidden], [inert], [aria-hidden='true']")
  }
  const describe = (element: Element) => {
    const input = element as HTMLInputElement
    const labelled = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "").join(" ")
    return [
      element.getAttribute("aria-label"), labelled, Array.from(input.labels ?? []).map((label) => label.textContent).join(" "),
      input.placeholder, input.name, element.id, element.getAttribute("autocomplete"), element.getAttribute("data-testid"),
    ].filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " ")
  }
  const ownText = (element: Element) => `${(element as HTMLElement).innerText ?? element.textContent ?? ""} ${element.getAttribute("aria-label") ?? ""} ${(element as HTMLInputElement).value && (element as HTMLInputElement).type === "submit" ? (element as HTMLInputElement).value : ""}`.trim().toLowerCase().replace(/\s+/g, " ")
  const inputs = all.filter((element): element is HTMLInputElement => element instanceof HTMLInputElement
    && !element.disabled && !element.readOnly && visible(element)
    && !["hidden", "checkbox", "radio", "submit", "button", "image", "reset", "file", "range", "color", "search"].includes(element.type))
  const autocomplete = (element: HTMLInputElement) => (element.getAttribute("autocomplete") ?? "").toLowerCase()
  const password = inputs.find((element) => element.type === "password" && !/new-password/.test(autocomplete(element))
    && !/confirm|repeat|re-?enter|new password|retype/.test(describe(element)))
  const codeWords = /one[- ]?time|\botp\b|totp|\b2fa\b|\bmfa\b|two[- ]factor|verification|security code|auth\w* code|passcode|\bpin\b|digit|\bcode\b/
  const singleBoxes = inputs.filter((element) => element.maxLength === 1 && element.type !== "password")
  const otpSingle = inputs.find((element) => element !== password && element.maxLength !== 1 && (autocomplete(element).includes("one-time-code")
    || (codeWords.test(describe(element)) && !/zip|postal|promo|coupon|country|area|referral|invite/.test(describe(element)))))
  const otp = singleBoxes.length >= 4 && singleBoxes.length <= 8 ? singleBoxes : otpSingle ? [otpSingle] : []
  const usernameCandidates = inputs.filter((element) => element !== password && !otp.includes(element)
    && ["text", "email", "tel", ""].includes(element.type)
    && (/username|email|webauthn/.test(autocomplete(element)) || element.type === "email"
      || /user|e-?mail|login|identifier|account|phone|handle/.test(describe(element)))
    && !/search|newsletter|subscribe|coupon|promo/.test(describe(element)))
  const form = password?.form ?? null
  const username = usernameCandidates.find((element) => form && element.form === form) ?? usernameCandidates[0] ?? null
  const clickables = all.filter((element) => (element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement
    || element.getAttribute("role") === "button" || element.getAttribute("role") === "link"
    || (element instanceof HTMLInputElement && (element.type === "submit" || element.type === "button"))) && visible(element)
    && !(element as HTMLButtonElement).disabled)
  const byText = (pattern: RegExp) => clickables.find((element) => pattern.test(ownText(element)))
  const field = otp[0] ?? password ?? username ?? null
  const submitFor = (target: Element | null) => {
    if (!target) return null
    const owner = (target as HTMLInputElement).form
    if (owner) {
      const inForm = clickables.filter((element) => (element as HTMLButtonElement).form === owner || owner.contains(element))
      const typed = inForm.find((element) => (element instanceof HTMLButtonElement && element.type === "submit") || (element instanceof HTMLInputElement && element.type === "submit"))
      if (typed) return typed
    }
    const words = /^(sign ?in|log ?in|login|next|continue|verify|submit|confirm|done|weiter|suivant)\b/
    const following = clickables.filter((element) => target.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
    return following.find((element) => words.test(ownText(element))) ?? clickables.find((element) => words.test(ownText(element))) ?? null
  }
  const frames = Array.from(document.querySelectorAll("iframe")).filter(visible)
  const captchaFrame = frames.find((frame) => {
    const src = frame.src
    if (/size=invisible/.test(src) || frame.closest(".grecaptcha-badge")) return false
    if (/challenges\.cloudflare\.com/.test(src)) {
      const response = frame.ownerDocument.querySelector<HTMLInputElement>("input[name='cf-turnstile-response']")
      return !response?.value
    }
    return /\/recaptcha\/(api2|enterprise)\/(anchor|bframe)|hcaptcha\.com|arkoselabs|funcaptcha|geo\.captcha-delivery|captcha/.test(src)
  })
  const captchaWidget = all.find((element) => /^(px-captcha|sec-cpt-if|ddv1-captcha-container)$/.test(element.id) && visible(element))
  const errors = all.filter((element) => (element.getAttribute("role") === "alert" || element.getAttribute("aria-live") === "assertive"
    || /(^|[\s_-])(error|alert|invalid)([\s_-]|$)/i.test(typeof element.className === "string" ? element.className : "")) && visible(element))
  const handles = {
    password: password ?? null,
    username,
    otp,
    submit: submitFor(field),
    passwordToggle: byText(/use (your )?password|(sign|log) ?in with (a |your )?password|enter (your )?password( instead)?|password instead|try another way/) ?? null,
    google: byText(/(sign ?in|log ?in|continue|sign ?up) (with|using|via) google|^google$/) ?? null,
    signInLink: byText(/^(sign ?in|log ?in|login)$/) ?? null,
    passkeyButton: byText(/(sign ?in|log ?in|continue) (with|using) (a |your )?passkey|use (a |your )?passkey|^passkey$/) ?? null,
  }
  const state = {
    captcha: captchaFrame ? captchaFrame.src.slice(0, 120) : captchaWidget ? `#${captchaWidget.id}` : null,
    hasPassword: Boolean(password),
    hasUsername: Boolean(username),
    usernameFilled: username?.value ?? "",
    otpCount: otp.length,
    hasPasswordToggle: Boolean(handles.passwordToggle),
    hasGoogle: Boolean(handles.google),
    hasSignInLink: Boolean(handles.signInLink),
    hasPasskeyButton: Boolean(handles.passkeyButton),
    text: `${document.title}\n${document.body?.innerText ?? ""}`.slice(0, 4000).toLowerCase(),
    errorText: errors.map((element) => (element as HTMLElement).innerText ?? "").join(" ").replace(/\s+/g, " ").trim().slice(0, 200),
  }
  return { state, handles }
}

type Read = { readonly frame: Frame; readonly state: PageState; readonly handles: JSHandle }

async function element(read: Read, name: "password" | "username" | "submit" | "passwordToggle" | "google" | "signInLink" | "passkeyButton"): Promise<ElementHandle | undefined> {
  const property = await read.handles.getProperty(name)
  return property.asElement() ?? undefined
}

async function otpElements(read: Read): Promise<ElementHandle[]> {
  const list = await read.handles.getProperty("otp")
  const properties = await list.getProperties()
  const elements: ElementHandle[] = []
  for (const [key, value] of properties) {
    if (!/^\d+$/.test(key)) continue
    const handle = value.asElement()
    if (handle) elements.push(handle as ElementHandle)
  }
  return elements
}

async function readFrame(frame: Frame): Promise<Read | undefined> {
  try {
    const handles = await frame.evaluateHandle(readPageScript)
    const state = await (await handles.getProperty("state")).jsonValue() as PageState
    return { frame, state, handles: await handles.getProperty("handles") }
  } catch {
    return undefined
  }
}

const actionable = (state: PageState) => Boolean(state.captcha || state.otpCount || state.hasPassword || state.hasUsername || state.hasPasswordToggle || state.hasGoogle || state.hasPasskeyButton)

/** The main frame, or the first same-site frame with something to act on (login forms embedded in an iframe). */
async function readPage(page: Page, site: string): Promise<Read | undefined> {
  const main = await readFrame(page.mainFrame())
  if (main && actionable(main.state)) return main
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue
    let origin: string
    try {
      origin = new URL(frame.url()).origin
    } catch {
      continue
    }
    if (!originOnSite(origin, site)) continue
    const read = await readFrame(frame)
    if (read && actionable(read.state)) return read
  }
  return main
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The page's site when none is given: an exact origin for local hosts, else roughly its registrable domain. */
export function defaultSite(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol === "http:" || /^[\d.]+$/.test(host) || host.includes(":") || host === "localhost" || host.endsWith(".localhost")) return parsed.origin
  const labels = host.split(".")
  const twoLevel = labels.length >= 3 && /^(co|com|org|net|gov|ac|edu|ne|or)$/.test(labels.at(-2)!) && labels.at(-1)!.length === 2
  return labels.slice(twoLevel ? -3 : -2).join(".")
}

/** What a one-time-code page is asking for, from its text. */
export function codeKind(text: string): "totp" | "sent" | "unknown" {
  if (/authenticator|authentication app|auth app|google authenticator|\btotp\b|one-time password app|security key app|2fa app|your app/.test(text)) return "totp"
  if (/\bsms\b|text message|texted|we (just )?sent|sent (a|the|you a) code|sent to|check your (email|inbox|phone)|by email|via email|phone call|call you|ending in|whatsapp/.test(text)) return "sent"
  return "unknown"
}

function verificationKind(text: string): string | undefined {
  if (/approve (the|this|your) (sign|log)|check your phone|tap yes|duo push|push notification|approve (it|the request)|waiting for (your )?approval|open the .{0,20} app on your/.test(text)) return "push_approval"
  if (/new device|unrecognized device|unfamiliar device|verify (it'?s|that it'?s) you|confirm (it'?s|your identity|that it'?s you)|verify your identity|security check/.test(text)) return "new_device"
  if (/security question/.test(text)) return "security_question"
  return undefined
}

function needsUser(step: SignInStep, why: string): SignInResult {
  return { status: "needs_user", step, reason: `${why} ${handoffHint}` }
}

async function clickHandle(handle: ElementHandle): Promise<void> {
  await handle.scrollIntoViewIfNeeded().catch(() => {})
  await handle.click({ timeout: 5_000 }).catch(async () => {
    await handle.evaluate((node) => (node as HTMLElement).click())
  })
}

/** After a submit or click: until the URL changes, the field goes away, or `timeoutMs`. */
async function waitForProgress(page: Page, field: ElementHandle | undefined, timeoutMs: number): Promise<boolean> {
  const url = page.url()
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    await delay(250)
    if (page.isClosed()) return true
    if (page.url() !== url) {
      await page.waitForLoadState("domcontentloaded", { timeout: Math.max(1, until - Date.now()) }).catch(() => {})
      return true
    }
    if (field && !(await field.isVisible().catch(() => false))) return true
  }
  return false
}

async function submit(read: Read, field: ElementHandle): Promise<void> {
  const button = await element(read, "submit")
  if (button) await clickHandle(button)
  else await field.press("Enter")
}

/** Runs a sign-in; never throws for page or Deadbolt problems, only reports them. */
export async function signIn(deps: SignInDeps, options: SignInOptions = {}): Promise<SignInResult> {
  const timeoutMs = options.timeoutMs ?? 90_000
  const deadline = Date.now() + timeoutMs
  let page = deps.page
  if (options.site !== undefined && (typeof options.site !== "string" || !options.site)) return { status: "failed", step: "start", reason: "site must be a host like example.com or an origin" }
  const startSite = options.site?.toLowerCase() ?? defaultSite(page.url())
  if (!startSite) return { status: "failed", step: "start", reason: "The page isn't on a website; navigate to the site's sign-in page first, or pass {site}." }
  const siteSpec: LoginSpec = { site: startSite, ...(options.username ? { username: options.username } : {}) }
  try {
    const onSite = (() => {
      try {
        return originOnSite(new URL(page.url()).origin, startSite)
      } catch {
        return false
      }
    })()
    if (!onSite) {
      const start = /^https?:\/\//.test(startSite) ? startSite : `https://${startSite}/`
      await page.goto(start, { waitUntil: "domcontentloaded", timeout: Math.min(30_000, timeoutMs) })
    }
    // A username names the passkey too: the tab's next passkey request uses that account.
    if (options.username && deps.passkeys) await deps.passkeys.select(page, startSite, options.username).catch(() => {})
    return await run(deps, page, siteSpec, deadline, 0)
  } catch (error) {
    return fromError(error, "start")
  } finally {
    // The account was for this sign-in only.
    if (options.username && deps.passkeys && !page.isClosed()) await deps.passkeys.select(page, startSite, "").catch(() => {})
  }
}

function fromError(error: unknown, step: SignInStep): SignInResult {
  if (error instanceof DeadboltError) {
    if (error.code === "not_granted") return { status: "not_granted", step, reason: error.message }
    if (error.code === "locked") return { status: "needs_user", step, reason: error.message }
    return { status: "failed", step, reason: `${error.code}: ${error.message}` }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/domain_not_allowed/.test(message)) return { status: "failed", step, reason: message.replace(/^secrets\.\w+: /, "") }
  return { status: "failed", step, reason: message.slice(0, 300) }
}

async function run(deps: SignInDeps, startPage: Page, siteSpec: LoginSpec, deadline: number, depth: number): Promise<SignInResult> {
  const page = startPage
  let step: SignInStep = "start"
  let googleSpec: LoginSpec | undefined
  let clickedSignInLink = false
  let toggles = 0
  let lastSignature = ""
  let repeats = 0
  let passkeyClicks = 0
  const started = Date.now()
  /** A passkey request on the page found several accounts and none was named: the agent picks. */
  const needsChoice = async (): Promise<SignInResult | undefined> => {
    if (siteSpec.username || !deps.passkeys) return undefined
    const choices = await deps.passkeys.choiceSince(page, started).catch(() => undefined)
    if (!choices || choices.length === 0) return undefined
    return { status: "needs_choice", step: "passkey", reason: `Several passkeys can sign in to ${siteSpec.site}; call again with { username } set to one of the choices.`, choices }
  }
  const specFor = (url: string): LoginSpec | undefined => {
    let origin: string
    try {
      origin = new URL(url).origin
    } catch {
      return undefined
    }
    if (originOnSite(origin, siteSpec.site)) return siteSpec
    if (googleSpec && originOnSite(origin, googleSite)) return googleSpec
    return undefined
  }
  while (Date.now() < deadline) {
    if (page.isClosed()) return step === "start" ? { status: "failed", step, reason: "The page closed." } : { status: "signed_in", step: "done", reason: "The sign-in window closed after the last step." }
    await page.waitForLoadState("domcontentloaded", { timeout: Math.max(1, Math.min(15_000, deadline - Date.now())) }).catch(() => {})
    const url = page.url()
    const spec = specFor(url)
    if (!spec) {
      if (step === "start") return { status: "failed", step, reason: `The page is on ${safeOrigin(url)}, not ${siteSpec.site}.` }
      // Sent somewhere else after a step: a site we don't sign in to (another identity provider, a consent page).
      return needsUser("provider", `The sign-in moved to ${safeOrigin(url)}, which isn't ${siteSpec.site}${googleSpec ? " or Google" : ""}.`)
    }
    const choice = await needsChoice()
    if (choice) return choice
    // SPAs render their forms late: give the page a few seconds to show something to act on.
    let read: Read | undefined
    const settleUntil = Math.min(deadline, Date.now() + (step === "start" ? 8_000 : 5_000))
    while (true) {
      read = await readPage(page, spec.site)
      if ((read && actionable(read.state)) || Date.now() >= settleUntil) break
      await delay(300)
    }
    if (!read) {
      await delay(300)
      continue
    }
    const state = read.state
    const signature = `${url}|${state.hasUsername}|${state.hasPassword}|${state.otpCount}|${state.usernameFilled.length}`
    repeats = signature === lastSignature ? repeats + 1 : 0
    lastSignature = signature
    if (repeats >= 2) {
      return { status: "failed", step, reason: state.errorText ? `The site didn't accept the ${step === "code" ? "code" : step}: ${state.errorText}` : `The page didn't move on after the ${step} step.` }
    }
    if (state.captcha) return needsUser(step, `A captcha is showing (${state.captcha}).`)
    const challenge = await deps.challenge(page).catch(() => undefined)
    if (challenge && challenge.kind !== "non-interactive") {
      return challenge.kind === "block"
        ? { status: "failed", step, reason: `The site blocked the visit (${challenge.vendor}).` }
        : needsUser(step, `A ${challenge.vendor} bot check is showing.`)
    }

    if (state.otpCount > 0) {
      const kind = codeKind(state.text)
      if (kind === "sent") return needsUser("code", "The site sent a one-time code by SMS, email or call.")
      const logins = await deps.logins(new URL(read.frame.url()).origin).catch(() => [] as readonly DeadboltLogin[])
      const hasTotp = logins.some((login) => login.hasTotp && login.granted && (!login.fields || login.fields.includes("totp")) && (!spec.username || login.username?.toLowerCase() === spec.username.toLowerCase()))
      if (!hasTotp) return needsUser("code", kind === "totp" ? "The site asks for an authenticator code, and the granted login has no one-time password." : "The site asks for a one-time code.")
      const boxes = await otpElements(read)
      step = "code"
      await deps.type(boxes, spec, "totp")
      // Split boxes often submit themselves on the last digit.
      if (!(await waitForProgress(page, boxes[0], 1_500))) {
        const stillThere = await boxes[0]!.isVisible().catch(() => false)
        if (stillThere) await submit(read, boxes.at(-1)!)
        await waitForProgress(page, boxes[0], 15_000)
      }
      continue
    }

    if (state.hasPassword) {
      const passwordField = (await element(read, "password"))!
      const usernameField = await element(read, "username")
      if (usernameField && !state.usernameFilled) await deps.type([usernameField], spec, "username")
      step = "password"
      await deps.type([passwordField], spec, "password")
      await submit(read, passwordField)
      await waitForProgress(page, passwordField, 15_000)
      continue
    }

    if (state.hasUsername) {
      const usernameField = (await element(read, "username"))!
      await deps.type([usernameField], spec, "username")
      step = "identifier"
      await submit(read, usernameField)
      await waitForProgress(page, usernameField, 15_000)
      continue
    }

    if (state.hasPasswordToggle && toggles < 2) {
      toggles += 1
      await clickHandle((await element(read, "passwordToggle"))!)
      await waitForProgress(page, undefined, 2_000)
      continue
    }

    if (state.hasGoogle && !googleSpec && depth === 0 && spec === siteSpec) {
      const siteLogins = await deps.logins(new URL(read.frame.url()).origin).catch(() => [] as readonly DeadboltLogin[])
      const viaGoogle = siteLogins.find((login) => login.signIn?.provider === "google")
      const googleLogins = (await deps.logins(`https://${googleSite}`).catch(() => [] as readonly DeadboltLogin[])).filter((login) => login.granted)
      const account = siteSpec.username ?? viaGoogle?.signIn?.account
      const googleLogin = googleLogins.find((login) => !account || login.username?.toLowerCase() === account.toLowerCase()) ?? (googleLogins.length === 1 ? googleLogins[0] : undefined)
      if (googleLogin && (viaGoogle || !siteLogins.some((login) => login.granted && login.hasPassword))) {
        if (!deps.allowed(`https://${googleSite}/`)) return needsUser("provider", `Signing in uses Google, but ${googleSite} isn't in this session's allowlist (add it with session_allowlist).`)
        googleSpec = { site: googleSite, ...(googleLogin.username ? { username: googleLogin.username } : {}) }
        step = "provider"
        const popupPromise = deps.context.waitForEvent("page", { timeout: 5_000 }).catch(() => undefined)
        await clickHandle((await element(read, "google"))!)
        const popup = await popupPromise
        if (popup) {
          await popup.waitForLoadState("domcontentloaded").catch(() => {})
          const result = await runProvider(deps, popup, googleSpec, deadline)
          if (result.status !== "signed_in") return result
          await waitForProgress(page, undefined, 5_000)
        } else {
          await waitForProgress(page, undefined, 10_000)
        }
        continue
      }
    }

    if (state.hasPasskeyButton && passkeyClicks < 1) {
      const origin = new URL(read.frame.url()).origin
      const passkeys = await deps.passkeyAccounts(origin).catch(() => [] as readonly DeadboltPasskey[])
      const granted = spec.username ? pickPasskey(passkeys, spec.username) !== undefined : passkeys.some((passkey) => passkey.granted)
      if (granted) {
        passkeyClicks += 1
        step = "passkey"
        const before = page.url()
        await clickHandle((await element(read, "passkeyButton"))!)
        // Until the page moves on, or the passkey request needs the agent to pick an account.
        const until = Math.min(deadline, Date.now() + 10_000)
        while (Date.now() < until && !page.isClosed() && page.url() === before) {
          const picked = await needsChoice()
          if (picked) return picked
          await delay(250)
        }
        await page.waitForLoadState("domcontentloaded").catch(() => {})
        continue
      }
    }

    const verification = verificationKind(state.text)
    if (verification) return needsUser("verify", verification === "push_approval" ? "The site waits for a push approval on another device." : verification === "security_question" ? "The site asks a security question." : "The site wants to verify a new device or that it's really the user.")
    if (step !== "start" && codeKind(state.text) === "sent") return needsUser("code", "The site sent a one-time code by SMS, email or call.")

    if (step === "start") {
      if (state.hasSignInLink && !clickedSignInLink) {
        clickedSignInLink = true
        await clickHandle((await element(read, "signInLink"))!)
        await waitForProgress(page, undefined, 8_000)
        continue
      }
      if (state.hasGoogle) return needsUser("provider", "The page offers Sign in with Google, but Deadbolt grants no Google login for it.")
      return { status: "failed", step, reason: "No sign-in form found on this page. Open the site's sign-in page first." }
    }
    if (state.errorText && /incorrect|wrong|invalid|doesn'?t match|not recognized|couldn'?t find|try again/i.test(state.errorText)) {
      return { status: "failed", step, reason: `The site refused the sign-in: ${state.errorText}` }
    }
    if (spec === googleSpec && spec !== siteSpec) return needsUser("provider", "Google shows a screen to choose an account or to give consent.")
    return { status: "signed_in", step: "done", reason: `Signed in to ${spec.site}: no sign-in field is left after the ${step} step.` }
  }
  return { status: "failed", step: "start", reason: "The sign-in didn't finish in time." }
}

/** The provider's sign-in in a popup: run the same steps there; the popup closing means it's done. */
async function runProvider(deps: SignInDeps, popup: Page, spec: LoginSpec, deadline: number): Promise<SignInResult> {
  const result = await run({ ...deps, page: popup }, popup, spec, deadline, 1)
  if (result.status !== "signed_in") return result
  if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: Math.max(1, Math.min(20_000, deadline - Date.now())) }).catch(() => {})
  return popup.isClosed() ? result : needsUser("provider", "Google's sign-in window stayed open (an account choice or consent screen).")
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url.slice(0, 80)
  }
}
