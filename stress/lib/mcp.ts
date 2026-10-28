// A minimal MCP client over stdio (newline-delimited JSON-RPC), the way opencode talks to `cli.mjs mcp`.
import { spawn, type ChildProcess } from "node:child_process"
import { cli } from "./env.ts"

export type ToolResult = { isError: boolean; text: string; data: any; images: number }

export class McpClient {
  private child: ChildProcess
  private nextId = 1
  private buffer = ""
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  stderr = ""
  exited: number | null | undefined = undefined

  constructor(command: string[] = [process.execPath, cli, "mcp"], env: NodeJS.ProcessEnv = {}) {
    this.child = spawn(command[0]!, command.slice(1), {
      env: { ...process.env, OPENCODE_BROWSER_UPDATE_CHECK: "0", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child.stdout!.setEncoding("utf8")
    this.child.stdout!.on("data", (chunk: string) => this.onData(chunk))
    this.child.stderr!.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-8000) })
    this.child.on("exit", (code) => {
      this.exited = code
      for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new Error(`MCP server exited (${code}): ${this.stderr.slice(-500)}`)) }
      this.pending.clear()
    })
    this.child.stdin!.on("error", () => undefined)
  }

  get pid() { return this.child.pid }

  private onData(chunk: string) {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: any
      try { message = JSON.parse(line) } catch { continue }
      if (typeof message.id !== "number") continue
      const entry = this.pending.get(message.id)
      if (!entry) continue
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(`JSON-RPC ${message.error.code}: ${message.error.message}`))
      else entry.resolve(message.result)
    }
  }

  request(method: string, params: unknown = {}, timeoutMs = 60_000): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (this.exited !== undefined) return reject(new Error(`MCP server exited (${this.exited})`))
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }

  notify(method: string, params: unknown = {}) {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  /** Writes a raw line (the fuzzer uses it for malformed JSON-RPC). */
  raw(line: string) { this.child.stdin!.write(line.endsWith("\n") ? line : `${line}\n`) }

  async initialize(): Promise<any> {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "browse-stress", version: "0.0.0" },
    }, 30_000)
    this.notify("notifications/initialized")
    return result
  }

  async call(name: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<ToolResult> {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs)
    const content: any[] = Array.isArray(result?.content) ? result.content : []
    const text = content.filter((item) => item.type === "text").map((item) => item.text).join("\n")
    return { isError: result?.isError === true, text, data: result?.structuredContent, images: content.filter((item) => item.type === "image").length }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.exited !== undefined) return resolve()
      const timer = setTimeout(() => { this.child.kill("SIGKILL"); resolve() }, 3000)
      this.child.once("exit", () => { clearTimeout(timer); resolve() })
      this.child.stdin!.end()
      this.child.kill("SIGTERM")
    })
  }
}

/** Runs one execute and returns its value, throwing with the relay's message when it fails. */
export async function exec(client: McpClient, session: string, code: string, timeoutMs = 90_000): Promise<any> {
  const result = await client.call("execute", { session, code }, timeoutMs)
  if (result.isError) throw new Error(`execute failed: ${result.text.slice(0, 600)}`)
  return result.data?.value
}
