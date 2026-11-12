import { afterAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { installedDevExtension, syncDevExtension, unzip } from "../src/setup/dev-extension.ts"
import { devExtensionFolder, devExtensionUrl, type DevExtension } from "../src/paths.ts"

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "browse-dev-extension-"))
afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }))

/** A dev extension zip like scripts/package.ts writes, and the reference a dev CLI carries for it. */
async function makeZip(name: string, build: string, manifest: Record<string, unknown> = { manifest_version: 3, version: "0.0.3.7", version_name: "0.0.3-dev.7", key: "KEY" }) {
  const source = path.join(temporary, `${name}-src`)
  fs.mkdirSync(path.join(source, "assets"), { recursive: true })
  fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest))
  fs.writeFileSync(path.join(source, "build.json"), JSON.stringify({ build }))
  fs.writeFileSync(path.join(source, "assets", "background.js"), `console.log(${JSON.stringify(build)})\n`.repeat(50))
  const zip = path.join(temporary, `${name}.zip`)
  await $`zip -qrX ${zip} .`.cwd(source).quiet()
  const bytes = fs.readFileSync(zip)
  const extension: DevExtension = { file: `${name}.zip`, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }
  return { bytes, extension }
}

/** A fetch that serves the given bytes and counts requests. */
function serve(bytes: Buffer) {
  const requests: string[] = []
  const fetch = (async (url: string) => {
    requests.push(String(url))
    return new Response(new Uint8Array(bytes))
  }) as unknown as typeof globalThis.fetch
  return { fetch, requests }
}

describe("dev extension", () => {
  test("unzips stored and deflated entries", async () => {
    const { bytes } = await makeZip("plain", "b1")
    const names = unzip(bytes).filter((entry) => !entry.directory).map((entry) => entry.name).sort()
    expect(names).toEqual(["assets/background.js", "build.json", "manifest.json"])
  })

  test("refuses entries that would escape the folder", () => {
    // A minimal zip with one stored entry named ../evil.
    const name = Buffer.from("../evil")
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(name.length, 28)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(1, 10)
    end.writeUInt32LE(local.length + name.length, 16)
    expect(() => unzip(Buffer.concat([local, name, central, name, end]))).toThrow(/unsafe path/)
  })

  test("downloads the build into the folder, pairs it, and keeps it until another build", async () => {
    const root = path.join(temporary, "root")
    const first = await makeZip("first", "b1")
    const server = serve(first.bytes)
    expect(await syncDevExtension(first.extension, { root, fetch: server.fetch, env: {}, port: 19988 })).toBe("updated")
    expect(server.requests).toEqual([devExtensionUrl(first.extension, {})])
    expect(server.requests[0]).toBe(`https://anoma.ly/release/browse/files/${first.extension.sha256}/first.zip`)
    const folder = devExtensionFolder(root)
    expect(fs.readFileSync(path.join(folder, "assets", "background.js"), "utf8")).toContain("b1")
    expect(JSON.parse(fs.readFileSync(path.join(folder, "relay-pairing.json"), "utf8"))).toMatchObject({ port: 19988, code: expect.stringMatching(/^[0-9A-Z]{8}$/) })
    expect(installedDevExtension(root)).toMatchObject({ sha256: first.extension.sha256, build: "b1", version: "0.0.3-dev.7" })

    expect(await syncDevExtension(first.extension, { root, fetch: server.fetch, env: {} })).toBe("current")
    expect(server.requests).toHaveLength(1)

    const second = await makeZip("second", "b2")
    expect(await syncDevExtension(second.extension, { root, fetch: serve(second.bytes).fetch, env: {} })).toBe("updated")
    expect(fs.readFileSync(path.join(folder, "assets", "background.js"), "utf8")).toContain("b2")
    expect(installedDevExtension(root)?.build).toBe("b2")
    expect(fs.readdirSync(root).filter((name) => name.startsWith(".extension-"))).toEqual([])
  })

  test("refuses bytes that aren't the build it was built with, leaving the folder as it was", async () => {
    const root = path.join(temporary, "tampered")
    const good = await makeZip("good", "g1")
    await syncDevExtension(good.extension, { root, fetch: serve(good.bytes).fetch, env: {} })
    const other = await makeZip("other", "evil")
    const expected: DevExtension = { ...good.extension, file: "next.zip", sha256: "0".repeat(64) }
    await expect(syncDevExtension(expected, { root, fetch: serve(other.bytes).fetch, env: {} })).rejects.toThrow(/isn't the one this version was built with/)
    expect(installedDevExtension(root)?.build).toBe("g1")
  })

  test("refuses a zip without the manifest key (it wouldn't have the unpacked ID)", async () => {
    const root = path.join(temporary, "keyless")
    const keyless = await makeZip("keyless", "k1", { manifest_version: 3, version: "0.0.3.7" })
    await expect(syncDevExtension(keyless.extension, { root, fetch: serve(keyless.bytes).fetch, env: {} })).rejects.toThrow(/no manifest key/)
    expect(fs.existsSync(devExtensionFolder(root))).toBe(false)
  })
})
