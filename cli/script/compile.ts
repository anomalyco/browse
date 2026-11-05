// Compiles the CLI (src/main.ts, the entry dist/cli.mjs bundles) into standalone executables with `bun build --compile`,
// every npm dependency bundled, one per platform the way opencode ships @opencode/cli-<target>:
//   bun script/compile.ts [target...]    e.g. linux-x64 darwin-arm64 windows-x64; no target: every target
// Output: dist-bin/browse-<target>/bin/browse (browse.exe on Windows) and its package.json (@opencode/browse-<target>,
// with os/cpu/libc), which script/pack.ts packs for npm. Like build.ts, OPENCODE_BROWSER_STORE_ID bakes in the store
// item and OPENCODE_BROWSER_EXTENSION_ZIP a dev build's extension zip. BUN_COMPILE_RELEASE (e.g. bun-v1.4.4) takes
// each target's Bun runtime from that GitHub release, checked against its SHASUMS256.txt, instead of letting Bun fetch it.
import { $ } from "bun"
import { createHash } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { NativeArch } from "./native-arch.ts"

const here = path.resolve(import.meta.dir, "..")
const outdir = path.join(here, "dist-bin")
const pkg = await Bun.file(path.join(here, "package.json")).json()
const version: string = pkg.version
const channel = version.includes("-dev.") ? "dev" : "latest"

type Target = { os: "linux" | "darwin" | "win32"; arch: "x64" | "arm64"; abi?: "musl"; avx2?: false }

// The targets the install script picks from (../install). Windows on ARM64 runs the x64 build.
export const targets: Target[] = [
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

/** linux-x64-baseline-musl: the install script's name, the npm package's suffix, and Bun's target after `bun-`. */
export function targetName(item: Target) {
  return [item.os === "win32" ? "windows" : item.os, item.arch, item.avx2 === false ? "baseline" : undefined, item.abi].filter(Boolean).join("-")
}

if (import.meta.main) {
  const requested = process.argv.slice(2).map((arg) => arg.replace(/^bun-/, ""))
  const unknown = requested.filter((name) => !targets.some((item) => targetName(item) === name))
  if (unknown.length) throw new Error(`Unknown target ${unknown.join(", ")}; one of ${targets.map(targetName).join(", ")}`)
  const selected = requested.length ? targets.filter((item) => requested.includes(targetName(item))) : targets

  const storeId = process.env.OPENCODE_BROWSER_STORE_ID?.trim()
  if (storeId && !/^[a-p]{32}$/.test(storeId)) throw new Error(`OPENCODE_BROWSER_STORE_ID is not a Chrome Web Store item ID: ${JSON.stringify(storeId)}`)
  const zip = process.env.OPENCODE_BROWSER_EXTENSION_ZIP?.trim()
  const extension = zip
    ? await readFile(zip).then((bytes) => ({ file: path.basename(zip), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }))
    : undefined
  const build = process.env.OPENCODE_BROWSER_BUILD ?? new Date().toISOString()

  await rm(outdir, { recursive: true, force: true })
  for (const item of selected) {
    const target = targetName(item)
    const name = `browse-${target}`
    const binary = path.join(outdir, name, "bin", item.os === "win32" ? "browse.exe" : "browse")
    const executablePath = await bunRuntime(item)
    const result = await Bun.build({
      entrypoints: [path.join(here, "src/main.ts")],
      tsconfig: path.join(here, "tsconfig.json"),
      format: "esm",
      minify: true,
      bytecode: true,
      sourcemap: "none",
      splitting: true,
      // patchright-core's BiDi-over-CDP bridge (Firefox) requires chromium-bidi lazily; browse only uses connectOverCDP.
      external: ["chromium-bidi/*"],
      plugins: [
        {
          // jsonc-parser's default entry is UMD with runtime requires; its ESM build bundles cleanly (bundle.ts).
          name: "jsonc-parser-esm",
          setup(build) {
            build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
              path: path.join(path.dirname(Bun.resolveSync("jsonc-parser/package.json", here)), "lib/esm/main.js"),
            }))
          },
        },
        patchrightFiles(),
      ],
      compile: {
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
        target: `bun-${target}` as Bun.Build.CompileTarget,
        ...(executablePath ? { executablePath } : {}),
        outfile: binary,
        execArgv: [`--user-agent=browse/${channel}/${version}`, "--use-system-ca", "--"],
        windows: {},
      },
      define: {
        "globalThis.__OPENCODE_BROWSER_VERSION__": JSON.stringify(version),
        "globalThis.__OPENCODE_BROWSER_BUILD_ID__": JSON.stringify(build),
        "globalThis.__OPENCODE_BROWSER_STORE__": JSON.stringify(storeId ? { id: storeId } : {}),
        "globalThis.__OPENCODE_BROWSER_EXTENSION__": extension ? JSON.stringify(extension) : "undefined",
        "globalThis.__OPENCODE_BROWSER_COMPILED__": "true",
        "globalThis.__OPENCODE_BROWSER_TARGET__": JSON.stringify(target),
      },
    })
    if (!result.success) throw new AggregateError(result.logs, `compile failed for ${target}`)
    await NativeArch.verify(binary, item.arch)

    await Bun.write(
      path.join(outdir, name, "package.json"),
      JSON.stringify(
        {
          name: `@opencode/${name}`,
          version,
          description: `The browse binary for ${target}.`,
          license: pkg.license,
          repository: pkg.repository,
          os: [item.os],
          cpu: [item.arch],
          ...(item.os === "linux" ? { libc: [item.abi ?? "glibc"] } : {}),
          publishConfig: { access: "public" },
        },
        null,
        2,
      ) + "\n",
    )
    console.log(`${name}: ${path.relative(here, binary)} (${(Bun.file(binary).size / 1024 / 1024).toFixed(1)} MB)`)
  }
}

/**
 * patchright-core reads a few of its own files at run time from a path built on __dirname, which a compiled binary
 * bakes in as the build machine's node_modules (so it only worked where it was built). The ones browse reaches are
 * written into the bundle instead: package.json and browsers.json (read when the module loads) and the WebP encoder
 * (screenshots). The rest browse never runs and is left as it is: browser downloads and install
 * (lib/entry/oopBrowserDownload.js, the browsers.json registry), the app icon of launchApp, the dashboard and skills
 * the CLI offers agents (lib/tools, lib/vite/dashboard), the Electron loader, the recorder and the trace viewer
 * (lib/vite/{recorder,traceViewer}, trace-viewer/), its own `run-driver` (cli.js), and xdg-open (utils bundle).
 */
function patchrightFiles(): Bun.BunPlugin {
  return {
    name: "patchright-files",
    setup(build) {
      const root = path.dirname(Bun.resolveSync("patchright-core/package.json", here))
      const json = (file: string) => readFile(path.join(root, file), "utf8").then((text) => JSON.stringify(JSON.parse(text)))
      // execute/patchright-tuning.ts reaches patchright-core's internals through createRequire(import.meta.url), which
      // a compiled binary resolves against its bundle path (/$bunfs/root, no node_modules); a plain require is resolved
      // while bundling, so the module it names is in the executable. The npm/Node build keeps its runtime require.
      build.onLoad({ filter: /[\\/]src[\\/]execute[\\/]patchright-tuning\.ts$/ }, async (args) => {
        const text = await readFile(args.path, "utf8")
        const contents = text.replaceAll("createRequire(import.meta.url)(", "require(")
        if (contents === text && text.includes("createRequire("))
          throw new Error("patchright-tuning.ts no longer calls createRequire(import.meta.url) directly; check how it loads patchright-core")
        return { contents, loader: "ts" }
      })
      build.onLoad({ filter: /[\\/]patchright-core[\\/]lib[\\/][^\\/]+\.js$/ }, async (args) => {
        let text = await readFile(args.path, "utf8")
        const packageJson = await json("package.json")
        const browsersJson = await json("browsers.json")
        text = text.replace(/require\(([\w$]+)\.default\.join\(packageRoot, "package\.json"\)\)/g, () => `(${packageJson})`)
        text = text.replace(/require\(([\w$]+)\.default\.join\(packageRoot, "browsers\.json"\)\)/g, () => `(${browsersJson})`)
        if (text.includes('"webp_codec.wasm"')) {
          const wasm = (await readFile(path.join(root, "lib", "webp_codec.wasm"))).toString("base64")
          text = text.replace(/([\w$]+)\.default\.readFileSync\(([\w$]+)\.default\.join\(__dirname, "webp_codec\.wasm"\)\)/g, () => `Buffer.from("${wasm}", "base64")`)
        }
        return { contents: text, loader: "js" }
      })
    },
  }
}

// Bun's runtime for a target from the pinned release, verified, as the executable to compile into (cross-compiling).
async function bunRuntime(item: Target) {
  const release = process.env.BUN_COMPILE_RELEASE?.trim()
  if (!release) return
  const name = ["bun", item.os === "win32" ? "windows" : item.os, item.arch === "arm64" ? "aarch64" : item.arch, item.abi, item.avx2 === false ? "baseline" : undefined]
    .filter(Boolean)
    .join("-")
  const cache = path.join(here, ".cache", "bun", release)
  const executable = path.join(cache, name, item.os === "win32" ? "bun.exe" : "bun")
  if (await Bun.file(executable).exists()) return executable

  await mkdir(cache, { recursive: true })
  // Release downloads, not the API: no token and no API rate limit on shared runners.
  const base = `https://github.com/oven-sh/bun/releases/download/${encodeURIComponent(release)}`
  const [response, sums] = await Promise.all([fetch(`${base}/${name}.zip`), fetch(`${base}/SHASUMS256.txt`)])
  if (!response.ok) throw new Error(`Failed to download ${name} from Bun release ${release}: ${response.status}`)
  if (!sums.ok) throw new Error(`Failed to download Bun release ${release} checksums: ${sums.status}`)
  const expected = (await sums.text())
    .split("\n")
    .find((line) => line.trimEnd().endsWith(`  ${name}.zip`))
    ?.split(/\s+/)[0]
  if (!expected) throw new Error(`Missing checksum for ${name}.zip in Bun release ${release}`)
  // Streamed to disk: `Bun.write(file, response)` can hang if the Response is collected mid-download
  // (https://github.com/oven-sh/bun/issues/40278).
  const archive = path.join(cache, `${name}.zip`)
  const hash = createHash("sha256")
  const sink = Bun.file(archive).writer()
  for await (const chunk of response.body!) {
    hash.update(chunk)
    await sink.write(chunk)
  }
  await sink.end()
  if (hash.digest("hex") !== expected) {
    await rm(archive)
    throw new Error(`Checksum mismatch for ${name}.zip in Bun release ${release}`)
  }
  await $`unzip -oq ${archive} -d ${cache}`
  await rm(archive)
  return executable
}
