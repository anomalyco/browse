import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionCatalog } from "../src/session-manager/catalog.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function temporaryCatalog() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-session-catalog-"))
  roots.push(root)
  return { root, catalog: new SessionCatalog(path.join(root, "sessions.json")) }
}

test("a corrupt catalog is moved aside, logged, and loaded as empty", async () => {
  const { root, catalog } = temporaryCatalog()
  fs.writeFileSync(catalog.filePath, "{ not json", "utf8")
  const logged: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => { logged.push(args) }
  try {
    expect(await catalog.load()).toEqual([])
  } finally {
    console.error = original
  }
  expect(fs.existsSync(catalog.filePath)).toBe(false)
  const moved = fs.readdirSync(root).filter((name) => name.startsWith("sessions.json.corrupt-"))
  expect(moved).toHaveLength(1)
  expect(fs.readFileSync(path.join(root, moved[0]!), "utf8")).toBe("{ not json")
  expect(logged).toHaveLength(1)
  expect(String(logged[0]![0])).toContain("started with no saved sessions")
})

test("a catalog with an invalid session id is moved aside too", async () => {
  const { root, catalog } = temporaryCatalog()
  fs.writeFileSync(catalog.filePath, JSON.stringify({
    version: 1,
    sessions: [{ id: "not a valid id!", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), readOnly: false }],
  }))
  const original = console.error
  console.error = () => {}
  try {
    expect(await catalog.load()).toEqual([])
  } finally {
    console.error = original
  }
  expect(fs.readdirSync(root).filter((name) => name.startsWith("sessions.json.corrupt-"))).toHaveLength(1)
})

test("session options survive a catalog round trip", async () => {
  const { catalog } = temporaryCatalog()
  const now = new Date().toISOString()
  const sessions = [
    { id: "keep-visible", createdAt: now, updatedAt: now, readOnly: false, keepVisible: true, allowedOrigins: ["https://shop.test"] },
    { id: "plain", createdAt: now, updatedAt: now, readOnly: true },
  ]

  await catalog.save(sessions)

  expect(await catalog.load()).toEqual(sessions)
})
