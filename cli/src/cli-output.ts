import { writeSync } from "node:fs"

export interface FailureEnvelope {
  readonly ok: false
  readonly command: string
  readonly checkedAt: string
  readonly error: {
    readonly code: string
    readonly message: string
    readonly hint?: string
    readonly exitCode: number
  }
}

/** 2 usage, 3 auth/permission, 4 relay or extension unreachable. */
export const ExitCode = { ok: 0, failure: 1, usage: 2, auth: 3, host: 4 } as const
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

export const failure = (
  command: string,
  code: string,
  message: string,
  options: { readonly hint?: string; readonly exitCode?: number } = {},
): FailureEnvelope => ({
  ok: false,
  command,
  checkedAt: new Date().toISOString(),
  error: {
    code,
    message,
    ...(options.hint ? { hint: options.hint } : {}),
    exitCode: options.exitCode ?? ExitCode.failure,
  },
})

/** `--json` may appear anywhere before `--`, including before the subcommand. */
export const takeJsonFlag = (argv: ReadonlyArray<string>) => ({
  json: argv.includes("--json"),
  argv: argv.filter((arg) => arg !== "--json"),
})

const pause = new Int32Array(new SharedArrayBuffer(4))

/**
 * Write all of `text` to stdout synchronously so large piped JSON outputs
 * past 64 KiB are never truncated on process exit.
 */
export const writeStdout = (text: string, fd = 1): void => {
  const buffer = Buffer.from(text)
  let offset = 0
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset, buffer.length - offset)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EPIPE") return
      if (code !== "EAGAIN") throw error
      Atomics.wait(pause, 0, 0, 2)
    }
  }
}

export const printJson = (value: unknown): void => writeStdout(`${JSON.stringify(value, null, 2)}\n`)
