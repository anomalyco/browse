// Browse's helpers for one frame. Evaluated with Runtime.evaluate in a Page.createIsolatedWorld context, so nothing
// here (globals, prototype patches, listeners) is visible to the page's own scripts. The Rust side substitutes the
// two placeholders below with js/naming.js and js/capture.js (generated from cli/src/snapshot).
(() => {
  const createNaming = __NAMING__
  const capture = __CAPTURE__
  const quoted = (value) => {
    const short = value.length > 80 ? `${value.slice(0, 80)}...` : value
    return `"${short.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  }
  const hiddenFromAria = (element) => {
    if (element.closest("[aria-hidden='true']")) return true
    const visible = element.checkVisibility?.({ visibilityProperty: true })
    if (visible !== undefined) return !visible
    const style = getComputedStyle(element)
    return style.display === "none" || style.visibility === "hidden"
  }
  const nextFrame = () => new Promise((resolve) => {
    // A hidden tab may never run animation frames; a timer keeps the check from hanging.
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    requestAnimationFrame(finish)
    setTimeout(finish, 120)
  })
  const rectOf = (element) => {
    const r = element.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }

  return {
    inj: undefined,

    // Compact snapshot capture (today's snapshot()).
    capture(settings) {
      return capture(settings)
    },
    captureWithin(element, settings) {
      return capture(element, settings)
    },
    captureRoot(selector) {
      // Mirrors the within-selector fallback: Playwright selectors that are not CSS resolve with the injected script.
      return this.query(selector, false)
    },

    // Selectors (Playwright syntax through the injected script).
    queryAll(selector, root) {
      const inj = this.inj
      return inj.querySelectorAll(inj.parseSelector(selector), root || document)
    },
    // The element, "none", or "multiple:<count>:<preview>|<preview>".
    query(selector, strict, root) {
      const matches = this.queryAll(selector, root)
      if (matches.length === 0) return "none"
      if (strict && matches.length > 1) {
        const previews = matches.slice(0, 4).map((element) => this.inj.previewNode(element))
        return `multiple:${matches.length}:${previews.join("\n")}`
      }
      return matches[0]
    },
    count(selector) {
      return this.queryAll(selector).length
    },

    // Snapshot refs: the elements matching the ref's selector that still have its role and exact name and are not
    // hidden from assistive technology. The element, "hidden" (a match exists but is hidden) or "none".
    refResolve(role, name, selector) {
      const naming = createNaming()
      const bySelector = selector.includes(" >> ") ? this.queryAll(selector) : Array.from(document.querySelectorAll(selector))
      const sameRole = role === null ? bySelector : bySelector.filter((element) => naming.roleFor(element) === role)
      const matches = role === null
        ? sameRole
        : sameRole.filter((element) => !hiddenFromAria(element) && (name === null || naming.identityNameFor(element, role) === name))
      if (matches.length > 0) return matches[0]
      if (role !== null && sameRole.some(hiddenFromAria)) return "hidden"
      return "none"
    },
    // The first element for a snapshot selector (CSS, or a `host >> inner` chain through shadow roots).
    first(selector) {
      if (selector.includes(" >> ")) return this.queryAll(selector)[0] ?? "none"
      return document.querySelector(selector) ?? "none"
    },
    refStale(id, role, name, selector) {
      const naming = createNaming()
      const bySelector = selector.includes(" >> ") ? this.queryAll(selector) : Array.from(document.querySelectorAll(selector))
      const was = `${role} ${quoted(name ?? "")}`
      const current = bySelector.length === 1 ? bySelector[0] : undefined
      const change = current
        ? naming.roleFor(current) === role
          ? `now reads ${quoted(naming.identityNameFor(current, role))}`
          : `is now ${naming.roleFor(current)} ${quoted(naming.identityNameFor(current, naming.roleFor(current)))}`
        : bySelector.length === 0
        ? "is gone; the page removed or re-rendered it"
        : `is gone; its selector now matches ${bySelector.length} other elements`
      return `ref ${id} is stale: ${was} ${change}; call snapshot again`
    },

    // Aria snapshot (Playwright's AI mode) with editable values redacted, as cli/src/snapshot/aria-snapshot.ts does.
    ariaSnapshot(element, options) {
      const restore = this.redact()
      try {
        return this.inj.ariaSnapshotJSON(element || document.body || document.documentElement, { mode: "ai", ...options })
      } finally {
        restore()
      }
    },
    renderAria(json) {
      return this.inj.__renderYaml(json)
    },
    ariaRef(ref) {
      const matches = this.queryAll(`aria-ref=${ref}`)
      return matches[0] ?? "none"
    },
    redact() {
      // Patches this world's prototypes only: the page's world keeps its own.
      const nonTextInputTypes = new Set(["button", "checkbox", "file", "hidden", "image", "radio", "reset", "submit"])
      const editableNameAttributes = new Set(["alt", "aria-description", "aria-describedby", "aria-label", "aria-labelledby", "aria-placeholder", "placeholder", "title"])
      const valueAttributes = new Set(["aria-valuenow", "aria-valuetext", "value"])
      const valueRoles = new Set(["meter", "progressbar", "scrollbar", "separator", "slider", "spinbutton"])
      const readOnlyAutocompleteTokens = new Set(["current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"])
      const saved = {
        inputValue: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"),
        textareaValue: Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value"),
        nodeValue: Object.getOwnPropertyDescriptor(Node.prototype, "nodeValue"),
        textContent: Object.getOwnPropertyDescriptor(Node.prototype, "textContent"),
        innerText: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText"),
        getAttribute: Object.getOwnPropertyDescriptor(Element.prototype, "getAttribute"),
      }
      const getAttribute = (element, name) => saved.getAttribute.value.call(element, name)
      const explicitEditableState = (element) => {
        const value = getAttribute(element, "contenteditable")
        if (value === null) return undefined
        const normalized = value.trim().toLowerCase()
        if (normalized === "false") return false
        return normalized === "" || normalized === "true" || normalized === "plaintext-only" ? true : undefined
      }
      const composedParent = (node) => {
        if (node.parentNode) return node.parentNode
        const treeRoot = node.getRootNode?.()
        return treeRoot instanceof ShadowRoot ? treeRoot.host : null
      }
      const isInEditableSubtree = (node) => {
        let current = node.nodeType === Node.TEXT_NODE ? node.parentNode : node
        while (current) {
          if (current instanceof Element) {
            const explicit = explicitEditableState(current)
            if (explicit !== undefined) return explicit
            if (current instanceof HTMLElement && current.isContentEditable) return true
          }
          current = composedParent(current)
        }
        return false
      }
      const isEditableDescendant = (element) => explicitEditableState(element) !== true && isInEditableSubtree(element)
      const isNativeTextControl = (element) => element instanceof HTMLTextAreaElement
        || (element instanceof HTMLInputElement && !nonTextInputTypes.has(element.type))
      const isReadOnlyTextControl = (element) => {
        if (!isNativeTextControl(element) || !element.readOnly) return false
        if (element instanceof HTMLInputElement && element.type === "password") return false
        const autocomplete = getAttribute(element, "autocomplete")
        return autocomplete === null || !autocomplete.trim().toLowerCase().split(/\s+/).some((token) => readOnlyAutocompleteTokens.has(token))
      }
      const isValueRole = (element) => {
        const role = getAttribute(element, "role")
        return role !== null && role.trim().toLowerCase().split(/\s+/).some((candidate) => valueRoles.has(candidate))
      }
      const hasRedactedText = (node) => isInEditableSubtree(node)
        || (node.nodeType === Node.TEXT_NODE && node.parentElement && isNativeTextControl(node.parentElement))
      Object.defineProperty(HTMLInputElement.prototype, "value", {
        ...saved.inputValue,
        get() { return isNativeTextControl(this) && !isReadOnlyTextControl(this) ? "" : saved.inputValue.get.call(this) },
      })
      Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
        ...saved.textareaValue,
        get() { return isReadOnlyTextControl(this) ? saved.textareaValue.get.call(this) : "" },
      })
      Object.defineProperty(Node.prototype, "nodeValue", {
        ...saved.nodeValue,
        get() { return this.nodeType === Node.TEXT_NODE && hasRedactedText(this) ? "" : saved.nodeValue.get.call(this) },
      })
      Object.defineProperty(Node.prototype, "textContent", {
        ...saved.textContent,
        get() { return (this instanceof Element && isNativeTextControl(this)) || hasRedactedText(this) ? "" : saved.textContent.get.call(this) },
      })
      Object.defineProperty(HTMLElement.prototype, "innerText", {
        ...saved.innerText,
        get() { return isNativeTextControl(this) || isInEditableSubtree(this) ? "" : saved.innerText.get.call(this) },
      })
      Object.defineProperty(Element.prototype, "getAttribute", {
        ...saved.getAttribute,
        value(name) {
          const attribute = String(name).toLowerCase()
          if (valueAttributes.has(attribute)
            && (isValueRole(this) || isInEditableSubtree(this)
              || (isNativeTextControl(this) && (attribute !== "value" || !isReadOnlyTextControl(this))))) return null
          if (editableNameAttributes.has(attribute) && isEditableDescendant(this)) return null
          return saved.getAttribute.value.call(this, name)
        },
      })
      return () => {
        Object.defineProperty(HTMLInputElement.prototype, "value", saved.inputValue)
        Object.defineProperty(HTMLTextAreaElement.prototype, "value", saved.textareaValue)
        Object.defineProperty(Node.prototype, "nodeValue", saved.nodeValue)
        Object.defineProperty(Node.prototype, "textContent", saved.textContent)
        Object.defineProperty(HTMLElement.prototype, "innerText", saved.innerText)
        Object.defineProperty(Element.prototype, "getAttribute", saved.getAttribute)
      }
    },

    // Element descriptions for results: `button "Save"`.
    describe(element) {
      const naming = createNaming()
      if (!(element instanceof Element)) return "node"
      const role = naming.roleFor(element)
      const name = naming.accessibleName(element)
      return name ? `${role} ${quoted(name)}` : role
    },
    kind(element) {
      if (element instanceof HTMLSelectElement) return element.multiple ? "select-multiple" : "select"
      if (element instanceof HTMLInputElement) {
        const type = element.type.toLowerCase()
        if (type === "checkbox" || type === "radio" || type === "file") return type
        return "input"
      }
      if (element instanceof HTMLTextAreaElement) return "textarea"
      if (element instanceof HTMLElement && element.isContentEditable) return "contenteditable"
      const role = element.getAttribute?.("role")
      if (role === "checkbox" || role === "switch" || role === "radio" || role === "menuitemcheckbox" || role === "menuitemradio") return "checkbox"
      if (element instanceof HTMLLabelElement && element.control) return this.kind(element.control)
      return "other"
    },
    isFrameOwner(element) {
      return element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement
    },

    // Actionability. "ok", "notconnected", or the first missing state: "visible", "enabled", "editable", "stable".
    async checkStates(element, states) {
      if (!element.isConnected) return "notconnected"
      for (const state of states) {
        if (state === "stable") continue
        const result = this.inj.elementState(element, state)
        if (result.received === "error:notconnected") return "notconnected"
        if (!result.matches) return state
      }
      if (states.includes("stable")) {
        const target = this.inj.retarget(element, "no-follow-label")
        if (!target) return "notconnected"
        let last = rectOf(target)
        for (let count = 0; count < 2; count++) {
          await nextFrame()
          if (!target.isConnected) return "notconnected"
          const now = rectOf(target)
          if (now.x !== last.x || now.y !== last.y || now.width !== last.width || now.height !== last.height) return "stable"
          last = now
        }
      }
      return "ok"
    },
    scrollIntoView(element) {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
    },
    // A point inside the element in this frame's viewport coordinates, or null when it has no box in the viewport.
    clickPoint(element, position) {
      const rects = Array.from(element.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
      const viewport = { width: document.documentElement.clientWidth || innerWidth, height: document.documentElement.clientHeight || innerHeight }
      if (rects.length === 0) return null
      if (position) {
        const box = element.getBoundingClientRect()
        return { x: box.left + position.x, y: box.top + position.y, inViewport: true, viewport }
      }
      for (const rect of rects) {
        const left = Math.max(rect.left, 0)
        const top = Math.max(rect.top, 0)
        const right = Math.min(rect.right, viewport.width)
        const bottom = Math.min(rect.bottom, viewport.height)
        if (right - left >= 1 && bottom - top >= 1) {
          return { x: (left + right) / 2, y: (top + bottom) / 2, inViewport: true, viewport }
        }
      }
      const rect = rects[0]
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, inViewport: false, viewport }
    },
    rect(element) {
      return rectOf(element)
    },
    // "done" or a description of the element that would receive the click instead.
    hitTest(element, x, y) {
      const target = this.inj.retarget(element, "button-link")
      if (!target || !target.isConnected) return "notconnected"
      const result = this.inj.expectHitTarget({ x, y }, target)
      return result === "done" ? "done" : result.hitTargetDescription
    },
    // Where an iframe's document starts, in its parent's viewport.
    frameOffset(element) {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        x: rect.left + element.clientLeft + parseFloat(style.paddingLeft || "0"),
        y: rect.top + element.clientTop + parseFloat(style.paddingTop || "0"),
      }
    },
    viewport() {
      return { width: document.documentElement.clientWidth || innerWidth, height: document.documentElement.clientHeight || innerHeight, scrollX, scrollY }
    },

    // Input preparation.
    fill(element, value) {
      return this.inj.fill(element, value)
    },
    focus(element) {
      return this.inj.focusNode(element, true)
    },
    selectText(element) {
      return this.inj.selectText(element)
    },
    isChecked(element) {
      const result = this.inj.elementState(element, "checked")
      return result.matches
    },
    selectOptions(element, options) {
      return this.inj.selectOptions(element, options)
    },
    fileInput(element) {
      const target = this.inj.retarget(element, "follow-label")
      if (target instanceof HTMLInputElement && target.type.toLowerCase() === "file") return target
      return "not-file-input"
    },
    activeElementIsEditable() {
      let active = document.activeElement
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
      if (!active || active === document.body) return false
      return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable === true
    },

    // Scrolling.
    scrollState(element) {
      if (element) return { x: element.scrollLeft, y: element.scrollTop, width: element.scrollWidth, height: element.scrollHeight, clientWidth: element.clientWidth, clientHeight: element.clientHeight }
      const root = document.scrollingElement || document.documentElement
      return { x: scrollX, y: scrollY, width: root.scrollWidth, height: root.scrollHeight, clientWidth: root.clientWidth, clientHeight: root.clientHeight }
    },
    scrollTo(element, edge) {
      const target = element || document.scrollingElement || document.documentElement
      if (edge === "top") target.scrollTo({ top: 0, behavior: "instant" })
      else if (edge === "bottom") target.scrollTo({ top: target.scrollHeight, behavior: "instant" })
      else if (edge === "left") target.scrollTo({ left: 0, behavior: "instant" })
      else if (edge === "right") target.scrollTo({ left: target.scrollWidth, behavior: "instant" })
    },

    // Page state.
    frameInfo() {
      return { url: location.href, origin: location.origin, title: document.title, readyState: document.readyState, platform: navigator.platform }
    },
    hasText(text) {
      const body = document.body
      if (!body) return false
      return (body.innerText || "").includes(text)
    },
    // Resolves once the document is quiet for `quietMs`, or after `maxMs` at most.
    quiet(quietMs, maxMs) {
      return new Promise((resolve) => {
        let quietTimer = setTimeout(done, quietMs)
        const maxTimer = setTimeout(done, maxMs)
        const observer = new MutationObserver(() => {
          clearTimeout(quietTimer)
          quietTimer = setTimeout(done, Math.min(quietMs, 55))
        })
        function done() {
          observer.disconnect()
          clearTimeout(quietTimer)
          clearTimeout(maxTimer)
          resolve(true)
        }
        if (document.body) observer.observe(document.body, { childList: true, subtree: true, attributes: true })
        else done()
      })
    },

    // Bot-challenge probe (cli/src/execute/challenge-detection.ts).
    probe(selectors) {
      const body = document.body
      const text = body ? body.innerText ?? "" : ""
      const matched = []
      const visible = []
      for (const selector of selectors) {
        let element = null
        try { element = document.querySelector(selector) } catch { element = null }
        if (!element) continue
        matched.push(selector)
        const rect = element.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) visible.push(selector)
      }
      return {
        url: location.href,
        title: document.title.slice(0, 300),
        text: text.slice(0, 3000),
        textLength: text.length,
        scriptSrcs: Array.from(document.scripts, (script) => script.src).filter(Boolean).slice(0, 50),
        selectors: matched,
        visibleSelectors: visible,
      }
    },

    // WebMCP (cli/src/execute/webmcp.ts).
    webmcpList() {
      const context = document.modelContext ?? navigator.modelContext
      if (!context?.getTools) return null
      return Promise.resolve(context.getTools()).then((tools) => tools
        .filter((tool) => !("window" in tool) || tool.window === window)
        .map((tool) => {
          let inputSchema = tool.inputSchema
          if (typeof inputSchema === "string") {
            try { inputSchema = JSON.parse(inputSchema) } catch { inputSchema = undefined }
          }
          return {
            name: typeof tool.name === "string" ? tool.name : "",
            ...(typeof tool.title === "string" ? { title: tool.title } : {}),
            description: typeof tool.description === "string" ? tool.description : "",
            ...(inputSchema === undefined ? {} : { inputSchema }),
            ...(tool.annotations ? {
              annotations: {
                readOnly: Boolean(tool.annotations.readOnlyHint ?? tool.annotations.readOnly),
                untrustedContent: Boolean(tool.annotations.untrustedContentHint ?? tool.annotations.untrustedContent),
                consequential: Boolean(tool.annotations.consequentialHint ?? tool.annotations.consequential),
              },
            } : {}),
            ...(typeof tool.origin === "string" ? { origin: tool.origin } : {}),
          }
        }))
    },
    webmcpCall(name, inputJson) {
      const isInputEncodingError = (error) => {
        const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error)
        return message.includes("parameter 2 is not of type 'object'") || message.includes("Failed to parse input arguments")
      }
      const context = document.modelContext ?? navigator.modelContext
      if (!context?.getTools) throw new Error("WebMCP is not available on this page")
      return Promise.resolve(context.getTools()).then(async (tools) => {
        const tool = tools.filter((candidate) => !("window" in candidate) || candidate.window === window)
          .find((candidate) => candidate.name === name)
        if (!tool) throw new Error(`WebMCP tool ${JSON.stringify(name)} is not registered in this frame`)
        const input = JSON.parse(inputJson)
        let result
        if (context.executeTool) {
          try {
            result = await context.executeTool(tool, input)
          } catch (error) {
            if (!isInputEncodingError(error)) throw error
            result = await context.executeTool(tool, inputJson)
          }
        } else if (context.invokeTool) {
          result = await context.invokeTool(name, input)
        } else {
          throw new Error("WebMCP tool execution is not available on this page")
        }
        if (typeof result !== "string") return result ?? null
        try { return JSON.parse(result) } catch { return result }
      })
    },
  }
})()
