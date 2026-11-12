import {
  blockedReason,
  oldStoreBuild,
  systemEffects,
  type Browser,
  type Detection,
  type Effects,
} from "./browsers.ts"
import { connectedMessage, manualPair, pairedOfflineMessage, STORE_IDS, STORE_URL } from "./environment.ts"
import { defaultPort } from "../relay/helpers.ts"

export type LocateOptions = {
  allowOpen: boolean
  connected: boolean
  pairedOffline?: boolean
  /** The relay just saw a browser that isn't paired: the extension is installed, so the store step is wrong. */
  unpaired?: boolean
  detections: Detection[]
  preferred: Browser | undefined
  env: { ssh: boolean; display: boolean; tty: boolean; platform: NodeJS.Platform }
  /** The store page to open; defaults to this channel's store item. */
  storeUrl?: string
}

/**
 * Reports the browsers and profiles that have browse. Every channel installs the extension from the Chrome Web Store,
 * so when none has it (and none is connected to the relay) the only step is adding it from there, with its page opened
 * when install may open things. Nothing opens when the browsers here aren't the ones the user looks at (SSH, no
 * display), with --no-open, or when a browser couldn't be checked and may already have it.
 * Returns "ready" when the extension is there (connected, paired before, or only waiting to pair), "off" when it's turned
 * off, else "guided".
 */
export function locateExtension(options: LocateOptions, effects: Effects = systemEffects): "ready" | "off" | "guided" {
  const { log } = effects
  const listing = options.storeUrl ?? STORE_URL
  if (options.pairedOffline) return log(pairedOfflineMessage), "ready"
  // A connected extension is installed, even somewhere the scan doesn't look (a custom profile directory, a snap).
  if (options.connected) return log(connectedMessage), "ready"
  if (!options.env.ssh && options.detections.some((detection) => detection.enabled.length)) return "ready"
  const off = options.detections.flatMap((detection) => detection.disabled)
  if (off.length) {
    log(
      `! browse is turned off in ${off.map((match) => `${match.browser.name} (${match.profile.name})`).join(", ")}. Turn it on in the browser's extensions page.`,
    )
    return "off"
  }
  // One that contacted the relay without a token is installed too; setup prints a pairing code for it.
  if (options.unpaired) return "ready"
  const blocked = options.detections.filter((detection) => detection.blocked).map((detection) => detection.browser.name)
  if (blocked.length) log(`! Couldn't check ${blocked.join(", ")} for browse (${blockedReason()})`)
  const target = options.preferred ?? options.detections.find((detection) => !detection.blocked)?.browser
  const interactive = options.allowOpen && options.env.display && !options.env.ssh
  // A browser that couldn't be checked may already have it: don't open anything over the user's work.
  const opened =
    interactive && !blocked.length && (target ? effects.open(target, listing) : effects.openDefault?.(listing))
  log(`Add browse to ${target?.name ?? "your browser"} from the Chrome Web Store${opened ? " (opened)" : ""}: ${listing}`)
  return "guided"
}

/**
 * Pairs a store-installed extension without the copy-paste step: opens its status page in the browser profile that has
 * it, with a one-time pairing code in the URL fragment (`welcome.html#code=<code>`). The page clears the fragment at
 * once and, only when the extension isn't paired, connects with the code, which the relay exchanges for the browser's
 * own token during the handshake (browser-pairing.ts). The code passes through the browser's command line, which other
 * local users can see in the process list (`ps`), so it's worth nothing after its first use or ten minutes, whichever
 * comes first. `pair` and typing the code stay as the fallback.
 * Returns "opened", "manual" (the store build is there but nothing was opened: say how to pair) or "none".
 */
export function pairStoreExtension(
  options: Pick<LocateOptions, "detections" | "preferred" | "allowOpen" | "env"> & {
    code: () => string
    storeIds?: readonly string[]
    /** The relay's listen port; appended to the link and the manual text when it isn't 19988 (relay/port.ts). */
    port?: number
  },
  effects: Effects = systemEffects,
): "opened" | "manual" | "none" {
  const ids = options.storeIds ?? STORE_IDS
  const matches = options.detections
    .flatMap((detection) => detection.enabled)
    .filter((match) => ids.includes(match.id) && !oldStoreBuild(match))
  const match = matches.find((candidate) => candidate.browser.name === options.preferred?.name) ?? matches[0]
  if (!match) return "none"
  const interactive = options.allowOpen && options.env.display && !options.env.ssh
  const port = options.port === undefined || options.port === defaultPort ? "" : `&port=${options.port}`
  if (
    interactive &&
    effects.open(match.browser, `chrome-extension://${match.id}/welcome.html#code=${options.code()}${port}`, match.profile.dir)
  ) {
    effects.log(`✓ Opened browse in ${match.browser.name} to connect it`)
    return "opened"
  }
  effects.log(`To connect browse in ${match.browser.name}: ${manualPair(options.code(), options.port)}`)
  return "manual"
}

/**
 * Polls until the extension connects to the relay: true when it does, false after timeoutMs. Install waits like
 * this after printing the store step, so the user sees the moment add-from-store worked.
 */
export async function waitForExtension(options: {
  connected: () => Promise<boolean>
  timeoutMs: number
  intervalMs: number
  sleep?: (ms: number) => Promise<void>
}) {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let waited = 0; ; waited += options.intervalMs) {
    if (await options.connected()) return true
    if (waited >= options.timeoutMs) return false
    await sleep(options.intervalMs)
  }
}
