import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// publish-cws.sh against its own loopback fake (CWS_API_BASE/CWS_TOKEN_URL): the store responses that decide whether a
// release skips, submits, or fails. The zip and gh calls are stubbed; nothing leaves the machine.

const repoRoot = path.resolve(import.meta.dir, "..")
const script = path.join(repoRoot, ".github", "release", "publish-cws.sh")
const item = "publishers/pub/items/item"
const api = `/v2/${item}`

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

type Status = Record<string, unknown>
type Scenario = {
  fetchStatus: Status
  publish?: { status?: number; body: unknown }
  upload?: { status?: number; body: unknown }
  cancel?: { status?: number; body?: unknown }
}

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-publish-cws-"))
  tempDirs.push(dir)
  const build = path.join(dir, "build")
  fs.mkdirSync(build)
  fs.writeFileSync(
    path.join(build, "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "browse", version: "0.1.1", description: "test" }),
  )
  const zipped = spawnSync("zip", ["-q", "browse-extension-0.1.1.zip", "manifest.json"], { cwd: build, encoding: "utf8" })
  if (zipped.status !== 0) throw new Error(`zip failed: ${zipped.stderr}`)

  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      'case "$1 $2" in',
      '  "attestation verify") exit 0 ;;',
      '  "release list") exit 0 ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  return { build, bin }
}

async function run(scenario: Scenario) {
  const { build, bin } = workspace()
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}`)
      if (url.pathname === "/token") {
        return Response.json({ access_token: "test-token", expires_in: 3600, token_type: "Bearer" })
      }
      if (url.pathname.endsWith(":fetchStatus")) return Response.json(scenario.fetchStatus)
      if (url.pathname.endsWith(":cancelSubmission")) {
        return Response.json(scenario.cancel?.body ?? {}, { status: scenario.cancel?.status ?? 200 })
      }
      if (url.pathname.includes(":upload")) {
        return Response.json(scenario.upload?.body ?? { uploadState: "SUCCEEDED", crxVersion: "0.1.1" }, {
          status: scenario.upload?.status ?? 200,
        })
      }
      if (url.pathname.endsWith(":publish")) {
        return Response.json(scenario.publish?.body ?? { state: "PENDING_REVIEW" }, {
          status: scenario.publish?.status ?? 200,
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    CWS_API_BASE: `http://127.0.0.1:${server.port}`,
    CWS_TOKEN_URL: `http://127.0.0.1:${server.port}/token`,
    CWS_CLIENT_ID: "client",
    CWS_CLIENT_SECRET: "secret",
    CWS_REFRESH_TOKEN: "refresh",
    CWS_PUBLISHER_ID: "pub",
    CWS_ITEM_ID: "item",
    GITHUB_REPOSITORY: "anomalyco/browse",
    GITHUB_ACTIONS: "",
    GITHUB_STEP_SUMMARY: "",
    BROWSE_VERSION: "0.1.1",
    BROWSE_DRY_RUN: "false",
    CWS_POLL_SECONDS: "0",
  }
  try {
    const proc = Bun.spawn(["bash", script, build], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stdout, stderr, requests }
  } finally {
    server.stop(true)
  }
}

const published = {
  publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "0.1.0", deployPercentage: 100 }] },
}

describe("publish-cws.sh store responses", () => {
  test("prints error details from a publish 400", async () => {
    const result = await run({
      fetchStatus: published,
      publish: {
        status: 400,
        body: {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "Your submission does not meet the requirements to be published in the store. Check the Developer Dashboard",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "PERMISSION_JUSTIFICATION_REQUIRED",
                domain: "chromewebstore.googleapis.com",
              },
            ],
          },
        },
      },
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("details:")
    expect(result.stderr).toContain('"reason":"PERMISSION_JUSTIFICATION_REQUIRED"')
    expect(result.requests).toContain(`POST /upload${api}:upload`)
    expect(result.requests).toContain(`POST ${api}:publish`)
  })

  test("prints the error code when status and message are missing", async () => {
    const result = await run({
      fetchStatus: published,
      publish: { status: 400, body: { error: { code: 400 } } },
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`failed: 400 400`)
  })

  test("skips when this version is already in review", async () => {
    const result = await run({
      fetchStatus: {
        ...published,
        submittedItemRevisionStatus: {
          state: "PENDING_REVIEW",
          distributionChannels: [{ crxVersion: "0.1.1" }],
        },
      },
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("already submitted")
    expect(result.requests).toEqual(["POST /token", `GET ${api}:fetchStatus`])
  })

  test("fails when publish returns a state that is not a submission", async () => {
    const result = await run({ fetchStatus: published, publish: { body: { state: "CANCELLED" } } })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("may not have the submission")
    expect(result.requests).toContain(`POST ${api}:publish`)
  })

  test("fails without uploading when this version was rejected", async () => {
    const result = await run({
      fetchStatus: {
        ...published,
        submittedItemRevisionStatus: {
          state: "REJECTED",
          distributionChannels: [{ crxVersion: "0.1.1" }],
        },
      },
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("was rejected")
    expect(result.stderr).toContain("bump the version")
    expect(result.requests).toEqual(["POST /token", `GET ${api}:fetchStatus`])
  })

  test("warns about a warned item but still submits", async () => {
    const result = await run({ fetchStatus: { ...published, warned: true } })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("::warning::")
    expect(result.stdout).toContain("warned for a policy violation")
    expect(result.requests).toContain(`POST /upload${api}:upload`)
    expect(result.requests).toContain(`POST ${api}:publish`)
  })

  test("keeps the upload version while polling, not the last submission's", async () => {
    const result = await run({
      fetchStatus: {
        ...published,
        lastAsyncUploadState: "SUCCEEDED",
        submittedItemRevisionStatus: {
          state: "PENDING_REVIEW",
          distributionChannels: [{ crxVersion: "0.1.0" }],
        },
      },
      upload: { body: { uploadState: "IN_PROGRESS" } },
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Uploaded 0.1.1")
    expect(result.requests).toContain(`POST ${api}:publish`)
  })
})
