// Builds the published package, dist/cli.mjs (main.ts and everything it loads, with npm dependencies left external and
// installed by npm, and dev dependencies bundled with their licenses in dist/THIRD_PARTY_NOTICES.txt), and the checkout's unpacked extension in ../dist (which `bun run setup` loads). The package ships no
// extension: a stable npm install gets it from the Chrome Web Store item, and a dev build from the release service, as
// the zip OPENCODE_BROWSER_EXTENSION_ZIP names (scripts/release-check.ts), whose sha256 is baked in.
import { $ } from "bun"
import { createHash } from "node:crypto"
import { cp, readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { bundleCli } from "./bundle.ts"

const here = import.meta.dir
const checkout = path.resolve(here, "..")
const pkg = await Bun.file(path.join(here, "package.json")).json()

// The Chrome Web Store item, from the release workflow's repository variable CWS_ITEM_ID (RELEASING.md); unset in a checkout.
const storeId = process.env.OPENCODE_BROWSER_STORE_ID?.trim()
if (storeId && !/^[a-p]{32}$/.test(storeId)) throw new Error(`OPENCODE_BROWSER_STORE_ID is not a Chrome Web Store item ID: ${JSON.stringify(storeId)}`)
const store = storeId ? { id: storeId } : {}
// A dev build's unpacked extension zip, which the release workflow publishes to the release service.
const zip = process.env.OPENCODE_BROWSER_EXTENSION_ZIP?.trim()
const extension = zip
  ? await readFile(zip).then((bytes) => ({ file: path.basename(zip), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }))
  : undefined

const build = process.env.OPENCODE_BROWSER_BUILD ?? new Date().toISOString()
await $`bun run build`.cwd(checkout).env({ ...process.env, OPENCODE_BROWSER_BUILD: build }).quiet()
await rm(path.join(here, "dist"), { recursive: true, force: true })
// Earlier builds copied the extension into the package.
await rm(path.join(here, "extension"), { recursive: true, force: true })

await bundleCli({ outdir: path.join(here, "dist"), version: pkg.version, buildId: build, store, ...(extension ? { extension } : {}) })

// install compares this with the build a connected unpacked extension reports, to skip a reload that changes nothing.
await Bun.write(path.join(checkout, "dist", "build.json"), JSON.stringify({ build }) + "\n")
// MIT asks for the license with every copy; npm ships LICENSE from the package folder.
await cp(path.join(checkout, "LICENSE"), path.join(here, "LICENSE"))
// The same for every package bundled into dist/, found by the source paths the bundler leaves in its comments.
await Bun.write(path.join(here, "dist", "THIRD_PARTY_NOTICES.txt"), await thirdPartyNotices(path.join(here, "dist")))
const notes = [store.id && `store ${store.id}`, extension && `dev extension ${extension.file} ${extension.sha256.slice(0, 12)}`].filter(Boolean)
console.log(`built dist/cli.mjs and ../dist (${[pkg.version, ...notes].join(", ")})`)

async function thirdPartyNotices(dist: string) {
  const packages = new Set<string>()
  for (const name of await readdir(dist)) {
    if (!name.endsWith(".mjs")) continue
    for (const [, dir] of (await readFile(path.join(dist, name), "utf8")).matchAll(/^\/\/ ((?:[^\n]*\/)?node_modules\/(?:@[^/\n]+\/)?[^/\n]+)\//gm))
      packages.add(path.resolve(here, dir!))
  }
  const sections: string[] = []
  for (const dir of [...packages].sort()) {
    const { name, version } = await Bun.file(path.join(dir, "package.json")).json()
    const license = (await readdir(dir)).find((file) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(file))
    if (!license) throw new Error(`${name} is bundled into dist/ but has no license file to ship with it`)
    sections.push(`${name}@${version}\n\n${(await readFile(path.join(dir, license), "utf8")).trim()}`)
  }
  return `Third-party software bundled into this package:\n\n${sections.join(`\n\n${"-".repeat(80)}\n\n`)}\n`
}
