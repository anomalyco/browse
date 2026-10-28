// Updating a checkout install (`git clone … && bun run setup`):
//   update          fast-forwards the clone to the remote branch it tracks and reruns setup's steps (bun install,
//                   build, install). It refuses, saying what to do, when the clone has local changes, has diverged,
//                   isn't on a tracking branch, or can't reach the remote, and does nothing when it's up to date.
//   update check    asks the remote for its branch head (`git ls-remote`, never a fetch), at most every 6 hours,
//                   cached in the data root. `status`, `doctor`, the MCP server and the extension's status page show
//                   its notice. It never blocks startup and fails silently. OPENCODE_BROWSER_UPDATE_CHECK=0 turns it off.
// An npm install (`npx @opencode/browse install`) has no clone: it updates itself (auto-update.ts), `update` installs
// the newest version on its channel now (runtime-update.ts), and the notice shows a newer version in "notify" mode.
import { execFile, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { autoUpdateStatus, compareVersions, npmRuntime } from "./auto-update.ts"
import { checkoutRoot, cliCommand, dataRoot } from "./paths.ts"

/** How long a check result stands before the remote is asked again. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** A failed check (offline, remote down) is retried sooner. */
const FAILED_CHECK_INTERVAL_MS = 60 * 60 * 1000
const CACHE_FILE = "update-check.json"

export type UpdateCheck = {
  readonly repo: string
  readonly checkedAt: number
  /** HEAD when checked: after an update (or any checkout) the result no longer applies. */
  readonly head: string
  /** The tracked remote branch, e.g. origin/main. */
  readonly upstream: string
  /** The remote branch's head; absent when the remote couldn't be asked. */
  readonly latest?: string
  /** New commits on the remote branch, when its head is already known locally (otherwise unknown without a fetch). */
  readonly behind?: number
  readonly available: boolean
  readonly failed?: boolean
}

/** What status, doctor, the MCP server and the status page show: what's new, and the command that updates. */
export type UpdateNotice = {
  readonly summary: string
  readonly command: string
  readonly check: UpdateCheck
}

/** Runs git in the clone; resolves stdout (trimmed), or undefined when git fails or times out. */
export type Git = (args: readonly string[], timeoutMs?: number) => Promise<string | undefined>

/** Git that never prompts (no credential or passphrase questions from a background check). */
const quietGitEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
})

export const gitIn = (repo: string): Git => (args, timeoutMs = 5_000) =>
  new Promise((resolve) => {
    execFile("git", ["-C", repo, ...args], { timeout: timeoutMs, encoding: "utf8", env: quietGitEnv() }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim()))
  })

const short = (sha: string) => sha.slice(0, 7)

/** Asks the remote for the head of the branch HEAD tracks; undefined when there's nothing to compare with. */
export async function checkForUpdate(repo: string, git: Git = gitIn(repo), now = Date.now()): Promise<UpdateCheck | undefined> {
  const [head, branch] = await Promise.all([git(["rev-parse", "HEAD"]), git(["symbolic-ref", "--short", "-q", "HEAD"])])
  if (!head || !branch) return undefined
  const [remote, merge] = await Promise.all([git(["config", `branch.${branch}.remote`]), git(["config", `branch.${branch}.merge`])])
  if (!remote || !merge || remote === ".") return undefined
  const upstream = `${remote}/${merge.replace(/^refs\/heads\//, "")}`
  const base = { repo, checkedAt: now, head, upstream }
  const latest = (await git(["ls-remote", remote, merge], 10_000))?.split(/\s/)[0]
  if (!latest || !/^[0-9a-f]{40,64}$/.test(latest)) return { ...base, available: false, failed: true }
  if (latest === head) return { ...base, latest, available: false }
  // Known locally (fetched before): it may be behind HEAD (unpushed local commits), and the gap can be counted.
  if ((await git(["cat-file", "-e", `${latest}^{commit}`])) !== undefined) {
    if ((await git(["merge-base", "--is-ancestor", latest, "HEAD"])) !== undefined) return { ...base, latest, available: false }
    const behind = Number(await git(["rev-list", "--count", `HEAD..${latest}`]))
    return { ...base, latest, available: true, ...(Number.isInteger(behind) && behind > 0 ? { behind } : {}) }
  }
  return { ...base, latest, available: true }
}

function readCache(file: string): UpdateCheck | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as UpdateCheck
  } catch {
    return undefined
  }
}

function writeCache(file: string, check: UpdateCheck) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(check) + "\n")
    renameSync(temporary, file)
  } catch {
    // The cache only saves a network round trip.
  }
}

/** The cached check while it's fresh and HEAD hasn't moved, else a new one (written to the cache). */
export async function cachedUpdateCheck(options: {
  readonly repo: string
  readonly dataDir: string
  readonly git?: Git
  readonly now?: number
}): Promise<UpdateCheck | undefined> {
  const git = options.git ?? gitIn(options.repo)
  const now = options.now ?? Date.now()
  const file = path.join(options.dataDir, CACHE_FILE)
  const cached = readCache(file)
  const head = await git(["rev-parse", "HEAD"])
  if (!head) return undefined
  const maxAge = cached?.failed ? FAILED_CHECK_INTERVAL_MS : UPDATE_CHECK_INTERVAL_MS
  if (cached && cached.repo === options.repo && cached.head === head && now - cached.checkedAt >= 0 && now - cached.checkedAt < maxAge)
    return cached
  const fresh = await checkForUpdate(options.repo, git, now)
  if (fresh) writeCache(file, fresh)
  return fresh
}

export const updateCheckEnabled = () => process.env.OPENCODE_BROWSER_UPDATE_CHECK !== "0"

/** One line saying what's new: the commit count when it's known, else the two heads. */
export function describeUpdate(check: UpdateCheck): string {
  if (check.behind) return `${check.behind} new commit${check.behind === 1 ? "" : "s"} on ${check.upstream}`
  return `${check.upstream} is at ${short(check.latest ?? "")} (you have ${short(check.head)})`
}

/** The update notice in `status --json`, `doctor --json` and the MCP `status` tool; null when there's none. */
export type UpdateJson = {
  readonly available: true
  readonly summary: string
  readonly command: string
  readonly notice: string
  readonly current: string
  readonly latest: string | null
  readonly behind: number | null
  readonly upstream: string
}

export function updateJson(update: UpdateNotice | undefined): UpdateJson | null {
  if (!update) return null
  const { check } = update
  return {
    available: true,
    summary: update.summary,
    command: update.command,
    notice: formatUpdateNotice(update),
    current: check.head,
    latest: check.latest ?? null,
    behind: check.behind ?? null,
    upstream: check.upstream,
  }
}

export function formatUpdateNotice(notice: Pick<UpdateNotice, "summary" | "command">): string {
  return `Update available: ${notice.summary}. Run \`${notice.command}\`, then restart opencode.`
}

/**
 * The update notice for this install, or undefined when it's up to date, isn't a clone, the check is turned off, or
 * the check failed. Never throws.
 */
export async function updateNotice(options: { readonly repo?: string; readonly dataDir?: string; readonly git?: Git } = {}): Promise<UpdateNotice | undefined> {
  try {
    if (!options.repo) {
      const npm = npmUpdateNotice()
      if (npm !== false) return npm
    }
    const repo = options.repo ?? checkoutRoot()
    if (!repo || !updateCheckEnabled() || !existsSync(path.join(repo, ".git"))) return undefined
    const check = await cachedUpdateCheck({ repo, dataDir: options.dataDir ?? dataRoot(), ...(options.git ? { git: options.git } : {}) })
    return check?.available ? { summary: describeUpdate(check), command: cliCommand("update"), check } : undefined
  } catch {
    return undefined
  }
}

/**
 * An npm install's notice, from what the relay's last daily check found: shown when a newer version waits and auto-update
 * won't install it by itself (notify mode, or its last attempt failed). false when this isn't an npm install.
 */
export function npmUpdateNotice(): UpdateNotice | undefined | false {
  const runtime = npmRuntime()
  if (!runtime) return false
  const status = autoUpdateStatus({ runtime })
  const latest = status.latest
  if (!latest || compareVersions(latest, runtime.version) <= 0 || status.effective === "off" || latest === status.skipped) return undefined
  if (status.effective === "on" && !status.lastError) return undefined
  const check: UpdateCheck = { repo: "npm", checkedAt: Date.now(), head: runtime.version, upstream: `npm ${status.channel ?? "latest"}`, latest, available: true }
  return { summary: `browse ${latest} is available (you have ${runtime.version})`, command: cliCommand("update"), check }
}

/**
 * Keeps the latest notice for a long-running process (the relay, the MCP server): `refresh` checks in the background,
 * at most once per `intervalMs` however often it's called, and reports changes.
 */
export function createUpdateWatcher(options: {
  readonly check?: () => Promise<UpdateNotice | undefined>
  readonly onChange?: (notice: UpdateNotice | undefined) => void
  readonly intervalMs?: number
  readonly now?: () => number
} = {}) {
  const check = options.check ?? (() => updateNotice())
  const now = options.now ?? Date.now
  const interval = options.intervalMs ?? FAILED_CHECK_INTERVAL_MS
  let current: UpdateNotice | undefined
  let lastRun: number | undefined
  let running: Promise<void> | undefined
  return {
    get current() {
      return current
    },
    refresh(): Promise<void> {
      if (running) return running
      if (lastRun !== undefined && now() - lastRun < interval) return Promise.resolve()
      lastRun = now()
      running = check()
        .catch(() => undefined)
        .then((next) => {
          const changed = (next ? formatUpdateNotice(next) : undefined) !== (current ? formatUpdateNotice(current) : undefined)
          current = next
          if (changed) options.onChange?.(next)
        })
        .finally(() => {
          running = undefined
        })
      return running
    },
  }
}

// ---- update command -----------------------------------------------------------------------------

type Run = { status: number | null; stdout: string; stderr: string; error?: Error }

export type UpdateDeps = {
  readonly repo: string | undefined
  readonly log: (line: string) => void
  /** Runs git in the clone, synchronously; output captured. */
  readonly git?: (args: readonly string[], timeoutMs?: number) => Run
  /** True when bun is on PATH. */
  readonly hasBun?: () => boolean
  /**
   * Setup's steps after the pull: install dependencies where they changed, build, install. Returns an error message
   * when a step failed.
   */
  readonly setup?: (step: { readonly repo: string; readonly root: boolean; readonly cli: boolean; readonly args: readonly string[] }) => string | undefined
}

const syncGit = (repo: string) => (args: readonly string[], timeoutMs = 30_000): Run => {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim(), ...(result.error ? { error: result.error } : {}) }
}

const realpath = (file: string) => {
  try {
    return realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

const firstLine = (text: string) => text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ""

const shellQuoted = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value))

/** bun install (frozen to the pulled lockfiles) where they changed, the build, then install, like `bun run setup`. */
function defaultSetup(step: { readonly repo: string; readonly root: boolean; readonly cli: boolean; readonly args: readonly string[] }): string | undefined {
  const cli = path.join(step.repo, "cli")
  const run = (command: string, args: readonly string[], cwd: string) => {
    const result = spawnSync(command, args, { cwd, stdio: "inherit" })
    return result.status === 0 ? undefined : `\`${[command, ...args].join(" ")}\` failed in ${cwd}${result.error ? ` (${result.error.message})` : ""}`
  }
  const installs: [boolean, string][] = [[step.root, step.repo], [step.cli, cli]]
  for (const [changed, directory] of installs) {
    if (!changed && existsSync(path.join(directory, "node_modules"))) continue
    const failed = run("bun", ["install", "--frozen-lockfile"], directory)
    if (failed) return failed
  }
  const built = run("bun", ["run", "build"], cli)
  if (built) return built
  // install needs Node (the MCP server and relay run under it), not the bun that may be running this.
  const node = process.versions.bun ? "node" : process.execPath
  return run(node, [path.join(cli, "dist", "cli.mjs"), "install", ...step.args], cli)
}

/** Install's flags passed through; update never waits for the extension to connect. */
function installArgs(args: readonly string[]) {
  const passed: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--opencode" && args[index + 1] !== undefined) passed.push(arg, args[++index]!)
    else if (arg === "--no-open") passed.push(arg)
  }
  return [...passed, "--no-wait"]
}

/** `opencode-browser update`: returns the exit code. */
export function runUpdate(args: readonly string[], deps: UpdateDeps): number {
  const { log } = deps
  const refuse = (problem: string, fix: string) => {
    log(`✗ Not updated: ${problem}`)
    log(`  ${fix}`)
    return 1
  }
  const repo = deps.repo
  if (!repo) {
    log("OpenCode Browser was installed from npm. Update it with:")
    log("  npx @opencode/browse@latest install")
    log("then restart opencode.")
    return 0
  }
  const git = deps.git ?? syncGit(repo)
  const at = shellQuoted(repo)
  const version = git(["--version"])
  if (version.error || version.status !== 0) return refuse("git isn't installed or isn't on PATH.", "Install git, then run this again.")
  const top = git(["rev-parse", "--show-toplevel"]).stdout
  if (!top || realpath(top) !== realpath(repo))
    return refuse(`${repo} isn't a git clone.`, `Clone it again: git clone https://github.com/anomalyco/browse.git && cd browse && bun run setup`)
  if (!(deps.hasBun ?? (() => !spawnSync("bun", ["--version"], { stdio: "ignore" }).error))())
    return refuse("bun isn't installed or isn't on PATH (setup builds with it).", "Install Bun from https://bun.sh, then run this again.")

  const branch = git(["symbolic-ref", "--short", "-q", "HEAD"]).stdout
  const head = git(["rev-parse", "HEAD"]).stdout
  if (!branch)
    return refuse(`${repo} isn't on a branch (HEAD is detached at ${short(head)}).`, `Check out the branch to follow, e.g. \`git -C ${at} checkout main\`, then run this again.`)
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).stdout
  const remote = git(["config", `branch.${branch}.remote`]).stdout
  const merge = git(["config", `branch.${branch}.merge`]).stdout
  if (!upstream || !remote || !merge || remote === ".")
    return refuse(`branch ${branch} doesn't track a remote branch.`, `Set one, e.g. \`git -C ${at} branch --set-upstream-to origin/main\`, then run this again.`)

  // Tracked files only, staged or not: untracked ones (the pairing code, builds) never stop a fast-forward.
  const changes = git(["diff", "--name-only", "HEAD"]).stdout
  if (changes) {
    const files = changes.split(/\r?\n/)
    return refuse(
      `${repo} has uncommitted changes (${files.slice(0, 5).join(", ")}${files.length > 5 ? `, and ${files.length - 5} more` : ""}).`,
      `Commit or stash them (\`git -C ${at} stash\`), then run this again.`,
    )
  }

  const fetched = git(["fetch", "--quiet", remote, merge], 120_000)
  if (fetched.status !== 0) {
    const url = git(["remote", "get-url", remote]).stdout
    return refuse(
      `couldn't fetch ${upstream}${url ? ` from ${url}` : ""}: ${firstLine(fetched.stderr) || fetched.error?.message || "git fetch failed"}.`,
      "Check your network connection, then run this again.",
    )
  }
  const latest = git(["rev-parse", "FETCH_HEAD"]).stdout
  if (!latest) return refuse(`couldn't read ${upstream} after fetching.`, `Run \`git -C ${at} pull --ff-only\` to see why.`)
  if (latest === head || git(["merge-base", "--is-ancestor", latest, "HEAD"]).status === 0) {
    log(`✓ Already up to date: ${short(head)} on ${branch} (${upstream}).`)
    return 0
  }
  if (git(["merge-base", "--is-ancestor", "HEAD", latest]).status !== 0) {
    const counts = git(["rev-list", "--left-right", "--count", `HEAD...${latest}`]).stdout.split(/\s+/)
    return refuse(
      `${branch} has diverged from ${upstream} (${counts[0] ?? "?"} local commit(s), ${counts[1] ?? "?"} new on the remote), so it can't fast-forward.`,
      `Reconcile them yourself (e.g. \`git -C ${at} pull --rebase\`), then run \`cd ${at} && bun run setup\`.`,
    )
  }

  const count = Number(git(["rev-list", "--count", `HEAD..${latest}`]).stdout) || 0
  const commits = git(["log", "--oneline", "--no-decorate", "-n", "20", `HEAD..${latest}`]).stdout
  const changed = (...files: string[]) => !!git(["diff", "--name-only", "HEAD", latest, "--", ...files]).stdout
  const rootDeps = changed("package.json", "bun.lock")
  const cliDeps = changed("cli/package.json", "cli/bun.lock")

  log(`Updating browse ${short(head)} → ${short(latest)} (${count} new commit${count === 1 ? "" : "s"} on ${upstream}):`)
  for (const line of commits.split(/\r?\n/).filter(Boolean)) log(`  ${line}`)
  if (count > 20) log(`  … and ${count - 20} more`)
  log("")

  const pulled = git(["merge", "--ff-only", "--quiet", latest], 60_000)
  if (pulled.status !== 0)
    return refuse(`couldn't fast-forward to ${short(latest)}: ${firstLine(pulled.stderr) || "git merge failed"}.`, `Run \`git -C ${at} pull --ff-only\` to see why.`)

  const failed = (deps.setup ?? defaultSetup)({ repo, root: rootDeps, cli: cliDeps, args: installArgs(args) })
  if (failed) {
    log("")
    log(`✗ Pulled ${short(head)} → ${short(latest)}, but setup failed: ${failed}.`)
    log(`  Fix it, then run \`cd ${at} && bun run setup\`.`)
    return 1
  }
  log("")
  log(`✓ Updated browse ${short(head)} → ${short(latest)}.`)
  log("  Restart opencode to load the new browse MCP server.")
  return 0
}

/** `opencode-browser update [--check]`. */
export async function runUpdateCommand(args: readonly string[]) {
  const log = (line: string) => process.stdout.write(line + "\n")
  const { runNpmUpdate } = await import("./runtime-update.ts")
  if (await runNpmUpdate(args)) return
  if (args.includes("--check")) {
    const repo = checkoutRoot()
    if (!repo) return log("Installed from npm: run `npx @opencode/browse@latest install` to update.")
    // Ask the remote now, whatever the cache says.
    const check = await checkForUpdate(repo)
    if (check) writeCache(path.join(dataRoot(), CACHE_FILE), check)
    if (!check) return log("Can't check: this clone isn't on a branch that tracks a remote.")
    if (check.failed) return log(`Can't check: ${check.upstream} couldn't be reached.`)
    return log(check.available ? formatUpdateNotice({ summary: describeUpdate(check), command: cliCommand("update") }) : `✓ Up to date with ${check.upstream}.`)
  }
  process.exitCode = runUpdate(args, { repo: checkoutRoot(), log })
}
