import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cachedUpdateCheck, checkForUpdate, createUpdateWatcher, gitIn, runUpdate, updateNotice, type UpdateNotice } from "../src/update.ts"

// Each scenario is a bare repository standing in for GitHub and a clone of it, so nothing here needs the network.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-update-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
}
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}
function commit(cwd: string, file: string, content = file) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
  fs.writeFileSync(path.join(cwd, file), content)
  git(cwd, "add", file)
  git(cwd, "commit", "-q", "-m", `change ${file}`)
  return git(cwd, "rev-parse", "HEAD")
}

let scenarios = 0
/** A remote with one commit on main, the user's clone of it, and a second clone to push new commits from. */
function scenario() {
  const dir = path.join(root, String(++scenarios))
  const remote = path.join(dir, "remote.git")
  const upstream = path.join(dir, "upstream")
  const clone = path.join(dir, "clone")
  fs.mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "--bare", "-b", "main", remote)
  git(dir, "clone", "-q", remote, upstream)
  git(upstream, "checkout", "-q", "-b", "main")
  commit(upstream, "README.md")
  git(upstream, "push", "-q", "origin", "main")
  git(dir, "clone", "-q", remote, clone)
  const push = (...files: string[]) => {
    let head = ""
    for (const file of files) head = commit(upstream, file)
    git(upstream, "push", "-q", "origin", "main")
    return head
  }
  return { dir, remote, clone, push, data: path.join(dir, "data") }
}

/** runUpdate with git run under the test's git config and setup's steps recorded instead of run. */
function update(repo: string | undefined, args: string[] = [], options: { hasBun?: boolean; setupFails?: string } = {}) {
  const lines: string[] = []
  const setups: { root: boolean; cli: boolean; args: readonly string[] }[] = []
  const code = runUpdate(args, {
    repo,
    log: (line) => lines.push(line),
    hasBun: () => options.hasBun ?? true,
    git: (gitArgs, timeoutMs) => {
      const result = spawnSync("git", ["-C", repo!, ...gitArgs], { encoding: "utf8", env: gitEnv, ...(timeoutMs ? { timeout: timeoutMs } : {}) })
      return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() }
    },
    setup: (step) => {
      setups.push({ root: step.root, cli: step.cli, args: step.args })
      return options.setupFails
    },
  })
  return { code, output: lines.join("\n"), setups }
}

describe("update check", () => {
  test("up to date with the remote branch", async () => {
    const { clone } = scenario()
    const check = await checkForUpdate(clone)
    expect(check).toMatchObject({ upstream: "origin/main", available: false })
    expect(check?.latest).toBe(check?.head)
  })

  test("newer commits on the remote: available, with the remote head (no fetch, so the count isn't known)", async () => {
    const { clone, push } = scenario()
    const latest = push("a.txt", "b.txt")
    const check = await checkForUpdate(clone)
    expect(check).toMatchObject({ available: true, latest })
    expect(check?.behind).toBeUndefined()
    // The check never fetches.
    expect(git(clone, "rev-parse", "origin/main")).not.toBe(latest)
  })

  test("counts the new commits once they're known locally", async () => {
    const { clone, push } = scenario()
    push("a.txt", "b.txt", "c.txt")
    git(clone, "fetch", "-q")
    expect(await checkForUpdate(clone)).toMatchObject({ available: true, behind: 3 })
  })

  test("local commits not on the remote aren't an update", async () => {
    const { clone } = scenario()
    git(clone, "fetch", "-q")
    commit(clone, "local.txt")
    expect(await checkForUpdate(clone)).toMatchObject({ available: false })
  })

  test("an unreachable remote fails quietly", async () => {
    const { clone, remote } = scenario()
    fs.renameSync(remote, `${remote}.gone`)
    expect(await checkForUpdate(clone)).toMatchObject({ available: false, failed: true })
  })

  test("a detached HEAD or a branch without a remote has nothing to compare", async () => {
    const { clone } = scenario()
    git(clone, "checkout", "-q", "--detach")
    expect(await checkForUpdate(clone)).toBeUndefined()
    git(clone, "checkout", "-q", "-b", "local")
    expect(await checkForUpdate(clone)).toBeUndefined()
  })

  test("is cached: the remote is asked again only after 6 hours, or when HEAD moves", async () => {
    const { clone, push, data } = scenario()
    let lsRemotes = 0
    const real = gitIn(clone)
    const counting = (args: readonly string[], timeoutMs?: number) => {
      if (args[0] === "ls-remote") lsRemotes++
      return real(args, timeoutMs)
    }
    const now = Date.now()
    expect(await cachedUpdateCheck({ repo: clone, dataDir: data, git: counting, now })).toMatchObject({ available: false })
    push("a.txt")
    // Within the interval the cached answer stands, even though the remote moved.
    expect(await cachedUpdateCheck({ repo: clone, dataDir: data, git: counting, now: now + 60_000 })).toMatchObject({ available: false })
    expect(lsRemotes).toBe(1)
    expect(await cachedUpdateCheck({ repo: clone, dataDir: data, git: counting, now: now + 6 * 60 * 60 * 1000 + 1 })).toMatchObject({ available: true })
    expect(lsRemotes).toBe(2)
    // Pulling moves HEAD, which invalidates the cache at once.
    git(clone, "pull", "-q", "--ff-only")
    expect(await cachedUpdateCheck({ repo: clone, dataDir: data, git: counting, now: now + 6 * 60 * 60 * 1000 + 2 })).toMatchObject({ available: false })
    expect(lsRemotes).toBe(3)
  })

  test("the notice names the update and the command; OPENCODE_BROWSER_UPDATE_CHECK=0 turns it off", async () => {
    const { clone, push, data } = scenario()
    push("a.txt")
    git(clone, "fetch", "-q")
    push("b.txt")
    const notice = await updateNotice({ repo: clone, dataDir: data })
    // The remote head isn't fetched yet, so the summary names the two heads.
    expect(notice?.summary).toMatch(/^origin\/main is at [0-9a-f]{7} \(you have [0-9a-f]{7}\)$/)
    expect(notice?.command).toMatch(/ update$/)
    const previous = process.env.OPENCODE_BROWSER_UPDATE_CHECK
    process.env.OPENCODE_BROWSER_UPDATE_CHECK = "0"
    try {
      expect(await updateNotice({ repo: clone, dataDir: path.join(data, "other") })).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BROWSER_UPDATE_CHECK
      else process.env.OPENCODE_BROWSER_UPDATE_CHECK = previous
    }
  })

  test("the watcher checks at most once per interval and reports changes", async () => {
    let time = 0
    let next: UpdateNotice | undefined
    let checks = 0
    const changes: (UpdateNotice | undefined)[] = []
    const watcher = createUpdateWatcher({
      check: async () => (checks++, next),
      onChange: (notice) => changes.push(notice),
      intervalMs: 1_000,
      now: () => time,
    })
    await watcher.refresh()
    expect(changes).toEqual([])
    next = { summary: "1 new commit on origin/main", command: "x update", check: {} as UpdateNotice["check"] }
    await watcher.refresh()
    expect(checks).toBe(1)
    time = 1_000
    await Promise.all([watcher.refresh(), watcher.refresh()])
    expect(checks).toBe(2)
    expect(watcher.current).toBe(next)
    expect(changes).toEqual([next])
  })
})

describe("update command", () => {
  test("behind: fast-forwards, lists the new commits, reruns setup and says to restart opencode", async () => {
    const { clone, push } = scenario()
    const before = git(clone, "rev-parse", "HEAD")
    const latest = push("cli/bun.lock", "src/feature.ts")
    const { code, output, setups } = update(clone, ["--opencode", "/tmp/opencode.json", "--no-open"])
    expect(code).toBe(0)
    expect(git(clone, "rev-parse", "HEAD")).toBe(latest)
    expect(output).toContain(`Updating browse ${before.slice(0, 7)} → ${latest.slice(0, 7)} (2 new commits on origin/main):`)
    expect(output).toContain("change cli/bun.lock")
    expect(output).toContain("change src/feature.ts")
    expect(output).toContain("Restart opencode")
    // Only the CLI's lockfile changed; install's flags pass through and it never waits for the extension.
    expect(setups).toEqual([{ root: false, cli: true, args: ["--opencode", "/tmp/opencode.json", "--no-open", "--no-wait"] }])
    // The update check sees it's current now.
    expect(await checkForUpdate(clone)).toMatchObject({ available: false })
  })

  test("up to date: says so and changes nothing", () => {
    const { clone } = scenario()
    const { code, output, setups } = update(clone)
    expect(code).toBe(0)
    expect(output).toMatch(/Already up to date: [0-9a-f]{7} on main/)
    expect(setups).toEqual([])
  })

  test("uncommitted changes: refuses, names them and how to stash", () => {
    const { clone, push } = scenario()
    const before = git(clone, "rev-parse", "HEAD")
    push("a.txt")
    fs.writeFileSync(path.join(clone, "README.md"), "edited")
    const { code, output, setups } = update(clone)
    expect(code).toBe(1)
    expect(output).toContain("uncommitted changes (README.md)")
    expect(output).toContain("stash")
    expect(git(clone, "rev-parse", "HEAD")).toBe(before)
    expect(fs.readFileSync(path.join(clone, "README.md"), "utf8")).toBe("edited")
    expect(setups).toEqual([])
  })

  test("untracked files (pairing code, builds) don't block it", () => {
    const { clone, push } = scenario()
    const latest = push("a.txt")
    fs.writeFileSync(path.join(clone, "relay-pairing.json"), "{}")
    expect(update(clone).code).toBe(0)
    expect(git(clone, "rev-parse", "HEAD")).toBe(latest)
  })

  test("diverged: refuses to merge and says how to reconcile", () => {
    const { clone, push } = scenario()
    push("remote.txt")
    const local = commit(clone, "local.txt")
    const { code, output, setups } = update(clone)
    expect(code).toBe(1)
    expect(output).toContain("has diverged from origin/main (1 local commit(s), 1 new on the remote)")
    expect(output).toContain("pull --rebase")
    expect(git(clone, "rev-parse", "HEAD")).toBe(local)
    expect(setups).toEqual([])
  })

  test("not on a branch, or no tracking branch: refuses", () => {
    const { clone } = scenario()
    git(clone, "checkout", "-q", "--detach")
    expect(update(clone).output).toContain("isn't on a branch (HEAD is detached")
    git(clone, "checkout", "-q", "-b", "local")
    expect(update(clone).output).toContain("branch local doesn't track a remote branch")
  })

  test("no network: refuses after the fetch fails", () => {
    const { clone, remote } = scenario()
    fs.renameSync(remote, `${remote}.gone`)
    const { code, output } = update(clone)
    expect(code).toBe(1)
    expect(output).toContain("couldn't fetch origin/main")
    expect(output).toContain("Check your network connection")
  })

  test("bun missing: refuses before pulling", () => {
    const { clone, push } = scenario()
    const before = git(clone, "rev-parse", "HEAD")
    push("a.txt")
    const { code, output } = update(clone, [], { hasBun: false })
    expect(code).toBe(1)
    expect(output).toContain("bun isn't installed")
    expect(git(clone, "rev-parse", "HEAD")).toBe(before)
  })

  test("a failed setup step is reported with how to finish", () => {
    const { clone, push } = scenario()
    push("a.txt")
    const { code, output } = update(clone, [], { setupFails: "`bun run build` failed" })
    expect(code).toBe(1)
    expect(output).toContain("but setup failed: `bun run build` failed")
    expect(output).toContain("bun run setup")
  })

  test("installed from npm: prints the npx update instead", () => {
    const { code, output } = update(undefined)
    expect(code).toBe(0)
    expect(output).toContain("npx opencode-browser-cli@latest install")
  })
})
