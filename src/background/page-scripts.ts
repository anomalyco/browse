export * as PageScripts from "./page-scripts"

import { DebuggerHub } from "./debugger-hub"

// The page-status script (src/content/page-status.ts) runs only in tabs agents use: it is injected with the first
// page status the relay sends for a tab and again after each navigation of such a tab, never into every page the
// user visits. Injecting twice is harmless; the script keeps its first copy in a document.

const FILE = "content.js"
const OWNER = "relay"

/** Injects the page-status script into the tab's top frame; restricted pages (chrome://, the Web Store) refuse it. */
export async function inject(tabId: number) {
  await chrome.scripting
    .executeScript({ target: { tabId }, files: [FILE], injectImmediately: true })
    .catch(() => undefined)
}

/**
 * Messages the tab's page-status script, injecting it first when the document doesn't have it yet. Pages that refuse
 * the script (about:blank, chrome://, the Web Store) get nothing: the caller keeps the status, and the script asks for
 * it ("page-status.ready") once the tab navigates to a page that takes the injection.
 */
export async function send(tabId: number, message: object) {
  try {
    return await chrome.tabs.sendMessage(tabId, message)
  } catch {
    await inject(tabId)
    return await chrome.tabs.sendMessage(tabId, message).catch(() => undefined)
  }
}

// A navigation starts a new document without the script. "loading" can still be the old document, so inject on
// "complete" too.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "loading" && change.status !== "complete") return
  if (DebuggerHub.tabsOwnedBy(OWNER).includes(tabId)) void inject(tabId)
})
