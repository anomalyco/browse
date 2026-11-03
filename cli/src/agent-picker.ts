import { autocompleteMultiselect, isCancel } from "@clack/prompts"
import { agentLabels, agentName, agentNames, type AgentLocation, type AgentName } from "./agent-config.ts"

export function agentFlags(args: string[]) {
  const requested = new Set<AgentName>()
  let all = args.includes("--all-agents")
  // `--agent none`: an agent install doesn't know; it prints the MCP server entry to add by hand instead.
  let none = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-a" && args[i] !== "--agent") continue
    if (!args[i + 1] || args[i + 1]!.startsWith("-")) throw new Error(`${args[i]} needs at least one agent name (or '*' or 'none').`)
    while (args[i + 1] && !args[i + 1]!.startsWith("-")) {
      const arg = args[++i]!
      if (arg === "*") { all = true; continue }
      if (arg === "none") { none = true; continue }
      const name = agentName(arg)
      if (!name) throw new Error(`Unknown agent ${JSON.stringify(arg)}. Choose ${agentNames.join(", ")}, or none to add Browse to another agent yourself.`)
      requested.add(name)
    }
  }
  return { requested: all ? [...agentNames] : [...requested], none: none && !all && !requested.size, yes: args.includes("--yes") || args.includes("-y") }
}

export function agentPlan(locations: AgentLocation[], flags: ReturnType<typeof agentFlags>, tty: boolean, caller?: AgentName, remembered?: AgentName[]) {
  const detected = locations.filter(a => a.installed).map(a => a.name)
  // An agent running install gets Browse itself; with no terminal to ask (CI, a script), every agent found does.
  const automatic = caller ? [caller] : !tty ? detected : undefined
  if (flags.none) return { picker: false, selected: [] }
  if (flags.requested.length) return { picker: false, selected: flags.requested }
  if (flags.yes && !caller) return { picker: false, selected: detected }
  if (automatic) return { picker: false, selected: automatic }
  return { picker: true, selected: remembered?.filter(n => agentNames.includes(n)) ?? detected }
}

/** The searchable agent list: OpenCode first, then the agents found on this computer, ticked. */
export async function pickAgents(locations: AgentLocation[], initial: AgentName[]): Promise<AgentName[] | undefined> {
  const ordered = [...locations].sort((a, b) => Number(b.name === "opencode") - Number(a.name === "opencode") || Number(b.installed) - Number(a.installed) || agentLabels[a.name].localeCompare(agentLabels[b.name]))
  // Clack's option type distributes over a union of values, so the picker works on plain names.
  const result = await autocompleteMultiselect<string>({
    message: "Which agents should get Browse? (Yours isn't listed? Pick none: you'll get the entry to add yourself.)",
    options: ordered.map((a) => ({ value: a.name, label: agentLabels[a.name], ...(a.installed ? { hint: "found" } : {}) })),
    initialValues: initial,
    maxItems: 10,
    filter: (search, option) => fuzzy(search.toLowerCase(), option.label ?? option.value) || fuzzy(search.toLowerCase(), option.value),
  })
  return isCancel(result) ? undefined : ordered.map((a) => a.name).filter((name) => result.includes(name))
}

function fuzzy(query: string, text: string) {
  let pos = 0
  for (const c of text.toLowerCase()) if (query[pos] === c) pos++
  return pos === query.length
}
