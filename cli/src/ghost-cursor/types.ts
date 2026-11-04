import type { JsonObject } from "../protocol.ts"

export type GhostCursorStyle = "distance-glide" | "spring-inertia"

export type GhostCursorClientOptions = {
  readonly color?: string
  readonly size?: number
  readonly zIndex?: number
  readonly style?: GhostCursorStyle
}

export type GhostCursorTone = "neutral" | "accent" | "success" | "warn"

export type GhostCursorCaptionOptions = {
  readonly subtitle?: string
  readonly step?: string
  readonly tone?: GhostCursorTone
}

export type GhostCursorCalloutOptions = {
  readonly detail?: string
  readonly tone?: GhostCursorTone
}

export type GhostCursorZoomOptions = {
  readonly scale?: number
  readonly durationMs?: number
}

export type GhostCursorSpotlightOptions = {
  readonly label?: string
  readonly detail?: string
  readonly tone?: GhostCursorTone
  readonly padding?: number
  readonly dim?: number
}

export type GhostCursorMouseAction = {
  readonly type: "move" | "down" | "up"
  readonly x: number
  readonly y: number
  readonly button: "left" | "right" | "middle" | "none"
}

export type GhostCursorCaptionPayload = {
  readonly title: string
  readonly options?: GhostCursorCaptionOptions
}

export type GhostCursorRect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type GhostCursorCalloutPayload = {
  readonly rect: GhostCursorRect
  readonly label: string
  readonly options?: GhostCursorCalloutOptions
}

export type GhostCursorZoomPayload = {
  readonly rect: GhostCursorRect | null
  readonly scale: number
  readonly durationMs: number
}

export type GhostCursorSpotlightPayload = {
  readonly rect: GhostCursorRect | null
  readonly options?: GhostCursorSpotlightOptions
}

export type GhostCursorKeysPayload = {
  readonly keys: readonly string[]
  readonly label?: string
}

export type GhostCursorOperation =
  | "show"
  | "hide"
  | "setCaption"
  | "showCallout"
  | "clearCallouts"
  | "zoomTo"
  | "setSpotlight"
  | "showKeys"

export const ghostCursorOperations: ReadonlySet<string> = new Set<GhostCursorOperation>([
  "show",
  "hide",
  "setCaption",
  "showCallout",
  "clearCallouts",
  "zoomTo",
  "setSpotlight",
  "showKeys",
])

export type GhostCursorPosition = { readonly x: number; readonly y: number }

export type GhostCursorTabState = {
  /** Set by showGhostCursor (persistent) or hideGhostCursor (disabled); otherwise the default applies. */
  mode?: "persistent" | "disabled"
  cursorOptions?: JsonObject
  position?: GhostCursorPosition
  caption?: JsonObject
  /** Whether the current document shows the cursor. */
  drawn?: boolean
}
