// Throwaway versions of the CLI for the auto-update tests, bundled from source.
import fs from "node:fs"
import path from "node:path"
import { bundleCli } from "../../bundle.ts"

const cliRoot = path.resolve(import.meta.dir, "..", "..")

/** Puts `code` at the top of a bundled entry, which runs before the CLI does anything. */
export function prepend(entry: string, code: string) {
  const [first = "", ...rest] = fs.readFileSync(entry, "utf8").split("\n")
  fs.writeFileSync(entry, (first.startsWith("#!") ? [first, code, ...rest] : [code, first, ...rest]).join("\n"))
}

/** Code that makes `serve` crash, when `when` holds, the way a release with a missing dependency export does. */
export const crash = (when: string) =>
  `if (process.argv[2] === "serve" && ${when}) throw new SyntaxError("The requested module '@effect/platform-node-shared' does not provide an export named 'NodeWS'")`

/** `version` as npx leaves it, under `root`: the package with its dependencies beside it. Returns its entry. */
export async function npxPackage(root: string, version: string, code: string) {
  const modules = path.join(root, `npx-${version}`, "node_modules")
  const entry = path.join(modules, "@opencode", "browse", "dist", "cli.mjs")
  await bundleCli({ outdir: path.dirname(entry), version })
  prepend(entry, code)
  const { dependencies } = JSON.parse(fs.readFileSync(path.join(cliRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> }
  fs.writeFileSync(path.join(path.dirname(path.dirname(entry)), "package.json"), JSON.stringify({ name: "@opencode/browse", version, type: "module", dependencies }))
  for (const name of fs.readdirSync(path.join(cliRoot, "node_modules"))) {
    if (name.startsWith(".") || name === "@opencode") continue
    fs.symlinkSync(path.join(cliRoot, "node_modules", name), path.join(modules, name), "dir")
  }
  return entry
}
