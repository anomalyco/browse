import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAutoUpdater, pruneVersions, readCurrent, readState, runtimeLayout, updateState, validatePending, versionEntry, writeCurrent, type Layout } from "../src/auto-update.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function layoutWith(versions: string[]): Layout {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-autoupdate-"))
  roots.push(root)
  const layout = runtimeLayout(root)
  for (const version of versions) {
    fs.mkdirSync(path.dirname(versionEntry(layout, version)), { recursive: true })
    fs.writeFileSync(versionEntry(layout, version), "")
  }
  return layout
}

const installed = (layout: Layout) => fs.readdirSync(layout.versions).sort()

describe("pruning", () => {
  test("never removes the current, previous or pending version", () => {
    const layout = layoutWith(["0.0.1", "0.0.2", "0.0.3", "0.0.4", "0.0.5"])
    writeCurrent(layout, { version: "0.0.3", previous: "0.0.2", channel: "latest" })
    updateState(layout, (state) => ({ ...state, pending: "0.0.5" }))
    pruneVersions(layout)
    expect(installed(layout)).toEqual(["0.0.2", "0.0.3", "0.0.5"])
  })

  test("keeps another process's install in progress, removes an abandoned one", () => {
    const layout = layoutWith(["0.0.1"])
    writeCurrent(layout, { version: "0.0.1", channel: "latest" })
    const live = `.install-${process.pid}-1`
    // A pid that isn't running: past the usual pid range.
    const dead = `.install-${2 ** 22 + 12345}-1`
    for (const name of [live, dead]) fs.mkdirSync(path.join(layout.versions, name))
    pruneVersions(layout)
    expect(installed(layout)).toEqual([live, "0.0.1"].sort())
  })
})

describe("a pending version whose directory is gone", () => {
  test("is cleared", () => {
    const layout = layoutWith(["0.0.1"])
    updateState(layout, (state) => ({ ...state, pending: "0.0.2" }))
    expect(validatePending(layout).pending).toBeUndefined()
    expect(readState(layout).pending).toBeUndefined()
  })

  test("is installed again instead of failing to switch on every tick", async () => {
    const layout = layoutWith(["0.0.1"])
    writeCurrent(layout, { version: "0.0.1", channel: "latest" })
    updateState(layout, (state) => ({ ...state, checkedAt: Date.now(), latest: "0.0.2", integrity: "sha512-x", pending: "0.0.2" }))
    const spawned: string[][] = []
    const events: string[] = []
    const updater = createAutoUpdater({
      runtime: { layout, version: "0.0.1", current: readCurrent(layout)! },
      isIdle: () => true,
      log: (event) => events.push(event),
      spawnChild: (args) => (spawned.push([...args]), 4242),
      env: {},
    })
    await updater.tick()
    expect(spawned).toEqual([["runtime-install", "0.0.2", "--integrity", "sha512-x"]])
    expect(readState(layout).installing).toMatchObject({ version: "0.0.2", pid: 4242 })
    expect(events).not.toContain("autoupdate.error")
  })
})

describe("the relay's updater", () => {
  const setup = (state: Parameters<typeof updateState>[1], idle = true) => {
    const layout = layoutWith(["0.0.1", "0.0.2"])
    writeCurrent(layout, { version: "0.0.1", channel: "latest" })
    updateState(layout, (rest) => state({ ...rest, checkedAt: Date.now(), latest: "0.0.2", integrity: "sha512-x" }))
    const spawned: string[][] = []
    const events: string[] = []
    const updater = createAutoUpdater({
      runtime: { layout, version: "0.0.1", current: readCurrent(layout)! },
      isIdle: () => idle,
      log: (event) => events.push(event),
      spawnChild: (args) => (spawned.push([...args]), process.pid),
      env: {},
    })
    return { layout, spawned, events, updater }
  }

  test("waits for an installer that is still running", async () => {
    const { spawned, updater } = setup((state) => ({ ...state, installing: { version: "0.0.2", pid: process.pid, startedAt: Date.now() } }))
    await updater.tick()
    expect(spawned).toEqual([])
  })

  test("records an installer that died without finishing", async () => {
    const { layout, events, updater } = setup((state) => ({ ...state, installing: { version: "0.0.2", pid: 2 ** 22 + 12345, startedAt: Date.now() } }))
    await updater.tick()
    expect(events).toContain("autoupdate.installer_gone")
    expect(readState(layout).installing).toBeUndefined()
    expect(readState(layout).lastError?.version).toBe("0.0.2")
  })

  test("switches through a runtime-switch child, never by moving current.json itself", async () => {
    const { layout, spawned, updater } = setup((state) => ({ ...state, pending: "0.0.2" }))
    await updater.tick()
    expect(spawned).toEqual([["runtime-switch", "0.0.2"]])
    expect(readCurrent(layout)?.version).toBe("0.0.1")
  })

  test("doesn't switch while an agent uses the browser", async () => {
    const { spawned, updater } = setup((state) => ({ ...state, pending: "0.0.2" }), false)
    await updater.tick()
    expect(spawned).toEqual([])
  })
})
