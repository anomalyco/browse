// The status page (welcome.html): opened on install, as the extension's options page, and by the toolbar button before
// setup. Leads with the first-run card (first-run.ts): the one thing to do next, kept live. Then the settings: where
// agent tabs open and how they're grouped and closed, the agent cursor, human-like input, and handoff notifications.
// Each is a chrome.storage.local key the background reads when it needs it (or sends to the relay, for the cursor and
// input); a setting the relay's environment fixes is shown as such. Last, the connection (the relay's address, a
// pairing code to enter, the live status and the update the relay found, if any), reconnect, cleanup and diagnostics.
import {
  AGENT_CURSOR_KEY,
  AGENT_DIAGNOSTICS,
  AGENT_GROUPING_KEY,
  AGENT_WINDOW_KEY,
  BROWSER_NAME_KEY,
  HANDOFF_NOTIFICATIONS_KEY,
  HUMAN_INPUT_KEY,
  IDLE_MINUTES_KEY,
  STATUS_PORT,
  agentCursor,
  agentGrouping,
  agentWindowPlacement,
  handoffNotifications,
  humanInput,
  idleMinutesSetting,
  type AgentRelayState,
  type FromStatusPage,
  type RelayOverrides,
  type ToStatusPage,
} from "../shared/protocol"
import { firstRunStep, relayProbeResult, shouldProbe, type FirstRunStep, type RelayProbe } from "./first-run"
import { unpackedExtensionId, unpackedReloadAdvice } from "../../cli/src/protocol"

// `npx @opencode/browse install` opens this page as welcome.html#code=<one-time code> for a store build
// (cli/src/setup.ts pairStoreExtension). Take it, then drop it from the URL (address bar and history) before anything else.
let fragmentCode = /^#code=([0-9A-Za-z-]{8,9})$/.exec(location.hash)?.[1]
let installTab = !!fragmentCode
if (/^#(code|ticket|pair)=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search)

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = element<HTMLParagraphElement>("status")
element("extension-id").textContent = chrome.runtime.id

let port: chrome.runtime.Port | undefined
const connect = () => {
  const next = chrome.runtime.connect({ name: STATUS_PORT })
  port = next
  next.onMessage.addListener((message: ToStatusPage) => {
    if (message.type === "agents") render(message.state)
    if (message.type === "pairing.link.result") {
      if (message.ok) pairedBy = "link"
      else showStepNote("Already paired with the relay; the pairing link from install was ignored.")
    }
    if (message.type === "relay.result") {
      if (connectFrom === "card") showCodeResult(message.status, message.address)
      else showRelayResult(message.status, message.address)
      connectFrom = undefined
    }
  })
  // The worker can stop and restart at any time; follow it.
  next.onDisconnect.addListener(() => {
    void chrome.runtime.lastError
    // A Connect in flight lost its answer with the worker; the status above still shows how it went.
    resetButton(element<HTMLFormElement>("relay-form").querySelector("button")!, "Connect")
    resetButton(element<HTMLFormElement>("step-code-form").querySelector("button")!, "Pair")
    connectFrom = undefined
    if (port === next) setTimeout(connect, 300)
  })
}
connect()

const send = (message: FromStatusPage) => port?.postMessage(message)

/** The worker's latest state, and what the probe of this computer's relay port found while there's nothing to connect with. */
let current: AgentRelayState | undefined
let probe: RelayProbe = "unknown"
/** How this page paired the browser, to confirm it once connected: install's link, or a code typed in the card. */
let pairedBy: "link" | "code" | undefined
/** Which form's Connect is waiting for its `relay.result`. */
let connectFrom: "card" | "advanced" | undefined

function render(state: AgentRelayState) {
  current = state
  renderStep()
  if (installTab && state.status === "connected") {
    installTab = false
    void returnToWelcomeTab().catch(() => {})
  }
  // The code from install's URL, used once, and only when this extension isn't paired with the relay (no token, or one
  // the relay refused). A working pairing is never replaced; the page says it ignored the link instead.
  // While it's still connecting (or the relay is starting), wait for a status that tells.
  if (fragmentCode && state.status !== "offline" && state.status !== "connecting") {
    if (state.status === "unpaired" || state.status === "untrusted") send({ type: "pairing.link", code: fragmentCode })
    else showStepNote("Already paired with the relay; the pairing link from install was ignored.")
    fragmentCode = undefined
  }
  // A Connect result from the form further down doesn't outlive the connection it described.
  if (state.status === "connected" && connectFrom === undefined) element("relay-result").hidden = true
  if (shouldProbe(state)) void probeRelay()
  status.dataset.state = state.status
  status.textContent = describe(state)
  showRelayAddress(state.relay.address)
  element("update").hidden = !state.update
  element("update-summary").textContent = state.update ? capitalized(state.update.summary) : ""
  element("update-command").textContent = state.update?.command ?? ""
  showOverrides(state.overrides)
  showAutoUpdate(state.autoUpdate)
  showBrowser(state.browser)
}

// Only remove this install-created code tab, after success, if the original first-run tab still exists in its window.
async function returnToWelcomeTab() {
  const self = await chrome.tabs.getCurrent()
  if (self?.id === undefined) return
  const welcome = (await chrome.tabs.query({ windowId: self.windowId })).find(tab => tab.url === chrome.runtime.getURL("welcome.html?first-run"))
  if (welcome?.id === undefined || welcome.id === self.id) return
  if (self.active) await chrome.tabs.update(welcome.id, { active: true })
  await chrome.tabs.remove(self.id)
}

/** The relay's update setting: shown for an npm install (a checkout updates with `update`; the notice above says so). */
function showAutoUpdate(autoUpdate: AgentRelayState["autoUpdate"]) {
  element("updates").hidden = autoUpdate?.install !== "npm"
  if (!autoUpdate || autoUpdate.install !== "npm") return
  for (const input of Array.from(element("auto-update").querySelectorAll<HTMLInputElement>("input[name=auto-update]")))
    input.checked = input.value === autoUpdate.mode
  const facts = [
    autoUpdate.version ? `Installed: ${autoUpdate.version}${autoUpdate.channel === "dev" ? " (dev channel)" : ""}.` : "",
    autoUpdate.pending ? `${autoUpdate.pending} is ready and switches in once no agent is using the browser.` : "",
    !autoUpdate.pending && autoUpdate.latest && autoUpdate.latest !== autoUpdate.version ? `Newest: ${autoUpdate.latest}.` : "",
    autoUpdate.previous && autoUpdate.version && autoUpdate.previous !== autoUpdate.version ? `\`opencode-browser rollback\` switches to ${autoUpdate.previous}.` : "",
  ]
  element("auto-update-state").textContent = facts.filter(Boolean).join(" ")
  const note = element("auto-update-override")
  note.hidden = !autoUpdate.overriddenBy
  if (autoUpdate.overriddenBy) {
    const variable = document.createElement("code")
    variable.textContent = autoUpdate.overriddenBy
    note.replaceChildren(`In effect: ${{ on: "automatic", notify: "notify only", off: "off" }[autoUpdate.effective]}. Set by `, variable, " on the relay.")
  }
}
for (const input of Array.from(element("auto-update").querySelectorAll<HTMLInputElement>("input[name=auto-update]")))
  input.addEventListener("change", () => {
    if (input.checked && (input.value === "on" || input.value === "notify" || input.value === "off")) send({ type: "autoUpdate.set", mode: input.value })
  })

/** What the relay calls this browser: the id agents pass, and its name. */
function showBrowser(browser: AgentRelayState["browser"]) {
  const line = element("browser-identity")
  if (!browser) {
    line.textContent = "Agents see this browser's name once it's connected."
    return
  }
  const id = document.createElement("code")
  id.textContent = browser.id
  line.replaceChildren("Agents call this browser ", id, ` (${browser.name}).`)
}
const showBrowserName = (value: unknown) => (element<HTMLInputElement>("browser-name").value = typeof value === "string" ? value : "")
void chrome.storage.local.get(BROWSER_NAME_KEY).then((stored) => showBrowserName(stored[BROWSER_NAME_KEY]))
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && BROWSER_NAME_KEY in changes) showBrowserName(changes[BROWSER_NAME_KEY]?.newValue)
})
element<HTMLFormElement>("browser-name-form").addEventListener("submit", (event) => {
  event.preventDefault()
  const name = element<HTMLInputElement>("browser-name").value.trim().slice(0, 60)
  // The background reconnects on the change, and the relay names the browser afresh.
  void (name ? chrome.storage.local.set({ [BROWSER_NAME_KEY]: name }) : chrome.storage.local.remove(BROWSER_NAME_KEY))
    .then(() => flash(element<HTMLFormElement>("browser-name-form").querySelector("button")!, "Saved"))
})

/** A short line in the first-run card, for what happened to a pairing code or install's link. */
function showStepNote(text: string) {
  const note = element("step-note")
  note.replaceChildren(...rich(text))
  note.hidden = false
}

/** Text with `code` spans, as elements. */
function rich(text: string): (string | HTMLElement)[] {
  return text.split(/`([^`]+)`/).map((part, index) => {
    if (index % 2 === 0) return part
    const code = document.createElement("code")
    code.textContent = part
    return code
  })
}

const resetButton = (button: HTMLButtonElement, label: string) => {
  button.disabled = false
  button.textContent = label
}

/** The first-run card: a title, a line or two, and only the controls this step needs. */
function renderStep() {
  const step = firstRunStep(current, installTab ? "install-waiting" : probe)
  const view = stepView(step)
  const card = element("first-run")
  // A note belongs to the step it was shown in.
  if (card.dataset.step !== step.kind) element("step-note").hidden = true
  card.dataset.step = step.kind
  card.dataset.tone = view.tone
  element("step-title").textContent = view.title
  element("step-text").replaceChildren(...rich(view.text))
  element("install-command").textContent = view.command ?? ""
  element("step-command").hidden = view.command === undefined
  element("step-agent").hidden = step.kind !== "install"
  element("step-code-form").hidden = view.codeLabel === undefined
  element("step-code-label").hidden = view.codeLabel === undefined
  element("step-code-label").replaceChildren(...rich(view.codeLabel ?? ""))
  element("step-example").hidden = !view.example
  element("open-extensions").hidden = step.kind !== "update-extension"
  element("step-reconnect").hidden = step.kind !== "conflict" && step.kind !== "mismatch"
  element("step-actions").hidden = element("open-extensions").hidden && element("step-reconnect").hidden
  const footnote = element("step-footnote")
  footnote.hidden = view.footnote === undefined
  if (view.footnote !== undefined) footnote.replaceChildren(...view.footnote)
  showPinHint(step.kind === "connected" || (step.kind === "waiting" && step.pairing === "token"))
}

type StepView = {
  title: string
  text: string
  tone: "neutral" | "ok" | "warn"
  /** A command to copy, in the box under the text. */
  command?: string
  /** What to enter in the pairing code field, shown above it (the field shows only with a label). */
  codeLabel?: string
  /** Show the example prompt to try. */
  example?: boolean
  footnote?: (string | HTMLElement)[]
}

const INSTALL = "npx @opencode/browse install"
const isUnpackedExtension = (unpacked: boolean | undefined) => Boolean(unpacked || chrome.runtime.id === unpackedExtensionId)

function stepView(step: FirstRunStep): StepView {
  const here = (remote: string | undefined) => (remote ? `the relay at ${remote}` : "the relay on this computer")
  switch (step.kind) {
    case "checking":
      return { title: "Checking…", text: "", tone: "neutral" }
    case "finishing":
      return { title: "Finishing setup from your terminal…", text: "Keep install running. This page will update when Browse connects.", tone: "neutral" }
    case "install": {
      const advanced = document.createElement("a")
      advanced.href = "#connection"
      advanced.textContent = "Advanced: connection"
      return {
        title: "Run this once in your terminal",
        text: "It installs the relay, adds the `browse` tools to your agent and pairs them with this browser. It needs Node.js 22.19 or newer. This page updates by itself when it's done.",
        tone: "neutral",
        command: INSTALL,
        footnote: ["Is your agent on another computer? See ", advanced, " below."],
      }
    }
    case "pair": {
      const why =
        step.reason === "code-rejected"
          ? `${capitalized(here(step.remote))} didn't accept the pairing code: it was mistyped, already used or expired.`
          : step.reason === "refused"
            ? `${capitalized(here(step.remote))} refused this browser's pairing: it was unpaired there, or that relay is a new install.`
            : `Browse found ${here(step.remote)}, but this browser isn't paired with it yet.`
      if (step.remote)
        return { title: "Almost there", text: why, tone: "warn", codeLabel: "Run `npx @opencode/browse pair` on that computer and enter the code it prints:" }
      return {
        title: "Almost there",
        text: `${why} Run install again: it opens this page with a one-time code and pairs by itself.`,
        tone: "warn",
        command: INSTALL,
        codeLabel: "Or enter the code `npx @opencode/browse pair` prints:",
      }
    }
    case "waiting":
      if (step.pairing === "code")
        return {
          title: "Code saved",
          text: `It pairs as soon as ${here(step.remote)} runs, within 10 minutes of \`pair\`. The relay starts when an agent uses the browse tools.`,
          tone: "neutral",
        }
      return {
        title: "Ready",
        text: `Browse is paired with ${here(step.remote)}, which starts when an agent uses the browse tools. Restart your agent if it was open during setup, then ask it to open a page. For example:`,
        tone: "neutral",
        example: true,
      }
    case "connecting":
      return { title: step.pairing ? "Pairing…" : "Connecting…", text: `Talking to ${here(step.remote)}.`, tone: "neutral" }
    case "connected": {
      const confirmation = pairedBy || step.remote ? `Paired with ${here(step.remote)}. ` : ""
      if (step.tabs)
        return { title: "Connected", text: `${confirmation}Agents are using ${step.tabs} tab${step.tabs === 1 ? "" : "s"}.`, tone: "ok" }
      return {
        title: "Connected",
        text: `${confirmation}Restart your agent, then ask it to open a page. For example:`,
        tone: "ok",
        example: true,
      }
    }
    case "update-cli":
      return {
        title: "Update the browse CLI",
        text: "This extension is newer than the browse CLI on this computer. Run this, then restart your agent. (With automatic updates on, the CLI catches up by itself within a day.)",
        tone: "warn",
        command: "npx @opencode/browse@latest install",
      }
    case "update-extension":
      return isUnpackedExtension(step.unpacked)
        ? { title: "Update this extension", text: unpackedReloadAdvice, tone: "warn" }
        : {
            title: "Update this extension",
            text: "It's older than the browse CLI on this computer. Chrome updates it within a few hours; to update now, open the extensions page, turn on Developer mode and click Update.",
            tone: "warn",
          }
    case "mismatch":
      return { title: "Versions don't match", text: "This extension and the browse CLI on this computer don't match. Run install again, then click Reconnect.", tone: "warn", command: INSTALL }
    case "conflict":
      return {
        title: "Another browser is connected",
        text: "Browse in another browser or profile holds the relay's connection. Close it there (or quit that browser), then click Reconnect.",
        tone: "warn",
      }
  }
}

/**
 * Asks this computer's relay port whether a browse relay answers (its /version is open), while the extension has no
 * token or code to connect with. One probe at a time, and again while the page stays in that state.
 */
let probing = false
let probeTimer: ReturnType<typeof setTimeout> | undefined
async function probeRelay() {
  if (probing || probeTimer !== undefined) return
  probing = true
  const port = /:(\d+)$/.exec(current?.relay.address ?? "")?.[1]
  let result: Exclude<RelayProbe, "unknown"> = "absent"
  if (port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/version`, { headers: { "x-browse-install": "probe" }, cache: "no-store", signal: AbortSignal.timeout(2_000) })
      result = relayProbeResult(response.status, await response.json().catch(() => undefined))
    } catch {
      result = "absent"
    }
  }
  probing = false
  if (result !== probe) {
    probe = result
    renderStep()
  }
  probeTimer = setTimeout(() => {
    probeTimer = undefined
    if (shouldProbe(current)) void probeRelay()
  }, 3_000)
}

/** Chrome hides a new extension's button in the Extensions menu; say how to pin it, until it is. */
let pinned: boolean | undefined
let pinWanted = false
function showPinHint(wanted: boolean) {
  pinWanted = wanted
  element("pin-hint").hidden = !wanted || pinned !== false
}
const readPinned = () =>
  chrome.action
    .getUserSettings()
    .then((settings) => {
      pinned = settings.isOnToolbar
      showPinHint(pinWanted)
    })
    .catch(() => undefined)
void readPinned()
// Chrome 130 tells; older ones are asked again when the user comes back to the page.
chrome.action.onUserSettingsChanged?.addListener(() => void readPinned())
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void readPinned()
})

/**
 * What the card's pairing code led to. The card itself shows most outcomes (Connected, Code saved, a refused code);
 * only a malformed code or a relay that's slow to answer need a line of their own.
 */
function showCodeResult(result: AgentRelayState["status"] | "invalid-address" | "invalid-code", address = "") {
  resetButton(element<HTMLFormElement>("step-code-form").querySelector("button")!, "Pair")
  if (result === "connected") pairedBy = "code"
  if (result === "invalid-code") showStepNote("That isn't a pairing code. Enter the 8 characters `npx @opencode/browse pair` prints (XXXX-XXXX).")
  else element<HTMLInputElement>("step-code").value = ""
  if (result === "connecting")
    showStepNote(`The relay ${address.startsWith("localhost:") ? "on this computer" : `at ${address}`} hasn't answered yet. This updates when it does.`)
  renderStep()
}
element<HTMLFormElement>("step-code-form").addEventListener("submit", (event) => {
  event.preventDefault()
  const code = element<HTMLInputElement>("step-code").value
  if (!code.trim()) return element<HTMLInputElement>("step-code").focus()
  const button = element<HTMLFormElement>("step-code-form").querySelector("button")!
  button.disabled = true
  button.textContent = "Pairing…"
  element("step-note").hidden = true
  connectFrom = "card"
  send({ type: "relay.connect", address: current?.relay.address ?? "", code })
})

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** What Connect led to, under the form. */
function showRelayResult(result: AgentRelayState["status"] | "invalid-address" | "invalid-code", address = "") {
  resetButton(element<HTMLFormElement>("relay-form").querySelector("button")!, "Connect")
  const local = address.startsWith("localhost:")
  const codeSent = current?.pairing === "code"
  const at = local ? `on this computer (${address})` : `at ${address}`
  const text = {
    "invalid-address": "That isn't an address. Use localhost, or a host or IP with an optional port: 100.64.0.2 or devbox.tailnet.ts.net:19988.",
    "invalid-code": "That isn't a pairing code. Enter the 8 characters `npx @opencode/browse pair` prints on the relay's computer (XXXX-XXXX).",
    connected: `Connected to the relay ${at}.`,
    connecting: `The relay ${at} hasn't answered yet. The status above updates when it does.`,
    offline: codeSent
      ? `Code saved. No relay answered ${at} yet; it pairs as soon as one runs there (within 10 minutes of \`pair\`).`
      : local
      ? `No relay answered ${at}. It starts the first time an agent uses the browse tools.`
      : `No relay answered ${at}. Check the address, that an agent has started the relay there, and that \`npx @opencode/browse set hostname 0.0.0.0\` was run there.`,
    unpaired: `The relay ${at} answered, but this browser isn't paired with it. Run \`npx @opencode/browse pair\` there and enter the code it prints.`,
    untrusted: `The relay ${at} didn't accept the pairing. Run \`npx @opencode/browse pair\` there and enter the new code it prints.`,
    conflict: `The relay ${at} answered, but Browse in another browser or profile is connected to it.`,
    incompatible: `The relay ${at} and this extension speak different protocols. See the status above.`,
  }[result]
  const note = element("relay-result")
  note.textContent = text
  note.hidden = false
  if (result !== "invalid-code") element<HTMLInputElement>("relay-code").value = ""
}
// The relay field shows where the extension connects (localhost:19988 for this computer), unless the user is editing it.
const relayField = element<HTMLInputElement>("relay-address")
let relayEdited = false
relayField.addEventListener("input", () => (relayEdited = true))
function showRelayAddress(address: string) {
  if (!relayEdited && document.activeElement !== relayField) relayField.value = address
}
element<HTMLFormElement>("relay-form").addEventListener("submit", (event) => {
  event.preventDefault()
  relayEdited = false
  const button = element<HTMLFormElement>("relay-form").querySelector("button")!
  button.disabled = true
  button.textContent = "Connecting…"
  element("relay-result").hidden = true
  connectFrom = "advanced"
  send({ type: "relay.connect", address: element<HTMLInputElement>("relay-address").value, code: element<HTMLInputElement>("relay-code").value })
})

function describe(state: AgentRelayState) {
  const tabs = state.tabs.length
  const remote = state.relay.remote ? state.relay.address : undefined
  if (state.status === "connected") {
    const connected = remote ? `Connected to the relay at ${remote}.` : "Connected."
    return tabs ? `${connected} Agents are using ${tabs} tab${tabs === 1 ? "" : "s"}.` : `${connected} No agent is using a tab yet.`
  }
  if (state.status === "connecting") return "Connecting to the relay…"
  if (state.status === "conflict")
    return "Browse in another browser or profile is connected. Close it there (or quit that browser), then click Reconnect."
  if (state.status === "incompatible" && state.skew === "update-cli")
    return "This extension is newer than the browse CLI on this computer. Update the CLI: run `npx @opencode/browse@latest install` (with automatic updates on, it catches up by itself within a day), then click Reconnect."
  if (state.status === "incompatible" && state.skew === "update-extension")
    return isUnpackedExtension(state.unpacked)
      ? unpackedReloadAdvice
      : "This extension is older than the browse CLI on this computer. Chrome updates it within a few hours; to update now, open chrome://extensions, turn on Developer mode and click Update."
  if (state.status === "incompatible")
    return "This extension and the installed CLI don't match. Run the install command again, then click Reconnect."
  if (state.status === "unpaired") return "Not paired yet. Run the install command at the top, or enter a pairing code below; until then no agent can use this browser."
  if (state.status === "untrusted" && remote)
    return `The relay at ${remote} didn't pair with this browser, so it was refused. Enter a new pairing code from it below.`
  if (state.status === "untrusted")
    return state.unpacked
      ? "The relay on this computer didn't pair with this browser, so it was refused. Run the install command again (or enter a code from `npx @opencode/browse pair` below), then click Connect."
      : "The relay on this computer didn't pair with this browser, so it was refused. Enter a new code from `npx @opencode/browse pair` below, or update the CLI."
  if (remote) return `Waiting for the relay at ${remote}. It starts the first time an agent there uses the browse tools.`
  return "Waiting for an agent. The relay starts the first time an agent uses the browse tools."
}

const flash = (button: HTMLButtonElement, label: string) => {
  const original = button.textContent
  button.textContent = label
  setTimeout(() => (button.textContent = original), 1500)
}

/**
 * Binds a group of radio buttons (fieldset `name`, inputs `name=name`) to a storage key: `read` turns the stored value
 * into the radio value to check (unknown values read as the default), `write` a chosen radio value into what's stored.
 */
function bindChoice(name: string, key: string, read: (stored: unknown) => string, write: (value: string) => unknown = (value) => value) {
  const inputs = Array.from(element(name).querySelectorAll<HTMLInputElement>(`input[name=${name}]`))
  const show = (value: unknown) => {
    const chosen = read(value)
    for (const input of inputs) input.checked = input.value === chosen
  }
  void chrome.storage.local.get(key).then((stored) => show(stored[key]))
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && key in changes) show(changes[key]?.newValue)
  })
  for (const input of inputs)
    input.addEventListener("change", () => {
      if (input.checked) void chrome.storage.local.set({ [key]: write(input.value) })
    })
}
// Where agents open new tabs (agent-window.ts) and how they're grouped (agent-relay.ts), read when an agent opens one.
bindChoice("agent-window", AGENT_WINDOW_KEY, agentWindowPlacement)
bindChoice("agent-grouping", AGENT_GROUPING_KEY, agentGrouping)
// Minutes before an untouched agent tab closes, 0 for never (tab-cleanup.ts).
bindChoice("idle-minutes", IDLE_MINUTES_KEY, (value) => String(idleMinutesSetting(value)), Number)
// Sent to the relay, which applies them from the next input.
bindChoice("agent-cursor", AGENT_CURSOR_KEY, agentCursor)
bindChoice("human-input", HUMAN_INPUT_KEY, humanInput)
bindChoice("handoff-notifications", HANDOFF_NOTIFICATIONS_KEY, handoffNotifications)

// A setting the relay's environment fixes wins over the page's; say so, with the value in effect.
const overrideNotes: { [Key in keyof RelayOverrides]-?: { variable: string; labels: Record<NonNullable<RelayOverrides[Key]>, string> } } = {
  agentWindow: { variable: "OPENCODE_BROWSER_AGENT_WINDOW", labels: { current: "in your window", separate: "in a separate window" } },
  cursor: { variable: "OPENCODE_BROWSER_GHOST_CURSOR", labels: { off: "off", always: "always shown" } },
  humanInput: { variable: "OPENCODE_BROWSER_HUMAN_INPUT", labels: { on: "on", off: "off" } },
}
function showOverrides(overrides: RelayOverrides | undefined) {
  for (const note of Array.from(document.querySelectorAll<HTMLElement>("[data-override]"))) {
    const key = note.dataset.override as keyof RelayOverrides
    const value = overrides?.[key]
    const known = overrideNotes[key]
    note.hidden = value === undefined || !known
    if (value === undefined || !known) continue
    const variable = document.createElement("code")
    variable.textContent = known.variable
    note.replaceChildren(`In effect: ${(known.labels as Record<string, string>)[value]}. Set by `, variable, " on the relay.")
  }
}

element<HTMLButtonElement>("copy-command").addEventListener("click", (event) => {
  const button = event.currentTarget as HTMLButtonElement
  void navigator.clipboard.writeText(element("install-command").textContent ?? "").then(() => flash(button, "Copied"))
})
element<HTMLButtonElement>("copy-example").addEventListener("click", (event) => {
  const button = event.currentTarget as HTMLButtonElement
  void navigator.clipboard.writeText(element("example-prompt").textContent ?? "").then(() => flash(button, "Copied"))
})
element<HTMLButtonElement>("open-extensions").addEventListener("click", () => void chrome.tabs.create({ url: "chrome://extensions" }))
element<HTMLButtonElement>("step-reconnect").addEventListener("click", () => send({ type: "agents.reconnect" }))
element<HTMLButtonElement>("copy-update").addEventListener("click", (event) => {
  const button = event.currentTarget as HTMLButtonElement
  void navigator.clipboard.writeText(element("update-command").textContent ?? "").then(() => flash(button, "Copied"))
})
element<HTMLButtonElement>("reconnect").addEventListener("click", () => send({ type: "agents.reconnect" }))
element<HTMLButtonElement>("cleanup").addEventListener("click", (event) => {
  send({ type: "tabs.cleanup" })
  flash(event.currentTarget as HTMLButtonElement, "Closed")
})
element<HTMLButtonElement>("diagnostics").addEventListener("click", (event) => {
  const button = event.currentTarget as HTMLButtonElement
  void chrome.runtime
    .sendMessage({ action: AGENT_DIAGNOSTICS })
    .then((response: { text?: string } | undefined) => navigator.clipboard.writeText(response?.text ?? "No diagnostics."))
    .then(() => flash(button, "Copied"))
})
