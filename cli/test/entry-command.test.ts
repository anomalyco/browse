import { describe, expect, test } from "bun:test"
import { entryCommand, entrySpawnCommand } from "../src/paths.ts"

const node = "/usr/bin/node"
const win = (entry: string, running: string, compiled = false) =>
  entrySpawnCommand(entry, node, { platform: "win32", running, compiled })

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

  test("uses the running script for npm's browse shim on Windows", () => {
    // npm installs browse as browse.cmd (plus an extensionless sh shim); child_process can't run either without a shell.
    const script = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@opencode\\browse\\dist\\cli.mjs"
    expect(win("browse", script)).toEqual([node, script])
    expect(win("browse.cmd", script)).toEqual([node, script])
    expect(win(".\\browse.cmd", script)).toEqual([node, script])
    expect(win("C:\\npm\\browse.cmd", script)).toEqual([node, script])
  })

  test("uses the compiled executable for a bare shim on Windows", () => {
    expect(win("browse", "C:\\Users\\me\\.local\\bin\\browse.exe", true)).toEqual([
      "C:\\Users\\me\\.local\\bin\\browse.exe",
    ])
  })

  test("runs an absolute Windows script or executable directly", () => {
    expect(win("C:\\browse\\cli.mjs", "C:\\other\\cli.mjs")).toEqual([node, "C:\\browse\\cli.mjs"])
    expect(win("C:\\browse\\browse.exe", "C:\\other\\browse.exe")).toEqual(["C:\\browse\\browse.exe"])
  })

  test("leaves agent configs on the entry they record", () => {
    // Config files keep using the stored command; only a spawn has to work around Windows' shims.
    expect(entryCommand("browse", "node")).toEqual(["browse"])
  })
})
