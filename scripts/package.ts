// Builds the extension and zips it as release/browse-extension-<version>.zip, on either channel:
//   stable  the store build, for the Chrome Web Store. The store assigns its own ID and rejects the `key` field, which
//           only pins the ID of unpacked builds.
//   dev     the unpacked extension the release workflow publishes to the release service; dev installs download it and
//           load it unpacked (cli/src/dev-extension.ts). It keeps `key`, so it has the unpacked ID the relay trusts, and
//           build.json, so a relay can tell whether the loaded extension is current.
// The versions tell the two builds apart (a dev version has -dev.), and the contents differ.
// The version comes from cli/package.json, the one release version for the zip and the npm package (scripts/version.ts
// maps a dev build to the four-part manifest version Chrome accepts).
import { $ } from "bun"
import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { applyManifestVersion } from "./version.ts"

const root = path.resolve(import.meta.dir, "..")
const staging = path.join(root, "release", "staging")
const version: string = (await Bun.file(path.join(root, "cli", "package.json")).json()).version
const dev = version.includes("-dev.")
const build = new Date().toISOString()
await $`bun run build`.cwd(root).env({ ...process.env, OPENCODE_BROWSER_BUILD: build })
await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
await cp(path.join(root, "dist"), staging, { recursive: true })
const manifest = await Bun.file(path.join(staging, "manifest.json")).json()
if (!dev) delete manifest.key
applyManifestVersion(manifest, version)
await Bun.write(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
await rm(path.join(staging, "build.json"), { force: true })
if (dev) await Bun.write(path.join(staging, "build.json"), JSON.stringify({ build }) + "\n")
const zip = path.join(root, "release", `browse-extension-${version}.zip`)
await rm(zip, { force: true })
// install writes this checkout's pairing code into public/ (and so dist/); it is private to this machine.
await rm(path.join(staging, "relay-pairing.json"), { force: true })
await $`zip -qrX ${zip} . -x "*.map" -x ".DS_Store" -x "relay-pairing.json"`.cwd(staging)
await rm(staging, { recursive: true, force: true })
console.log(zip)
