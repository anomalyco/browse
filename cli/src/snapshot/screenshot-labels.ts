import fs from "node:fs/promises"
import path from "node:path"
import type { Frame, Page } from "patchright-core"
import { PNG } from "pngjs"
import {
  invalidateSnapshotDocument,
  type ScreenshotLabel,
  type ScreenshotWithLabelsOptions,
  type ScreenshotWithLabelsResult,
} from "./types.ts"

export async function screenshotWithLabels(options: ScreenshotWithLabelsOptions = {}): Promise<ScreenshotWithLabelsResult> {
  if (!options.page) {
    throw new Error("screenshotWithLabels requires a page")
  }
  if (options.path !== undefined && !path.isAbsolute(options.path)) {
    throw new Error("screenshotWithLabels requires an absolute path")
  }

  const page = options.page
  const offPage = options.offPage === true
  const { labels, viewportWidth } = await showScreenshotLabels(page, !offPage)
  if (options.registry) {
    const registry = options.registry
    registry.removeNavigationListener?.()
    registry.selectors.clear()
    registry.page = page
    registry.url = page.url()
    for (const label of labels) {
      registry.selectors.set(label.ref, {
        selector: label.selector,
        role: "screenshot-label",
      })
    }
    const onFrameNavigated = (frame: Frame) => {
      if (frame !== page.mainFrame()) return
      invalidateSnapshotDocument(registry)
    }
    const removeNavigationListener = () => page.off("framenavigated", onFrameNavigated)
    page.on("framenavigated", onFrameNavigated)
    registry.removeNavigationListener = removeNavigationListener
  }
  try {
    const screenshot = offPage
      ? drawScreenshotLabels(await page.screenshot(), labels, viewportWidth)
      : await page.screenshot(options.path ? { path: options.path } : {})
    if (offPage && options.path) await fs.writeFile(options.path, screenshot)
    return {
      ...(options.path ? { path: options.path } : { image: screenshot }),
      size: screenshot.byteLength,
      labelCount: labels.length,
      labels,
    }
  } finally {
    if (!offPage) await hideScreenshotLabels(page)
  }
}

// Labels are drawn from Patchright's isolated (utility) world into a closed shadow root on a host without an
// id: the page can't see the script's state, and the host exists only until the screenshot is taken.
type ScreenshotLabelsWindow = Window & { __opencodeBrowserScreenshotLabels?: { readonly host: HTMLElement; readonly timer: number } }

async function showScreenshotLabels(page: Page, draw: boolean): Promise<{ readonly labels: readonly ScreenshotLabel[]; readonly viewportWidth: number }> {
  return await page.evaluate(({ draw }) => {
    type BrowserLabel = {
      readonly ref: string
      readonly selector: string
      readonly role: string
      readonly text: string
      readonly context?: string
      readonly tagName: string
      readonly rect: {
        readonly x: number
        readonly y: number
        readonly width: number
        readonly height: number
      }
    }

    const markerClass = "label"
    const opencodeBrowserWindow = window as ScreenshotLabelsWindow
    const previous = opencodeBrowserWindow.__opencodeBrowserScreenshotLabels
    if (previous) {
      window.clearTimeout(previous.timer)
      previous.host.remove()
      delete opencodeBrowserWindow.__opencodeBrowserScreenshotLabels
    }

    const selectors = [
      "button",
      "a[href]",
      "input",
      "textarea",
      "select",
      "summary",
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[role="option"]',
      '[role="switch"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="combobox"]',
      '[role="searchbox"]',
      '[role="textbox"]',
      '[role="slider"]',
      '[role="spinbutton"]',
      '[role="treeitem"]',
      "[onclick]",
      "[contenteditable]",
    ]
    const selectorString = selectors.join(",")
    const isShadowRoot = (node: unknown): node is ShadowRoot =>
      typeof ShadowRoot !== "undefined" && node instanceof ShadowRoot
    const queryDeep = (scope: Element | Document | ShadowRoot): Element[] => {
      if (!scope.children) {
        return Array.from(scope.querySelectorAll(selectorString))
      }
      const results: Element[] = []
      const visit = (node: Element | Document | ShadowRoot) => {
        for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
          if (child.matches(selectorString)) results.push(child)
          if (child.shadowRoot) visit(child.shadowRoot)
          if (child.firstElementChild) visit(child)
        }
      }
      visit(scope)
      return results
    }
    const candidates = queryDeep(document)
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        if (rect.width < 4 || rect.height < 4) {
          return false
        }
        if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) {
          return false
        }
        return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0"
      })
      .slice(0, 80)

    const localSelectorForElement = (element: Element, scope: Document | ShadowRoot): string => {
      const id = element.getAttribute("id")
      if (id) {
        return `#${CSS.escape(id)}`
      }
      for (const attr of ["data-testid", "data-test-id", "data-test"]) {
        const val = element.getAttribute(attr)
        if (val) return `[${attr}="${CSS.escape(val)}"]`
      }
      const name = element.getAttribute("name")
      if (name) {
        return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`
      }
      const parent = element.parentElement
      if (!parent) {
        if (isShadowRoot(scope)) {
          const siblings = Array.from(scope.children).filter((child) => child.tagName === element.tagName)
          return `${element.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(element) + 1})`
        }
        return element.tagName.toLowerCase()
      }
      const siblings = Array.from(parent.children).filter((child) => {
        return child.tagName === element.tagName
      })
      const index = siblings.indexOf(element) + 1
      return `${localSelectorForElement(parent, scope)} > ${element.tagName.toLowerCase()}:nth-of-type(${index})`
    }

    const selectorForElement = (element: Element): string => {
      const rootNode = element.getRootNode?.()
      if (isShadowRoot(rootNode)) {
        return `${selectorForElement(rootNode.host)} >> ${localSelectorForElement(element, rootNode)}`
      }
      return localSelectorForElement(element, document)
    }

    const roleForElement = (element: Element): string => {
      const explicitRole = element.getAttribute("role")
      if (explicitRole) {
        return explicitRole
      }
      if (element instanceof HTMLAnchorElement) {
        return "link"
      }
      if (element instanceof HTMLButtonElement) {
        return "button"
      }
      if (element instanceof HTMLInputElement) {
        return element.type || "input"
      }
      if (element instanceof HTMLTextAreaElement) {
        return "textarea"
      }
      if (element instanceof HTMLSelectElement) {
        return "select"
      }
      if (element instanceof HTMLElement && element.isContentEditable) {
        return "contenteditable"
      }
      return element.getAttribute("onclick") ? "onclick" : element.tagName.toLowerCase()
    }

    const textForElement = (element: Element): string => {
      const ariaLabel = element.getAttribute("aria-label")
      const title = element.getAttribute("title")
      const placeholder = element.getAttribute("placeholder")
      const value = element instanceof HTMLInputElement ? element.value : ""
      return (ariaLabel || placeholder || value || title || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80)
    }

    const normalizeText = (value: string): string => {
      return value.replace(/\s+/g, " ").trim()
    }

    const trimContext = (value: string): string => {
      return normalizeText(value).slice(0, 60)
    }

    const accessibleTextForElement = (element: Element): string => {
      const ariaLabel = element.getAttribute("aria-label")
      if (ariaLabel) {
        return ariaLabel
      }
      const labelledBy = element.getAttribute("aria-labelledby")
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
        if (normalizeText(text)) {
          return text
        }
      }
      if (element instanceof HTMLFieldSetElement) {
        const legend = element.querySelector(":scope > legend")
        if (legend?.textContent) {
          return legend.textContent
        }
      }
      const heading = element.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6")
      if (heading?.textContent) {
        return heading.textContent
      }
      return element.textContent ?? ""
    }

    const nearestPrecedingHeading = (element: Element): string => {
      const elementRect = element.getBoundingClientRect()
      const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']"))
      let nearest: Element | undefined
      let nearestDistance = Number.POSITIVE_INFINITY
      for (const heading of headings) {
        const rect = heading.getBoundingClientRect()
        if (rect.bottom > elementRect.top || rect.right < 0 || rect.left > window.innerWidth) {
          continue
        }
        const distance = elementRect.top - rect.bottom
        if (distance < nearestDistance) {
          nearest = heading
          nearestDistance = distance
        }
      }
      return nearest?.textContent ?? ""
    }

    const contextForElement = (element: Element, ownText: string): string | undefined => {
      const contextElement = element.closest("tr, [role='row'], li, [role='listitem'], fieldset, section, article, form, [aria-label], [aria-labelledby]")
      const rawContext = contextElement && contextElement !== element
        ? accessibleTextForElement(contextElement)
        : nearestPrecedingHeading(element)
      const context = trimContext(rawContext)
      const label = trimContext(ownText)
      if (!context || context.toLowerCase() === label.toLowerCase()) {
        return undefined
      }
      return context
    }

    const labels: BrowserLabel[] = candidates.map((element, index) => {
      const rect = element.getBoundingClientRect()
      const text = textForElement(element)
      const context = contextForElement(element, text)
      return {
        ref: `e${index + 1}`,
        selector: selectorForElement(element),
        role: roleForElement(element),
        text,
        ...(context ? { context } : {}),
        tagName: element.tagName.toLowerCase(),
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      }
    })

    if (!draw) return { labels, viewportWidth: window.innerWidth }
    const host = document.createElement("div")
    const container = host.attachShadow({ mode: "closed" })

    const style = document.createElement("style")
    style.textContent = `
      :host {
        all: initial !important;
        position: fixed !important;
        left: 0 !important;
        top: 0 !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
      }
      .${markerClass} {
        position: fixed;
        min-width: 18px;
        box-sizing: border-box;
        padding: 1px 4px;
        border: 1px solid #7c3aed;
        border-radius: 4px;
        background: #a78bfa;
        color: #111827;
        font-weight: 700;
        line-height: 16px;
        text-align: center;
        box-shadow: 0 1px 3px rgba(17, 24, 39, 0.35);
      }
    `
    container.appendChild(style)

    const markers = labels.map((label) => {
      const marker = document.createElement("div")
      marker.className = markerClass
      marker.textContent = label.ref
      marker.style.left = `${Math.max(0, label.rect.x)}px`
      marker.style.top = `${Math.max(0, label.rect.y - 18)}px`
      return marker
    })
    container.append(...markers)

    document.documentElement.appendChild(host)
    const timer = window.setTimeout(() => {
      host.remove()
      delete opencodeBrowserWindow.__opencodeBrowserScreenshotLabels
    }, 30_000)
    opencodeBrowserWindow.__opencodeBrowserScreenshotLabels = { host, timer }
    return { labels, viewportWidth: window.innerWidth }
  }, { draw }, undefined, true)
}

// 5x7 glyphs for label refs (e1, e2, ...), one row per string, "#" lit.
const labelGlyphs: Record<string, readonly string[]> = {
  e: ["     ", "     ", " ### ", "#   #", "#####", "#    ", " ####"],
  "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
  "1": ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
  "3": ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
  "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
  "5": ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
  "6": ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
  "7": ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
  "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  "9": [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
}

/** Draws the label markers onto a PNG screenshot, where showScreenshotLabels would have put them in the page. */
function drawScreenshotLabels(image: Buffer, labels: readonly ScreenshotLabel[], viewportWidth: number): Buffer {
  const png = PNG.sync.read(image)
  const scale = viewportWidth > 0 ? png.width / viewportWidth : 1
  const fill = (x0: number, y0: number, width: number, height: number, [r, g, b]: readonly [number, number, number]) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(png.height, Math.round(y0 + height)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(png.width, Math.round(x0 + width)); x++) {
        const offset = (y * png.width + x) * 4
        png.data[offset] = r
        png.data[offset + 1] = g
        png.data[offset + 2] = b
        png.data[offset + 3] = 255
      }
    }
  }
  const dot = Math.max(1, Math.round(1.6 * scale))
  for (const label of labels) {
    const glyphs = Array.from(label.ref, (char) => labelGlyphs[char]).filter((glyph) => glyph !== undefined)
    const textWidth = glyphs.length * 6 * dot - dot
    const height = 18 * scale
    const width = Math.max(18 * scale, textWidth + 8 * scale)
    const x = Math.max(0, label.rect.x) * scale
    const y = Math.max(0, label.rect.y - 18) * scale
    fill(x, y, width, height, [0x7c, 0x3a, 0xed])
    fill(x + scale, y + scale, width - 2 * scale, height - 2 * scale, [0xa7, 0x8b, 0xfa])
    let penX = x + (width - textWidth) / 2
    const penY = y + (height - 7 * dot) / 2
    for (const glyph of glyphs) {
      glyph.forEach((row, rowIndex) => {
        for (let column = 0; column < row.length; column++) {
          if (row[column] === "#") fill(penX + column * dot, penY + rowIndex * dot, dot, dot, [0x11, 0x18, 0x27])
        }
      })
      penX += 6 * dot
    }
  }
  return PNG.sync.write(png)
}

async function hideScreenshotLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const opencodeBrowserWindow = window as ScreenshotLabelsWindow
    const labels = opencodeBrowserWindow.__opencodeBrowserScreenshotLabels
    if (!labels) return
    window.clearTimeout(labels.timer)
    labels.host.remove()
    delete opencodeBrowserWindow.__opencodeBrowserScreenshotLabels
  }, undefined, undefined, true)
}
