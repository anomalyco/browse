// Where OpenCode Browser keeps its files: the installed runtime, the relay's log, session catalogs and
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

/** The published npm package. */
export const PACKAGE_NAME = "@opencode/browse"

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
  return fromCheckout()
    ? `node ${quoted(path.join(packageRoot(), "dist", "cli.mjs"))} ${args}`
    : `npx ${PACKAGE_NAME} ${args}`
}

/**
 * Whether the Chrome Web Store listing is live. Until it is, install guides loading the unpacked build instead of
 * opening the listing; set it to true when the listing is published to restore the store flow.
 */
export const STORE_LISTED = false

/** How to tell the user to install (or update) OpenCode Browser. */
export function installCommand(): string {
  return fromCheckout() ? `cd ${quoted(path.dirname(packageRoot()))} && bun run setup` : `npx ${PACKAGE_NAME} install`
}
