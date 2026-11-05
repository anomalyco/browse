import { Effect, Predicate } from "effect"
import { WebSocket } from "ws"
import { installCommand } from "../paths.ts"
import {
  extensionProtocolAdvice,
  browserUnresponsive,
  extensionProtocolCompatibility,
  type ExtensionCommand,
  type ExtensionProtocolCompatibility,
  type ExtensionResponse,
  type JsonObject,
  type JsonValue,
} from "../protocol.ts"

export type ExtensionCommandInput = Omit<ExtensionCommand, "id">

export type PendingExtensionRequest = {
  readonly resolve: (value: JsonObject) => void
  readonly reject: (error: Error) => void
  readonly debuggerTabId?: number
}

export type ExtensionRpcTimeouts = {
  readonly commandTimeoutMs?: number
  readonly debuggerCommandTimeoutMs?: number
  readonly livenessProbeTimeoutMs?: number
}

/**
 * Request/response correlator for the single extension websocket.
 *
 * A timed-out command fails only that command. Connection teardown is reserved
 * for a failed websocket-level liveness probe, so one hung debugger command
 * (for example a dialog-blocked tab) cannot destroy every attached tab's relay
 * state.
 */
export class ExtensionRpc {
  private socket: WebSocket | undefined
  private ready = false
  unresponsive = false
  private replies = 0
  private nextRequestId = 1
  private readonly pendingRequests = new Map<number, PendingExtensionRequest>()
  private livenessProbe: { readonly timeout: NodeJS.Timeout; readonly socket: WebSocket; readonly onPong: () => void } | undefined
  version: string | undefined
  protocolVersion: number | null | undefined
  protocolCompatible: boolean | undefined
  protocolLegacy: boolean | undefined

  constructor(private readonly timeouts: ExtensionRpcTimeouts = {}) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.ready && !this.unresponsive && this.protocolCompatible !== false
  }

  get acceptsEvents(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.protocolCompatible === true
  }

  isCurrent(socket: WebSocket): boolean {
    return this.socket === socket
  }

  replaceSocket(socket: WebSocket): void {
    this.rejectPending(new Error("Extension replaced"))
    this.socket?.close(4001, "Extension replaced")
    this.resetConnectionState(socket)
  }

  markHandshake(version: string | undefined, reportedProtocolVersion: JsonValue | undefined): ExtensionProtocolCompatibility {
    const protocol = extensionProtocolCompatibility(reportedProtocolVersion)
    this.version = version
    this.protocolVersion = protocol.version
    this.protocolCompatible = protocol.compatible
    this.protocolLegacy = protocol.legacy
    return protocol
  }

  markReady(): void {
    if (this.protocolCompatible === true) {
      this.ready = true
    }
  }

  disconnectIfCurrent(socket: WebSocket): boolean {
    if (this.socket !== socket) {
      return false
    }
    this.resetConnectionState(undefined)
    this.rejectPending(new Error("Extension disconnected"))
    return true
  }

  private resetConnectionState(socket: WebSocket | undefined): void {
    this.cancelLivenessProbe()
    this.socket = socket
    this.ready = false
    this.unresponsive = false
    this.version = undefined
    this.protocolVersion = undefined
    this.protocolCompatible = undefined
    this.protocolLegacy = undefined
  }

  close(): void {
    this.cancelLivenessProbe()
    this.socket?.close()
  }

  rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error)
    }
  }

  rejectDebuggerCommandsForTab(tabId: number, error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.debuggerTabId !== tabId) {
        continue
      }
      pending.reject(error)
    }
  }

  noteResponse(): void {
    this.replies++
    this.unresponsive = false
  }

  handleResponse(response: ExtensionResponse): boolean {
    // Even a late reply to a timed-out heartbeat proves the worker is running again.
    this.noteResponse()
    const pending = this.pendingRequests.get(response.id)
    if (!pending) {
      return false
    }
    if (response.error) {
      pending.reject(new Error(response.error))
      return true
    }
    pending.resolve(response.result ?? {})
    return true
  }

  send(command: ExtensionCommandInput): Effect.Effect<JsonObject, Error> {
    return Effect.callback<JsonObject, Error>((resume) => {
      const socket = this.socket
      if (this.protocolCompatible === false) {
        resume(Effect.fail(new Error(extensionProtocolAdvice(this.protocolVersion, { install: installCommand() }))))
        return Effect.void
      }
      if (!socket || socket.readyState !== WebSocket.OPEN || !this.acceptsEvents) {
        resume(Effect.fail(new Error("browse extension is not connected")))
        return Effect.void
      }

      const id = this.nextRequestId++
      const replies = this.replies
      const message: ExtensionCommand = { ...command, id }
      let completed = false
      // A page.evaluate that awaits a promise runs as long as the page's work does; Playwright's own timeouts
      // govern it, so the relay adds none.
      const timeoutMs = awaitsPagePromise(command)
        ? undefined
        : command.method === "ping" ? 4_000
        : command.method === "debugger.sendCommand"
        ? this.timeouts.debuggerCommandTimeoutMs ?? 60_000
        : this.timeouts.commandTimeoutMs ?? 15_000
      const finish = (effect: Effect.Effect<JsonObject, Error>) => {
        if (completed) {
          return
        }
        completed = true
        clearTimeout(timeout)
        this.pendingRequests.delete(id)
        resume(effect)
      }
      const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
        if (command.method === "ping") {
          // Other replies also prove liveness; a slow page command alone is never a dead browser.
          if (this.replies !== replies) return finish(Effect.succeed({}))
          this.unresponsive = true
          return finish(Effect.fail(new Error(browserUnresponsive)))
        }
        // Fail only this command. Close the socket only if the websocket
        // itself is unresponsive to a protocol-level ping.
        this.probeLiveness(socket)
        finish(Effect.fail(new Error(`Extension command timed out after ${timeoutMs}ms: ${command.method}`)))
      }, timeoutMs)
      const debuggerTabId = command.method === "debugger.sendCommand" && Predicate.isNumber(command.params?.tabId)
        ? command.params.tabId
        : undefined
      this.pendingRequests.set(id, {
        resolve: (value) => {
          finish(Effect.succeed(value))
        },
        reject: (error) => {
          finish(Effect.fail(error))
        },
        ...(debuggerTabId === undefined ? {} : { debuggerTabId }),
      })
      try {
        socket.send(JSON.stringify(message), (error) => {
          if (error) {
            finish(Effect.fail(new Error(`send extension command: ${command.method}`, { cause: error })))
          }
        })
      } catch (error) {
        finish(Effect.fail(new Error(`send extension command: ${command.method}`, { cause: error })))
      }
      return Effect.sync(() => {
        completed = true
        clearTimeout(timeout)
        this.pendingRequests.delete(id)
      })
    })
  }

  probeLiveness(socket = this.socket): void {
    if (!socket || this.socket !== socket || this.livenessProbe || socket.readyState !== WebSocket.OPEN) {
      return
    }
    const probeTimeoutMs = this.timeouts.livenessProbeTimeoutMs ?? 10_000
    const onPong = () => {
      if (this.livenessProbe?.socket !== socket) return
      this.cancelLivenessProbe()
    }
    const timeout = setTimeout(() => {
      if (this.livenessProbe?.socket !== socket) return
      this.cancelLivenessProbe()
      socket.close(4002, "Extension websocket did not answer liveness probe")
    }, probeTimeoutMs)
    this.livenessProbe = { timeout, socket, onPong }
    socket.on("pong", onPong)
    try {
      socket.ping()
    } catch {
      // If ping cannot be sent the socket is already failing; let the probe
      // timeout close it.
    }
  }

  private cancelLivenessProbe(): void {
    if (this.livenessProbe) {
      clearTimeout(this.livenessProbe.timeout)
      this.livenessProbe.socket.off("pong", this.livenessProbe.onPong)
      this.livenessProbe = undefined
    }
  }
}

function awaitsPagePromise(command: Omit<ExtensionCommand, "id">): boolean {
  if (command.method !== "debugger.sendCommand") return false
  const method = command.params?.method
  const params = command.params?.params
  return (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") &&
    Predicate.isObject(params) && (params as JsonObject).awaitPromise === true
}
