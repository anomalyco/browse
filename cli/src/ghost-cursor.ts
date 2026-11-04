import { Effect, Match, Predicate } from "effect"
import { ghostCursorMotionSource } from "./ghost-cursor/client-motion.ts"
import { ghostCursorOverlaysSource } from "./ghost-cursor/client-overlays.ts"
import {
  clearGhostCursorCallouts,
  ghostCursorCommandMethod,
  hideGhostCursor,
  setGhostCursorCaption,
  setGhostCursorSpotlight,
  showGhostCursor,
  showGhostCursorCallout,
  showGhostCursorKeys,
  zoomGhostCursorCamera,
} from "./ghost-cursor/page-commands.ts"
import {
  ghostCursorOperations,
  type GhostCursorCalloutOptions,
  type GhostCursorCaptionOptions,
  type GhostCursorClientOptions,
  type GhostCursorMouseAction,
  type GhostCursorSpotlightOptions,
  type GhostCursorTabState,
  type GhostCursorZoomOptions,
} from "./ghost-cursor/types.ts"
import type { JsonObject } from "./protocol.ts"

export {
  clearGhostCursorCallouts,
  ghostCursorCommandMethod,
  hideGhostCursor,
  setGhostCursorCaption,
  setGhostCursorSpotlight,
  showGhostCursor,
  showGhostCursorCallout,
  showGhostCursorKeys,
  zoomGhostCursorCamera,
  type GhostCursorCalloutOptions,
  type GhostCursorCaptionOptions,
  type GhostCursorClientOptions,
  type GhostCursorMouseAction,
  type GhostCursorSpotlightOptions,
  type GhostCursorZoomOptions,
}

// The cursor and its overlays render in a CDP isolated world the relay creates for the tab (GhostCursorTabs
// below), inside a closed shadow root on a host element without an id. The page cannot see the script's globals,
// its observers or timers; only the host element while something is shown.
export const ghostCursorClientSource = `${ghostCursorMotionSource}\n\n${ghostCursorOverlaysSource}`

export function inputDispatchMouseEventToGhostCursorAction(params: JsonObject | undefined): GhostCursorMouseAction | undefined {
  if (!params) {
    return undefined
  }
  const type = params.type
  if (type !== "mouseMoved" && type !== "mousePressed" && type !== "mouseReleased") {
    return undefined
  }
  if (!Predicate.isNumber(params.x) || !Predicate.isNumber(params.y)) {
    return undefined
  }
  const button = parseButton(params.button)
  return {
    type: Match.value(type).pipe(
      Match.when("mousePressed", () => "down" as const),
      Match.when("mouseReleased", () => "up" as const),
      Match.when("mouseMoved", () => "move" as const),
      Match.exhaustive,
    ),
    x: params.x,
    y: params.y,
    button,
  }
}

type SendDebuggerCommand = (command: {
  readonly tabId: number
  readonly method: string
  readonly params: JsonObject
}) => Effect.Effect<unknown, Error>

/**
 * The relay's ghost cursor, per tab. It is off unless the default says so (`shownByDefault`: the status page's
 * "Agent cursor" setting or OPENCODE_BROWSER_GHOST_CURSOR outside recordings, a recording's cursor: true on a recorded
 * tab), or the agent calls showGhostCursor(). While it is off the relay sends
 * nothing to the page for it. While it is on it runs in an isolated world (Page.createIsolatedWorld, which
 * returns the same world for the same name until the document changes), so the page's own scripts can't see
 * it. Position and caption live here, in the relay, and are restored on the next document.
 */
export class GhostCursorTabs {
  private readonly tabs = new Map<number, GhostCursorTabState>()
  private readonly worldName = globalThis.crypto.randomUUID().replaceAll("-", "")
  /** Tabs showing the cursor only because of the default (a recording); it goes once that ends. */
  private readonly shownByDefault = new Set<number>()
  private watchTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: {
    readonly send: SendDebuggerCommand
    readonly mainFrameId: (tabId: number) => string | undefined
    /** Whether the cursor shows on a tab the agent hasn't shown or hidden it on. */
    readonly shownByDefault: (tabId: number) => boolean
  }) {}

  visible(tabId: number): boolean {
    const mode = this.tabs.get(tabId)?.mode
    return mode === "persistent" || (mode === undefined && this.options.shownByDefault(tabId))
  }

  /** Animates the cursor toward an Input.dispatchMouseEvent target; only remembers the position while hidden. */
  readonly mouseEvent = Effect.fnUntraced(function* (this: GhostCursorTabs, tabId: number, params: JsonObject | undefined) {
    const action = inputDispatchMouseEventToGhostCursorAction(params)
    if (!action) return
    const state = this.state(tabId)
    const previous = state.position
    state.position = { x: action.x, y: action.y }
    if (!this.visible(tabId)) return
    yield* Effect.gen({ self: this }, function* () {
      if (!state.drawn) {
        yield* this.call(tabId, "show", state.cursorOptions ?? {})
        if (previous) yield* this.call(tabId, "restore", previous)
        this.drawn(tabId, state)
      }
      yield* this.call(tabId, "applyMouseEvent", action, true)
    }).pipe(Effect.timeout("2 seconds"), Effect.ignore)
  })

  /** A new main-frame document: put the visible cursor and caption back where they were. */
  readonly documentCreated = Effect.fnUntraced(function* (this: GhostCursorTabs, tabId: number) {
    const state = this.tabs.get(tabId)
    if (!state) return
    state.drawn = false
    if (state.position && this.visible(tabId)) {
      yield* this.call(tabId, "show", state.cursorOptions ?? {})
      yield* this.call(tabId, "restore", state.position)
      this.drawn(tabId, state)
    }
    if (state.caption) yield* this.call(tabId, "setCaption", state.caption)
  })

  /** Answers ghostCursorCommandMethod from execute's ghostCursor helpers. */
  readonly command = Effect.fnUntraced(function* (this: GhostCursorTabs, tabId: number, params: JsonObject | undefined) {
    const operation = params?.op
    if (!Predicate.isString(operation) || !ghostCursorOperations.has(operation)) {
      return yield* Effect.fail(new Error(`Unknown ghost cursor operation: ${String(operation)}`))
    }
    const payload = params?.payload ?? null
    const state = this.state(tabId)
    if (operation === "show") {
      state.mode = "persistent"
      state.cursorOptions = Predicate.isObject(payload) && !Array.isArray(payload) ? payload as JsonObject : {}
      yield* this.call(tabId, "show", state.cursorOptions)
      if (state.position) yield* this.call(tabId, "restore", state.position)
      state.drawn = true
      return {}
    }
    if (operation === "hide") {
      state.mode = "disabled"
      state.drawn = false
      delete state.caption
      yield* this.call(tabId, "hide", null, false, false)
      return {}
    }
    if (operation === "setCaption") {
      if (Predicate.isObject(payload) && !Array.isArray(payload)) state.caption = payload as JsonObject
      else delete state.caption
    }
    yield* this.call(tabId, operation, payload, operation === "zoomTo" || operation === "setSpotlight")
    return {}
  })

  forget(tabId: number): void {
    this.tabs.delete(tabId)
    this.shownByDefault.delete(tabId)
  }

  private drawn(tabId: number, state: GhostCursorTabState): void {
    state.drawn = true
    if (state.mode === "persistent") return
    this.shownByDefault.add(tabId)
    // Recordings end in their own modules; check once a second and take the cursor away when one has.
    this.watchTimer ??= setInterval(() => void this.refresh(), 1_000)
    this.watchTimer.unref?.()
  }

  /**
   * Takes the cursor away now from tabs (all by default) that showed it only by default and no longer should: the
   * setting turned off, or a recording without the cursor started.
   */
  refresh(tabIds: Iterable<number> = this.shownByDefault): Promise<void> {
    const hides: Promise<void>[] = []
    for (const id of Array.from(tabIds)) {
      if (!this.shownByDefault.has(id) || this.visible(id)) continue
      this.shownByDefault.delete(id)
      const current = this.tabs.get(id)
      if (current) {
        current.drawn = false
        delete current.caption
      }
      hides.push(Effect.runPromise(Effect.ignore(this.call(id, "hide", null, false, false).pipe(Effect.timeout("2 seconds")))).catch(() => {}))
    }
    if (this.shownByDefault.size === 0 && this.watchTimer) {
      clearInterval(this.watchTimer)
      this.watchTimer = undefined
    }
    return Promise.all(hides).then(() => undefined)
  }

  private state(tabId: number): GhostCursorTabState {
    let state = this.tabs.get(tabId)
    if (!state) {
      state = {}
      this.tabs.set(tabId, state)
    }
    return state
  }

  /**
   * Calls the cursor API in the tab's isolated world, installing it first when the document is new. With
   * `install` false a missing cursor is left alone (nothing to hide).
   */
  private readonly call = Effect.fnUntraced(function* (
    this: GhostCursorTabs,
    tabId: number,
    method: string,
    payload: unknown,
    awaitPromise = false,
    install = true,
  ) {
    const frameId = this.options.mainFrameId(tabId)
    if (!frameId) return
    const world = yield* this.options.send({
      tabId,
      method: "Page.createIsolatedWorld",
      params: { frameId, worldName: this.worldName },
    })
    const contextId = Predicate.isObject(world) && "executionContextId" in world ? world.executionContextId : undefined
    if (!Predicate.isNumber(contextId)) return
    const api = "globalThis.__opencodeBrowserGhostCursor"
    const evaluate = (expression: string) => this.options.send({
      tabId,
      method: "Runtime.evaluate",
      params: { expression, contextId, awaitPromise, returnByValue: true, silent: true },
    })
    const invoke = `${api}?.${method}(${JSON.stringify(payload)})`
    if (!install) {
      yield* evaluate(invoke)
      return
    }
    const result = yield* evaluate(`${api} ? ${invoke} : ${JSON.stringify(missingGhostCursor)}`)
    const value = Predicate.isObject(result) && "result" in result && Predicate.isObject(result.result) && "value" in result.result
      ? result.result.value
      : undefined
    if (value !== missingGhostCursor) return
    yield* evaluate(`${ghostCursorClientSource}\n${invoke}`)
  })
}

const missingGhostCursor = "__missing__"

function parseButton(value: JsonObject[string] | undefined): GhostCursorMouseAction["button"] {
  if (value === "left" || value === "right" || value === "middle" || value === "none") {
    return value
  }
  return "none"
}
