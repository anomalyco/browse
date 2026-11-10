import { describe, expect, test } from "bun:test"
import { AriaSnapshotRedactionError, isRedactionCleanupFailure } from "../src/snapshot/aria-snapshot.ts"
import { frameFailureNote, frameSkipNote } from "../src/snapshot/frames.ts"

describe("aria snapshot redaction failures", () => {
  test("a cleanup failure for a captured frame fails the call", () => {
    expect(isRedactionCleanupFailure(new AriaSnapshotRedactionError([new Error("off_ timed out")], false))).toBe(true)
  })

  test("a cleanup failure after a failed capture stays a note", () => {
    // The read never completed, so the frame's content is not used; a frame that hung through its own cleanup
    // must not take the rest of the snapshot down with it.
    expect(isRedactionCleanupFailure(new AriaSnapshotRedactionError([new Error("read timed out"), new Error("off_ timed out")], true))).toBe(false)
  })

  test("lookalike errors are not cleanup failures", () => {
    expect(isRedactionCleanupFailure(new Error("browse could not confirm ARIA snapshot value-redaction cleanup"))).toBe(false)
    expect(isRedactionCleanupFailure(new AggregateError([], "aggregate"))).toBe(false)
    expect(isRedactionCleanupFailure("browse could not confirm ARIA snapshot value-redaction cleanup")).toBe(false)
  })
})

describe("frame failure notes", () => {
  test("classifies a destroyed or closed frame", () => {
    expect(frameFailureNote(new Error("Execution context was destroyed."))).toBe("the frame changed while capturing")
    expect(frameFailureNote(new Error("Frame was detached"))).toBe("the frame changed while capturing")
    expect(frameFailureNote(new Error("Target page, context or browser has been closed"))).toBe("the frame changed while capturing")
  })

  test("classifies a timeout and anything else", () => {
    expect(frameFailureNote(new Error("Frame snapshot timed out after 1000ms"))).toBe("the frame did not answer before the snapshot deadline")
    expect(frameFailureNote(new Error("Cannot evaluate in this document"))).toBe("the frame could not be read")
  })

  test("skip notes count frames, not lines", () => {
    expect(frameSkipNote(1, "maxItems reached")).toBe("- ... 1 iframe content not captured (maxItems reached)")
    expect(frameSkipNote(3, "snapshot deadline reached")).toBe("- ... 3 iframe contents not captured (snapshot deadline reached)")
  })
})
