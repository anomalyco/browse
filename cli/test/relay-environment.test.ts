import { describe, expect, test } from "bun:test"
import { relayEnvironment } from "../src/relay/lifecycle.ts"

// paths.ts resolves browse's config, data, state, cache and bin roots from these, and OPENCODE_BROWSER_HOME overrides
// all of them. The managed relay must resolve the same roots as the CLI that started it, or files they share (pairing
// codes included) land under different folders.
const pathOverrides = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_BIN_HOME",
  "OPENCODE_BROWSER_HOME",
] as const

describe("managed relay environment", () => {
  test("forwards every path override paths.ts reads", () => {
    const env: NodeJS.ProcessEnv = Object.fromEntries(pathOverrides.map((name) => [name, `/tmp/browse-test/${name.toLowerCase()}`]))
    expect(relayEnvironment(env)).toEqual(env)
  })

  test("keeps the relay's basics and drops unrelated variables", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "http://proxy.example",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem",
      OPENCODE_BROWSER_PORT: "29988",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp-secret",
      SOME_OTHER_VARIABLE: "value",
    }
    expect(relayEnvironment(env)).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "http://proxy.example",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem",
      OPENCODE_BROWSER_PORT: "29988",
    })
  })

  test("omits variables that are not set", () => {
    expect(relayEnvironment({ HOME: "/home/tester", XDG_STATE_HOME: undefined })).toEqual({ HOME: "/home/tester" })
  })
})
