import { describe, expect, test } from "bun:test"
import { cliUpdateNotice, type RelayAutoUpdate } from "../src/shared/protocol"
import { relayAutoUpdate } from "../src/background/agent-relay/wire"
import { cliUpdateText } from "../src/status/describe"

// When the extension tells the user its browse CLI is out of date, and when a normal pending auto-update stays quiet.

const NOW = Date.parse("2026-11-14T12:00:00.000Z")
const iso = (at: number) => new Date(at).toISOString()
const minutes = (count: number) => count * 60_000
const base: RelayAutoUpdate = {
  install: "binary",
  cli: "browse",
  mode: "on",
  effective: "on",
  version: "0.0.16",
  latest: "0.0.17",
  latestAt: iso(NOW - minutes(5)),
}

describe("cliUpdateNotice", () => {
  test("says nothing when the running version is the latest", () => {
    expect(cliUpdateNotice({ ...base, latest: "0.0.16" }, NOW)).toBeUndefined()
    expect(cliUpdateNotice({ ...base, latest: undefined }, NOW)).toBeUndefined()
    expect(cliUpdateNotice({ ...base, version: undefined }, NOW)).toBeUndefined()
    expect(cliUpdateNotice(undefined, NOW)).toBeUndefined()
  })

  test("waits quietly while a self-updating install is pending", () => {
    expect(cliUpdateNotice(base, NOW)).toBeUndefined()
    expect(cliUpdateNotice({ ...base, install: "npm" }, NOW)).toBeUndefined()
  })

  test("mentions a self-update that stayed pending for over a day", () => {
    const notice = cliUpdateNotice({ ...base, latestAt: iso(NOW - minutes(25 * 60)) }, NOW)
    expect(notice).toMatchObject({ current: "0.0.16", latest: "0.0.17", reason: "pending", command: "browse update" })
    // Exactly a day is still the normal window.
    expect(cliUpdateNotice({ ...base, latestAt: iso(NOW - 24 * 60 * 60_000) }, NOW)).toBeUndefined()
    // Without a timestamp (an older relay), there is no pending clock to judge.
    expect(cliUpdateNotice({ ...base, latestAt: undefined }, NOW)).toBeUndefined()
  })

  test("mentions updates that are notify-only or off", () => {
    expect(cliUpdateNotice({ ...base, install: "npm", mode: "notify", effective: "notify" }, NOW)).toMatchObject({
      reason: "mode",
      command: "npm install -g @opencode/browse@latest",
    })
    expect(cliUpdateNotice({ ...base, install: "npm", mode: "off", effective: "off" }, NOW)).toMatchObject({ reason: "mode" })
    // An environment override can turn off what the stored mode says.
    expect(cliUpdateNotice({ ...base, install: "npm", mode: "on", effective: "off" }, NOW)).toMatchObject({ reason: "mode" })
  })

  test("mentions installs that can't update themselves", () => {
    expect(cliUpdateNotice({ ...base, install: "npx", effective: "off" }, NOW)).toMatchObject({
      reason: "install",
      command: "npx @opencode/browse@latest install",
    })
    expect(cliUpdateNotice({ ...base, install: "other", effective: "off" }, NOW)).toMatchObject({ reason: "install", command: "browse update" })
    expect(cliUpdateNotice({ ...base, install: "other", cli: "node /src/cli.mjs", effective: "off" }, NOW)).toMatchObject({
      command: "node /src/cli.mjs update",
    })
  })

  test("mentions a failed attempt for the release it tried", () => {
    expect(cliUpdateNotice({ ...base, lastError: { message: "npm failed", at: iso(NOW - minutes(30)), version: "0.0.17" } }, NOW)).toMatchObject({
      reason: "failed",
    })
    expect(cliUpdateNotice({ ...base, lastError: { message: "npm failed", at: iso(NOW - minutes(30)) } }, NOW)).toMatchObject({ reason: "failed" })
    // A failure for another release doesn't change what a normal pending update is doing.
    expect(cliUpdateNotice({ ...base, lastError: { message: "npm failed", at: iso(NOW - minutes(30)), version: "0.0.15" } }, NOW)).toBeUndefined()
  })

  test("doesn't call a rollback or a different prerelease an update", () => {
    expect(cliUpdateNotice({ ...base, latest: "0.0.15" }, NOW)).toBeUndefined()
    expect(cliUpdateNotice({ ...base, install: "npm", version: "0.0.17-dev.3", latest: "0.0.17-dev.2" }, NOW)).toBeUndefined()
    expect(cliUpdateNotice({ ...base, install: "npm", version: "0.0.17", latest: "0.0.17-beta.2" }, NOW)).toBeUndefined()
  })

  test("orders dev runs and treats an unknown shape as a different build", () => {
    expect(cliUpdateNotice({ ...base, install: "npm", mode: "notify", effective: "notify", version: "0.0.17-dev.2", latest: "0.0.17-dev.3" }, NOW)).toMatchObject({
      reason: "mode",
    })
    expect(cliUpdateNotice({ ...base, mode: "notify", effective: "notify", latest: "build-20261114" }, NOW)).toMatchObject({ reason: "mode" })
  })

  test("uses the relay's command for a binary install and names the version plainly", () => {
    const notice = cliUpdateNotice({ ...base, cli: "/opt/browse/bin/browse", mode: "notify", effective: "notify" }, NOW)!
    expect(notice.command).toBe("/opt/browse/bin/browse update")
    expect(cliUpdateText(notice)).toBe("browse 0.0.16 is out of date (0.0.17 is out). Run `/opt/browse/bin/browse update`.")
  })
})

describe("relayAutoUpdate", () => {
  test("keeps the install kind, timestamps and the last failure the relay sent", () => {
    expect(
      relayAutoUpdate({
        install: "npx",
        cli: "npx @opencode/browse",
        mode: "on",
        effective: "off",
        version: "0.0.16",
        latest: "0.0.17",
        latestAt: iso(NOW - minutes(5)),
        checkedAt: iso(NOW),
        lastError: { message: "npm failed", at: iso(NOW), version: "0.0.17", attempts: 2 },
      }),
    ).toEqual({
      install: "npx",
      cli: "npx @opencode/browse",
      mode: "on",
      effective: "off",
      version: "0.0.16",
      latest: "0.0.17",
      latestAt: iso(NOW - minutes(5)),
      checkedAt: iso(NOW),
      lastError: { message: "npm failed", at: iso(NOW), version: "0.0.17", attempts: 2 },
    })
  })

  test("drops malformed failures and unknown installs from an older or newer relay", () => {
    expect(relayAutoUpdate({ install: "binary", mode: "on", effective: "on", lastError: { message: 1 } })).toMatchObject({ install: "binary" })
    expect(relayAutoUpdate({ install: "binary", mode: "on", effective: "on", lastError: { message: 1 } })?.lastError).toBeUndefined()
    expect(relayAutoUpdate({ install: "unknown", mode: "on", effective: "on" })?.install).toBe("other")
    expect(relayAutoUpdate({ install: "npm", mode: "on", effective: "on", lastError: { message: "x", at: iso(NOW), attempts: 0 } })?.lastError).toEqual({
      message: "x",
      at: iso(NOW),
    })
  })
})
