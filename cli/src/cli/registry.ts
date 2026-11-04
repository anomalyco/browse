import type { Command } from "effect/cli"
import type * as RelayClient from "../relay-client.ts"
import type * as SessionStore from "../session-store.ts"

export type CliServices = RelayClient.Service | SessionStore.Service | Command.Environment

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RegisteredSubcommand = Command.Command<any, any, any, unknown, CliServices>

export type CliCommandContext = {
  readonly packageRoot: string
}

type RegisteredEntry = {
  readonly order: number
  readonly build: (ctx: CliCommandContext) => RegisteredSubcommand
}

const entries: RegisteredEntry[] = []

/**
 * Register a top-level CLI subcommand from its own feature module rather than appending to a central list.
 * Entries are sorted deterministically by `order`.
 */
export function registerCliCommand<Name extends string, Input, ContextInput, E, R extends CliServices>(
  order: number,
  build: (ctx: CliCommandContext) => Command.Command<Name, Input, ContextInput, E, R>,
): void {
  entries.push({
    order,
    build: build as (ctx: CliCommandContext) => RegisteredSubcommand,
  })
}

export function buildRegisteredCliCommands(ctx: CliCommandContext): readonly RegisteredSubcommand[] {
  return [...entries]
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.build(ctx))
}
