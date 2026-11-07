// Where browse keeps its files, on every OS (the same scheme opencode uses on macOS):
//   config  $XDG_CONFIG_HOME/browse      settings.json, config.json
//   data    $XDG_DATA_HOME/browse        session catalogs, secrets, auth profiles, paired browsers
//   state   $XDG_STATE_HOME/browse       logs, journals, current session, pairing codes, update state
//   cache   $XDG_CACHE_HOME/browse       update checks and the dev extension (re-creatable)
//   bin     $XDG_BIN_HOME              the installer's executable (XDG_BIN_HOME, else ~/.local/bin)// Unset variables fall back to ~/.config, ~/.local/share, ~/.local/state, ~/.cache and ~/.local/bin;
// Windows uses the same paths under %USERPROFILE%. OPENCODE_BROWSER_HOME overrides all of them for isolated
// test relays (the executable then lives in <root>/bin).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const override = (home: string) =>
  home === os.homedir() && process.env.OPENCODE_BROWSER_HOME ? process.env.OPENCODE_BROWSER_HOME : undefined

const xdgRoot = (variable: string, fallback: string, home: string) => {
  const configured = home === os.homedir() ? process.env[variable] : undefined
  return path.join(configured && path.isAbsolute(configured) ? configured : path.join(home, fallback), "browse")
}

/** The config folder without the OPENCODE_BROWSER_HOME override: where an everyday install keeps its settings. */
function defaultConfigRoot(home = os.homedir()): string {
  return xdgRoot("XDG_CONFIG_HOME", ".config", home)
}

/** Browse's XDG folders without the OPENCODE_BROWSER_HOME override: an everyday install still writes them. */
export function defaultRoots(home = os.homedir()): {
  readonly config: string
  readonly data: string
  readonly state: string
  readonly cache: string
} {
  return {
    config: defaultConfigRoot(home),
    data: xdgRoot("XDG_DATA_HOME", ".local/share", home),
    state: xdgRoot("XDG_STATE_HOME", ".local/state", home),
    cache: xdgRoot("XDG_CACHE_HOME", ".cache", home),
  }
}

export function configRoot(home = os.homedir()): string {
  return override(home) ?? defaultConfigRoot(home)
}

export function dataRoot(home = os.homedir()): string {
  return override(home) ?? xdgRoot("XDG_DATA_HOME", ".local/share", home)
}

export function stateRoot(home = os.homedir()): string {
  return override(home) ?? xdgRoot("XDG_STATE_HOME", ".local/state", home)
}

export function cacheRoot(home = os.homedir()): string {
  return override(home) ?? xdgRoot("XDG_CACHE_HOME", ".cache", home)
}

/** The installers' folder: $XDG_BIN_HOME when absolute, else ~/.local/bin (the same on Windows under %USERPROFILE%). */
function installerBinRoot(home = os.homedir()): string {
  const configured = home === os.homedir() ? process.env.XDG_BIN_HOME : undefined
  return configured && path.isAbsolute(configured) ? configured : path.join(home, ".local", "bin")
}

/** The executable's folder: $OPENCODE_BROWSER_HOME/bin when that override is set, else the installers' folder. */
export function binRoot(home = os.homedir()): string {
  if (override(home)) return path.join(override(home)!, "bin")
  return installerBinRoot(home)
}

/** The executable agents run: $OPENCODE_BROWSER_HOME/bin when set, else the installers' folder. */
export const installedBinaryPath = (home = os.homedir()) => path.join(binRoot(home), binaryName())

/** The executable the installers wrote, independent of where OPENCODE_BROWSER_HOME points the CLI. */
export const installerBinaryPath = (home = os.homedir()) => path.join(installerBinRoot(home), binaryName())

/** An everyday install's settings, independent of where OPENCODE_BROWSER_HOME points the CLI. */
export const defaultSettingsPath = (home = os.homedir()) => path.join(defaultConfigRoot(home), "settings.json")

/** This package's root: cli/ in a checkout (src/paths.ts, or the dist/cli.mjs bundle), else the installed package. */
const packageRoot = () => path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// The store's v0.0.2 never dials a relay without a long code. Install records that it saw this build;
// the relay can then explain the mismatch even though it received no hello. A new install/hello clears it.
export const oldStoreMarker = () => path.join(stateRoot(), "old-store-extension")

/** Running from a source checkout (the sources are next to the bundle), not the published npm package. */
export function fromCheckout(): boolean {
  return !compiledBinary() && fs.existsSync(path.join(packageRoot(), "src", "main.ts"))
}

/** A standalone executable (script/compile.ts), which the install script puts in ~/.local/bin; not Node and npm. */
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

/** The executable a binary install put on PATH, when it is there. */
export function installedBinary(): string | undefined {
  const binary = installedBinaryPath()
  return fs.existsSync(binary) ? binary : undefined
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
  | { readonly kind: "npm"; readonly version?: string | undefined; readonly npx?: boolean | undefined }
  | { readonly kind: "checkout"; readonly bundle: string }

export function cliInstall(): CliInstall {
  if (compiledBinary()) return { kind: "binary", binary: installedBinary() ?? process.execPath, pathEnv: process.env.PATH }
  if (fromCheckout()) return { kind: "checkout", bundle: path.join(packageRoot(), "dist", "cli.mjs") }
  return { kind: "npm", version: globalThis.__OPENCODE_BROWSER_VERSION__, npx: /[/\\]_npx[/\\]/.test(process.argv[1] ?? "") }
}

/**
 * The command that runs browse in a terminal: `browse` for a binary or global npm install on PATH (install adds the
 * binary's folder), the executable's full path when it isn't on PATH, `npx @opencode/browse` (`@dev` on the dev
 * channel) for an npx run, and this checkout's bundle from a checkout, where the package may not be published.
 */
export function cliPrefix(install: CliInstall = cliInstall()): string {
  if (install.kind === "binary") {
    const dir = path.dirname(install.binary)
    const onPath = (install.pathEnv ?? "").split(path.delimiter).some((entry) => entry && path.resolve(entry) === dir)
    return onPath ? "browse" : quoted(install.binary)
  }
  if (install.kind === "checkout") return `node ${quoted(install.bundle)}`
  if (install.npx) return install.version?.includes("-dev.") ? "npx @opencode/browse@dev" : "npx @opencode/browse"
  return "browse"
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
export const devExtensionFolder = (root = cacheRoot()) => path.join(root, "extension")

/** The store page of an item. */
export const storeUrl = (id: string) => `https://chromewebstore.google.com/detail/${id}`

/** How to tell the user to install (or update) browse. */
export function installCommand(): string {
  return fromCheckout() ? `cd ${quoted(path.dirname(packageRoot()))} && bun run setup` : cliCommand("install")
}
