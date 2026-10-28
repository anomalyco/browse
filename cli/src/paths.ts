// Where Browse keeps its files: the installed runtime, the relay's log, session catalogs and
// journals, and captured secrets. One root, so `uninstall` can remove it and logs are easy to find.
//   macOS/Linux: $XDG_DATA_HOME/opencode-browser, else ~/.local/share/opencode-browser
//   Windows:     %LOCALAPPDATA%\opencode-browser
// OPENCODE_BROWSER_HOME overrides it (isolated test relays).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export function dataRoot(home = os.homedir()): string {
  const override = process.env.OPENCODE_BROWSER_HOME
  if (override) return override
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "opencode-browser")
  const xdg = home === os.homedir() ? process.env.XDG_DATA_HOME : undefined
  return path.join(xdg ?? path.join(home, ".local", "share"), "opencode-browser")
}

/** This package's root: cli/ in a checkout (src/paths.ts, or the dist/cli.mjs bundle), else the installed package. */
const packageRoot = () => path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Running from a source checkout (the sources are next to the bundle), not the published npm package. */
export function fromCheckout(): boolean {
  return fs.existsSync(path.join(packageRoot(), "src", "main.ts"))
}

/** The git clone this runs from (the folder above cli/), or undefined for the published package. */
export function checkoutRoot(): string | undefined {
  return fromCheckout() ? path.dirname(packageRoot()) : undefined
}

const quoted = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value))

/**
 * How to tell the user to run `opencode-browser <args>`: through npx from the published package, and with this
 * checkout's bundle from a checkout (where nothing is on PATH and the package may not be published).
 */
export function cliCommand(args: string): string {
  if (fromCheckout()) return `node ${quoted(path.join(packageRoot(), "dist", "cli.mjs"))} ${args}`
  // An installed runtime (auto-update.ts): its stable shim runs the version this install uses, which npx might not.
  const shim = path.join(dataRoot(), "bin", "opencode-browser.mjs")
  const versions = path.join(dataRoot(), "runtime", "versions")
  if (!path.relative(versions, packageRoot()).startsWith("..") && fs.existsSync(shim)) return `node ${quoted(shim)} ${args}`
  return `npx @opencode/browse ${args}`
}

declare global {
  // Injected by build.ts from the release workflow's repository variables (RELEASING.md).
  var __OPENCODE_BROWSER_STORE__: { readonly id?: string; readonly betaId?: string; readonly listed?: boolean } | undefined
}

/** A Chrome Web Store extension ID: 32 letters a to p. */
const STORE_ITEM_ID = /^[a-p]{32}$/

export type StoreConfig = {
  /** The stable store item, when the release that built this package was configured with one. */
  readonly id?: string
  /** The unlisted beta store item. */
  readonly betaId?: string
  /** The item this install's channel uses: the beta item for a beta version (else the stable one). */
  readonly channelId?: string
  /** Whether install sends new users to the store listing instead of loading the unpacked build. */
  readonly listed: boolean
}

/**
 * The Chrome Web Store items this install knows. The published package carries the IDs the release workflow baked in
 * (OPENCODE_BROWSER_STORE_ID, OPENCODE_BROWSER_BETA_STORE_ID, OPENCODE_BROWSER_STORE_LISTED at build time); the same
 * variables at run time override them (testing a store build from a checkout). Nothing else is trusted as a store ID:
 * install sends the pairing code to the extension with this ID. A checkout never sends users to the store listing.
 */
export function storeConfig(env: NodeJS.ProcessEnv = process.env, baked = globalThis.__OPENCODE_BROWSER_STORE__, checkout = fromCheckout(), version = globalThis.__OPENCODE_BROWSER_VERSION__ ?? ""): StoreConfig {
  const valid = (value: string | undefined) => (value && STORE_ITEM_ID.test(value) ? value : undefined)
  const id = valid(env.OPENCODE_BROWSER_STORE_ID) ?? valid(baked?.id)
  const betaId = valid(env.OPENCODE_BROWSER_BETA_STORE_ID) ?? valid(baked?.betaId)
  const listedFlag = env.OPENCODE_BROWSER_STORE_LISTED !== undefined ? env.OPENCODE_BROWSER_STORE_LISTED === "true" : baked?.listed === true
  const channelId = (version.includes("-beta.") ? betaId : undefined) ?? id
  return { ...(id ? { id } : {}), ...(betaId ? { betaId } : {}), ...(channelId ? { channelId } : {}), listed: !checkout && listedFlag && !!channelId }
}

/**
 * Whether install opens the Chrome Web Store listing for new users. False from a checkout and until a release is built
 * with a live listing (the CWS_ITEM_LISTED repository variable); then install guides loading the unpacked build.
 */
export const STORE_LISTED = storeConfig().listed

/** How to tell the user to install (or update) Browse. */
export function installCommand(): string {
  return fromCheckout() ? `cd ${quoted(path.dirname(packageRoot()))} && bun run setup` : "npx @opencode/browse install"
}
