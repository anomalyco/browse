// The onboarding page's checklist (onboarding.tsx): connect an agent, pin Browse, try it. Each step is done, the one
// to do now, or not reached yet; the page shows the first that isn't done as active.
import type { AgentRelayState } from "../shared/protocol"
import { agentLabels, agentNames, type AgentName } from "../../cli/src/agent-labels"

export type StepState = "done" | "active" | "upcoming"

export type Checklist = { agent: StepState; pin: StepState; tryIt: StepState; finished: boolean }

export type ChecklistInput = {
  state: AgentRelayState | undefined
  /** The relay connected at some point while the page was open. */
  wasConnected: boolean
  /** chrome.action's isOnToolbar; undefined until Chrome answers. */
  pinned: boolean | undefined
  pinSkipped: boolean
  /** An agent used a tab while the page was open. */
  tried: boolean
}

/**
 * The agent step stays done while a paired relay merely stops (agents start it on demand, and it goes when they do),
 * but not when the relay refuses this browser or speaks another version.
 */
export function agentConnected(state: AgentRelayState | undefined, wasConnected: boolean) {
  if (!state) return false
  if (state.status === "connected") return true
  return wasConnected && state.pairing === "token" && (state.status === "offline" || state.status === "connecting")
}

export function checklist(input: ChecklistInput): Checklist {
  const agentDone = agentConnected(input.state, input.wasConnected)
  const pinDone = input.pinned === true || input.pinSkipped
  const tryDone = input.tried || (agentDone && (input.state?.tabs.length ?? 0) > 0)
  const agent: StepState = agentDone ? "done" : "active"
  const pin: StepState = pinDone ? "done" : agentDone ? "active" : "upcoming"
  const tryIt: StepState = tryDone ? "done" : agentDone && pinDone ? "active" : "upcoming"
  return { agent, pin, tryIt, finished: agent === "done" && pin === "done" && tryIt === "done" }
}

/** The agents shown as chips before "More". */
export const featuredAgents: AgentName[] = ["opencode", "claude", "codex", "cursor", "vscode", "gemini"]
export const otherAgents = agentNames.filter((name) => !featuredAgents.includes(name)).sort((a, b) => agentLabels[a].localeCompare(agentLabels[b]))
export { agentLabels, type AgentName }

/** Install, for one agent: OpenCode is the default the terminal picker offers, any other is named with --agent. */
export const installCommand = (agent: AgentName) => (agent === "opencode" ? "npx @opencode/browse install" : `npx @opencode/browse install --agent ${agent}`)

export const TRY_PROMPT = "Open news.ycombinator.com and tell me the top story"
