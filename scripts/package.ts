// Builds the extension and zips it for the Chrome Web Store: release/opencode-browser-<version>.zip.
// The store assigns its own ID and rejects the `key` field, which only pins the ID of unpacked builds.
// The version comes from cli/package.json, the one release version for the zip and the npm package (scripts/version.ts
// maps a beta to the four-part manifest version Chrome accepts).
import { $ } from "bun"
import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { applyManifestVersion } from "./version.ts"

const root = path.resolve(import.meta.dir, "..")
const staging = path.join(root, "release", "staging")
await $`bun run build`.cwd(root)
await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
await cp(path.join(root, "dist"), staging, { recursive: true })
const manifest = await Bun.file(path.join(staging, "manifest.json")).json()
delete manifest.key
const version: string = (await Bun.file(path.join(root, "cli", "package.json")).json()).version
applyManifestVersion(manifest, version)
await Bun.write(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
const zip = path.join(root, "release", `opencode-browser-${version}.zip`)
await rm(zip, { force: true })
// install writes this checkout's pairing code into public/ (and so dist/); it is private to this machine.
await rm(path.join(staging, "relay-pairing.json"), { force: true })
await $`zip -qrX ${zip} . -x "*.map" -x ".DS_Store" -x "relay-pairing.json"`.cwd(staging)
await rm(staging, { recursive: true, force: true })
console.log(zip)
