// Local PRs need only the host binary; build the other runners' inputs in the same Linux job when requested.
import { $ } from "bun"
import path from "node:path"
export const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`

if (import.meta.main) {
  const cli = path.join(import.meta.dir, "../cli")
  const extra = (process.env.EVAL_EXTRA_TARGETS ?? "").split(/\s+/).filter(Boolean)
  await $`bun script/compile.ts ${[target, ...extra]}`.cwd(cli)
  const version = await $`${path.join(cli, `dist-bin/browse-${target}/bin/browse${process.platform === "win32" ? ".exe" : ""}`)} --version`.text()
  if (version.trim() !== (await Bun.file(path.join(cli, "package.json")).json()).version) throw new Error(`unexpected --version: ${version}`)
  await $`bun script/pack.ts`.cwd(cli)
}
