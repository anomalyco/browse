/**
 * Bot-challenge and block-page detection for execute.
 *
 * After an execute call navigates (or fails), the sandbox reads a few signals from the page and classifies it:
 *
 * - `non-interactive`: an interstitial the browser clears by itself (Cloudflare's "Just a moment...", Akamai's and AWS
 *   WAF's silent challenges, a DataDome device check). Execute waits for it to go away, up to a bound.
 * - `interactive`: a challenge only a person should answer (Turnstile or reCAPTCHA/hCaptcha checkboxes, PerimeterX
 *   "Press & Hold", a DataDome or AWS WAF captcha). Execute never touches it: it reports `blocked` and recommends
 *   `handoff()`.
 * - `block`: the site refused the visit outright (Cloudflare "Sorry, you have been blocked", Akamai or Imperva "Access
 *   Denied"). Retrying makes it worse; the agent should stop or ask the user.
 *
 * The signals are vendor markers (challenge iframes and scripts, element ids the vendors' pages use) and title/text
 * phrases. Generic phrases ("access denied", "verify you are human") only count on short pages, so an article that
 * mentions them is not a challenge. Detection is deliberately conservative: a miss costs an agent turn, a false
 * positive costs a 15 s wait or a needless handoff.
 *
 * Pure module apart from the page-side probe source, which runs in Patchright's isolated world (not visible to the
 * page's own scripts).
 */

export type ChallengeVendor =
  | "cloudflare"
  | "akamai"
  | "datadome"
  | "perimeterx"
  | "imperva"
  | "aws-waf"
  | "recaptcha"
  | "hcaptcha"
  | "generic"

export type ChallengeKind = "non-interactive" | "interactive" | "block"

export type ChallengeDetection = {
  readonly vendor: ChallengeVendor
  readonly kind: ChallengeKind
  /** The marker that matched, for logs and the agent ("title: Just a moment...", "iframe challenges.cloudflare.com"). */
  readonly signal: string
}

/** What the probe reads from the page. Every field is bounded by the probe. */
export type ChallengeProbe = {
  readonly url: string
  readonly title: string
  /** document.body.innerText, first 3000 characters. */
  readonly text: string
  /** Full innerText length, to tell short interstitials from long pages. */
  readonly textLength: number
  /** Frame URLs from the CDP frame tree (Playwright's page.frames()). */
  readonly frameUrls: readonly string[]
  /** Script src values, first 50. */
  readonly scriptSrcs: readonly string[]
  /** Which of `probeSelectors` matched an element. */
  readonly selectors: readonly string[]
  /** Whether a matched widget is visible (non-zero size); keys are the selectors. */
  readonly visibleSelectors: readonly string[]
}

/** Element markers the probe checks. Keep in sync with `classifyChallenge`. */
export const probeSelectors = [
  // Cloudflare
  "#challenge-form", "#challenge-running", "#challenge-stage", "#cf-challenge-running", "#cf-please-wait", ".cf-turnstile",
  "#cf-error-details", "#cf-wrapper .cf-error-type",
  // Akamai Bot Manager
  "#sec-if-cpt-container", "#sec-cpt-if", "#sec-text-if",
  // DataDome
  "#ddv1-captcha-container",
  // PerimeterX / HUMAN
  "#px-captcha", "#px-captcha-wrapper", "[id^='px-captcha']",
  // Imperva / Incapsula
  "#main-iframe[src*='_Incapsula_Resource']",
  // AWS WAF
  "#captcha-container awswaf-captcha", "awswaf-captcha", "#challenge-container",
  // reCAPTCHA / hCaptcha
  ".g-recaptcha", "iframe[src*='/recaptcha/'][title*='challenge']", ".h-captcha",
] as const

/** Page-side probe; run with `page.evaluate(probeSource, selectors)` in the isolated world. */
export const probePageScript = (selectors: readonly string[]) => {
  const body = document.body
  const text = body ? body.innerText ?? "" : ""
  const matched: string[] = []
  const visible: string[] = []
  for (const selector of selectors) {
    let element: Element | null = null
    try {
      element = document.querySelector(selector)
    } catch {
      element = null
    }
    if (!element) continue
    matched.push(selector)
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) visible.push(selector)
  }
  return {
    title: document.title.slice(0, 300),
    text: text.slice(0, 3000),
    textLength: text.length,
    scriptSrcs: Array.from(document.scripts, (script) => script.src).filter(Boolean).slice(0, 50),
    selectors: matched,
    visibleSelectors: visible,
  }
}

const shortPage = (probe: ChallengeProbe): boolean => probe.textLength < 1_500

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

function hasFrame(probe: ChallengeProbe, pattern: RegExp): string | undefined {
  return probe.frameUrls.find((url) => pattern.test(url))
}

function hasScript(probe: ChallengeProbe, pattern: RegExp): string | undefined {
  return probe.scriptSrcs.find((src) => pattern.test(src))
}

const has = (probe: ChallengeProbe, selector: string): boolean => probe.selectors.includes(selector)
const visible = (probe: ChallengeProbe, selector: string): boolean => probe.visibleSelectors.includes(selector)

/** Classify a probed page, or undefined when it doesn't look like a challenge or block page. */
export function classifyChallenge(probe: ChallengeProbe): ChallengeDetection | undefined {
  const title = probe.title.trim().toLowerCase()
  const text = probe.text.toLowerCase()
  const host = hostOf(probe.url)
  const signal = (value: string) => value.slice(0, 160)

  // Cloudflare
  if (/sorry, you have been blocked/.test(text) && (has(probe, "#cf-error-details") || /cloudflare/.test(text))) {
    return { vendor: "cloudflare", kind: "block", signal: "text: Sorry, you have been blocked" }
  }
  const cloudflareInterstitial = /^just a moment\b|^attention required! \| cloudflare|^checking your browser|^un instant|^einen moment/.test(title)
    || has(probe, "#challenge-form") || has(probe, "#challenge-running") || has(probe, "#cf-challenge-running") || has(probe, "#challenge-stage")
  const turnstileFrame = hasFrame(probe, /^https:\/\/challenges\.cloudflare\.com\/.*(turnstile|challenge-platform)/)
  if (cloudflareInterstitial || (turnstileFrame && shortPage(probe))) {
    // The managed challenge shows Turnstile's checkbox only when it wants a click; until then it clears itself.
    const widget = visible(probe, ".cf-turnstile") || /verify you are human by completing|click to verify|confirm you are human/.test(text)
    return {
      vendor: "cloudflare",
      kind: widget ? "interactive" : "non-interactive",
      signal: cloudflareInterstitial ? signal(`title: ${probe.title.trim()}`) : signal(`iframe ${turnstileFrame}`),
    }
  }

  // PerimeterX / HUMAN
  if (has(probe, "#px-captcha") || has(probe, "#px-captcha-wrapper") || has(probe, "[id^='px-captcha']") || /press (?:&|and) hold/.test(text)) {
    return { vendor: "perimeterx", kind: "interactive", signal: has(probe, "#px-captcha") ? "element #px-captcha" : "text: Press & Hold" }
  }

  // DataDome
  const dataDomeFrame = hasFrame(probe, /captcha-delivery\.com/)
  if (dataDomeFrame || has(probe, "#ddv1-captcha-container")) {
    const interstitial = dataDomeFrame !== undefined && /\/interstitial\//.test(dataDomeFrame)
    return { vendor: "datadome", kind: interstitial ? "non-interactive" : "interactive", signal: signal(dataDomeFrame ? `iframe ${dataDomeFrame}` : "element #ddv1-captcha-container") }
  }

  // Akamai Bot Manager
  if (has(probe, "#sec-if-cpt-container") || has(probe, "#sec-cpt-if") || has(probe, "#sec-text-if")) {
    const interactive = visible(probe, "#sec-cpt-if") && /verify|press|slide|captcha/.test(text)
    return { vendor: "akamai", kind: interactive ? "interactive" : "non-interactive", signal: "element #sec-if-cpt-container" }
  }
  if (title === "access denied" && /you don't have permission to access/.test(text) && /reference #?\d/.test(text)) {
    return { vendor: "akamai", kind: "block", signal: "title: Access Denied (Akamai reference)" }
  }

  // Imperva / Incapsula
  const incapsula = hasFrame(probe, /_Incapsula_Resource/) ?? hasScript(probe, /_Incapsula_Resource/)
  if (incapsula || has(probe, "#main-iframe[src*='_Incapsula_Resource']")) {
    const captcha = /captcha|verify you are human|i am human/.test(text) || hasFrame(probe, /hcaptcha|recaptcha/) !== undefined
    if (/request unsuccessful|incapsula incident id/.test(text) && !captcha) {
      return { vendor: "imperva", kind: "block", signal: "text: Request unsuccessful (Incapsula)" }
    }
    return { vendor: "imperva", kind: captcha ? "interactive" : "non-interactive", signal: signal(`resource ${incapsula ?? "_Incapsula_Resource"}`) }
  }
  if (/incapsula incident id/.test(text) && shortPage(probe)) {
    return { vendor: "imperva", kind: "block", signal: "text: Incapsula incident ID" }
  }

  // AWS WAF
  const awsCaptcha = has(probe, "awswaf-captcha") || has(probe, "#captcha-container awswaf-captcha")
  const awsScript = hasScript(probe, /\.awswaf\.com\//)
  if (awsCaptcha) return { vendor: "aws-waf", kind: "interactive", signal: "element awswaf-captcha" }
  if (awsScript && shortPage(probe) && (has(probe, "#challenge-container") || probe.textLength < 300)) {
    return { vendor: "aws-waf", kind: "non-interactive", signal: signal(`script ${awsScript}`) }
  }

  // Captcha walls: a page that is mostly a reCAPTCHA or hCaptcha widget.
  if (shortPage(probe)) {
    const recaptcha = hasFrame(probe, /^https:\/\/www\.(?:google|recaptcha)\.(?:com|net)\/recaptcha\/(?:api2|enterprise)\/anchor/)
    const hcaptcha = hasFrame(probe, /^https:\/\/(?:newassets\.|assets\.)?hcaptcha\.com\/captcha\//)
    const wallText = /verify you are (?:a )?human|are you a robot|not a robot|unusual traffic|security check|complete the captcha|captcha/.test(text)
      || /captcha|security check|verify/.test(title)
    if (hcaptcha && wallText) return { vendor: "hcaptcha", kind: "interactive", signal: signal(`iframe ${hcaptcha}`) }
    if (recaptcha && wallText) return { vendor: "recaptcha", kind: "interactive", signal: signal(`iframe ${recaptcha}`) }
    // Google's own "unusual traffic" interstitial.
    if (/^www\.google\./.test(host) && /\/sorry\//.test(probe.url)) {
      return { vendor: "recaptcha", kind: "interactive", signal: "url: google.com/sorry" }
    }
  }

  // Generic block and verification pages, short pages only.
  if (shortPage(probe)) {
    if (/^(?:access denied|403 forbidden|forbidden|blocked|request blocked|you have been blocked)$/.test(title)
      || /^(?:access to this page has been denied|access denied)\b/.test(text.trim())) {
      return { vendor: "generic", kind: "block", signal: signal(`title: ${probe.title.trim() || text.trim().slice(0, 60)}`) }
    }
    if (/verify (?:that )?you are (?:a )?human|confirm you are (?:a )?human|are you a robot\?|pardon our interruption|please verify you are a human|bot (?:check|detection)/.test(`${title}\n${text}`)) {
      return { vendor: "generic", kind: "interactive", signal: signal(`text: ${(/verify[^.\n]*human|confirm[^.\n]*human|are you a robot|pardon our interruption|bot (?:check|detection)/.exec(`${title}\n${text}`)?.[0] ?? "verification")}`) }
    }
  }
  return undefined
}

export type ChallengeOutcome = ChallengeDetection & {
  /** cleared: the interstitial went away while execute waited; blocked: it is still there. */
  readonly status: "cleared" | "blocked"
  readonly url: string
  readonly waitedMs: number
  /** What the agent should do next. */
  readonly recommendation: "continue" | "handoff" | "stop"
}

export function challengeWarning(outcome: ChallengeOutcome): string | undefined {
  if (outcome.status === "cleared") return undefined
  const where = (() => {
    try {
      return new URL(outcome.url).origin
    } catch {
      return outcome.url
    }
  })()
  if (outcome.recommendation === "handoff") {
    return `Blocked by a ${outcome.vendor} ${outcome.kind} challenge on ${where} (${outcome.signal}${outcome.waitedMs > 0 ? `, still there after ${Math.round(outcome.waitedMs / 1000)} s` : ""}). Don't retry, reload or try to solve it: call handoff("Solve the security check on ${where}, then click Continue") so the user does it, or stop.`
  }
  return `Blocked: ${where} refused the visit (${outcome.vendor}, ${outcome.signal}). Don't retry or reload in a loop, which makes the block worse for the user's IP and account: stop, or tell the user.`
}
