// Each check gets a log and a machine-readable result, even when a later check fails.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { openSync, closeSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { parseReleaseVersion } from "../scripts/version.ts"
import { freeSmokePort, smokeEnv } from "../scripts/check-artifacts.ts"
import matrix from "./matrix.json"

const root = path.resolve(import.meta.dir, "..")
const { positionals, values } = parseArgs({ allowPositionals: true, options: { version: { type: "string" } } })
const [tier] = positionals
if (positionals.length !== 1 || (tier !== "pr" && tier !== "artifact") || (tier === "pr" && values.version)) {
  throw new Error("usage: bun evals/run.ts pr | artifact [--version <published version>]")
}
const { version } = parseReleaseVersion(values.version ?? process.env.EVAL_BUILD_VERSION ?? (await Bun.file(path.join(root, "cli/package.json")).json()).version)
const dir = path.join(import.meta.dir, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}-${tier}`)
await mkdir(dir, { recursive: true })
const home = await mkdtemp(path.join(os.tmpdir(), "browse-eval-"))
// The file-sandbox tests distinguish HOME from /tmp (both /tmp and TMPDIR are allowed file roots).
const prHome = tier === "pr" ? await mkdtemp(path.join(os.homedir(), ".browse-eval-home-")) : undefined
const steps: { name: string; cwd?: string; cmd: string[] }[] = tier === "pr" ? matrix.pr : matrix.artifact.map(name => ({
  name, cmd: ["bun", "evals/artifact.ts", name, home, version, values.version ? "published" : "built"],
}))
let failed = false
try {
  const port = await freeSmokePort()
  const env: Record<string, string | undefined> = { ...smokeEnv(home), OPENCODE_BROWSER_PORT: String(port), BROWSE_TEST_RELAY_PORT: String(port),
    BROWSE_TEST_FIXTURE_PORT: String(await freeSmokePort(port)),
    // The browser is provisioned before changing HOME (CI uses patchright's download cache).
    ...(tier === "pr" ? { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? require(path.join(root, "cli/node_modules/patchright-core")).chromium.executablePath() } : {}),
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("EVAL_") || k === "BUN_COMPILE_RELEASE")),
  }
  if (prHome) {
    env.HOME = env.USERPROFILE = prHome
    delete env.OPENCODE_BROWSER_UPDATE_CHECK // the unit suite exercises both enabled and disabled update checks
  }
  for (const step of steps) {
    const log = `${step.name}.log`
    const fd = openSync(path.join(dir, log), "w")
    const start = performance.now()
    let exit: number | null = null
    try {
      exit = await Bun.spawn(step.cmd, { cwd: path.join(root, step.cwd ?? ""), env, stdin: "ignore", stdout: fd, stderr: fd }).exited
    } catch (error) {
      await writeFile(path.join(dir, log), String(error), { flag: "a" })
    } finally { closeSync(fd) }
    const durationMs = Math.round(performance.now() - start)
    const status = exit === 0 ? "pass" : "fail"
    await writeFile(path.join(dir, `${step.name}.json`), JSON.stringify({ name: step.name, tier, os: process.platform, arch: process.arch, version, status, durationMs, log }, null, 2) + "\n")
    console.log(`${step.name}: ${status} (${(durationMs / 1000).toFixed(1)}s)`)
    if (exit !== 0) {
      failed = true
      console.error((await Bun.file(path.join(dir, log)).text()).slice(-4000))
      if (step.name === "prepare") break // no artifacts to execute
    }
  }
} finally {
  if (prHome) await rm(prHome, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
console.log(`Results: ${dir}`)
process.exitCode = failed ? 1 : 0
