import assert from "node:assert/strict"
import net from "node:net"

export async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return port
}

export async function portFromEnv(name: string): Promise<number> {
  const value = process.env[name]
  if (!value) return await freePort()
  const port = Number(value)
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `${name} must be a port number`)
  return port
}
