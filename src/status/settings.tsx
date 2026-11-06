// The settings page (settings.html, the extension's options page). One card: the connection's state at the top, then a
// row per setting (this browser's name, where agent tabs open and how they're grouped and closed, the agent cursor,
// human-like input and handoff notifications, updates), then an Advanced section for the relay's address and pairing
// code, reconnect and diagnostics. Each row is a chrome.storage.local key the background reads when it needs it (or
// sends to the relay, for the cursor and input); a setting the relay's environment fixes is shown as such.
import { createSignal, Show, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { SegmentedControl, SegmentedControlItem } from "@opencode/ui/segmented-control"
import { Switch } from "@opencode/ui/switch"
import { TextInput } from "@opencode/ui/text-input"
import { showToast, Toast } from "@opencode/ui/toast"
import {
  AGENT_CURSOR_KEY,
  AGENT_DIAGNOSTICS,
  AGENT_GROUPING_KEY,
  AGENT_WINDOW_KEY,
  BROWSER_NAME_KEY,
  HANDOFF_NOTIFICATIONS_KEY,
  HUMAN_INPUT_KEY,
  IDLE_MINUTES_KEY,
  agentCursor,
  agentGrouping,
  agentWindowPlacement,
  handoffNotifications,
  humanInput,
  idleMinutesSetting,
  type AgentGrouping,
  type AgentRelayState,
  type AgentWindowPlacement,
  type AutoUpdateMode,
  type RelayOverrides,
} from "../shared/protocol"
import { unpackedExtensionId } from "../../cli/src/protocol"
import { describeStatus } from "./describe"
import { RelayForm } from "./relay-form"
import { applyColorScheme, Brand, CopyBox, createRelay, createStored, Note, Rich } from "./ui"
import "./settings.css"

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

function Settings() {
  const relay = createRelay()
  const state = relay.state

  const [agentWindow, setAgentWindow] = createStored(AGENT_WINDOW_KEY, agentWindowPlacement)
  const [grouping, setGrouping] = createStored(AGENT_GROUPING_KEY, agentGrouping)
  const [idle, setIdle] = createStored(IDLE_MINUTES_KEY, idleMinutesSetting)
  const [cursor, setCursor] = createStored(AGENT_CURSOR_KEY, agentCursor)
  const [human, setHuman] = createStored(HUMAN_INPUT_KEY, humanInput)
  const [notifications, setNotifications] = createStored(HANDOFF_NOTIFICATIONS_KEY, handoffNotifications)
  const [storedName] = createStored(BROWSER_NAME_KEY, (value) => (typeof value === "string" ? value : ""))

  const [name, setName] = createSignal<string>()
  const saveName = (event: SubmitEvent) => {
    event.preventDefault()
    const next = (name() ?? storedName()).trim().slice(0, 60)
    // The background reconnects on the change, and the relay names the browser afresh.
    void (next ? chrome.storage.local.set({ [BROWSER_NAME_KEY]: next }) : chrome.storage.local.remove(BROWSER_NAME_KEY)).then(() => {
      setName(undefined)
      showToast({ title: next ? "Name saved" : "Name reset", description: "browse reconnects so agents see it.", variant: "success" })
    })
  }

  const reconnect = () => relay.send({ type: "agents.reconnect" })
  const action = () => primaryAction(state())

  // The pairing code fields live in Advanced; the pair action brings them into view.
  let advanced!: HTMLDetailsElement
  const openAdvanced = () => {
    advanced.open = true
    advanced.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }

  const copyDiagnostics = () =>
    void chrome.runtime
      .sendMessage({ action: AGENT_DIAGNOSTICS })
      .then((response: { text?: string } | undefined) => navigator.clipboard.writeText(response?.text ?? "No diagnostics."))
      .then(() => showToast({ title: "Diagnostics copied", description: "Paste them into a bug report.", variant: "success" }))

  return (
    <main class="settings">
      <Brand
        end={
          <a class="link" href={chrome.runtime.getURL("onboarding.html")}>
            Setup guide
          </a>
        }
      />

      <section class="card">
        <header class="card-head" data-state={state()?.status ?? "connecting"}>
          <div class="head-line">
            <span class="dot" aria-hidden="true" />
            <h1 class="head-status">{statusText(state())}</h1>
            <Show when={action()}>
              {(kind) => (
                <Button
                  class="head-action"
                  variant="neutral"
                  size="small"
                  icon={kind() === "reconnect" ? "refresh" : undefined}
                  onClick={kind() === "pair" ? openAdvanced : reconnect}
                >
                  {kind() === "pair" ? "Pair with a code" : "Reconnect"}
                </Button>
              )}
            </Show>
          </div>
          <Show when={statusDetail(state())}>
            {(detail) => (
              <p class="head-sub">
                <Rich text={detail()} />
              </p>
            )}
          </Show>
        </header>

        <Show when={state()?.update}>
          {(update) => (
            <Section title="update available">
              <p class="row-desc">{capitalized(update().summary)}. Run this in a terminal, or ask your agent to update browse:</p>
              <CopyBox text={update().command} />
            </Section>
          )}
        </Show>

        <Section title="this browser">
          <Row
            label="Name for agents"
            description="When several browsers connect to one relay, agents pick one by this name. The first to connect is the default."
          >
            <form class="name-form" onSubmit={saveName}>
              <TextInput
                value={name() ?? storedName()}
                onInput={(event) => setName(event.currentTarget.value)}
                maxlength={60}
                placeholder="Browser and computer"
                aria-label="Name for agents"
                autocomplete="off"
                spellcheck={false}
              />
              <Button type="submit" variant="neutral">
                Save
              </Button>
            </form>
          </Row>
        </Section>

        <Section title="agent tabs">
          <Row label="Where agents open their tabs" description="In the background of your window, or one of their own.">
            <SegmentedControl
              class="seg-window"
              value={agentWindow()}
              onChange={(value) => value && setAgentWindow(value as AgentWindowPlacement)}
            >
              <SegmentedControlItem value="current">Your window</SegmentedControlItem>
              <SegmentedControlItem value="separate">Own window</SegmentedControlItem>
            </SegmentedControl>
          </Row>
          <Override overrides={state()?.overrides} setting="agentWindow" />
          <Row label="Group tabs" description="Per agent session, or one shared group.">
            <SegmentedControl
              class="seg-group"
              value={grouping()}
              onChange={(value) => value && setGrouping(value as AgentGrouping)}
            >
              <SegmentedControlItem value="session">Per session</SegmentedControlItem>
              <SegmentedControlItem value="shared">All agents</SegmentedControlItem>
              <SegmentedControlItem value="none">None</SegmentedControlItem>
            </SegmentedControl>
          </Row>
          <Row
            label="Close idle tabs after"
            description="Stays open while a script or recording runs, or a handoff waits."
          >
            <SegmentedControl class="seg-idle" value={String(idle())} onChange={(value) => value !== null && setIdle(Number(value))}>
              <SegmentedControlItem value="10">10 min</SegmentedControlItem>
              <SegmentedControlItem value="30">30 min</SegmentedControlItem>
              <SegmentedControlItem value="60">1 hour</SegmentedControlItem>
              <SegmentedControlItem value="0">Never</SegmentedControlItem>
            </SegmentedControl>
          </Row>
        </Section>

        <Section title="agent input">
          <Row
            label="Show the agent cursor"
            description="Pages can see the cursor while it's shown. Recordings leave it out unless the agent asks for it."
          >
            <Switch hideLabel checked={cursor() === "always"} onChange={(on) => setCursor(on ? "always" : "off")}>
              Show the agent cursor
            </Switch>
          </Row>
          <Override overrides={state()?.overrides} setting="cursor" />
          <Row
            label="Human-like input"
            description="Curved mouse paths, paced typing and scrolling. Off is faster, but easier for sites to flag as a bot."
          >
            <Switch hideLabel checked={human() === "on"} onChange={(on) => setHuman(on ? "on" : "off")}>
              Human-like input
            </Switch>
          </Row>
          <Override overrides={state()?.overrides} setting="humanInput" />
        </Section>

        <Section title="handoffs">
          <Row
            label="Notify me on every handoff"
            description="A system notification as well as the card on the page. Off: only on recorded tabs, where there's no card."
          >
            <Switch hideLabel checked={notifications() === "always"} onChange={(on) => setNotifications(on ? "always" : "recording")}>
              Notify me on every handoff
            </Switch>
          </Row>
        </Section>

        <Show when={state()?.autoUpdate?.install === "npm" && state()?.autoUpdate}>
          {(autoUpdate) => (
            <Section title="updates">
              <Row label="When a new version is published" description={updateFacts(autoUpdate())}>
                <SegmentedControl
                  class="seg-update"
                  value={autoUpdate().mode}
                  onChange={(value) => {
                    if (value === "on" || value === "notify" || value === "off") relay.send({ type: "autoUpdate.set", mode: value })
                  }}
                >
                  <SegmentedControlItem value="on">Install</SegmentedControlItem>
                  <SegmentedControlItem value="notify">Tell me</SegmentedControlItem>
                  <SegmentedControlItem value="off">Off</SegmentedControlItem>
                </SegmentedControl>
              </Row>
              <Show when={autoUpdate().overriddenBy}>
                {(variable) => (
                  <Note tone="warn">
                    In effect:{" "}
                    {({ on: "automatic", notify: "notify only", off: "off" } satisfies Record<AutoUpdateMode, string>)[autoUpdate().effective]}. Set
                    by <code>{variable()}</code> on the relay.
                  </Note>
                )}
              </Show>
            </Section>
          )}
        </Show>

        <div class="hr" />
        <details class="advanced" ref={advanced}>
          <summary class="advanced-summary">
            <span class="advanced-title">advanced</span>
            <span class="advanced-hint">relay address, pairing code, diagnostics</span>
            <Icon class="advanced-chevron" name="chevron-down" size="small" />
          </summary>
          <div class="advanced-body">
            <Show when={state()}>
              {(current) => (
                <p class="advanced-status" data-state={state()?.status}>
                  <span class="dot" aria-hidden="true" />
                  <span>
                    <Rich text={describeStatus(current(), chrome.runtime.id === unpackedExtensionId)} />
                  </span>
                </p>
              )}
            </Show>
            <RelayForm relay={relay} />
            <p class="row-desc">
              <Rich text="The relay runs on this computer unless your agent runs on another one: run `browse set hostname 0.0.0.0` there, then enter that computer's Tailscale IP or name. A pairing code is only needed for a new relay, or after this browser was unpaired: run `browse pair` on the relay's computer. It works once, within 10 minutes." />
            </p>
            <div class="actions">
              <Button variant="neutral" icon="refresh" onClick={reconnect}>
                Reconnect
              </Button>
              <Button
                variant="neutral"
                onClick={() => {
                  relay.send({ type: "tabs.cleanup" })
                  showToast({ title: "Agent tabs closed", variant: "success" })
                }}
              >
                Close agent tabs
              </Button>
              <Button variant="neutral" icon="copy" onClick={copyDiagnostics}>
                Copy diagnostics
              </Button>
            </div>
            <p class="advanced-id">
              Extension ID <code>{chrome.runtime.id}</code>
            </p>
          </div>
        </details>
      </section>

      <footer class="settings-foot">Agents open their own tabs. To share one of yours, click the browse button on it.</footer>
      <Toast.Region />
    </main>
  )
}

/** A section of the card, under a hairline: a small heading, then a row per setting. */
function Section(props: { title: string; children: JSX.Element }) {
  return (
    <>
      <div class="hr" />
      <section class="section">
        <h2 class="section-title">{props.title}</h2>
        <div class="section-body">{props.children}</div>
      </section>
    </>
  )
}

/** A setting on one line: what it is (and a sentence on it) on the left, the control on the right; a narrow page stacks them. */
function Row(props: { label: string; description?: string; children: JSX.Element }) {
  return (
    <div class="row">
      <div class="row-text">
        <span class="row-label">{props.label}</span>
        <Show when={props.description}>
          {(description) => (
            <span class="row-desc">
              <Rich text={description()} />
            </span>
          )}
        </Show>
      </div>
      <div class="row-control">{props.children}</div>
    </div>
  )
}

/** The connection in a few words, for the top of the card; Advanced has the long version. */
function statusText(state: AgentRelayState | undefined) {
  if (state === undefined) return "Connecting to the relay…"
  const remote = state.relay.remote ? state.relay.address : undefined
  switch (state.status) {
    case "connected":
      return remote ? `Connected to the relay at ${remote}` : "Connected to the relay on this computer"
    case "connecting":
      return "Connecting to the relay…"
    case "conflict":
      return "Another browser is using the relay"
    case "incompatible":
      return "This extension and the relay don't match"
    case "unpaired":
      return "Not paired with the relay"
    case "untrusted":
      return "The relay didn't accept this browser"
    default:
      return remote ? `Waiting for the relay at ${remote}` : "Waiting for an agent"
  }
}

/** The line under the status: where this browser stands, or the one thing to do next. Text in backticks shows as code. */
function statusDetail(state: AgentRelayState | undefined) {
  if (state === undefined) return undefined
  const remote = state.relay.remote ? state.relay.address : undefined
  switch (state.status) {
    case "connected":
      return state.browser ? `\`${state.browser.id}\` is how agents call this browser.` : "No agent is using a tab yet."
    case "offline":
      return remote
        ? "It starts the first time an agent there uses the browse tools."
        : "The relay starts the first time an agent uses the browse tools."
    case "conflict":
      return "Close browse in the other browser or profile, then reconnect."
    case "incompatible":
      return "Update this extension and the browse CLI on this computer."
    case "unpaired":
      return "Until it's paired, no agent can use this browser."
    case "untrusted":
      return "Enter a new code from `browse pair` on the relay's computer."
    default:
      return undefined
  }
}

/** The one action the state calls for, if any. */
const primaryAction = (state: AgentRelayState | undefined) =>
  state?.status === "unpaired" || state?.status === "untrusted" ? "pair" : state?.status === "conflict" || state?.status === "incompatible" ? "reconnect" : undefined

// A setting the relay's environment fixes wins over the page's; say so, with the value in effect.
const overrideNotes: { [Key in keyof RelayOverrides]-?: { variable: string; labels: Record<NonNullable<RelayOverrides[Key]>, string> } } = {
  agentWindow: { variable: "OPENCODE_BROWSER_AGENT_WINDOW", labels: { current: "in your window", separate: "in a separate window" } },
  cursor: { variable: "OPENCODE_BROWSER_GHOST_CURSOR", labels: { off: "off", always: "always shown" } },
  humanInput: { variable: "OPENCODE_BROWSER_HUMAN_INPUT", labels: { on: "on", off: "off" } },
}
function Override(props: { overrides: RelayOverrides | undefined; setting: keyof RelayOverrides }) {
  const value = () => props.overrides?.[props.setting]
  return (
    <Show when={value()}>
      {(current) => (
        <Note tone="warn">
          In effect: {(overrideNotes[props.setting].labels as Record<string, string>)[current()]}. Set by{" "}
          <code>{overrideNotes[props.setting].variable}</code> on the relay.
        </Note>
      )}
    </Show>
  )
}

/** The relay's update state, in a sentence or two. */
function updateFacts(autoUpdate: NonNullable<AgentRelayState["autoUpdate"]>) {
  return [
    autoUpdate.version ? `Installed: ${autoUpdate.version}${autoUpdate.channel === "dev" ? " (dev channel)" : ""}.` : "",
    autoUpdate.pending ? `${autoUpdate.pending} is ready and switches in once no agent is using the browser.` : "",
    !autoUpdate.pending && autoUpdate.latest && autoUpdate.latest !== autoUpdate.version ? `Newest: ${autoUpdate.latest}.` : "",
  ]
    .filter(Boolean)
    .join(" ")
}

applyColorScheme()
render(() => <Settings />, document.getElementById("root")!)
