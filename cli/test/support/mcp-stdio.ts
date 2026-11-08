import { spawn } from "node:child_process"
import path from "node:path"

export type McpReply = { result?: Record<string, unknown>; error?: unknown }

/** The real `browse mcp` server over stdio, with its data under `home`, talking to the relay on `port` when given. */
export function mcpStdio(options: {
  readonly home: string
  readonly port?: number
  readonly command?: readonly string[]
  readonly env?: Record<string, string | undefined>
}) {
  const command = options.command ?? [process.execPath, path.join(import.meta.dir, "..", "..", "src", "main.ts")]
  const child = spawn(command[0]!, [...command.slice(1), "mcp"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: {
      ...process.env,
      HOME: options.home,
      OPENCODE_BROWSER_HOME: options.home,
      ...(options.port ? { OPENCODE_BROWSER_PORT: String(options.port) } : {}),
      OPENCODE_BROWSER_AUTOSTART: "false",
      OPENCODE_BROWSER_UPDATE_CHECK: "0",
      ...options.env,
    },
  })
  const pending = new Map<unknown, (message: McpReply) => void>()
  let buffer = ""
  let id = 0
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      pending.get(message.id)?.(message)
    }
  })
  /** Sends a request; `withId` picks its id (a string id, say) instead of the next number. */
  const request = (method: string, params: Record<string, unknown> = {}, withId: number | string = ++id) =>
    new Promise<McpReply>((resolve) => {
      pending.set(withId, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: withId, method, params }) + "\n")
    })
  return {
    pid: child.pid,
    request,
    notify: (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"),
    close: () => child.kill(),
  }
}
