import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as Deadbolt from "../src/deadbolt.ts"
import { parsePasskeyRequest, rpIdAllowed } from "../src/passkey-bridge.ts"
import { codeKind, defaultSite } from "../src/sign-in.ts"
import { startFakeDeadbolt, type FakeDeadbolt } from "./fake-deadbolt.ts"

const tempDir = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "db-"))

describe("socket path", () => {
  test("BLAKE3 matches the reference vectors", () => {
    expect(Deadbolt.blake3Hex(Buffer.from(""))).toBe("af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262")
    expect(Deadbolt.blake3Hex(Buffer.from("abc"))).toBe("6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85")
  })

  test("follows Deadbolt's rules: XDG_RUNTIME_DIR, else TMPDIR with the uid; DEADBOLT_HOME adds a suffix", () => {
    const uid = process.getuid!()
    expect(Deadbolt.computedSocketPath({ XDG_RUNTIME_DIR: "/run/x" })).toBe("/run/x/deadbolt/agent.sock")
    const suffix = Deadbolt.blake3Hex(Buffer.from("/tmp/home")).slice(0, 8)
    expect(Deadbolt.computedSocketPath({ XDG_RUNTIME_DIR: "/run/x", DEADBOLT_HOME: "/tmp/home" })).toBe(`/run/x/deadbolt-${suffix}/agent.sock`)
    if (!fs.existsSync(`/run/user/${uid}`)) {
      expect(Deadbolt.computedSocketPath({ TMPDIR: "/tmp/t" })).toBe(`/tmp/t/deadbolt-${uid}/agent.sock`)
    }
  })

  test("OPENCODE_BROWSER_DEADBOLT_SOCKET overrides it", () => {
    expect(Deadbolt.socketPath({ env: { OPENCODE_BROWSER_DEADBOLT_SOCKET: "/x/agent.sock" } })).toBe("/x/agent.sock")
  })
})

describe("names and sites", () => {
  test("parses deadbolt:<site>[/<username>]", () => {
    expect(Deadbolt.parseDeadboltName("deadbolt:github.com")).toEqual({ site: "github.com" })
    expect(Deadbolt.parseDeadboltName("deadbolt:github.com/alice@example.com")).toEqual({ site: "github.com", username: "alice@example.com" })
    expect(Deadbolt.parseDeadboltName("deadbolt:http://127.0.0.1:8080/bob")).toEqual({ site: "http://127.0.0.1:8080", username: "bob" })
    expect(Deadbolt.parseDeadboltName("shop")).toBeUndefined()
  })

  test("an origin is on a site: the host or a subdomain over https, or the exact origin", () => {
    expect(Deadbolt.originOnSite("https://github.com", "github.com")).toBe(true)
    expect(Deadbolt.originOnSite("https://gist.github.com", "github.com")).toBe(true)
    expect(Deadbolt.originOnSite("https://evilgithub.com", "github.com")).toBe(false)
    expect(Deadbolt.originOnSite("http://github.com", "github.com")).toBe(false)
    expect(Deadbolt.originOnSite("http://127.0.0.1:8080", "http://127.0.0.1:8080")).toBe(true)
    expect(Deadbolt.originOnSite("http://127.0.0.1:8081", "http://127.0.0.1:8080")).toBe(false)
  })

  test("the default site and code kinds", () => {
    expect(defaultSite("https://login.example.co.uk/x")).toBe("example.co.uk")
    expect(defaultSite("https://www.github.com/login")).toBe("github.com")
    expect(defaultSite("http://127.0.0.1:3000/login")).toBe("http://127.0.0.1:3000")
    expect(codeKind("enter the 6-digit code from your authenticator app")).toBe("totp")
    expect(codeKind("we sent a code to your phone ending in 12")).toBe("sent")
    expect(codeKind("enter code")).toBe("unknown")
  })

  test("allowlist patterns become origins to ask about", () => {
    expect(Deadbolt.originsFromPatterns(["github.com", "*.example.com", "http://localhost:3000"])).toEqual(["https://github.com", "https://example.com", "http://localhost:3000"])
  })
})

describe("client", () => {
  let fake: FakeDeadbolt
  let root: string
  beforeAll(async () => {
    root = tempDir()
    fake = await startFakeDeadbolt({
      directory: path.join(root, "sock"),
      logins: [
        { ref: { vault: "v", item: "1" }, site: "example.com", title: "Example", username: "alice", values: { username: "alice", password: "pw-1", totp: "123456" }, fields: ["username", "password", "totp"] },
        { ref: { vault: "v", item: "2" }, site: "example.com", title: "Example 2", username: "bob", values: { username: "bob", password: "pw-2" }, fields: [] },
      ],
    })
    await Deadbolt.saveClient(fake.client, root)
  })
  afterAll(() => fake.close())

  test("stores the client 0600 and sends it with the agent's protocol version", async () => {
    expect(fs.statSync(Deadbolt.clientFilePath(root)).mode & 0o777).toBe(0o600)
    const connection = Deadbolt.connect({ root, socket: fake.socket })
    const logins = await connection.logins("https://login.example.com")
    expect(logins.map((login) => [login.username, login.granted])).toEqual([["alice", true], ["bob", false]])
    expect(JSON.stringify(logins)).not.toContain("pw-1")
    const request = fake.requests.find((entry) => entry.cmd === "agent-logins")!
    expect(request).toMatchObject({ v: 15, client: fake.client, origin: "https://login.example.com" })
    expect(await connection.fill("https://example.com", logins[0]!, ["password"])).toEqual({ password: "pw-1" })
  })

  test("picks only granted logins and names what to allow", async () => {
    const connection = Deadbolt.connect({ root, socket: fake.socket })
    const logins = await connection.logins("https://example.com")
    expect(Deadbolt.pickLogin(logins, "example.com", undefined).username).toBe("alice")
    expect(() => Deadbolt.pickLogin(logins, "example.com", "bob")).toThrow(/deadbolt agents allow example.com --login bob/)
  })

  test("maps Deadbolt's errors", async () => {
    const connection = Deadbolt.connect({ root, socket: fake.socket })
    const [, bob] = await connection.logins("https://example.com")
    const notGranted = await connection.fill("https://example.com", bob!, ["password"]).catch((error) => error)
    expect(notGranted).toBeInstanceOf(Deadbolt.DeadboltError)
    expect(notGranted).toMatchObject({ code: "not_granted", detail: { site: "example.com", login: "bob" } })
    fake.locked = true
    expect(await connection.logins("https://example.com").catch((error) => error.code)).toBe("locked")
    fake.locked = false
    const forbidden = Deadbolt.connect({ root, socket: fake.socket, client: { id: fake.client.id, token: "b".repeat(64) } })
    expect(await forbidden.logins("https://example.com").catch((error) => error.code)).toBe("forbidden")
    const missing = Deadbolt.connect({ root, socket: path.join(root, "nope.sock") })
    expect(await missing.logins("https://example.com").catch((error) => error.code)).toBe("unavailable")
    expect(() => Deadbolt.connect({ root: tempDir() })).toThrow(/opencode-browser deadbolt connect/)
  })

  test("lists logins for origins without values", async () => {
    const listing = await Deadbolt.listLogins(["https://example.com", "https://other.test"], Deadbolt.connect({ root, socket: fake.socket }))
    expect(listing.connected).toBe(true)
    expect(listing.logins.map((login) => login.username)).toEqual(["alice", "bob"])
    expect(listing.passkeys).toEqual([])
    expect(JSON.stringify(listing)).not.toMatch(/pw-1|"ref"/)
  })
})

describe("passkey accounts", () => {
  const challenge = Buffer.alloc(32, 7).toString("base64url")
  for (const chooseAsReply of [false, true]) {
    test(`several granted passkeys need a choice (${chooseAsReply ? "ok reply" : "error code"}); a ref picks one`, async () => {
      const root = tempDir()
      const fake = await startFakeDeadbolt({
        directory: path.join(root, "sock"),
        chooseAsReply,
        logins: [
          { ref: { vault: "v", item: "a" }, site: "example.com", title: "A", username: "alice", values: {}, fields: [], passkeys: true, passkey: { displayName: "Alice A" } },
          { ref: { vault: "v", item: "c" }, site: "example.com", title: "C", username: "carol", values: {}, fields: [], passkeys: true, passkey: { displayName: "Carol C" } },
          { ref: { vault: "v", item: "d" }, site: "example.com", title: "D", username: "dave", values: {}, fields: [], passkey: { displayName: "Dave" } },
        ],
      })
      try {
        const connection = Deadbolt.connect({ client: fake.client, socket: fake.socket })
        const { passkeys } = await connection.site("https://example.com")
        expect(passkeys.map((passkey) => [passkey.username, passkey.displayName, passkey.granted])).toEqual([["alice", "Alice A", true], ["carol", "Carol C", true]])
        const request = { origin: "https://example.com", challenge, allowCredentials: [], userVerification: "preferred" }
        const choose = await connection.passkeyGet(request).catch((error) => error)
        expect(choose).toBeInstanceOf(Deadbolt.DeadboltError)
        expect(choose.code).toBe("choose_passkey")
        expect(choose.detail.choices.map((choice: Deadbolt.DeadboltPasskey) => [choice.username, choice.displayName])).toEqual([["alice", "Alice A"], ["carol", "Carol C"]])
        const carol = Deadbolt.pickPasskey(passkeys, "Carol")!
        expect(Deadbolt.pickPasskey(passkeys, "carol c")).toBe(carol)
        expect(Deadbolt.pickPasskey(passkeys, "dave")).toBeUndefined()
        expect(JSON.stringify(choose.detail.choices)).not.toContain("cred-")
        const assertion = await connection.passkeyGet({ ...request, login: carol.ref })
        expect(Buffer.from(assertion.credentialId, "base64url").toString()).toBe("cred-c")
        expect(fake.requests.at(-1)).toMatchObject({ cmd: "agent-passkey-get", login: { vault: "v", item: "c" } })
      } finally {
        await fake.close()
      }
    })
  }
})

describe("passkey requests from the page", () => {
  const challenge = Buffer.alloc(32, 7).toString("base64url")
  test("accepts a well-formed request and rejects anything else", () => {
    expect(parsePasskeyRequest(JSON.stringify({ id: 1, challenge, rpId: "Example.com", allowCredentials: ["AQID"], userVerification: "required" })))
      .toEqual({ id: 1, challenge, rpId: "example.com", allowCredentials: ["AQID"], userVerification: "required" })
    expect(parsePasskeyRequest(JSON.stringify({ id: 1, challenge: "not base64!", allowCredentials: [] }))).toBeUndefined()
    expect(parsePasskeyRequest(JSON.stringify({ id: -1, challenge, allowCredentials: [] }))).toBeUndefined()
    expect(parsePasskeyRequest(JSON.stringify({ id: 1, challenge, allowCredentials: "x" }))).toBeUndefined()
    expect(parsePasskeyRequest(`{"id":1,"challenge":"${"A".repeat(70_000)}"}`)).toBeUndefined()
  })

  test("the rpId must be the origin's host or a parent domain, on a secure origin", () => {
    expect(rpIdAllowed("https://login.example.com", "example.com")).toBe(true)
    expect(rpIdAllowed("https://login.example.com", undefined)).toBe(true)
    expect(rpIdAllowed("https://example.com", "other.com")).toBe(false)
    expect(rpIdAllowed("https://example.com", "com")).toBe(false)
    expect(rpIdAllowed("http://example.com", "example.com")).toBe(false)
    expect(rpIdAllowed("http://127.0.0.1:8080", "127.0.0.1")).toBe(true)
  })
})
