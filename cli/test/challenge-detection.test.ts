import { describe, expect, test } from "bun:test"
import { challengeWarning, classifyChallenge, type ChallengeProbe } from "../src/challenge-detection.ts"

function probe(overrides: Partial<ChallengeProbe>): ChallengeProbe {
  const text = overrides.text ?? ""
  return {
    url: "https://shop.example/",
    title: "",
    text,
    textLength: overrides.textLength ?? text.length,
    frameUrls: [],
    scriptSrcs: [],
    selectors: [],
    visibleSelectors: [],
    ...overrides,
  }
}

describe("classifyChallenge", () => {
  test("Cloudflare's managed challenge clears by itself until Turnstile shows a checkbox", () => {
    const waiting = probe({ title: "Just a moment...", text: "Checking if the site connection is secure", selectors: ["#challenge-running"] })
    expect(classifyChallenge(waiting)).toMatchObject({ vendor: "cloudflare", kind: "non-interactive" })
    const widget = probe({
      title: "Just a moment...",
      text: "Verify you are human by completing the action below.",
      frameUrls: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc"],
      selectors: [".cf-turnstile"],
      visibleSelectors: [".cf-turnstile"],
    })
    expect(classifyChallenge(widget)).toMatchObject({ vendor: "cloudflare", kind: "interactive" })
  })

  test("Cloudflare and Akamai blocks", () => {
    expect(classifyChallenge(probe({ title: "Attention Required! | Cloudflare", text: "Sorry, you have been blocked. Cloudflare Ray ID: 1", selectors: ["#cf-error-details"] })))
      .toMatchObject({ vendor: "cloudflare", kind: "block" })
    expect(classifyChallenge(probe({ title: "Access Denied", text: "Access Denied\nYou don't have permission to access \"http://shop.example/\" on this server.\nReference #18.abc.1700000000.1" })))
      .toMatchObject({ vendor: "akamai", kind: "block" })
  })

  test("vendor captchas are interactive", () => {
    expect(classifyChallenge(probe({ selectors: ["#px-captcha"], text: "Press & Hold to confirm you are a human (and not a bot)." })))
      .toMatchObject({ vendor: "perimeterx", kind: "interactive" })
    expect(classifyChallenge(probe({ frameUrls: ["https://geo.captcha-delivery.com/captcha/?initialCid=x"] })))
      .toMatchObject({ vendor: "datadome", kind: "interactive" })
    expect(classifyChallenge(probe({ frameUrls: ["https://geo.captcha-delivery.com/interstitial/?initialCid=x"] })))
      .toMatchObject({ vendor: "datadome", kind: "non-interactive" })
    expect(classifyChallenge(probe({ selectors: ["awswaf-captcha"] }))).toMatchObject({ vendor: "aws-waf", kind: "interactive" })
    expect(classifyChallenge(probe({ text: "Please verify you are a human", frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox"] })))
      .toMatchObject({ vendor: "hcaptcha", kind: "interactive" })
    expect(classifyChallenge(probe({ text: "Our systems have detected unusual traffic", frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=x"] })))
      .toMatchObject({ vendor: "recaptcha", kind: "interactive" })
  })

  test("Akamai and Imperva interstitials", () => {
    expect(classifyChallenge(probe({ selectors: ["#sec-if-cpt-container"], text: "Please wait while we verify" })))
      .toMatchObject({ vendor: "akamai", kind: "non-interactive" })
    expect(classifyChallenge(probe({ frameUrls: ["https://shop.example/_Incapsula_Resource?SWUDNSAI=1"], text: "" })))
      .toMatchObject({ vendor: "imperva", kind: "non-interactive" })
    expect(classifyChallenge(probe({ scriptSrcs: ["https://shop.example/_Incapsula_Resource?x"], text: "Request unsuccessful. Incapsula incident ID: 1-2" })))
      .toMatchObject({ vendor: "imperva", kind: "block" })
  })

  test("generic phrases count only on short pages", () => {
    expect(classifyChallenge(probe({ title: "Access Denied", text: "Access denied" }))).toMatchObject({ vendor: "generic", kind: "block" })
    expect(classifyChallenge(probe({ title: "Security", text: "Please verify you are a human to continue." }))).toMatchObject({ vendor: "generic", kind: "interactive" })
    const article = `How bot detection works: sites ask you to verify you are human. ${"Long article text. ".repeat(200)}`
    expect(classifyChallenge(probe({ title: "Bot detection explained", text: article.slice(0, 3000), textLength: article.length }))).toBeUndefined()
    // A login form with an embedded reCAPTCHA is not a wall.
    expect(classifyChallenge(probe({ title: "Sign in", text: "Email\nPassword\nSign in", frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=x"] }))).toBeUndefined()
    expect(classifyChallenge(probe({ title: "Example Domain", text: "This domain is for use in documentation examples." }))).toBeUndefined()
  })
})

describe("challengeWarning", () => {
  test("recommends a handoff for interactive challenges and stopping for blocks", () => {
    const base = { vendor: "cloudflare" as const, signal: "title: Just a moment...", url: "https://shop.example/a?b", waitedMs: 15_000 }
    expect(challengeWarning({ ...base, kind: "interactive", status: "blocked", recommendation: "handoff" })).toContain('handoff("Solve the security check on https://shop.example')
    expect(challengeWarning({ ...base, kind: "block", status: "blocked", recommendation: "stop" })).toContain("Don't retry")
    expect(challengeWarning({ ...base, kind: "non-interactive", status: "cleared", recommendation: "continue" })).toBeUndefined()
  })
})
