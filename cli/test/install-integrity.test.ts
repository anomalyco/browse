import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const installer = readFileSync(path.join(import.meta.dir, "../../install"), "utf8")
const version = "0.0.7"

type Env = { home: string; bin: string; work: string }

function setup(): Env {
  const home = mkdtempSync(path.join(tmpdir(), "browse installer-integrity-"))
  const bin = path.join(home, "fake bin")
  const work = path.join(home, "work")
  mkdirSync(bin)
  mkdirSync(work)
  mkdirSync(path.join(home, "tmp"))
  writeFileSync(path.join(bin, "curl"), `#!/bin/sh
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -H|-A|--header|--user-agent|-w) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  *registry.npmjs.org*/-/*.tgz) cp "$FAKE_TARBALL" "$out"; printf '200' ;;
  *registry.npmjs.org*) cp "$FAKE_METADATA" "$out"; printf '%s' "\${FAKE_STATUS:-200}"; exit 0 ;;
  *) echo "fake curl: unexpected URL $url" >&2; exit 1 ;;
esac
`)
  chmodSync(path.join(bin, "curl"), 0o755)
  return { home, bin, work }
}

function tarball(env: Env, name: string, contents: string): string {
  const source = path.join(env.work, `${name}-source`)
  mkdirSync(path.join(source, "package/bin"), { recursive: true })
  writeFileSync(path.join(source, "package/bin/browse"), contents)
  const archive = path.join(env.work, `${name}.tgz`)
  const tar = spawnSync("tar", ["-czf", archive, "package"], { cwd: source })
  expect(tar.status, String(tar.stderr)).toBe(0)
  return archive
}

function metadata(env: Env, archive: string | undefined, name: string): string {
  const file = path.join(env.work, `${name}.json`)
  const dist = archive ? { tarball: `https://registry.npmjs.org/@opencode/browse-test/-/${name}.tgz`, integrity: `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}` } : {}
  writeFileSync(file, JSON.stringify({ name: "@opencode/browse-test", version, dist }))
  return file
}

function install(env: Env, archive: string, packageMetadata: string, status = "200") {
  return spawnSync("sh", ["-s", "--", "--version", version, "--no-setup"], {
    env: {
      PATH: `${env.bin}${path.delimiter}${process.env.PATH}`,
      HOME: env.home,
      TMPDIR: path.join(env.home, "tmp"),
      FAKE_TARBALL: archive,
      FAKE_METADATA: packageMetadata,
      FAKE_STATUS: status,
    },
    input: installer,
    encoding: "utf8",
  })
}

test.skipIf(process.platform === "win32")("a pinned tarball matching npm's integrity installs", () => {
  const env = setup()
  try {
    const archive = tarball(env, "matching", "#!/bin/sh\nprintf 'good\\n'\n")
    const run = install(env, archive, metadata(env, archive, "matching"))
    expect(run.status, run.stderr).toBe(0)
    expect(readFileSync(path.join(env.home, ".local/bin/browse"), "utf8")).toContain("good")
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("a tarball that does not match npm's integrity fails and leaves the old binary alone", () => {
  const env = setup()
  try {
    const published = tarball(env, "published", "published binary")
    // Not a tarball: extraction must never run, or its error would replace the checksum failure.
    const tampered = path.join(env.work, "tampered.tgz")
    writeFileSync(tampered, "tampered binary")
    const bin = path.join(env.home, ".local/bin")
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, "browse"), "old binary")
    const run = install(env, tampered, metadata(env, published, "published"))
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("checksum mismatch")
    expect(run.stderr).toContain("@opencode/browse-")
    expect(run.stderr).toContain("nothing was installed")
    expect(readFileSync(path.join(bin, "browse"), "utf8")).toBe("old binary")
    expect(existsSync(path.join(bin, "browse.new"))).toBe(false)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("a pinned package without integrity fails and installs nothing", () => {
  const env = setup()
  try {
    const archive = tarball(env, "missing", "binary")
    const run = install(env, archive, metadata(env, undefined, "missing"))
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("no published SHA-512 integrity")
    expect(run.stderr).toContain("nothing was installed")
    expect(existsSync(path.join(env.home, ".local/bin/browse"))).toBe(false)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})
