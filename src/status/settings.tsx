// The settings page (settings.html, the extension's options page). Where agent tabs open, how they're grouped and
// closed, the agent cursor, human-like input and handoff notifications: each a chrome.storage.local key the background
// reads when it needs it (or sends to the relay, for the cursor and input); a setting the relay's environment fixes
// is shown as such. Then this browser's name, updates, and the connection: relay address and pairing code, reconnect,
// cleanup and diagnostics.
import { createSignal, For, Show, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { Button } from "@opencode/ui/button"
import { Divider } from "@opencode/ui/divider"
import { Field } from "@opencode/ui/field"
import { RadioGroup, RadioItem } from "@opencode/ui/radio"
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
  DEFAULT_IDLE_MINUTES,
  HANDOFF_NOTIFICATIONS_KEY,
  HUMAN_INPUT_KEY,
  IDLE_MINUTES_KEY,
  agentCursor,
  agentGrouping,
  handoffNotifications,
  humanInput,
  type AgentRelayState,
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

  const [agentWindow, setAgentWindow] = createStored(AGENT_WINDOW_KEY, (value) => (value === "separate" ? "separate" : "current"))
  const [grouping, setGrouping] = createStored(AGENT_GROUPING_KEY, agentGrouping)
  const [idle, setIdle] = createStored(IDLE_MINUTES_KEY, (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_MINUTES,
  )
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
      showToast({ title: next ? "Name saved" : "Name reset", description: "Browse reconnects so agents see it.", variant: "success" })
    })
  }

  const copyDiagnostics = () =>
    void chrome.runtime
      .sendMessage({ action: AGENT_DIAGNOSTICS })
      .then((response: { text?: string } | undefined) => navigator.clipboard.writeText(response?.text ?? "No diagnostics."))
      .then(() => showToast({ title: "Diagnostics copied", description: "Paste them into a bug report.", variant: "success" }))

  return (
    <main class="settings">
      <Brand
        page="Settings"
        end={
          <a class="link" href={chrome.runtime.getURL("onboarding.html")}>
            Setup guide
          </a>
        }
      />

      <Show when={state()?.update}>
        {(update) => (
          <section class="callout">
            <h2>Update available</h2>
            <p>{capitalized(update().summary)}. Run this in a terminal (or ask your agent to update browse), then restart your agent:</p>
            <CopyBox text={update().command} />
          </section>
        )}
      </Show>

      <Section title="This browser">
        <p class="row-text">
          <Show when={state()?.browser} fallback="Agents see this browser's name once it's connected.">
            {(browser) => (
              <>
                Agents call this browser <code>{browser().id}</code> ({browser().name}).
              </>
            )}
          </Show>
        </p>
        <form class="inline-form" onSubmit={saveName}>
          <Field class="grow">
            <Field.Label>Name for agents</Field.Label>
            <TextInput
              value={name() ?? storedName()}
              onInput={(event) => setName(event.currentTarget.value)}
              maxlength={60}
              placeholder="Default: browser and computer"
              autocomplete="off"
              spellcheck={false}
            />
          </Field>
          <Button type="submit" variant="neutral">
            Save
          </Button>
        </form>
        <p class="hint">When several browsers connect to one relay, agents pick one by this name; the first to connect is the default.</p>
      </Section>

      <Section title="Agent tabs">
        <RadioGroup label="Where agents open their tabs" value={agentWindow()} onChange={setAgentWindow}>
          <RadioItem value="current" label="In your window, in the background" description="Default" />
          <RadioItem value="separate" label="In a separate window" description="Opens unfocused, beside yours" />
        </RadioGroup>
        <Override overrides={state()?.overrides} setting="agentWindow" />
        <RadioGroup label="Grouping" value={grouping()} onChange={setGrouping}>
          <RadioItem value="session" label="One collapsed group per agent session" description="Default" />
          <RadioItem value="shared" label="One shared collapsed group for all agents" />
          <RadioItem value="none" label="Don't group" />
        </RadioGroup>
        <Row wide label="Close tabs agents haven't touched for" hint="Tabs stay open while a script runs on them, a handoff waits or a recording runs.">
          <SegmentedControl value={String(idle())} onChange={(value) => value !== null && setIdle(Number(value))}>
            <SegmentedControlItem value="10">10 min</SegmentedControlItem>
            <SegmentedControlItem value="30">30 min</SegmentedControlItem>
            <SegmentedControlItem value="60">1 hour</SegmentedControlItem>
            <SegmentedControlItem value="0">Never</SegmentedControlItem>
          </SegmentedControl>
        </Row>
      </Section>

      <Section title="Agent input">
        <Row label="Show the agent cursor" hint="Pages can detect the cursor while it's shown. Recordings leave it out unless the agent asks for it.">
          <Switch hideLabel checked={cursor() === "always"} onChange={(on) => setCursor(on ? "always" : "off")}>
            Show the agent cursor
          </Switch>
        </Row>
        <Override overrides={state()?.overrides} setting="cursor" />
        <Row label="Human-like input" hint="Curved mouse paths, paced typing and scrolling. Off is faster, but easier for sites to flag as a bot.">
          <Switch hideLabel checked={human() === "on"} onChange={(on) => setHuman(on ? "on" : "off")}>
            Human-like input
          </Switch>
        </Row>
        <Override overrides={state()?.overrides} setting="humanInput" />
      </Section>

      <Section title="Handoffs">
        <Row
          label="Notify on every handoff"
          hint="A system notification as well as the card on the page. Off: only while the tab is recorded, when the card isn't shown."
        >
          <Switch hideLabel checked={notifications() === "always"} onChange={(on) => setNotifications(on ? "always" : "recording")}>
            Notify on every handoff
          </Switch>
        </Row>
      </Section>

      <Show when={state()?.autoUpdate?.install === "npm" && state()?.autoUpdate}>
        {(autoUpdate) => (
          <Section title="Updates">
            <Row wide label="When a new version of browse is published" hint={updateFacts(autoUpdate())}>
              <SegmentedControl
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
                  In effect: {({ on: "automatic", notify: "notify only", off: "off" } satisfies Record<AutoUpdateMode, string>)[autoUpdate().effective]}. Set by{" "}
                  <code>{variable()}</code> on the relay.
                </Note>
              )}
            </Show>
          </Section>
        )}
      </Show>

      <Section title="Connection">
        <Show when={state()}>{(current) => <StatusLine state={current()} />}</Show>
        <RelayForm relay={relay} />
        <p class="hint">
          <Rich text="The relay is on this computer (`localhost`) unless your agent runs on another one: then run `npx @opencode/browse set hostname 0.0.0.0` there and enter that computer's Tailscale IP or name. A pairing code is only needed for a new relay, or after this browser was unpaired: run `npx @opencode/browse pair` on the relay's computer and enter the code it prints. It works once, within 10 minutes." />
        </p>
        <Divider />
        <div class="actions">
          <Button variant="neutral" icon="refresh" onClick={() => relay.send({ type: "agents.reconnect" })}>
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
      </Section>

      <Section title="Using it">
        <ul class="tips">
          <For each={tips}>{(tip) => <li>{tip}</li>}</For>
        </ul>
      </Section>

      <footer>
        Extension ID <code>{chrome.runtime.id}</code>
      </footer>
      <Toast.Region />
    </main>
  )
}

const tips = [
  "Agents open their own tabs in the background of your window, grouped at the start of your tab strip and collapsed unless you're looking at one. Tabs nobody uses for a while close by themselves.",
  "To let agents use a tab you have open, click the Browse toolbar button on it. Click again to take it back, even while an agent is running.",
  "When an agent needs you (a login, 2FA, a payment), the badge shows WAIT and the page shows a card. Finish, then click Continue or the toolbar button.",
  "Recordings show only the page. If an agent needs you while it records a tab, you get a notification instead of the card; click it to go to the tab.",
]

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <section class="section">
      <h2>{props.title}</h2>
      <div class="section-body">{props.children}</div>
    </section>
  )
}

/** A setting on one line: what it is (and a hint) on the left, the control on the right; a wide control wraps below on a narrow page. */
function Row(props: { label: string; hint?: string; wide?: boolean; children: JSX.Element }) {
  return (
    <div class="row" data-wide={props.wide ? "" : undefined}>
      <div class="row-text">
        <span class="row-label">{props.label}</span>
        <Show when={props.hint}>
          {(hint) => (
            <span class="hint">
              <Rich text={hint()} />
            </span>
          )}
        </Show>
      </div>
      <div class="row-control">{props.children}</div>
    </div>
  )
}

function StatusLine(props: { state: AgentRelayState }) {
  return (
    <p class="status-line" data-state={props.state.status}>
      <span class="dot" aria-hidden="true" />
      <span>
        <Rich text={describeStatus(props.state, chrome.runtime.id === unpackedExtensionId)} />
      </span>
    </p>
  )
}

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
    autoUpdate.previous && autoUpdate.version && autoUpdate.previous !== autoUpdate.version
      ? `\`opencode-browser rollback\` switches to ${autoUpdate.previous}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ")
}

applyColorScheme()
render(() => <Settings />, document.getElementById("root")!)
