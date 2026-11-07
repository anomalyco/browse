// The release protocol's decision vectors from anomalyco/release test-vectors/ (copied here so CI runs them without the
// private repo; see fixtures/release/README.md). Every case must deep-equal the service's own reference implementation,
// src/protocol/decide.ts.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { decide, type ReleaseDecision } from "../src/update/release-service.ts"

type Case = {
  readonly name: string
  readonly input: {
    readonly app: string
    readonly artifact: string
    readonly channel: string
    readonly manifest: string
    readonly install: {
      readonly version: string
      readonly target: string
      readonly distribution: string
      readonly rollout_bucket: number
      readonly sha256?: string
      readonly channel?: string
    }
  }
  readonly expect: ReleaseDecision
}
type Vectors = { readonly cases: readonly Case[] }
type Manifests = { readonly manifests: Readonly<Record<string, { readonly manifest: string }>> }

const directory = path.join(import.meta.dir, "fixtures/release")
const decisions = JSON.parse(fs.readFileSync(path.join(directory, "decisions.json"), "utf8")) as Vectors
const manifests = JSON.parse(fs.readFileSync(path.join(directory, "manifests.json"), "utf8")) as Manifests

describe("the release protocol's test vectors", () => {
  test("every decision matches the service's reference implementation", () => {
    expect(decisions.cases.length).toBeGreaterThan(20)
    for (const item of decisions.cases) {
      const manifest = manifests.manifests[item.input.manifest]?.manifest
      expect(manifest, item.name).toBeDefined()
      const decision = decide({
        app: item.input.app,
        artifact: item.input.artifact,
        channel: item.input.channel,
        manifest: manifest!,
        install: {
          version: item.input.install.version,
          target: item.input.install.target,
          distribution: item.input.install.distribution,
          rolloutBucket: item.input.install.rollout_bucket,
          ...(item.input.install.sha256 ? { sha256: item.input.install.sha256 } : {}),
          ...(item.input.install.channel ? { channel: item.input.install.channel } : {}),
        },
      })
      expect(decision, item.name).toEqual(item.expect)
    }
  })
})
