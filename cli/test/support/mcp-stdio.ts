import { spawn } from "node:child_process"
import path from "node:path"

export type McpReply = { result?: Record<string, unknown>; error?: unknown }

/** The real `browse mcp` server over stdio, with its data under `home`, talking to the relay on `port` when given. */
export function mcpStdio(options: { readonly home: string; readonly port?: number; readonly command?: readonly string[] }) {
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
    },
  })
  const pending = new Map<number, (message: McpReply) => void>()
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
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<McpReply>((resolve) => {
      pending.set(++id, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  return { request, notify: (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"), close: () => child.kill() }
}
