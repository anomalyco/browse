import { beforeEach, describe, expect, test } from "bun:test"
import { installChrome } from "./chrome-stub"

const stub = installChrome()

const { UserSettings } = await import("../src/background/user-settings")
const { AgentWindow } = await import("../src/background/agent-relay/window")
const { AgentGroups } = await import("../src/background/agent-relay/groups")
const { TabCleanup } = await import("../src/background/tab-cleanup")
const { browserName } = await import("../src/background/agent-relay/wire")
const { effectiveRelayAddress, readManaged, readSetting } = await import("../src/shared/policy")
const {
  AGENT_GROUPING_KEY,
  AGENT_WINDOW_KEY,
  BROWSER_NAME_KEY,
  HANDOFF_NOTIFICATIONS_KEY,
  HUMAN_INPUT_KEY,
  IDLE_MINUTES_KEY,
  MUTE_TABS_KEY,
  RELAY_ADDRESS_KEY,
} = await import("../src/shared/protocol")

const local = stub.chrome.storage.local as unknown as { data: Map<string, unknown>; set: (items: Record<string, unknown>) => Promise<void> }
const managed = stub.chrome.storage.managed as unknown as {
  data: Map<string, unknown>
  set: (items: Record<string, unknown>) => Promise<void>
  remove: (keys: string | string[]) => Promise<void>
}

beforeEach(() => {
  local.data.clear()
  managed.data.clear()
})

describe("browser managed policy settings", () => {
  test("managed policy overrides local storage and reverts cleanly when removed", async () => {
    await local.set({
      [AGENT_WINDOW_KEY]: "current",
      [AGENT_GROUPING_KEY]: "shared",
      [IDLE_MINUTES_KEY]: 10,
      [HUMAN_INPUT_KEY]: "on",
      [MUTE_TABS_KEY]: "off",
      [HANDOFF_NOTIFICATIONS_KEY]: "recording",
      [BROWSER_NAME_KEY]: "Local Chrome",
      [RELAY_ADDRESS_KEY]: "127.0.0.1:19988",
    })

    await managed.set({
      window: "separate",
      grouping: "session",
      groupCollapse: "off",
      idleMinutes: 30,
      humanInput: "off",
      muteTabs: "on",
      handoffNotifications: "always",
      browserName: "Helium on NixOS",
      relayAddress: "localhost:20000",
      autoPairLocalRelay: true,
    })

    expect(await AgentWindow.placement()).toBe("separate")
    expect(await AgentGroups.mode()).toBe("session")
    expect(await TabCleanup.idleMinutes()).toBe(30)
    expect(await readSetting("groupCollapse")).toBe("off")
    expect(await readSetting("humanInput")).toBe("off")
    expect(await readSetting("muteTabs")).toBe("on")
    expect(await readSetting("handoffNotifications")).toBe("always")
    expect(await browserName()).toBe("Helium on NixOS")
    expect(await effectiveRelayAddress()).toBe("localhost:20000")
    expect(await readManaged("autoPairLocalRelay")).toBe(true)

    const result = await UserSettings.read()
    expect(result).toEqual({
      settings: {
        window: "separate",
        grouping: "session",
        groupCollapse: "off",
        idleMinutes: 30,
        humanInput: "off",
        muteTabs: "on",
        handoffNotifications: "always",
      },
      managed: ["window", "grouping", "groupCollapse", "idleMinutes", "humanInput", "muteTabs", "handoffNotifications"],
    })

    // Removing keys from managed policy reverts to local storage without leftover writes.
    await managed.remove(["window", "grouping", "idleMinutes", "browserName", "relayAddress"])
    expect(await AgentWindow.placement()).toBe("current")
    expect(await AgentGroups.mode()).toBe("shared")
    expect(await TabCleanup.idleMinutes()).toBe(10)
    expect(await browserName()).toBe("Local Chrome")
    expect(await effectiveRelayAddress()).toBe("127.0.0.1:19988")
  })

  test("UserSettings.write skips policy-managed keys without touching local storage", async () => {
    await local.set({ [AGENT_GROUPING_KEY]: "shared" })
    await managed.set({ grouping: "session" })

    const updated = await UserSettings.write({ grouping: "none", muteTabs: "on" })
    expect(updated).toEqual({
      settings: {
        window: "current",
        grouping: "session",
        groupCollapse: "auto",
        idleMinutes: 10,
        humanInput: "on",
        muteTabs: "on",
        handoffNotifications: "recording",
      },
      managed: ["grouping"],
    })
    // Local storage for the managed key was never overwritten; the unmanaged key was written.
    expect(local.data.get(AGENT_GROUPING_KEY)).toBe("shared")
    expect(local.data.get(MUTE_TABS_KEY)).toBe("on")
  })

  test("invalid policy values are ignored and fall back to local/default", async () => {
    await local.set({ [AGENT_GROUPING_KEY]: "none" })
    await managed.set({
      window: "bogus",
      grouping: 42,
      idleMinutes: 99,
      relayAddress: "not a valid address ://",
      autoPairLocalRelay: "yes",
    })

    expect(await AgentWindow.placement()).toBe("current")
    expect(await AgentGroups.mode()).toBe("none")
    expect(await TabCleanup.idleMinutes()).toBe(10)
    expect(await effectiveRelayAddress()).toBeUndefined()
    expect(await readManaged("autoPairLocalRelay")).toBeUndefined()
  })
})
