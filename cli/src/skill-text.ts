// The browse agent skill, inlined at bundle time so a compiled binary (no package folder on disk) can print it.
// @ts-expect-error text imports are a Bun bundler feature; NodeNext resolution has no type for a .md module.
import text from "../skills/browse/SKILL.md" with { type: "text" }

export const skillText: string = text
