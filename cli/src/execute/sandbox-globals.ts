import { Effect } from "effect"
import type { Browser, BrowserContext, Page } from "patchright-core"
import { startDemonstrationRecorder } from "./demonstration.ts"
import { createExecuteFiles, sandboxModules, type ExecuteRealm } from "../execute-realm.ts"
import {
  clearGhostCursorCallouts,
  hideGhostCursor as hideGhostCursorOnPage,
  setGhostCursorCaption,
  setGhostCursorSpotlight,
  showGhostCursor as showGhostCursorOnPage,
  showGhostCursorCallout,
  showGhostCursorKeys,
  zoomGhostCursorCamera,
} from "../ghost-cursor.ts"
import type * as NetworkCapture from "../network-capture.ts"
import { PageConsole } from "./console.ts"
import { createScreenshotDiff } from "../snapshot/screenshot-diff.ts"
import {
  createAriaSnapshotHelper,
  createSnapshotHelpers,
  fillInput,
  fillInputs,
  screenshotWithLabels,
  type SnapshotRefRegistry,
} from "../snapshot.ts"
import { createWebMcpHelper } from "./webmcp.ts"
import {
  nodeModules,
  type HandoffCallOptions,
  type HideGhostCursorOptions,
  type SandboxGlobals,
  type ShowGhostCursorOptions,
} from "./code-runner.ts"
import {
  defaultHandoffMessage,
  defaultHandoffTimeoutMs,
  finishHandoff,
  handoffPageContextTimeoutMs,
  SessionPageRecoveryError,
  SessionPageRepairRequired,
  type RequestHandoff,
} from "./page-recovery.ts"
import { pageTargetId } from "./target-selection.ts"
import type { ExecuteSecretsBridge } from "./secrets-bridge.ts"

export function buildSandboxGlobals(deps: {
  readonly browser: Browser
  readonly context: BrowserContext
  readonly page: Page
  readonly state: Record<string, unknown>
  readonly realm: ExecuteRealm | undefined
  readonly snapshotRefs: SnapshotRefRegistry
  readonly networkCapture: NetworkCapture.Recorder
  readonly secrets: ExecuteSecretsBridge
  readonly requestHandoff: RequestHandoff | undefined
  readonly isRecordingTarget: ((targetId: string) => boolean) | undefined
  readonly isDefaultPage: (candidate: Page) => boolean
  readonly resolveDefaultPage: () => Promise<Page>
  readonly disconnectSettled: () => Effect.Effect<void, Error>
  readonly warnSyntheticInput: () => void
}): SandboxGlobals {
  const { browser, context, page } = deps
  const showGhostCursor = async (options?: ShowGhostCursorOptions) => {
    const { page: targetPage = page, ...cursorOptions } = options ?? {}
    await showGhostCursorOnPage({ page: targetPage, cursorOptions })
  }
  const hideGhostCursor = async (options?: HideGhostCursorOptions) => {
    await hideGhostCursorOnPage({ page: options?.page ?? page })
  }
  const ariaSnapshot = createAriaSnapshotHelper(page)
  const { snapshot, ref } = createSnapshotHelpers(page, deps.snapshotRefs)
  const screenshotDiff = createScreenshotDiff(page)
  const handoffTracker = { count: 0 }
  const requestHandoff = deps.requestHandoff
  const handoff = async (message?: string, options?: HandoffCallOptions) => {
    if (!requestHandoff) {
      throw new Error("handoff is not available in this sandbox; it requires a relay-backed browse session")
    }
    const handoffMessage = message?.trim() || defaultHandoffMessage
    const timeoutMs = options?.timeoutMs ?? defaultHandoffTimeoutMs
    const handoffPage = options?.page ?? page
    if (handoffPage.isClosed() || handoffPage.context() !== context) {
      throw new Error("handoff requires an open page in the current browser context")
    }
    const followsDefaultPage = deps.isDefaultPage(handoffPage)
    const targetId = await pageTargetId(handoffPage)
    const outcome = await requestHandoff({
      message: handoffMessage,
      timeoutMs,
      target: { targetId },
      ...(options?.start ? { start: options.start } : {}),
      ...(options?.start ? { cancelStart: () => Effect.runPromise(deps.disconnectSettled()) } : {}),
    })
    await finishHandoff({
      outcome,
      message: handoffMessage,
      timeoutMs,
      contextTimeoutMs: handoffPageContextTimeoutMs,
      evaluate: async () => {
        try {
          const currentPage = followsDefaultPage ? await deps.resolveDefaultPage() : handoffPage
          await currentPage.evaluate(() => true)
        } catch (error) {
          if ((error instanceof SessionPageRecoveryError && error.reason === "target-unavailable") || error instanceof SessionPageRepairRequired) {
            throw new Error("Execution context is not available while the handoff destination settles", { cause: error })
          }
          throw error
        }
      },
    })
    handoffTracker.count += 1
  }
  const demonstrate = async (message?: string, options?: HandoffCallOptions) => {
    const demonstrationPage = options?.page ?? page
    if (demonstrationPage.isClosed() || demonstrationPage.context() !== context) {
      throw new Error("demonstrate requires an open page in the current browser context")
    }
    const recorder = await startDemonstrationRecorder(demonstrationPage)
    try {
      await handoff(message ?? "Demonstrate the browser flow, then continue", { ...options, page: demonstrationPage })
    } catch (error) {
      await recorder.stop().catch(() => {})
      throw error
    }
    return await recorder.stop()
  }
  return {
    browser,
    context,
    page,
    state: deps.state,
    modules: deps.realm ? deps.realm.proxyAsObject({ ...sandboxModules }) : nodeModules,
    files: deps.realm ? deps.realm.proxyAsObject(createExecuteFiles()) : createExecuteFiles(),
    fillInput: async (target, value) => {
      await fillInput({ page, target, value })
      deps.warnSyntheticInput()
    },
    fillInputs: async (targetPage, fields) => {
      await fillInputs(targetPage, fields)
      deps.warnSyntheticInput()
    },
    screenshotWithLabels: async (screenshotOptions = {}) => {
      const labelsPage = screenshotOptions.page ?? page
      // A recorded tab must not show the labels: they go onto the image instead.
      const recorded = deps.isRecordingTarget
        ? deps.isRecordingTarget(await pageTargetId(labelsPage).catch(() => ""))
        : false
      return await screenshotWithLabels({
        ...screenshotOptions,
        page: labelsPage,
        registry: deps.snapshotRefs,
        ...(recorded ? { offPage: true } : {}),
      })
    },
    // Named property functions: the execute realm checks their file options by name.
    screenshotDiff: (diffOptions) => screenshotDiff(diffOptions),
    ariaSnapshot,
    snapshot,
    ref,
    webmcp: createWebMcpHelper(page),
    showGhostCursor,
    hideGhostCursor,
    ghostCursor: {
      show: showGhostCursor,
      hide: hideGhostCursor,
      caption: async (title, captionOptions) => {
        const { page: targetPage = page, ...rest } = captionOptions ?? {}
        await setGhostCursorCaption({ page: targetPage, title, captionOptions: rest })
      },
      clearCaption: async (clearOptions) => {
        await setGhostCursorCaption({ page: clearOptions?.page ?? page, title: null })
      },
      callout: async (target, label, calloutOptions) => {
        const { page: targetPage = page, ...rest } = calloutOptions ?? {}
        await showGhostCursorCallout({ page: targetPage, target, label, calloutOptions: rest })
      },
      clearCallouts: async (clearOptions) => {
        await clearGhostCursorCallouts({ page: clearOptions?.page ?? page })
      },
      zoom: async (target, zoomOptions) => {
        const { page: targetPage = page, ...rest } = zoomOptions ?? {}
        await zoomGhostCursorCamera({ page: targetPage, target, zoomOptions: rest })
      },
      resetZoom: async (resetOptions) => {
        const { page: targetPage = page, ...rest } = resetOptions ?? {}
        await zoomGhostCursorCamera({ page: targetPage, target: null, zoomOptions: rest })
      },
      spotlight: async (target, spotlightOptions) => {
        const { page: targetPage = page, ...rest } = spotlightOptions ?? {}
        await setGhostCursorSpotlight({ page: targetPage, target, spotlightOptions: rest })
      },
      clearSpotlight: async (clearOptions) => {
        await setGhostCursorSpotlight({ page: clearOptions?.page ?? page, target: null })
      },
      keys: async (keys, label, keyOptions) => {
        await showGhostCursorKeys({ page: keyOptions?.page ?? page, keys, ...(label ? { label } : {}) })
      },
    },
    handoff,
    demonstrate,
    network: {
      start: (options) => Effect.runPromise(deps.networkCapture.start(page, options)),
      status: () => deps.networkCapture.status(),
      stop: (options) => Effect.runPromise(deps.networkCapture.stop(options)),
      cancel: () => Effect.runPromise(deps.networkCapture.cancel()),
    },
    pageConsole: {
      start: (target) => PageConsole.start(target ?? page),
      stop: (target) => PageConsole.stop(target ?? page),
    },
    secrets: {
      type: (target, name, typeOptions) => deps.secrets.typeSecret(page, target, name, typeOptions),
      signIn: (signInOptions) => deps.secrets.signIn(page, signInOptions),
      usePasskey: (passkeyOptions) => deps.secrets.usePasskey(passkeyOptions?.page ?? page, passkeyOptions),
    },
    handoffTracker,
  }
}
