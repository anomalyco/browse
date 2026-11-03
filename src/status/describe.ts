// Plain-word lines both pages show: the connection's status (settings) and what a Connect to a relay led to. Text in
// backticks shows as code.
import type { AgentRelayState, ToStatusPage } from "../shared/protocol"
import { unpackedReloadAdvice } from "../../cli/src/protocol"

export type RelayResult = Extract<ToStatusPage, { type: "relay.result" }>

/** What Connect led to, under the relay form. `codeSent`: the extension now holds the code it was given. */
export function relayResultText(result: RelayResult["status"], address: string, codeSent: boolean) {
  const local = address.startsWith("localhost:")
  const at = local ? `on this computer (${address})` : `at ${address}`
  return {
    "invalid-address": "That isn't an address. Use localhost, or a host or IP with an optional port: 100.64.0.2 or devbox.tailnet.ts.net:19988.",
    "invalid-code": "That isn't a pairing code. Enter the 8 characters `npx @opencode/browse pair` prints on the relay's computer (XXXX-XXXX).",
    connected: `Connected to the relay ${at}.`,
    connecting: `The relay ${at} hasn't answered yet. This updates when it does.`,
    offline: codeSent
      ? `Code saved. No relay answered ${at} yet; it pairs as soon as one runs there (within 10 minutes of \`pair\`).`
      : local
        ? `No relay answered ${at}. It starts the first time an agent uses the browse tools.`
        : `No relay answered ${at}. Check the address, that an agent has started the relay there, and that \`npx @opencode/browse set hostname 0.0.0.0\` was run there.`,
    unpaired: `The relay ${at} answered, but this browser isn't paired with it. Run \`npx @opencode/browse pair\` there and enter the code it prints.`,
    untrusted: `The relay ${at} didn't accept the pairing. Run \`npx @opencode/browse pair\` there and enter the new code it prints.`,
    conflict: `The relay ${at} answered, but Browse in another browser or profile is connected to it.`,
    incompatible: `The relay ${at} and this extension speak different protocols. Update both, then reconnect.`,
  }[result]
}

/** Whether a relay result is good news, bad news or just news. */
export const relayResultTone = (result: RelayResult["status"]): "ok" | "warn" | "neutral" =>
  result === "connected" ? "ok" : result === "connecting" || result === "offline" ? "neutral" : "warn"

/** The connection, in a sentence. `unpacked`: this is the unpacked build install copied, which reloads to update. */
export function describeStatus(state: AgentRelayState, unpacked: boolean) {
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
    return state.unpacked || unpacked
      ? unpackedReloadAdvice
      : "This extension is older than the browse CLI on this computer. Chrome updates it within a few hours; to update now, open chrome://extensions, turn on Developer mode and click Update."
  if (state.status === "incompatible") return "This extension and the installed CLI don't match. Run the install command again, then click Reconnect."
  if (state.status === "unpaired") return "Not paired yet. Run the install command from the setup page, or enter a pairing code below; until then no agent can use this browser."
  if (state.status === "untrusted" && remote) return `The relay at ${remote} didn't pair with this browser, so it was refused. Enter a new pairing code from it below.`
  if (state.status === "untrusted")
    return state.unpacked
      ? "The relay on this computer didn't pair with this browser, so it was refused. Run the install command again (or enter a code from `npx @opencode/browse pair` below), then click Connect."
      : "The relay on this computer didn't pair with this browser, so it was refused. Enter a new code from `npx @opencode/browse pair` below, or update the CLI."
  if (remote) return `Waiting for the relay at ${remote}. It starts the first time an agent there uses the browse tools.`
  return "Waiting for an agent. The relay starts the first time an agent uses the browse tools."
}

/** Text split into plain parts and `code` parts, for rendering. */
export const richParts = (text: string) => text.split(/`([^`]+)`/).map((part, index) => ({ code: index % 2 === 1, text: part }))
