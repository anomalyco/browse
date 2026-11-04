import type { SnapshotCaptureSettings, SnapshotEntry } from "./types.ts"

// Self-contained browser evaluation script: serialized via Function.prototype.toString() into page.evaluate().
// Do not reference module-level runtime imports inside captureSnapshotInBrowser.
export const captureSnapshotInBrowser = (
  rootOrSettings: Element | SnapshotCaptureSettings,
  locatorSettings?: SnapshotCaptureSettings,
) => {
  type BrowserEntry = SnapshotEntry
  const settings = locatorSettings ?? rootOrSettings as SnapshotCaptureSettings

  const normalize = (value: string): string => value.replace(/\s+/g, " ").trim()
  const truncate = (value: string, maxLength: number): string => {
    if (value.length <= maxLength) return value
    const prefix = value.slice(0, maxLength + 1)
    const boundary = prefix.lastIndexOf(" ")
    return `${prefix.slice(0, boundary >= Math.floor(maxLength * 0.6) ? boundary : maxLength).trimEnd()}...`
  }
  const quote = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  const styleCache = new WeakMap<Element, CSSStyleDeclaration>()
  const styleOf = (element: Element): CSSStyleDeclaration => {
    let cached = styleCache.get(element)
    if (!cached) {
      cached = window.getComputedStyle(element)
      styleCache.set(element, cached)
    }
    return cached
  }
  const visibleCache = new WeakMap<Element, boolean>()
  const visibleAssociatedLabel = (element: Element): HTMLLabelElement | undefined => {
    if (!(element instanceof HTMLInputElement) || (element.type !== "radio" && element.type !== "checkbox")) {
      return undefined
    }
    return Array.from(element.labels ?? []).find((label) => isVisible(label))
  }
  const isVisible = (element: Element): boolean => {
    const cached = visibleCache.get(element)
    if (cached !== undefined) return cached
    const style = styleOf(element)
    let result = true
    if (style.display === "none" || style.visibility === "hidden") {
      result = false
    } else if (style.opacity === "0") {
      result = Boolean(visibleAssociatedLabel(element))
    } else if (style.display === "contents") {
      const children = [
        ...Array.from(element.children ?? []),
        ...Array.from(element.shadowRoot?.children ?? []),
      ]
      result = children.some(isVisible)
    } else {
      const rect = element.getBoundingClientRect()
      result = (rect.width >= 1 && rect.height >= 1) || Boolean(visibleAssociatedLabel(element))
    }
    visibleCache.set(element, result)
    return result
  }
  const explicitAriaName = (element: Element): string => {
    const ariaLabel = element.getAttribute("aria-label")
    if (ariaLabel) return normalize(ariaLabel)
    const labelledBy = element.getAttribute("aria-labelledby")
    if (labelledBy) {
      const rootNode = element.getRootNode() as Document | ShadowRoot
      const labelled = normalize(labelledBy.split(/\s+/).map((id) => (rootNode.getElementById?.(id) ?? document.getElementById(id))?.textContent ?? "").join(" "))
      if (labelled) return labelled
    }
    return ""
  }
  const titleName = (element: Element): string => normalize(element.getAttribute("title") ?? "")
  const labelledName = (element: Element): string => explicitAriaName(element) || titleName(element)
  const safeTextCache = new WeakMap<Element, string>()
  const safeText = (element: Element): string => {
    const cached = safeTextCache.get(element)
    if (cached !== undefined) return cached
    const rootStyle = styleOf(element)
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" || rootStyle.display === "none" || rootStyle.visibility === "hidden" || rootStyle.opacity === "0") {
      safeTextCache.set(element, "")
      return ""
    }
    if (element.firstElementChild === null && !element.shadowRoot && element.localName !== "slot") {
      const result = normalize(element.textContent ?? "")
      safeTextCache.set(element, result)
      return result
    }
    const parts: string[] = []
    const nearestBlock = (start: Element | null): Element => {
      let current = start
      while (current && current !== element && element.contains(current)) {
        const display = styleOf(current).display
        if (display && display !== "inline" && display !== "contents") return current
        current = current.parentElement
      }
      return element
    }
    let lastBlock: Element | undefined
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node instanceof Element) {
          const local = node.localName
          if (local === "input" || local === "textarea" || local === "select" || local === "script" || local === "style" || local === "noscript" || local === "template") {
            return NodeFilter.FILTER_REJECT
          }
          const style = styleOf(node)
          if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
            return NodeFilter.FILTER_REJECT
          }
          if (node !== element && (node.hasAttribute("aria-label") || node.hasAttribute("aria-labelledby"))) {
            const ariaText = explicitAriaName(node)
            if (ariaText) {
              parts.push(` ${ariaText} `)
              lastBlock = undefined
            }
            return NodeFilter.FILTER_REJECT
          }
        }
        return NodeFilter.FILTER_ACCEPT
      },
    })
    let node = walker.nextNode()
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const block = nearestBlock(node.parentElement)
        if (lastBlock && lastBlock !== block) parts.push(" ")
        parts.push(node.textContent ?? "")
        lastBlock = block
      } else if (node instanceof HTMLImageElement) {
        const alt = node.getAttribute("alt")
        if (alt) parts.push(` ${alt} `)
        lastBlock = undefined
      } else if (typeof HTMLSlotElement !== "undefined" && node instanceof HTMLSlotElement) {
        for (const assigned of node.assignedNodes({ flatten: true })) {
          if (assigned.nodeType === Node.TEXT_NODE) {
            parts.push(assigned.textContent ?? "")
          } else if (assigned instanceof Element) {
            parts.push(safeText(assigned))
          }
        }
        lastBlock = undefined
      } else if (node instanceof Element && node.tagName === "BR") {
        parts.push(" ")
        lastBlock = undefined
      }
      node = walker.nextNode()
    }
    const result = normalize(parts.join(""))
    safeTextCache.set(element, result)
    return result
  }
  const authorAccessibleName = (element: Element): string => {
    const labelled = explicitAriaName(element)
    if (labelled) return labelled
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLButtonElement
    ) {
      const label = element.labels?.[0]
      if (label) {
        const labelText = safeText(label)
        if (labelText) return labelText
      }
    }
    if (element instanceof HTMLInputElement && (element.type === "button" || element.type === "submit" || element.type === "reset")) {
      const buttonValue = normalize(element.value || (element.type === "submit" ? "Submit" : element.type === "reset" ? "Reset" : ""))
      if (buttonValue) return buttonValue
    }
    const title = titleName(element)
    if (title) return title
    const placeholder = element.getAttribute("placeholder")
    if (placeholder) return normalize(placeholder)
    return ""
  }
  const accessibleNameCache = new WeakMap<Element, string>()
  const accessibleName = (element: Element): string => {
    const cached = accessibleNameCache.get(element)
    if (cached !== undefined) return cached
    let result = ""
    const labelled = explicitAriaName(element)
    if (labelled) {
      result = labelled
    } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      result = authorAccessibleName(element)
    } else {
      const alt = element.getAttribute("alt")
      const raw = alt || safeText(element) || titleName(element) ||
        element.querySelector?.("[aria-label]")?.getAttribute("aria-label") ||
        element.querySelector?.("svg title")?.textContent ||
        ""
      result = normalize(raw)
    }
    accessibleNameCache.set(element, result)
    return result
  }
  const roleFor = (element: Element): string => {
    const explicit = element.getAttribute("role")
    if (explicit) return explicit
    if (/^H[1-6]$/.test(element.tagName)) return "heading"
    if (element instanceof HTMLAnchorElement || (element.tagName.toLowerCase() === "a" && element.hasAttribute("href"))) return "link"
    if (element instanceof HTMLButtonElement) return "button"
    if (element.tagName === "SUMMARY") return "summary"
    if (element instanceof HTMLTextAreaElement) return "textbox"
    if (element instanceof HTMLSelectElement) return element.hasAttribute("multiple") || element.size > 1 ? "listbox" : "combobox"
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox") return "checkbox"
      if (element.type === "radio") return "radio"
      if (element.type === "number") return "spinbutton"
      if (element.type === "range") return "slider"
      if (["email", "search", "tel", "text", "url"].includes(element.type)) {
        const listId = element.getAttribute("list")?.trim().split(/\s+/)[0]
        const list = listId ? (element.getRootNode() as Document | ShadowRoot).getElementById(listId) : null
        if (list?.tagName === "DATALIST") return "combobox"
      }
      if (element.type === "search") return "searchbox"
      if (element.type === "button" || element.type === "submit" || element.type === "reset" || element.type === "file") return "button"
      return "textbox"
    }
    if (element instanceof HTMLDialogElement) return "dialog"
    if (element instanceof HTMLFieldSetElement || element.tagName === "DETAILS") return "group"
    if (element instanceof HTMLTableElement) return "table"
    if (element instanceof HTMLTableRowElement) return "row"
    if (element instanceof HTMLUListElement || element instanceof HTMLOListElement) return "list"
    if (element instanceof HTMLLIElement) return "listitem"
    if (element.tagName === "PRE" || element.tagName === "CODE") return "code"
    if (element.tagName === "NAV") return "navigation"
    return element.tagName.toLowerCase()
  }
  const isRowCell = (child: Element): boolean => {
    const local = child.localName
    if (local === "th" || local === "td") return true
    const role = child.getAttribute("role")
    return role === "columnheader" || role === "rowheader" || role === "cell" || role === "gridcell"
  }
  const isColumnHeaderCell = (child: Element): boolean =>
    child.localName === "th" || child.getAttribute("role") === "columnheader"
  const isAnyHeaderCell = (child: Element): boolean => {
    if (child.localName === "th") return true
    const role = child.getAttribute("role")
    return role === "columnheader" || role === "rowheader"
  }
  const tableHeaderRowsCache = new WeakMap<Element, ReadonlyArray<{ readonly row: Element; readonly headers: readonly string[] }>>()
  const headerRowFor = (table: Element, currentRow: Element): { readonly row: Element; readonly headers: readonly string[] } | undefined => {
    let cached = tableHeaderRowsCache.get(table)
    if (!cached) {
      const found: Array<{ readonly row: Element; readonly headers: readonly string[] }> = []
      const rows = table.querySelectorAll("tr, [role='row']")
      for (let i = 0; i < rows.length && found.length < 2; i++) {
        const row = rows[i]!
        const rowCells: Element[] = []
        let allColHeaders = true
        let hasScopedColHeader = false
        for (let child = row.firstElementChild; child; child = child.nextElementSibling) {
          if (!isRowCell(child)) continue
          rowCells.push(child)
          const isCol = isColumnHeaderCell(child)
          if (!isCol) allColHeaders = false
          if (child.getAttribute("role") === "columnheader" || (child.localName === "th" && child.getAttribute("scope")?.toLowerCase() === "col")) {
            hasScopedColHeader = true
          }
        }
        if (rowCells.length > 0 && (allColHeaders || hasScopedColHeader)) {
          const headers: string[] = []
          for (let child = row.firstElementChild; child; child = child.nextElementSibling) {
            if (isColumnHeaderCell(child)) headers.push(safeText(child))
          }
          found.push({ row, headers })
        }
      }
      cached = found
      tableHeaderRowsCache.set(table, cached)
    }
    return cached[0]?.row === currentRow ? cached[1] : cached[0]
  }
  const structuralName = (element: Element, role: string): string => {
    const labelled = labelledName(element)
    if (labelled) return labelled
    if (element instanceof HTMLFieldSetElement) return normalize(element.querySelector(":scope > legend")?.textContent ?? "")
    if (element instanceof HTMLTableElement) return normalize(element.caption?.textContent ?? "")
    if (element instanceof HTMLDetailsElement) return normalize(element.querySelector(":scope > summary")?.textContent ?? "")
    if (role === "dialog" || role === "alertdialog" || role === "group") {
      return normalize(element.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']")?.textContent ?? "")
    }
    if (role === "code") return normalize(element.textContent ?? "")
    if (role === "row") {
      const cells: Element[] = []
      const headerCells: Element[] = []
      for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        if (!isRowCell(child)) continue
        cells.push(child)
        if (isAnyHeaderCell(child)) headerCells.push(child)
      }
      const values = cells.map((cell) => safeText(cell))
      if (values.length === 0) return safeText(element)
      const table = element.closest("table, [role='table'], [role='grid']")
      const headerRow = table ? headerRowFor(table, element) : undefined
      if (headerRow) {
        const headers = headerRow.headers
        if (headers.length === values.length && headers.every(Boolean)) {
          return values.map((value, index) => `${headers[index]}: ${value}`).join(" | ")
        }
      }
      if (headerCells.length === cells.length) return values.join(" | ")
      if (headerCells.length > 0) {
        const headers = headerCells.map((cell) => safeText(cell)).filter(Boolean)
        const data = cells.filter((cell) => !headerCells.includes(cell)).map((cell) => safeText(cell)).filter(Boolean)
        return headers.length === 1 && data.length > 0 ? `${headers[0]}: ${data.join(" | ")}` : values.join(" | ")
      }
      return values.join(" | ")
    }
    if (role === "listitem") return safeText(element)
    return ""
  }
  let autoScopedMain = false
  const root = rootOrSettings instanceof Element
    ? rootOrSettings
    : (() => {
        if (settings.rootSelector) {
          const matches = document.querySelectorAll(settings.rootSelector)
          if (matches.length !== 1) {
            throw new Error(`snapshot within expects exactly one match for selector: ${settings.rootSelector}; got ${matches.length}`)
          }
          return matches[0] as Element
        }
        const fallbackRoot = (document.body ?? document.documentElement) as Element | null
        if (!fallbackRoot) return null
        const dialogs = Array.from(document.querySelectorAll("dialog, [role='dialog'], [role='alertdialog']")).filter(isVisible)
        const modals = dialogs.filter((dialog) => dialog.matches(":modal, [aria-modal='true']") || Boolean(dialog.closest?.("[data-focus-lock-disabled='false']")))
        if (modals.length === 1) return modals[0] as Element
        const isOpenListboxOrMenu = (menu: Element): boolean => {
          if (!isVisible(menu)) return false
          if (menu.getAttribute("aria-label") === "slider" || menu.getAttribute("aria-roledescription") === "carousel") return false
          const items = Array.from(menu.querySelectorAll("[role='option'], [role^='menuitem']")).filter(isVisible)
          return items.length > 0 && !items.some((item) => item.getAttribute("role") === "option" && item.querySelector?.("a[href], button"))
        }
        const portalMenus = Array.from(document.querySelectorAll("[role='listbox'], [role='menu']")).filter(isOpenListboxOrMenu)
        const mains = Array.from(document.querySelectorAll("main")).filter(isVisible)
        if (dialogs.length > 0 || (mains.length === 1 && portalMenus.some((menu) => !mains[0]!.contains?.(menu)))) {
          return fallbackRoot
        }
        if (mains.length === 1) {
          autoScopedMain = true
          return mains[0] as Element
        }
        return fallbackRoot
      })()
  if (!root) {
    return { entries: [], truncated: false }
  }
  if ((settings.rootRole && roleFor(root) !== settings.rootRole) || (settings.rootName && accessibleName(root) !== settings.rootName)) {
    throw new Error("Snapshot ref no longer identifies the captured element; call snapshot() again")
  }
  const detailsFor = (element: Element): string | undefined => {
    const details: string[] = []
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox" || element.type === "radio") details.push(element.checked ? "checked" : "unchecked")
    }
    const ariaChecked = element.getAttribute("aria-checked")
    if ((ariaChecked === "true" || ariaChecked === "false" || ariaChecked === "mixed") && !(element instanceof HTMLInputElement)) {
      details.push(ariaChecked === "true" ? "checked" : ariaChecked === "false" ? "unchecked" : "checked=mixed")
    }
    if (element instanceof HTMLSelectElement) {
      const selected = element.selectedOptions[0]?.textContent
      if (selected) details.push(`selected="${quote(normalize(selected).slice(0, 80))}"`)
      details.push(`${element.options.length} options`)
    }
    if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
      if (element.disabled) details.push("disabled")
    }
    if (element.getAttribute("aria-disabled") === "true" && !details.includes("disabled")) {
      details.push("disabled")
    }
    const expanded = element.getAttribute("aria-expanded")
    if (expanded) details.push(`expanded=${expanded}`)
    if (element instanceof HTMLDetailsElement) details.push(`expanded=${element.open}`)
    if (element instanceof HTMLDialogElement) {
      details.push(`open=${element.open}`)
      const modal = element.getAttribute("aria-modal")
      if (modal) details.push(`modal=${modal}`)
    }
    if (element.tagName === "SUMMARY" && element.parentElement instanceof HTMLDetailsElement) details.push(`expanded=${element.parentElement.open}`)
    const selected = element.getAttribute("aria-selected")
    if (selected) details.push(`selected=${selected}`)
    const current = element.getAttribute("aria-current")
    if (current) details.push(`current=${current}`)
    if (element instanceof HTMLTableElement) details.push(`${element.rows.length} rows`)
    if (element instanceof HTMLUListElement || element instanceof HTMLOListElement) details.push(`${element.children.length} items`)
    if (element instanceof HTMLFieldSetElement) details.push(`${element.elements.length} controls`)
    return details.length ? details.join(" ") : undefined
  }
  const isShadowRoot = (node: unknown): node is ShadowRoot =>
    typeof ShadowRoot !== "undefined" && node instanceof ShadowRoot
  const parentElementOrHost = (node: Element | null): Element | null => {
    if (!node) return null
    if (node.parentElement) return node.parentElement
    const rootNode = node.getRootNode?.()
    return isShadowRoot(rootNode) ? rootNode.host : null
  }
  const closestDeep = (element: Element, selector: string): Element | null => {
    let current: Element | null = element
    while (current) {
      const match = current.closest?.(selector) ?? null
      if (match) return match
      const rootNode = current.getRootNode?.()
      current = isShadowRoot(rootNode) ? rootNode.host : null
    }
    return null
  }
  const querySelectorAllDeep = (scope: Element | Document | ShadowRoot, selector: string): Element[] => {
    if (!scope.children) {
      return Array.from(scope.querySelectorAll(selector))
    }
    const results: Element[] = []
    const visit = (node: Element | Document | ShadowRoot) => {
      for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
        if (child.matches(selector)) results.push(child)
        if (child.shadowRoot) visit(child.shadowRoot)
        if (child.firstElementChild) visit(child)
      }
    }
    if (scope instanceof Element && scope.shadowRoot) visit(scope.shadowRoot)
    visit(scope)
    return results
  }
  const uniqueSelectorCache = new WeakMap<Document | ShadowRoot, Map<string, boolean>>()
  const isUniqueSelector = (scope: Document | ShadowRoot, selector: string): boolean => {
    let bySelector = uniqueSelectorCache.get(scope)
    if (!bySelector) {
      bySelector = new Map<string, boolean>()
      uniqueSelectorCache.set(scope, bySelector)
    }
    const cached = bySelector.get(selector)
    if (cached !== undefined) return cached
    const unique = scope.querySelectorAll(selector).length === 1
    bySelector.set(selector, unique)
    return unique
  }
  const attributeStatsCache = new WeakMap<Document | ShadowRoot, Map<string, { misses: number; counts?: Map<string, number> }>>()
  const isUniqueAttributeValue = (scope: Document | ShadowRoot, attribute: string, value: string): boolean => {
    let byAttr = attributeStatsCache.get(scope)
    if (!byAttr) {
      byAttr = new Map()
      attributeStatsCache.set(scope, byAttr)
    }
    let state = byAttr.get(attribute)
    if (!state) {
      state = { misses: 0 }
      byAttr.set(attribute, state)
    }
    if (state.counts) {
      return state.counts.get(value) === 1
    }
    const candidate = `[${attribute}="${CSS.escape(value)}"]`
    let bySelector = uniqueSelectorCache.get(scope)
    const cached = bySelector?.get(candidate)
    if (cached !== undefined) return cached
    if (++state.misses >= 4) {
      const counts = new Map<string, number>()
      const elements = scope.querySelectorAll(`[${attribute}]`)
      for (let i = 0; i < elements.length; i++) {
        const attrVal = elements[i]!.getAttribute(attribute)
        if (attrVal !== null) counts.set(attrVal, (counts.get(attrVal) ?? 0) + 1)
      }
      state.counts = counts
      return counts.get(value) === 1
    }
    return isUniqueSelector(scope, candidate)
  }
  const nthOfTypeByContainer = new WeakMap<Element | ShadowRoot, WeakMap<Element, number>>()
  const nthOfType = (element: Element, container: Element | ShadowRoot): number => {
    let byElement = nthOfTypeByContainer.get(container)
    if (!byElement) {
      byElement = new WeakMap<Element, number>()
      const counts = new Map<string, number>()
      for (let child = container.firstElementChild; child; child = child.nextElementSibling) {
        const next = (counts.get(child.tagName) ?? 0) + 1
        counts.set(child.tagName, next)
        byElement.set(child, next)
      }
      nthOfTypeByContainer.set(container, byElement)
    }
    return byElement.get(element) ?? 1
  }
  const localCssCache = new WeakMap<Element, string>()
  const localCssPath = (element: Element, scope: Document | ShadowRoot): string => {
    const cached = localCssCache.get(element)
    if (cached !== undefined) return cached
    const compute = (): string => {
      const id = element.getAttribute("id")
      if (id) {
        const candidate = `#${CSS.escape(id)}`
        if (isUniqueSelector(scope, candidate)) return candidate
      }
      for (const attribute of ["data-testid", "data-test-id", "data-test", "name", "aria-label", "placeholder"]) {
        const value = element.getAttribute(attribute)
        if (value) {
          if (isUniqueAttributeValue(scope, attribute, value)) return `[${attribute}="${CSS.escape(value)}"]`
        }
      }
      const tag = element.tagName.toLowerCase()
      const role = element.getAttribute("role")
      const roleSuffix = role ? `[role="${quote(role)}"]` : ""
      let checkedClasses = 0
      for (const className of element.classList ?? []) {
        if (className.includes(":") || className.includes("[") || className.includes("/")) continue
        if (++checkedClasses > 4) break
        const candidate = `${tag}.${CSS.escape(className)}${roleSuffix}`
        if (isUniqueSelector(scope, candidate)) return candidate
      }
      const parent = element.parentElement
      if (!parent) {
        if (isShadowRoot(scope)) {
          return `${tag}:nth-of-type(${nthOfType(element, scope)})`
        }
        return tag
      }
      return `${localCssPath(parent, scope)} > ${tag}:nth-of-type(${nthOfType(element, parent)})`
    }
    const result = compute()
    localCssCache.set(element, result)
    return result
  }
  const cssPath = (element: Element): string => {
    const rootNode = element.getRootNode?.()
    if (isShadowRoot(rootNode)) {
      return `${cssPath(rootNode.host)} >> ${localCssPath(element, rootNode)}`
    }
    return localCssPath(element, document)
  }
  const rootHeadings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']")).map((heading) => {
    const candidate = /^H([1-6])$/.exec(heading.tagName)?.[1]
    return {
      heading,
      level: candidate ? Number(candidate) : Number(heading.getAttribute("aria-level") ?? 1),
    }
  })
  const headingDepthCache = new WeakMap<Element, number>()
  const headingDepth = (element: Element): number => {
    const cached = headingDepthCache.get(element)
    if (cached !== undefined) return cached
    const ownLevel = /^H([1-6])$/.exec(element.tagName)?.[1]
    if (ownLevel) {
      const depth = Number(ownLevel) - 1
      headingDepthCache.set(element, depth)
      return depth
    }
    let treeTarget = element
    while (isShadowRoot(treeTarget.getRootNode?.())) {
      treeTarget = (treeTarget.getRootNode() as ShadowRoot).host
    }
    let low = 0
    let high = rootHeadings.length - 1
    let best = -1
    while (low <= high) {
      const mid = (low + high) >>> 1
      const { heading } = rootHeadings[mid]!
      if (heading !== treeTarget && (heading.compareDocumentPosition(treeTarget) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
        best = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    const level = best >= 0 ? rootHeadings[best]!.level : 0
    headingDepthCache.set(element, level)
    return level
  }

  const structuralTags = new Set(["fieldset", "dialog", "details", "table", "tr", "ul", "ol", "li", "pre"])
  const structuralRoles = new Set(["group", "radiogroup", "dialog", "alertdialog", "listbox", "menu", "tablist", "table", "row", "list", "listitem"])
  const interactiveTags = new Set(["button", "input", "textarea", "select", "summary"])
  const interactiveRoles = new Set([
    "button", "link", "tab",
    "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "switch", "checkbox", "radio",
    "combobox", "searchbox", "textbox",
    "slider", "spinbutton", "treeitem",
  ])
  const extraCandidateTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "nav", "p"])
  const extraCandidateRoles = new Set(["heading", "navigation", "alert", "status"])
  const isStructuralElement = (element: Element): boolean => {
    if (structuralTags.has(element.localName)) return true
    const role = element.getAttribute("role")
    return role !== null && structuralRoles.has(role)
  }
  const isInteractiveElement = (element: Element): boolean => {
    const local = element.localName
    if (interactiveTags.has(local)) return true
    if (local === "a" && element.hasAttribute("href")) return true
    if (element.hasAttribute("contenteditable")) return true
    const role = element.getAttribute("role")
    return role !== null && interactiveRoles.has(role)
  }
  const isCandidateElement = (element: Element): boolean => {
    const local = element.localName
    if (extraCandidateTags.has(local) || structuralTags.has(local) || interactiveTags.has(local)) return true
    if (local === "a" && element.hasAttribute("href")) return true
    if (element.hasAttribute("contenteditable")) return true
    const role = element.getAttribute("role")
    return role !== null && (extraCandidateRoles.has(role) || structuralRoles.has(role) || interactiveRoles.has(role))
  }
  const structuralKeys = new WeakMap<Element, string>()
  let nextStructuralKey = 1
  const structuralKey = (element: Element): string => {
    const existing = structuralKeys.get(element)
    if (existing) return existing
    const key = `s${nextStructuralKey++}`
    structuralKeys.set(element, key)
    return key
  }
  const parentChainCache = new WeakMap<Element, readonly string[]>()
  const structuralChainFrom = (node: Element | null): readonly string[] => {
    if (!node || node === root) return []
    const cached = parentChainCache.get(node)
    if (cached !== undefined) return cached
    const tail = structuralChainFrom(parentElementOrHost(node))
    const result = isStructuralElement(node) ? [structuralKey(node), ...tail] : tail
    parentChainCache.set(node, result)
    return result
  }
  const structuralParentKeys = (element: Element): readonly string[] =>
    structuralChainFrom(parentElementOrHost(element))
  const primaryLinks = new WeakMap<Element, Element | null>()
  const isPrimaryLink = (element: Element): boolean => {
    if (
      element.closest?.("h1, h2, h3, h4, h5, h6, [role='heading']") ||
      (element.firstElementChild !== null && element.querySelector?.("h1, h2, h3, h4, h5, h6, [role='heading']"))
    ) {
      return true
    }
    const group = element.closest("article, li, tr, dt, [role='listitem'], [role='row']")
    if (!group || !root.contains(group)) return false
    if (!primaryLinks.has(group)) {
      const rawLinks = Array.from(group.querySelectorAll("a[href]"))
      if ((group.localName === "article" || group.getAttribute("role") === "article") && rawLinks.length > 12) {
        primaryLinks.set(group, null)
        return false
      }
      const links = rawLinks.filter(isVisible)
      let primary: Element | null = null
      let primaryScore = -1
      for (const link of links) {
        const name = accessibleName(link)
        const headingBonus = link.closest("h1, h2, h3, h4, h5, h6, [role='heading']") ? 1_000 : 0
        const commentBonus = /\b\d+\s+comments?\b/i.test(name) ? 500 : 0
        const score = name.length + headingBonus + commentBonus
        if (score > primaryScore) {
          primary = link
          primaryScore = score
        }
      }
      primaryLinks.set(group, primary)
    }
    if (primaryLinks.get(group) !== element) return false
    if (group.localName === "tr" || group.getAttribute("role") === "row") {
      const groupTextLength = safeText(group).length
      return groupTextLength > 0 && accessibleName(element).length / groupTextLength >= 0.15
    }
    return true
  }
  const nestedTableCache = new WeakMap<Element, boolean>()
  const hasNestedTable = (table: Element): boolean => {
    const cached = nestedTableCache.get(table)
    if (cached !== undefined) return cached
    const result = Boolean(table.querySelector?.("table, [role='table']"))
    nestedTableCache.set(table, result)
    return result
  }
  const layoutTableCache = new WeakMap<Element, boolean>()
  const isLayoutTable = (table: Element | null): boolean => {
    if (!table || !settings.compact) return false
    const cached = layoutTableCache.get(table)
    if (cached !== undefined) return cached
    let result: boolean
    if (hasNestedTable(table)) {
      result = true
    } else {
      const hasHeaders = Boolean(
        labelledName(table) ||
        (table as HTMLTableElement).caption ||
        table.querySelector?.("th, [role='columnheader'], [role='rowheader']"),
      )
      if (hasHeaders) {
        result = false
      } else {
        const rowCount = table instanceof HTMLTableElement
          ? table.rows.length
          : table.querySelectorAll("tr, [role='row']").length
        result = rowCount <= 1 || rowCount >= 20
      }
    }
    layoutTableCache.set(table, result)
    return result
  }
  const isRedundantHeadingForLink = (element: Element): boolean => {
    if (!settings.compact || element === root) return false
    const parentInteractive = element.closest?.("a[href], button, [role='button'], [role='option'], [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']")
    if (parentInteractive && (root.contains?.(parentInteractive) ?? true) && isVisible(parentInteractive)) {
      return true
    }
    const headingText = accessibleName(element)
    if (!headingText) return false
    const childLinks = Array.from(element.querySelectorAll?.("a[href]") ?? []).filter(isVisible)
    if (childLinks.length === 1) {
      const linkText = accessibleName(childLinks[0]!)
      if (linkText && (linkText === headingText || linkText.startsWith(headingText))) {
        return true
      }
    }
    const card = element.closest?.("article, [role='article']")
    if (card && (root.contains?.(card) ?? true)) {
      const rawCardLinks = Array.from(card.querySelectorAll("a[href]"))
      if (rawCardLinks.length <= 12 && rawCardLinks.filter(isVisible).some((link) => accessibleName(link) === headingText)) {
        return true
      }
    }
    return false
  }
  const seenCardLinks = new WeakMap<Element, Set<string>>()
  const isDuplicateCardLink = (element: Element, displayName: string): boolean => {
    if (!settings.compact || !displayName || element.localName !== "a" || !element.hasAttribute("href")) return false
    const card = element.closest?.("article, [role='article'], li, [role='listitem'], tr, [role='row']")
    if (!card || !(root.contains?.(card) ?? true)) return false
    const href = element.getAttribute("href") ?? ""
    if (!href) return false
    let seen = seenCardLinks.get(card)
    if (!seen) {
      seen = new Set<string>()
      seenCardLinks.set(card, seen)
    }
    const key = `${href}\0${displayName}`
    if (seen.has(key)) return true
    seen.add(key)
    return false
  }
  const redundantListItemCache = new WeakMap<Element, boolean>()
  const isRedundantListItem = (element: Element): boolean => {
    if (!settings.compact || element === root) return false
    const cached = redundantListItemCache.get(element)
    if (cached !== undefined) return cached
    let result = false
    if (element.querySelector?.("ul, ol, [role='list'], h1, h2, h3, h4, h5, h6, [role='heading']")) {
      result = true
    } else if (!element.querySelector?.("p")) {
      const controls = Array.from(element.querySelectorAll?.("a[href], button") ?? []).filter(isVisible)
      if (controls.length > 0) {
        const itemLength = safeText(element).length
        result = itemLength > 0 && controls.some((control) => accessibleName(control).length >= itemLength * 0.65)
      }
    }
    redundantListItemCache.set(element, result)
    return result
  }
  const priorityFor = (options: { readonly role: string; readonly interactive: boolean; readonly primaryLink: boolean; readonly structuralEssential: boolean; readonly inActiveOverlay: boolean }): number => {
    if (options.role === "alert" || options.role === "status" || options.role === "navigation" || options.structuralEssential || options.inActiveOverlay) return -1
    if (options.role === "heading") return 0
    if (options.role === "link" && options.primaryLink) return 0
    if (options.interactive && (options.role !== "link" || options.primaryLink)) return 1
    if (options.role === "link") return 3
    return 2
  }

  type PendingEntry = BrowserEntry & { readonly interactiveElement?: Element }
  const entries: PendingEntry[] = []
  let truncated = false
  const add = (entry: PendingEntry): void => {
    if (entry.depth > settings.depth) return
    if (entries.length >= settings.maxCandidates) {
      truncated = true
      return
    }
    entries.push(entry)
  }
  const headerSelector = "input, textarea, select, button, [role='searchbox'], [role='combobox'], [role='button'], a[href][aria-label]"
  const headerRoots = autoScopedMain && typeof document.querySelectorAll === "function"
    ? Array.from(document.querySelectorAll("header, [role='banner']")).filter((h) => isVisible(h) && !root.contains?.(h))
    : []
  const headerCandidateSet = new Set(
    headerRoots.flatMap((h) =>
      querySelectorAllDeep(h, headerSelector).filter((el) => !el.closest?.("nav, [role='navigation']")),
    ),
  )
  const collapsedNavigation = new Set<Element>()
  const nonCollapsibleNavigation = new WeakSet<Element>()
  let reservedLists = 0

  function* iterateCandidates(scope: Element): Generator<Element> {
    for (const headerEl of headerCandidateSet) yield headerEl
    if (isCandidateElement(scope)) yield scope
    function* visit(node: Element | Document | ShadowRoot): Generator<Element> {
      for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
        if (isCandidateElement(child)) yield child
        if (collapsedNavigation.has(child)) continue
        if (child.shadowRoot) yield* visit(child.shadowRoot)
        if (child.firstElementChild) yield* visit(child)
      }
    }
    if (scope.shadowRoot) yield* visit(scope.shadowRoot)
    yield* visit(scope)
  }

  for (const element of iterateCandidates(root)) {
    if (entries.length >= settings.maxCandidates) {
      truncated = true
      break
    }
    if (settings.compact && !headerCandidateSet.has(element)) {
      const navigation = closestDeep(element, "nav, [role='navigation'], aside, [role='complementary'], [data-slot='sidebar'], [data-sidebar='sidebar']")
      if (navigation && collapsedNavigation.has(navigation)) {
        continue
      }
      if (navigation && navigation !== root && !navigation.contains?.(root) && !nonCollapsibleNavigation.has(navigation)) {
        const isCollapsibleNav = isVisible(navigation) && (
          navigation.matches("nav, [role='navigation']") ||
          (querySelectorAllDeep(navigation, "a[href]").length >= 8 && !navigation.querySelector?.("h1, main, [role='main'], input, textarea, select"))
        )
        if (isCollapsibleNav) {
          collapsedNavigation.add(navigation)
          const count = querySelectorAllDeep(navigation, "a[href], button").length
          add({ depth: headingDepth(navigation), role: "navigation", name: truncate(labelledName(navigation), 100) || "Navigation", details: `${count} controls`, priority: 0 })
          continue
        }
        nonCollapsibleNavigation.add(navigation)
      }
    }
    if (!isVisible(element)) continue
    const role = roleFor(element)
    const isHeading = role === "heading"
    if (isHeading && isRedundantHeadingForLink(element)) continue
    if (
      role === "combobox" &&
      !(element instanceof HTMLInputElement || element instanceof HTMLButtonElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) &&
      element.querySelector?.("input, textarea, select")
    ) {
      continue
    }
    if (role === "option" && element.querySelector?.("a[href], button")) {
      continue
    }
    const isInteractive = isInteractiveElement(element)
    const isSafetyText = role === "alert" || role === "status"
    const isParagraph = element.localName === "p"
    const isStructural = !isInteractive && isStructuralElement(element)
    if (isStructural) {
      if (role === "listbox" && (element.getAttribute("aria-label") === "slider" || element.getAttribute("aria-roledescription") === "carousel")) {
        continue
      }
      if (role === "listitem" && isRedundantListItem(element)) {
        continue
      }
      if (role === "table" && isLayoutTable(element)) {
        continue
      }
      if (role === "row") {
        const parentTable = element.closest?.("table, [role='table']") ?? null
        if (parentTable ? (isLayoutTable(parentTable) || (hasNestedTable(parentTable) && Boolean(element.querySelector?.("table, [role='table']")))) : Boolean(element.querySelector?.("table, [role='table']"))) {
          continue
        }
      }
    }
    if (!isHeading && !isInteractive && !isSafetyText && !isStructural && (settings.interactive || !isParagraph)) continue
    if (settings.interactive && isParagraph && !isSafetyText) continue
    if (
      settings.compact &&
      isParagraph &&
      !isSafetyText &&
      element.parentElement !== null &&
      (element.parentElement.localName === "li" || element.parentElement.getAttribute("role") === "listitem") &&
      !isRedundantListItem(element.parentElement) &&
      safeText(element).length >= safeText(element.parentElement).length * 0.8
    ) {
      continue
    }
    const displayName = isStructural ? structuralName(element, role) : accessibleName(element)
    if (isInteractive && isDuplicateCardLink(element, displayName)) continue
    const nameFromAuthorOnly = role === "combobox" || role === "listbox" || role === "textbox" || role === "searchbox" || role === "spinbutton" || role === "slider"
    const identityName = isInteractive
      ? (nameFromAuthorOnly ? authorAccessibleName(element) : displayName)
      : displayName
    const isDisabled = ((element as HTMLButtonElement).disabled === true) || element.getAttribute("aria-disabled") === "true"
    if (isInteractive && isDisabled && !displayName && !element.getAttribute("name")) continue
    const fallbackName = role === "group" ? "Group"
      : role === "dialog" || role === "alertdialog" ? "Dialog"
      : role === "listbox" ? "Listbox"
      : role === "menu" ? "Menu"
      : role === "table" ? "Table"
      : role === "list" ? "List"
      : role === "tablist" ? "Tab list"
      : isInteractive ? element.getAttribute("name") || element.getAttribute("data-testid") || element.getAttribute("data-test-id") || element.getAttribute("data-test") || role
      : ""
    const name = truncate(displayName || fallbackName, isParagraph || isSafetyText || isStructural ? 180 : 120)
    if (!name) continue
    const details = isHeading ? `level=${headingDepth(element) + 1}` : detailsFor(element)
    const primaryLink = (role === "link" && isPrimaryLink(element)) || headerCandidateSet.has(element)
    const baseDepth = headingDepth(element)
    const parentKeys = structuralParentKeys(element)
    const overlayAncestor = element.closest?.("dialog, [role='dialog'], [role='alertdialog'], [role='listbox'], [role='menu']") ?? null
    const inActiveOverlay = Boolean(
      (isInteractive || role === "dialog" || role === "alertdialog" || role === "listbox" || role === "menu") &&
      overlayAncestor &&
      overlayAncestor.getAttribute("aria-label") !== "slider" &&
      overlayAncestor.getAttribute("aria-roledescription") !== "carousel",
    )
    const labelProxy = (() => {
      if (!isInteractive) return undefined
      const label = visibleAssociatedLabel(element)
      if (!label) return undefined
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return label
      if (styleOf(element).opacity !== "0") return undefined
      const hit = document.elementFromPoint?.(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit === element ? undefined : label
    })()
    add({
      depth: baseDepth + parentKeys.length,
      baseDepth,
      ...(isStructural ? { key: structuralKey(element) } : {}),
      ...(parentKeys.length > 0 ? { parentKeys } : {}),
      role,
      name,
      ...(isInteractive && identityName && !labelProxy ? { identityName } : {}),
      ...(labelProxy ? { selectorRole: "label" } : {}),
      ...(isInteractive ? { interactiveElement: labelProxy ?? element } : {}),
      ...(details ? { details } : {}),
      priority: priorityFor({
        role: headerCandidateSet.has(element) ? "heading" : role,
        interactive: isInteractive,
        primaryLink,
        inActiveOverlay,
        structuralEssential: isStructural &&
          role !== "row" &&
          role !== "listitem" &&
          role !== "code" &&
          (role !== "group" || Boolean(displayName)) &&
          (role !== "list" || reservedLists++ < Math.max(1, Math.floor(settings.maxItems / 10))),
      }),
    })
  }
  const selected: BrowserEntry[] = entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.priority - right.entry.priority || left.index - right.index)
    .slice(0, settings.maxItems)
    .sort((left, right) => left.index - right.index)
    .map(({ entry: { interactiveElement, ...rest } }) => ({
      ...rest,
      ...(interactiveElement ? { selector: cssPath(interactiveElement) } : {}),
    }))
  const needsSettle = Boolean(
    !settings.rootSelector &&
    typeof MutationObserver !== "undefined" &&
    document.body &&
    (
      Boolean(document.querySelector?.("[aria-busy='true'], .skeleton:not(.no-skeleton)")) ||
      (!selected.some((entry) => Boolean(entry.selector)) && typeof performance !== "undefined" && performance.now() < 2_500)
    ),
  )
  return {
    entries: selected,
    truncated: truncated || selected.length < entries.length,
    ...(needsSettle ? { needsSettle: true } : {}),
  }
}

export const browserCapture = new Function(
  "rootOrSettings",
  "locatorSettings",
  `const __name = (target) => target
return (${captureSnapshotInBrowser.toString()})(rootOrSettings, locatorSettings)`,
) as typeof captureSnapshotInBrowser
