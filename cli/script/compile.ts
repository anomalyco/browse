// Feasibility: compiles the CLI (src/main.ts) into a standalone executable with `bun build --compile`, every npm
// dependency bundled. Usage: bun script/compile.ts [target...], e.g. bun-linux-x64 bun-darwin-arm64. Output: dist-bin/.
import path from "node:path"

const here = path.resolve(import.meta.dir, "..")
const pkg = await Bun.file(path.join(here, "package.json")).json()
const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [`bun-${process.platform}-${process.arch}`]

for (const target of targets) {
  const outfile = path.join(here, "dist-bin", target, target.includes("windows") ? "browse.exe" : "browse")
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
      "globalThis.__OPENCODE_BROWSER_VERSION__": JSON.stringify(pkg.version),
      "globalThis.__OPENCODE_BROWSER_BUILD_ID__": JSON.stringify(new Date().toISOString()),
      "globalThis.__OPENCODE_BROWSER_STORE__": JSON.stringify({}),
      "globalThis.__OPENCODE_BROWSER_EXTENSION__": "undefined",
      "globalThis.__OPENCODE_BROWSER_COMPILED__": "true",
    },
  })
  if (!result.success) throw new AggregateError(result.logs, `compile failed for ${target}`)
  const size = Bun.file(outfile).size
  console.log(`${target}: ${outfile} (${(size / 1024 / 1024).toFixed(1)} MB)`)
}
