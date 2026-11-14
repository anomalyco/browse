import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { freePort } from "./support/ports.ts"

// Set both to artifacts of the same build. Don't substitute a bundle fixture: the two publishers stamped them differently.
const binary = process.env.BROWSE_TEST_BINARY, npm = process.env.BROWSE_TEST_NPM_CLI
test.skipIf(!binary || !npm)("the npm CLI can use a relay from the matching binary", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-build-")), port = await freePort()
  const env = { ...process.env, HOME: home, USERPROFILE: home, OPENCODE_BROWSER_HOME: home, OPENCODE_BROWSER_PORT: String(port), OPENCODE_BROWSER_UPDATE_CHECK: "0", OPENCODE_BROWSER_AUTOSTART: "false" }
  const relay = Bun.spawn([binary!, "serve"], { env, stdout: "ignore", stderr: "inherit" })
  try {
    const url = `http://127.0.0.1:${port}/version`
    for (let n = 0; n < 100 && !await fetch(url).then(r => r.ok, () => false); n++) await Bun.sleep(50)
    const cli = Bun.spawn(["node", npm!, "session", "list", "--json"], { env, stdout: "pipe", stderr: "pipe" })
    const [code, output, error] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()])
    expect(code, error || output).toBe(0)
    expect(JSON.parse(output).sessions).toEqual([])
  } finally {
    relay.kill(); await relay.exited
    rmSync(home, { recursive: true, force: true })
  }
}, 15_000)
