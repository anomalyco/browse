import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { agentLocations, agentNames, callingAgent, editAgentConfig } from "../src/setup/agent-config.ts"
import { agentFlags, agentPlan } from "../src/setup/agent-picker.ts"
import { configRoot, stableNodePath } from "../src/setup/environment.ts"
import { pairedOfflineApplies } from "../src/setup/guidance.ts"
import { configFile } from "../src/setup/mcp.ts"
import { configureMcp, installedExtensionVersion, installedRuntime, installExitCode, installWaitTimeout, locateExtension, manualMcpEntry, pairStoreExtension, relayNotRestarted, remoteRelayAddresses, remoteRelayLines, removalsFor, removeMcp, setupStatusLines, storeCheckNeeded, waitForExtension, type Browser, type Detection, type LocateOptions } from "../src/setup.ts"

const browser = (name: string): Browser => ({ name, userData: `/data/${name}`, manifests: [], defaultIDs: [], executables: [] })
const chrome = browser("Google Chrome")
const edge = browser("Microsoft Edge")
const none = (target: Browser): Detection => ({ browser: target, blocked: false, enabled: [], disabled: [] })
const folder = "/src/browse/dist"

test("identifies the calling agent, not the editor hosting a regular terminal", () => {
  expect(callingAgent({ CLAUDECODE: "1", TERM_PROGRAM: "vscode" })).toBe("claude")
  expect(callingAgent({ CLAUDE_CODE_ENTRYPOINT: "sdk-py" })).toBe("claude")
  expect(callingAgent({ CODEX_THREAD_ID: "thread" })).toBe("codex")
  expect(callingAgent({ CURSOR_AGENT: "1", TERM_PROGRAM: "vscode" })).toBe("cursor")
  expect(callingAgent({ COPILOT_AGENT: "1", TERM_PROGRAM: "vscode" })).toBe("vscode")
  expect(callingAgent({ AI_AGENT: "github_copilot_vscode_agent" })).toBe("vscode")
  expect(callingAgent({ TERM_PROGRAM: "vscode", CODEX_HOME: "/home/me/.codex" })).toBeUndefined()
  expect(callingAgent({ GEMINI_CLI: "1" })).toBe("gemini")
  expect(callingAgent({ OPENCODE_SESSION_ID: "session" })).toBe("opencode")
  expect(callingAgent({ AMP_CURRENT_THREAD_ID: "thread" })).toBe("amp")
  expect(callingAgent({ AI_AGENT: "goose@1.2.3" })).toBe("goose")
})

test("OpenCode JSONC keeps comments and other servers across install, reinstall and uninstall", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-openconfig-"))
  try {
    const file = path.join(home, "opencode.jsonc"), entry = path.join(home, "cli.mjs")
    const before = '{\n// keep this\n"mcp": { "servers": { "other": {"type":"local","command":["my-server"]} } }\n}'
    fs.writeFileSync(file, before)
    expect(configureMcp(file, entry)).toContain("added")
    const once = fs.readFileSync(file, "utf8")
    expect(parse(once).mcp.servers.browse).toMatchObject({ type: "local", command: [process.execPath, entry, "mcp"] })
    expect(configureMcp(file, entry, entry)).toContain("up to date")
    expect(fs.readFileSync(file, "utf8")).toBe(once)
    expect(removeMcp("browse", entry, file)).toBe(true)
    const after = fs.readFileSync(file, "utf8")
    expect(parse(after)).toEqual(parse(before))
    expect(after).toContain("// keep this")
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test("a binary install's entry runs the executable itself, in OpenCode, other agents and the manual entry", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-binary-"))
  try {
    const binary = path.join(home, ".browse", "bin", "browse")
    const opencode = path.join(home, "opencode.json")
    expect(configureMcp(opencode, binary)).toContain("added")
    expect(parse(fs.readFileSync(opencode, "utf8")).mcp.servers.browse).toMatchObject({ command: [binary, "mcp"], environment: { OPENCODE_BROWSER_RUNTIME: "auto-update" } })
    expect(configureMcp(opencode, binary, binary)).toContain("up to date")
    expect(removeMcp("browse", binary, opencode)).toBe(true)

    const claude = { name: "claude" as const, file: path.join(home, ".claude.json"), entry: binary }
    expect(editAgentConfig(claude)).toBe("added")
    expect(parse(fs.readFileSync(claude.file, "utf8")).mcpServers.browse).toEqual({ type: "stdio", command: binary, args: ["mcp"] })
    // An npm install's receipt for the same file doesn't own the binary entry, unless passed as the recorded receipt.
    const npmClaude = { ...claude, node: "/usr/bin/node", entry: "/data/bin/opencode-browser.mjs" }
    expect(editAgentConfig(npmClaude, true)).toBe("conflict")
    expect(editAgentConfig(npmClaude, false, claude)).toBe("added")
    expect(parse(fs.readFileSync(claude.file, "utf8")).mcpServers.browse).toEqual({ type: "stdio", command: "/usr/bin/node", args: ["/data/bin/opencode-browser.mjs", "mcp"] })
    expect(editAgentConfig(claude, false, npmClaude)).toBe("added")
    expect(parse(fs.readFileSync(claude.file, "utf8")).mcpServers.browse).toEqual({ type: "stdio", command: binary, args: ["mcp"] })
    expect(editAgentConfig(claude, true)).toBe("removed")

    const codex = { name: "codex" as const, file: path.join(home, "config.toml"), entry: binary }
    const npmCodex = { ...codex, node: "/usr/bin/node", entry: "/data/bin/opencode-browser.mjs" }
    expect(editAgentConfig(npmCodex)).toBe("added")
    expect(editAgentConfig(codex, false, npmCodex)).toBe("added")
    expect(Bun.TOML.parse(fs.readFileSync(codex.file, "utf8"))).toEqual({ mcp_servers: { browse: { command: binary, args: ["mcp"] } } })
    expect(editAgentConfig(codex, true)).toBe("removed")

    expect(JSON.parse(manualMcpEntry([binary]))).toEqual({ mcpServers: { browse: { command: binary, args: ["mcp"] } } })
    expect(JSON.parse(manualMcpEntry(["/usr/bin/node", "/x/cli.mjs"]))).toEqual({ mcpServers: { browse: { command: "/usr/bin/node", args: ["/x/cli.mjs", "mcp"] } } })
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test("install exits cleanly when it stops early and 1 only when waiting timed out", () => {
  expect(installExitCode("cancelled")).toBe(130)
  expect(installExitCode("none-selected")).toBe(0)
  expect(installExitCode("skipped")).toBe(0)
  expect(installExitCode("timeout")).toBe(1)
})

test("an unpacked install never aborts on an old store build in another profile", () => {
  expect(storeCheckNeeded(folder, false)).toBe(false)
  expect(storeCheckNeeded(folder, true)).toBe(false)
  expect(storeCheckNeeded(undefined, false)).toBe(true)
  expect(storeCheckNeeded(undefined, true)).toBe(false)
})

describe("paired offline only explains a disconnect when a browser here has browse", () => {
  const match = { browser: chrome, profile: { dir: "Default", name: "Person 1" }, id: "afeafocngkodbmaipcngoamamfmekgfo" }

  test("a closed browser that has the extension, or one that couldn't be checked, does", () => {
    expect(pairedOfflineApplies(true, [{ ...none(chrome), enabled: [match] }], false)).toBe(true)
    expect(pairedOfflineApplies(true, [{ ...none(chrome), blocked: true }], false)).toBe(true)
    expect(pairedOfflineApplies(true, [], true)).toBe(true)
  })

  test("after the extension was removed, install guides reinstalling it", () => {
    expect(pairedOfflineApplies(true, [none(chrome)], false)).toBe(false)
    expect(pairedOfflineApplies(true, [], false)).toBe(false)
    expect(pairedOfflineApplies(false, [{ ...none(chrome), enabled: [match] }], false)).toBe(false)
  })
})

test("a picker's cleanup takes what was left unchecked, not what is still selected", () => {
  const claude = { name: "claude" as const, file: "/home/me/.claude.json", node: "/usr/bin/node", entry: "/cli.mjs" }
  const cursor = { name: "cursor" as const, file: "/home/me/.cursor/mcp.json", node: "/usr/bin/node", entry: "/cli.mjs" }
  const settings = { agents: [claude, cursor], opencodeConfigs: ["/home/me/.config/opencode/opencode.json"] }
  expect(removalsFor(settings, [], ["opencode", "claude"])).toEqual({ opencodeConfigs: [], agents: [cursor] })
  expect(removalsFor(settings, settings.opencodeConfigs, ["claude"])).toEqual({ opencodeConfigs: settings.opencodeConfigs, agents: [cursor] })
  expect(removalsFor(undefined, ["/a.json"], [])).toEqual({ opencodeConfigs: ["/a.json"], agents: [] })
})

test("cleanup removes only the browse entries install recorded", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-removal-"))
  try {
    const agentFile = path.join(home, "mcp.json")
    const receipt = { name: "claude" as const, file: agentFile, node: "/usr/bin/node", entry: "/cli.mjs" }
    fs.writeFileSync(agentFile, '{ "unrelated": true }')
    expect(editAgentConfig(receipt)).toBe("added")
    const file = path.join(home, "opencode.jsonc")
    const entry = path.join(home, "cli.mjs")
    expect(configureMcp(file, entry)).toContain("added")
    const removals = removalsFor({ agents: [receipt], opencodeConfigs: [file] }, [file], [])
    for (const stale of removals.agents) expect(editAgentConfig(stale, true)).toBe("removed")
    for (const stale of removals.opencodeConfigs) expect(removeMcp("browse", entry, stale)).toBe(true)
    expect(parse(fs.readFileSync(agentFile, "utf8"))).toEqual({ unrelated: true, mcpServers: {} })
    expect(parse(fs.readFileSync(file, "utf8")).mcp?.servers?.browse).toBeUndefined()
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test("plans a single picker, remembering even an intentionally empty selection", () => {
  const locations = agentNames.map(name => ({ name, file: name, installed: name === "opencode" || name === "cursor" }))
  const plan = (args: string[], tty: boolean, caller?: "claude", remembered?: (typeof agentNames[number])[]) => agentPlan(locations, agentFlags(args), tty, caller, remembered)
  expect(plan([], true)).toEqual({ picker: true, selected: ["opencode", "cursor"] })
  expect(plan([], true, undefined, ["claude"])).toEqual({ picker: true, selected: ["claude"] })
  expect(plan([], true, undefined, [])).toEqual({ picker: true, selected: [] })
  expect(plan([], true, "claude")).toEqual({ picker: false, selected: ["claude"] })
  expect(plan([], false, "claude", ["cursor"])).toEqual({ picker: false, selected: ["claude"] })
  expect(plan([], false)).toEqual({ picker: false, selected: ["opencode", "cursor"] })
  expect(agentPlan([], agentFlags([]), false)).toEqual({ picker: false, selected: [] })
  expect(plan(["-y"], true)).toEqual(plan(["--yes"], false))
  expect(plan(["-y"], true).selected).toEqual(["opencode", "cursor"])
  expect(plan(["-a", "claude", "vscode", "--agent", "claude", "--yes"], true, "claude")).toEqual({ picker: false, selected: ["claude", "vscode"] })
  expect(plan(["--agent", "*"], false).selected).toEqual([...agentNames])
  expect(plan(["--agent", "none"], true, "claude")).toEqual({ picker: false, selected: [] })
  expect(plan(["--agent", "none", "claude"], true).selected).toEqual(["claude"])
  expect(plan(["--all-agents"], true)).toEqual(plan(["-a", "*"], false))
  expect(() => agentFlags(["--agent", "oops"])).toThrow("Unknown agent")
  expect(() => agentFlags(["-a", "--yes"])).toThrow("at least one")
})

test.each(agentNames.filter(n => n !== "opencode"))("%s user config: preserve unrelated settings, install twice, uninstall, refuse collisions", name => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-config-"))
  try {
    const key = name === "vscode" ? "servers" : name === "zed" ? "context_servers" : name === "amp" ? "amp.mcpServers" : name === "kilo" ? "mcp" : "mcpServers"
    const toml = ["codex", "grok", "vibe"].includes(name)
    const yaml = name === "goose" || name === "hermes"
    const yamlKey = name === "goose" ? "extensions" : "mcp_servers"
    const file = path.join(home, toml ? "config.toml" : yaml ? "config.yaml" : "mcp.json")
    const before = toml ? `# my config\nmodel="test"\n${name === "vibe" ? '[[mcp_servers]]\nname="other"' : '[mcp_servers.other]'}\nurl="https://other"\n` : yaml ? `# my config\ncustom: &original [a, b]\ncopy: *original\n${yamlKey}:\n  other: { url: https://other } # keep this server\n` : `{\n// my config\n"unrelated":true, "${key}":{"other":{"url":"https://other"}},\n}`
    const config = () => { const text = fs.readFileSync(file, "utf8"); return yaml ? Bun.YAML.parse(text) : toml ? Bun.TOML.parse(text) : parse(text) }
    fs.writeFileSync(file, before)
    const original = config()
    const receipt = { name, file, node: "/a path/node", entry: "/a path/browse.mjs" }
    const definition = (node: string, entry: string) => name === "kilo" ? { type: "local", command: [node, entry, "mcp"] } : name === "copilot" ? { type: "local", command: node, args: [entry, "mcp"], tools: ["*"] } : name === "goose" ? { type: "stdio", name: "browse", cmd: node, args: [entry, "mcp"], enabled: true } : name === "vibe" ? { name: "browse", transport: "stdio", command: node, args: [entry, "mcp"] } : ["vscode", "claude", "codebuddy", "droid", "cortex"].includes(name) ? { type: "stdio", command: node, args: [entry, "mcp"] } : { command: node, args: [entry, "mcp"] }
    const server = () => name === "vibe" ? config().mcp_servers.find((s: { name: string }) => s.name === "browse") : config()[toml ? "mcp_servers" : yaml ? yamlKey : key].browse
    expect(editAgentConfig(receipt)).toBe("added")
    expect(server()).toEqual(definition(receipt.node, receipt.entry))
    const once = fs.readFileSync(file, "utf8")
    expect(editAgentConfig(receipt)).toBe("unchanged")
    expect(fs.readFileSync(file, "utf8")).toBe(once)

    // A reinstall replaces the entry this installer recorded, but only when given that receipt.
    const upgraded = { ...receipt, node: "/new node/node", entry: "/new path/browse.mjs" }
    expect(editAgentConfig(upgraded)).toBe("conflict")
    expect(fs.readFileSync(file, "utf8")).toBe(once)
    expect(editAgentConfig(upgraded, false, { ...receipt, name: name === "claude" ? "cursor" : "claude" })).toBe("conflict")
    expect(editAgentConfig(upgraded, false, receipt)).toBe("added")
    expect(server()).toEqual(definition(upgraded.node, upgraded.entry))
    const updated = fs.readFileSync(file, "utf8")
    expect(updated).toContain(toml ? "my config" : yaml ? "# keep this server" : "// my config")
    if (name === "vibe") expect(updated.match(/\[\[mcp_servers\]\]/g)).toHaveLength(2)
    else if (toml) expect(updated.match(/\[mcp_servers\.browse\]/g)).toHaveLength(1)
    expect(editAgentConfig(upgraded, false, receipt)).toBe("unchanged")
    expect(fs.readFileSync(file, "utf8")).toBe(updated)
    // Removal stays strict: it only takes the definition it would write today, never a previous one.
    expect(editAgentConfig(receipt, true, upgraded)).toBe("conflict")
    expect(editAgentConfig(upgraded, true)).toBe("removed")
    expect(config()).toEqual(original)
    if (yaml) expect(fs.readFileSync(file, "utf8")).toContain("# keep this server")

    fs.writeFileSync(file, once.replace("/a path/node", "/some-other/server"))
    expect(editAgentConfig(receipt)).toBe("conflict")
    expect(editAgentConfig(receipt, false, receipt)).toBe("conflict")
    expect(editAgentConfig(receipt, true)).toBe("conflict")
    fs.writeFileSync(file, once)
    expect(editAgentConfig(receipt, true)).toBe("removed")
    expect(config()).toEqual(original)
    expect(fs.readFileSync(file, "utf8")).toContain("my config")
    if (yaml) expect(fs.readFileSync(file, "utf8")).toContain("# keep this server")
    fs.unlinkSync(file)
    expect(editAgentConfig(receipt)).toBe("added")
    expect(editAgentConfig(receipt, true)).toBe("removed")
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test("every picker choice has one user-scoped destination; config dirs and binaries count as detected", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-locations-"))
  try {
    const config = path.join(home, ".config")
    fs.mkdirSync(path.join(home, ".qwen"))
    const locations = agentLocations(home, config, bin => bin === "droid", path.join(config, "opencode/opencode.json"))
    expect(locations.map(a => a.name).sort()).toEqual([...agentNames].sort())
    expect(locations.find(a => a.name === "qwen-code")).toMatchObject({ installed: true, file: path.join(home, ".qwen/settings.json") })
    expect(locations.find(a => a.name === "droid")).toMatchObject({ installed: true, file: path.join(home, ".factory/mcp.json") })
    expect(locations.find(a => a.name === "junie")?.installed).toBe(false)
    // macOS app bundles in ~/Applications count, including the desktop beta build named "OpenCode Beta".
    if (process.platform === "darwin") {
      const apps = path.join(home, "Applications")
      for (const bundle of ["OpenCode", "OpenCode Beta"]) {
        fs.mkdirSync(path.join(apps, `${bundle}.app`), { recursive: true })
        expect(agentLocations(home, config, () => undefined, path.join(config, "opencode/opencode.json")).find(a => a.name === "opencode")?.installed).toBe(true)
        fs.rmSync(path.join(apps, `${bundle}.app`), { recursive: true, force: true })
      }
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

/** Runs locateExtension with recording effects: nothing real is opened, revealed or copied. */
function run(overrides: Partial<Omit<LocateOptions, "folder">> & { folder?: string | undefined } = {}, results: { open?: boolean } = {}) {
  const calls: { open: [string, string][]; reveal: string[]; copy: string[] } = { open: [], reveal: [], copy: [] }
  const lines: string[] = []
  const { folder: unpacked = "folder" in overrides ? undefined : folder, ...rest } = overrides
  const options: LocateOptions = {
    allowOpen: true,
    connected: false,
    ...(unpacked ? { folder: unpacked } : {}),
    detections: [none(chrome)],
    preferred: chrome,
    env: { ssh: false, display: true, tty: true, platform: "darwin" },
    ...rest,
  }
  const outcome = locateExtension(options, {
    open: (target, url) => (calls.open.push([target.name, url]), results.open ?? true),
    reveal: (dir) => (calls.reveal.push(dir), true),
    copy: (text) => (calls.copy.push(text), true),
    log: (line) => lines.push(line),
  })
  return { outcome, calls, output: lines.join("\n") }
}

describe("a checkout install without the extension", () => {
  test("opens the extensions page, reveals the folder and copies its path", () => {
    const { outcome, calls, output } = run()
    expect(outcome).toBe("guided")
    expect(calls).toEqual({ open: [["Google Chrome", "chrome://extensions"]], reveal: [folder], copy: [folder] })
    expect(output).toContain("Load browse in Google Chrome: open chrome://extensions (opened)")
    expect(output).toContain("Developer mode")
    expect(output).toContain("Load unpacked")
    expect(output).toContain(`${folder} (path copied`)
    expect(output).toContain("Cmd+Shift+G")
    expect(output).not.toContain("chromewebstore")
  })

  test("uses the browser's own scheme for its extensions page", () => {
    const { calls, output } = run({ detections: [none(chrome), none(edge)], preferred: edge })
    expect(calls.open).toEqual([["Microsoft Edge", "edge://extensions"]])
    expect(output).toContain("Load browse in Microsoft Edge: open edge://extensions (opened)")
  })

  test("falls back to the first detected browser when the default isn't a known Chromium", () => {
    expect(run({ preferred: undefined }).calls.open).toEqual([["Google Chrome", "chrome://extensions"]])
  })

  test("doesn't claim the page opened when the browser couldn't be launched", () => {
    const { output } = run({}, { open: false })
    expect(output).toContain("Load browse in Google Chrome: open chrome://extensions")
    expect(output).not.toContain("(opened)")
  })

  test.each([
    ["--no-open", { allowOpen: false }],
    ["no display", { env: { ssh: false, display: false, tty: true, platform: "linux" as const } }],
  ])("only prints the steps with %s", (_, overrides) => {
    const { outcome, calls, output } = run(overrides)
    expect(outcome).toBe("guided")
    expect(calls).toEqual({ open: [], reveal: [], copy: [] })
    expect(output).toContain(folder)
    expect(output).not.toContain("(opened)")
    expect(output).not.toContain("copied")
  })

  test("over SSH, prints the steps without scanning or opening anything", () => {
    const { calls, output } = run({ env: { ssh: true, display: true, tty: true, platform: "linux" } })
    expect(calls).toEqual({ open: [], reveal: [], copy: [] })
    expect(output).not.toContain("Default browser")
    expect(output).toContain("Load unpacked")
    expect(output).toContain(folder)
  })

  test("doesn't open anything when a browser couldn't be checked and may already have it", () => {
    const { calls, output } = run({ detections: [none(chrome), { ...none(edge), blocked: true }] })
    expect(calls).toEqual({ open: [], reveal: [], copy: [] })
    expect(output).toContain("Couldn't check Microsoft Edge")
    expect(output).not.toContain("you're set")
  })

  test("with no Chromium browser found, names the page without opening it", () => {
    const { calls, output } = run({ detections: [], preferred: undefined })
    expect(calls.open).toEqual([])
    expect(output).toContain("Load browse in your browser: open chrome://extensions")
  })
})

describe("install with the extension", () => {
  test("a connected extension is ready", () => {
    const { outcome, calls, output } = run({ connected: true })
    expect(outcome).toBe("ready")
    expect(output).toContain("Restart your agent")
    expect(calls).toEqual({ open: [], reveal: [], copy: [] })
  })

  test("a paired browser that is closed needs no new code or tab", () => {
    const { calls, output } = run({ pairedOffline: true })
    expect(output).toContain("Open the browser profile already paired")
    expect(output).not.toContain("code")
    expect(calls.open).toEqual([])
  })

  test("an installed extension is ready even before the relay runs", () => {
    const match = { browser: chrome, profile: { dir: "Default", name: "Person 1" }, id: "afeafocngkodbmaipcngoamamfmekgfo" }
    const { outcome, output } = run({ detections: [{ ...none(chrome), enabled: [match] }] })
    expect(outcome).toBe("ready")
    expect(output).toBe("")
    expect(output).not.toContain("Agents can use browse now")
  })

  test("a turned-off extension is reported, not reinstalled", () => {
    const match = { browser: chrome, profile: { dir: "Default", name: "Person 1" }, id: "afeafocngkodbmaipcngoamamfmekgfo" }
    const { outcome, calls, output } = run({ detections: [{ ...none(chrome), disabled: [match] }] })
    expect(outcome).toBe("off")
    expect(calls.open).toEqual([])
    expect(output).toContain("turned off in Google Chrome (Person 1)")
  })
})

describe("an npm install without the extension", () => {
  const storeUrl = "https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop"

  test("an agent without a terminal opens the store if a display is available", () => {
    const { calls } = run({ folder: undefined, storeUrl, env: { ssh: false, display: true, tty: false, platform: "darwin" } })
    expect(calls.open).toEqual([["Google Chrome", storeUrl]])
  })

  test("opens its channel's store page, never the unpacked steps", () => {
    const { outcome, calls, output } = run({ folder: undefined, storeUrl })
    expect(outcome).toBe("guided")
    expect(calls).toEqual({ open: [["Google Chrome", storeUrl]], reveal: [], copy: [] })
    expect(output).toContain("Add browse to Google Chrome from the Chrome Web Store (opened)")
    expect(output).not.toContain("Load unpacked")
  })

  test("with no Chromium browser detected, prints the store page instead of opening it in Safari", () => {
    const opened: string[] = []
    const lines: string[] = []
    const outcome = locateExtension(
      {
        allowOpen: true,
        connected: false,
        detections: [],
        preferred: undefined,
        storeUrl,
        env: { ssh: false, display: true, tty: true, platform: "darwin" },
      },
      {
        open: (target, url) => (opened.push(`${target.name} ${url}`), true),
        openDefault: (url) => (opened.push(`default ${url}`), true),
        reveal: () => true,
        copy: () => true,
        log: (line) => lines.push(line),
      },
    )
    expect(outcome).toBe("guided")
    expect(opened).toEqual([])
    expect(lines.join("\n")).toContain("Chromium")
    expect(lines.join("\n")).toContain(storeUrl)
    expect(lines.join("\n")).toContain("Google Chrome, Brave, Microsoft Edge or Arc")
    expect(lines.join("\n")).not.toContain("(opened)")
  })

  test("over SSH, prints the store page", () => {
    const { calls, output } = run({ folder: undefined, storeUrl, env: { ssh: true, display: true, tty: true, platform: "linux" } })
    expect(calls.open).toEqual([])
    expect(output).toContain(storeUrl)
    expect(output).not.toContain("Load unpacked")
  })

  test("a package built without its store item says it can't install the extension", () => {
    const { outcome, calls, output } = run({ folder: undefined })
    expect(outcome).toBe("guided")
    expect(calls.open).toEqual([])
    expect(output).toContain("doesn't know its Chrome Web Store item")
  })
})

describe("pairing the store build", () => {
  const storeId = "abcdefghijklmnopabcdefghijklmnop"
  const profile = { dir: "Profile 2", name: "Work" }
  test("reads the packed version even when the cached store manifest is absent", () => {
    expect(installedExtensionVersion(storeId, { path: `${storeId}/0.0.2_0` })).toBe("0.0.2")
    expect(installedExtensionVersion(storeId, { path: `${storeId}\\0.0.3_1` })).toBe("0.0.3")
    expect(installedExtensionVersion(storeId, { path: `${storeId}/0.0.2_0`, manifest: { version: "0.0.3" } })).toBe("0.0.3")
    expect(installedExtensionVersion(storeId, { path: "other/0.0.2_0" })).toBeUndefined()
  })
  const pair = (detections: Detection[], overrides: { allowOpen?: boolean; ssh?: boolean } = {}) => {
    const opened: [string, string, string | undefined][] = []
    const lines: string[] = []
    const outcome = pairStoreExtension(
      { detections, preferred: chrome, allowOpen: overrides.allowOpen ?? true, env: { ssh: overrides.ssh ?? false, display: true, tty: true, platform: "darwin" }, code: () => "ABCD1234", storeIds: [storeId] },
      { open: (target, url, dir) => (opened.push([target.name, url, dir]), true), reveal: () => true, copy: () => true, log: (line) => lines.push(line) },
    )
    return { outcome, opened, output: lines.join("\n") }
  }

  test("opens the store build's status page with a one-time code in the fragment, in the profile that has it", () => {
    const { outcome, opened, output } = pair([{ ...none(chrome), enabled: [{ browser: chrome, profile, id: storeId }] }])
    expect(outcome).toBe("opened")
    expect(opened).toEqual([["Google Chrome", `chrome-extension://${storeId}/welcome.html#code=ABCD1234`, "Profile 2"]])
    expect(output).toContain("Opened browse in Google Chrome to connect it")
  })

  test("never hands the code to an extension that isn't a configured store item", () => {
    const { outcome, opened } = pair([{ ...none(chrome), enabled: [{ browser: chrome, profile, id: "afeafocngkodbmaipcngoamamfmekgfo" }] }])
    expect(outcome).toBe("none")
    expect(opened).toEqual([])
  })

  test("an older store copy in the default browser doesn't hide a compatible second browser", () => {
    const { opened } = pair([
      { ...none(chrome), enabled: [{ browser: chrome, profile, id: storeId, version: "0.0.2" }] },
      { ...none(edge), enabled: [{ browser: edge, profile, id: storeId, version: "0.0.3" }] },
    ])
    expect(opened.map(([name]) => name)).toEqual(["Microsoft Edge"])
  })

  test("with --no-open, says how to pair by hand", () => {
    const { outcome, opened, output } = pair([{ ...none(chrome), enabled: [{ browser: chrome, profile, id: storeId }] }], { allowOpen: false })
    expect(outcome).toBe("manual")
    expect(opened).toEqual([])
    expect(output).toContain("click Pair.")
  })
})

describe("waiting for the extension", () => {
  test("install leaves time to report next steps to an agent but keeps the terminal wait", () => {
    expect(installWaitTimeout([], false)).toBe(90_000)
    expect(installWaitTimeout([], true)).toBe(180_000)
    expect(installWaitTimeout(["--wait-seconds", "240"], false)).toBe(240_000)
  })
  const instant = async () => {}

  test("returns as soon as it connects", async () => {
    let polls = 0
    const connected = await waitForExtension({ connected: async () => ++polls === 3, timeoutMs: 10_000, intervalMs: 1_000, sleep: instant })
    expect(connected).toBe(true)
    expect(polls).toBe(3)
  })

  test("gives up after the timeout", async () => {
    let polls = 0
    const connected = await waitForExtension({ connected: async () => (polls++, false), timeoutMs: 5_000, intervalMs: 1_000, sleep: instant })
    expect(connected).toBe(false)
    expect(polls).toBe(6)
  })
})

describe("status recognises the install", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-setup-"))
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  const checkout = path.join(root, "browse", "cli")
  const entry = path.join(checkout, "dist", "cli.mjs")
  fs.mkdirSync(path.join(checkout, "dist"), { recursive: true })
  fs.mkdirSync(path.join(checkout, "src"), { recursive: true })
  fs.writeFileSync(entry, "")
  fs.writeFileSync(path.join(checkout, "src", "main.ts"), "")
  fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ version: "1.2.3" }))
  const server = { type: "local", command: ["/usr/bin/node", entry, "mcp"] }

  test("a checkout whose settings have no version, from the MCP server entry", () => {
    expect(installedRuntime({ opencode: "/bin/opencode" }, server)).toEqual({ entry, version: "1.2.3", source: true })
  })

  test("the version install recorded", () => {
    expect(installedRuntime({ entry, version: "0.0.9" }, undefined)).toEqual({ entry, version: "0.0.9", source: true })
  })

  test("nothing installed", () => {
    expect(installedRuntime(undefined, undefined)).toBeUndefined()
    expect(installedRuntime({ opencode: "/bin/opencode" }, { command: ["/usr/bin/node", path.join(root, "gone", "cli.mjs"), "mcp"] })).toBeUndefined()
  })
})

describe("relayNotRestarted", () => {
  const output = "Restarting the relay leaves browser tabs open but resets in-memory JavaScript state.\nRelay has raw CDP clients attached; disconnect them before restarting\n"
  const status = (sessions: { id: string; connected: boolean }[]) => JSON.stringify({ relay: { stale: true }, sessions })

  test("names the active agent sessions, says the old version stays, and gives the restart command", () => {
    expect(relayNotRestarted(status([{ id: "github", connected: true }, { id: "idle", connected: false }]), output, "node /x/cli.mjs relay restart")).toEqual([
      "! Relay not restarted: an agent session is active (github) (Relay has raw CDP clients attached; disconnect them before restarting).",
      "  It keeps running the previous version, so agents get this update only after it restarts.",
      "  When no agent is using the browser, run: node /x/cli.mjs relay restart",
    ])
    expect(relayNotRestarted(status([{ id: "a", connected: true }, { id: "b", connected: true }]), output, "cmd")[0]).toStartWith("! Relay not restarted: 2 agent sessions are active (a, b)")
  })

  test("when a capture or recording blocks the restart, it offers --force", () => {
    const blocked = "Relay has a network capture in session x; stop them, or run `opencode-browser relay restart --force` to end them (discarding what they captured) and restart"
    expect(relayNotRestarted("not json", blocked, "cmd")[2]).toBe("  When no agent is using the browser, run: cmd (or cmd --force to end what's blocking it now)")
  })

  test("without a connected session it gives the relay's reason, and by default the command for this checkout", () => {
    const lines = relayNotRestarted("not json", output)
    expect(lines[0]).toBe("! Relay not restarted: Relay has raw CDP clients attached; disconnect them before restarting.")
    expect(lines[2]).toMatch(/run: node .*cli[/\\]dist[/\\]cli\.mjs relay restart$/)
  })

  test("a reason that already ends in a period keeps exactly one", () => {
    expect(relayNotRestarted("not json", "Relay is recording in session x.\n")[0]).toBe("! Relay not restarted: Relay is recording in session x.")
    expect(relayNotRestarted(status([{ id: "github", connected: true }]), "Relay is recording in session x.")[0]).toBe(
      "! Relay not restarted: an agent session is active (github) (Relay is recording in session x).",
    )
  })
})

describe("status lines when OpenCode isn't configured", () => {
  const claude = { name: "claude" as const, file: "/home/me/.claude.json", node: "/usr/bin/node", entry: "/cli.mjs" }
  const lines = (settings: Parameters<typeof setupStatusLines>[0]["settings"], opencode: string | undefined, mcpConfigured: boolean) =>
    setupStatusLines({ settings, runtime: undefined, opencode, mcpConfigured, autoUpdate: "Auto-update: on", logs: "/tmp/logs" })

  test("names the agents install wrote browse into instead of saying nothing is configured", () => {
    const output = lines({ agents: [claude] }, undefined, false).join("\n")
    expect(output).toContain("Agents:    Claude Code (/home/me/.claude.json)")
    expect(output).toContain('MCP:       "browse" configured in Claude Code')
    expect(output).not.toContain("opencode:  not found")
    expect(output).not.toContain("MCP:       not configured")
  })

  test("still says nothing is configured without any agent", () => {
    const output = lines(undefined, undefined, false).join("\n")
    expect(output).toContain("opencode:  not found")
    expect(output).toContain("MCP:       not configured")
  })

  test("keeps the opencode lines when OpenCode is configured", () => {
    const output = lines(undefined, "/bin/opencode", true).join("\n")
    expect(output).toContain("opencode:  /bin/opencode")
    expect(output).toContain('MCP:       "browse" configured')
    expect(output).not.toContain("Agents:")
  })
})

describe("configFile", () => {
  const previous = process.env.OPENCODE_CONFIG_DIR

  afterEach(() => {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
  })

  test("OPENCODE_CONFIG_DIR is the config directory itself, and its existing files win in order", () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "browse-config-"))
    try {
      fs.writeFileSync(path.join(folder, "opencode.jsonc"), "{}")
      process.env.OPENCODE_CONFIG_DIR = folder
      expect(configFile()).toBe(path.join(folder, "opencode.jsonc"))
      fs.writeFileSync(path.join(folder, "opencode.json"), "{}")
      expect(configFile()).toBe(path.join(folder, "opencode.json"))
    } finally {
      fs.rmSync(folder, { recursive: true, force: true })
    }
  })

  test("without OPENCODE_CONFIG_DIR it reads opencode's folder under the config root", () => {
    delete process.env.OPENCODE_CONFIG_DIR
    const base = path.join(configRoot, "opencode")
    const file = configFile()
    expect(file.startsWith(base + path.sep)).toBe(true)
    expect(path.basename(file)).toMatch(/^opencode\.jsonc?$/)
  })
})

describe("stableNodePath", () => {
  test("prefers the node on PATH when it is the running binary", () => {
    expect(stableNodePath(process.execPath, () => process.execPath)).toBe(process.execPath)
  })

  test("follows a symlink to the running binary", () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "browse-link-"))
    const link = path.join(folder, "node")
    try {
      fs.symlinkSync(process.execPath, link)
      expect(stableNodePath(process.execPath, () => link)).toBe(link)
    } finally {
      fs.rmSync(folder, { recursive: true, force: true })
    }
  })

  test("keeps execPath for another binary, a missing one, or a path that does not resolve", () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "browse-node-"))
    const other = path.join(folder, "node")
    fs.writeFileSync(other, "")
    try {
      expect(stableNodePath(process.execPath, () => other)).toBe(process.execPath)
      expect(stableNodePath(process.execPath, () => path.join(folder, "gone"))).toBe(process.execPath)
      expect(stableNodePath(process.execPath, () => undefined)).toBe(process.execPath)
    } finally {
      fs.rmSync(folder, { recursive: true, force: true })
    }
  })
})

test("install --remote prefers the tailnet's addresses, else the LAN's, and prints the code with its lifetime", () => {
  const address = (value: string, internal = false) => ({ address: value, family: "IPv4" as const, internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null })
  const lan = { lo: [address("127.0.0.1", true)], eth0: [address("192.168.1.20")], docker0: [address("172.17.0.1")], wlan0: [address("169.254.3.4"), address("10.0.0.5")] }
  expect(remoteRelayAddresses(lan)).toEqual(["192.168.1.20", "10.0.0.5"])
  expect(remoteRelayAddresses(lan, { port: 19988 })).toEqual(["192.168.1.20", "10.0.0.5"])
  expect(remoteRelayAddresses(lan, { port: 20001 })).toEqual(["192.168.1.20:20001", "10.0.0.5:20001"])
  const tailnet = { ...lan, tailscale0: [address("100.101.102.103")] }
  expect(remoteRelayAddresses(tailnet)).toEqual(["100.101.102.103"])
  expect(remoteRelayAddresses(tailnet, { magicDns: "devbox.tail1234.ts.net" })).toEqual(["devbox.tail1234.ts.net", "100.101.102.103"])
  expect(remoteRelayAddresses({ lo: [address("127.0.0.1", true)] })).toEqual([])

  expect(remoteRelayLines(["devbox.tail1234.ts.net", "100.101.102.103"], "ABCDEFGH", 10 * 60_000)).toEqual([
    "Relay address  devbox.tail1234.ts.net",
    "           or  100.101.102.103",
    "Pairing code   ABCD-EFGH",
    "",
    expect.stringMatching(/^The code works once, within 10 minutes\. For a new one, run: .*pair$/),
  ])
  expect(remoteRelayLines([], "ABCDEFGH")[0]).toBe("Relay address  this computer's IP address")
})
