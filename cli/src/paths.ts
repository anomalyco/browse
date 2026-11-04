// Where browse keeps its files: the installed runtime, the relay's log, session catalogs and
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

// The store's v0.0.2 never dials a relay without a long code. Install records that it saw this build;
// the relay can then explain the mismatch even though it received no hello. A new install/hello clears it.
export const oldStoreMarker = () => path.join(dataRoot(), "old-store-extension")

/** Running from a source checkout (the sources are next to the bundle), not the published npm package. */
export function fromCheckout(): boolean {
  return !compiledBinary() && fs.existsSync(path.join(packageRoot(), "src", "main.ts"))
}

/** A standalone executable (script/compile.ts), which the install script puts in ~/.browse/bin; not Node and npm. */
export const compiledBinary = (): boolean => globalThis.__OPENCODE_BROWSER_COMPILED__ === true

/** The npm package that carries this executable's platform build, e.g. @opencode/browse-darwin-arm64. */
export const binaryPackage = (): string | undefined =>
  globalThis.__OPENCODE_BROWSER_TARGET__ ? `@opencode/browse-${globalThis.__OPENCODE_BROWSER_TARGET__}` : undefined

/** The executable's file name in its package (package/bin/) and in an installed version's directory. */
export const binaryName = (platform: NodeJS.Platform = process.platform) => (platform === "win32" ? "browse.exe" : "browse")

/** A CLI entry Node runs (a bundle or source file), as opposed to an executable that runs by itself. */
export const scriptEntry = (entry: string) => /\.[cm]?[jt]s$/.test(entry)

/** The command that runs the CLI at `entry`: `<node> <entry>` for a script, the executable itself otherwise. */
export const entryCommand = (entry: string, node = process.execPath): string[] => (scriptEntry(entry) ? [node, entry] : [entry])

/** The executable a binary install put on PATH, as runtime/current.json records it (auto-update.ts). */
function installedBinary(): string | undefined {
  try {
    const binary = (JSON.parse(fs.readFileSync(path.join(dataRoot(), "runtime", "current.json"), "utf8")) as { binary?: unknown }).binary
    return typeof binary === "string" ? binary : undefined
  } catch {
    return undefined
  }
}

/** This process's own CLI entry: the executable, or the script Node runs. */
export const runningEntry = (): string => (compiledBinary() ? process.execPath : process.argv[1]!)

/** The git clone this runs from (the folder above cli/), or undefined for the published package. */
export function checkoutRoot(): string | undefined {
  return fromCheckout() ? path.dirname(packageRoot()) : undefined
}

const quoted = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value))

/**
 * How to tell the user to run `opencode-browser <args>`: through npx from the published package (the dev channel when
 * this build carries a dev extension; see npxCommand), and with this checkout's bundle from a checkout (where nothing is
 * on PATH and the package may not be published).
 */
export function cliCommand(args: string): string {
  if (compiledBinary()) {
    // A binary install's executable on PATH (auto-update.ts current.json), not the version an MCP server runs from;
    // `browse` once its folder is on PATH (install adds it), else its full path.
    const binary = installedBinary() ?? process.execPath
    const dir = path.dirname(binary)
    const onPath = (process.env.PATH ?? "").split(path.delimiter).some((entry) => entry && path.resolve(entry) === dir)
    return `${onPath ? "browse" : quoted(binary)} ${args}`
  }
  if (fromCheckout()) return `node ${quoted(path.join(packageRoot(), "dist", "cli.mjs"))} ${args}`
  // An installed runtime (auto-update.ts): its stable shim runs the version this install uses, which npx might not.
  const shim = path.join(dataRoot(), "bin", "opencode-browser.mjs")
  const versions = path.join(dataRoot(), "runtime", "versions")
  if (!path.relative(versions, packageRoot()).startsWith("..") && fs.existsSync(shim)) return `node ${quoted(shim)} ${args}`
  return npxCommand(args)
}

declare global {
  // Injected by build.ts: the store item from the release workflow's repository variables (RELEASING.md), and for a
  // dev build the unpacked extension zip it was built with, published to the release service.
  var __OPENCODE_BROWSER_STORE__: { readonly id?: string } | undefined
  var __OPENCODE_BROWSER_EXTENSION__: DevExtension | undefined
}

/** A Chrome Web Store extension ID: 32 letters a to p. */
const STORE_ITEM_ID = /^[a-p]{32}$/

export type StoreConfig = {
  /** The public store item, when the release that built this package was configured with one. */
  readonly id?: string
}

/**
 * The Chrome Web Store item this install knows. The published package carries the ID the release workflow baked in
 * (OPENCODE_BROWSER_STORE_ID at build time); the same variable at run time overrides it (testing a store build from a
 * checkout). Nothing else is trusted as a store ID: install sends the pairing code to the extension with this ID.
 * A stable npm install gets the extension from this item, a dev install from the release service (devExtension), and a
 * checkout loads dist/ unpacked.
 */
export function storeConfig(env: NodeJS.ProcessEnv = process.env, baked = globalThis.__OPENCODE_BROWSER_STORE__): StoreConfig {
  const id = [env.OPENCODE_BROWSER_STORE_ID, baked?.id].find((value) => value && STORE_ITEM_ID.test(value))
  return id ? { id } : {}
}

/** The unpacked extension zip a dev build was built with: content-addressed on the release service, so exactly these bytes. */
export type DevExtension = { readonly file: string; readonly sha256: string; readonly size: number }

/** Anomaly's release service (github.com/anomalyco/release), where every push to dev publishes the dev extension. */
export const RELEASE_SERVICE = "https://anoma.ly/release"

/** The dev extension this package was built with; undefined for stable releases and checkouts. */
export function devExtension(baked = globalThis.__OPENCODE_BROWSER_EXTENSION__): DevExtension | undefined {
  return baked && /^[0-9a-f]{64}$/.test(baked.sha256) && /^[\w.-]+\.zip$/.test(baked.file) ? baked : undefined
}

/**
 * How to tell the user to run the published package with `args`: a dev build carries a dev extension (devExtension),
 * whose extension only the dev channel publishes, so it runs `@opencode/browse@dev`; stable builds run the default tag.
 * Checkouts and installed runtimes take their own branches in cliCommand/installCommand, so they never see this. Going
 * through devExtension() rather than the baked global keeps its sha256/filename validation and build.ts's substitution
 * in one place.
 */
export function npxCommand(args: string, dev = devExtension()): string {
  return `npx @opencode/browse${dev ? "@dev" : ""} ${args}`
}

/** Where the release service serves a file; OPENCODE_BROWSER_RELEASE_SERVICE points it elsewhere (tests; the sha256 is still checked). */
export const devExtensionUrl = (extension: DevExtension, env: NodeJS.ProcessEnv = process.env) =>
  `${(env.OPENCODE_BROWSER_RELEASE_SERVICE || RELEASE_SERVICE).replace(/\/+$/, "")}/browse/files/${extension.sha256}/${extension.file}`

/** The folder a dev install's unpacked extension lives in (loaded once with Load unpacked; updates replace its files). */
export const devExtensionFolder = (root = dataRoot()) => path.join(root, "extension")

/** The store page of an item. */
export const storeUrl = (id: string) => `https://chromewebstore.google.com/detail/${id}`

/** How to tell the user to install (or update) browse; the npx form follows the dev channel when this build carries a dev extension. */
export function installCommand(): string {
  if (compiledBinary()) return cliCommand("install")
  return fromCheckout() ? `cd ${quoted(path.dirname(packageRoot()))} && bun run setup` : npxCommand("install")
}
