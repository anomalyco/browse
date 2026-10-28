// Gets the Chrome Web Store API refresh token the release workflow uses, once, on your own computer:
//   bun scripts/cws-auth.ts                 prints the refresh token once
//   bun scripts/cws-auth.ts --set-secret    stores it straight into GitHub (gh secret set CWS_REFRESH_TOKEN
//                                           --env chrome-web-store), so it never shows on screen
// It asks for the OAuth client's ID and secret (or reads CWS_CLIENT_ID / CWS_CLIENT_SECRET), opens Google's consent page
// in your browser with PKCE, receives the code on a one-time 127.0.0.1 redirect, and exchanges it. Nothing is written to
// disk. Sign in as the Google account that owns (or is a member of) the Chrome Web Store publisher.
// The OAuth client must be a "Desktop app" client, which allows loopback redirects (RELEASING.md).
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createInterface } from "node:readline"
import { parseArgs } from "node:util"

const SCOPE = "https://www.googleapis.com/auth/chromewebstore"
const REPO = "anomalyco/browse"

function loopbackOverride(name: string, fallback: string) {
  const value = process.env[name]
  if (!value) return fallback
  const url = new URL(value)
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error(`${name} may only point at a loopback http server`)
  return value
}
const AUTH_URL = loopbackOverride("CWS_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth")
const TOKEN_URL = loopbackOverride("CWS_TOKEN_URL", "https://oauth2.googleapis.com/token")

const base64url = (bytes: Buffer) => bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** Reads a line from the terminal; a secret is read without echoing it. */
function ask(question: string, secret = false): Promise<string> {
  return new Promise((resolve) => {
    const output = process.stderr
    const prompt = createInterface({ input: process.stdin, output, terminal: true })
    if (secret) {
      const write = output.write.bind(output)
      ;(prompt as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => {
        if (text.includes(question)) write(text)
      }
    }
    prompt.question(question, (answer) => {
      prompt.close()
      if (secret) output.write("\n")
      resolve(answer.trim())
    })
  })
}

function openBrowser(url: string) {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]]
  const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true })
  child.on("error", () => {})
  child.unref()
}

async function main() {
  const { values } = parseArgs({ options: { "set-secret": { type: "boolean" }, "no-open": { type: "boolean" }, repo: { type: "string" } } })
  const clientId = process.env.CWS_CLIENT_ID?.trim() || (await ask("OAuth client ID: "))
  const clientSecret = process.env.CWS_CLIENT_SECRET?.trim() || (await ask("OAuth client secret (hidden): ", true))
  if (!clientId || !clientSecret) throw new Error("Both the client ID and secret are needed.")

  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash("sha256").update(verifier).digest())
  const state = base64url(randomBytes(16))

  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const code = new Promise<string>((resolve, reject) => {
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", redirect)
      if (url.pathname !== "/") return void response.writeHead(404).end()
      const done = (status: number, message: string) => response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message)
      if (url.searchParams.get("state") !== state) return done(400, "State mismatch; start again.")
      const error = url.searchParams.get("error")
      if (error) {
        done(400, `Google returned ${error}. You can close this tab.`)
        return reject(new Error(`Authorization failed: ${error}`))
      }
      const value = url.searchParams.get("code")
      if (!value) return done(400, "No code in the redirect.")
      done(200, "Authorized. You can close this tab and go back to the terminal.")
      resolve(value)
    })
  })

  const consent = `${AUTH_URL}?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })}`
  console.error("Open this page and allow access (opening it in your browser):")
  console.error(`  ${consent}`)
  if (!values["no-open"]) openBrowser(consent)

  const timeout = setTimeout(() => {
    console.error("✗ Timed out after 5 minutes waiting for the redirect.")
    process.exit(1)
  }, 5 * 60_000)
  const authorization = await code.finally(() => {
    clearTimeout(timeout)
    server.close()
  })

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: authorization,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirect,
    }),
  })
  const body = (await response.json().catch(() => ({}))) as { refresh_token?: string; scope?: string; error?: string; error_description?: string }
  if (!response.ok || !body.refresh_token)
    throw new Error(`Token exchange failed: ${response.status} ${body.error ?? ""} ${body.error_description ?? ""}${response.ok ? " (no refresh token; revoke the app's access at https://myaccount.google.com/permissions and run this again)" : ""}`)
  if (body.scope && !body.scope.split(" ").includes(SCOPE)) throw new Error(`The token doesn't carry the ${SCOPE} scope.`)

  if (values["set-secret"]) {
    const repo = values.repo ?? REPO
    const result = spawnSync("gh", ["secret", "set", "CWS_REFRESH_TOKEN", "--env", "chrome-web-store", "--repo", repo], {
      input: body.refresh_token,
      stdio: ["pipe", "inherit", "inherit"],
    })
    if (result.status !== 0) throw new Error("gh secret set failed (is gh installed and signed in with admin access to the repo?). Run without --set-secret to print the token instead.")
    console.error(`✓ Stored CWS_REFRESH_TOKEN in the chrome-web-store environment of ${repo}.`)
  } else {
    console.error("Refresh token (shown once; store it as the CWS_REFRESH_TOKEN secret of the chrome-web-store environment, then clear your terminal):")
    process.stdout.write(`${body.refresh_token}\n`)
  }
}

main().catch((error) => {
  console.error(`✗ ${(error as Error).message}`)
  process.exit(1)
})
