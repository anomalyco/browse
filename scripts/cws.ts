// Uploads and publishes the store zip with the Chrome Web Store API (v2), for the release workflow's publish-cws job:
//   bun scripts/cws.ts publish --zip release/opencode-browser-0.1.0.zip --version 0.1.0 [--dry-run]
//   bun scripts/cws.ts status
// Environment: CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN (the chrome-web-store environment's secrets),
// CWS_PUBLISHER_ID and CWS_ITEM_ID (repository variables; the beta job passes the beta item's ID).
// Idempotent: when the item already has this version (published or in review), nothing is uploaded again; it reports
// the state. Publishing uses the item's visibility in the dashboard (public for stable, unlisted for the beta item) and
// submits for review; the job ends with the review state, it doesn't wait for review.
// CWS_API_BASE and CWS_TOKEN_URL point it at a local fake for testing; they only accept loopback http URLs, so a changed
// variable can't send the credentials anywhere else.
import { $ } from "bun"
import { appendFile, readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { manifestVersionFields } from "./version.ts"

const API_BASE = "https://chromewebstore.googleapis.com"
const TOKEN_URL = "https://oauth2.googleapis.com/token"

function endpoint(name: string, fallback: string) {
  const value = process.env[name]
  if (!value) return fallback
  const url = new URL(value)
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error(`${name} may only point at a loopback http server (a local fake); got ${url.origin}`)
  return value.replace(/\/$/, "")
}

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  return value
}

type Status = {
  itemId?: string
  publishedItemRevisionStatus?: { state?: string; distributionChannels?: { crxVersion?: string; deployPercentage?: number }[] }
  submittedItemRevisionStatus?: { state?: string; distributionChannels?: { crxVersion?: string }[] }
  lastAsyncUploadState?: string
  takenDown?: boolean
  warned?: boolean
}

export function createClient(options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {}) {
  const request = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? ((line: string) => console.log(line))
  const api = endpoint("CWS_API_BASE", API_BASE)
  const tokenUrl = endpoint("CWS_TOKEN_URL", TOKEN_URL)
  const item = `publishers/${encodeURIComponent(required("CWS_PUBLISHER_ID"))}/items/${encodeURIComponent(required("CWS_ITEM_ID"))}`
  let token: string | undefined

  async function accessToken() {
    if (token) return token
    const response = await request(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: required("CWS_CLIENT_ID"),
        client_secret: required("CWS_CLIENT_SECRET"),
        refresh_token: required("CWS_REFRESH_TOKEN"),
        grant_type: "refresh_token",
      }),
    })
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string }
    if (!response.ok || !body.access_token)
      throw new Error(`Couldn't get an access token (${response.status} ${body.error ?? ""}${body.error_description ? `: ${body.error_description}` : ""}). Check the CWS_* secrets; RELEASING.md says how to make a new refresh token.`)
    token = body.access_token
    if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${token}`)
    return token
  }

  async function call<T>(method: string, url: string, init: { body?: BodyInit; contentType?: string } = {}): Promise<T> {
    const response = await request(url, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, ...(init.contentType ? { "content-type": init.contentType } : {}) },
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    const text = await response.text()
    const body = (() => {
      try {
        return JSON.parse(text) as Record<string, unknown>
      } catch {
        return { raw: text.slice(0, 500) }
      }
    })()
    if (!response.ok) {
      const error = body.error as { message?: string; status?: string } | undefined
      throw new Error(`${method} ${url.replace(api, "")} failed: ${response.status} ${error?.status ?? ""} ${error?.message ?? JSON.stringify(body).slice(0, 500)}`)
    }
    return body as T
  }

  const status = () => call<Status>("GET", `${api}/v2/${item}:fetchStatus`)

  return {
    item,
    status,
    async upload(zip: Uint8Array, expected: string) {
      const result = await call<{ uploadState?: string; crxVersion?: string }>("POST", `${api}/upload/v2/${item}:upload`, {
        body: zip,
        contentType: "application/zip",
      })
      let state = result.uploadState
      let version = result.crxVersion
      // Large packages finish processing asynchronously; poll for up to five minutes.
      for (let attempt = 0; state === "IN_PROGRESS" && attempt < 60; attempt++) {
        await sleep(5_000)
        const current = await status()
        state = current.lastAsyncUploadState
        version = current.submittedItemRevisionStatus?.distributionChannels?.[0]?.crxVersion ?? version
      }
      if (state !== "SUCCEEDED") throw new Error(`Upload ended in state ${state ?? "unknown"}; see the developer dashboard for the reason.`)
      if (version && version !== expected) throw new Error(`The store read version ${version} from the upload, expected ${expected}.`)
      log(`✓ Uploaded ${expected}`)
    },
    async publish() {
      const result = await call<{ state?: string; warningInfo?: { warnings?: { reason?: string; description?: string }[] } }>(
        "POST",
        `${api}/v2/${item}:publish`,
        { body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" }), contentType: "application/json" },
      )
      for (const warning of result.warningInfo?.warnings ?? []) log(`! ${warning.reason ?? "warning"}: ${warning.description ?? ""}`)
      return result.state ?? "unknown"
    },
  }
}

/** The version the store already has for this item (published or submitted), when it's the one being released. */
export function existingVersion(status: Status, expected: string) {
  const published = status.publishedItemRevisionStatus?.distributionChannels?.map((channel) => channel.crxVersion) ?? []
  const submitted = status.submittedItemRevisionStatus?.distributionChannels?.map((channel) => channel.crxVersion) ?? []
  if (published.includes(expected)) return { where: "published", state: status.publishedItemRevisionStatus?.state ?? "PUBLISHED" }
  if (submitted.includes(expected)) return { where: "submitted", state: status.submittedItemRevisionStatus?.state ?? "PENDING_REVIEW" }
  return undefined
}

async function summary(lines: string[]) {
  for (const line of lines) console.log(line)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n")
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { zip: { type: "string" }, version: { type: "string" }, "dry-run": { type: "boolean" } },
  })
  const command = positionals[0]
  try {
    const client = createClient()
    if (command === "status") {
      console.log(JSON.stringify(await client.status(), null, 2))
    } else if (command === "publish" && values.zip && values.version) {
      const expected = manifestVersionFields(values.version).version
      const zip = new Uint8Array(await readFile(values.zip))
      // Never upload a zip whose manifest isn't the version being released.
      const packaged = JSON.parse(await $`unzip -p ${values.zip} manifest.json`.quiet().text()).version
      if (packaged !== expected) throw new Error(`${values.zip} has manifest version ${packaged}, not ${expected}.`)
      const before = await client.status()
      if (before.takenDown) throw new Error(`Item ${client.item} is taken down for a policy violation; resolve it in the developer dashboard first.`)
      const existing = existingVersion(before, expected)
      if (existing) {
        await summary([`### Chrome Web Store`, `${values.version} (${expected}) is already ${existing.where} on ${client.item}: ${existing.state}. Nothing uploaded.`])
      } else if (values["dry-run"]) {
        await summary([`### Chrome Web Store (dry run)`, `Would upload ${values.zip} (${expected}) to ${client.item} and publish it; the store has ${before.publishedItemRevisionStatus?.distributionChannels?.[0]?.crxVersion ?? "no published version"}.`])
      } else {
        await client.upload(zip, expected)
        const state = await client.publish()
        await summary([
          `### Chrome Web Store`,
          `Submitted ${values.version} (${expected}) on ${client.item}: ${state}.`,
          state === "PENDING_REVIEW" ? "It goes live when review passes (usually within a few days); follow it in the developer dashboard." : "",
        ].filter(Boolean))
      }
    } else {
      console.error("usage: bun scripts/cws.ts publish --zip <file> --version <version> [--dry-run] | status")
      process.exit(2)
    }
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`)
    process.exit(1)
  }
}
