// The status page (welcome.html): opened on install and as the extension's options page. Shows the install command
// and the relay connection (with the update the relay found, if any), offers reconnect, cleanup, and diagnostics, and
// sets where agents open their tabs.
import {
  AGENT_DIAGNOSTICS,
  AGENT_WINDOW_KEY as PLACEMENT_KEY,
  STATUS_PORT,
  type AgentRelayState,
  type FromStatusPage,
  type ToStatusPage,
} from "../shared/protocol"

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = element<HTMLParagraphElement>("status")
element("extension-id").textContent = chrome.runtime.id

let port: chrome.runtime.Port | undefined
const connect = () => {
  const next = chrome.runtime.connect({ name: STATUS_PORT })
  port = next
  next.onMessage.addListener((message: ToStatusPage) => {
    if (message.type === "agents") render(message.state)
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
  status.dataset.state = state.status
  status.textContent = describe(state)
  // An unpacked build is paired by install; a store build pairs here (and can be paired again).
  element("pairing").hidden = state.pairing === "bundled" && state.status !== "untrusted"
  element("update").hidden = !state.update
  element("update-summary").textContent = state.update ? capitalized(state.update.summary) : ""
  element("update-command").textContent = state.update?.command ?? ""
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

function describe(state: AgentRelayState) {
  const tabs = state.tabs.length
  if (state.status === "connected")
    return tabs ? `Connected. Agents are using ${tabs} tab${tabs === 1 ? "" : "s"}.` : "Connected. No agent is using a tab yet."
  if (state.status === "connecting") return "Connecting to the relay…"
  if (state.status === "conflict")
    return "OpenCode Browser in another browser or profile is connected. Close it there (or quit that browser), then click Reconnect."
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

// Where agents open new tabs (agent-window.ts reads it when an agent opens one).
const placements = Array.from(element("agent-window").querySelectorAll<HTMLInputElement>("input[name=agent-window]"))
const showPlacement = (value: unknown) => {
  const chosen = value === "separate" ? "separate" : "current"
  for (const input of placements) input.checked = input.value === chosen
}
void chrome.storage.local.get(PLACEMENT_KEY).then((stored) => showPlacement(stored[PLACEMENT_KEY]))
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && PLACEMENT_KEY in changes) showPlacement(changes[PLACEMENT_KEY]?.newValue)
})
for (const input of placements)
  input.addEventListener("change", () => {
    if (input.checked) void chrome.storage.local.set({ [PLACEMENT_KEY]: input.value })
  })

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
