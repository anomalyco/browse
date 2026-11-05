// Keep Patchright behind this dynamic import boundary: compiled dispatch-fault stacks must identify the
// dependency (coreBundle-<hash>.js), not the relay. Only dependency code belongs in this chunk.
export { chromium, errors, selectors } from "patchright-core"
// @ts-expect-error Patchright exports its internal CommonJS bundle without a declaration file.
export { default as internals } from "patchright-core/lib/coreBundle"
