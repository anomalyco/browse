import { $ } from "bun"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, rename } from "node:fs/promises"
import path from "node:path"
import { checkCliRuntime, checkPackageInstall, checkStoreZip, freeSmokePort, smokeEnv } from "../scripts/check-artifacts.ts"
import { target } from "./compile.ts"

const [step, scratch, version, source] = process.argv.slice(2) as [string, string, string, string]
const root = path.resolve(import.meta.dir, "..")
const published = source === "published"
const dev = version.includes("-dev.")
const win = process.platform === "win32"
const exe = win ? "browse.exe" : "browse"
// Git Bash's GNU tar treats D:\... as a remote host. Match the native tar used by install.ps1.
const tar = win ? path.join(process.env.SystemRoot!, "System32/tar.exe") : "tar"
const zipName = `${dev ? "browse-extension" : "opencode-browser"}-${version}.zip`
const build = process.env.EVAL_BUILD_DIR ?? path.join(root, "release")
const binaries = process.env.EVAL_BINARIES_DIR ?? path.join(root, "cli/dist-bin/npm")
const npmTar = path.join(published ? scratch : build, `opencode-browse-${version}.tgz`)
const binaryTar = (target: string) => path.join(published ? scratch : binaries, `opencode-browse-${target}-${version}.tgz`)
const zip = path.join(published && !process.env.EVAL_BUILD_DIR ? scratch : build, zipName)
const cwd = await mkdtemp(path.join(scratch, `${step}-`))

// npm checks dist.integrity when it packs a registry version. Retry only registry availability, never a smoke test.
async function packPublished(name: string) {
  const deadline = Date.now() + Number(process.env.EVAL_REGISTRY_WAIT_MS ?? 0)
  for (;;) {
    const result = await $`npm pack ${name + "@" + version} --registry=https://registry.npmjs.org --ignore-scripts --prefer-online --fetch-retries=0 --fetch-timeout=15000 --pack-destination ${scratch}`.cwd(cwd).quiet().nothrow()
    if (result.exitCode === 0) return
    const error = result.stderr.toString()
    if (Date.now() >= deadline || !/E404|ETARGET|E50[234]|ETIMEDOUT|ECONNRESET/.test(error)) throw new Error(error)
    console.warn(`${name}@${version} isn't available yet; retrying in 10s`)
    await Bun.sleep(10_000)
  }
}

async function publishedZip() {
  let url = `https://github.com/anomalyco/browse/releases/download/v${version}/${zipName}`
  if (dev) {
    // The release service's channel URL moves; the published CLI names its exact immutable extension zip.
    await $`${tar} -xzf ${npmTar} -C ${cwd} package/dist`
    const dist = path.join(cwd, "package/dist")
    let digest: string | undefined
    for (const file of await readdir(dist)) {
      if (!file.endsWith(".mjs")) continue
      const text = await Bun.file(path.join(dist, file)).text()
      const at = text.indexOf(zipName)
      if (at >= 0) digest ??= text.slice(at + zipName.length, at + zipName.length + 128).match(/sha256["']?\s*:\s*["']([a-f0-9]{64})["']/)?.[1]
    }
    if (!digest) throw new Error(`No immutable ${zipName} reference in the published CLI`)
    url = `https://anoma.ly/release/browse/files/${digest}/${zipName}`
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  await Bun.write(zip, await response.arrayBuffer())
}

// Fresh CI VMs have neither directory. For a locally built binary, also hide the absolute build paths: changing
// cwd and HOME alone doesn't catch a bundled __dirname. Keep the directories on their own volume and restore them.
async function withoutBuildDeps<T>(check: () => Promise<T>) {
  const moved: [string, string][] = []
  try {
    for (const dir of ["node_modules", "cli/node_modules"]) {
      const from = path.join(root, dir)
      if (!existsSync(from)) continue
      const to = `${from}.eval-${process.pid}`
      await rename(from, to)
      moved.push([from, to])
    }
    return await check()
  } finally {
    for (const [from, to] of moved.reverse()) await rename(to, from)
  }
}

async function installer() {
  // A real npm-layout mirror. 404 any other target/path rather than serving whatever binary happens to be there.
  const served = new Set<string>()
  const mirror = !published && Bun.serve({ hostname: "127.0.0.1", port: await freeSmokePort(), async fetch(req) {
    const pathname = decodeURIComponent(new URL(req.url).pathname)
    for (const t of [target, ...(target.endsWith("-x64") ? [`${target}-baseline`] : [])]) {
      const file = Bun.file(binaryTar(t))
      if (!await file.exists()) continue
      if (pathname === `/@opencode/browse-${t}/${version}`) return Response.json({ version })
      if (pathname === `/@opencode/browse-${t}/-/browse-${t}-${version}.tgz`) {
        served.add(t)
        return new Response(file)
      }
    }
    console.error(`Mirror has no ${pathname}`)
    return new Response(null, { status: 404 })
  } })
  try {
    const env = { ...smokeEnv(cwd), ...(mirror ? { BROWSE_INSTALL_BASE_URL: `http://127.0.0.1:${mirror.port}` } : {}) }
    const args = win ? ["pwsh", "-NoProfile", "-NonInteractive", "-File", path.join(root, "install.ps1")] : ["bash", path.join(root, "install")]
    await $`${args} --version ${version} --no-setup --no-modify-path`.cwd(cwd).env(env)
    if (mirror && !served.size) throw new Error("Installer did not download this run's platform tarball from the mirror")
    return await checkCliRuntime([path.join(cwd, ".browse/bin", exe)], cwd, version, false)
  } finally { if (mirror) await mirror.stop(true) }
}

let problems: string[] = []
switch (step) {
  case "prepare":
    if (published) {
      await Promise.all([packPublished("@opencode/browse"), packPublished(`@opencode/browse-${target}`)])
      if (!process.env.EVAL_BUILD_DIR) await publishedZip()
    }
    for (const file of [npmTar, binaryTar(target), zip]) {
      if (!await Bun.file(file).exists()) throw new Error(`Missing ${file}. Build this version first (see evals/README.md).`)
    }
    break
  case "binary":
    await $`${tar} -xzf ${binaryTar(target)} -C ${cwd} ${`package/bin/${exe}`}`
    problems = await withoutBuildDeps(() => checkCliRuntime([path.join(cwd, "package/bin", exe)], cwd, version))
    break
  case "npm": problems = await checkPackageInstall(npmTar, version); break
  case "installer": problems = await installer(); break
  case "extension-zip": problems = await checkStoreZip(zip, version, undefined, dev); break
  default: throw new Error(`Unknown artifact check: ${step}`)
}
if (problems.length) throw new Error(problems.join("\n"))
console.log(`${step}: ${target} ${version} OK`)
