// The onboarding page (onboarding.html): opened on install, and by the toolbar button while this browser isn't paired.
// One page, a live checklist: run install for your agent (or connect to a relay on another computer), pin Browse to
// the toolbar, try a prompt. Each step checks itself off from the worker's state, chrome.action's toolbar setting and
// the first agent tab; the step to do now is the first that isn't done.
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { TextInput } from "@opencode/ui/text-input"
import { unpackedExtensionId, unpackedReloadAdvice } from "../../cli/src/protocol"
import { firstRunStep, relayProbeResult, shouldProbe, type FirstRunStep, type RelayProbe } from "./first-run"
import {
  TRY_PROMPT,
  agentLabels,
  checklist,
  featuredAgents,
  installCommand,
  otherAgents,
  type AgentName,
  type StepState,
} from "./checklist"
import { RelayForm } from "./relay-form"
import { applyColorScheme, Brand, CopyBox, createRelay, Note, Rich, type Relay } from "./ui"
import "./onboarding.css"

// `npx @opencode/browse install` opens the setup page with a one-time code in the fragment (welcome.html#code=…, which
// forwards here) for a store build (cli/src/setup.ts pairStoreExtension). Take it, then drop it from the URL (address
// bar and history) before anything else.
let fragmentCode = /^#code=([0-9A-Za-z-]{8,9})$/.exec(location.hash)?.[1]
const installTab = !!fragmentCode
if (/^#(code|ticket|pair)=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search)

const settingsUrl = () => chrome.runtime.getURL("settings.html")

function Onboarding() {
  const relay = createRelay()
  const [probe, setProbe] = createSignal<RelayProbe>("unknown")
  const [installWaiting, setInstallWaiting] = createSignal(installTab)
  const [wasConnected, setWasConnected] = createSignal(false)
  const [tried, setTried] = createSignal(false)
  const [pinned, setPinned] = createSignal<boolean>()
  const [pinSkipped, setPinSkipped] = createSignal(false)
  const [pairedBy, setPairedBy] = createSignal<"link" | "code">()
  const [linkNote, setLinkNote] = createSignal<string>()

  const step = createMemo(() => firstRunStep(relay.state(), installWaiting() ? "install-waiting" : probe()))
  const list = createMemo(() => checklist({ state: relay.state(), wasConnected: wasConnected(), pinned: pinned(), pinSkipped: pinSkipped(), tried: tried() }))

  createEffect(() => {
    const state = relay.state()
    if (!state) return
    if (state.status === "connected") setWasConnected(true)
    if (state.status === "connected" && state.tabs.length > 0) setTried(true)
    if (installWaiting() && state.status === "connected") {
      setInstallWaiting(false)
      void returnToFirstRunTab().catch(() => {})
    }
    // The code from install's URL, used once, and only when this extension isn't paired with the relay (no token, or
    // one the relay refused). A working pairing is never replaced; the page says it ignored the link instead. While
    // it's still connecting (or the relay is starting), wait for a status that tells.
    if (fragmentCode && state.status !== "offline" && state.status !== "connecting") {
      if (state.status === "unpaired" || state.status === "untrusted") relay.send({ type: "pairing.link", code: fragmentCode })
      else setLinkNote("Already paired with the relay; the pairing link from install was ignored.")
      fragmentCode = undefined
    }
    if (shouldProbe(state)) void probeRelay()
  })
  relay.onMessage((message) => {
    if (message?.type !== "pairing.link.result") return
    if (message.ok) setPairedBy("link")
    else setLinkNote("Already paired with the relay; the pairing link from install was ignored.")
  })

  /**
   * Asks this computer's relay port whether a browse relay answers (its /version is open), while the extension has
   * no token or code to connect with. One probe at a time, and again while the page stays in that state.
   */
  let probing = false
  let probeTimer: ReturnType<typeof setTimeout> | undefined
  async function probeRelay() {
    if (probing || probeTimer !== undefined) return
    probing = true
    const port = /:(\d+)$/.exec(relay.state()?.relay.address ?? "")?.[1]
    let result: Exclude<RelayProbe, "unknown"> = "absent"
    if (port) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/version`, {
          headers: { "x-browse-install": "probe" },
          cache: "no-store",
          signal: AbortSignal.timeout(2_000),
        })
        result = relayProbeResult(response.status, await response.json().catch(() => undefined))
      } catch {
        result = "absent"
      }
    }
    probing = false
    setProbe(result)
    probeTimer = setTimeout(() => {
      probeTimer = undefined
      if (shouldProbe(relay.state())) void probeRelay()
    }, 3_000)
  }
  onCleanup(() => clearTimeout(probeTimer))

  // Chrome hides a new extension's button in the Extensions menu until it's pinned. Chrome 130 says when that
  // changes; older ones are asked again when the user comes back to the page.
  const readPinned = () =>
    chrome.action
      .getUserSettings()
      .then((settings) => setPinned(settings.isOnToolbar))
      .catch(() => undefined)
  void readPinned()
  chrome.action.onUserSettingsChanged?.addListener(() => void readPinned())
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void readPinned()
  })

  return (
    <main class="onboarding" data-finished={list().finished ? "" : undefined}>
      <Brand
        end={
          <Button variant="ghost-muted" size="small" icon="settings-gear" onClick={() => location.assign(settingsUrl())}>
            Settings
          </Button>
        }
      />
      <h1>Connect your agent</h1>
      <p class="subtitle">Three steps. This page checks each one as it happens.</p>

      <ol class="checklist">
        <Step number={1} state={list().agent} title="Run this in your terminal" done={<AgentDone relay={relay} pairedBy={pairedBy()} />}>
          <AgentStep relay={relay} step={step()} linkNote={linkNote()} onPaired={() => setPairedBy("code")} />
        </Step>
        <Step number={2} state={list().pin} title="Pin Browse to your toolbar" done={pinned() ? "Pinned. Click it on any tab to hand that tab to your agent." : "Skipped. Browse stays in the Extensions menu."}>
          <PinStep onSkip={() => setPinSkipped(true)} />
        </Step>
        <Step number={3} state={list().tryIt} title="Try it" done="Your agent opened a tab. Browse works.">
          <p>Paste this into your agent:</p>
          <CopyBox text={TRY_PROMPT} label="Example prompt" />
          <Waiting>Watching for your agent's first tab…</Waiting>
          <p class="hint">If your agent was open during setup, restart it first so it picks up the browse tools.</p>
        </Step>
      </ol>

      <Show when={list().finished}>
        <section class="finished">
          <span class="marker" aria-hidden="true">
            <Icon name="check" size="small" />
          </span>
          <div>
            <h2>You're set</h2>
            <p>
              Agents open their own tabs in the background, grouped and collapsed. When one needs you for a login or a
              payment, the page shows a card and the badge says WAIT.
            </p>
            <a class="link" href={settingsUrl()}>
              Settings
            </a>
          </div>
        </section>
      </Show>
    </main>
  )
}

/** One checklist row: a marker (number, pulse or check), the title, and the body while it's the step to do now. */
function Step(props: { number: number; state: StepState; title: string; done: JSX.Element; children: JSX.Element }) {
  return (
    <li class="step" data-state={props.state} aria-current={props.state === "active" ? "step" : undefined}>
      <span class="marker" aria-hidden="true">
        <Show when={props.state === "done"} fallback={props.number}>
          <Icon name="check" size="small" />
        </Show>
      </span>
      <div class="step-body">
        <h2>{props.title}</h2>
        <Switch>
          <Match when={props.state === "done"}>
            <p class="done-line">{props.done}</p>
          </Match>
          <Match when={props.state === "active"}>{props.children}</Match>
        </Switch>
      </div>
    </li>
  )
}

function Waiting(props: { children: JSX.Element }) {
  return (
    <p class="waiting" aria-live="polite">
      <span class="pulse" aria-hidden="true" />
      {props.children}
    </p>
  )
}

function AgentDone(props: { relay: Relay; pairedBy: "link" | "code" | undefined }) {
  const state = () => props.relay.state()
  const remote = () => (state()?.relay.remote ? state()?.relay.address : undefined)
  return (
    <>
      {props.pairedBy ? "Paired and connected" : "Agent connected"}
      <Show when={state()?.browser}>
        {(browser) => (
          <>
            {" · this browser is "}
            <code>{browser().id}</code>
          </>
        )}
      </Show>
      <Show when={remote()}>{(address) => ` · relay at ${address()}`}</Show>
    </>
  )
}

/** Step 1: the agent picker and install command, and whatever the connection says to do next. */
function AgentStep(props: { relay: Relay; step: FirstRunStep; linkNote: string | undefined; onPaired: () => void }) {
  const [agent, setAgent] = createSignal<AgentName>("opencode")
  const [more, setMore] = createSignal(false)
  const [remoteOpen, setRemoteOpen] = createSignal(false)
  const here = (remote: string | undefined) => (remote ? `the relay at ${remote}` : "the relay on this computer")
  const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
  const kind = () => props.step.kind
  const remote = () => ("remote" in props.step ? props.step.remote : undefined)
  const unpacked = () => (props.step.kind === "update-extension" ? props.step.unpacked || chrome.runtime.id === unpackedExtensionId : false)
  const showInstall = () => kind() === "install" || (kind() === "pair" && !remote()) || kind() === "mismatch"

  const chips = () => (more() ? [...featuredAgents, ...otherAgents] : featuredAgents.includes(agent()) ? featuredAgents : [...featuredAgents, agent()])

  return (
    <>
      <Show when={showInstall()}>
        <div class="chips" role="radiogroup" aria-label="Your agent">
          <For each={chips()}>
            {(name) => (
              <button type="button" class="chip" role="radio" aria-checked={agent() === name} onClick={() => setAgent(name)}>
                {agentLabels[name]}
              </button>
            )}
          </For>
          <Show when={!more()}>
            <button type="button" class="chip chip-more" onClick={() => setMore(true)}>
              {otherAgents.length} more
            </button>
          </Show>
        </div>
        <CopyBox text={installCommand(agent())} label="Install command" />
        <p class="hint">
          Installs the relay, adds the browse tools to {agentLabels[agent()]} and pairs them with this browser. Needs
          Node.js 22.19 or newer.
        </p>
      </Show>

      <Switch>
        <Match when={kind() === "checking"}>
          <Waiting>Checking…</Waiting>
        </Match>
        <Match when={kind() === "install"}>
          <Waiting>Waiting for your agent to connect…</Waiting>
        </Match>
        <Match when={kind() === "finishing"}>
          <Waiting>Finishing setup from your terminal. Keep install running.</Waiting>
        </Match>
        <Match when={props.step.kind === "pair" && props.step}>
          {(pair) => (
            <>
              <Note tone="warn">
                {pair().reason === "code-rejected"
                  ? `${capitalized(here(pair().remote))} didn't accept the pairing code: it was mistyped, already used or expired.`
                  : pair().reason === "refused"
                    ? `${capitalized(here(pair().remote))} refused this browser's pairing: it was unpaired there, or that relay is a new install.`
                    : `Browse found ${here(pair().remote)}, but this browser isn't paired with it yet.`}{" "}
                {pair().remote ? "" : "Run install again: it pairs by itself."}
              </Note>
              <CodeForm
                relay={props.relay}
                label={pair().remote ? "Run `npx @opencode/browse pair` on that computer and enter the code it prints:" : "Or enter the code `npx @opencode/browse pair` prints:"}
                onPaired={props.onPaired}
              />
            </>
          )}
        </Match>
        <Match when={props.step.kind === "waiting" && props.step}>
          {(waiting) =>
            waiting().pairing === "code" ? (
              <Waiting>
                Code saved. It pairs as soon as {here(waiting().remote)} runs, within 10 minutes of <code>pair</code>.
              </Waiting>
            ) : (
              <>
                <Waiting>Paired with {here(waiting().remote)}. Waiting for your agent to connect…</Waiting>
                <p class="hint">The relay starts when your agent uses the browse tools. Restart your agent if it was open during setup.</p>
              </>
            )
          }
        </Match>
        <Match when={props.step.kind === "connecting" && props.step}>
          {(connecting) => <Waiting>{connecting().pairing ? "Pairing" : "Connecting"} with {here(connecting().remote)}…</Waiting>}
        </Match>
        <Match when={kind() === "update-cli"}>
          <Note tone="warn">
            This extension is newer than the browse CLI on this computer. Run this, then restart your agent. (With automatic
            updates on, the CLI catches up by itself within a day.)
          </Note>
          <CopyBox text="npx @opencode/browse@latest install" />
        </Match>
        <Match when={kind() === "update-extension"}>
          <Show
            when={!unpacked()}
            fallback={
              <Note tone="warn">
                <Rich text={unpackedReloadAdvice} />
              </Note>
            }
          >
            <Note tone="warn">
              This extension is older than the browse CLI on this computer. Chrome updates it within a few hours; to update
              now, open the extensions page, turn on Developer mode and click Update.
            </Note>
            <div class="actions">
              <Button variant="neutral" onClick={() => void chrome.tabs.create({ url: "chrome://extensions" })}>
                Open the extensions page
              </Button>
            </div>
          </Show>
        </Match>
        <Match when={kind() === "mismatch"}>
          <Note tone="warn">This extension and the browse CLI on this computer don't match. Run install again, then reconnect.</Note>
          <div class="actions">
            <Button variant="neutral" icon="refresh" onClick={() => props.relay.send({ type: "agents.reconnect" })}>
              Reconnect
            </Button>
          </div>
        </Match>
        <Match when={kind() === "conflict"}>
          <Note tone="warn">
            Browse in another browser or profile holds the relay's connection. Close it there (or quit that browser), then
            reconnect.
          </Note>
          <div class="actions">
            <Button variant="neutral" icon="refresh" onClick={() => props.relay.send({ type: "agents.reconnect" })}>
              Reconnect
            </Button>
          </div>
        </Match>
      </Switch>

      <Show when={props.linkNote}>{(text) => <Note>{text()}</Note>}</Show>

      <div class="disclosure" data-open={remoteOpen() ? "" : undefined}>
        <button type="button" class="disclosure-toggle" aria-expanded={remoteOpen()} onClick={() => setRemoteOpen(!remoteOpen())}>
          <Icon name={remoteOpen() ? "chevron-down" : "chevron-right"} size="small" />
          Agent on another computer? Connect to a relay
        </button>
        <Show when={remoteOpen()}>
          <RelayForm relay={props.relay} help />
        </Show>
      </div>
    </>
  )
}

/** A pairing code for the relay the extension already points at. */
function CodeForm(props: { relay: Relay; label: string; onPaired: () => void }) {
  const [code, setCode] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [note, setNote] = createSignal<string>()
  props.relay.onMessage((message) => {
    if (message === undefined) return setPending(false)
    if (message.type !== "relay.result" || !pending()) return
    setPending(false)
    if (message.status === "connected") props.onPaired()
    if (message.status === "invalid-code") return setNote("That isn't a pairing code. Enter the 8 characters `npx @opencode/browse pair` prints (XXXX-XXXX).")
    setCode("")
    const address = message.address ?? ""
    setNote(message.status === "connecting" ? `The relay ${address.startsWith("localhost:") ? "on this computer" : `at ${address}`} hasn't answered yet. This updates when it does.` : undefined)
  })
  return (
    <form
      class="code-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!code().trim()) return
        setPending(true)
        setNote(undefined)
        props.relay.send({ type: "relay.connect", address: props.relay.state()?.relay.address ?? "", code: code() })
      }}
    >
      <p class="hint">
        <Rich text={props.label} />
      </p>
      <div class="inline-form">
        <TextInput value={code()} onInput={(event) => setCode(event.currentTarget.value)} placeholder="XXXX-XXXX" aria-label="Pairing code" autocomplete="off" spellcheck={false} />
        <Button type="submit" variant="contrast" disabled={pending()}>
          {pending() ? "Pairing…" : "Pair"}
        </Button>
      </div>
      <Show when={note()}>{(text) => <Note tone="warn"><Rich text={text()} /></Note>}</Show>
    </form>
  )
}

const PUZZLE = "M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4c-1.1 0-2 .9-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20c0 1.1.9 2 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17c1.1 0 2-.9 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z"
const PIN = "M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"

/** Step 2: where Chrome keeps the button, and Skip. */
function PinStep(props: { onSkip: () => void }) {
  return (
    <>
      <p>
        Chrome keeps new extensions in the Extensions menu. Click the puzzle piece, then the pin next to Browse. Then
        click Browse on any tab to hand that tab to your agent.
      </p>
      <div class="pin-visual" aria-hidden="true">
        <span class="pin-toolbar">
          <svg viewBox="0 0 24 24">
            <path d={PUZZLE} />
          </svg>
        </span>
        <Icon name="arrow-right" size="small" />
        <span class="pin-row">
          <img src="/icons/icon-16.png" width="16" height="16" alt="" />
          Browse
          <svg class="pin-icon" viewBox="0 0 24 24">
            <path d={PIN} />
          </svg>
        </span>
      </div>
      <Waiting>Waiting for the pin…</Waiting>
      <div class="actions">
        <Button variant="ghost-muted" size="small" onClick={props.onSkip}>
          Skip
        </Button>
      </div>
    </>
  )
}

// Only remove this install-created code tab, after success, if the original first-run tab still exists in its window.
async function returnToFirstRunTab() {
  const self = await chrome.tabs.getCurrent()
  if (self?.id === undefined) return
  const firstRun = new Set(["onboarding.html?first-run", "welcome.html?first-run"].map((page) => chrome.runtime.getURL(page)))
  const original = (await chrome.tabs.query({ windowId: self.windowId })).find((tab) => tab.url !== undefined && firstRun.has(tab.url))
  if (original?.id === undefined || original.id === self.id) return
  if (self.active) await chrome.tabs.update(original.id, { active: true })
  await chrome.tabs.remove(self.id)
}

applyColorScheme()
render(() => <Onboarding />, document.getElementById("root")!)
