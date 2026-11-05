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

/** How this CLI was installed, for the command a person types to run it (cliPrefix). */
export type CliInstall =
  | { readonly kind: "binary"; readonly binary: string; readonly pathEnv?: string | undefined }
  | { readonly kind: "npm"; readonly version?: string | undefined }
  | { readonly kind: "checkout"; readonly bundle: string }

export function cliInstall(): CliInstall {
  // A binary install's executable on PATH (auto-update.ts current.json), not the version an MCP server runs from.
  if (compiledBinary()) return { kind: "binary", binary: installedBinary() ?? process.execPath, pathEnv: process.env.PATH }
  if (fromCheckout()) return { kind: "checkout", bundle: path.join(packageRoot(), "dist", "cli.mjs") }
  return { kind: "npm", version: globalThis.__OPENCODE_BROWSER_VERSION__ }
}

/**
 * The command that runs browse in a terminal: `browse` for a binary install once its folder is on PATH (install adds
 * it), else the executable's full path; `npx @opencode/browse` (`@dev` on the dev channel) for an npm install, which
 * puts nothing on PATH; and this checkout's bundle from a checkout, where the package may not be published.
 */
export function cliPrefix(install: CliInstall = cliInstall()): string {
  if (install.kind === "binary") {
    const dir = path.dirname(install.binary)
    const onPath = (install.pathEnv ?? "").split(path.delimiter).some((entry) => entry && path.resolve(entry) === dir)
    return onPath ? "browse" : quoted(install.binary)
  }
  if (install.kind === "checkout") return `node ${quoted(install.bundle)}`
  return install.version?.includes("-dev.") ? "npx @opencode/browse@dev" : "npx @opencode/browse"
}

/** How to tell the user to run `browse <args>` (cliPrefix). */
export const cliCommand = (args: string, install: CliInstall = cliInstall()): string => `${cliPrefix(install)} ${args}`

declare global {
  // Injected by build.ts: the store item from the release workflow's repository variables (RELEASING.md), and for a
  // dev build the unpacked extension zip it was built with, published to the release service.
  var __OPENCODE_BROWSER_STORE__: { readonly id?: string } | undefined
  var __OPENCODE_BROWSER_EXTENSION__: DevExtension | undefined
}

/** A Chrome Web Store extension ID: 32 letters a to p. */
const STORE_ITEM_ID = /^[a-p]{32}$/

/**
 * browse's public Chrome Web Store item (the CWS_ITEM_ID repository variable, RELEASING.md). A checkout, or a package
 * built without one, still points users at this item: every channel installs browse from the store.
 */
export const PUBLIC_STORE_ID = "mfnicocicmmlkpjnaffgihfjhdgjkdjg"

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

/** Where the release service serves a file; OPENCODE_BROWSER_RELEASE_SERVICE points it elsewhere (tests; the sha256 is still checked). */
export const devExtensionUrl = (extension: DevExtension, env: NodeJS.ProcessEnv = process.env) =>
  `${(env.OPENCODE_BROWSER_RELEASE_SERVICE || RELEASE_SERVICE).replace(/\/+$/, "")}/browse/files/${extension.sha256}/${extension.file}`

/** The folder a dev install's unpacked extension lives in (loaded once with Load unpacked; updates replace its files). */
export const devExtensionFolder = (root = dataRoot()) => path.join(root, "extension")

/** The store page of an item. */
export const storeUrl = (id: string) => `https://chromewebstore.google.com/detail/${id}`

/** How to tell the user to install (or update) browse. */
export function installCommand(): string {
  return fromCheckout() ? `cd ${quoted(path.dirname(packageRoot()))} && bun run setup` : cliCommand("install")
}
