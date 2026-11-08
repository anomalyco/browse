import fs from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { parse as parseToml } from "smol-toml"
import { isMap, parseDocument } from "yaml"
import { agentLabels, agentNames, type AgentName } from "./agents.ts"

export { agentLabels, agentNames, type AgentName }
/** What install wrote: `<node> <entry> mcp`, or `<entry> mcp` when there is no node (a binary install's executable). */
export type AgentReceipt = { name: Exclude<AgentName, "opencode">; file: string; node?: string; entry: string }
export type AgentLocation = { name: AgentName; file: string; installed: boolean }

const aliases: Record<string, AgentName> = {
  "claude-code": "claude", "gemini-cli": "gemini", "roo-code": "roo", "kilo-code": "kilo", "kiro-cli": "kiro",
  "factory-droid": "droid", "github-copilot": "copilot", "copilot-cli": "copilot", lmstudio: "lm-studio",
  "kimi-code-cli": "kimi", "hermes-agent": "hermes", "mistral-vibe": "vibe", "antigravity-cli": "antigravity",
}
export function agentName(id: string): AgentName | undefined {
  return agentNames.find(n => n === id) ?? (Object.hasOwn(aliases, id) ? aliases[id] : undefined)
}

/** Shell markers, not installed binaries or config directories. A plain VS Code terminal isn't its agent. */
export function callingAgent(env: NodeJS.ProcessEnv): AgentName | undefined {
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT) return "claude"
  if (env.CODEX_THREAD_ID) return "codex"
  if (env.CURSOR_AGENT) return "cursor"
  if (env.AI_AGENT === "github_copilot_vscode_agent" || (env.COPILOT_AGENT === "1" && env.TERM_PROGRAM === "vscode")) return "vscode"
  if (env.GEMINI_CLI === "1") return "gemini"
  if (env.AMP_CURRENT_THREAD_ID) return "amp"
  if (env.COPILOT_CLI === "1") return "copilot"
  const identified = agentName(env.AI_AGENT?.split("@")[0] ?? "") ?? agentName(env.AGENT ?? "")
  if (identified) return identified
  if (env.OPENCODE === "1" || env.OPENCODE_SESSION_ID) return "opencode"
  return undefined
}

/** User scope only; never write a project, workspace or managed config. */
export function agentLocations(home: string, config: string, onPath: (name: string) => unknown, opencodeConfig: string, opencodeBinary?: string): AgentLocation[] {
  const at = (...parts: string[]) => path.join(home, ...parts)
  const { env, platform } = process
  const support = platform === "darwin" ? at("Library/Application Support") : platform === "win32" ? env.APPDATA ?? at("AppData/Roaming") : config
  const app = (name: string) => process.platform === "darwin" && ["/Applications", at("Applications")].some(d => fs.existsSync(path.join(d, name + ".app")))
  const firstFile = (...files: string[]) => files.find(f => fs.existsSync(f)) ?? files[0]!
  const loc = (name: AgentName, file: string, bin?: string, bundle?: string, dirs = [path.dirname(file)]): AgentLocation => ({
    name, file, installed: !!(bin && onPath(bin)) || !!(bundle && app(bundle)) || fs.existsSync(file) || dirs.some(dir => fs.existsSync(dir)),
  })
  const codeStorage = path.join(support, "Code/User/globalStorage")
  const cline = env.CLINE_DIR ?? at(".cline")
  const clineSettings = path.join(env.CLINE_DATA_DIR ?? path.join(cline, "data"), "settings/cline_mcp_settings.json")
  const clineExtension = path.join(codeStorage, "saoudrizwan.claude-dev")
  const roo = path.join(codeStorage, "rooveterinaryinc.roo-cline")
  const zed = platform === "win32" ? path.join(support, "Zed") : platform === "darwin" ? at(".config/zed") : path.join(env.FLATPAK_XDG_CONFIG_HOME ?? config, "zed")
  const goose = env.GOOSE_PATH_ROOT && path.isAbsolute(env.GOOSE_PATH_ROOT) ? path.join(env.GOOSE_PATH_ROOT, "config") : platform === "win32" ? path.join(support, "Block/goose/config") : path.join(config, "goose")
  const codex = env.CODEX_HOME ?? at(".codex")
  const cascade = path.join(process.platform === "win32" ? support : config, "devin/mcp_config.json")
  // Windsurf uses .codeium; its renamed Cascade client moved mcp_config.json to the Devin config directory.
  const windsurf = at(".codeium/windsurf/mcp_config.json")
  const claude = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : at(".claude.json")
  return [
    { name: "opencode", file: opencodeConfig, installed: !!opencodeBinary || app("OpenCode") || fs.existsSync(path.join(config, "opencode")) },
    { name: "claude", file: claude, installed: !!onPath("claude") || fs.existsSync(claude) || fs.existsSync(at(".claude")) },
    { name: "cursor", file: at(".cursor/mcp.json"), installed: !!onPath("cursor") || app("Cursor") || fs.existsSync(at(".cursor")) },
    { name: "codex", file: path.join(codex, "config.toml"), installed: !!onPath("codex") || app("Codex") || fs.existsSync(codex) },
    { name: "vscode", file: path.join(support, "Code/User/mcp.json"), installed: !!onPath("code") || app("Visual Studio Code") || fs.existsSync(path.join(support, "Code/User")) },
    { name: "windsurf", file: fs.existsSync(windsurf) || !fs.existsSync(cascade) ? windsurf : cascade, installed: !!onPath("windsurf") || app("Windsurf") || fs.existsSync(path.dirname(windsurf)) || fs.existsSync(cascade) },
    loc("claude-desktop", path.join(support, "Claude/claude_desktop_config.json"), "claude-desktop", "Claude"),
    loc("gemini", path.join(env.GEMINI_CLI_HOME ?? home, ".gemini/settings.json"), "gemini"),
    loc("zed", path.join(zed, "settings.json"), "zed", "Zed"),
    loc("cline", env.CLINE_MCP_SETTINGS_PATH ?? firstFile(clineSettings, path.join(clineExtension, "settings/cline_mcp_settings.json")), "cline", undefined, [cline, clineExtension]),
    loc("roo", path.join(roo, "settings/mcp_settings.json"), undefined, undefined, [roo, at(".roo")]),
    loc("kilo", firstFile(...["kilo.json", "kilo.jsonc", "config.json"].map(f => path.join(config, "kilo", f))), "kilo"),
    loc("goose", path.join(goose, "config.yaml"), "goose", "Goose"),
    loc("amp", firstFile(at(".config/amp/settings.json"), at(".config/amp/settings.jsonc")), "amp"),
    loc("kiro", at(".kiro/settings/mcp.json"), "kiro-cli", "Kiro", [at(".kiro")]),
    loc("droid", at(".factory/mcp.json"), "droid"),
    loc("copilot", path.join(env.COPILOT_HOME ?? at(".copilot"), "mcp-config.json"), "copilot"),
    loc("warp", at(".warp/.mcp.json"), "warp", "Warp", [at(".warp"), path.join(config, "warp-terminal"), ...(platform === "win32" ? [path.join(support, "warp/Warp")] : [])]),
    loc("lm-studio", at(".lmstudio/mcp.json"), "lms", "LM Studio"),
    loc("qwen-code", at(".qwen/settings.json"), "qwen"),
    loc("kimi", path.join(env.KIMI_SHARE_DIR ?? at(".kimi"), "mcp.json"), "kimi"),
    loc("augment", at(".augment/settings.json"), "auggie"),
    loc("antigravity", at(".gemini/config/mcp_config.json"), "agy", "Antigravity", [at(".gemini/antigravity"), at(".gemini/antigravity-cli")]),
    loc("junie", at(".junie/mcp/mcp.json"), "junie", undefined, [at(".junie")]),
    loc("codebuddy", firstFile(at(".codebuddy/.mcp.json"), at(".codebuddy/mcp.json")), "codebuddy"),
    loc("cortex", at(".snowflake/cortex/mcp.json"), "cortex"),
    loc("hermes", path.join(env.HERMES_HOME ?? at(".hermes"), "config.yaml"), "hermes"),
    loc("grok", path.join(env.GROK_HOME ?? at(".grok"), "config.toml"), "grok"),
    loc("vibe", path.join(env.VIBE_HOME ?? at(".vibe"), "config.toml"), "vibe"),
    loc("qoder", at(".qoder/settings.json"), "qoder", "Qoder"),
  ]
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
type EditResult = "added" | "unchanged" | "removed" | "conflict"
/** Parse YAML without rounding integers beyond 2^53: install only adds its entry. */
const yamlOptions = { merge: true, intAsBigInt: true } as const

/** The command array of the browse server in an agent config, if it has one (for migration). */
export function browseServerCommand(name: AgentName, file: string): string[] | undefined {
  if (!fs.existsSync(file)) return undefined
  const before = fs.readFileSync(file, "utf8")
  const toml = name === "codex" || name === "grok" || name === "vibe"
  const yaml = name === "goose" || name === "hermes"
  try {
    let current: unknown
    if (yaml) {
      const config = parseDocument(before, yamlOptions).toJS() as Record<string, unknown>
      const key = name === "goose" ? "extensions" : "mcp_servers"
      current = object(config[key]) ? (config[key] as Record<string, unknown>).browse : undefined
    } else if (toml) {
      const config = parseToml(before) as Record<string, unknown>
      if (name === "vibe") {
        const list = Array.isArray(config.mcp_servers) ? config.mcp_servers : []
        current = list.find((entry) => object(entry) && entry.name === "browse")
      } else current = object(config.mcp_servers) ? (config.mcp_servers as Record<string, unknown>).browse : undefined
    } else {
      const config = parse(before, [], { allowTrailingComma: true }) as Record<string, unknown>
      if (name === "opencode") {
        const mcp = object(config.mcp) ? config.mcp : undefined
        const servers = mcp && object(mcp.servers) ? mcp.servers : undefined
        current = servers?.browse
      } else {
        const key = serverKeys[name] ?? "mcpServers"
        const container = config[key]
        current = Array.isArray(container)
          ? container.find((entry) => object(entry) && entry.name === "browse")
          : object(container) ? container.browse : undefined
      }
    }
    if (!object(current)) return undefined
    const command = current.command ?? current.cmd
    const args = Array.isArray(current.args) ? current.args.filter((arg): arg is string => typeof arg === "string") : []
    if (Array.isArray(command)) return command.filter((part): part is string => typeof part === "string")
    return typeof command === "string" ? [command, ...args] : undefined
  } catch {
    return undefined
  }
}

function serverDefinition(name: AgentReceipt["name"], command: string, args: string[]) {
  if (name === "kilo") return { type: "local", command: [command, ...args] }
  if (name === "goose") return { type: "stdio", name: "browse", enabled: true, cmd: command, args }
  if (name === "copilot") return { type: "local", command, args, tools: ["*"] }
  if (name === "vibe") return { name: "browse", transport: "stdio", command, args }
  if (["claude", "vscode", "cortex", "droid", "codebuddy"].includes(name)) return { type: "stdio", command, args }
  return { command, args }
}

const serverKeys: Partial<Record<AgentName, string>> = { vscode: "servers", zed: "context_servers", kilo: "mcp", amp: "amp.mcpServers", goose: "extensions", hermes: "mcp_servers" }

/** Preserve unrelated settings and comments. Refuse conflicting names, invalid
 * configs and edits made since install. Only the installer that created an entry gets a removal receipt. */
export function editAgentConfig(receipt: AgentReceipt, remove = false): EditResult {
  const { name, file, node, entry } = receipt
  const toml = name === "codex" || name === "grok" || name === "vibe"
  const yaml = name === "goose" || name === "hermes"
  const exists = fs.existsSync(file)
  if (!exists && remove) return "unchanged"
  const before = exists ? fs.readFileSync(file, "utf8") : toml ? "" : "{}"
  const errors: ParseError[] = []
  // Edit the YAML document, not a serialized JS object: retain comments, anchors and other extensions.
  const doc = yaml ? parseDocument(before, yamlOptions) : undefined
  const config: unknown = doc ? doc.toJS() : toml ? parseToml(before) : parse(before, errors, { allowTrailingComma: true })
  const key = toml ? "mcp_servers" : serverKeys[name] ?? "mcpServers"
  const invalid = () => new Error(`Invalid ${file}; left unchanged`)
  if (errors.length || doc?.errors.length || doc?.warnings.length || !object(config)) throw invalid()
  const container = config[key]
  if (container !== undefined && !(name === "vibe" ? Array.isArray(container) : object(container))) throw invalid()
  const list = Array.isArray(container) ? container : []
  const matches = list.filter(s => s?.name === "browse")
  if (matches.length > 1) return "conflict"
  const servers = (container ?? Object.create(null)) as Record<string, unknown>
  const [command, args] = node ? [node, [entry, "mcp"]] : [entry, ["mcp"]]
  const expected = serverDefinition(name, command, args)
  const current = name === "vibe" ? matches[0] : servers.browse
  if (current !== undefined && !isDeepStrictEqual({ ...(object(current) ? current : {}) }, expected)) return "conflict"
  if (remove ? current === undefined : current !== undefined) return "unchanged"
  let after: string
  if (toml) {
    const header = name === "vibe" ? '[[mcp_servers]]\nname = "browse"\ntransport = "stdio"' : "[mcp_servers.browse]"
    const block = `${header}\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`
    if (remove && !before.includes(block)) return "conflict"
    after = remove ? before.replace(block, "") : `${before}${before.endsWith("\n") || !before ? "" : "\n"}\n${block}`
    // A matching string could also occur inside a multiline value. Check the *entire* parsed result before writing.
    const result = parseToml(after)
    if (name === "vibe") config[key] = remove ? list.filter(s => s !== current) : [...list, Object.assign(Object.create(null), expected)]
    else if (remove) delete servers.browse
    else servers.browse = Object.assign(Object.create(null), expected)
    if (name !== "vibe") config[key] = servers
    if (remove && !Object.keys(config[key] as object).length && result[key] === undefined) delete config[key]
    if (!isDeepStrictEqual(result, config)) return "conflict"
  } else if (doc) {
    if (!isMap(doc.contents) || (container !== undefined && !isMap(doc.get(key, true)))) throw invalid()
    if (remove) doc.deleteIn([key, "browse"])
    else doc.setIn([key, "browse"], expected)
    after = doc.toString({ lineWidth: 0 }) // Keep long strings on one line.
    // Shared YAML anchors can make a single edit visible elsewhere. Refuse rather than change another entry.
    config[key] = { ...servers }
    if (remove) delete (config[key] as Record<string, unknown>).browse
    else (config[key] as Record<string, unknown>).browse = expected
    if (!isDeepStrictEqual(parseDocument(after, yamlOptions).toJS(), config)) return "conflict"
  } else {
    after = applyEdits(before, modify(before, [key, "browse"], remove ? undefined : expected, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (exists && fs.readFileSync(file, "utf8") !== before) throw new Error(`${file} changed during setup; try again`)
  // Write beside the target and rename: a crash never leaves a half-written agent config, and the existing file's mode
  // stays as it was (0600 for a new one).
  const mode = exists ? fs.statSync(file).mode & 0o777 : 0o600
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporary, after, { mode, flag: "wx" })
    fs.chmodSync(temporary, mode)
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  return remove ? "removed" : "added"
}
