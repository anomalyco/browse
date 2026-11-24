// The execute globals: browse's tools as async functions, a Playwright-style page/locator layer on top of them, the
// TS execute helpers (snapshot, ref, handoff, files, ...), console capture and timers. Everything that leaves the
// engine goes through `host`: host.async(op, json) → id (settled later through settle), host.sync(op, json) → json,
// host.cancel(id), host.log(level, ...text), host.finish(json).
(function (host, configJson, stateJson) {
  "use strict"
  const config = JSON.parse(configJson)
  const pending = new Map()
  const warnings = []
  const warn = (text) => { if (!warnings.includes(text)) warnings.push(text) }

  // ---------------------------------------------------------------- host calls

  const timeoutPattern = /timed out|timeout|waited \d+ ?ms/i
  function makeError(message, trace) {
    const error = trace || new Error()
    error.message = String(message)
    if (timeoutPattern.test(error.message)) error.name = "TimeoutError"
    return error
  }
  function hostAsync(op, payload) {
    const trace = new Error()
    return new Promise((resolve, reject) => {
      const id = host.async(op, JSON.stringify(payload ?? null))
      pending.set(id, { resolve, reject, trace })
    })
  }
  function hostSync(op, payload) {
    try {
      return JSON.parse(host.sync(op, JSON.stringify(payload ?? null)))
    } catch (error) {
      throw makeError(error && error.message !== undefined ? error.message : error)
    }
  }
  function settle(id, ok, json) {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    const value = JSON.parse(json)
    if (ok) entry.resolve(value)
    else entry.reject(makeError(value, entry.trace))
  }

  // ---------------------------------------------------------------- images and tool results

  const imageId = Symbol("image")
  class BrowseImage {
    constructor(info) {
      Object.defineProperty(this, imageId, { value: info.id })
      this.type = "image"
      this.mimeType = info.mimeType
      this.size = info.size
    }
    get length() { return this.size }
    get byteLength() { return this.size }
    toString(encoding) {
      if (encoding === "base64") return hostSync("image", { id: this[imageId] })
      return `[image ${this.mimeType}, ${this.size} bytes]`
    }
    toJSON() { return { type: "image", mimeType: this.mimeType, size: this.size } }
  }

  function toolValue(result) {
    let value = result.text
    if (typeof value === "string" && value.length) {
      try { value = JSON.parse(value) } catch {}
    } else value = undefined
    const images = (result.images || []).map((info) => new BrowseImage(info))
    if (!images.length) return value
    if (value === undefined || value === "") return images.length === 1 ? images[0] : images
    if (value && typeof value === "object" && !Array.isArray(value)) {
      value.image = images[0]
      if (images.length > 1) value.images = images
      return value
    }
    return images.length > 1 ? { result: value, image: images[0], images } : { result: value, image: images[0] }
  }
  function clean(args) {
    const out = {}
    for (const [key, value] of Object.entries(args || {})) if (value !== undefined) out[key] = value
    return out
  }
  async function tool(name, args) {
    return toolValue(await hostAsync("tool", { name, args: clean(args) }))
  }
  function toolSync(name, args) {
    return toolValue(hostSync("tool", { name, args: clean(args) }))
  }
  const sleep = (ms) => hostAsync("sleep", { ms: Math.max(0, Number(ms) || 0) })

  // browse.<tool>() acts in `page`'s tab unless the call names one; browse.navigate() without a tab opens one for
  // `page` like page.goto().
  const tabless = new Set(["tabs", "status", "settings"])
  const browse = {}
  for (const name of config.tools) {
    browse[name] = async (args) => {
      const own = args && args.tab !== undefined && args.tab !== null
      if (own || tabless.has(name) || !defaultPage) return tool(name, args)
      if (defaultPage._hasTab()) return tool(name, { ...(args || {}), tab: defaultPage._tab })
      const result = await tool(name, args)
      if (name === "navigate" && result && typeof result.tab === "number") {
        defaultPage._tab = result.tab
        pages.set(result.tab, defaultPage)
      }
      return result
    }
    const camel = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    if (camel !== name) browse[camel] = browse[name]
  }

  // ---------------------------------------------------------------- console and timers

  function format(value) {
    if (typeof value === "string") return value
    if (value instanceof Error) return `${value.name}: ${value.message}`
    if (value === undefined) return "undefined"
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
    try { return JSON.stringify(value, (k, v) => typeof v === "bigint" ? String(v) : v) ?? String(value) } catch { return String(value) }
  }
  const consoleObject = {}
  for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
    consoleObject[level] = (...items) => host.log(level === "trace" ? "debug" : level, ...items.map(format))
  }
  consoleObject.dir = consoleObject.log
  consoleObject.table = consoleObject.log
  consoleObject.assert = (condition, ...items) => { if (!condition) host.log("error", "Assertion failed", ...items.map(format)) }
  consoleObject.time = consoleObject.timeEnd = consoleObject.group = consoleObject.groupEnd = () => {}

  const timers = new Map()
  let nextTimer = 1
  function setTimer(callback, ms, args, repeat) {
    if (typeof callback !== "function") throw new TypeError("setTimeout needs a function")
    const handle = nextTimer++
    const schedule = () => {
      const trace = undefined
      const id = host.async("sleep", JSON.stringify({ ms: Math.max(0, Number(ms) || 0) }))
      timers.set(handle, id)
      pending.set(id, {
        trace,
        resolve: () => {
          if (!timers.has(handle)) return
          if (repeat) schedule()
          else timers.delete(handle)
          try { callback(...args) } catch (error) { host.log("error", "Uncaught in timer:", format(error)) }
        },
        reject: () => timers.delete(handle),
      })
    }
    schedule()
    return handle
  }
  function clearTimer(handle) {
    const id = timers.get(handle)
    if (id === undefined) return
    timers.delete(handle)
    pending.delete(id)
    host.cancel(id)
  }
  globalThis.setTimeout = (callback, ms, ...args) => setTimer(callback, ms, args, false)
  globalThis.setInterval = (callback, ms, ...args) => setTimer(callback, Math.max(10, Number(ms) || 0), args, true)
  globalThis.clearTimeout = clearTimer
  globalThis.clearInterval = clearTimer
  globalThis.queueMicrotask = (callback) => { Promise.resolve().then(callback) }
  const unavailable = (name, instead) => { throw new Error(`${name} is not available in execute; ${instead}`) }
  globalThis.fetch = () => unavailable("fetch", "it belongs to the page: page.evaluate(() => fetch(url).then((r) => r.text()))")
  globalThis.require = (name) => unavailable(`require(${JSON.stringify(name)})`, "there are no Node modules; use the browse globals (page, files, browse.*)")
  globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value))

  // ---------------------------------------------------------------- selectors

  const escapeAttribute = (value, exact) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"${exact ? "s" : "i"}`
  const regexSelector = (re) => String(re)
  const textSelector = (text, exact) => text instanceof RegExp ? regexSelector(text) : JSON.stringify(String(text)) + (exact ? "s" : "i")
  const attributeValue = (value, exact) => value instanceof RegExp ? regexSelector(value) : escapeAttribute(value, exact)
  function roleSelector(role, options = {}) {
    let selector = `internal:role=${role}`
    if (options.name !== undefined) selector += `[name=${attributeValue(options.name, options.exact)}]`
    for (const key of ["checked", "pressed", "selected", "expanded", "disabled", "level"]) {
      if (options[key] !== undefined) selector += `[${key}=${options[key]}]`
    }
    if (options.includeHidden) selector += "[include-hidden=true]"
    return selector
  }
  const builders = {
    getByRole: (role, options) => roleSelector(role, options),
    getByText: (text, options = {}) => `internal:text=${textSelector(text, options.exact)}`,
    getByLabel: (text, options = {}) => `internal:label=${textSelector(text, options.exact)}`,
    getByPlaceholder: (text, options = {}) => `internal:attr=[placeholder=${attributeValue(text, options.exact)}]`,
    getByAltText: (text, options = {}) => `internal:attr=[alt=${attributeValue(text, options.exact)}]`,
    getByTitle: (text, options = {}) => `internal:attr=[title=${attributeValue(text, options.exact)}]`,
    getByTestId: (id) => `internal:testid=[data-testid=${attributeValue(id, true)}]`,
  }
  function filterSelector(options = {}) {
    let selector = ""
    if (options.hasText !== undefined) selector += ` >> internal:has-text=${textSelector(options.hasText, false)}`
    if (options.hasNotText !== undefined) selector += ` >> internal:has-not-text=${textSelector(options.hasNotText, false)}`
    if (options.has) selector += ` >> internal:has=${JSON.stringify(selectorOf(options.has))}`
    if (options.hasNot) selector += ` >> internal:has-not=${JSON.stringify(selectorOf(options.hasNot))}`
    if (options.visible !== undefined) selector += ` >> visible=${!!options.visible}`
    return selector
  }
  function selectorOf(locator) {
    if (!(locator instanceof Locator)) throw new Error("expected a locator")
    if (locator._ref) throw new Error(`ref("${locator._ref}") can't be combined with other locators; use a selector`)
    return locator._selector
  }
  /** Function source for page.evaluate and friends. */
  function source(fn) {
    if (typeof fn === "function") return fn.toString()
    if (typeof fn === "string") return null
    throw new TypeError("evaluate needs a function or a string")
  }
  const box = (arg) => (arg === undefined ? {} : { v: arg })

  /** One setInputFiles entry as the upload tool takes it: a path, or { name, data } with base64 data. */
  function uploadPayload(file) {
    if (typeof file === "string") return file
    const takes = "setInputFiles takes file paths, { name, buffer } with a Uint8Array or ArrayBuffer, or { name, data } with base64 data"
    if (!file || typeof file !== "object" || typeof file.name !== "string" || !file.name) throw new Error(takes)
    let data
    if (typeof file.buffer === "string") throw new Error("setInputFiles: buffer must be bytes; pass base64 as data instead")
    else if (file.buffer instanceof ArrayBuffer) data = bytesToBase64(new Uint8Array(file.buffer))
    else if (ArrayBuffer.isView(file.buffer)) data = bytesToBase64(new Uint8Array(file.buffer.buffer, file.buffer.byteOffset, file.buffer.byteLength))
    else if (typeof file.data === "string") data = file.data
    else throw new Error(takes)
    return clean({ name: file.name, data, mimeType: file.mimeType, lastModified: file.lastModified === undefined ? Date.now() : file.lastModified })
  }

  // ---------------------------------------------------------------- locators

  const pageOf = Symbol("page")
  class Locator {
    constructor(page, selector, ref) {
      Object.defineProperty(this, pageOf, { value: page })
      this._selector = selector
      this._ref = ref
    }
    _target(extra) {
      const target = this._ref ? { ref: this._ref } : { selector: this._selector }
      return this[pageOf]._args({ ...target, ...extra })
    }
    _timeout(options) { return options && options.timeout !== undefined ? options.timeout : this[pageOf]._timeout }
    _chain(selector) {
      if (this._ref) throw new Error(`ref("${this._ref}") can't be chained; take a selector from the snapshot (e.g. role=button[name="..."]) instead`)
      return new Locator(this[pageOf], `${this._selector} >> ${selector}`)
    }
    toString() { return this._ref ? `ref(${this._ref})` : `locator(${this._selector})` }
    page() { return this[pageOf] }

    locator(selector, options) {
      if (selector instanceof Locator) return this._chain(`internal:chain=${JSON.stringify(selectorOf(selector))}`)
      return this._chain(String(selector) + filterSelector(options))
    }
    filter(options) { const s = filterSelector(options); return s ? this._chain(s.slice(4)) : this }
    and(other) { return this._chain(`internal:and=${JSON.stringify(selectorOf(other))}`) }
    or(other) { return this._chain(`internal:or=${JSON.stringify(selectorOf(other))}`) }
    first() { return this._ref ? this : this._chain("nth=0") }
    last() { return this._ref ? this : this._chain("nth=-1") }
    nth(index) { return this._ref && index === 0 ? this : this._chain(`nth=${index}`) }
    frameLocator(selector) { return new FrameLocator(this[pageOf], this._chain(String(selector))._selector) }
    contentFrame() { return new FrameLocator(this[pageOf], selectorOf(this)) }

    async click(options = {}) {
      if (options.trial) return this.waitFor({ timeout: options.timeout })
      return tool("click", this._target({ button: options.button, clickCount: options.clickCount, modifiers: options.modifiers, position: options.position, force: options.force, timeout: this._timeout(options) }))
    }
    dblclick(options = {}) { return this.click({ ...options, clickCount: 2 }) }
    tap(options) { return this.click(options) }
    fill(value, options = {}) { return tool("fill", this._target({ value: String(value), force: options.force, timeout: this._timeout(options) })) }
    clear(options) { return this.fill("", options) }
    type(text, options = {}) { return tool("type", this._target({ text: String(text), delay: options.delay, timeout: this._timeout(options) })) }
    pressSequentially(text, options) { return this.type(text, options) }
    press(key, options = {}) { return tool("press", this._target({ key, timeout: this._timeout(options) })) }
    hover(options = {}) { return tool("hover", this._target({ position: options.position, force: options.force, timeout: this._timeout(options) })) }
    check(options = {}) { return tool("fill", this._target({ checked: true, force: options.force, timeout: this._timeout(options) })) }
    uncheck(options = {}) { return tool("fill", this._target({ checked: false, force: options.force, timeout: this._timeout(options) })) }
    setChecked(checked, options) { return checked ? this.check(options) : this.uncheck(options) }
    async selectOption(values, options = {}) {
      const list = values === null || values === undefined ? [] : Array.isArray(values) ? values : [values]
      let by
      const plain = list.map((item) => {
        if (typeof item === "string" || typeof item === "number") return String(item)
        if (item && item.value !== undefined) { by = by || "value"; return String(item.value) }
        if (item && item.label !== undefined) { by = by || "label"; return String(item.label) }
        if (item && item.index !== undefined) { by = by || "index"; return String(item.index) }
        throw new Error("selectOption takes strings or { value } / { label } / { index }")
      })
      const result = await tool("select", this._target({ values: plain, by, timeout: this._timeout(options) }))
      return result && Array.isArray(result.selected) ? result.selected : result
    }
    setInputFiles(files, options = {}) {
      const list = (Array.isArray(files) ? files : [files]).map(uploadPayload)
      return tool("upload", this._target({ files: list, timeout: this._timeout(options) }))
    }
    async evaluate(fn, arg, options = {}) {
      const src = source(fn)
      const expression = src === null ? `(el) => (${fn})` : `(el, __a) => (${src})(el, __a.v)`
      return tool("eval", this._target({ expression, arg: box(arg), timeout: this._timeout(options) }))
    }
    _read(fn, options) { return this.evaluate(fn, undefined, options) }
    textContent(options) { return this._read((el) => el.textContent, options) }
    innerText(options) { return this._read((el) => el.innerText, options) }
    innerHTML(options) { return this._read((el) => el.innerHTML, options) }
    inputValue(options) { return this._read((el) => { if (!("value" in el)) throw new Error("Not an <input>, <textarea> or <select> element"); return el.value }, options) }
    getAttribute(name, options) { return this.evaluate((el, n) => el.getAttribute(n), name, options) }
    isChecked(options) { return this._read((el) => el.checked !== undefined && el.type !== undefined ? !!el.checked : el.getAttribute("aria-checked") === "true", options) }
    isDisabled(options) { return this._read((el) => !!el.disabled || el.getAttribute("aria-disabled") === "true", options) }
    async isEnabled(options) { return !(await this.isDisabled(options)) }
    isEditable(options) { return this._read((el) => !el.disabled && !el.readOnly && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)), options) }
    focus(options) { return this._read((el) => { el.focus() }, options) }
    blur(options) { return this._read((el) => { el.blur() }, options) }
    dispatchEvent(type, init, options) { return this.evaluate((el, [t, i]) => { el.dispatchEvent(new Event(t, { bubbles: true, cancelable: true, ...(i || {}) })) }, [type, init || {}], options) }
    boundingBox(options) { return this._read((el) => { const r = el.getBoundingClientRect(); return r.width || r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null }, options) }
    scrollIntoViewIfNeeded(options = {}) { return tool("scroll", this._target({ timeout: this._timeout(options) })) }
    highlight() { return Promise.resolve() }
    async isVisible() {
      if (this._ref) {
        try { return await tool("eval", this._target({ expression: "(el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' }", timeout: 1000 })) } catch { return false }
      }
      return this[pageOf]._query(this._selector, "(els, a, h) => els.length > 0 && h.visible(els[0])")
    }
    async isHidden() { return !(await this.isVisible()) }
    async count() {
      if (this._ref) { try { await tool("eval", this._target({ expression: "(el) => 1", timeout: 1000 })); return 1 } catch { return 0 } }
      return this[pageOf]._query(this._selector, "(els) => els.length")
    }
    async all() {
      if (this._ref) return [this]
      const n = await this.count()
      return Array.from({ length: n }, (_, i) => this.nth(i))
    }
    allTextContents() { return this[pageOf]._query(selectorOf(this), "(els) => els.map((e) => e.textContent ?? '')") }
    allInnerTexts() { return this[pageOf]._query(selectorOf(this), "(els) => els.map((e) => e.innerText ?? '')") }
    evaluateAll(fn, arg) {
      const src = source(fn)
      if (src === null) throw new TypeError("evaluateAll needs a function")
      return this[pageOf]._query(selectorOf(this), `(els, __a) => (${src})(els, __a.v)`, box(arg))
    }
    async waitFor(options = {}) {
      await tool("wait_for", this._target({ state: options.state, timeout: this._timeout(options) }))
    }
    screenshot(options = {}) {
      return tool("screenshot", this._target({ path: options.path, format: options.type, quality: options.quality, timeoutMs: this._timeout(options) }))
    }
    dragTo(target, options = {}) {
      const end = target._ref ? { ref: target._ref } : { selector: selectorOf(target) }
      const start = this._ref ? { ref: this._ref } : { selector: this._selector }
      return tool("drag", this[pageOf]._args({ from: start, to: end, force: options.force, timeout: this._timeout(options) }))
    }
    evaluateHandle() { unsupported("locator.evaluateHandle", "use locator.evaluate and return plain data") }
    elementHandle() { return Promise.resolve(this) }
    elementHandles() { return this.all() }
    ariaSnapshot(options = {}) { return snapshotFn({ mode: "aria", within: this._ref || this._selector, ...this[pageOf]._args({}), ...options }) }
  }
  for (const [name, build] of Object.entries(builders)) {
    Locator.prototype[name] = function (...args) { return this._chain(build(...args)) }
  }

  class FrameLocator {
    constructor(page, frameSelector) {
      this._page = page
      this._frame = frameSelector
    }
    _inner(selector) { return new Locator(this._page, `${this._frame} >> internal:control=enter-frame >> ${selector}`) }
    locator(selector, options) { return this._inner(String(selector) + filterSelector(options)) }
    frameLocator(selector) { return new FrameLocator(this._page, `${this._frame} >> internal:control=enter-frame >> ${selector}`) }
    owner() { return new Locator(this._page, this._frame) }
    first() { return new FrameLocator(this._page, `${this._frame} >> nth=0`) }
    last() { return new FrameLocator(this._page, `${this._frame} >> nth=-1`) }
    nth(index) { return new FrameLocator(this._page, `${this._frame} >> nth=${index}`) }
  }
  for (const [name, build] of Object.entries(builders)) {
    FrameLocator.prototype[name] = function (...args) { return this._inner(build(...args)) }
  }

  function unsupported(name, instead) {
    throw new Error(`${name} is not supported in browse's execute; ${instead}`)
  }

  // ---------------------------------------------------------------- page

  class Response {
    constructor(result) { this._result = result || {} }
    url() { return this._result.url }
    status() { return this._result.status ?? 200 }
    statusText() { return "" }
    ok() { const s = this.status(); return s >= 200 && s < 400 }
    headers() { return {} }
    allHeaders() { return Promise.resolve({}) }
    request() { unsupported("response.request()", "use network.start() / network.stop() to see requests") }
    text() { unsupported("response.text()", "use page.content() or page.evaluate(() => document.body.innerText)") }
    json() { unsupported("response.json()", "use page.evaluate(() => fetch(url).then((r) => r.json()))") }
    toJSON() { return this._result }
  }

  const waitStates = { load: "load", domcontentloaded: "domcontentloaded", networkidle: "settle", commit: "commit" }
  function waitUntil(value) {
    if (value === undefined) return undefined
    if (!(value in waitStates)) throw new Error(`waitUntil must be load, domcontentloaded, networkidle or commit, not ${JSON.stringify(value)}`)
    return waitStates[value]
  }

  const pages = new Map()
  let defaultPage
  const noTab = "page has no tab yet: call await page.goto(url) first (it opens a new tab), or pass `tab` to execute to work in a tab you already have"
  class Page {
    constructor(tab) {
      this._tab = tab
      this._timeout = undefined
      this._navigationTimeout = undefined
      this.keyboard = new Keyboard(this)
      this.mouse = new Mouse(this)
      this.touchscreen = { tap: (x, y) => this.mouse.click(x, y) }
    }
    _hasTab() { return this._tab !== undefined && this._tab !== null }
    _args(args) {
      if (!this._hasTab()) throw makeError(noTab)
      return clean({ ...args, tab: this._tab })
    }
    _query(selector, fn, arg) { return hostAsync("query", { selector, function: fn, arg: arg ?? {}, tab: this._args({}).tab }) }
    toString() { return `Page(${this._hasTab() ? `tab ${this._tab}` : "no tab yet"})` }

    context() { return contextObject }
    mainFrame() { return this }
    frames() { return [this] }
    isClosed() {
      if (!this._hasTab()) return this._closed === true
      try { return !toolSync("tabs", {}).tabs.some((t) => t.tab === this._tab) } catch { return false }
    }
    setDefaultTimeout(ms) { this._timeout = ms }
    setDefaultNavigationTimeout(ms) { this._navigationTimeout = ms }

    async goto(url, options = {}) {
      const args = { url: String(url), waitUntil: waitUntil(options.waitUntil), timeout: options.timeout ?? this._navigationTimeout, referrer: options.referer }
      // A page without a tab opens one on its first navigation.
      const result = await tool("navigate", this._hasTab() ? this._args(args) : clean(args))
      if (!this._hasTab() && result && typeof result.tab === "number") {
        this._closed = false
        this._tab = result.tab
        pages.set(result.tab, this)
      }
      return new Response(result)
    }
    async reload(options = {}) { return new Response(await tool("navigate", this._args({ action: "reload", waitUntil: waitUntil(options.waitUntil), timeout: options.timeout }))) }
    async goBack(options = {}) { return new Response(await tool("navigate", this._args({ action: "back", waitUntil: waitUntil(options.waitUntil), timeout: options.timeout }))) }
    async goForward(options = {}) { return new Response(await tool("navigate", this._args({ action: "forward", waitUntil: waitUntil(options.waitUntil), timeout: options.timeout }))) }
    url() { return this._hasTab() ? hostSync("url", { tab: this._tab }) : "about:blank" }
    title() { return this.evaluate("document.title") }
    content() { return this.evaluate("(document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '') + document.documentElement.outerHTML") }
    async evaluate(fn, arg, isolated) {
      const src = source(fn)
      const world = isolated === false ? "main" : undefined
      if (src === null) return tool("eval", this._args({ expression: fn, world }))
      return tool("eval", this._args({ expression: `(__e, __a) => (${src})(__a.v)`, arg: box(arg), world }))
    }
    evaluateHandle() { unsupported("page.evaluateHandle", "use page.evaluate and return plain data") }
    $eval(selector, fn, arg) { return this.locator(selector).first().evaluate(fn, arg) }
    $$eval(selector, fn, arg) { return this.locator(selector).evaluateAll(fn, arg) }
    async $(selector) { const l = this.locator(selector).first(); return (await l.count()) ? l : null }
    $$(selector) { return this.locator(selector).all() }
    locator(selector, options) {
      if (selector instanceof Locator) return selector
      return new Locator(this, String(selector) + filterSelector(options))
    }
    frameLocator(selector) { return new FrameLocator(this, String(selector)) }
    frame() { unsupported("page.frame()", "use page.frameLocator(iframeSelector) or an `iframe >> frame >> ...` selector") }

    // Page-level actions act on the first match, like Playwright's.
    _first(selector) { return this.locator(selector).first() }
    click(selector, options) { return this._first(selector).click(options) }
    dblclick(selector, options) { return this._first(selector).dblclick(options) }
    tap(selector, options) { return this._first(selector).click(options) }
    fill(selector, value, options) { return this._first(selector).fill(value, options) }
    type(selector, text, options) { return this._first(selector).type(text, options) }
    press(selector, key, options) { return this._first(selector).press(key, options) }
    hover(selector, options) { return this._first(selector).hover(options) }
    focus(selector, options) { return this._first(selector).focus(options) }
    check(selector, options) { return this._first(selector).check(options) }
    uncheck(selector, options) { return this._first(selector).uncheck(options) }
    setChecked(selector, checked, options) { return this._first(selector).setChecked(checked, options) }
    selectOption(selector, values, options) { return this._first(selector).selectOption(values, options) }
    setInputFiles(selector, files, options) { return this._first(selector).setInputFiles(files, options) }
    textContent(selector, options) { return this._first(selector).textContent(options) }
    innerText(selector, options) { return this._first(selector).innerText(options) }
    innerHTML(selector, options) { return this._first(selector).innerHTML(options) }
    inputValue(selector, options) { return this._first(selector).inputValue(options) }
    getAttribute(selector, name, options) { return this._first(selector).getAttribute(name, options) }
    isVisible(selector) { return this._first(selector).isVisible() }
    isHidden(selector) { return this._first(selector).isHidden() }
    isChecked(selector, options) { return this._first(selector).isChecked(options) }
    isEnabled(selector, options) { return this._first(selector).isEnabled(options) }
    isDisabled(selector, options) { return this._first(selector).isDisabled(options) }
    isEditable(selector, options) { return this._first(selector).isEditable(options) }
    dispatchEvent(selector, type, init, options) { return this._first(selector).dispatchEvent(type, init, options) }
    dragAndDrop(source, target, options = {}) { return tool("drag", this._args({ from: source, to: target, force: options.force, timeout: options.timeout })) }

    waitForTimeout(ms) { return sleep(ms) }
    async waitForSelector(selector, options = {}) {
      const state = options.state || "visible"
      const first = this._first(selector)
      await tool("wait_for", first._target({ state, timeout: options.timeout ?? this._timeout }))
      return state === "visible" || state === "attached" ? first : null
    }
    async waitForURL(url, options = {}) {
      const timeout = options.timeout ?? this._navigationTimeout ?? 30000
      if (typeof url === "function") {
        const deadline = Date.now() + timeout
        for (;;) {
          let current
          try { current = new URL(this.url()) } catch { current = this.url() }
          if (await url(current)) break
          if (Date.now() > deadline) throw makeError(`waitForURL timed out after ${timeout} ms`)
          await sleep(100)
        }
      } else if (url instanceof RegExp) {
        await tool("wait_for", this._args({ urlRegex: (url.flags.includes("i") ? "(?i)" : "") + url.source, timeout }))
      } else {
        await tool("wait_for", this._args({ url: String(url), timeout }))
      }
      if (options.waitUntil) await this.waitForLoadState(options.waitUntil, { timeout })
    }
    async waitForLoadState(state = "load", options = {}) {
      await tool("wait_for", this._args({ load: waitUntil(state), timeout: options.timeout ?? this._navigationTimeout }))
    }
    async waitForNavigation(options = {}) {
      const before = this.url()
      const timeout = options.timeout ?? this._navigationTimeout ?? 30000
      const deadline = Date.now() + timeout
      while (this.url() === before && Date.now() < deadline) await sleep(100)
      if (options.url) await this.waitForURL(options.url, { timeout: Math.max(1, deadline - Date.now()) })
      await this.waitForLoadState(options.waitUntil || "load", { timeout: Math.max(1000, deadline - Date.now()) })
      return null
    }
    async waitForFunction(fn, arg, options = {}) {
      const timeout = options.timeout ?? this._timeout ?? 30000
      const interval = typeof options.polling === "number" ? options.polling : 100
      const deadline = Date.now() + timeout
      for (;;) {
        const value = await this.evaluate(fn, arg)
        if (value) return value
        if (Date.now() > deadline) throw makeError(`waitForFunction timed out after ${timeout} ms`)
        await sleep(interval)
      }
    }
    waitForEvent(event) {
      if (event === "filechooser") unsupported(`page.waitForEvent(${JSON.stringify(event)})`, `call setInputFiles on the button that opens the chooser instead (page.locator("#attach").setInputFiles(path) or browse.upload({ selector, files }))`)
      unsupported(`page.waitForEvent(${JSON.stringify(event)})`, "wait for what the event changes instead (page.waitForURL, locator.waitFor, browse.wait_for)")
    }
    waitForResponse() { unsupported("page.waitForResponse", "use network.start() before the action and network.stop() after it") }
    waitForRequest() { unsupported("page.waitForRequest", "use network.start() before the action and network.stop() after it") }

    on(event, handler) { return this._listen(event, handler) }
    once(event, handler) { return this._listen(event, handler) }
    addListener(event, handler) { return this._listen(event, handler) }
    off() { return this }
    removeListener() { return this }
    removeAllListeners() { return this }
    _listen(event, handler) {
      if (event === "dialog") {
        const answer = /dismiss/.test(String(handler)) ? "dismiss" : "accept"
        toolSync("dialog", this._args({ auto: answer }))
        warn(`page.on("dialog") handlers aren't called in execute: dialogs on the tab are now ${answer}ed automatically (browse.dialog({ auto: "off" }) stops it)`)
        return this
      }
      if (event === "filechooser") unsupported(`page.on(${JSON.stringify(event)})`, `call setInputFiles on the button that opens the chooser instead (page.locator("#attach").setInputFiles(path) or browse.upload({ selector, files }))`)
      if (event === "console" || event === "pageerror") unsupported(`page.on(${JSON.stringify(event)})`, "use pageConsole.start(), then pageConsole.read()")
      if (event === "request" || event === "response" || event === "requestfinished") unsupported(`page.on(${JSON.stringify(event)})`, "use network.start() and network.stop()")
      unsupported(`page.on(${JSON.stringify(event)})`, "events aren't available; poll for the change instead")
    }

    async screenshot(options = {}) {
      if (options.mask || options.animations || options.omitBackground) warn("page.screenshot: mask, animations and omitBackground are ignored")
      return tool("screenshot", this._args({ path: options.path, fullPage: options.fullPage, format: options.type, quality: options.quality, clip: options.clip, scale: options.scale }))
    }
    async setViewportSize(size) { await tool("emulate", this._args({ viewport: { width: size.width, height: size.height } })) }
    viewportSize() { return hostEval(this, "({ width: innerWidth, height: innerHeight })") }
    async emulateMedia(options = {}) {
      await tool("emulate", this._args({ colorScheme: options.colorScheme ?? undefined, reducedMotion: options.reducedMotion ?? undefined, forcedColors: options.forcedColors ?? undefined, media: options.media === null ? "reset" : options.media }))
    }
    async bringToFront() { warn("page.bringToFront() does nothing: browse's tabs never take focus from the user") }
    async close() {
      if (!this._hasTab()) return
      await tool("tabs", { action: "close", tab: this._tab })
      pages.delete(this._tab)
      // A closed page has no tab; a later goto opens a new one.
      this._tab = undefined
      this._closed = true
    }
    async pause() { warn("page.pause() does nothing in execute; use handoff() to let the user act") }
    pdf() { unsupported("page.pdf()", "take page.screenshot({ fullPage: true }) instead") }
    route() { unsupported("page.route()", "requests can't be intercepted; use network.start() to observe them") }
    unroute() { return Promise.resolve() }
    setExtraHTTPHeaders() { unsupported("page.setExtraHTTPHeaders()", "headers can't be changed") }
    addInitScript() { unsupported("page.addInitScript()", "pages could see it; run page.evaluate() after navigating instead") }
    exposeFunction() { unsupported("page.exposeFunction()", "pages could see it; read page state with page.evaluate() instead") }
    exposeBinding() { unsupported("page.exposeBinding()", "pages could see it; read page state with page.evaluate() instead") }
    addScriptTag() { unsupported("page.addScriptTag()", "use page.evaluate(code, arg, false) to run in the page's own world") }
    addStyleTag() { unsupported("page.addStyleTag()", "use page.evaluate() to add a <style> element") }
    setContent(html) { return this.evaluate((h) => { document.open(); document.write(h); document.close() }, String(html)) }
    async opener() { return null }
    video() { return null }
  }
  for (const [name, build] of Object.entries(builders)) {
    Page.prototype[name] = function (...args) { return new Locator(this, build(...args)) }
  }
  function hostEval(page, expression) {
    return toolSync("eval", page._args({ expression }))
  }

  class Keyboard {
    constructor(page) { this._page = page }
    press(key, options = {}) { return tool("press", this._page._args({ key })) }
    type(text, options = {}) { return tool("type", this._page._args({ text: String(text), delay: options.delay })) }
    insertText(text) { return tool("type", this._page._args({ text: String(text) })) }
    down(key) { unsupported(`keyboard.down(${JSON.stringify(key)})`, 'press a combination instead: keyboard.press("Shift+ArrowDown")') }
    up(key) { unsupported(`keyboard.up(${JSON.stringify(key)})`, 'press a combination instead: keyboard.press("Shift+ArrowDown")') }
  }
  class Mouse {
    constructor(page) { this._page = page }
    click(x, y, options = {}) { return tool("click", this._page._args({ x, y, button: options.button, clickCount: options.clickCount })) }
    dblclick(x, y, options = {}) { return this.click(x, y, { ...options, clickCount: 2 }) }
    move(x, y) { return tool("hover", this._page._args({ x, y })) }
    wheel(deltaX, deltaY) { return tool("scroll", this._page._args({ deltaX, deltaY })) }
    down() { unsupported("mouse.down()", "use locator.dragTo(), page.dragAndDrop() or browse.drag({ from, to })") }
    up() { unsupported("mouse.up()", "use locator.dragTo(), page.dragAndDrop() or browse.drag({ from, to })") }
  }

  function pageFor(tab) {
    if (!pages.has(tab)) pages.set(tab, new Page(tab))
    return pages.get(tab)
  }
  defaultPage = config.tab === null || config.tab === undefined ? new Page(undefined) : pageFor(config.tab)

  const contextObject = {
    async newPage() {
      const opened = await tool("tabs", { action: "new" })
      return pageFor(opened.tab)
    },
    /** The tabs this execute works in, and the popups they opened. */
    pages() {
      const list = toolSync("tabs", {}).tabs || []
      const known = (t) => pages.has(t.tab) || (t.opener !== undefined && pages.has(t.opener))
      const found = list.filter(known).map((t) => pageFor(t.tab))
      return defaultPage._hasTab() ? found : [defaultPage, ...found]
    },
    browser() { return browserObject },
    async close() { warn("context.close() does nothing: the browser is the user's. Close tabs you opened with page.close()") },
    cookies() { unsupported("context.cookies()", "cookies stay in the user's browser; read what the page can see with page.evaluate(() => document.cookie)") },
    addCookies() { unsupported("context.addCookies()", "cookies stay in the user's browser") },
    clearCookies() { unsupported("context.clearCookies()", "cookies stay in the user's browser") },
    storageState() { unsupported("context.storageState()", "cookies and storage stay in the user's browser") },
    grantPermissions() { unsupported("context.grantPermissions()", "permissions can't be granted; ask the user with handoff()") },
    setGeolocation(geolocation) { return tool("emulate", defaultPage._args({ geolocation })) },
    setOffline(offline) { return tool("emulate", defaultPage._args({ offline: !!offline })) },
    route() { unsupported("context.route()", "requests can't be intercepted; use network.start() to observe them") },
    on(event) { unsupported(`context.on(${JSON.stringify(event)})`, "events aren't available; list tabs with context.pages()") },
    waitForEvent(event) {
      if (event === "filechooser") unsupported(`context.waitForEvent(${JSON.stringify(event)})`, `call setInputFiles on the button that opens the chooser instead (page.locator("#attach").setInputFiles(path) or browse.upload({ selector, files }))`)
      unsupported(`context.waitForEvent(${JSON.stringify(event)})`, "poll context.pages() instead")
    },
    setDefaultTimeout(ms) { defaultPage._timeout = ms },
    setDefaultNavigationTimeout(ms) { defaultPage._navigationTimeout = ms },
    addInitScript() { unsupported("context.addInitScript()", "pages could see it; run page.evaluate() after navigating instead") },
  }
  const browserObject = {
    contexts() { return [contextObject] },
    newPage() { return contextObject.newPage() },
    newContext() { unsupported("browser.newContext()", "there is one context, the user's browser; open tabs with context.newPage()") },
    async close() { warn("browser.close() does nothing: the browser is the user's") },
    isConnected() { return true },
    version() { return "chromium" },
  }

  // ---------------------------------------------------------------- TS execute helpers

  function pageArgs(options) {
    const page = options && options.page
    const rest = { ...(options || {}) }
    delete rest.page
    return page instanceof Page ? page._args(rest) : defaultPage._args(rest)
  }
  function snapshotFn(options) { return tool("snapshot", pageArgs(options)) }
  const snapshot = (options) => snapshotFn(options)
  const ariaSnapshot = (options) => snapshotFn({ ...(options || {}), mode: "aria" })
  const ref = (id) => {
    if (typeof id !== "string" || !id) throw new TypeError("ref needs a snapshot ref like \"e12\"")
    return new Locator(defaultPage, undefined, id.replace(/^\[?ref=/, "").replace(/\]$/, ""))
  }
  async function handoff(message, options = {}) {
    const page = options.page instanceof Page ? options.page : defaultPage
    const timeoutSeconds = options.timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(options.timeoutMs / 1000))
    const args = page._args({ message: String(message || "Finish this step in the browser, then click Continue"), timeoutSeconds })
    const waiting = tool("handoff", args)
    if (typeof options.start === "function") {
      waiting.catch(() => {})
      await options.start()
    }
    try {
      return await waiting
    } catch (error) {
      let outcome
      try { outcome = JSON.parse(error.message).outcome } catch {}
      if (outcome) error.message = `The handoff ended without the user continuing (${outcome})`
      throw error
    }
  }
  async function demonstrate(message, options = {}) {
    const page = options.page instanceof Page ? options.page : defaultPage
    const timeoutSeconds = options.timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(options.timeoutMs / 1000))
    return tool("demonstrate", page._args({ message: String(message || "Demonstrate the browser flow, then click Continue"), timeoutSeconds }))
  }
  async function screenshotWithLabels(options = {}) {
    const result = await tool("screenshot", pageArgs({ ...options, labels: true }))
    const labels = Array.isArray(result) ? result : result && (result.labels || result.result)
    const image = result && result.image
    return { image, screenshot: image, path: result && result.path, labels: labels || [], labelCount: (labels || []).length, size: image ? image.size : 0 }
  }
  const screenshotDiff = (options) => tool("screenshot_diff", pageArgs(options))
  const target = (page) => (page instanceof Page ? page._args({}) : defaultPage._args({}))
  const network = {
    start: (options) => tool("network", pageArgs({ ...(options || {}), action: "start" })),
    status: (page) => toolSync("network", { ...target(page), action: "status" }),
    stop: (page) => tool("network", { ...target(page), action: "stop" }),
    cancel: (page) => tool("network", { ...target(page), action: "cancel" }),
  }
  const pageConsole = {
    start: (page) => tool("console", { ...target(page), action: "start" }),
    read: (options) => tool("console", pageArgs({ ...(options || {}), action: "read" })),
    stop: (page) => tool("console", { ...target(page), action: "stop" }),
  }
  const webmcp = {
    list: () => tool("webmcp", defaultPage._args({ action: "list" })),
    call: (name, input, options = {}) => tool("webmcp", defaultPage._args({ action: "call", name, input: input || {}, frame: options.frame, timeout: options.timeout })),
  }
  function inputTarget(value) {
    if (value instanceof Locator) return value._ref ? { ref: value._ref } : { selector: value._selector }
    if (typeof value === "string") return /^f?\d*[ae]\d+$/.test(value) ? { ref: value } : { selector: value }
    if (value && (value.ref || value.selector)) return { ref: value.ref, selector: value.selector }
    throw new TypeError("expected a locator, a selector or a ref")
  }
  const fillInput = (targetValue, value, options = {}) => tool("fill", defaultPage._args({ ...inputTarget(targetValue), value: String(value), force: options.force }))
  const fillInputs = (page, fields, options = {}) => {
    if (Array.isArray(page)) { options = fields || {}; fields = page; page = defaultPage }
    const list = fields.map((field) => clean({ ...inputTarget(field.target ?? field.locator ?? field), value: field.value === undefined ? undefined : String(field.value), checked: field.checked }))
    return tool("fill", (page instanceof Page ? page : defaultPage)._args({ fields: list, force: options.force }))
  }

  const fileInfo = () => hostSync("files", { op: "info" })
  const files = {
    get dir() { return fileInfo().dir },
    get roots() { return fileInfo().roots },
    path: (name) => hostSync("files", { op: "path", target: String(name) }),
    async write(name, data) {
      const payload = { op: "write", target: String(name) }
      if (typeof data === "string") payload.text = data
      else if (data instanceof BrowseImage) payload.base64 = data.toString("base64")
      else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) payload.base64 = bytesToBase64(new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength))
      else if (data !== undefined && data !== null) payload.text = JSON.stringify(data)
      else throw new TypeError("files.write needs a string, bytes or an image")
      return hostSync("files", payload)
    },
    async read(name, encoding) {
      const result = hostSync("files", { op: "read", target: String(name), encoding: encoding === undefined ? undefined : String(encoding).toLowerCase() })
      if (result.text !== undefined) return result.text
      if (encoding === "base64") return result.base64
      return base64ToBytes(result.base64)
    },
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  function bytesToBase64(bytes) {
    let out = ""
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
      out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + (i + 1 < bytes.length ? alphabet[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? alphabet[n & 63] : "=")
    }
    return out
  }
  function base64ToBytes(text) {
    const clean = text.replace(/=+$/, "")
    const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4))
    let j = 0
    for (let i = 0; i < clean.length; i += 4) {
      const n = (alphabet.indexOf(clean[i]) << 18) | (alphabet.indexOf(clean[i + 1]) << 12) | ((alphabet.indexOf(clean[i + 2]) & 63) << 6) | (alphabet.indexOf(clean[i + 3]) & 63)
      if (j < bytes.length) bytes[j++] = (n >> 16) & 255
      if (j < bytes.length) bytes[j++] = (n >> 8) & 255
      if (j < bytes.length) bytes[j++] = n & 255
    }
    return bytes
  }

  let state
  try { state = JSON.parse(stateJson) } catch { state = {} }
  if (!state || typeof state !== "object" || Array.isArray(state)) state = {}

  // ---------------------------------------------------------------- results

  function jsonSafe(value, images, reasons) {
    const seen = new Set()
    const walk = (v, depth) => {
      if (v === null || typeof v === "string" || typeof v === "boolean") return v
      if (typeof v === "number") return Number.isFinite(v) ? v : null
      if (typeof v === "bigint") return String(v)
      if (v === undefined || typeof v === "function" || typeof v === "symbol") return undefined
      if (v instanceof BrowseImage) { images.push(v[imageId]); return v.toJSON() }
      if (seen.has(v)) { reasons.add("circular reference"); return undefined }
      if (depth > 32) { reasons.add("maximum object depth exceeded"); return undefined }
      seen.add(v)
      try {
        if (Array.isArray(v) || v instanceof Set) return Array.from(v, (x) => { const w = walk(x, depth + 1); return w === undefined ? null : w })
        if (ArrayBuffer.isView(v)) return Array.from(v.slice(0, 1000))
        if (v instanceof Map) { const o = {}; for (const [k, x] of v) { const w = walk(x, depth + 1); if (w !== undefined) o[String(k)] = w } return o }
        if (v instanceof Date) return v.toISOString()
        if (v instanceof Error) return { name: v.name, message: v.message }
        if (v instanceof Response) return v.toJSON()
        const proto = Object.getPrototypeOf(v)
        if (proto !== Object.prototype && proto !== null) { reasons.add(`class instance (${String(v)})`); return undefined }
        const o = {}
        for (const key of Object.keys(v)) { const w = walk(v[key], depth + 1); if (w !== undefined) o[key] = w }
        return o
      } finally { seen.delete(v) }
    }
    return walk(value, 0)
  }

  const frameLine = /execute\.js:\d+/
  function errorText(error) {
    if (error instanceof Error) {
      const frames = String(error.stack || "").split("\n").filter((line) => frameLine.test(line)).map((line) => "    " + line.trim())
      const head = `${error.name || "Error"}: ${error.message}`
      return frames.length ? `${head}\n${frames.join("\n")}` : head
    }
    // QuickJS throws null when it can't even allocate the out-of-memory error.
    if (error === null) return "Thrown: null (most likely out of memory: execute code has 64 MB; keep large data in the page or write it to a file)"
    return `Thrown: ${format(error)}`
  }

  function finish(report) {
    report.warnings = warnings
    // The tab `page` ended on, and every tab this execute worked in, so the next execute can continue there.
    if (defaultPage._hasTab()) report.tab = defaultPage._tab
    report.tabs = [...pages.keys()]
    host.finish(JSON.stringify(report))
  }

  async function start(fn) {
    const values = { console: consoleObject, browser: browserObject, context: contextObject, page: defaultPage, state, browse, files, snapshot, ariaSnapshot, ref, handoff, demonstrate, screenshotWithLabels, screenshotDiff, network, pageConsole, webmcp, fillInput, fillInputs }
    try {
      let value = await fn(...config.globals.map((name) => values[name]))
      // `async (page) => { ... }`, as other Playwright tools take it.
      if (typeof value === "function" && /^\s*(async\s*)?(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(String(value))) value = await value(defaultPage)
      const images = []
      const reasons = new Set()
      const safe = jsonSafe(value, images, reasons)
      let text
      if (typeof value === "string") text = value
      else if (value === undefined) text = "undefined"
      else if (safe === undefined) text = String(value)
      else text = JSON.stringify(safe)
      if (value !== undefined && reasons.size) warn(`Parts of the result could not be represented as JSON and were left out: ${[...reasons].join(", ")}`)
      finish({ ok: true, text, images })
    } catch (error) {
      finish({ ok: false, error: errorText(error), images: [] })
    }
  }
  function fail(error) {
    finish({ ok: false, error: errorText(error), images: [] })
  }
  function saveState() {
    try { return JSON.stringify(state) } catch (error) { warn(`state could not be saved as JSON: ${error.message}`); return null }
  }

  return { settle, start, fail, saveState }
})
