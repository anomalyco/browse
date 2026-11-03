// What the onboarding and settings pages share: the color scheme, the port to the worker, stored settings as signals,
// and a few small pieces of UI built on @opencode/ui.
import { createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { Button } from "@opencode/ui/button"
import {
  STATUS_PORT,
  type AgentRelayState,
  type FromStatusPage,
  type ToStatusPage,
} from "../shared/protocol"
import { richParts } from "./describe"
import "./pages.css"

/** The opencode dark theme, unless the system asks for light. */
export function applyColorScheme() {
  const light = matchMedia("(prefers-color-scheme: light)")
  const apply = () => (document.documentElement.dataset.colorScheme = light.matches ? "light" : "dark")
  apply()
  light.addEventListener("change", apply)
}

/**
 * The status port to the worker: its latest state, and every other message as it arrives. The worker can stop and
 * restart at any time; the port follows it, and `onMessage` listeners hear `undefined` when a reply was lost with it.
 */
export function createRelay() {
  const [state, setState] = createSignal<AgentRelayState>()
  const listeners = new Set<(message: ToStatusPage | undefined) => void>()
  let port: chrome.runtime.Port | undefined
  const connect = () => {
    const next = chrome.runtime.connect({ name: STATUS_PORT })
    port = next
    next.onMessage.addListener((message: ToStatusPage) => {
      if (message.type === "agents") setState(message.state)
      for (const listener of listeners) listener(message)
    })
    next.onDisconnect.addListener(() => {
      void chrome.runtime.lastError
      for (const listener of listeners) listener(undefined)
      if (port === next) setTimeout(connect, 300)
    })
  }
  connect()
  return {
    state,
    send: (message: FromStatusPage) => port?.postMessage(message),
    onMessage(listener: (message: ToStatusPage | undefined) => void) {
      listeners.add(listener)
      onCleanup(() => listeners.delete(listener))
    },
  }
}
export type Relay = ReturnType<typeof createRelay>

/** A chrome.storage.local key as a signal: `read` turns what's stored (or nothing) into the value. */
export function createStored<T>(key: string, read: (stored: unknown) => T) {
  const [value, setValue] = createSignal<T>(read(undefined))
  void chrome.storage.local.get(key).then((stored) => setValue(() => read(stored[key])))
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && key in changes) setValue(() => read(changes[key]?.newValue))
  }
  chrome.storage.onChanged.addListener(changed)
  onCleanup(() => chrome.storage.onChanged.removeListener(changed))
  const save = (next: unknown) => void chrome.storage.local.set({ [key]: next })
  return [value, save] as const
}

/** Text with `code` spans. */
export function Rich(props: { text: string }) {
  return (
    <For each={richParts(props.text)}>{(part) => (part.code ? <code>{part.text}</code> : part.text)}</For>
  )
}

/** A label that says what a button just did, then goes back. */
export function createFlash(label: string, done: string) {
  const [text, setText] = createSignal(label)
  let timer: ReturnType<typeof setTimeout> | undefined
  const flash = () => {
    setText(done)
    clearTimeout(timer)
    timer = setTimeout(() => setText(label), 1500)
  }
  onCleanup(() => clearTimeout(timer))
  return [text, flash] as const
}

/** A command or prompt to copy, in monospace, with a Copy button. */
export function CopyBox(props: { text: string; label?: string }) {
  const [label, flash] = createFlash("Copy", "Copied")
  return (
    <div class="copy-box" aria-label={props.label}>
      <code>{props.text}</code>
      <Button
        size="small"
        variant="ghost"
        icon={label() === "Copied" ? "check" : "copy"}
        onClick={() => void navigator.clipboard.writeText(props.text).then(flash)}
      >
        {label()}
      </Button>
    </div>
  )
}

/** The browse mark and name, with an optional page name and something on the right. */
export function Brand(props: { page?: string; end?: JSX.Element }) {
  return (
    <header class="brand">
      <img src="/icons/icon-48.png" width="24" height="24" alt="" />
      <span class="brand-name">browse</span>
      <Show when={props.page}>
        <span class="brand-page">{props.page}</span>
      </Show>
      <span class="brand-end">{props.end}</span>
    </header>
  )
}

/** A line in a tone: neutral, good or a warning. */
export function Note(props: { tone?: "ok" | "warn" | "neutral"; children: JSX.Element }) {
  return (
    <p class="note" data-tone={props.tone ?? "neutral"}>
      {props.children}
    </p>
  )
}
