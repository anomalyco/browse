// A dev install's extension. Dev builds (every push to dev) don't go to the Chrome Web Store: the release workflow
// publishes the unpacked extension zip to Anomaly's release service, and the CLI of that build carries the zip's sha256
// (paths.ts devExtension). install downloads it into <cache root>/extension, which the user loads unpacked once; its
// manifest key pins the same ID as a checkout's build, which the relay trusts. When the relay of a newer dev version starts
// (auto-update), it puts that version's extension in the folder and reloads the connected unpacked extension (relay.ts).
//
//   <cache root>/extension/        the unpacked extension, with this machine's pairing code (relay-pairing.json)
//   <cache root>/extension.json    { version, file, sha256, build, installedAt }: what the folder holds
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { crc32, inflateRawSync } from "node:zlib"
import { cacheRoot, devExtensionFolder, devExtensionUrl, type DevExtension } from "../paths.ts"
import { bundledPairingCodeTtlMs, mintPairingCode, writeExtensionPairing } from "../relay/browser-pairing.ts"

export type Installed = { readonly version?: string; readonly file: string; readonly sha256: string; readonly build?: string; readonly installedAt: string }

export const devExtensionRecord = (root = cacheRoot()) => path.join(root, "extension.json")

/** What the folder holds, when a dev install put it there. */
export function installedDevExtension(root = cacheRoot()): Installed | undefined {
  try {
    const record = JSON.parse(readFileSync(devExtensionRecord(root), "utf8")) as Installed
    return typeof record.sha256 === "string" && existsSync(path.join(devExtensionFolder(root), "manifest.json")) ? record : undefined
  } catch {
    return undefined
  }
}

/**
 * Makes <cache root>/extension hold `extension`: downloads it from the release service when the folder has another build
 * (or nothing), checks its size and sha256, unpacks it beside the folder with a fresh one-time pairing code (an
 * extension with its key ignores it) and swaps it in. Returns "current" when the folder already had it, "updated" when
 * its files changed.
 */
export async function syncDevExtension(extension: DevExtension, options: { readonly root?: string; readonly fetch?: typeof fetch; readonly env?: NodeJS.ProcessEnv } = {}): Promise<"current" | "updated"> {
  const root = options.root ?? cacheRoot()
  const folder = devExtensionFolder(root)
  // Already current: `install` puts a fresh code in the folder when one is needed (pairUnpacked), so a relay starting
  // up doesn't use up pending codes.
  if (installedDevExtension(root)?.sha256 === extension.sha256) return "current"
  const url = devExtensionUrl(extension, options.env)
  const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(120_000), headers: { "user-agent": "browse/dev" } })
  if (!response.ok) throw new Error(`downloading the dev extension from ${url} failed: HTTP ${response.status}`)
  const zip = Buffer.from(await response.arrayBuffer())
  const sha256 = createHash("sha256").update(zip).digest("hex")
  if (zip.length !== extension.size || sha256 !== extension.sha256)
    throw new Error(`the dev extension from ${url} isn't the one this version was built with (sha256 ${sha256}, ${zip.length} bytes)`)
  mkdirSync(root, { recursive: true })
  const staging = path.join(root, `.extension-${process.pid}-${Date.now()}`)
  const old = `${staging}-old`
  rmSync(staging, { recursive: true, force: true })
  try {
    for (const entry of unzip(zip)) {
      const target = path.join(staging, ...entry.name.split("/"))
      mkdirSync(path.dirname(target), { recursive: true })
      if (!entry.directory) writeFileSync(target, entry.data)
    }
    const manifest = JSON.parse(readFileSync(path.join(staging, "manifest.json"), "utf8")) as { version_name?: string; version?: string; key?: string }
    if (!manifest.key) throw new Error("the dev extension has no manifest key, so it wouldn't have browse's unpacked ID")
    // No port here: this folder is written before install knows the relay's listen port. install replaces the code
    // with a fresh one (pairUnpacked) that names a live relay's port; an omitted port means 19988.
    writeExtensionPairing(staging, mintPairingCode(undefined, { ttlMs: bundledPairingCodeTtlMs }))
    const build = (() => {
      try {
        return (JSON.parse(readFileSync(path.join(staging, "build.json"), "utf8")) as { build?: string }).build
      } catch {
        return undefined
      }
    })()
    // The browser loaded the folder by its path, so it must keep it: move the old files aside, then the new ones in.
    if (existsSync(folder)) renameSync(folder, old)
    renameSync(staging, folder)
    const version = manifest.version_name ?? manifest.version
    const record: Installed = { ...(version ? { version } : {}), file: extension.file, sha256, ...(build ? { build } : {}), installedAt: new Date().toISOString() }
    writeFileSync(devExtensionRecord(root), JSON.stringify(record, null, 2) + "\n")
    return "updated"
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(old, { recursive: true, force: true })
  }
}

type Entry = { readonly name: string; readonly directory: boolean; readonly data: Buffer }

/**
 * Reads a zip archive (stored or deflated entries, no ZIP64), checking every entry's CRC-32 and refusing absolute or
 * parent paths and symbolic links. The extension zips are small, so it works in memory.
 */
export function unzip(zip: Buffer): Entry[] {
  let end = -1
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset--)
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      end = offset
      break
    }
  if (end < 0) throw new Error("not a zip archive")
  const count = zip.readUInt16LE(end + 10)
  let offset = zip.readUInt32LE(end + 16)
  const entries: Entry[] = []
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("corrupt zip central directory")
    const method = zip.readUInt16LE(offset + 10)
    const crc = zip.readUInt32LE(offset + 16)
    const compressed = zip.readUInt32LE(offset + 20)
    const size = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const mode = zip.readUInt32LE(offset + 38) >>> 16
    const local = zip.readUInt32LE(offset + 42)
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => part === ".." || part === "."))
      throw new Error(`unsafe path in zip: ${JSON.stringify(name)}`)
    if ((mode & 0o170000) === 0o120000) throw new Error(`symbolic link in zip: ${name}`)
    if (compressed === 0xffffffff || size === 0xffffffff) throw new Error("ZIP64 archives aren't supported")
    const directory = name.endsWith("/")
    if (directory) {
      entries.push({ name: name.slice(0, -1), directory, data: Buffer.alloc(0) })
      continue
    }
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip entry ${name}`)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + compressed)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : undefined
    if (!data) throw new Error(`unsupported compression method ${method} for ${name}`)
    if (data.length !== size || crc32(data) !== crc) throw new Error(`zip entry ${name} is corrupt`)
    entries.push({ name, directory, data })
  }
  return entries
}
