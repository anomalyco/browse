import { pairingProof, randomNonce } from "../src/background/pairing"

export type RelayWireMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}

/**
 * Installs a scripted relay-side WebSocket class on `globalThis.WebSocket` for isolated background tests:
 * answers the pairing handshake with `token` on `port` and records messages sent by the extension.
 */
export function installFakeRelaySocket(options: { readonly port: number; readonly token: string }) {
  class FakeRelaySocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    static current: FakeRelaySocket | undefined
    readonly received: RelayWireMessage[] = []
    readyState = FakeRelaySocket.CONNECTING
    onopen: ((event: unknown) => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: ((event: unknown) => void) | null = null

    constructor(readonly url: string) {
      FakeRelaySocket.current = this
      setTimeout(() => {
        this.readyState = FakeRelaySocket.OPEN
        this.onopen?.({})
      }, 0)
    }

    send(data: string) {
      const message = JSON.parse(data) as RelayWireMessage
      this.received.push(message)
      if (message.method === "hello") void this.challenge(String((message.params?.pairing as { nonce: string }).nonce))
    }

    private async challenge(extensionNonce: string) {
      const nonce = randomNonce()
      this.deliver({
        method: "auth.challenge",
        params: { nonce, proof: await pairingProof(options.token, "relay", options.port, nonce, extensionNonce) },
      })
    }

    deliver(message: RelayWireMessage) {
      this.onmessage?.({ data: JSON.stringify(message) })
    }

    drop(code = 1006) {
      this.readyState = FakeRelaySocket.CLOSED
      this.onclose?.({ code, reason: "", wasClean: false })
    }

    close() {}
  }

  globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeRelaySocket
  return () => FakeRelaySocket.current!
}
