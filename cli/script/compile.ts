// Compiles the CLI (src/main.ts, every npm dependency bundled) into standalone executables with `bun build --compile`.
//   bun script/compile.ts [bun-target...]     e.g. bun-linux-x64 bun-darwin-arm64 bun-windows-x64 bun-linux-x64-musl
// Default: this computer's platform. Output: dist-bin/<target>/browse (browse.exe on Windows), where <target> is the
// platform as the install script names it (linux-x64, darwin-arm64, linux-x64-baseline-musl…): the executable's npm
// package is @opencode/browse-<target>, with the executable at package/bin/browse[.exe].
// Like build.ts, OPENCODE_BROWSER_STORE_ID bakes in the Chrome Web Store item, and OPENCODE_BROWSER_VERSION overrides
// package.json's version.
import path from "node:path"

const here = path.resolve(import.meta.dir, "..")
const pkg = await Bun.file(path.join(here, "package.json")).json()
const version: string = process.env.OPENCODE_BROWSER_VERSION?.trim() || pkg.version
const storeId = process.env.OPENCODE_BROWSER_STORE_ID?.trim()
if (storeId && !/^[a-p]{32}$/.test(storeId)) throw new Error(`OPENCODE_BROWSER_STORE_ID is not a Chrome Web Store item ID: ${JSON.stringify(storeId)}`)
const buildId = new Date().toISOString()
const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [`bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`]

/** bun-linux-x64-musl-baseline → linux-x64-baseline-musl, the install script's order. */
function platformTarget(bunTarget: string): string {
  const parts = bunTarget.replace(/^bun-/, "").split("-")
  const [os, arch] = parts
  if (!os || !arch) throw new Error(`Not a bun compile target: ${bunTarget}`)
  return [os, arch, ...(parts.includes("baseline") ? ["baseline"] : []), ...(parts.includes("musl") ? ["musl"] : [])].join("-")
}

for (const target of targets) {
  const platform = platformTarget(target)
  const outfile = path.join(here, "dist-bin", platform, platform.startsWith("windows") ? "browse.exe" : "browse")
  const result = await Bun.build({
    entrypoints: [path.join(here, "src/main.ts")],
    compile: { target: target as Bun.Build.Target, outfile },
    minify: { syntax: true, whitespace: true },
    sourcemap: "none",
    // patchright-core's BiDi-over-CDP bridge (Firefox) requires chromium-bidi lazily; Browse only uses connectOverCDP.
    external: ["chromium-bidi/*"],
    plugins: [
      {
        name: "jsonc-parser-esm",
        setup(build) {
          build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
            path: path.join(path.dirname(Bun.resolveSync("jsonc-parser/package.json", here)), "lib/esm/main.js"),
          }))
        },
      },
    ],
    define: {
      "globalThis.__OPENCODE_BROWSER_VERSION__": JSON.stringify(version),
      "globalThis.__OPENCODE_BROWSER_BUILD_ID__": JSON.stringify(buildId),
      "globalThis.__OPENCODE_BROWSER_STORE__": JSON.stringify(storeId ? { id: storeId } : {}),
      "globalThis.__OPENCODE_BROWSER_EXTENSION__": "undefined",
      "globalThis.__OPENCODE_BROWSER_COMPILED__": "true",
      "globalThis.__OPENCODE_BROWSER_TARGET__": JSON.stringify(platform),
    },
  })
  if (!result.success) throw new AggregateError(result.logs, `compile failed for ${target}`)
  console.log(`${platform}: ${outfile} (${(Bun.file(outfile).size / 1024 / 1024).toFixed(1)} MB)`)
}
