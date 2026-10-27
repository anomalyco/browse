// In-page status for tabs agents use through the OpenCode Browser relay: a "your turn" card when an agent hands
// the page to the user (logins, 2FA, passkeys, payments). While an agent is running it also removes other
// extensions' injected frames, which make Chrome drop the debugger. The background injects it (a classic
// script: content scripts cannot import modules) only into the top frame of tabs agents use, again after
// each navigation (src/background/page-scripts.ts).
//
// Pages must not be able to tell that agents use the tab, or to fake the user's answer: the script lives in
// the extension's isolated world, adds nothing to the page's DOM until a handoff waits for the user, and then
// shows the card in a closed shadow root on a host element without an id, in the top layer, restoring it when
// the page removes, hides or restyles it, and back on top when the page opens a dialog, popover or fullscreen
// element after it. Only a real click (event.isTrusted) on Continue completes the handoff.
// The toolbar badge shows the other states (ON, RUN).
import { pageStatusFromJson, type PageStatus } from "../agent-relay/protocol"

type Loaded = { __opencodeBrowserPageStatus?: true }

let current: PageStatus | undefined
let completing: string | undefined
let host: HTMLElement | undefined
let root: ShadowRoot | undefined
let observer: MutationObserver | undefined

// The background injects again after navigations; a document that already has the script keeps the first copy.
if (!(globalThis as Loaded).__opencodeBrowserPageStatus) {
  ;(globalThis as Loaded).__opencodeBrowserPageStatus = true
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (typeof message !== "object" || message === null || !("action" in message)) return
    if (message.action === "evict-extension-frames") {
      sendResponse({ removed: evictForeignFrames(document) })
      return
    }
    if (message.action === "page-status.clear") return clear()
    const status = "status" in message ? pageStatusFromJson(message.status) : undefined
    if (message.action !== "page-status.set" || !status) return
    current = status
    completing = undefined
    // Password managers stay usable while the tab is only lent or waits for the user; while an agent runs
    // the debugger comes first.
    if (status.state === "running") evictForeignFrames(document)
    render()
  })
  void chrome.runtime.sendMessage({ action: "page-status.ready" }).catch(() => undefined)
}

// A recorded tab never shows the card (the background sends it without one, and a notification instead).
function waiting() {
  return current?.state === "waiting" && current.handoffId !== undefined && !current.recording
}

function render() {
  if (!current) return
  const showing = waiting()
  if (!showing) removeHost()
  else if (document.documentElement) {
    const shadow = root ?? create()
    const pill = shadow.getElementById("pill")!
    pill.dataset.state = "waiting"
    shadow.getElementById("label")!.textContent = "Waiting for you"
    pill.title = [
      current.owner === "session" ? "An agent opened this tab" : "You let agents use this tab",
      current.sessionId ? `Session ${current.sessionId}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ")
    shadow.getElementById("message")!.textContent = current.message ?? "Finish this step, then continue."
    shadow.getElementById("origin")!.textContent = pageOrigin()
    const button = shadow.getElementById("continue") as HTMLButtonElement
    button.disabled = completing === current.handoffId
    button.textContent = completing === current.handoffId ? "Continuing…" : "Continue"
    raise()
  }
  // The observer sees only this world's view of the DOM; the page can't see or disconnect it.
  if ((current.state === "running" || showing) && document.documentElement) {
    observer ??= new MutationObserver((records) => {
      if (!current) return
      if (current.state === "running")
        for (const record of records) for (const node of record.addedNodes) evictForeignFrames(node)
      if (!waiting()) return
      // A dialog the page opens (showModal sets `open`) goes into the top layer above the card.
      if (records.some((record) => record.attributeName === "open" && record.target !== host && opened(record.target)))
        retop()
      else if (records.some((record) => record.target === host || !host?.isConnected)) raise()
    })
    observer.observe(document.documentElement, { childList: true, subtree: true, attributeFilter: ["open"] })
    if (host) observer.observe(host, { attributes: true })
  } else {
    observer?.disconnect()
    observer = undefined
  }
  watchTopLayer(showing)
}

/** Whether `node` is an open dialog, which may be modal and so above the card. */
function opened(node: Node) {
  return node instanceof HTMLDialogElement && node.open
}

let watching = false
/**
 * While the card shows, puts it back on top when the page puts something in the top layer after it: a popover or
 * modal dialog (toggle events, which don't bubble but reach a capturing listener; dialogs fire them in recent
 * Chrome, the observer above catches them in older ones) or a fullscreen element. Event-driven, so it costs nothing
 * while the page does neither. Over a modal dialog or a fullscreen element the card shows but Chrome makes it inert
 * like the rest of the page, so Continue takes clicks again once the dialog closes; the toolbar button works anyway.
 */
function watchTopLayer(on: boolean) {
  if (on === watching) return
  watching = on
  const method = on ? "addEventListener" : "removeEventListener"
  document[method]("toggle", onTopLayer, true)
  document[method]("fullscreenchange", onTopLayer, true)
}

function onTopLayer(event: Event) {
  if (!waiting() || event.target === host) return
  if (event.type === "toggle" && (event as ToggleEvent).newState !== "open") return
  if (event.type === "fullscreenchange" && !document.fullscreenElement) return
  retop()
}

/** Re-tops at most this often per second, so a page that keeps re-opening its own element can't loop with the card. */
const RETOPS_PER_SECOND = 10
let retops = { second: 0, count: 0 }

/** Moves the card to the top of the top layer: closing and opening a popover puts it last. */
function retop() {
  if (!host?.isConnected) return raise()
  const second = Math.floor(performance.now() / 1000)
  if (retops.second !== second) retops = { second, count: 0 }
  if (++retops.count > RETOPS_PER_SECOND) return
  try {
    if (host.matches(":popover-open")) host.hidePopover()
  } catch {
    // Not open; raise() opens it.
  }
  raise()
}

/** The page's origin as the user should read it: the site asking them to act. */
function pageOrigin() {
  const origin = location.origin
  return origin && origin !== "null" ? origin : location.protocol === "file:" ? location.href : "This page"
}

/** Puts the host back in the document and the top layer, without attributes a page may have set on it. */
function raise() {
  if (!host || !document.documentElement) return
  for (const name of host.getAttributeNames()) if (name !== "popover") host.removeAttribute(name)
  if (host.getAttribute("popover") !== "manual") host.setAttribute("popover", "manual")
  if (!host.isConnected) document.documentElement.append(host)
  try {
    if (!host.matches(":popover-open")) host.showPopover()
  } catch {
    // Another top-layer element (a modal dialog) can refuse it; the host still shows above the page.
  }
}

/**
 * Removes other extensions' frames and password-manager hosts (1Password's custom elements keep their UI in
 * closed shadow roots, so the host itself goes) from `root` and the open shadow roots inside it. A frame
 * from another extension makes Chrome refuse debugger commands or detach the debugger. Returns how many
 * elements it removed.
 */
function evictForeignFrames(root: Node): number {
  const own = `chrome-extension://${chrome.runtime.id}`
  const foreign = (element: Element) => {
    const tag = element.tagName.toLowerCase()
    if (
      tag.startsWith("com-1password-") ||
      element.hasAttribute("data-onepassword-extension") ||
      element.hasAttribute("data-lastpass-root") ||
      element.id.startsWith("bitwarden-")
    )
      return true
    if (tag !== "iframe" && tag !== "frame" && tag !== "object" && tag !== "embed") return false
    const src = element.getAttribute("src") ?? element.getAttribute("data") ?? ""
    return src.startsWith("chrome-extension://") && !src.startsWith(own)
  }
  let removed = 0
  const visit = (node: Element | Document | ShadowRoot) => {
    if (node instanceof Element && foreign(node)) {
      node.remove()
      removed++
      return
    }
    if (node instanceof Element && node.shadowRoot) visit(node.shadowRoot)
    for (const element of Array.from(node.querySelectorAll("*"))) {
      // Skip what went with an element removed earlier in this walk.
      if (!node.contains(element)) continue
      if (foreign(element)) {
        element.remove()
        removed++
        continue
      }
      if (element.shadowRoot) visit(element.shadowRoot)
    }
  }
  if (root instanceof Element || root instanceof Document || root instanceof ShadowRoot) visit(root)
  return removed
}

function create() {
  host = document.createElement("div")
  host.setAttribute("popover", "manual")
  root = host.attachShadow({ mode: "closed" })
  root.innerHTML = `<style>${STYLE}</style>
    <div id="vignette"></div>
    <div id="card" role="dialog" aria-labelledby="title" aria-describedby="message">
      <div id="head"><span id="dot"></span><span id="title">Your turn</span><span id="source">${MARK}OpenCode Browser</span></div>
      <p id="origin"></p>
      <p id="message"></p>
      <div id="actions"><button id="continue" type="button">Continue</button></div>
    </div>
    <div id="pill" role="status" aria-live="polite">${MARK}<span id="label"></span><span id="light"></span></div>`
  root.getElementById("continue")!.addEventListener("click", (event) => {
    // Page scripts can't reach the closed root, and only the user's own click counts.
    if (!event.isTrusted) return
    const handoffId = current?.handoffId
    if (!handoffId || completing === handoffId) return
    completing = handoffId
    render()
    void chrome.runtime.sendMessage({ action: "handoff.complete", handoffId }).catch(() => {
      completing = undefined
      render()
    })
  })
  // The page can close the popover (hidePopover); open it again while the handoff waits.
  host.addEventListener("toggle", () => {
    if (waiting()) queueMicrotask(raise)
  })
  return root
}

function removeHost() {
  host?.remove()
  host = undefined
  root = undefined
}

function clear() {
  current = undefined
  completing = undefined
  observer?.disconnect()
  observer = undefined
  watchTopLayer(false)
  removeHost()
}

const MARK = `<svg class="mark" viewBox="0 0 16 20" width="9" height="11" aria-hidden="true"><path d="M12 16H4V8h8v8Z" fill="currentColor" opacity=".45"/><path d="M12 4H4v12h8V4Zm4 16H0V0h16v20Z" fill="currentColor"/></svg>`

// Colors follow the color scheme preference; the page itself may be light or dark either way, so both
// surfaces are opaque enough to read on anything. Fonts are system fonts only: a page's own @font-face
// rules apply inside the shadow root, so a family like "Inter" could resolve to the site's file.
const STYLE = `
  :host { all: initial !important; display: block !important; position: fixed !important; inset: 0 !important;
    width: auto !important; height: auto !important; margin: 0 !important; padding: 0 !important; border: 0 !important;
    background: transparent !important; overflow: visible !important; z-index: 2147483647 !important;
    pointer-events: none !important; }
  * { box-sizing: border-box; }
  #pill, #card { --bg: #161616; --fg: #ededed; --muted: #a0a0a0; --faint: #707070; --ring: rgba(255,255,255,.09);
    --running: #f5a524; --waiting: #4c8dff; --idle: #7a7a7a; --button: #ededed; --button-fg: #111; --button-hover: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-style: normal;
    font-synthesis: none; text-transform: none; text-align: left; -webkit-font-smoothing: antialiased; color: var(--fg); }
  #pill { position: absolute; right: 12px; bottom: 12px; display: inline-flex; align-items: center; gap: 7px; height: 26px;
    padding: 0 10px 0 9px; border-radius: 999px; background: color-mix(in srgb, var(--bg) 92%, transparent);
    box-shadow: 0 0 0 1px var(--ring), 0 6px 16px rgba(0,0,0,.22); backdrop-filter: blur(10px);
    font-size: 12px; font-weight: 500; line-height: 26px; letter-spacing: -.01em; white-space: nowrap; }
  .mark { flex: none; display: block; }
  #pill .mark { color: var(--fg); }
  #label { display: block; }
  #light { flex: none; width: 6px; height: 6px; border-radius: 999px; background: var(--idle); }
  #pill[data-state="waiting"] #light { background: var(--waiting); box-shadow: 0 0 0 3px color-mix(in srgb, var(--waiting) 24%, transparent); }
  #vignette { position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 2px rgba(76,141,255,.55), inset 0 0 80px rgba(76,141,255,.10);
    animation: fade .3s ease-out both; }
  #card { position: absolute; right: 12px; bottom: 48px; width: 320px; max-width: calc(100vw - 24px); padding: 12px 12px 12px 14px;
    border-radius: 12px; background: var(--bg); pointer-events: auto; user-select: text;
    box-shadow: 0 0 0 1px var(--ring), 0 18px 44px rgba(0,0,0,.34); animation: enter .22s cubic-bezier(.2,.8,.2,1) both; }
  #head { display: flex; align-items: center; gap: 8px; height: 20px; }
  #dot { flex: none; width: 7px; height: 7px; border-radius: 999px; background: var(--waiting);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--waiting) 24%, transparent); }
  #title { font-size: 13px; font-weight: 600; line-height: 20px; letter-spacing: -.01em; }
  #source { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; color: var(--faint); font-size: 11.5px;
    font-weight: 500; line-height: 20px; }
  #source .mark { width: 7px; height: 9px; }
  #origin { margin: 6px 0 0; color: var(--fg); font-size: 12px; font-weight: 500; line-height: 17px; overflow-wrap: anywhere; }
  #message { margin: 6px 0 12px; color: var(--muted); font-size: 13px; line-height: 19px; overflow-wrap: anywhere; }
  #actions { display: flex; justify-content: flex-end; }
  #continue { all: unset; box-sizing: border-box; cursor: pointer; height: 28px; padding: 0 12px; border-radius: 7px;
    background: var(--button); color: var(--button-fg); font-family: inherit; font-size: 13px; font-weight: 500; line-height: 28px;
    transition: background-color .12s; }
  #continue:hover { background: var(--button-hover); }
  #continue:focus-visible { outline: 2px solid var(--waiting); outline-offset: 2px; }
  #continue:disabled { cursor: default; opacity: .6; }
  @media (prefers-color-scheme: light) {
    #pill, #card { --bg: #ffffff; --fg: #171717; --muted: #5f5f5f; --faint: #8f8f8f; --ring: rgba(0,0,0,.09);
      --running: #d97706; --waiting: #2563eb; --idle: #a3a3a3; --button: #171717; --button-fg: #fff; --button-hover: #000; }
    #pill { box-shadow: 0 0 0 1px var(--ring), 0 6px 16px rgba(0,0,0,.10); }
    #card { box-shadow: 0 0 0 1px var(--ring), 0 18px 44px rgba(0,0,0,.14); }
  }
  @keyframes fade { from { opacity: 0; } }
  @keyframes enter { from { opacity: 0; transform: translateY(6px) scale(.98); } }
  @media (prefers-reduced-motion: reduce) { #light, #card, #vignette { animation: none !important; } }
`
