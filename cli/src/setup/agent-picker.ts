import { styleText } from "node:util"
import { AutocompletePrompt, isCancel } from "@clack/core"
import {
  limitOptions,
  S_BAR,
  S_BAR_END,
  S_CHECKBOX_INACTIVE,
  S_CHECKBOX_SELECTED,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  settings,
  symbol,
} from "@clack/prompts"
import { agentLabels, agentName, agentNames, type AgentLocation, type AgentName } from "./agent-config.ts"

export type AgentOption = { value: AgentName; label: string }

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
      if (!name) throw new Error(`Unknown agent ${JSON.stringify(arg)}. Choose ${agentNames.join(", ")}, or none to add browse to another agent yourself.`)
      requested.add(name)
    }
  }
  return { requested: all ? [...agentNames] : [...requested], none: none && !all && !requested.size, yes: args.includes("--yes") || args.includes("-y") }
}

export function agentPlan(locations: AgentLocation[], flags: ReturnType<typeof agentFlags>, tty: boolean, caller?: AgentName, remembered?: AgentName[]) {
  const detected = locations.filter(a => a.installed).map(a => a.name)
  // An agent running install gets browse itself; with no terminal to ask (CI, a script), every agent found does.
  const automatic = caller ? [caller] : !tty ? detected : undefined
  if (flags.none) return { picker: false, selected: [] }
  if (flags.requested.length) return { picker: false, selected: flags.requested }
  if (flags.yes && !caller) return { picker: false, selected: detected }
  if (automatic) return { picker: false, selected: automatic }
  return { picker: true, selected: remembered?.filter(n => agentNames.includes(n)) ?? detected }
}

/** One agent row: a pointer on the focused row, its checkbox, then its name bright when focused and dim otherwise. */
export function agentRow(option: AgentOption, active: boolean, selected: AgentName[]) {
  const box = selected.includes(option.value) ? styleText("green", S_CHECKBOX_SELECTED) : styleText("dim", S_CHECKBOX_INACTIVE)
  if (active) return `${styleText("green", S_RADIO_ACTIVE)} ${box} ${option.label}`
  return `${styleText("dim", S_RADIO_INACTIVE)} ${box} ${styleText("dim", option.label)}`
}

/** The collapsed line after Enter: the picked agents by name, not "2 items selected". */
export function agentSummary(labels: string[]) {
  return labels.length ? labels.join(", ") : "none"
}

/** The searchable agent list: OpenCode first, then the agents found on this computer, ticked; typing searches every agent install knows. */
export async function pickAgents(locations: AgentLocation[], initial: AgentName[]): Promise<AgentName[] | undefined> {
  const ordered = [...locations].sort((a, b) => Number(b.name === "opencode") - Number(a.name === "opencode") || Number(b.installed) - Number(a.installed) || agentLabels[a.name].localeCompare(agentLabels[b.name]))
  // The same option objects every render: clack keeps the cursor by identity, and loses it on fresh ones.
  const all = ordered.map((a) => ({ value: a.name, label: agentLabels[a.name] }))
  const shown = all.filter((_, i) => ordered[i]!.installed || initial.includes(ordered[i]!.name))
  let last = { query: "", list: shown }
  // Clack focuses the last initial selection, so listing OpenCode last starts the cursor on the top row.
  const start = [...initial].sort((a, b) => Number(a === "opencode") - Number(b === "opencode"))
  const prompt = new AutocompletePrompt<AgentOption>({
    options() {
      const query = this.userInput.trim().toLowerCase()
      if (query === last.query) return last.list
      last = { query, list: query ? all.filter((o) => fuzzy(query, o.label) || fuzzy(query, o.value)) : shown }
      return last.list
    },
    filter: () => true,
    multiple: true,
    initialValue: start,
    // Clack's own autocompleteMultiselect only dims unfocused rows and collapses to a count; this is its frame with a
    // pointer on the focused row and the picked names in the summary, so the rail stays consistent.
    render() {
      const guide = settings.withGuide
      const head = `${guide ? `${styleText("gray", S_BAR)}\n` : ""}${symbol(this.state)}  Set browse up in these agents for you?`
      const summary = agentSummary(ordered.filter((agent) => this.selectedValues.includes(agent.name)).map((agent) => agentLabels[agent.name]))
      if (this.state === "submit") return `${head}\n${guide ? `${styleText("gray", S_BAR)}  ` : ""}${styleText("dim", summary)}`
      if (this.state === "cancel") return `${head}\n${guide ? `${styleText("gray", S_BAR)}  ` : ""}${styleText(["strikethrough", "dim"], this.userInput)}`
      const color = this.state === "error" ? "yellow" : "cyan"
      const rail = guide ? styleText(color, S_BAR) : ""
      const at = guide ? `${rail}  ` : ""
      const count = this.filteredOptions.length !== this.options.length ? ` (${this.filteredOptions.length} match${this.filteredOptions.length === 1 ? "" : "es"})` : ""
      const search = this.isNavigating || this.userInput === "" ? styleText("dim", this.userInput) : this.userInputWithCursor
      const top = [
        ...head.split("\n"),
        `${at}${styleText("dim", "Search:")} ${search}${styleText("dim", count)}`,
        ...(this.filteredOptions.length === 0 && this.userInput ? [`${at}${styleText("yellow", "No matches found")}`] : []),
        ...(this.state === "error" ? [`${at}${styleText("yellow", this.error)}`] : []),
      ]
      const footer = [
        `${at}${styleText("dim", "↑/↓")} to navigate • ${styleText("dim", this.isNavigating ? "Space/Tab:" : "Tab:")} select • ${styleText("dim", "Enter:")} confirm • ${styleText("dim", "Type:")} to search`,
        guide ? styleText(color, S_BAR_END) : "",
      ]
      const rows = limitOptions({
        cursor: this.cursor,
        options: this.filteredOptions,
        style: (option, active) => agentRow(option, active, this.selectedValues),
        maxItems: 10,
        columnPadding: guide ? 3 : 0,
        rowPadding: top.length + footer.length,
      })
      return [...top, ...rows.map((row) => `${at}${row}`), ...footer].join("\n")
    },
  })
  const result = await prompt.prompt()
  if (isCancel(result) || !result) return undefined
  return ordered.map((a) => a.name).filter((name) => result.includes(name))
}

function fuzzy(query: string, text: string) {
  let pos = 0
  for (const c of text.toLowerCase()) if (query[pos] === c) pos++
  return pos === query.length
}
