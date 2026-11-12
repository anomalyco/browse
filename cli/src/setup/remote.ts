// install --remote: a browser on another computer.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { networkInterfaces } from "node:os"
import * as clack from "@clack/prompts"
import { formatPairingCode, mintPairingCode, pairingCodeTtlMs } from "../relay/browser-pairing.ts"
import { readRelayConfig, writeRelayConfig } from "../relay/config.ts"
import { probeRelayPort, resolveRelayPort } from "../relay/port.ts"
import { cliCommand, entrySpawnCommand } from "../paths.ts"
import { parseJson } from "./browsers.ts"
import { ensureRelay } from "./commands.ts"
import { findOnPath, log, rail } from "./environment.ts"

const tailnetIPv4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
/** Container, VM and tunnel interfaces a browser on another computer can't reach this one through. */
const virtualInterface = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|podman|utun|awdl|llw|bridge)/

/**
 * Where a browser on another computer reaches this relay: on a tailnet, its MagicDNS name and Tailscale addresses
 * (they work from anywhere on it); otherwise the LAN IPv4 addresses. The port shows only when it isn't the default.
 */
export function remoteRelayAddresses(
  interfaces: ReturnType<typeof networkInterfaces>,
  options: { port?: number; magicDns?: string | undefined } = {},
) {
  const ipv4 = Object.entries(interfaces)
    .filter(([name]) => !virtualInterface.test(name))
    .flatMap(([, addresses]) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254."))
    .map((address) => address.address)
  const tailnet = ipv4.filter((address) => tailnetIPv4.test(address))
  const hosts = tailnet.length ? [...(options.magicDns ? [options.magicDns] : []), ...tailnet] : ipv4
  const port = options.port && options.port !== 19988 ? `:${options.port}` : ""
  return [...new Set(hosts)].map((host) => host + port)
}

/** What to enter in browse on the other computer: the relay address (and alternatives), the code and how long it lasts. */
export function remoteRelayLines(addresses: string[], code: string, ttlMs = pairingCodeTtlMs) {
  return [
    `Relay address  ${addresses[0] ?? "this computer's IP address"}`,
    ...addresses.slice(1).map((address) => `           or  ${address}`),
    `Pairing code   ${formatPairingCode(code)}`,
    "",
    `The code works once, within ${ttlMs / 60_000} minutes. For a new one, run: ${cliCommand("pair")}`,
  ]
}

/** This computer's MagicDNS name, from the Tailscale CLI when it's installed. */
function magicDnsName() {
  const mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  const cli = findOnPath("tailscale") ?? (process.platform === "darwin" && existsSync(mac) ? mac : undefined)
  if (!cli) return undefined
  const status = spawnSync(cli, ["status", "--json"], { encoding: "utf8", timeout: 5_000 })
  const name = (parseJson(status.stdout) as { Self?: { DNSName?: unknown } } | undefined)?.Self?.DNSName
  return typeof name === "string" && name ? name.replace(/\.$/, "") : undefined
}

/**
 * The rest of `install --remote`, after the agents here are set up: opens the relay to other computers (as `set
 * hostname 0.0.0.0` does), starts it, and prints the address and a one-time pairing code to enter in browse on the
 * other computer. No browser here is looked for, opened or paired.
 */
export async function installRemote(entry: string, tty: boolean) {
  const config = readRelayConfig()
  if (config.hostname !== "0.0.0.0") {
    writeRelayConfig({ ...config, hostname: "0.0.0.0" })
    const running = (await probeRelayPort(resolveRelayPort(), 2_000)) === "browse"
    const [file, ...prefix] = entrySpawnCommand(entry)
    const restarted =
      running && spawnSync(file!, [...prefix, "relay", "restart"], { encoding: "utf8", timeout: 60_000 }).status === 0
    if (running && !restarted) {
      process.exitCode = 1
      log(`! The relay is still only reachable from this computer. When no agent is using it, run: ${cliCommand("relay restart --force")}`)
    } else log("✓ Opened the relay to other computers")
  } else log("✓ The relay is open to other computers")
  ensureRelay(entry)
  const port = resolveRelayPort()
  const interfaces = networkInterfaces()
  const onTailnet = Object.values(interfaces)
    .flat()
    .some((address) => address?.family === "IPv4" && tailnetIPv4.test(address.address))
  const addresses = remoteRelayAddresses(interfaces, { port, magicDns: onTailnet ? magicDnsName() : undefined })
  const lines = remoteRelayLines(addresses, mintPairingCode())
  const where = 'In Chrome on the other computer, open browse, choose "Connect an agent on another computer" and enter:'
  if (rail.active) clack.note(lines.join("\n"), "Enter this in browse on the other computer")
  else {
    log("")
    log(where)
    for (const line of lines) log(line && `  ${line}`)
    log("")
  }
  if (!onTailnet)
    log("! browse doesn't encrypt this connection: use it on a network you trust, or over Tailscale, not the open internet.")
  if (!tty)
    log(
      "Agent: give the user the relay address and pairing code above to enter in browse in their browser. The code works once and expires; if it does, run `" +
        cliCommand("pair") +
        "` for a new one.",
    )
}
