import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const installer = readFileSync(path.join(import.meta.dir, "../../install"), "utf8")
const powershellInstaller = readFileSync(path.join(import.meta.dir, "../../install.ps1"), "utf8")
const version = "0.0.7"
const packageName = "@opencode/browse-test"

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
  *registry.npmjs.org*) cp "$FAKE_METADATA" "$out"; printf '200' ;;
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

function tarballWithoutBinary(env: Env, name: string): string {
  const source = path.join(env.work, `${name}-source`)
  mkdirSync(path.join(source, "package"), { recursive: true })
  writeFileSync(path.join(source, "package/README.md"), "no binary here")
  const archive = path.join(env.work, `${name}.tgz`)
  const tar = spawnSync("tar", ["-czf", archive, "package"], { cwd: source })
  expect(tar.status, String(tar.stderr)).toBe(0)
  return archive
}

function tarballUrl(name: string): string {
  return `https://registry.npmjs.org/${packageName}/-/${name}.tgz`
}

// The npm version document as the registry returns it: dist fields in publish order, then the top-level fields npm adds.
// `integrity` is derived from the archive, overridden, or omitted; the top-level `_integrity` always has a real hash, so a
// check that reads the wrong field would pass a tarball it should reject.
function metadata(env: Env, name: string, options: { archive?: string; integrity?: string | null } = {}): string {
  const file = path.join(env.work, `${name}.json`)
  const bytes = options.archive ? readFileSync(options.archive) : undefined
  const sha512 = bytes ? createHash("sha512").update(bytes).digest("base64") : undefined
  const integrity = options.integrity === null ? undefined : (options.integrity ?? (sha512 ? `sha512-${sha512}` : undefined))
  const dist = bytes
    ? {
        shasum: createHash("sha1").update(bytes).digest("hex"),
        tarball: tarballUrl(name),
        fileCount: 2,
        signatures: [{ keyid: "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA", sig: "MEUCIQDx0y8ZKv3xHm4Q0J8m0T5g5m2Qm8b1o" }],
        ...(integrity === undefined ? {} : { integrity }),
        unpackedSize: 1234,
      }
    : {}
  writeFileSync(
    file,
    JSON.stringify({
      _id: `${packageName}@${version}`,
      name: packageName,
      version,
      dist,
      _integrity: sha512 ? `sha512-${sha512}` : undefined,
      _resolved: tarballUrl(name),
      _from: packageName,
      _nodeVersion: "22.19.0",
      _npmVersion: "10.9.0",
    }),
  )
  return file
}

function tempLeftovers(env: Env): string[] {
  return readdirSync(path.join(env.home, "tmp")).filter((name) => name.startsWith("browse_install_"))
}

function runInstaller(env: Env, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync("sh", ["-s", "--", ...args], {
    env: {
      PATH: `${env.bin}${path.delimiter}${process.env.PATH}`,
      HOME: env.home,
      TMPDIR: path.join(env.home, "tmp"),
      ...extraEnv,
    },
    input: installer,
    encoding: "utf8",
  })
  const leftovers = tempLeftovers(env)
  expect(leftovers, `installer left ${leftovers.join(", ")} behind`).toEqual([])
  return result
}

function install(env: Env, archive: string, packageMetadata: string) {
  return runInstaller(env, ["--version", version, "--no-setup"], {
    FAKE_TARBALL: archive,
    FAKE_METADATA: packageMetadata,
  })
}

test.skipIf(process.platform === "win32")("a pinned tarball matching npm's integrity installs", () => {
  const env = setup()
  try {
    const archive = tarball(env, "matching", "#!/bin/sh\nprintf 'good\\n'\n")
    const result = install(env, archive, metadata(env, "matching", { archive }))
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(path.join(env.home, ".local/bin/browse"), "utf8")).toContain("good")
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("a tarball with different contents than npm's integrity fails and leaves the old binary alone", () => {
  const env = setup()
  try {
    const published = tarball(env, "published", "#!/bin/sh\nprintf 'published\\n'\n")
    const tampered = tarball(env, "tampered", "#!/bin/sh\nprintf 'tampered\\n'\n")
    const bin = path.join(env.home, ".local/bin")
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, "browse"), "old binary")
    const result = install(env, tampered, metadata(env, "published", { archive: published }))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("checksum mismatch")
    expect(result.stderr).toContain("@opencode/browse-")
    expect(result.stderr).toContain("nothing was installed")
    expect(readFileSync(path.join(bin, "browse"), "utf8")).toBe("old binary")
    expect(existsSync(path.join(bin, "browse.new"))).toBe(false)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("a checksum mismatch fails before extraction, even when the download is not a tarball", () => {
  const env = setup()
  try {
    const published = tarball(env, "published", "published binary")
    // Not a tarball: extraction must never run, or its error would replace the checksum failure.
    const tampered = path.join(env.work, "tampered.tgz")
    writeFileSync(tampered, "tampered binary")
    const result = install(env, tampered, metadata(env, "published", { archive: published }))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("checksum mismatch")
    expect(result.stderr).toContain("nothing was installed")
    expect(existsSync(path.join(env.home, ".local/bin/browse"))).toBe(false)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("a pinned package without integrity fails and installs nothing", () => {
  const env = setup()
  try {
    const archive = tarball(env, "missing", "binary")
    const result = install(env, archive, metadata(env, "missing", { archive, integrity: null }))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("no published SHA-512 integrity")
    expect(result.stderr).toContain("nothing was installed")
    expect(existsSync(path.join(env.home, ".local/bin/browse"))).toBe(false)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("malformed integrity fails as invalid SHA-512, not as a missing tool", () => {
  const env = setup()
  try {
    const archive = tarball(env, "malformed", "binary")
    const result = install(env, archive, metadata(env, "malformed", { archive, integrity: "sha512-!!!notbase64" }))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("invalid SHA-512 integrity")
    expect(result.stderr).not.toContain("base64 or openssl is required")
    expect(existsSync(path.join(env.home, ".local/bin/browse"))).toBe(false)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("a SHA-512 integrity of the wrong length fails and installs nothing", () => {
  const env = setup()
  try {
    const archive = tarball(env, "short", "binary")
    const shortIntegrity = Buffer.alloc(32).toString("base64")
    const result = install(env, archive, metadata(env, "short", { archive, integrity: `sha512-${shortIntegrity}` }))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("invalid SHA-512 integrity")
    expect(existsSync(path.join(env.home, ".local/bin/browse"))).toBe(false)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("a sha1-only integrity fails and installs nothing", () => {
  const env = setup()
  try {
    const archive = tarball(env, "sha1", "binary")
    const sha1 = createHash("sha1").update(readFileSync(archive)).digest("hex")
    const result = install(env, archive, metadata(env, "sha1", { archive, integrity: `sha1-${sha1}` }))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("no published SHA-512 integrity")
    expect(existsSync(path.join(env.home, ".local/bin/browse"))).toBe(false)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("an empty pinned version fails instead of installing the channel", () => {
  const env = setup()
  try {
    const result = runInstaller(env, ["--version", "v", "--no-setup"])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--version needs a version, e.g. 0.0.14")
    expect(existsSync(path.join(env.home, ".local/bin/browse"))).toBe(false)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("a failed metadata read removes the temporary directory", () => {
  const env = setup()
  try {
    // The fake registry answers 200 but never writes the metadata file, so reading it fails.
    const result = runInstaller(env, ["--version", version, "--no-setup"], {
      FAKE_TARBALL: path.join(env.work, "missing.tgz"),
      FAKE_METADATA: path.join(env.work, "missing.json"),
    })
    expect(result.status).not.toBe(0)
    expect(existsSync(path.join(env.home, ".local/bin/browse"))).toBe(false)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("an archive that is not a tarball fails extraction and removes the temporary directory", () => {
  const env = setup()
  try {
    // The integrity matches this file, so the checksum passes and extraction is what fails.
    const archive = path.join(env.work, "garbage.tgz")
    writeFileSync(archive, "not a tarball")
    const result = install(env, archive, metadata(env, "garbage", { archive }))
    expect(result.status).not.toBe(0)
    expect(existsSync(path.join(env.home, ".local/bin/browse"))).toBe(false)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("a verified tarball without the binary fails before the move and installs nothing", () => {
  const env = setup()
  try {
    const archive = tarballWithoutBinary(env, "empty")
    const result = install(env, archive, metadata(env, "empty", { archive }))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("has no package/bin/browse")
    expect(existsSync(path.join(env.home, ".local/bin/browse"))).toBe(false)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

// .NET's HttpClient (PowerShell 7) accepts only RFC 7231 product tokens and comments in a User-Agent; Windows
// PowerShell 5.1 sends anything, so an invalid value here goes unnoticed until a PowerShell 7 user installs.
const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+"
const product = `${token}(?:/${token})?`
const comment = "\\([^()]*\\)"
const userAgent = new RegExp(`^${product}(?:[ \\t]+(?:${product}|${comment}))*$`)

test("every install.ps1 User-Agent is a valid sequence of product tokens", () => {
  const values = [...powershellInstaller.matchAll(/-UserAgent\s+"([^"]*)"/g)].map((match) =>
    match[1]!.replace(/\$(?:\{)?([A-Za-z_][A-Za-z0-9_]*)(?:\})?/g, (_whole, name: string) => (name === "version" ? "0.0.15" : "stable")),
  )
  expect(values.length).toBeGreaterThan(0)
  for (const value of values) expect(value, value).toMatch(userAgent)
})
