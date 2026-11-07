// The Anomaly release service client (anomalyco/release docs/protocol.md): the manifest a binary install polls, the
// client rules that decide whether its channel's current release is the build it runs, and the file URLs the installer
// verifies. Versions are display text, never ordered: an install moves whenever the channel's current release is not
// the build it runs. npm, pnpm and bun installs never read this; they follow the npm registry (auto-update.ts).
import crypto from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { RELEASE_SERVICE, stateRoot } from "../paths.ts"

export type ReleaseChannel = "stable" | "beta" | "dev"

/** The service's target name for a build: macos where npm says darwin, everything else already agrees. */
export function serviceTarget(target: string): string {
  return target.replace(/^darwin-/, "macos-")
}

/** This executable's service target; undefined outside a compiled binary (an npm install has no service manifest). */
export function runningServiceTarget(): string | undefined {
  return globalThis.__OPENCODE_BROWSER_TARGET__ ? serviceTarget(globalThis.__OPENCODE_BROWSER_TARGET__) : undefined
}

/** The service channel for a build: npm's `latest` tag is the service's `stable` channel. */
export function releaseChannel(channel: string): ReleaseChannel {
  if (channel === "dev" || channel === "beta" || channel === "stable") return channel
  return "stable"
}

export const releaseService = (env: NodeJS.ProcessEnv = process.env) =>
  (env.OPENCODE_BROWSER_RELEASE_SERVICE?.trim() || RELEASE_SERVICE).replace(/\/+$/, "")

// ---- the protocol's manifest and client rules -----------------------------------------------------

export type Target = { readonly url: string; readonly size: number; readonly sha256: string }

type Release = {
  readonly version: string
  readonly notes_url?: string
  readonly rollout_percent: number
  readonly required: boolean
  readonly targets: Readonly<Record<string, Target>>
  readonly distributions: readonly { readonly kind: string; readonly version?: string; readonly command?: string }[]
}

export type Manifest = {
  readonly schema: 1
  readonly app: string
  readonly artifact: string
  readonly channel: string
  readonly sequence: number
  readonly release: Release
}

export type ReleaseInstall = {
  readonly version: string
  readonly target: string
  readonly distribution: string
  /** 0–99, drawn once and kept locally; never sent. */
  readonly rolloutBucket: number
  readonly sha256?: string
  /** The channel this build was published on; absent means the expected one. */
  readonly channel?: string
}

export type ReleaseDecision =
  | { readonly action: "reject"; readonly reason: "malformed" | "wrong_app" | "wrong_artifact" | "wrong_channel" }
  | { readonly action: "none"; readonly reason: "up_to_date" | "rollout_deferred" | "no_target" | "distribution_unlisted" | "distribution_pending" }
  | { readonly action: "install"; readonly reason: "update" | "required" | "switch"; readonly version: string; readonly target: Target }
  | {
      readonly action: "notify"
      readonly reason: "update" | "required" | "switch"
      readonly version: string
      readonly distribution: string
      readonly command?: string
      readonly notes_url?: string
    }

const NAME = /^[a-z][a-z0-9-]{0,31}$/
const SHA256 = /^[0-9a-f]{64}$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const text = (value: unknown, pattern?: RegExp): string | undefined =>
  typeof value === "string" && (!pattern || pattern.test(value)) ? value : undefined
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined
const https = (value: unknown): string | undefined => {
  const url = text(value)
  if (!url) return undefined
  try {
    return new URL(url).protocol === "https:" ? url : undefined
  } catch {
    return undefined
  }
}

/** A manifest as clients read it: unknown fields are ignored so the service can add some without breaking us. */
export function parseManifest(value: unknown): Manifest | undefined {
  const raw = record(value)
  const release = record(raw?.release)
  if (!raw || !release || raw.schema !== 1) return undefined
  const app = text(raw.app, NAME)
  const artifact = text(raw.artifact, NAME)
  const channel = text(raw.channel, NAME)
  const sequence = integer(raw.sequence, 1)
  const version = text(release.version, VERSION)
  const rollout = integer(release.rollout_percent, 0, 100)
  if (!app || !artifact || !channel || sequence === undefined || !version || rollout === undefined) return undefined
  if (typeof raw.published_at !== "string") return undefined
  if (release.required !== undefined && release.required !== false && release.required !== true) return undefined
  const targets: Record<string, Target> = {}
  const rawTargets = record(release.targets)
  if (!rawTargets || Object.keys(rawTargets).length > 64) return undefined
  for (const [name, item] of Object.entries(rawTargets)) {
    const target = record(item)
    const url = text(target?.url)
    const size = integer(target?.size, 0)
    const sha256 = text(target?.sha256, SHA256)
    if (!url || size === undefined || !sha256) return undefined
    targets[name] = { url, size, sha256 }
  }
  if (!Array.isArray(release.distributions) || release.distributions.length > 32) return undefined
  const distributions: { kind: string; version?: string; command?: string }[] = []
  for (const item of release.distributions) {
    const distribution = record(item)
    const kind = text(distribution?.kind, NAME)
    if (!distribution || !kind) return undefined
    const distributionVersion = distribution.version === undefined ? undefined : text(distribution.version, VERSION)
    const command = distribution.command === undefined ? undefined : text(distribution.command)
    if ((distribution.version !== undefined && !distributionVersion) || (distribution.command !== undefined && !command)) return undefined
    distributions.push({ kind, ...(distributionVersion ? { version: distributionVersion } : {}), ...(command ? { command } : {}) })
  }
  const notes_url = release.notes_url === undefined ? undefined : https(release.notes_url)
  if (release.notes_url !== undefined && !notes_url) return undefined
  return {
    schema: 1,
    app,
    artifact,
    channel,
    sequence,
    release: {
      version,
      ...(notes_url ? { notes_url } : {}),
      rollout_percent: rollout,
      required: release.required === true,
      targets,
      distributions,
    },
  }
}

/**
 * docs/protocol.md's client rules, the same function as anomalyco/release src/protocol/decide.ts. Every case in the
 * release repo's test-vectors/decisions.json is a test (test/release-vectors.test.ts).
 */
export function decide(input: { readonly app: string; readonly artifact: string; readonly channel: string; readonly manifest: string; readonly install: ReleaseInstall }): ReleaseDecision {
  let manifest: Manifest | undefined
  try {
    manifest = parseManifest(JSON.parse(input.manifest))
  } catch {
    return { action: "reject", reason: "malformed" }
  }
  if (!manifest) return { action: "reject", reason: "malformed" }
  if (manifest.app !== input.app) return { action: "reject", reason: "wrong_app" }
  if (manifest.artifact !== input.artifact) return { action: "reject", reason: "wrong_artifact" }
  if (manifest.channel !== input.channel) return { action: "reject", reason: "wrong_channel" }

  const release = manifest.release
  let candidate = release.version
  let target: Target | undefined
  let distribution: Release["distributions"][number] | undefined
  if (input.install.distribution === "direct") {
    target = release.targets[input.install.target]
    if (!target) return { action: "none", reason: "no_target" }
  } else if (input.install.distribution !== "unknown") {
    distribution = release.distributions.find((item) => item.kind === input.install.distribution)
    if (!distribution) return { action: "none", reason: "distribution_unlisted" }
    if (!distribution.version) return { action: "none", reason: "distribution_pending" }
    candidate = distribution.version
  }

  const running = target && input.install.sha256 !== undefined ? input.install.sha256 === target.sha256 : candidate === input.install.version
  if (running) return { action: "none", reason: "up_to_date" }

  const act = (reason: "update" | "required" | "switch"): ReleaseDecision =>
    target
      ? { action: "install", reason, version: candidate, target }
      : {
          action: "notify",
          reason,
          version: candidate,
          distribution: input.install.distribution,
          ...(distribution?.command ? { command: distribution.command } : {}),
          ...(release.notes_url ? { notes_url: release.notes_url } : {}),
        }

  if (input.install.channel !== undefined && input.install.channel !== input.channel) return act("switch")
  if (release.required) return act("required")
  if (input.install.rolloutBucket < release.rollout_percent) return act("update")
  return { action: "none", reason: "rollout_deferred" }
}

// ---- polling ----------------------------------------------------------------------------------------

export type ManifestResponse =
  | { readonly status: "manifest"; readonly text: string; readonly etag?: string }
  | { readonly status: "unchanged" }
  | { readonly status: "missing" }

/** GET the CLI manifest for a channel, with the protocol's User-Agent and ETag revalidation. */
export async function fetchManifest(options: {
  readonly channel: ReleaseChannel
  readonly version: string
  readonly etag?: string
  readonly service?: string
  readonly fetch?: typeof fetch
}): Promise<ManifestResponse> {
  const service = (options.service ?? releaseService()).replace(/\/+$/, "")
  const response = await (options.fetch ?? fetch)(`${service}/browse/cli/${options.channel}.json`, {
    headers: {
      "user-agent": `browse/${options.channel}/${options.version}/cli`,
      ...(options.etag ? { "if-none-match": options.etag } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 304) return { status: "unchanged" }
  if (response.status === 404) return { status: "missing" }
  if (!response.ok) throw new Error(`the release service answered ${response.status} for browse/cli/${options.channel}`)
  const etag = response.headers.get("etag")
  return { status: "manifest", text: await response.text(), ...(etag ? { etag } : {}) }
}

export type ReleaseCheck =
  | { readonly status: "unchanged" }
  | { readonly status: "missing" }
  | { readonly status: "manifest"; readonly etag?: string; readonly releaseVersion: string; readonly decision: ReleaseDecision }

/** One update check for a binary install: the manifest, then the protocol's decision for it. */
export async function checkRelease(options: {
  readonly version: string
  readonly channel: ReleaseChannel
  readonly target: string
  readonly etag?: string
  readonly service?: string
  readonly fetch?: typeof fetch
  readonly stateDir?: string
}): Promise<ReleaseCheck> {
  const manifest = await fetchManifest({
    channel: options.channel,
    version: options.version,
    ...(options.etag ? { etag: options.etag } : {}),
    ...(options.service ? { service: options.service } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  if (manifest.status !== "manifest") return manifest
  const decision = decide({
    app: "browse",
    artifact: "cli",
    channel: options.channel,
    manifest: manifest.text,
    install: {
      version: options.version,
      target: options.target,
      distribution: "direct",
      rolloutBucket: rolloutBucket(options.stateDir),
    },
  })
  let releaseVersion = options.version
  try {
    releaseVersion = parseManifest(JSON.parse(manifest.text))?.release.version ?? options.version
  } catch {
    // decide() already rejected it as malformed; the running version stands.
  }
  return { status: "manifest", releaseVersion, decision, ...(manifest.etag ? { etag: manifest.etag } : {}) }
}

/** This install's rollout bucket: drawn once, 0–99, kept locally and never sent. */
export function rolloutBucket(root = stateRoot()): number {
  const file = path.join(root, "rollout-bucket")
  try {
    const saved = Number(readFileSync(file, "utf8").trim())
    if (Number.isInteger(saved) && saved >= 0 && saved < 100) return saved
  } catch {
    // No bucket yet (or unreadable): draw one.
  }
  const bucket = crypto.randomInt(100)
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    writeFileSync(file, `${bucket}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
  } catch {
    // An unwritable state root still checks; the bucket just isn't stable across runs.
  }
  return bucket
}
