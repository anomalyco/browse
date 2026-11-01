// Builds the published package, dist/cli.mjs (main.ts and everything it loads, with npm dependencies left external and
// installed by npm), and the checkout's unpacked extension in ../dist (which `bun run setup` loads). The package ships no
// extension: an npm install gets it from its channel's Chrome Web Store item.
import { $ } from "bun"
import { cp, rm } from "node:fs/promises"
import path from "node:path"
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
  ...(storeId("OPENCODE_BROWSER_DEV_STORE_ID") ? { devId: storeId("OPENCODE_BROWSER_DEV_STORE_ID") } : {}),
}

const build = new Date().toISOString()
await $`bun run build`.cwd(extension).env({ ...process.env, OPENCODE_BROWSER_BUILD: build }).quiet()
await rm(path.join(here, "dist"), { recursive: true, force: true })
// Earlier builds copied the extension into the package.
await rm(path.join(here, "extension"), { recursive: true, force: true })

await bundleCli({ outdir: path.join(here, "dist"), version: pkg.version, store })

// install compares this with the build a connected unpacked extension reports, to skip a reload that changes nothing.
await Bun.write(path.join(extension, "dist", "build.json"), JSON.stringify({ build }) + "\n")
// MIT asks for the license with every copy; npm ships LICENSE from the package folder.
await cp(path.join(extension, "LICENSE"), path.join(here, "LICENSE"))
const items = [store.id, store.devId && `dev ${store.devId}`].filter(Boolean)
console.log(`built dist/cli.mjs and ../dist (${pkg.version}${items.length ? `, store ${items.join(" / ")}` : ""})`)
