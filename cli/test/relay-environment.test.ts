import { describe, expect, test } from "bun:test"
import { binRoot, cacheRoot, configRoot, dataRoot, installedBinaryPath, stateRoot } from "../src/paths.ts"
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

/**
 * Runs `body` with exactly `env` applied, after clearing every path override: a variable the relay did not forward must
 * not keep an outer value, or each side would still resolve the same roots and the comparison would prove nothing.
 */
function withEnvironment<T>(env: NodeJS.ProcessEnv, body: () => T): T {
  const names = [...new Set([...pathOverrides, ...Object.keys(env)])]
  const saved = new Map(names.map((name) => [name, process.env[name]]))
  const apply = (values: NodeJS.ProcessEnv) => {
    for (const name of names) {
      const value = values[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  apply(env)
  try {
    return body()
  } finally {
    apply(Object.fromEntries(saved))
  }
}

const resolvedRoots = () => ({
  config: configRoot(),
  data: dataRoot(),
  state: stateRoot(),
  cache: cacheRoot(),
  bin: binRoot(),
  binary: installedBinaryPath(),
})

describe("managed relay environment", () => {
  test("forwards every path override paths.ts reads", () => {
    const env: NodeJS.ProcessEnv = Object.fromEntries(pathOverrides.map((name) => [name, `/tmp/browse-test/${name.toLowerCase()}`]))
    expect(relayEnvironment(env)).toEqual(env)
  })

  test("the relay resolves browse's roots exactly as the CLI that started it", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCODE_BROWSER_HOME: undefined,
      XDG_CONFIG_HOME: "/tmp/browse-env/config",
      XDG_DATA_HOME: "/tmp/browse-env/data",
      XDG_STATE_HOME: "/tmp/browse-env/state",
      XDG_CACHE_HOME: "/tmp/browse-env/cache",
      XDG_BIN_HOME: "/tmp/browse-env/bin",
    }
    // A fresh relay child only has the forwarded variables, so each side is evaluated with exactly its own environment.
    expect(withEnvironment(relayEnvironment(env), resolvedRoots)).toEqual(withEnvironment(env, resolvedRoots))
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
