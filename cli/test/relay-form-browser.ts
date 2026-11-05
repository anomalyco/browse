// Run after building the extension and CLI, with PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH set to Chrome for Testing.
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import { unpackedExtensionId } from "../src/protocol.ts"
import { startBrowserScene } from "./support/browser-scene.ts"

const scene = await startBrowserScene({ name: "relay-form-" })
const endpoint = http.createServer()
try {
  const dialed = new Promise<string | undefined>(resolve => endpoint.once("upgrade", (req, socket) => {
    socket.destroy()
    resolve(req.url)
  }))
  await new Promise<void>(resolve => endpoint.listen(scene.fixturePort, "127.0.0.1", resolve))
  const page = await scene.browser.newPage()
  await page.goto(`chrome-extension://${unpackedExtensionId}/settings.html`)
  const address = `127.0.0.1:${scene.fixturePort}`
  const field = page.locator(".relay-form input").first()
  await field.fill(address)
  await page.locator(".relay-form input").nth(1).fill("ABCD-EFGH")
  await page.locator('.relay-form button[type="submit"]').click()
  assert.equal(await Promise.race([dialed, new Promise(resolve => setTimeout(resolve, 5000).unref())]), "/extension",
    "the worker must dial the address submitted on the settings page")
} finally {
  endpoint.close()
  await scene.stop()
  fs.rmSync(scene.root, { recursive: true, force: true })
}
