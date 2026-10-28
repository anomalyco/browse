// Bundles the CLI (src/main.ts and everything it loads) into one node ESM file, with npm dependencies left external
// and installed by npm. build.ts uses it for dist/cli.mjs; the auto-update tests build throwaway versions with it.
import { chmod } from "node:fs/promises"
import path from "node:path"

const here = import.meta.dir

export async function bundleCli(options: {
  readonly outdir: string
  readonly version: string
  readonly buildId?: string
  readonly store?: { readonly id?: string | undefined; readonly betaId?: string | undefined; readonly listed: boolean }
}): Promise<string> {
  const pkg = await Bun.file(path.join(here, "package.json")).json()
  const result = await Bun.build({
    entrypoints: [path.join(here, "src/main.ts")],
    outdir: options.outdir,
    naming: "cli.mjs",
    target: "node",
    format: "esm",
    // Runtime dependencies stay external; jsonc-parser (a dev dependency) is bundled.
    external: Object.keys(pkg.dependencies ?? {}),
    plugins: [
      {
        // jsonc-parser's default entry is UMD with runtime requires; its ESM build bundles cleanly.
        name: "jsonc-parser-esm",
        setup(build) {
          build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
            path: path.join(path.dirname(Bun.resolveSync("jsonc-parser/package.json", here)), "lib/esm/main.js"),
          }))
        },
      },
    ],
    define: {
      "globalThis.__OPENCODE_BROWSER_VERSION__": JSON.stringify(options.version),
      "globalThis.__OPENCODE_BROWSER_BUILD_ID__": JSON.stringify(options.buildId ?? new Date().toISOString()),
      "globalThis.__OPENCODE_BROWSER_STORE__": JSON.stringify(options.store ?? { listed: false }),
    },
  })
  if (!result.success) throw new AggregateError(result.logs, "build failed")
  const cli = path.join(options.outdir, "cli.mjs")
  const source = await Bun.file(cli).text()
  await Bun.write(cli, source.startsWith("#!") ? source : `#!/usr/bin/env node\n${source}`)
  await chmod(cli, 0o755)
  return cli
}
