// The onboarding page (onboarding.html): opened on install, and by the toolbar button while this browser isn't paired.
// One card, laid out like Console's Connect OpenCode guide: a tab for an agent on this computer and one for an agent on
// another computer, each a few numbered steps that check themselves off from the worker's state and the first agent
// tab.
import { createEffect, createMemo, createSignal, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { Tabs } from "@kobalte/core/tabs"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { TextInput } from "@opencode/ui/text-input"
import { unpackedExtensionId, unpackedReloadAdvice } from "../../cli/src/protocol"
import { firstRunStep, relayProbeResult, shouldProbe, type FirstRunStep, type RelayProbe } from "./first-run"
import { TRY_PROMPT, checklist } from "./checklist"
import { RelayForm } from "./relay-form"
import { applyColorScheme, Brand, createFlash, createRelay, Note, Rich, type Relay } from "./ui"
import "./onboarding.css"

// `browse install` opens the setup page with a one-time code in the fragment (welcome.html#code=…, which
// forwards here) for a store build (cli/src/setup.ts pairStoreExtension). Take it, then drop it from the URL (address
// bar and history) before anything else.
let fragmentCode = /^#code=([0-9A-Za-z-]{8,9})$/.exec(location.hash)?.[1]
const installTab = !!fragmentCode
if (/^#(code|ticket|pair)=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search)

const settingsUrl = () => chrome.runtime.getURL("settings.html")
const INSTALL = "curl -fsSL https://opencode.ai/browse/install | sh"
const REMOTE_INSTALL = `${INSTALL} -s -- --remote`
const AGENT_PROMPT = `Set up Browse so you can use my Chrome: run ${INSTALL}`

type Where = "here" | "remote"
type How = "agent" | "manual"

function Onboarding() {
  const relay = createRelay()
  const [probe, setProbe] = createSignal<RelayProbe>("unknown")
  const [installWaiting, setInstallWaiting] = createSignal(installTab)
  const [wasConnected, setWasConnected] = createSignal(false)
  const [tried, setTried] = createSignal(false)
  const [pairedBy, setPairedBy] = createSignal<"link" | "code">()
  const [linkNote, setLinkNote] = createSignal<string>()
  const [where, setWhere] = createSignal<Where>()
  const [how, setHow] = createSignal<How>("agent")

  const step = createMemo(() => firstRunStep(relay.state(), installWaiting() ? "install-waiting" : probe()))
  const list = createMemo(() => checklist({ state: relay.state(), wasConnected: wasConnected(), tried: tried() }))
  const connected = () => list().agent === "done"
  // Until the user picks, it follows where the extension already points.
  const remote = () => (where() ?? (relay.state()?.relay.remote ? "remote" : "here")) === "remote"

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

  const tryIt = (number: number, agent: string) => (
    <Step
      number={number}
      title={`Restart ${agent} and try it`}
      done={list().tryIt === "done"}
      description={list().tryIt === "done" ? "Your agent opened a tab. Browse works." : "Agents load new tools when they start. Then ask it something like:"}
    >
      <Show when={list().tryIt !== "done"}>
        <Command text={TRY_PROMPT} label="Copy prompt" />
        <Show when={connected()}>
          <Waiting>Watching for your agent's first tab…</Waiting>
        </Show>
      </Show>
    </Step>
  )

  const installStep = (how: How) => (
    <Step
      number={1}
      title={how === "agent" ? "Paste this into your agent" : "Run this in your terminal"}
      done={connected()}
      description={
        connected() ? (
          <AgentDone relay={relay} pairedBy={pairedBy()} />
        ) : how === "agent" ? (
          "Claude Code, Codex, OpenCode, Cursor or any agent that can run commands. It installs Browse, adds it to itself and connects to this browser."
        ) : (
          "Downloads Browse, adds it to the agents it finds on this computer and connects to this browser. Nothing else to install."
        )
      }
    >
      <Show when={!connected()}>
        <AgentStep
          relay={relay}
          step={step()}
          command={how === "agent" ? { text: AGENT_PROMPT, label: "Copy prompt" } : { text: INSTALL, label: "Copy command" }}
          linkNote={linkNote()}
          onPaired={() => setPairedBy("code")}
        />
      </Show>
    </Step>
  )

  return (
    <main class="page">
      <Brand />

      <section class="guide" aria-labelledby="guide-title">
        <header class="guide-head">
          <h1 id="guide-title" class="guide-title">
            {remote() ? "Connect an agent on another computer" : "Connect your agent"}
            <Show when={connected()}>
              <span class="guide-connected">
                <span aria-hidden="true">·</span>
                <span class="ok">Connected</span>
              </span>
            </Show>
          </h1>
          <p class="guide-sub">
            <Show when={remote()} fallback="This page checks each step as it happens.">
              For an agent on a server, a dev box or another laptop.{" "}
              <button type="button" class="link" onClick={() => setWhere("here")}>
                Agent on this computer?
              </button>
            </Show>
          </p>
        </header>

        <Show
          when={remote()}
          fallback={
            <Tabs value={how()} onChange={(value) => setHow(value as How)}>
              <Tabs.List class="tabs" aria-label="How to set it up">
                <Tabs.Trigger class="tab" value="agent">
                  <span>Ask your agent</span>
                </Tabs.Trigger>
                <Tabs.Trigger class="tab" value="manual">
                  <span>Do it yourself</span>
                </Tabs.Trigger>
                <Tabs.Indicator class="tab-indicator" />
              </Tabs.List>
              <div class="hr" />
              <Tabs.Content class="guide-body" value="agent">
                <div class="steps">
                  {installStep("agent")}
                  {tryIt(2, "your agent")}
                </div>
              </Tabs.Content>
              <Tabs.Content class="guide-body" value="manual">
                <div class="steps">
                  {installStep("manual")}
                  {tryIt(2, "your agent")}
                </div>
              </Tabs.Content>
            </Tabs>
          }
        >
          <div class="hr" />
          <div class="guide-body">
            <div class="steps">
              <Step
                number={1}
                title="On that computer, run"
                done={connected()}
                description="Installs Browse there, opens its relay to other computers and prints its address and a pairing code."
              >
                <Show when={!connected()}>
                  <Command text={REMOTE_INSTALL} label="Copy command" />
                </Show>
              </Step>
              <Step
                number={2}
                title="Enter its address and code"
                done={connected()}
                description={connected() ? <AgentDone relay={relay} pairedBy={pairedBy()} /> : "The code works once, within 10 minutes."}
              >
                <Show when={!connected()}>
                  <RelayForm relay={relay} remote />
                </Show>
              </Step>
              {tryIt(3, "that agent")}
            </div>
          </div>
        </Show>

        <Show when={!remote() && !list().finished}>
          <div class="hr" />
          <footer class="guide-foot">
            <span class="muted">
              Agent on another computer?{" "}
              <button type="button" class="link" onClick={() => setWhere("remote")}>
                Connect to it
              </button>
            </span>
          </footer>
        </Show>

        <Show when={list().finished}>
          <div class="hr" />
          <footer class="guide-foot">
            <Button variant="neutral" size="large" onClick={() => location.assign(settingsUrl())}>
              Open settings
            </Button>
            <span class="sep" aria-hidden="true" />
            <span class="muted">You're set. When an agent needs you for a login, the page shows a card.</span>
          </footer>
        </Show>
      </section>
    </main>
  )
}

/** One numbered step on the rail: the number turns into a check once it's done. */
function Step(props: { number: number; title: string; description?: JSX.Element; done?: boolean; children?: JSX.Element }) {
  return (
    <div class="step" data-done={props.done ? "" : undefined}>
      <div class="rail" aria-hidden="true">
        <span class="num">
          <Show when={props.done} fallback={props.number}>
            <Icon name="check" size="small" />
          </Show>
        </span>
        <span class="line" />
      </div>
      <div class="step-body">
        <div class="step-text">
          <h2 class="step-title">{props.title}</h2>
          <Show when={props.description}>
            <p class="step-desc">{props.description}</p>
          </Show>
        </div>
        {props.children}
      </div>
    </div>
  )
}

/** A command or prompt to copy. */
function Command(props: { text: string; label: string }) {
  const [copied, flash] = createFlash("copy", "check")
  return (
    <div class="cmd">
      <div class="cmd-text">
        <code>{props.text}</code>
        <IconButton
          variant="ghost-muted"
          size="small"
          aria-label={props.label}
          icon={<Icon name={copied() === "check" ? "check" : "copy"} size="small" />}
          onClick={() => void navigator.clipboard.writeText(props.text).then(flash)}
        />
      </div>
    </div>
  )
}

function Waiting(props: { children: JSX.Element }) {
  return (
    <p class="waiting" aria-live="polite">
      <span class="pulse" aria-hidden="true" />
      <span>{props.children}</span>
    </p>
  )
}

function AgentDone(props: { relay: Relay; pairedBy: "link" | "code" | undefined }) {
  const state = () => props.relay.state()
  const remote = () => (state()?.relay.remote ? state()?.relay.address : undefined)
  return (
    <>
      {props.pairedBy ? "Paired and connected" : "Connected"}
      <Show when={state()?.browser}>
        {(browser) => (
          <>
            {". This browser is "}
            <span class="kbd">{browser().id}</span>
          </>
        )}
      </Show>
      <Show when={remote()}>{(address) => <>{" on the relay at "}<span class="kbd">{address()}</span></>}</Show>
      .
    </>
  )
}

/** Step 1 on this computer: the prompt or command that installs Browse, and whatever the connection says to do next. */
function AgentStep(props: {
  relay: Relay
  step: FirstRunStep
  command: { text: string; label: string }
  linkNote: string | undefined
  onPaired: () => void
}) {
  const here = (remote: string | undefined) => (remote ? `the relay at ${remote}` : "the relay on this computer")
  const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
  const kind = () => props.step.kind
  const remote = () => ("remote" in props.step ? props.step.remote : undefined)
  const unpacked = () => (props.step.kind === "update-extension" ? props.step.unpacked || chrome.runtime.id === unpackedExtensionId : false)
  const showInstall = () => kind() === "install" || (kind() === "pair" && !remote()) || kind() === "mismatch"

  return (
    <>
      <Show when={showInstall()}>
        <Command text={props.command.text} label={props.command.label} />
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
                label={pair().remote ? "Run `browse pair` on that computer and enter the code it prints:" : "Or enter the code `browse pair` prints:"}
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
              <Waiting>
                Paired with {here(waiting().remote)}. The relay starts when your agent uses the browse tools; restart your
                agent if it was open during setup.
              </Waiting>
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
          <Command text="curl -fsSL https://opencode.ai/browse/install | sh" label="Copy command" />
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
    if (message.status === "invalid-code") return setNote("That isn't a pairing code. Enter the 8 characters `browse pair` prints (XXXX-XXXX).")
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
