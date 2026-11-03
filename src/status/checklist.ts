// The onboarding page's checklist (onboarding.tsx): connect an agent, then try it. Each step is done, the one to do
// now, or not reached yet; the page shows the first that isn't done as active.
import type { AgentRelayState } from "../shared/protocol"

export type StepState = "done" | "active" | "upcoming"

export type Checklist = { agent: StepState; tryIt: StepState; finished: boolean }

export type ChecklistInput = {
  state: AgentRelayState | undefined
  /** The relay connected at some point while the page was open. */
  wasConnected: boolean
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
  const tryDone = input.tried || (agentDone && (input.state?.tabs.length ?? 0) > 0)
  const agent: StepState = agentDone ? "done" : "active"
  const tryIt: StepState = tryDone ? "done" : agentDone ? "active" : "upcoming"
  return { agent, tryIt, finished: agent === "done" && tryIt === "done" }
}

export const TRY_PROMPT = "Open news.ycombinator.com and tell me the top story"
