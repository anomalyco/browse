// The status page (welcome.html): opened on install and as the extension's options page. Shows the install command
// and the relay connection (with the update the relay found, if any), offers reconnect, cleanup, and diagnostics, and
// holds the settings: where agent tabs open and how they're grouped and closed, the agent cursor, human-like input,
// and handoff notifications. Each is a chrome.storage.local key the background reads when it needs it (or sends to the
// relay, for the cursor and input); a setting the relay's environment fixes is shown as such.
import {
  AGENT_CURSOR_KEY,
  AGENT_DIAGNOSTICS,
  AGENT_GROUPING_KEY,
  AGENT_WINDOW_KEY,
  DEFAULT_IDLE_MINUTES,
  HANDOFF_NOTIFICATIONS_KEY,
  HUMAN_INPUT_KEY,
  IDLE_MINUTES_KEY,
  STATUS_PORT,
  agentCursor,
  agentGrouping,
  handoffNotifications,
  humanInput,
  type AgentRelayState,
  type FromStatusPage,
  type RelayOverrides,
  type ToStatusPage,
} from "../shared/protocol"

// `npx @opencode/browse install` opens this page as welcome.html#ticket=<one-time ticket> for a store build
// (cli/src/setup.ts pairStoreExtension). Take it, then drop it from the URL (address bar and history) before anything else.
let fragmentTicket = /^#ticket=([0-9A-Za-z-]{16,64})$/.exec(location.hash)?.[1]
if (location.hash.startsWith("#ticket=") || location.hash.startsWith("#pair=")) history.replaceState(null, "", location.pathname + location.search)

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = element<HTMLParagraphElement>("status")
element("extension-id").textContent = chrome.runtime.id

let port: chrome.runtime.Port | undefined
const connect = () => {
  const next = chrome.runtime.connect({ name: STATUS_PORT })
  port = next
  next.onMessage.addListener((message: ToStatusPage) => {
    if (message.type === "agents") render(message.state)
    if (message.type === "pairing.ticket.result")
      showPairingNote(message.ok ? "Pairing with the relay on this computer…" : "Already paired with the relay; the pairing link from install was ignored.")
    if (message.type === "pairing.result") {
      const button = element<HTMLButtonElement>("pairing-form").querySelector("button")!
      if (message.ok) element<HTMLInputElement>("pairing-code").value = ""
      flash(button, message.ok ? "Paired" : "Not a code")
    }
  })
  // The worker can stop and restart at any time; follow it.
  next.onDisconnect.addListener(() => {
    void chrome.runtime.lastError
    if (port === next) setTimeout(connect, 300)
  })
}
connect()

const send = (message: FromStatusPage) => port?.postMessage(message)

function render(state: AgentRelayState) {
  // The ticket from install's URL, used once, and only when this extension isn't paired with the relay (no code, or one
  // the relay refused). A working pairing is never replaced; the page says it ignored the link instead.
  // While it's still connecting (or the relay is starting), wait for a status that tells.
  if (fragmentTicket && state.status !== "offline" && state.status !== "connecting") {
    if (state.status === "unpaired" || state.status === "untrusted") send({ type: "pairing.ticket", ticket: fragmentTicket })
    else showPairingNote("Already paired with the relay; the pairing link from install was ignored.")
    fragmentTicket = undefined
  }
  status.dataset.state = state.status
  status.textContent = describe(state)
  // An unpacked build is paired by install; a store build pairs here (and can be paired again).
  element("pairing").hidden = state.pairing === "bundled" && state.status !== "untrusted"
  element("update").hidden = !state.update
  element("update-summary").textContent = state.update ? capitalized(state.update.summary) : ""
  element("update-command").textContent = state.update?.command ?? ""
  showOverrides(state.overrides)
  showAutoUpdate(state.autoUpdate)
  if (state.status === "connected" && element("pairing-note").textContent?.startsWith("Pairing with")) showPairingNote("Paired with the relay on this computer.")
  if (state.ticketRejected && state.status !== "connected")
    showPairingNote("The pairing link from install expired or was already used. Run `npx @opencode/browse pair` and paste the code below.")
}

/** The relay's update setting: shown for an npm install (a checkout updates with `update`; the notice above says so). */
function showAutoUpdate(autoUpdate: AgentRelayState["autoUpdate"]) {
  element("updates").hidden = autoUpdate?.install !== "npm"
  if (!autoUpdate || autoUpdate.install !== "npm") return
  for (const input of Array.from(element("auto-update").querySelectorAll<HTMLInputElement>("input[name=auto-update]")))
    input.checked = input.value === autoUpdate.mode
  const facts = [
    autoUpdate.version ? `Installed: ${autoUpdate.version}${autoUpdate.channel === "beta" ? " (beta channel)" : ""}.` : "",
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

/** A short line under the status, for what happened to install's pairing link. */
function showPairingNote(text: string) {
  const note = element("pairing-note")
  note.textContent = text
  note.hidden = false
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

function describe(state: AgentRelayState) {
  const tabs = state.tabs.length
  if (state.status === "connected")
    return tabs ? `Connected. Agents are using ${tabs} tab${tabs === 1 ? "" : "s"}.` : "Connected. No agent is using a tab yet."
  if (state.status === "connecting") return "Connecting to the relay…"
  if (state.status === "conflict")
    return "OpenCode Browser in another browser or profile is connected. Close it there (or quit that browser), then click Reconnect."
  if (state.status === "incompatible" && state.skew === "update-cli")
    return "This extension is newer than the browse CLI on this computer. Update the CLI: run `npx @opencode/browse@latest install` (with automatic updates on, it catches up by itself within a day), then click Reconnect."
  if (state.status === "incompatible" && state.skew === "update-extension")
    return state.pairing === "bundled"
      ? "This extension is older than the browse CLI on this computer. Run the install command again to update it, then click Reconnect."
      : "This extension is older than the browse CLI on this computer. Chrome updates it within a few hours; to update now, open chrome://extensions, turn on Developer mode and click Update."
  if (state.status === "incompatible")
    return "This extension and the installed CLI don't match. Run the install command again, then click Reconnect."
  if (state.status === "unpaired") return "Not paired yet. Enter the pairing code below; until then no agent can use this browser."
  if (state.status === "untrusted")
    return state.pairing === "bundled"
      ? "The relay on this computer didn't pair with this extension, so it was refused. Run the install command again (or update the CLI), then click Reconnect."
      : "The relay on this computer didn't pair with this extension, so it was refused. Check the pairing code below, or update the CLI."
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
bindChoice("agent-window", AGENT_WINDOW_KEY, (value) => (value === "separate" ? "separate" : "current"))
bindChoice("agent-grouping", AGENT_GROUPING_KEY, agentGrouping)
// Minutes before an untouched agent tab closes, 0 for never (tab-cleanup.ts).
bindChoice(
  "idle-minutes",
  IDLE_MINUTES_KEY,
  (value) => String(typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_MINUTES),
  Number,
)
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
element<HTMLButtonElement>("copy-update").addEventListener("click", (event) => {
  const button = event.currentTarget as HTMLButtonElement
  void navigator.clipboard.writeText(element("update-command").textContent ?? "").then(() => flash(button, "Copied"))
})
element<HTMLFormElement>("pairing-form").addEventListener("submit", (event) => {
  event.preventDefault()
  send({ type: "pairing.set", code: element<HTMLInputElement>("pairing-code").value })
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
