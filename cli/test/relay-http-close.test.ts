import { expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { Effect } from "effect"
import { closeHttpServer } from "../src/relay/http.ts"

// A relay execute can outlive the shutdown wait and leave its request unanswered. server.close() alone waits for that
// request's connection, so shutdown would never finish; closeHttpServer must drop it.
test("closeHttpServer resolves while a request is still awaiting a response", async () => {
  let handledResolve: (() => void) | undefined
  const handled = new Promise<void>((resolve) => {
    handledResolve = resolve
  })
  const server = http.createServer((_request, response) => {
    response.on("error", () => {})
    handledResolve?.()
    // Never respond: this request stands in for a hung execute.
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  const request = http.request({ host: "127.0.0.1", port: address.port, path: "/" })
  request.on("error", () => {})
  request.end()
  try {
    await handled
    await Effect.runPromise(
      closeHttpServer(server).pipe(
        Effect.timeoutOrElse({
          duration: 1_000,
          orElse: () => Effect.fail(new Error("closeHttpServer waited for the in-flight request")),
        }),
      ),
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
