// Builds the published package: dist/cli.mjs (main.ts and everything it loads, with npm dependencies left
// external and installed by npm) and extension/ (the built unpacked extension, keeping its manifest key so the
// unpacked ID matches the host's allowed origins). Both carry this package's version.
import { $ } from "bun"
import { cp, rm } from "node:fs/promises"
import path from "node:path"
import { applyManifestVersion } from "../scripts/version.ts"
import { bundleCli } from "./bundle.ts"

const here = import.meta.dir
const extension = path.resolve(here, "..")
const pkg = await Bun.file(path.join(here, "package.json")).json()

// The Chrome Web Store items, from the release workflow's repository variables (RELEASING.md); unset in a checkout.
const storeId = (name: string) => {
  const value = process.env[name]?.trim()
  if (!value) return undefined
  if (!/^[a-p]{32}$/.test(value)) throw new Error(`${name} is not a Chrome Web Store item ID: ${JSON.stringify(value)}`)
  return value
}
const store = {
  ...(storeId("OPENCODE_BROWSER_STORE_ID") ? { id: storeId("OPENCODE_BROWSER_STORE_ID") } : {}),
  ...(storeId("OPENCODE_BROWSER_BETA_STORE_ID") ? { betaId: storeId("OPENCODE_BROWSER_BETA_STORE_ID") } : {}),
  listed: process.env.OPENCODE_BROWSER_STORE_LISTED?.trim() === "true",
}

const build = new Date().toISOString()
await $`bun run build`.cwd(extension).env({ ...process.env, OPENCODE_BROWSER_BUILD: build }).quiet()
await rm(path.join(here, "dist"), { recursive: true, force: true })
await rm(path.join(here, "extension"), { recursive: true, force: true })

await bundleCli({ outdir: path.join(here, "dist"), version: pkg.version, store })

await cp(path.join(extension, "dist"), path.join(here, "extension"), {
  recursive: true,
  // A checkout's pairing code (written by install into public/ and dist/) must never ship in the package.
  filter: (file) => !file.endsWith(".map") && path.basename(file) !== "relay-pairing.json",
})
const manifestFile = path.join(here, "extension", "manifest.json")
const manifest = await Bun.file(manifestFile).json()
applyManifestVersion(manifest, pkg.version)
await Bun.write(manifestFile, JSON.stringify(manifest, null, 2) + "\n")
// install compares this with the build a connected extension reports, to skip a reload that changes nothing.
await Bun.write(path.join(here, "extension", "build.json"), JSON.stringify({ build }) + "\n")
// MIT asks for the license with every copy; npm ships LICENSE from the package folder.
await cp(path.join(extension, "LICENSE"), path.join(here, "LICENSE"))
console.log(`built dist/cli.mjs and extension/ (${pkg.version}${store.id || store.betaId ? `, store ${[store.id, store.betaId].filter(Boolean).join(" / ")}${store.listed ? " listed" : ""}` : ""})`)
