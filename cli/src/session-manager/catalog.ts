import { dataRoot } from "../paths.ts"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { Schema } from "effect"
import { isNodeError, isUnsupportedDirectorySyncError } from "../fs-durability.ts"
import { isValidSessionId } from "../relay/helpers.ts"

const PersistedTarget = Schema.Struct({
  id: Schema.String,
  owner: Schema.Literals(["relay", "user"]),
})

export type PersistedTarget = Schema.Schema.Type<typeof PersistedTarget>

/** Only relay-owned pages are reclaimed after a restart; a user tab is never a held agent target. */
const PersistedRelayTarget = Schema.Struct({
  id: Schema.String,
  owner: Schema.Literal("relay"),
})

export type PersistedRelayTarget = Schema.Schema.Type<typeof PersistedRelayTarget>

export const PersistedSession = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  readOnly: Schema.Boolean,
  allowedOrigins: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Keep the session's own tabs visible to the page between execute calls. */
  keepVisible: Schema.optionalKey(Schema.Boolean),
  browser: Schema.optionalKey(Schema.String),
  browserKey: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(PersistedTarget),
  /**
   * Every relay-owned target the session holds, so a relay that starts after this one reclaims all of them.
   * Older relays ignore it; older catalogs without it still load.
   */
  targets: Schema.optionalKey(Schema.Array(PersistedRelayTarget)),
  /** The process (an MCP server, a CLI) that last used the session, so the relay can tell when it is gone. */
  clientPid: Schema.optionalKey(Schema.Int),
})

export type PersistedSession = Schema.Schema.Type<typeof PersistedSession>

const Catalog = Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Array(PersistedSession),
})

/**
 * Older 0.x relays wrote any target they had into `targets`; only relay-owned entries are valid now. Drop the rest
 * before decoding so one bad entry can never move the whole catalog aside.
 */
function relayOwnedCatalog(input: unknown): { readonly value: unknown; readonly dropped: number } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { value: input, dropped: 0 }
  const catalog = input as Record<string, unknown>
  if (!Array.isArray(catalog.sessions)) return { value: input, dropped: 0 }
  let dropped = 0
  const sessions = catalog.sessions.map((session) => {
    if (session === null || typeof session !== "object" || Array.isArray(session)) return session
    const entry = session as Record<string, unknown>
    if (!Array.isArray(entry.targets)) return session
    const targets = entry.targets.filter((target) => {
      const keep = target !== null && typeof target === "object" && !Array.isArray(target) &&
        (target as Record<string, unknown>).owner === "relay"
      if (!keep) dropped++
      return keep
    })
    return { ...entry, targets }
  })
  return { value: { ...catalog, sessions }, dropped }
}

export function defaultSessionCatalogPath(port: number, home = os.homedir()): string {
  return path.join(dataRoot(home), "relays", String(port), "sessions.json")
}

export class SessionCatalog {
  constructor(readonly filePath: string) {}

  async load(): Promise<readonly PersistedSession[]> {
    let text: string
    try {
      text = await fs.readFile(this.filePath, "utf8")
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return []
      throw new Error(`Could not read browse session catalog at ${this.filePath}`, { cause: error })
    }
    try {
      const sanitized = relayOwnedCatalog(JSON.parse(text))
      const sessions = Schema.decodeUnknownSync(Catalog)(sanitized.value).sessions
      const invalid = sessions.find((session) => !isValidSessionId(session.id))
      if (invalid) throw new Error(`Invalid persisted session id: ${invalid.id}`)
      if (sanitized.dropped > 0) {
        console.error(`Browse session catalog at ${this.filePath} held ${sanitized.dropped} non-relay target(s); dropped them`)
      }
      return sessions
    } catch (error) {
      const detail = error instanceof Error && error.message ? `: ${error.message}` : ""
      // A corrupt catalog must not keep the relay from starting: keep it for inspection and begin empty.
      const corruptPath = `${this.filePath}.corrupt-${Date.now()}`
      try {
        await fs.rename(this.filePath, corruptPath)
        console.error(`Browse session catalog at ${this.filePath} was unreadable${detail}; moved it to ${corruptPath} and started with no saved sessions`)
      } catch (moveError) {
        console.error(`Browse session catalog at ${this.filePath} was unreadable${detail}; could not move it aside (${moveError instanceof Error ? moveError.message : String(moveError)}), starting with no saved sessions`)
      }
      return []
    }
  }

  async save(sessions: readonly PersistedSession[]): Promise<void> {
    const directory = path.dirname(this.filePath)
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    const contents = `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`
    let temporaryFile: fs.FileHandle | undefined
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      await fs.chmod(directory, 0o700)
      temporaryFile = await fs.open(temporaryPath, "wx", 0o600)
      await temporaryFile.writeFile(contents, "utf8")
      await temporaryFile.sync()
      await temporaryFile.close()
      temporaryFile = undefined
      await fs.rename(temporaryPath, this.filePath)
      const directoryHandle = await fs.open(directory, "r")
      try {
        try {
          await directoryHandle.sync()
        } catch (error) {
          if (!isUnsupportedDirectorySyncError(error)) throw error
        }
      } finally {
        await directoryHandle.close()
      }
    } catch (error) {
      try {
        await temporaryFile?.close()
      } catch {}
      try {
        await fs.rm(temporaryPath, { force: true })
      } catch {}
      throw new Error(`Could not write browse session catalog at ${this.filePath}`, { cause: error })
    }
  }
}
