/**
 * Per-session domain allowlists, and the origin patterns secrets declare.
 *
 * A session can be given a list of allowed hosts (opt-in; sessions without one may go anywhere, because localhost dev
 * servers are a core use). With a list, the relay refuses agent navigations to other hosts (Page.navigate,
 * Target.createTarget) and sends session tabs that end up elsewhere anyway (a link, a redirect, a script's
 * location change, a popup) back to about:blank, or closes the popup.
 *
 * Pattern forms (case-insensitive):
 *
 * - `example.com`: that host, http or https, any port. `example.com:8443`: that host and port.
 * - `*.example.com`: example.com and every subdomain.
 * - `https://example.com`, `http://localhost:3000`, `https://*.example.com`: scheme, host and port must match.
 * - IP literals: `127.0.0.1`, `[::1]`, `10.0.0.5:8080`.
 *
 * Private, loopback, link-local and other non-public addresses (and `localhost`) are refused even when a wildcard
 * matches them; only a pattern naming that exact host allows one. Hostnames are resolved before an agent navigation
 * and the document's actual remote IP is checked when it arrives, so a public name that resolves to (or rebinds to) a
 * private address is caught too. URLs are parsed the WHATWG way, so decimal, octal or hex IPv4 spellings normalize to
 * dotted form before the check.
 *
 * Pure module apart from `resolvesToPrivateAddress` (DNS).
 */
import dns from "node:dns/promises"
import net from "node:net"

export type OriginRule = {
  readonly pattern: string
  readonly scheme?: "http:" | "https:"
  /** Lowercase host without brackets; for wildcards, the suffix after `*.`. */
  readonly host: string
  readonly wildcard: boolean
  readonly port?: string
}

export class OriginPatternError extends Error {
  override readonly name = "OriginPatternError"
}

const maxPatterns = 100

export function parseOriginPattern(raw: string): OriginRule {
  const pattern = raw.trim()
  if (!pattern) throw new OriginPatternError("Empty origin pattern")
  if (pattern === "*" || pattern === "*.*") throw new OriginPatternError(`Origin pattern ${JSON.stringify(raw)} allows every site; leave the allowlist unset instead`)
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(pattern)
  const scheme = schemeMatch?.[1]?.toLowerCase()
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") {
    throw new OriginPatternError(`Origin pattern ${JSON.stringify(raw)}: only http and https origins can be allowed`)
  }
  let rest = schemeMatch ? pattern.slice(schemeMatch[0].length) : pattern
  if (/[/?#]/.test(rest.replace(/\/$/, ""))) throw new OriginPatternError(`Origin pattern ${JSON.stringify(raw)} must be a host or origin, without a path`)
  rest = rest.replace(/\/$/, "")
  const wildcard = rest.startsWith("*.")
  if (wildcard) rest = rest.slice(2)
  if (rest.includes("*")) throw new OriginPatternError(`Origin pattern ${JSON.stringify(raw)}: a wildcard is only allowed as a leading "*."`)
  let parsed: URL
  try {
    parsed = new URL(`${scheme ?? "http"}://${rest}`)
  } catch {
    throw new OriginPatternError(`Origin pattern ${JSON.stringify(raw)} is not a valid host or origin`)
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || !parsed.hostname) {
    throw new OriginPatternError(`Origin pattern ${JSON.stringify(raw)} must be a host or origin`)
  }
  const host = unbracket(parsed.hostname.toLowerCase())
  if (wildcard && net.isIP(host)) throw new OriginPatternError(`Origin pattern ${JSON.stringify(raw)}: wildcards don't apply to IP addresses`)
  if (wildcard && !host.includes(".")) throw new OriginPatternError(`Origin pattern ${JSON.stringify(raw)}: "*." needs a domain with a dot, like *.example.com`)
  // An origin with a scheme and no port means the scheme's default port; a bare host means any port.
  const port = parsed.port || (scheme ? (scheme === "https" ? "443" : "80") : undefined)
  return {
    pattern,
    ...(scheme ? { scheme: `${scheme}:` as const } : {}),
    host,
    wildcard,
    ...(port ? { port } : {}),
  }
}

export function parseOriginPatterns(raw: readonly string[]): readonly OriginRule[] {
  if (raw.length > maxPatterns) throw new OriginPatternError(`At most ${maxPatterns} origin patterns are allowed`)
  return raw.map(parseOriginPattern)
}

/** Normalized pattern strings, for storage and display. Throws OriginPatternError on an invalid one. */
export function normalizeOriginPatterns(raw: readonly string[]): readonly string[] {
  return Array.from(new Set(parseOriginPatterns(raw.flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean)).map((rule) => rule.pattern.toLowerCase())))
}

function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
}

function ipv4ToNumber(ip: string): number {
  return ip.split(".").reduce((value, part) => value * 256 + Number(part), 0)
}

const privateIpv4Ranges: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]

/** True for loopback, private, link-local, CGNAT, documentation, multicast and reserved addresses. */
export function isPrivateAddress(address: string): boolean {
  const ip = unbracket(address.toLowerCase()).replace(/%.*$/, "")
  if (net.isIPv4(ip)) {
    const value = ipv4ToNumber(ip)
    return privateIpv4Ranges.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
      return ((value & mask) >>> 0) === ((ipv4ToNumber(base) & mask) >>> 0)
    })
  }
  if (net.isIPv6(ip)) {
    if (ip === "::" || ip === "::1") return true
    const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
    if (mapped?.[1]) return isPrivateAddress(mapped[1])
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
    if (hexMapped?.[1] && hexMapped[2]) {
      const high = parseInt(hexMapped[1], 16)
      const low = parseInt(hexMapped[2], 16)
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    const first = parseInt(ip.split(":")[0] || "0", 16)
    // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast, 64:ff9b::/96 NAT64 (embeds IPv4).
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true
    if (ip.startsWith("64:ff9b::")) return true
    return false
  }
  return false
}

function isLocalhostName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain"
}

/** Whether a host is non-public by its spelling alone (IP literal or localhost name). */
export function isPrivateHost(host: string): boolean {
  const bare = unbracket(host.toLowerCase())
  return isLocalhostName(bare) || (net.isIP(bare) !== 0 && isPrivateAddress(bare))
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80"
}

function ruleMatches(rule: OriginRule, url: URL, host: string, options: { readonly httpsOnlyWithoutScheme?: boolean }): boolean {
  if (rule.scheme !== undefined && rule.scheme !== url.protocol) return false
  if (rule.scheme === undefined && options.httpsOnlyWithoutScheme && url.protocol !== "https:" && !isPrivateHost(host)) return false
  if (rule.port !== undefined && rule.port !== (url.port || defaultPort(url.protocol))) return false
  if (rule.wildcard) return host === rule.host || host.endsWith(`.${rule.host}`)
  return host === rule.host
}

/** A rule that names this exact host (no wildcard): the only kind that allows a private address. */
export function explicitlyAllowsHost(rules: readonly OriginRule[], url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = unbracket(parsed.hostname.toLowerCase())
    return rules.some((rule) => !rule.wildcard && ruleMatches(rule, parsed, host, {}))
  } catch {
    return false
  }
}

export type UrlDecision =
  | { readonly allowed: true; readonly host?: string; readonly explicit?: boolean }
  | { readonly allowed: false; readonly reason: string }

/** Schemes that load no remote document: about:blank and srcdoc, data: (an opaque origin), blob: (the creator's). */
const neutralSchemes = new Set(["about:", "data:", "blob:"])

/**
 * Check a URL against allowed origin patterns (synchronously: by spelling, without DNS).
 * `httpsOnlyWithoutScheme` makes bare-host patterns match https only (used for secrets), except for local hosts.
 */
export function checkUrl(rawUrl: string, rules: readonly OriginRule[], options: { readonly httpsOnlyWithoutScheme?: boolean } = {}): UrlDecision {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { allowed: false, reason: `${JSON.stringify(rawUrl.slice(0, 200))} is not a valid URL` }
  }
  if (neutralSchemes.has(url.protocol)) return { allowed: true }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: `${url.protocol} URLs are not allowed for this session` }
  }
  const host = unbracket(url.hostname.toLowerCase())
  const matching = rules.filter((rule) => ruleMatches(rule, url, host, options))
  if (matching.length === 0) {
    return { allowed: false, reason: `${url.host} is not in the allowed origins (${rules.map((rule) => rule.pattern).join(", ") || "none"})` }
  }
  const explicit = matching.some((rule) => !rule.wildcard)
  if (isPrivateHost(host) && !explicit) {
    return { allowed: false, reason: `${url.host} is a private, loopback or local address; allow it by naming that exact host` }
  }
  return { allowed: true, host, explicit }
}

/** Resolve a hostname and report a non-public address it resolves to, or undefined (also when DNS fails). */
export async function resolvesToPrivateAddress(host: string, timeoutMs = 2_000): Promise<string | undefined> {
  const bare = unbracket(host)
  if (net.isIP(bare) || isLocalhostName(bare)) return isPrivateHost(bare) ? bare : undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const addresses = await Promise.race([
      dns.lookup(bare, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("DNS lookup timed out")), timeoutMs) }),
    ])
    return addresses.find((entry) => isPrivateAddress(entry.address))?.address
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Full check for an agent navigation: spelling, then DNS for names an explicit pattern doesn't cover. */
export async function checkNavigationUrl(rawUrl: string, rules: readonly OriginRule[]): Promise<UrlDecision> {
  const decision = checkUrl(rawUrl, rules)
  if (!decision.allowed || decision.host === undefined || decision.explicit) return decision
  const privateAddress = await resolvesToPrivateAddress(decision.host)
  if (privateAddress) {
    return { allowed: false, reason: `${decision.host} resolves to the private address ${privateAddress}; allow it by naming that exact host` }
  }
  return decision
}
