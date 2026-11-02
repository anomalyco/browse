import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { parse as parseToml } from "smol-toml"

export const agentNames = ["claude", "cursor", "codex", "vscode", "windsurf"] as const
export type AgentName = typeof agentNames[number]
export type AgentReceipt = { name: AgentName; file: string; node: string; entry: string }
export type AgentLocation = { name: AgentName; file: string; installed: boolean }

/** Shell markers, not installed binaries or config directories. A plain VS Code terminal isn't its agent. */
export function callingAgent(env: NodeJS.ProcessEnv): AgentName | undefined {
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT) return "claude"
  if (env.CODEX_THREAD_ID) return "codex"
  if (env.CURSOR_AGENT) return "cursor"
  if (env.AI_AGENT === "github_copilot_vscode_agent" || (env.COPILOT_AGENT === "1" && env.TERM_PROGRAM === "vscode")) return "vscode"
  return undefined
}

/** User scope only; never write a project, workspace or managed config. */
export function agentLocations(home: string, config: string, onPath: (name: string) => unknown): AgentLocation[] {
  const at = (...parts: string[]) => path.join(home, ...parts)
  const support = process.platform === "darwin" ? at("Library/Application Support") : process.platform === "win32" ? process.env.APPDATA ?? at("AppData/Roaming") : config
  const app = (name: string) => process.platform === "darwin" && ["/Applications", at("Applications")].some(d => fs.existsSync(path.join(d, name + ".app")))
  const codex = process.env.CODEX_HOME ?? at(".codex")
  const cascade = path.join(process.platform === "win32" ? support : config, "devin/mcp_config.json")
  // Windsurf uses .codeium; its renamed Cascade client moved mcp_config.json to the Devin config directory.
  const windsurf = at(".codeium/windsurf/mcp_config.json")
  const claude = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : at(".claude.json")
  return [
    { name: "claude", file: claude, installed: !!onPath("claude") || fs.existsSync(claude) || fs.existsSync(at(".claude")) },
    { name: "cursor", file: at(".cursor/mcp.json"), installed: !!onPath("cursor") || app("Cursor") || fs.existsSync(at(".cursor")) },
    { name: "codex", file: path.join(codex, "config.toml"), installed: !!onPath("codex") || app("Codex") || fs.existsSync(codex) },
    { name: "vscode", file: path.join(support, "Code/User/mcp.json"), installed: !!onPath("code") || app("Visual Studio Code") || fs.existsSync(path.join(support, "Code/User")) },
    { name: "windsurf", file: fs.existsSync(windsurf) || !fs.existsSync(cascade) ? windsurf : cascade, installed: !!onPath("windsurf") || app("Windsurf") || fs.existsSync(path.dirname(windsurf)) || fs.existsSync(cascade) },
  ]
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const argsFor = (entry: string) => [entry, "mcp"]

/** Preserve unrelated bytes (including JSONC comments and TOML tables). Refuse conflicting names, invalid
 * configs and edits made since install. Only the installer that created an entry gets a removal receipt. */
export function editAgentConfig(receipt: AgentReceipt, remove = false): "added" | "unchanged" | "removed" | "conflict" {
  const { name, file, node, entry } = receipt
  const toml = name === "codex"
  const exists = fs.existsSync(file)
  if (!exists && remove) return "unchanged"
  const before = exists ? fs.readFileSync(file, "utf8") : toml ? "" : "{}"
  const errors: ParseError[] = []
  const config: unknown = toml ? parseToml(before) : parse(before, errors, { allowTrailingComma: true })
  const key = toml ? "mcp_servers" : name === "vscode" ? "servers" : "mcpServers"
  if (errors.length || !object(config) || (config[key] !== undefined && !object(config[key]))) throw new Error(`Invalid ${file}; left unchanged`)
  const servers = (config[key] ?? Object.create(null)) as Record<string, unknown>
  const expected = { ...(name === "claude" || name === "vscode" ? { type: "stdio" } : {}), command: node, args: argsFor(entry) }
  const current = servers.browse
  if (current !== undefined && !isDeepStrictEqual({ ...(object(current) ? current : {}) }, expected)) return "conflict"
  if (remove ? current === undefined : current !== undefined) return "unchanged"
  let after: string
  if (toml) {
    const block = `[mcp_servers.browse]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(expected.args)}\n`
    if (remove && !before.includes(block)) return "conflict"
    after = remove ? before.replace(block, "") : `${before}${before.endsWith("\n") || !before ? "" : "\n"}\n${block}`
    // A matching string could also occur inside a multiline value. Check the *entire* parsed result before writing.
    const result = parseToml(after)
    if (remove) delete servers.browse
    else servers.browse = Object.assign(Object.create(null), expected)
    if (remove && !Object.keys(servers).length && result[key] === undefined) delete config[key]
    else config[key] = servers
    if (!isDeepStrictEqual(result, config)) return "conflict"
  } else {
    after = applyEdits(before, modify(before, [key, "browse"], remove ? undefined : expected, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (exists && fs.readFileSync(file, "utf8") !== before) throw new Error(`${file} changed during setup; try again`)
  fs.writeFileSync(file, after, { mode: 0o600, flag: exists ? "w" : "wx" })
  return remove ? "removed" : "added"
}
