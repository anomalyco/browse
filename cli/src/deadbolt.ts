/**
 * Deadbolt logins for unattended agent sign-ins.
 *
 * Deadbolt (a local password manager) lets the user grant this relay standing use of a few logins
 * (`deadbolt agents allow <site>`). The relay is Deadbolt's client: it asks for a login's values only right before it
 * types them into a field whose frame origin it read from CDP, and never hands them to execute code, results, logs or
 * HARs (they are redacted like stored site secrets). Passkey assertions are signed by Deadbolt for the origin the relay
 * read from CDP.
 *
 * Pairing: `opencode-browser deadbolt connect` runs `deadbolt agents add-client browse` (the user proves they are there
 * in Deadbolt: Touch ID or the passphrase; Deadbolt refuses AI callers) and stores the client's `{id, token}` in
 * `<data root>/deadbolt-client.json` (0600). Every request carries it; Deadbolt keeps only the token's SHA-256. Any
 * process running as this user that can read the file can use the granted logins: that is the price of unattended use,
 * so keep grants small. Grants are set only by the user, in Deadbolt.
 *
 * Protocol: line-delimited JSON over Deadbolt's control socket, one request per connection: `{v, cmd, client, ...}` ->
 * `{"type":"ok","reply":{...}}` or `{"type":"error","code":"...","message":"..."}`. `v` is the protocol the running
 * agent reports in `status` (answered whatever `v` says), asked once per connection to Deadbolt.
 *
 * Socket path, first that applies:
 *   1. $OPENCODE_BROWSER_DEADBOLT_SOCKET.
 *   2. The path `deadbolt status --json` reported when `deadbolt connect` ran (stored in the client file), or that the
 *      relay asked for once itself when the computed path has no socket.
 *   3. Deadbolt's own rules (crates/client/src/paths.rs): `$XDG_RUNTIME_DIR/deadbolt<suffix>/agent.sock`, else
 *      `/run/user/<uid>/deadbolt<suffix>/agent.sock` when that directory exists and is ours, else
 *      `$TMPDIR/deadbolt<suffix>-<uid>/agent.sock`; `<suffix>` is empty, or `-` and the first 8 hex digits of the
 *      BLAKE3 hash of $DEADBOLT_HOME when it is set.
 */
import { spawn, spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { writeJsonFileAtomically } from "./fs-durability.ts"
import { dataRoot } from "./paths.ts"

export type DeadboltErrorCode =
  /** Deadbolt is locked: agent fills pause until the user unlocks it. */
  | "locked"
  /** No live grant covers this client, site, login and field. */
  | "not_granted"
  /** The client token is unknown or revoked: run `opencode-browser deadbolt connect` again. */
  | "forbidden"
  | "rate_limited"
  /** This install has no Deadbolt client (`opencode-browser deadbolt connect`). */
  | "not_connected"
  /** Deadbolt isn't running or its socket can't be reached. */
  | "unavailable"
  /** The login's URLs aren't on the site of the origin. */
  | "domain_mismatch"
  | "not_found"
  /** Several granted passkeys could answer: the caller names one (`detail.choices`). */
  | "choose_passkey"
  | "failed"

export type DeadboltErrorDetail = { readonly site?: string; readonly login?: string; readonly choices?: readonly DeadboltPasskey[] }

export class DeadboltError extends Error {
  override readonly name = "DeadboltError"
  readonly code: DeadboltErrorCode
  readonly detail: DeadboltErrorDetail
  constructor(code: DeadboltErrorCode, message: string, detail: DeadboltErrorDetail = {}) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

export type DeadboltClient = { readonly id: string; readonly token: string }

/** A login Deadbolt lets this client use on an origin. No values. */
export type DeadboltLogin = {
  /** Opaque reference passed back to agent-fill; never shown to people. */
  readonly ref: unknown
  readonly title: string
  readonly username?: string
  readonly hasPassword: boolean
  readonly hasTotp: boolean
  readonly hasPasskey: boolean
  /** Whether live grants let this client fill any field of it or use its passkey. */
  readonly granted: boolean
  /** Fields live grants let this client fill. */
  readonly fields?: readonly string[]
  /** Whether a live grant lets this client sign in with its passkey. */
  readonly passkeys: boolean
  /** "Sign in with <provider>" logins: the provider id and the account's username or title. */
  readonly signIn?: { readonly provider: string; readonly account?: string }
}

export type DeadboltField = "username" | "password" | "totp"

/** A passkey Deadbolt has for a site: its account, never key material. */
export type DeadboltPasskey = {
  /** Opaque reference passed back to agent-passkey-get; kept in the relay, never shown to the agent. */
  readonly ref: unknown
  readonly username?: string
  readonly displayName?: string
  /** Whether live grants let this client sign in with it. */
  readonly granted: boolean
}

export type DeadboltValues = { readonly username?: string; readonly password?: string; readonly totp?: string }

export type DeadboltAssertion = {
  readonly credentialId: string
  readonly clientDataJson: string
  readonly authenticatorData: string
  readonly signature: string
  readonly userHandle?: string
}

const clientFileName = "deadbolt-client.json"

export function clientFilePath(root = dataRoot()): string {
  return path.join(root, clientFileName)
}

type ClientFile = { readonly version: 1; readonly id: string; readonly token: string; readonly socket?: string; readonly connectedAt: string }

function readClientFile(root = dataRoot()): ClientFile | undefined {
  let text: string
  try {
    const file = clientFilePath(root)
    const stat = fs.statSync(file)
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) fs.chmodSync(file, 0o600)
    text = fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  try {
    const value = JSON.parse(text) as Partial<ClientFile>
    if (typeof value.id !== "string" || !value.id || typeof value.token !== "string" || !value.token) return undefined
    return {
      version: 1,
      id: value.id,
      token: value.token,
      ...(typeof value.socket === "string" && value.socket ? { socket: value.socket } : {}),
      connectedAt: typeof value.connectedAt === "string" ? value.connectedAt : "",
    }
  } catch {
    return undefined
  }
}

/** The paired client, or undefined when this install isn't connected to Deadbolt. */
export function readClient(root = dataRoot()): DeadboltClient | undefined {
  const file = readClientFile(root)
  return file ? { id: file.id, token: file.token } : undefined
}

export async function saveClient(client: DeadboltClient & { readonly socket?: string }, root = dataRoot()): Promise<void> {
  const value: ClientFile = { version: 1, id: client.id, token: client.token, ...(client.socket ? { socket: client.socket } : {}), connectedAt: new Date().toISOString() }
  await writeJsonFileAtomically(clientFilePath(root), value, { dirMode: 0o700 })
}

export function removeClient(root = dataRoot()): boolean {
  const file = clientFilePath(root)
  if (!fs.existsSync(file)) return false
  fs.rmSync(file, { force: true })
  return true
}

// ---- socket path ----------------------------------------------------------------------------------------------

/** Deadbolt's socket path by its own rules (crates/client/src/paths.rs), for this environment. */
export function computedSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const nonEmpty = (name: string) => (env[name] ? env[name] : undefined)
  const deadboltHome = nonEmpty("DEADBOLT_HOME")
  const suffix = deadboltHome ? `-${blake3Hex(Buffer.from(deadboltHome, "utf8")).slice(0, 8)}` : ""
  const uid = typeof process.getuid === "function" ? process.getuid() : 0
  const runtime = nonEmpty("XDG_RUNTIME_DIR") ?? userRuntimeDir(uid)
  const directory = runtime ? path.join(runtime, `deadbolt${suffix}`) : path.join(nonEmpty("TMPDIR") ?? os.tmpdir(), `deadbolt${suffix}-${uid}`)
  return path.join(directory, "agent.sock")
}

function userRuntimeDir(uid: number): string | undefined {
  const directory = `/run/user/${uid}`
  try {
    const stat = fs.statSync(directory)
    return stat.isDirectory() && stat.uid === uid ? directory : undefined
  } catch {
    return undefined
  }
}

/** The socket `deadbolt status --json` reports, when that CLI is installed and says. */
export function askCliForSocket(command = process.env.OPENCODE_BROWSER_DEADBOLT_CLI || "deadbolt"): string | undefined {
  try {
    const result = spawnSync(command, ["status", "--json"], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] })
    if (result.status !== 0 || !result.stdout) return undefined
    const status = JSON.parse(result.stdout) as Record<string, unknown>
    const socket = status.socket ?? (status.paths as Record<string, unknown> | undefined)?.socket
    return typeof socket === "string" && path.isAbsolute(socket) ? socket : undefined
  } catch {
    return undefined
  }
}

let askedCli: { readonly socket: string | undefined } | undefined

/** Where to reach Deadbolt (see the module comment for the order). */
export function socketPath(options: { readonly root?: string; readonly env?: NodeJS.ProcessEnv } = {}): string {
  const env = options.env ?? process.env
  if (env.OPENCODE_BROWSER_DEADBOLT_SOCKET) return env.OPENCODE_BROWSER_DEADBOLT_SOCKET
  const stored = readClientFile(options.root)?.socket
  if (stored && fs.existsSync(stored)) return stored
  const computed = computedSocketPath(env)
  if (fs.existsSync(computed)) return computed
  askedCli ??= { socket: askCliForSocket() }
  return askedCli.socket ?? stored ?? computed
}

// ---- requests -------------------------------------------------------------------------------------------------

const requestTimeoutMs = 15_000
const maxReplyBytes = 4 * 1024 * 1024

function errorCode(code: unknown): DeadboltErrorCode {
  const normalized = typeof code === "string" ? code.replace(/-/g, "_") : ""
  switch (normalized) {
    case "locked":
    case "not_granted":
    case "forbidden":
    case "rate_limited":
    case "domain_mismatch":
    case "not_found":
    case "choose_passkey":
      return normalized
    case "not_initialized":
      return "locked"
    default:
      return "failed"
  }
}

const errorHints: Partial<Record<DeadboltErrorCode, string>> = {
  locked: "Deadbolt is locked, so agent sign-ins are paused until the user unlocks it.",
  forbidden: "Deadbolt doesn't know this Browse install (its client was removed or revoked). Ask the user to run `opencode-browser deadbolt connect`.",
  rate_limited: "Deadbolt is rate-limiting this client; wait before trying again.",
}

/** One request over one connection; resolves with the reply object of the final `ok` message. */
export function rawRequest(socket: string, request: Record<string, unknown>, timeoutMs = requestTimeoutMs): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socket)
    let buffer = ""
    let settled = false
    const finish = (error: Error | undefined, value?: Record<string, unknown>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connection.destroy()
      if (error) reject(error)
      else resolve(value!)
    }
    const timer = setTimeout(() => finish(new DeadboltError("unavailable", `Deadbolt did not answer ${String(request.cmd)} within ${timeoutMs} ms`)), timeoutMs)
    connection.setEncoding("utf8")
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`))
    connection.on("error", (cause: NodeJS.ErrnoException) => {
      const missing = cause.code === "ENOENT" || cause.code === "ECONNREFUSED"
      finish(new DeadboltError("unavailable", missing ? "Deadbolt isn't running (no agent socket). Ask the user to start or unlock Deadbolt." : `Could not reach Deadbolt: ${cause.message}`))
    })
    connection.on("data", (chunk: string) => {
      buffer += chunk
      if (buffer.length > maxReplyBytes) return finish(new DeadboltError("failed", "Deadbolt's reply was too large"))
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line)
        } catch {
          return finish(new DeadboltError("failed", "Deadbolt sent a reply that isn't JSON"))
        }
        if (message.type === "ok") return finish(undefined, (message.reply ?? {}) as Record<string, unknown>)
        if (message.type === "error") {
          const code = errorCode(message.code)
          const text = typeof message.message === "string" ? message.message : String(message.code)
          const detail = (message.grant ?? {}) as Record<string, unknown>
          const choices = passkeyList(message.choices ?? message.passkeys)
          return finish(new DeadboltError(code, errorHints[code] ? `${text.replace(/[\s.]*$/, ".")} ${errorHints[code]}` : text, {
            ...(typeof detail.site === "string" ? { site: detail.site } : {}),
            ...(typeof detail.login === "string" ? { login: detail.login } : {}),
            ...(choices.length > 0 ? { choices } : {}),
          }))
        }
        // Events (pairing only) aren't expected for agent commands; ignore them.
      }
    })
    connection.on("end", () => finish(new DeadboltError("failed", "Deadbolt closed the connection without a reply")))
  })
}

export type DeadboltConnection = {
  readonly socket: string
  readonly client: DeadboltClient
  readonly status: () => Promise<{ readonly protocol: number; readonly unlocked: boolean; readonly version?: string }>
  readonly logins: (origin: string) => Promise<readonly DeadboltLogin[]>
  /** The logins and the passkeys (accounts only) on an origin's site, in one request. */
  readonly site: (origin: string) => Promise<{ readonly logins: readonly DeadboltLogin[]; readonly passkeys: readonly DeadboltPasskey[] }>
  readonly fill: (origin: string, login: DeadboltLogin, want: readonly DeadboltField[]) => Promise<DeadboltValues>
  readonly passkeyGet: (request: {
    readonly origin: string
    readonly rpId?: string
    readonly challenge: string
    readonly allowCredentials: readonly string[]
    readonly userVerification: string
    /** Which passkey (a ref from `site().passkeys`); without one Deadbolt picks, or answers choose_passkey. */
    readonly login?: unknown
  }) => Promise<DeadboltAssertion>
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

/** Passkey accounts from a reply (`passkeys` or `choices`): `{ref, username, display_name, granted?}`. */
function passkeyList(value: unknown): DeadboltPasskey[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object").map((entry) => {
    const username = str(entry.username)
    const displayName = str(entry.display_name) ?? str(entry.displayName)
    return { ref: entry.ref ?? entry.login, ...(username ? { username } : {}), ...(displayName ? { displayName } : {}), granted: entry.granted !== false }
  })
}

function toLogin(raw: Record<string, unknown>): DeadboltLogin {
  const signIn = raw.sign_in as Record<string, unknown> | undefined
  const fields = Array.isArray(raw.fields) ? raw.fields.filter((field): field is string => typeof field === "string") : undefined
  const username = str(raw.username)
  return {
    ref: raw.ref ?? raw.login,
    title: str(raw.title) ?? "",
    ...(username ? { username } : {}),
    hasPassword: raw.has_password === true,
    hasTotp: raw.has_totp === true || raw.has_otp === true,
    hasPasskey: raw.has_passkey === true,
    // What live grants of this client cover: fields to fill, and passkeys.
    granted: (fields !== undefined && fields.length > 0) || raw.passkeys === true,
    passkeys: raw.passkeys === true,
    ...(fields ? { fields } : {}),
    ...(signIn && typeof signIn.provider === "string" ? { signIn: { provider: signIn.provider, ...(str(signIn.account) ? { account: str(signIn.account)! } : {}) } } : {}),
  }
}

/** A connection to Deadbolt as this install's paired client. Throws `not_connected` when there is none. */
export function connect(options: { readonly root?: string; readonly socket?: string; readonly client?: DeadboltClient } = {}): DeadboltConnection {
  const client = options.client ?? readClient(options.root)
  if (!client) {
    throw new DeadboltError("not_connected", "Browse isn't connected to Deadbolt. Ask the user to run `opencode-browser deadbolt connect` and to allow the logins agents may use with `deadbolt agents allow <site>`.")
  }
  const socket = options.socket ?? socketPath(options.root ? { root: options.root } : {})
  let protocol: number | undefined
  const version = async () => {
    if (protocol === undefined) {
      const status = await rawRequest(socket, { v: 0, cmd: "status" })
      protocol = typeof status.protocol === "number" ? status.protocol : 0
    }
    return protocol
  }
  const send = async (cmd: string, fields: Record<string, unknown>) =>
    rawRequest(socket, { v: await version(), cmd, client: { id: client.id, token: client.token }, ...fields })
  const site = async (origin: string) => {
    const reply = await send("agent-logins", { origin })
    const raw = (Array.isArray(reply.logins) ? reply.logins : []).filter((login): login is Record<string, unknown> => login !== null && typeof login === "object")
    const logins = raw.map(toLogin)
    let passkeys = passkeyList(reply.passkeys)
    // Without a passkey list, a login that has a passkey stands for it (its username is the passkey's account).
    if (!Array.isArray(reply.passkeys)) {
      passkeys = logins.filter((login) => login.hasPasskey).map((login) => ({ ref: login.ref, ...(login.username ? { username: login.username } : {}), granted: login.passkeys }))
    }
    return { logins, passkeys }
  }
  return {
    socket,
    client,
    status: async () => {
      const status = await rawRequest(socket, { v: 0, cmd: "status" })
      protocol = typeof status.protocol === "number" ? status.protocol : 0
      return { protocol, unlocked: status.unlocked === true, ...(str(status.version) ? { version: str(status.version)! } : {}) }
    },
    logins: async (origin) => (await site(origin)).logins,
    site: (origin) => site(origin),
    fill: async (origin, login, want) => {
      const reply = await send("agent-fill", { origin, login: login.ref, want: [...want] })
      const values = (reply.values ?? reply) as Record<string, unknown>
      return {
        ...(str(values.username) !== undefined ? { username: str(values.username)! } : {}),
        ...(str(values.password) !== undefined ? { password: str(values.password)! } : {}),
        ...(str(values.totp) !== undefined ? { totp: str(values.totp)! } : {}),
      }
    },
    passkeyGet: async (request) => {
      const reply = await send("agent-passkey-get", {
        origin: request.origin,
        ...(request.rpId ? { rp_id: request.rpId } : {}),
        challenge: request.challenge,
        allow_credentials: [...request.allowCredentials],
        user_verification: request.userVerification,
        ...(request.login !== undefined ? { login: request.login } : {}),
      })
      if (reply.reply === "choose-passkey") {
        throw new DeadboltError("choose_passkey", "Several passkeys could sign in here; name one by its username.", { choices: passkeyList(reply.choices ?? reply.passkeys) })
      }
      const credentialId = str(reply.credential_id)
      const clientDataJson = str(reply.client_data_json)
      const authenticatorData = str(reply.authenticator_data)
      const signature = str(reply.signature)
      if (!credentialId || !clientDataJson || !authenticatorData || !signature) throw new DeadboltError("failed", "Deadbolt's passkey assertion is incomplete")
      return { credentialId, clientDataJson, authenticatorData, signature, ...(str(reply.user_handle) ? { userHandle: str(reply.user_handle)! } : {}) }
    },
  }
}

// ---- names and sites --------------------------------------------------------------------------------------------

export const deadboltNamePrefix = "deadbolt:"

/** `deadbolt:<site>[/<username>]`: the site (a host like `github.com`, or an exact origin) and an optional username. */
export function parseDeadboltName(name: string): { readonly site: string; readonly username?: string } | undefined {
  if (!name.startsWith(deadboltNamePrefix)) return undefined
  const rest = name.slice(deadboltNamePrefix.length).trim()
  const origin = /^https?:\/\/[^/]+/i.exec(rest)
  const site = origin ? origin[0] : rest.split("/")[0]!
  const username = rest.slice(site.length + 1)
  if (!site) return undefined
  return { site: site.toLowerCase(), ...(username ? { username } : {}) }
}

/** Whether an origin is on `site`: the exact origin, or the host or one of its subdomains (https, or http on localhost). */
export function originOnSite(origin: string, site: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (/^https?:\/\//i.test(site)) {
    try {
      return new URL(site).origin === url.origin
    } catch {
      return false
    }
  }
  const host = url.hostname.toLowerCase()
  const bare = site.replace(/^\*\./, "").replace(/:\d+$/, "").toLowerCase()
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return false
  return host === bare || host.endsWith(`.${bare}`)
}

/** Picks the login for a username (case-insensitive), or the only one. */
export function pickLogin(logins: readonly DeadboltLogin[], site: string, username: string | undefined, field?: DeadboltField): DeadboltLogin {
  const granted = logins.filter((login) => login.granted && (field === undefined || login.fields === undefined || login.fields.includes(field)))
  const candidates = username === undefined ? granted : granted.filter((login) => login.username?.toLowerCase() === username.toLowerCase())
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length === 0) {
    throw new DeadboltError("not_granted", username === undefined
      ? `No Deadbolt login is granted to Browse for ${site}${field ? ` (${field})` : ""}. Ask the user to allow one with \`deadbolt agents allow ${site}\`.`
      : `No Deadbolt login for ${username} is granted to Browse for ${site}${field ? ` (${field})` : ""}. Ask the user to allow it with \`deadbolt agents allow ${site} --login ${username}\`.`, { site, ...(username ? { login: username } : {}) })
  }
  throw new DeadboltError("failed", `Several Deadbolt logins are granted for ${site}; name one: deadbolt:${site}/<username> (${candidates.map((login) => login.username ?? login.title).join(", ")})`)
}

// ---- listing ------------------------------------------------------------------------------------------------------

/** Origins to ask Deadbolt about for allowlist patterns: `example.com` and `*.example.com` -> https://example.com. */
export function originsFromPatterns(patterns: readonly string[]): string[] {
  const origins = new Set<string>()
  for (const pattern of patterns) {
    const scheme = /^(https?):\/\//i.exec(pattern)?.[1]?.toLowerCase() ?? "https"
    const host = pattern.replace(/^https?:\/\//i, "").replace(/^\*\./, "").replace(/\/$/, "")
    try {
      origins.add(new URL(`${scheme}://${host}`).origin)
    } catch {}
  }
  return [...origins]
}

export type ListedLogin = Omit<DeadboltLogin, "ref"> & { readonly origin: string }

export type ListedPasskey = Omit<DeadboltPasskey, "ref"> & { readonly origin: string }

export type LoginListing = {
  readonly connected: boolean
  readonly logins: readonly ListedLogin[]
  readonly passkeys: readonly ListedPasskey[]
  readonly error?: { readonly code: DeadboltErrorCode; readonly message: string }
}

/** The logins granted on each origin (metadata only), or why there are none. */
export async function listLogins(origins: readonly string[], connection?: DeadboltConnection): Promise<LoginListing> {
  let deadbolt: DeadboltConnection
  try {
    deadbolt = connection ?? connect()
  } catch (error) {
    return { connected: false, logins: [], passkeys: [], error: { code: error instanceof DeadboltError ? error.code : "failed", message: error instanceof Error ? error.message : String(error) } }
  }
  const logins: ListedLogin[] = []
  const passkeys: ListedPasskey[] = []
  for (const origin of origins.slice(0, 20)) {
    try {
      const found = await deadbolt.site(origin)
      for (const { ref: _ref, ...login } of found.logins) logins.push({ ...login, origin })
      for (const { ref: _ref, ...passkey } of found.passkeys) passkeys.push({ ...passkey, origin })
    } catch (error) {
      if (error instanceof DeadboltError && (error.code === "domain_mismatch" || error.code === "not_found" || error.code === "not_granted")) continue
      return { connected: true, logins, passkeys, error: { code: error instanceof DeadboltError ? error.code : "failed", message: error instanceof Error ? error.message : String(error) } }
    }
  }
  return { connected: true, logins, passkeys }
}

/** The granted passkey for a username (case-insensitive, username or display name), or undefined. */
export function pickPasskey(passkeys: readonly DeadboltPasskey[], username: string): DeadboltPasskey | undefined {
  const wanted = username.toLowerCase()
  const granted = passkeys.filter((passkey) => passkey.granted)
  return granted.find((passkey) => passkey.username?.toLowerCase() === wanted) ?? granted.find((passkey) => passkey.displayName?.toLowerCase() === wanted)
}

// ---- connect / disconnect (CLI) -------------------------------------------------------------------------------

/**
 * Runs `deadbolt agents add-client <name> --json`, which asks the user to prove they are there (Touch ID or the
 * passphrase on this terminal), and stores the client it prints. The prompt goes to the terminal: stdin and stderr are
 * inherited, stdout (the JSON with the token) is read here and never printed.
 */
export async function pair(options: { readonly name?: string; readonly command?: string; readonly root?: string } = {}): Promise<{ readonly id: string; readonly socket?: string }> {
  const command = options.command ?? (process.env.OPENCODE_BROWSER_DEADBOLT_CLI || "deadbolt")
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, ["agents", "add-client", options.name ?? "browse", "--json"], { stdio: ["inherit", "pipe", "inherit"] })
    let output = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { output += chunk })
    child.on("error", (cause: NodeJS.ErrnoException) => reject(new DeadboltError("unavailable", cause.code === "ENOENT" ? `${command} isn't installed or on PATH. Install Deadbolt first.` : `Could not run ${command}: ${cause.message}`)))
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new DeadboltError("failed", `deadbolt agents add-client exited with status ${code}`))))
  })
  let parsed: Record<string, unknown>
  try {
    const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? ""
    parsed = JSON.parse(line)
  } catch {
    throw new DeadboltError("failed", "deadbolt agents add-client --json didn't print a client")
  }
  const client = (parsed.client ?? parsed) as Record<string, unknown>
  const id = str(client.id)
  const token = str(client.token) ?? str(parsed.token)
  if (!id || !token) throw new DeadboltError("failed", "deadbolt agents add-client --json printed no id and token")
  const socket = askCliForSocket(command)
  await saveClient({ id, token, ...(socket ? { socket } : {}) }, options.root)
  return { id, ...(socket ? { socket } : {}) }
}

/** Runs `deadbolt agents remove-client <id>` (best effort) and deletes the stored client. */
export function unpair(options: { readonly command?: string; readonly root?: string } = {}): { readonly removed: boolean; readonly revoked: boolean } {
  const client = readClient(options.root)
  if (!client) return { removed: false, revoked: false }
  const command = options.command ?? (process.env.OPENCODE_BROWSER_DEADBOLT_CLI || "deadbolt")
  const result = spawnSync(command, ["agents", "remove-client", client.id], { stdio: ["inherit", "ignore", "inherit"], timeout: 120_000 })
  return { removed: removeClient(options.root), revoked: result.status === 0 }
}

// ---- base64url --------------------------------------------------------------------------------------------------

export function isBase64Url(value: unknown, maxLength = 8192): value is string {
  return typeof value === "string" && value.length <= maxLength && /^[A-Za-z0-9_-]*$/.test(value)
}

export function randomName(prefix: string): string {
  return `${prefix}${crypto.randomBytes(12).toString("hex")}`
}

// ---- BLAKE3 (single chunk: inputs up to 1024 bytes, enough for a DEADBOLT_HOME path) ------------------------------

const blake3Iv = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
const blake3Permutation = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8]

function blake3Compress(cv: readonly number[], block: Uint32Array, blockLength: number, flags: number): number[] {
  const s = new Uint32Array([...cv, blake3Iv[0]!, blake3Iv[1]!, blake3Iv[2]!, blake3Iv[3]!, 0, 0, blockLength, flags])
  let m = Uint32Array.from(block)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  const g = (a: number, b: number, c: number, d: number, x: number, y: number) => {
    s[a] = s[a]! + s[b]! + x; s[d] = rotr(s[d]! ^ s[a]!, 16)
    s[c] = s[c]! + s[d]!; s[b] = rotr(s[b]! ^ s[c]!, 12)
    s[a] = s[a]! + s[b]! + y; s[d] = rotr(s[d]! ^ s[a]!, 8)
    s[c] = s[c]! + s[d]!; s[b] = rotr(s[b]! ^ s[c]!, 7)
  }
  for (let round = 0; round < 7; round++) {
    g(0, 4, 8, 12, m[0]!, m[1]!); g(1, 5, 9, 13, m[2]!, m[3]!); g(2, 6, 10, 14, m[4]!, m[5]!); g(3, 7, 11, 15, m[6]!, m[7]!)
    g(0, 5, 10, 15, m[8]!, m[9]!); g(1, 6, 11, 12, m[10]!, m[11]!); g(2, 7, 8, 13, m[12]!, m[13]!); g(3, 4, 9, 14, m[14]!, m[15]!)
    if (round < 6) m = Uint32Array.from(blake3Permutation, (index) => m[index]!)
  }
  return Array.from({ length: 8 }, (_, index) => (s[index]! ^ s[index + 8]!) >>> 0)
}

/** BLAKE3-256 of up to 1024 bytes, hex. */
export function blake3Hex(input: Uint8Array): string {
  if (input.length > 1024) throw new Error("blake3Hex handles inputs up to 1024 bytes (DEADBOLT_HOME is longer: set OPENCODE_BROWSER_DEADBOLT_SOCKET)")
  const blocks = Math.max(1, Math.ceil(input.length / 64))
  let cv = [...blake3Iv]
  for (let index = 0; index < blocks; index++) {
    const bytes = new Uint8Array(64)
    const chunk = input.subarray(index * 64, index * 64 + 64)
    bytes.set(chunk)
    const words = new Uint32Array(16)
    const view = new DataView(bytes.buffer)
    for (let word = 0; word < 16; word++) words[word] = view.getUint32(word * 4, true)
    const flags = (index === 0 ? 1 : 0) | (index === blocks - 1 ? 2 | 8 : 0)
    cv = blake3Compress(cv, words, chunk.length, flags)
  }
  const out = Buffer.alloc(32)
  cv.forEach((word, index) => out.writeUInt32LE(word, index * 4))
  return out.toString("hex")
}
