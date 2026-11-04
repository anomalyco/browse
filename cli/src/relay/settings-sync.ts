import { Effect } from "effect"
import { autoUpdateModes, autoUpdateOverride, autoUpdateStatus, setStoredMode, storedMode, type AutoUpdateMode } from "../auto-update.ts"
import type { BrowserLink, BrowserLinks } from "../browser-links.ts"
import type { ExtensionRpc } from "../extension-rpc.ts"
import type { GhostCursorTabs } from "../ghost-cursor.ts"
import { humanInputEnabled, humanInputOverride } from "../human-input.ts"
import { installCommand } from "../paths.ts"
import type { JsonObject } from "../protocol.ts"
import { HttpRouteError } from "../relay-helpers.ts"
import { relayLog } from "../relay-log.ts"
import {
  describeChanges,
  describeSettings,
  parseSettingChanges,
  settingsFromExtension,
  SettingsInputError,
  settingsToExtension,
  type SettingOverrides,
  type Settings,
} from "../user-settings.ts"
import type { ExtensionHandshake } from "./extension-handshake.ts"

type ExtensionCommandInput = Parameters<ExtensionRpc["send"]>[0]

export function createRelaySettingsSync(options: {
  readonly browsers: BrowserLinks
  readonly handshake: ExtensionHandshake
  readonly ghostCursor: GhostCursorTabs
  readonly ghostCursorEnv: boolean | undefined
  readonly agentWindow: "current" | "separate" | undefined
  readonly sendToExtension: (command: ExtensionCommandInput, link?: BrowserLink) => Effect.Effect<JsonObject, Error>
  readonly sendExtensionBestEffort: (command: ExtensionCommandInput, link?: BrowserLink) => void
}) {
  const { browsers, handshake, ghostCursor, ghostCursorEnv, agentWindow, sendToExtension, sendExtensionBestEffort } = options

  /** The extension's settings with the relay's own (autoUpdate) filled in from the data root. */
  const withRelaySettings = (settings: Settings): Settings => ({ ...settings, autoUpdate: storedMode() })

  /** The same, for the settings tool: by setting, with the variable that fixes it and the value in effect. */
  const userSettingOverrides = (): SettingOverrides => {
    const human = humanInputOverride()
    const autoUpdate = autoUpdateOverride()
    return {
      ...(autoUpdate ? { autoUpdate: { variable: process.env.OPENCODE_BROWSER_AUTO_UPDATE !== undefined ? "OPENCODE_BROWSER_AUTO_UPDATE" : "OPENCODE_BROWSER_UPDATE_CHECK", value: autoUpdate } } : {}),
      ...(agentWindow ? { window: { variable: "OPENCODE_BROWSER_AGENT_WINDOW", value: agentWindow } } : {}),
      ...(ghostCursorEnv === undefined ? {} : { cursor: { variable: "OPENCODE_BROWSER_GHOST_CURSOR", value: ghostCursorEnv ? "always" : "off" } }),
      ...(human === undefined ? {} : { humanInput: { variable: "OPENCODE_BROWSER_HUMAN_INPUT", value: human ? "on" : "off" } }),
    }
  }

  // With several browsers, the settings tool reads and changes the default browser's.
  const extensionSettings = (method: "settings.get" | "settings.set", values?: JsonObject) =>
    Effect.gen(function* () {
      if (!browsers.connected) {
        const rejected = handshake.rejectedProtocol()
        return yield* Effect.fail(new Error(rejected ? handshake.mismatchAdvice(rejected.version) : "The Browse extension isn't connected, so its settings can't be read or changed. Ask the user to open the browser with the extension; its options page shows whether it's connected."))
      }
      const result = yield* sendToExtension({ method, ...(values ? { params: { values } } : {}) }).pipe(
        Effect.mapError((error) => /Invalid extension command/.test(error.message)
          ? new Error(`The connected Browse extension is too old to read or change settings from here. Update browse (\`${installCommand()}\`) and reload the extension, or change them on its options page.`)
          : error),
      )
      return settingsFromExtension(result)
    })

  /** The settings the relay's environment fixes, for the extension's status page. */
  const settingOverrides = (): JsonObject => {
    const human = humanInputOverride()
    return {
      ...(agentWindow ? { agentWindow } : {}),
      ...(ghostCursorEnv === undefined ? {} : { cursor: ghostCursorEnv ? "always" : "off" }),
      ...(human === undefined ? {} : { humanInput: human ? "on" : "off" }),
    }
  }

  /** What the status pages show from the relay: the settings its environment fixes, and the update state. */
  const sendRelaySettings = (): void => {
    for (const link of browsers.list()) {
      if (!link.rpc.connected) continue
      sendExtensionBestEffort({
        method: "relay.settings",
        params: { overrides: settingOverrides(), autoUpdate: autoUpdateStatus() as unknown as JsonObject, browser: { id: link.id, name: link.name } },
      }, link)
    }
  }

  /**
   * The extension's status page settings (its `settings` event, sent after pairing and on every change). Only the
   * known values count; anything else leaves that setting as it was. Environment variables still win. The answer tells
   * the status page which settings the environment fixes.
   */
  const applyExtensionSettings = (link: BrowserLink, params: JsonObject | undefined): void => {
    const cursor = params?.cursor
    if (cursor === "off" || cursor === "always") link.cursor = cursor === "always"
    const human = params?.humanInput
    if (human === "on" || human === "off") link.humanInput = human === "on"
    const autoUpdate = params?.autoUpdate
    if (typeof autoUpdate === "string" && (autoUpdateModes as readonly string[]).includes(autoUpdate)) {
      setStoredMode(autoUpdate as AutoUpdateMode)
      relayLog("autoupdate.mode", { mode: autoUpdate })
    }
    relayLog("extension.settings", { browser: link.id, cursor: (ghostCursorEnv ?? link.cursor) ? "always" : "off", humanInput: humanInputEnabled(link.humanInput) ? "on" : "off" })
    void ghostCursor.refresh()
    sendRelaySettings()
  }

  const httpSettings = {
    get: (): Effect.Effect<object, Error> =>
      extensionSettings("settings.get").pipe(Effect.map((stored) => describeSettings(withRelaySettings(stored), userSettingOverrides()))),
    set: (input: unknown): Effect.Effect<object, Error> => Effect.gen(function* () {
      const requested = yield* Effect.try({
        try: () => parseSettingChanges(input),
        catch: (error) => error instanceof SettingsInputError
          ? new HttpRouteError({ message: error.message, status: 400, code: "invalid-request" })
          : new Error(String(error)),
      })
      const overrides = userSettingOverrides()
      const writable = Object.fromEntries(Object.entries(requested).filter(([key]) => !(key in overrides)))
      const extensionChanges = settingsToExtension(writable)
      const relayOnly = Object.keys(extensionChanges).length === 0
      const fromExtension = relayOnly && !browsers.connected ? undefined : yield* extensionSettings("settings.get")
      const before = withRelaySettings(fromExtension ?? settingsFromExtension({ settings: {} }))
      if (typeof writable.autoUpdate === "string") setStoredMode(writable.autoUpdate as AutoUpdateMode)
      const after = withRelaySettings(Object.keys(extensionChanges).length ? yield* extensionSettings("settings.set", extensionChanges) : (fromExtension ?? before))
      if (writable.autoUpdate !== undefined) sendRelaySettings()
      relayLog("settings.set", { changes: Object.keys(writable).join(",") || undefined, overridden: Object.keys(requested).filter((key) => key in overrides).join(",") || undefined })
      return describeChanges({ before, after, requested, overrides })
    }),
  }

  return {
    applyExtensionSettings,
    sendRelaySettings,
    httpSettings,
  }
}
