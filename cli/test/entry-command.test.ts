import { describe, expect, test } from "bun:test"
import path from "node:path"
import { entryCommand, entrySpawnCommand, type EntrySpawnOptions } from "../src/paths.ts"

const node = "/usr/bin/node"
const winPath = path.win32

const files = (...paths: string[]) => {
  const known = new Set(paths.map((file) => winPath.normalize(file)))
  return (file: string) => known.has(winPath.normalize(file))
}

const win = (entry: string, options: EntrySpawnOptions = {}) =>
  entrySpawnCommand(entry, node, {
    platform: "win32",
    checkout: false,
    pathModule: winPath,
    env: { PATH: "" },
    existsSync: () => false,
    ...options,
  })

describe("entry commands", () => {
  test("runs a script entry under the same node", () => {
    expect(entryCommand("/opt/browse/dist/cli.mjs", node)).toEqual([node, "/opt/browse/dist/cli.mjs"])
  })

  test("runs a binary entry itself", () => {
    expect(entryCommand("/home/me/.local/bin/browse", node)).toEqual(["/home/me/.local/bin/browse"])
  })

  test("leaves a bare command name to the shell elsewhere", () => {
    expect(entrySpawnCommand("browse", node, { platform: "linux", running: "/opt/browse/dist/cli.mjs" })).toEqual(["browse"])
  })

  test("leaves a windows shim alone on linux", () => {
    expect(entrySpawnCommand("browse.cmd", node, { platform: "linux" })).toEqual(["browse.cmd"])
  })

  test("resolves npm's global shim to the installed cli, not the running npx copy", () => {
    // npm puts browse.cmd and node_modules side by side in its global prefix; PATH may quote entries and leave gaps.
    const prefix = "C:\\Users\\me\\AppData\\Roaming\\npm"
    const installed = `${prefix}\\node_modules\\@opencode\\browse\\dist\\cli.mjs`
    const running = "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\@opencode\\browse\\dist\\cli.mjs"
    expect(
      win("browse", {
        running,
        env: { PATH: `C:\\empty;;"${prefix}";` },
        existsSync: files(`${prefix}\\browse.cmd`, installed),
      }),
    ).toEqual([node, installed])
  })

  test("resolves a bare browse.exe on PATH to the executable", () => {
    const executable = "C:\\tools\\browse.exe"
    expect(win("browse", { env: { PATH: "C:\\tools" }, existsSync: files(executable) })).toEqual([executable])
  })

  test("resolves a .cmd entry through its own folder", () => {
    const prefix = "C:\\Users\\me\\AppData\\Roaming\\npm"
    const shim = `${prefix}\\browse.cmd`
    const script = `${prefix}\\node_modules\\@opencode\\browse\\dist\\cli.mjs`
    expect(win(shim, { existsSync: files(shim, script) })).toEqual([node, script])
  })

  test("leaves a bare entry when nothing resolves and the running script is under _npx", () => {
    const running = "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\@opencode\\browse\\dist\\cli.mjs"
    expect(win("browse", { running })).toEqual(["browse"])
  })

  test("does not fall back to a compiled binary's own executable", () => {
    expect(win("browse", { compiled: true, running: "C:\\Users\\me\\Downloads\\browse.exe" })).toEqual(["browse"])
  })

  test("falls back to a running script outside npx and checkouts", () => {
    const running = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@opencode\\browse\\dist\\cli.mjs"
    expect(win("browse", { running })).toEqual([node, running])
  })

  test("does not fall back to a checkout's running script", () => {
    expect(win("browse", { running: "/checkout/cli/dist/cli.mjs", checkout: true })).toEqual(["browse"])
  })
})
