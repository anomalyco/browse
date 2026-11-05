import { describe, expect, test } from "bun:test"
import { stripVTControlCharacters } from "node:util"
import { agentRow, agentSummary, type AgentOption } from "../src/setup/agent-picker.ts"

const plain = (text: string) => stripVTControlCharacters(text)
const opencode: AgentOption = { value: "opencode", label: "OpenCode" }
const claude: AgentOption = { value: "claude", label: "Claude Code" }

describe("agent picker", () => {
  test("the focused row gets the pointer and a bright name; others dim", () => {
    expect(plain(agentRow(opencode, true, ["opencode"]))).toBe("● ◼ OpenCode")
    expect(plain(agentRow(opencode, false, ["opencode"]))).toBe("○ ◼ OpenCode")
    expect(plain(agentRow(claude, false, []))).toBe("○ ◻ Claude Code")
  })

  test("the collapsed summary names the picked agents, in the order shown, or none", () => {
    expect(agentSummary(["OpenCode", "Claude Code"])).toBe("OpenCode, Claude Code")
    expect(agentSummary([])).toBe("none")
  })
})
