import { cliCommand } from "../paths.ts"
import {
  blockedReason,
  extensionsPage,
  oldStoreBuild,
  systemEffects,
  type Browser,
  type Detection,
  type Effects,
} from "./browsers.ts"
import { connectedMessage, manualPair, pairedOfflineMessage, STORE_IDS, STORE_URL } from "./environment.ts"

export type LocateOptions = {
  allowOpen: boolean
  connected: boolean
  pairedOffline?: boolean
  /** The folder to load unpacked (a checkout's dist/, or a dev install's). Without one, the extension comes from the store item. */
  folder?: string
  detections: Detection[]
  preferred: Browser | undefined
  env: { ssh: boolean; display: boolean; tty: boolean; platform: NodeJS.Platform }
  /** The store page to open; defaults to this channel's store item. */
  storeUrl?: string
}

/**
 * Whether a browser already paired with the relay explains why nothing is connected: over SSH the browsers here aren't
 * scanned, and locally only one that has browse enabled (or couldn't be checked) counts. Running install after the
 * extension was removed finds neither, and the guidance to reinstall it is the useful answer.
 */
export function pairedOfflineApplies(pairedOffline: boolean, detections: Detection[], ssh: boolean) {
  return pairedOffline && (ssh || detections.some((detection) => detection.blocked || detection.enabled.length > 0))
}

/**
 * Reports the browsers and profiles that have browse. When none does (and none is connected to the relay),
 * guides installing it: from a checkout or a dev install, loading the unpacked build, with the browser's extensions page
 * opened, the folder revealed and its path copied; from a stable npm install, the Chrome Web Store item, whose page it opens
 * in a Chromium browser (a Safari-only machine just gets the address: browse can't run there).
 * Nothing opens when the browsers here aren't the ones the user looks at (SSH, no display),
 * with --no-open, or when a browser couldn't be checked and may already have it.
 * Returns "ready" when the extension is there, "off" when it's turned off, else "guided".
 */
export function locateExtension(options: LocateOptions, effects: Effects = systemEffects): "ready" | "off" | "guided" {
  const { log } = effects
  const listing = options.storeUrl ?? STORE_URL
  const noListing = () =>
    log(
      `! This package doesn't know its Chrome Web Store item, so it can't install the extension. Install a released version (\`npx @opencode/browse install\`), or set up browse from a checkout.`,
    )
  const pairLater = () => log(`  Once it's added, run \`${cliCommand("install")}\` again to pair it with the relay.`)
  if (options.pairedOffline) return log(pairedOfflineMessage), "ready"
  if (options.env.ssh) {
    if (options.connected) return log(connectedMessage), "ready"
    if (options.folder) unpackedSteps({ folder: options.folder, platform: options.env.platform, log })
    else if (listing) log(`Install browse in your browser from the Chrome Web Store: ${listing}`), pairLater()
    else noListing()
    return "guided"
  }
  // A connected extension is installed, even somewhere the scan doesn't look (a custom profile directory, a snap).
  if (options.connected) return log(connectedMessage), "ready"
  if (options.detections.some((detection) => detection.enabled.length)) return "ready"
  const off = options.detections.flatMap((detection) => detection.disabled)
  if (off.length) {
    log(
      `! browse is turned off in ${off.map((match) => `${match.browser.name} (${match.profile.name})`).join(", ")}. Turn it on in the browser's extensions page.`,
    )
    return "off"
  }
  const blocked = options.detections.filter((detection) => detection.blocked).map((detection) => detection.browser.name)
  if (blocked.length) log(`! Couldn't check ${blocked.join(", ")} for browse (${blockedReason()})`)
  const target = options.preferred ?? options.detections.find((detection) => !detection.blocked)?.browser
  const interactive = options.allowOpen && options.env.display
  if (!options.folder) {
    if (!listing) return noListing(), "guided"
    // No Chromium browser here means the default browser may be Safari or Firefox, which can't run the extension:
    // print the store page rather than opening it where it can't be used.
    if (!options.env.ssh && options.detections.length === 0) {
      log(
        `! browse needs a Chromium browser (Google Chrome, Brave, Microsoft Edge or Arc); it can't be added to Safari or Firefox.`,
      )
      log(`Install it from the Chrome Web Store: ${listing}`)
      pairLater()
      return "guided"
    }
    const opened =
      interactive && !blocked.length && (target ? effects.open(target, listing) : effects.openDefault?.(listing))
    log(`Add browse to ${target?.name ?? "your browser"} from the Chrome Web Store${opened ? " (opened)" : ""}: ${listing}`)
    return "guided"
  }
  // A browser that couldn't be checked may already have it: show the steps, but don't open anything over the user's work.
  const act = interactive && !blocked.length
  const page = target ? extensionsPage(target) : "chrome://extensions"
  unpackedSteps({
    folder: options.folder,
    platform: options.env.platform,
    log,
    browser: target?.name,
    page,
    opened: act && target !== undefined && effects.open(target, page),
    revealed: act && options.env.tty && effects.reveal(options.folder),
    copied: act && options.env.tty && effects.copy(options.folder),
  })
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
  if (
    interactive &&
    effects.open(match.browser, `chrome-extension://${match.id}/welcome.html#code=${options.code()}`, match.profile.dir)
  ) {
    effects.log(`✓ Opened browse in ${match.browser.name} to connect it`)
    return "opened"
  }
  effects.log(`To connect browse in ${match.browser.name}: ${manualPair(options.code())}`)
  return "manual"
}

/** The steps for loading the unpacked build, saying what install already did for each. */
function unpackedSteps(step: {
  folder: string
  platform: NodeJS.Platform
  log: (line: string) => void
  browser?: string | undefined
  page?: string
  opened?: boolean
  revealed?: boolean
  copied?: boolean
}) {
  const { log } = step
  const page = step.page ?? "chrome://extensions"
  const fileManager =
    step.platform === "darwin" ? "Finder" : step.platform === "win32" ? "Explorer" : "your file manager"
  const paste =
    step.platform === "darwin"
      ? "press Cmd+Shift+G in the folder picker and paste"
      : "paste it into the folder picker"
  log(
    `Load browse in ${step.browser ?? "your browser"}: open ${page}${step.opened ? " (opened)" : ""}, turn on Developer mode, click Load unpacked and choose ${step.folder}${step.copied ? ` (path copied: ${paste})` : step.revealed ? ` (shown in ${fileManager})` : ""}`,
  )
}

/**
 * Polls until the extension connects to the relay: true when it does, false after timeoutMs. Install waits like
 * this after printing the unpacked steps, so the user sees the moment Load unpacked worked.
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
