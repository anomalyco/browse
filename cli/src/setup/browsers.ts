import { spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { unpackedExtensionId } from "../protocol.ts"
import { configRoot, findOnPath, home, log, readJson, STORE_IDS, windows } from "./environment.ts"

export type Browser = {
  name: string
  /** The Chromium user data directory: `Local State` and one directory per profile. */
  userData: string
  /** Where earlier versions wrote the native messaging host manifest. */
  manifests: string[]
  /** How the OS names this browser as the default: bundle IDs, desktop files, or URL ProgIds. */
  defaultIDs: string[]
  /** macOS application name, for `/Applications/<app>.app` and `open -a`. */
  app?: string
  /** Linux: binary names on PATH. Windows: full executable paths. */
  executables: string[]
}

export type Profile = { dir: string; name: string }
export type Match = { browser: Browser; profile: Profile; id: string; version?: string }
export const oldStoreBuild = (match: Match) => /^0\.0\.[012]$/.test(match.version ?? "")
/** blocked: the OS refused to read the browser's data (macOS privacy protection), so it may have the extension. */
export type Detection = { browser: Browser; blocked: boolean; enabled: Match[]; disabled: Match[] }

/** What locateExtension may do outside the terminal; stubbed in tests so they never open a real browser. */
export type Effects = {
  /** Opens a URL in a specific browser (and profile directory); false when it couldn't be handed to one. */
  open(browser: Browser, url: string, profile?: string): boolean
  openDefault?(url: string): boolean
  /** Shows the folder in the file manager, selected where the OS can, so it can be dragged. */
  reveal(folder: string): boolean
  /** Puts text on the clipboard; false when there is no clipboard tool. */
  copy(text: string): boolean
  log(line: string): void
}

export type ExtensionSetting = { disable_reasons?: unknown; manifest?: { version?: string }; path?: string }

export function browsers(): Browser[] {
  if (process.platform === "darwin") {
    const support = (dir: string) => path.join(home, "Library/Application Support", dir)
    const browser = (name: string, app: string, bundleID: string, dirs: string[]): Browser => ({
      name,
      app,
      userData: support(dirs[0]!),
      manifests: dirs.map((dir) => path.join(support(dir), "NativeMessagingHosts")),
      defaultIDs: [bundleID],
      executables: [],
    })
    return [
      browser("Google Chrome", "Google Chrome", "com.google.Chrome", ["Google/Chrome"]),
      browser("Chrome for Testing", "Google Chrome for Testing", "com.google.chrome.for.testing", [
        "Google/Chrome for Testing",
        "Google/ChromeForTesting",
      ]),
      browser("Google Chrome Beta", "Google Chrome Beta", "com.google.Chrome.beta", ["Google/Chrome Beta"]),
      browser("Google Chrome Canary", "Google Chrome Canary", "com.google.Chrome.canary", ["Google/Chrome Canary"]),
      browser("Chromium", "Chromium", "org.chromium.Chromium", ["Chromium"]),
      browser("Microsoft Edge", "Microsoft Edge", "com.microsoft.edgemac", ["Microsoft Edge"]),
      browser("Brave", "Brave Browser", "com.brave.Browser", ["BraveSoftware/Brave-Browser"]),
      browser("Opera", "Opera", "com.operasoftware.Opera", ["com.operasoftware.Opera"]),
      browser("Vivaldi", "Vivaldi", "com.vivaldi.Vivaldi", ["Vivaldi"]),
      browser("Helium", "Helium", "net.imput.helium", ["net.imput.helium"]),
      browser("Arc", "Arc", "company.thebrowser.Browser", ["Arc/User Data"]),
      browser("Dia", "Dia", "company.thebrowser.dia", ["Dia/User Data"]),
      browser("Comet", "Comet", "ai.perplexity.comet", ["Comet"]),
    ]
  }
  if (windows) {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
    const programs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], local].filter(
      (dir): dir is string => !!dir,
    )
    const installs = (relative: string) => programs.map((dir) => path.join(dir, relative))
    return [
      {
        name: "Google Chrome",
        userData: path.join(local, "Google", "Chrome", "User Data"),
        manifests: [],
        defaultIDs: ["ChromeHTML"],
        executables: installs("Google\\Chrome\\Application\\chrome.exe"),
      },
      {
        name: "Microsoft Edge",
        userData: path.join(local, "Microsoft", "Edge", "User Data"),
        manifests: [],
        defaultIDs: ["MSEdgeHTM"],
        executables: installs("Microsoft\\Edge\\Application\\msedge.exe"),
      },
      {
        name: "Brave",
        userData: path.join(local, "BraveSoftware", "Brave-Browser", "User Data"),
        manifests: [],
        defaultIDs: ["BraveHTML"],
        executables: installs("BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
      },
      {
        name: "Opera",
        userData: path.join(roaming, "Opera Software", "Opera Stable"),
        manifests: [],
        defaultIDs: ["OperaStable"],
        executables: installs("Programs\\Opera\\opera.exe"),
      },
      {
        name: "Vivaldi",
        userData: path.join(local, "Vivaldi", "User Data"),
        manifests: [],
        defaultIDs: ["VivaldiHTM"],
        executables: installs("Vivaldi\\Application\\vivaldi.exe"),
      },
    ]
  }
  // Chrome-family builds honor CHROME_CONFIG_HOME before XDG_CONFIG_HOME.
  const chrome = process.env.CHROME_CONFIG_HOME ?? configRoot
  const browser = (name: string, rootDir: string, dir: string, executables: string[]): Browser => ({
    name,
    userData: path.join(rootDir, dir),
    manifests: [path.join(rootDir, dir, "NativeMessagingHosts")],
    defaultIDs: executables,
    executables,
  })
  return [
    browser("Google Chrome", chrome, "google-chrome", ["google-chrome", "google-chrome-stable"]),
    browser("Google Chrome Beta", chrome, "google-chrome-beta", ["google-chrome-beta"]),
    browser("Google Chrome Unstable", chrome, "google-chrome-unstable", ["google-chrome-unstable"]),
    browser("Chrome for Testing", chrome, "google-chrome-for-testing", ["google-chrome-for-testing"]),
    browser("Chromium", chrome, "chromium", ["chromium", "chromium-browser"]),
    browser("Microsoft Edge", configRoot, "microsoft-edge", ["microsoft-edge", "microsoft-edge-stable"]),
    browser("Brave", configRoot, "BraveSoftware/Brave-Browser", ["brave-browser", "brave"]),
    browser("Opera", configRoot, "opera", ["opera"]),
    browser("Vivaldi", configRoot, "vivaldi", ["vivaldi", "vivaldi-stable"]),
    browser("Helium", configRoot, "net.imput.helium", ["helium", "helium-browser"]),
  ]
}

/** The browser's own extensions page; every Chromium browser also accepts chrome://, these rewrite it to their scheme. */
export function extensionsPage(browser: Pick<Browser, "name">) {
  const scheme = (
    { "Microsoft Edge": "edge", Brave: "brave", Vivaldi: "vivaldi", Opera: "opera" } as Record<string, string>
  )[browser.name]
  return `${scheme ?? "chrome"}://extensions`
}

/** Every browser with user data here, and the profiles that have Browse. */
export function detectBrowsers() {
  return browsers().flatMap((browser): Detection[] => {
    const state = readLocked(path.join(browser.userData, "Local State"))
    if (state.missing) return []
    // Leftover data of an uninstalled browser: nothing to open it with.
    if (state.blocked) return launcher(browser) ? [{ browser, blocked: true, enabled: [], disabled: [] }] : []
    let blocked = false
    const matches = listProfiles(browser, state.text).flatMap((profile) => {
      const settings = ["Secure Preferences", "Preferences"].map((file) => {
        const prefs = readLocked(path.join(browser.userData, profile.dir, file))
        blocked ||= prefs.blocked
        return (
          (parseJson(prefs.text) as { extensions?: { settings?: Record<string, ExtensionSetting> } } | undefined)
            ?.extensions?.settings ?? {}
        )
      })
      const id = [...STORE_IDS, unpackedExtensionId].find((candidate) => settings.some((entries) => entries[candidate]))
      if (!id) return []
      const setting = settings.find((entries) => entries[id])![id]!
      const version = installedExtensionVersion(id, setting)
      return [{ browser, profile, id, ...(version ? { version } : {}), enabled: !disabled(setting) }]
    })
    return [
      {
        browser,
        blocked,
        enabled: matches.filter((match) => match.enabled),
        disabled: matches.filter((match) => !match.enabled),
      },
    ]
  })
}

export function installedExtensionVersion(id: string, setting: ExtensionSetting) {
  if (setting.manifest?.version) return setting.manifest.version
  if (!setting.path) return undefined
  // Chromium omits the cached manifest for unpacked installs. Packed ones also record <id>/<version>_<index>.
  if (path.isAbsolute(setting.path))
    return readJson<{ version?: string }>(path.join(setting.path, "manifest.json"))?.version
  const packed = /^([a-p]{32})[/\\](\d+(?:\.\d+){0,3})_\d+$/.exec(setting.path)
  return packed?.[1] === id ? packed[2] : undefined
}

function disabled(setting: ExtensionSetting) {
  const reasons = setting.disable_reasons
  if (Array.isArray(reasons)) return reasons.length > 0
  return typeof reasons === "number" && reasons !== 0
}

/** Profiles from `Local State` (with their display names), else the profile directories themselves. */
function listProfiles(browser: Browser, localState: string | undefined): Profile[] {
  const cache = (
    parseJson(localState) as { profile?: { info_cache?: Record<string, { name?: string }> } } | undefined
  )?.profile?.info_cache
  if (cache && Object.keys(cache).length)
    return Object.entries(cache).map(([dir, info]) => ({ dir, name: info.name || dir }))
  const dirs = (() => {
    try {
      return readdirSync(browser.userData)
    } catch {
      return []
    }
  })()
  return dirs.filter((dir) => /^(Default|Profile \d+)$/.test(dir)).map((dir) => ({ dir, name: dir }))
}

function readLocked(file: string) {
  try {
    return { text: readFileSync(file, "utf8"), missing: false, blocked: false }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      text: undefined,
      missing: code === "ENOENT" || code === "ENOTDIR",
      blocked: code === "EPERM" || code === "EACCES",
    }
  }
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The OS default web browser among the known ones; undefined when it can't be told or isn't Chromium. */
export function defaultBrowser(candidates: Browser[]) {
  const id = defaultBrowserID()
  if (!id) return undefined
  const known = browsers().find((browser) =>
    browser.defaultIDs.some((name) => name.toLowerCase() === id.toLowerCase() || id.startsWith(`${name}.`)),
  )
  return known && (candidates.find((browser) => browser.name === known.name) ?? known)
}

function defaultBrowserID() {
  if (process.platform === "darwin") {
    const plist = path.join(home, "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist")
    const json = spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" })
    const handlers =
      (
        parseJson(json.stdout) as
          | { LSHandlers?: { LSHandlerURLScheme?: string; LSHandlerRoleAll?: string }[] }
          | undefined
      )?.LSHandlers ?? []
    return ["https", "http"]
      .map((scheme) => handlers.find((handler) => handler.LSHandlerURLScheme === scheme)?.LSHandlerRoleAll)
      .find((bundle) => !!bundle)
  }
  if (windows) {
    const key = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice"
    const query = spawnSync("reg", ["query", key, "/v", "ProgId"], { encoding: "utf8" })
    return /ProgId\s+REG_SZ\s+(\S+)/.exec(query.stdout ?? "")?.[1]
  }
  const xdg = spawnSync("xdg-settings", ["get", "default-web-browser"], { encoding: "utf8" })
  return xdg.status === 0 ? xdg.stdout.trim().replace(/\.desktop$/, "") || undefined : undefined
}

export function reportDetections(detections: Detection[], preferred: Browser | undefined, writeLog: (line: string) => void) {
  writeLog(`Default browser: ${preferred?.name ?? "unknown"}`)
  detections.forEach((detection) => {
    const name = detection.browser.name
    if (detection.blocked) return writeLog(`  ${name}: couldn't check (${blockedReason()})`)
    if (detection.enabled.length)
      return writeLog(`  ${name}: Browse in ${detection.enabled.map(describe).join(", ")}`)
    if (detection.disabled.length)
      return writeLog(`  ${name}: Browse turned off in ${detection.disabled.map(describe).join(", ")}`)
    writeLog(`  ${name}: no Browse`)
  })
}

const describe = (match: Match) => `${match.profile.name}${match.id === unpackedExtensionId ? " (unpacked)" : ""}`
const blockedReason = () => (process.platform === "darwin" ? "macOS privacy protection" : "permission denied")

/**
 * Opens a URL in a specific browser by launching its executable with the URL, which forwards it to a running
 * instance; chrome:// URLs only open this way. Without the executable, an https URL goes through the OS, which on
 * macOS can still pick the app; a chrome:// URL can't (it isn't a scheme the OS knows), so it's left to the user.
 */
function openInBrowser(browser: Browser, url: string, profile?: string) {
  const executable = launcher(browser)?.executable
  const web = /^https?:/.test(url)
  if (executable) {
    const child = spawn(executable, [...(profile ? [`--profile-directory=${profile}`] : []), url], {
      detached: true,
      stdio: "ignore",
    })
    child.on("error", () => web && openWithSystem(browser, url))
    child.unref()
    return true
  }
  if (!web) return false
  return openWithSystem(browser, url)
}

function openWithSystem(browser: Browser | undefined, url: string) {
  if (process.platform === "darwin")
    return spawnSync("open", browser?.app ? ["-a", browser.app, url] : [url]).status === 0
  // rundll32 hands the URL to its handler without cmd parsing the & in it.
  if (windows) return spawnSync("rundll32", ["url.dll,FileProtocolHandler", url]).status === 0
  return spawnSync("xdg-open", [url]).status === 0
}

/** Shows the folder selected in its parent (Finder, Explorer), or opens the parent (Linux file managers). */
export function revealFolder(folder: string) {
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { stdio: "ignore", timeout: 10_000 })
    // explorer exits 1 even when it opened the window.
    return !result.error && (windows || result.status === 0)
  }
  if (process.platform === "darwin") return run("open", ["-R", folder])
  if (windows) return run("explorer", [`/select,${folder}`])
  return run("xdg-open", [path.dirname(folder)])
}

/** Copies text with the platform's clipboard tool: pbcopy, clip, or wl-copy / xclip / xsel. */
function copyToClipboard(text: string) {
  const tools: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : windows
        ? [["clip", []]]
        : [
            ...(process.env.WAYLAND_DISPLAY ? [["wl-copy", []] as [string, string[]]] : []),
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ]
  return tools.some(([command, args]) => {
    const result = spawnSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 5_000 })
    return !result.error && result.status === 0
  })
}

export const systemEffects: Effects = {
  open: openInBrowser,
  openDefault: (url) => openWithSystem(undefined, url),
  reveal: revealFolder,
  copy: copyToClipboard,
  log,
}

/** The browser's executable, or (macOS) just its app bundle when the executable can't be read. */
function launcher(browser: Browser): { executable?: string } | undefined {
  if (process.platform === "darwin") {
    const bundle = [
      path.join("/Applications", `${browser.app}.app`),
      path.join(home, "Applications", `${browser.app}.app`),
    ].find((dir) => existsSync(dir))
    if (!bundle) return undefined
    const name = spawnSync(
      "plutil",
      ["-extract", "CFBundleExecutable", "raw", "-o", "-", path.join(bundle, "Contents", "Info.plist")],
      { encoding: "utf8" },
    ).stdout?.trim()
    const executable = name ? path.join(bundle, "Contents", "MacOS", name) : undefined
    return executable && existsSync(executable) ? { executable } : {}
  }
  const executable = windows
    ? browser.executables.find((file) => existsSync(file))
    : browser.executables.map(findOnPath).find((file) => !!file)
  return executable ? { executable } : undefined
}
