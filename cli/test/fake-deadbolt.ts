// A fake Deadbolt agent socket for tests: speaks the line-JSON control protocol (status, agent-logins, agent-fill,
// agent-passkey-get) with one paired client, and records every request (tokens included, for assertions).
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

export type FakeLogin = {
  readonly ref: { readonly vault: string; readonly item: string }
  readonly site: string
  readonly title: string
  readonly username?: string
  readonly values: { readonly username?: string; readonly password?: string; readonly totp?: string }
  /** Fields the grant covers; empty: listed but not granted. */
  readonly fields: readonly ("username" | "password" | "totp")[]
  readonly passkeys?: boolean
  readonly signIn?: { readonly provider: string; readonly account?: string }
}

export type FakeDeadbolt = {
  readonly socket: string
  readonly client: { readonly id: string; readonly token: string }
  readonly requests: Array<Record<string, any>>
  locked: boolean
  close(): Promise<void>
}

/** Whether an origin is on a fake login's site: an exact origin, or a host and its subdomains. */
function onSite(origin: string, site: string): boolean {
  if (/^https?:\/\//.test(site)) return new URL(site).origin === origin
  const host = new URL(origin).hostname
  return host === site || host.endsWith(`.${site}`)
}

export async function startFakeDeadbolt(options: { readonly directory: string; readonly logins: readonly FakeLogin[]; readonly protocol?: number }): Promise<FakeDeadbolt> {
  fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  const socket = path.join(options.directory, "agent.sock")
  fs.rmSync(socket, { force: true })
  const client = { id: "c0ffee01", token: "a".repeat(64) }
  const protocol = options.protocol ?? 15
  const state: FakeDeadbolt = { socket, client, requests: [], locked: false, close: async () => {} }
  const reply = (connection: net.Socket, message: Record<string, unknown>) => connection.end(`${JSON.stringify(message)}\n`)
  const ok = (connection: net.Socket, value: Record<string, unknown>) => reply(connection, { type: "ok", reply: value })
  const error = (connection: net.Socket, code: string, message: string, grant?: Record<string, unknown>) => reply(connection, { type: "error", code, message, ...(grant ? { grant } : {}) })
  const server = net.createServer((connection) => {
    let buffer = ""
    connection.setEncoding("utf8")
    connection.on("data", (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, any>
      state.requests.push(request)
      if (request.cmd === "status") return ok(connection, { reply: "status", protocol, version: "0.0.0-fake", unlocked: !state.locked })
      if (request.v !== protocol) return error(connection, "version", `protocol ${request.v} isn't ${protocol}`)
      if (request.client?.id !== client.id || request.client?.token !== client.token) return error(connection, "forbidden", "unknown agent client")
      if (state.locked) return error(connection, "locked", "the store is locked")
      const origin = String(request.origin ?? "")
      const site = options.logins.find((login) => onSite(origin, login.site))?.site
      const logins = options.logins.filter((login) => onSite(origin, login.site))
      if (request.cmd === "agent-logins") {
        return ok(connection, {
          reply: "agent-logins",
          site: site ?? "",
          granted: logins.some((login) => login.fields.length > 0 || login.passkeys),
          logins: logins.map((login) => ({
            ref: login.ref, title: login.title, username: login.username ?? null,
            has_password: Boolean(login.values.password), has_totp: Boolean(login.values.totp), has_passkey: Boolean(login.passkeys),
            ...(login.signIn ? { sign_in: login.signIn } : {}),
            fields: login.fields, passkeys: Boolean(login.passkeys),
          })),
        })
      }
      if (request.cmd === "agent-fill") {
        const login = logins.find((candidate) => candidate.ref.item === request.login?.item)
        if (!login) return error(connection, "domain-mismatch", "the login isn't saved for this site")
        const want = request.want as string[]
        if (!want.every((field) => login.fields.includes(field as never))) return error(connection, "not-granted", "no grant covers this", { site: login.site, login: login.username ?? login.title })
        return ok(connection, { reply: "site-fill", values: Object.fromEntries(want.map((field) => [field, login.values[field as keyof FakeLogin["values"]]])) })
      }
      if (request.cmd === "agent-passkey-get") {
        const login = logins.find((candidate) => candidate.passkeys)
        if (!login) return error(connection, "not-granted", "no passkey grant for this site", { site: site ?? origin, login: null })
        const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: request.challenge, origin, crossOrigin: false })).toString("base64url")
        return ok(connection, {
          reply: "passkey-assertion",
          credential_id: Buffer.from(`cred-${login.ref.item}`).toString("base64url"),
          client_data_json: clientData,
          authenticator_data: Buffer.alloc(37, 1).toString("base64url"),
          signature: Buffer.from("fake-signature").toString("base64url"),
          user_handle: Buffer.from("user-1").toString("base64url"),
          verified: false,
        })
      }
      return error(connection, "failed", `unknown command ${request.cmd}`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, resolve)
  })
  fs.chmodSync(socket, 0o600)
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return state
}
