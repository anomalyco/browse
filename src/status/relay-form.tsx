// The relay address and pairing code form, on both pages: saves them, reconnects, and says how it went.
import { createEffect, createSignal, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Field } from "@opencode/ui/field"
import { TextInput } from "@opencode/ui/text-input"
import { relayResultText, relayResultTone, type RelayResult } from "./describe"
import { Note, Rich, type Relay } from "./ui"

export function RelayForm(props: { relay: Relay; help?: boolean }) {
  const [address, setAddress] = createSignal("")
  const [code, setCode] = createSignal("")
  const [edited, setEdited] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [result, setResult] = createSignal<RelayResult>()

  // The field shows where the extension connects (localhost:19988 for this computer), unless the user is editing it.
  createEffect(() => {
    const current = props.relay.state()?.relay.address
    if (current !== undefined && !edited()) setAddress(current)
  })
  // A result doesn't outlive the connection it described.
  createEffect(() => {
    if (props.relay.state()?.status === "connected" && !pending() && result()?.status !== "connected") setResult(undefined)
  })
  props.relay.onMessage((message) => {
    if (message === undefined) return setPending(false)
    if (message.type !== "relay.result" || !pending()) return
    setPending(false)
    setResult(message)
    if (message.status !== "invalid-code") setCode("")
  })

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    setEdited(false)
    setPending(true)
    setResult(undefined)
    props.relay.send({ type: "relay.connect", address: address(), code: code() })
  }

  return (
    <form class="relay-form" onSubmit={submit}>
      <div class="relay-fields">
        <Field>
          <Field.Label>Relay address</Field.Label>
          <TextInput
            value={address()}
            onInput={(event) => {
              setEdited(true)
              setAddress(event.currentTarget.value)
            }}
            placeholder="localhost:19988"
            autocomplete="off"
            spellcheck={false}
          />
        </Field>
        <Field>
          <Field.Label>Pairing code</Field.Label>
          <TextInput
            value={code()}
            onInput={(event) => setCode(event.currentTarget.value)}
            placeholder="XXXX-XXXX"
            autocomplete="off"
            spellcheck={false}
          />
        </Field>
      </div>
      <Show when={props.help}>
        <p class="hint">
          <Rich text="On the agent's computer, run `npx @opencode/browse set hostname 0.0.0.0` and `npx @opencode/browse pair`, then enter that computer's Tailscale IP or name and the code it prints. The code works once, within 10 minutes." />
        </p>
      </Show>
      <div class="actions">
        <Button type="submit" variant="contrast" disabled={pending()}>
          {pending() ? "Connecting…" : "Connect"}
        </Button>
      </div>
      <Show when={result()}>
        {(shown) => (
          <Note tone={relayResultTone(shown().status)}>
            <Rich text={relayResultText(shown().status, shown().address ?? "", props.relay.state()?.pairing === "code")} />
          </Note>
        )}
      </Show>
    </form>
  )
}
