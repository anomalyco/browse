// The agents install can configure, by the name `--agent` takes. No Node imports: the extension's onboarding page
// builds its agent picker from this list too.
export const agentLabels = {
  opencode: "OpenCode", claude: "Claude Code", cursor: "Cursor", codex: "Codex", vscode: "VS Code", windsurf: "Windsurf",
  "claude-desktop": "Claude Desktop", gemini: "Gemini CLI", zed: "Zed", cline: "Cline", roo: "Roo Code (VS Code)",
  kilo: "Kilo Code", goose: "Goose", amp: "Amp", kiro: "Kiro", droid: "Factory Droid", copilot: "GitHub Copilot CLI",
  warp: "Warp", "lm-studio": "LM Studio", "qwen-code": "Qwen Code", kimi: "Kimi Code CLI", augment: "Augment (Auggie CLI)",
  antigravity: "Antigravity", junie: "Junie", codebuddy: "CodeBuddy Code", cortex: "Cortex Code", hermes: "Hermes Agent",
  grok: "Grok Build", vibe: "Mistral Vibe", qoder: "Qoder CLI",
}
export type AgentName = keyof typeof agentLabels
export const agentNames = Object.keys(agentLabels) as AgentName[]
