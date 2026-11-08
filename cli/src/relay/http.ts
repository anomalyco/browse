import type http from "node:http"
import { Effect, Schema } from "effect"
import type { WebSocketServer } from "ws"
import { parseJsonObject, type JsonObject } from "../protocol.ts"
import { RelayErrorCode } from "./schema.ts"

const maxCliBodyBytes = 1_000_000

export class HttpRouteError extends Schema.TaggedError<HttpRouteError>()(
  "HttpApi.HttpRouteError",
  { message: Schema.String, status: Schema.Number, code: RelayErrorCode },
) {}

export function formatHostForUrl(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`
  }
  return host
}

export function listenHttpServer(options: {
  readonly server: http.Server
  readonly host: string
  readonly port: number
}): Effect.Effect<void, Error> {
  return Effect.callback<void, Error>((resume) => {
    const onError = (error: Error) => {
      resume(Effect.fail(error))
    }
    options.server.once("error", onError)
    options.server.listen(options.port, options.host, () => {
      options.server.off("error", onError)
      resume(Effect.void)
    })
    return Effect.sync(() => {
      options.server.off("error", onError)
    })
  })
}

export function closeHttpServer(server: http.Server): Effect.Effect<void, Error> {
  if (!server.listening) {
    return Effect.void
  }
  return Effect.callback<void, Error>((resume) => {
    server.close((error?: Error) => {
      if (error) {
        resume(Effect.fail(new Error("close http server", { cause: error })))
        return
      }
      resume(Effect.void)
    })
    // A request whose work outlived shutdown still holds its connection; nothing will answer it now.
    server.closeAllConnections()
    return Effect.void
  })
}

export function closeWebSocketServer(server: WebSocketServer): Effect.Effect<void, Error> {
  return Effect.callback<void, Error>((resume) => {
    server.close((error?: Error) => {
      const nodeError = error as NodeJS.ErrnoException | undefined
      if (nodeError?.code === "ERR_SERVER_NOT_RUNNING") {
        resume(Effect.void)
        return
      }
      if (error) {
        resume(Effect.fail(new Error("close websocket server", { cause: error })))
        return
      }
      resume(Effect.void)
    })
    return Effect.void
  })
}

export function logCloseError(message: string) {
  return (effect: Effect.Effect<void, Error>): Effect.Effect<void> => {
    return Effect.catch(effect, (error) => {
      return Effect.sync(() => {
        console.error(message, error)
      })
    })
  }
}

export function sendJson(response: http.ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}

export function readJsonBody(request: http.IncomingMessage): Effect.Effect<JsonObject, Error> {
  const contentType = request.headers["content-type"]
  const contentTypeValue = Array.isArray(contentType) ? contentType[0] : contentType
  if (!contentTypeValue?.toLowerCase().includes("application/json")) {
    return Effect.fail(new HttpRouteError({ message: "Content-Type must be application/json", status: 415, code: "invalid-request" }))
  }
  return Effect.callback<JsonObject, Error>((resume) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let completed = false
    const onData = (chunk: Buffer) => {
      if (completed) {
        return
      }
      totalBytes += chunk.byteLength
      if (totalBytes > maxCliBodyBytes) {
        completed = true
        request.destroy(new Error(`Request body exceeds ${maxCliBodyBytes} bytes`))
        resume(Effect.fail(new HttpRouteError({ message: `Request body exceeds ${maxCliBodyBytes} bytes`, status: 413, code: "invalid-request" })))
        return
      }
      chunks.push(chunk)
    }
    const onError = (error: Error) => {
      if (completed) {
        return
      }
      completed = true
      resume(Effect.fail(new Error("read request body", { cause: error })))
    }
    const onAbort = () => {
      if (completed) {
        return
      }
      completed = true
      resume(Effect.fail(new Error("request body aborted")))
    }
    const onClose = () => {
      if (completed || request.complete) {
        return
      }
      completed = true
      resume(Effect.fail(new Error("request closed before body completed")))
    }
    const onEnd = () => {
      if (completed) {
        return
      }
      completed = true
      const text = Buffer.concat(chunks).toString("utf8")
      if (!text.trim()) {
        resume(Effect.succeed({}))
        return
      }
      try {
        resume(Effect.succeed(parseJsonObject(text)))
      } catch (error) {
        resume(Effect.fail(new HttpRouteError({ message: "Invalid JSON body", status: 400, code: "invalid-request" })))
      }
    }
    request.on("data", onData)
    request.on("error", onError)
    request.on("aborted", onAbort)
    request.on("close", onClose)
    request.on("end", onEnd)
    return Effect.sync(() => {
      request.off("data", onData)
      request.off("error", onError)
      request.off("aborted", onAbort)
      request.off("close", onClose)
      request.off("end", onEnd)
    })
  })
}
