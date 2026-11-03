import { Prompt, isCancel } from "@clack/core"
import { agentLabels, agentName, agentNames, type AgentLocation, type AgentName } from "./agent-config.ts"

export function agentFlags(args: string[]) {
  const requested = new Set<AgentName>()
  let all = args.includes("--all-agents")
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-a" && args[i] !== "--agent") continue
    if (!args[i + 1] || args[i + 1]!.startsWith("-")) throw new Error(`${args[i]} needs at least one agent name (or '*').`)
    while (args[i + 1] && !args[i + 1]!.startsWith("-")) {
      const arg = args[++i]!
      if (arg === "*") { all = true; continue }
      const name = agentName(arg)
      if (!name) throw new Error(`Unknown agent ${JSON.stringify(arg)}. Choose ${agentNames.join(", ")}.`)
      requested.add(name)
    }
  }
  return { requested: all ? [...agentNames] : [...requested], yes: args.includes("--yes") || args.includes("-y") }
}

export function agentPlan(locations: AgentLocation[], flags: ReturnType<typeof agentFlags>, tty: boolean, caller?: AgentName, remembered?: AgentName[]) {
  const detected = locations.filter(a => a.installed).map(a => a.name)
  const automatic = caller || !tty ? agentNames.filter(n => n === caller || (!tty && n === "opencode" && detected.includes(n))) : undefined
  if (flags.requested.length) return { picker: false, selected: flags.requested }
  if (flags.yes && !caller) return { picker: false, selected: detected }
  if (automatic) return { picker: false, selected: automatic }
  return { picker: true, selected: remembered?.filter(n => agentNames.includes(n)) ?? detected }
}

function fuzzy(query: string, text: string) {
  let pos = 0
  for (const c of text.toLowerCase()) if (query[pos] === c) pos++
  return pos === query.length
}

/** Clack handles raw mode, cancellation and redraw. Space always toggles (including directly after filtering). */
export async function pickAgents(locations: AgentLocation[], initial: AgentName[]): Promise<AgentName[] | undefined> {
  const selected = new Set(initial)
  const ordered = [...locations].sort((a, b) => Number(b.installed) - Number(a.installed) || agentLabels[a.name].localeCompare(agentLabels[b.name]))
  let query = "", cursor = 0, matches = ordered
  const prompt = new Prompt<AgentName[]>({ render() {
    if (this.state === "cancel") return "Install cancelled."
    if (this.state === "submit") return `Selected agents: ${[...selected].map(n => agentLabels[n]).join(", ") || "none"}`
    const count = Math.max(1, Math.min(12, (process.stdout.rows || 24) - 5))
    const start = Math.max(0, Math.min(cursor - Math.floor(count / 2), matches.length - count))
    return ["Choose agents for Browse", `Filter: ${query || "_"}`, ...matches.slice(start, start + count).map((a, i) =>
      `${i + start === cursor ? "❯" : " "} [${selected.has(a.name) ? "x" : " "}] ${agentLabels[a.name]}${a.installed ? " (detected)" : ""}`),
      ...(matches.length ? [] : ["  No matching agents"]),
      `↑/↓ move · Space toggle · Enter confirm · Type to filter (${selected.size} selected)`].join("\n")
  } })
  prompt.on("key", (char, key) => {
    if (key.name === "return") { prompt.value = [...selected]; return }
    if (key.name === "up" || key.name === "down") { cursor = (cursor + (key.name === "up" ? -1 : 1) + matches.length) % (matches.length || 1); return }
    if (key.name === "space") {
      const item = matches[cursor]
      if (item && !selected.delete(item.name)) selected.add(item.name)
      return
    }
    if (key.name === "backspace") query = query.slice(0, -1)
    else if (char && !key.ctrl && !key.meta && /^[\p{L}\p{N}-]$/u.test(char)) query += char.toLowerCase()
    else return
    cursor = 0
    matches = ordered.filter(a => fuzzy(query, agentLabels[a.name]) || fuzzy(query, a.name))
  })
  const result = await prompt.prompt()
  return isCancel(result) ? undefined : result
}
