// Generated from cli/src/snapshot/browser-capture.ts by js/generate.sh. Do not edit.
function capture(rootOrSettings,locatorSettings
) {
const __name = (target) => target
const naming = (() => {
  const normalize = (value) => value.replace(/\s+/g, " ").trim(), styleCache = new WeakMap, styleOf = (element) => {
    let cached = styleCache.get(element);
    if (!cached) {
      cached = window.getComputedStyle(element);
      styleCache.set(element, cached);
    }
    return cached;
  }, visibleCache = new WeakMap, visibleAssociatedLabel = (element) => {
    if (!(element instanceof HTMLInputElement) || element.type !== "radio" && element.type !== "checkbox")
      return;
    return Array.from(element.labels ?? []).find((label) => isVisible(label));
  }, isVisible = (element) => {
    const cached = visibleCache.get(element);
    if (cached !== void 0)
      return cached;
    const style = styleOf(element);
    let result = !0;
    if (style.display === "none" || style.visibility === "hidden")
      result = !1;
    else if (style.opacity === "0")
      result = Boolean(visibleAssociatedLabel(element));
    else if (style.display === "contents")
      result = [
        ...Array.from(element.children ?? []),
        ...Array.from(element.shadowRoot?.children ?? [])
      ].some(isVisible);
    else {
      const rect = element.getBoundingClientRect();
      result = rect.width >= 1 && rect.height >= 1 || Boolean(visibleAssociatedLabel(element));
    }
    visibleCache.set(element, result);
    return result;
  }, explicitAriaName = (element) => {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel)
      return normalize(ariaLabel);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const rootNode = element.getRootNode(), labelled = normalize(labelledBy.split(/\s+/).map((id) => (rootNode.getElementById?.(id) ?? document.getElementById(id))?.textContent ?? "").join(" "));
      if (labelled)
        return labelled;
    }
    return "";
  }, titleName = (element) => normalize(element.getAttribute("title") ?? ""), labelledName = (element) => explicitAriaName(element) || titleName(element), safeTextCache = new WeakMap, safeText = (element) => {
    const cached = safeTextCache.get(element);
    if (cached !== void 0)
      return cached;
    const rootStyle = styleOf(element);
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" || rootStyle.display === "none" || rootStyle.visibility === "hidden" || rootStyle.opacity === "0") {
      safeTextCache.set(element, "");
      return "";
    }
    if (element.firstElementChild === null && !element.shadowRoot && element.localName !== "slot") {
      const result = normalize(element.textContent ?? "");
      safeTextCache.set(element, result);
      return result;
    }
    const parts = [], nearestBlock = (start) => {
      let current = start;
      while (current && current !== element && element.contains(current)) {
        const display = styleOf(current).display;
        if (display && display !== "inline" && display !== "contents")
          return current;
        current = current.parentElement;
      }
      return element;
    };
    let lastBlock;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node instanceof Element) {
          const local = node.localName;
          if (local === "input" || local === "textarea" || local === "select" || local === "script" || local === "style" || local === "noscript" || local === "template")
            return NodeFilter.FILTER_REJECT;
          const style = styleOf(node);
          if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
            return NodeFilter.FILTER_REJECT;
          if (node !== element && (node.hasAttribute("aria-label") || node.hasAttribute("aria-labelledby"))) {
            const ariaText = explicitAriaName(node);
            if (ariaText) {
              parts.push(` ${ariaText} `);
              lastBlock = void 0;
            }
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const block = nearestBlock(node.parentElement);
        if (lastBlock && lastBlock !== block)
          parts.push(" ");
        parts.push(node.textContent ?? "");
        lastBlock = block;
      } else if (node instanceof HTMLImageElement) {
        const alt = node.getAttribute("alt");
        if (alt)
          parts.push(` ${alt} `);
        lastBlock = void 0;
      } else if (typeof HTMLSlotElement < "u" && node instanceof HTMLSlotElement) {
        for (const assigned of node.assignedNodes({ flatten: !0 }))
          if (assigned.nodeType === Node.TEXT_NODE)
            parts.push(assigned.textContent ?? "");
          else if (assigned instanceof Element)
            parts.push(safeText(assigned));
        lastBlock = void 0;
      } else if (node instanceof Element && node.tagName === "BR") {
        parts.push(" ");
        lastBlock = void 0;
      }
      node = walker.nextNode();
    }
    const result = normalize(parts.join(""));
    safeTextCache.set(element, result);
    return result;
  }, authorAccessibleName = (element) => {
    const labelled = explicitAriaName(element);
    if (labelled)
      return labelled;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element instanceof HTMLButtonElement) {
      const label = element.labels?.[0];
      if (label) {
        const labelText = safeText(label);
        if (labelText)
          return labelText;
      }
    }
    if (element instanceof HTMLInputElement && (element.type === "button" || element.type === "submit" || element.type === "reset")) {
      const buttonValue = normalize(element.value || (element.type === "submit" ? "Submit" : element.type === "reset" ? "Reset" : ""));
      if (buttonValue)
        return buttonValue;
    }
    const title = titleName(element);
    if (title)
      return title;
    const placeholder = normalize(element.getAttribute("placeholder") || element.getAttribute("aria-placeholder") || "");
    if (placeholder)
      return placeholder;
    return "";
  }, placeholderName = (element) => {
    const role = element.getAttribute("role");
    if (!element.hasAttribute("contenteditable") && role !== "textbox" && role !== "searchbox")
      return "";
    return normalize(element.getAttribute("placeholder") || element.getAttribute("aria-placeholder") || "");
  }, accessibleNameCache = new WeakMap, accessibleName = (element) => {
    const cached = accessibleNameCache.get(element);
    if (cached !== void 0)
      return cached;
    let result = "";
    const labelled = explicitAriaName(element);
    if (labelled)
      result = labelled;
    else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
      result = authorAccessibleName(element);
    else {
      const raw = element.getAttribute("alt") || safeText(element) || titleName(element) || placeholderName(element) || element.querySelector?.("[aria-label]")?.getAttribute("aria-label") || element.querySelector?.("svg title")?.textContent || "";
      result = normalize(raw);
    }
    accessibleNameCache.set(element, result);
    return result;
  }, roleFor = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit)
      return explicit;
    if (/^H[1-6]$/.test(element.tagName))
      return "heading";
    if (element instanceof HTMLAnchorElement || element.tagName.toLowerCase() === "a" && element.hasAttribute("href"))
      return "link";
    if (element instanceof HTMLButtonElement)
      return "button";
    if (element.tagName === "SUMMARY")
      return "summary";
    if (element instanceof HTMLTextAreaElement)
      return "textbox";
    if (element instanceof HTMLSelectElement)
      return element.hasAttribute("multiple") || element.size > 1 ? "listbox" : "combobox";
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox")
        return "checkbox";
      if (element.type === "radio")
        return "radio";
      if (element.type === "number")
        return "spinbutton";
      if (element.type === "range")
        return "slider";
      if (["email", "search", "tel", "text", "url"].includes(element.type)) {
        const listId = element.getAttribute("list")?.trim().split(/\s+/)[0];
        if ((listId ? element.getRootNode().getElementById(listId) : null)?.tagName === "DATALIST")
          return "combobox";
      }
      if (element.type === "search")
        return "searchbox";
      if (element.type === "button" || element.type === "submit" || element.type === "reset" || element.type === "file")
        return "button";
      return "textbox";
    }
    if (element instanceof HTMLDialogElement)
      return "dialog";
    if (element instanceof HTMLFieldSetElement || element.tagName === "DETAILS")
      return "group";
    if (element instanceof HTMLTableElement)
      return "table";
    if (element instanceof HTMLTableRowElement)
      return "row";
    if (element instanceof HTMLUListElement || element instanceof HTMLOListElement)
      return "list";
    if (element instanceof HTMLLIElement)
      return "listitem";
    if (element.tagName === "PRE" || element.tagName === "CODE")
      return "code";
    if (element.tagName === "NAV")
      return "navigation";
    return element.tagName.toLowerCase();
  }, nameFromAuthorOnlyRoles = new Set(["combobox", "listbox", "textbox", "searchbox", "spinbutton", "slider"]);
  return {
    normalize,
    styleOf,
    isVisible,
    visibleAssociatedLabel,
    explicitAriaName,
    labelledName,
    safeText,
    authorAccessibleName,
    accessibleName,
    roleFor,
    identityNameFor: (element, role) => nameFromAuthorOnlyRoles.has(role) ? authorAccessibleName(element) : accessibleName(element)
  };
})()
return ((rootOrSettings, locatorSettings, naming) => {
  const settings = locatorSettings ?? rootOrSettings, truncate = (value, maxLength) => {
    if (value.length <= maxLength)
      return value;
    const prefix = value.slice(0, maxLength + 1), boundary = prefix.lastIndexOf(" ");
    return `${prefix.slice(0, boundary >= Math.floor(maxLength * 0.6) ? boundary : maxLength).trimEnd()}...`;
  }, quote = (value) => value.replace(/\\/g, "\\\\").replace(/"/g, "\\\""), {
    normalize,
    styleOf,
    isVisible,
    visibleAssociatedLabel,
    explicitAriaName,
    labelledName,
    safeText,
    accessibleName,
    roleFor,
    identityNameFor
  } = naming, isRowCell = (child) => {
    const local = child.localName;
    if (local === "th" || local === "td")
      return !0;
    const role = child.getAttribute("role");
    return role === "columnheader" || role === "rowheader" || role === "cell" || role === "gridcell";
  }, isColumnHeaderCell = (child) => child.localName === "th" || child.getAttribute("role") === "columnheader", isAnyHeaderCell = (child) => {
    if (child.localName === "th")
      return !0;
    const role = child.getAttribute("role");
    return role === "columnheader" || role === "rowheader";
  }, tableHeaderRowsCache = new WeakMap, headerRowFor = (table, currentRow) => {
    let cached = tableHeaderRowsCache.get(table);
    if (!cached) {
      const found = [], rows = table.querySelectorAll("tr, [role='row']");
      for (let i = 0;i < rows.length && found.length < 2; i++) {
        const row = rows[i], rowCells = [];
        let allColHeaders = !0, hasScopedColHeader = !1;
        for (let child = row.firstElementChild;child; child = child.nextElementSibling) {
          if (!isRowCell(child))
            continue;
          rowCells.push(child);
          if (!isColumnHeaderCell(child))
            allColHeaders = !1;
          if (child.getAttribute("role") === "columnheader" || child.localName === "th" && child.getAttribute("scope")?.toLowerCase() === "col")
            hasScopedColHeader = !0;
        }
        if (rowCells.length > 0 && (allColHeaders || hasScopedColHeader)) {
          const headers = [];
          for (let child = row.firstElementChild;child; child = child.nextElementSibling)
            if (isColumnHeaderCell(child))
              headers.push(safeText(child));
          found.push({ row, headers });
        }
      }
      cached = found;
      tableHeaderRowsCache.set(table, cached);
    }
    return cached[0]?.row === currentRow ? cached[1] : cached[0];
  }, structuralName = (element, role) => {
    const labelled = labelledName(element);
    if (labelled)
      return labelled;
    if (element instanceof HTMLFieldSetElement)
      return normalize(element.querySelector(":scope > legend")?.textContent ?? "");
    if (element instanceof HTMLTableElement)
      return normalize(element.caption?.textContent ?? "");
    if (element instanceof HTMLDetailsElement)
      return normalize(element.querySelector(":scope > summary")?.textContent ?? "");
    if (role === "dialog" || role === "alertdialog" || role === "group")
      return normalize(element.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']")?.textContent ?? "");
    if (role === "code")
      return normalize(element.textContent ?? "");
    if (role === "row") {
      const cells = [], headerCells = [];
      for (let child = element.firstElementChild;child; child = child.nextElementSibling) {
        if (!isRowCell(child))
          continue;
        cells.push(child);
        if (isAnyHeaderCell(child))
          headerCells.push(child);
      }
      const values = cells.map((cell) => safeText(cell));
      if (values.length === 0)
        return safeText(element);
      const table = element.closest("table, [role='table'], [role='grid']"), headerRow = table ? headerRowFor(table, element) : void 0;
      if (headerRow) {
        const headers = headerRow.headers;
        if (headers.length === values.length && headers.every(Boolean))
          return values.map((value, index) => `${headers[index]}: ${value}`).join(" | ");
      }
      if (headerCells.length === cells.length)
        return values.join(" | ");
      if (headerCells.length > 0) {
        const headers = headerCells.map((cell) => safeText(cell)).filter(Boolean), data = cells.filter((cell) => !headerCells.includes(cell)).map((cell) => safeText(cell)).filter(Boolean);
        return headers.length === 1 && data.length > 0 ? `${headers[0]}: ${data.join(" | ")}` : values.join(" | ");
      }
      return values.join(" | ");
    }
    if (role === "listitem")
      return safeText(element);
    return "";
  };
  let autoScopedMain = !1, rootNote;
  const root = rootOrSettings instanceof Element ? rootOrSettings : (() => {
    if (settings.rootSelector) {
      const matches = Array.from(document.querySelectorAll(settings.rootSelector));
      if (matches.length === 1)
        return matches[0];
      if (!settings.reportRootFallback)
        throw Error(`snapshot within expects exactly one match for selector: ${settings.rootSelector}; got ${matches.length}`);
      const firstMatch = matches.find(isVisible) ?? matches[0];
      if (firstMatch) {
        rootNote = `within "${settings.rootSelector}" matched ${matches.length} elements; showing the first`;
        return firstMatch;
      }
      rootNote = `within "${settings.rootSelector}" matched nothing; showing the whole page`;
      return document.body ?? document.documentElement;
    }
    const fallbackRoot = document.body ?? document.documentElement;
    if (!fallbackRoot)
      return null;
    const dialogs = Array.from(document.querySelectorAll("dialog, [role='dialog'], [role='alertdialog']")).filter(isVisible), modals = dialogs.filter((dialog) => dialog.matches(":modal, [aria-modal='true']") || Boolean(dialog.closest?.("[data-focus-lock-disabled='false']")));
    if (modals.length === 1)
      return modals[0];
    const isOpenListboxOrMenu = (menu) => {
      if (!isVisible(menu))
        return !1;
      if (menu.getAttribute("aria-label") === "slider" || menu.getAttribute("aria-roledescription") === "carousel")
        return !1;
      const items = Array.from(menu.querySelectorAll("[role='option'], [role^='menuitem']")).filter(isVisible);
      return items.length > 0 && !items.some((item) => item.getAttribute("role") === "option" && item.querySelector?.("a[href], button"));
    }, portalMenus = Array.from(document.querySelectorAll("[role='listbox'], [role='menu']")).filter(isOpenListboxOrMenu), mains = Array.from(document.querySelectorAll("main")).filter(isVisible);
    if (dialogs.length > 0 || mains.length === 1 && portalMenus.some((menu) => !mains[0].contains?.(menu)))
      return fallbackRoot;
    if (mains.length === 1) {
      autoScopedMain = !0;
      return mains[0];
    }
    return fallbackRoot;
  })();
  if (!root)
    return { entries: [], truncated: !1, ...rootNote ? { notes: [rootNote] } : {} };
  if (settings.rootRole && roleFor(root) !== settings.rootRole || settings.rootName && accessibleName(root) !== settings.rootName)
    throw Error("Snapshot ref no longer identifies the captured element; call snapshot() again");
  const nonTextInputTypes = new Set(["button", "checkbox", "file", "hidden", "image", "radio", "reset", "submit"]), isNativeTextControl = (element) => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement && !nonTextInputTypes.has(element.type), hiddenReadonlyAutocompleteTokens = new Set([
    "current-password",
    "new-password",
    "one-time-code",
    "cc-number",
    "cc-csc",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year"
  ]), detailsFor = (element) => {
    const details = [];
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox" || element.type === "radio")
        details.push(element.checked ? "checked" : "unchecked");
    }
    const ariaChecked = element.getAttribute("aria-checked");
    if ((ariaChecked === "true" || ariaChecked === "false" || ariaChecked === "mixed") && !(element instanceof HTMLInputElement))
      details.push(ariaChecked === "true" ? "checked" : ariaChecked === "false" ? "unchecked" : "checked=mixed");
    if (isNativeTextControl(element)) {
      const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/), isPassword = element instanceof HTMLInputElement && element.type === "password";
      if (element.readOnly && !isPassword && !autocomplete.some((token) => hiddenReadonlyAutocompleteTokens.has(token))) {
        details.push("readonly");
        const value = normalize(element.value);
        if (value)
          details.push(`value="${quote(truncate(value, 80))}"`);
      }
    }
    if (element instanceof HTMLSelectElement) {
      const selected = element.selectedOptions[0]?.textContent;
      if (selected)
        details.push(`selected="${quote(normalize(selected).slice(0, 80))}"`);
      details.push(`${element.options.length} options`);
    }
    if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
      if (element.disabled)
        details.push("disabled");
    }
    if (element.getAttribute("aria-disabled") === "true" && !details.includes("disabled"))
      details.push("disabled");
    const expanded = element.getAttribute("aria-expanded");
    if (expanded)
      details.push(`expanded=${expanded}`);
    if (element instanceof HTMLDetailsElement)
      details.push(`expanded=${element.open}`);
    if (element instanceof HTMLDialogElement) {
      details.push(`open=${element.open}`);
      const modal = element.getAttribute("aria-modal");
      if (modal)
        details.push(`modal=${modal}`);
    }
    if (element.tagName === "SUMMARY" && element.parentElement instanceof HTMLDetailsElement)
      details.push(`expanded=${element.parentElement.open}`);
    const selected = element.getAttribute("aria-selected");
    if (selected)
      details.push(`selected=${selected}`);
    const current = element.getAttribute("aria-current");
    if (current)
      details.push(`current=${current}`);
    if (element instanceof HTMLTableElement)
      details.push(`${element.rows.length} rows`);
    if (element instanceof HTMLUListElement || element instanceof HTMLOListElement)
      details.push(`${element.children.length} items`);
    if (element instanceof HTMLFieldSetElement)
      details.push(`${element.elements.length} controls`);
    return details.length ? details.join(" ") : void 0;
  }, isShadowRoot = (node) => typeof ShadowRoot < "u" && node instanceof ShadowRoot, parentElementOrHost = (node) => {
    if (!node)
      return null;
    if (node.parentElement)
      return node.parentElement;
    const rootNode = node.getRootNode?.();
    return isShadowRoot(rootNode) ? rootNode.host : null;
  }, closestDeep = (element, selector) => {
    let current = element;
    while (current) {
      const match = current.closest?.(selector) ?? null;
      if (match)
        return match;
      const rootNode = current.getRootNode?.();
      current = isShadowRoot(rootNode) ? rootNode.host : null;
    }
    return null;
  }, querySelectorAllDeep = (scope, selector) => {
    if (!scope.children)
      return Array.from(scope.querySelectorAll(selector));
    const results = [], visit = (node) => {
      for (let child = node.firstElementChild;child; child = child.nextElementSibling) {
        if (child.matches(selector))
          results.push(child);
        if (child.shadowRoot)
          visit(child.shadowRoot);
        if (child.firstElementChild)
          visit(child);
      }
    };
    if (scope instanceof Element && scope.shadowRoot)
      visit(scope.shadowRoot);
    visit(scope);
    return results;
  }, uniqueSelectorCache = new WeakMap, isUniqueSelector = (scope, selector) => {
    let bySelector = uniqueSelectorCache.get(scope);
    if (!bySelector) {
      bySelector = new Map;
      uniqueSelectorCache.set(scope, bySelector);
    }
    const cached = bySelector.get(selector);
    if (cached !== void 0)
      return cached;
    const unique = scope.querySelectorAll(selector).length === 1;
    bySelector.set(selector, unique);
    return unique;
  }, attributeStatsCache = new WeakMap, isUniqueAttributeValue = (scope, attribute, value) => {
    let byAttr = attributeStatsCache.get(scope);
    if (!byAttr) {
      byAttr = new Map;
      attributeStatsCache.set(scope, byAttr);
    }
    let state = byAttr.get(attribute);
    if (!state) {
      state = { misses: 0 };
      byAttr.set(attribute, state);
    }
    if (state.counts)
      return state.counts.get(value) === 1;
    const candidate = `[${attribute}="${CSS.escape(value)}"]`, cached = uniqueSelectorCache.get(scope)?.get(candidate);
    if (cached !== void 0)
      return cached;
    if (++state.misses >= 4) {
      const counts = new Map, elements = scope.querySelectorAll(`[${attribute}]`);
      for (let i = 0;i < elements.length; i++) {
        const attrVal = elements[i].getAttribute(attribute);
        if (attrVal !== null)
          counts.set(attrVal, (counts.get(attrVal) ?? 0) + 1);
      }
      state.counts = counts;
      return counts.get(value) === 1;
    }
    return isUniqueSelector(scope, candidate);
  }, nthOfTypeByContainer = new WeakMap, nthOfType = (element, container) => {
    let byElement = nthOfTypeByContainer.get(container);
    if (!byElement) {
      byElement = new WeakMap;
      const counts = new Map;
      for (let child = container.firstElementChild;child; child = child.nextElementSibling) {
        const next = (counts.get(child.tagName) ?? 0) + 1;
        counts.set(child.tagName, next);
        byElement.set(child, next);
      }
      nthOfTypeByContainer.set(container, byElement);
    }
    return byElement.get(element) ?? 1;
  }, localCssCache = new WeakMap, localCssPath = (element, scope) => {
    const cached = localCssCache.get(element);
    if (cached !== void 0)
      return cached;
    const result = (() => {
      const id = element.getAttribute("id");
      if (id) {
        const candidate = `#${CSS.escape(id)}`;
        if (isUniqueSelector(scope, candidate))
          return candidate;
      }
      for (const attribute of ["data-testid", "data-test-id", "data-test", "name", "aria-label", "placeholder"]) {
        const value = element.getAttribute(attribute);
        if (value) {
          if (isUniqueAttributeValue(scope, attribute, value))
            return `[${attribute}="${CSS.escape(value)}"]`;
        }
      }
      const tag = element.tagName.toLowerCase(), role = element.getAttribute("role"), roleSuffix = role ? `[role="${quote(role)}"]` : "";
      let checkedClasses = 0;
      for (const className of element.classList ?? []) {
        if (className.includes(":") || className.includes("[") || className.includes("/"))
          continue;
        if (++checkedClasses > 4)
          break;
        const candidate = `${tag}.${CSS.escape(className)}${roleSuffix}`;
        if (isUniqueSelector(scope, candidate))
          return candidate;
      }
      const parent = element.parentElement;
      if (!parent) {
        if (isShadowRoot(scope))
          return `${tag}:nth-of-type(${nthOfType(element, scope)})`;
        return tag;
      }
      return `${localCssPath(parent, scope)} > ${tag}:nth-of-type(${nthOfType(element, parent)})`;
    })();
    localCssCache.set(element, result);
    return result;
  }, cssPath = (element) => {
    const rootNode = element.getRootNode?.();
    if (isShadowRoot(rootNode))
      return `${cssPath(rootNode.host)} >> ${localCssPath(element, rootNode)}`;
    return localCssPath(element, document);
  }, frameTags = new Set(["iframe", "frame"]), frameHost = (element) => {
    const src = element.getAttribute("src");
    if (!src)
      return "";
    try {
      const url = new URL(src, document.baseURI);
      return url.host || url.protocol.replace(/:$/, "");
    } catch {
      return "";
    }
  }, frameName = (element) => {
    const labelled = labelledName(element);
    if (labelled)
      return labelled;
    const name = normalize(element.getAttribute("name") ?? "");
    if (name)
      return name;
    return frameHost(element) || "Frame";
  }, frameSource = (element) => {
    const host = frameHost(element);
    return host ? `src=${truncate(host, 80)}` : void 0;
  }, frameSelector = (element) => {
    const tag = element.localName;
    for (const attribute of ["title", "name", "src"]) {
      const value = element.getAttribute(attribute);
      if (!value)
        continue;
      const candidate = `${tag}[${attribute}="${quote(value)}"]`;
      if (isUniqueSelector(document, candidate))
        return candidate;
    }
    return cssPath(element);
  }, rootHeadings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']")).map((heading) => {
    const candidate = /^H([1-6])$/.exec(heading.tagName)?.[1];
    return {
      heading,
      level: candidate ? Number(candidate) : Number(heading.getAttribute("aria-level") ?? 1)
    };
  }), headingDepthCache = new WeakMap, headingDepth = (element) => {
    const cached = headingDepthCache.get(element);
    if (cached !== void 0)
      return cached;
    const ownLevel = /^H([1-6])$/.exec(element.tagName)?.[1];
    if (ownLevel) {
      const depth = Number(ownLevel) - 1;
      headingDepthCache.set(element, depth);
      return depth;
    }
    let treeTarget = element;
    while (isShadowRoot(treeTarget.getRootNode?.()))
      treeTarget = treeTarget.getRootNode().host;
    let low = 0, high = rootHeadings.length - 1, best = -1;
    while (low <= high) {
      const mid = low + high >>> 1, { heading } = rootHeadings[mid];
      if (heading !== treeTarget && (heading.compareDocumentPosition(treeTarget) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
        best = mid;
        low = mid + 1;
      } else
        high = mid - 1;
    }
    const level = best >= 0 ? rootHeadings[best].level : 0;
    headingDepthCache.set(element, level);
    return level;
  }, structuralTags = new Set(["fieldset", "dialog", "details", "table", "tr", "ul", "ol", "li", "pre"]), structuralRoles = new Set(["group", "radiogroup", "dialog", "alertdialog", "listbox", "menu", "tablist", "table", "row", "list", "listitem"]), interactiveTags = new Set(["button", "input", "textarea", "select", "summary"]), interactiveRoles = new Set([
    "button",
    "link",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "switch",
    "checkbox",
    "radio",
    "combobox",
    "searchbox",
    "textbox",
    "slider",
    "spinbutton",
    "treeitem"
  ]), extraCandidateTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "nav", "p"]), extraCandidateRoles = new Set(["heading", "navigation", "alert", "status"]), isStructuralElement = (element) => {
    if (structuralTags.has(element.localName))
      return !0;
    const role = element.getAttribute("role");
    return role !== null && structuralRoles.has(role);
  }, isInteractiveElement = (element) => {
    const local = element.localName;
    if (interactiveTags.has(local))
      return !0;
    if (local === "a" && element.hasAttribute("href"))
      return !0;
    if (element.hasAttribute("contenteditable"))
      return !0;
    const role = element.getAttribute("role");
    return role !== null && interactiveRoles.has(role);
  }, controlSelector = "a[href], button, input, textarea, select, summary, [contenteditable], [role]", visibleControlsIn = (scope) => querySelectorAllDeep(scope, controlSelector).filter((element) => isInteractiveElement(element) && isVisible(element)), menuControlSelector = "a[href], button, summary, [role='button'][aria-expanded], [role^='menuitem']", isCandidateElement = (element) => {
    const local = element.localName;
    if (frameTags.has(local))
      return !0;
    if (extraCandidateTags.has(local) || structuralTags.has(local) || interactiveTags.has(local))
      return !0;
    if (local === "a" && element.hasAttribute("href"))
      return !0;
    if (element.hasAttribute("contenteditable"))
      return !0;
    const role = element.getAttribute("role");
    return role !== null && (extraCandidateRoles.has(role) || structuralRoles.has(role) || interactiveRoles.has(role));
  }, structuralKeys = new WeakMap;
  let nextStructuralKey = 1;
  const structuralKey = (element) => {
    const existing = structuralKeys.get(element);
    if (existing)
      return existing;
    const key = `s${nextStructuralKey++}`;
    structuralKeys.set(element, key);
    return key;
  }, parentChainCache = new WeakMap, structuralChainFrom = (node) => {
    if (!node || node === root)
      return [];
    const cached = parentChainCache.get(node);
    if (cached !== void 0)
      return cached;
    const tail = structuralChainFrom(parentElementOrHost(node)), result = isStructuralElement(node) ? [structuralKey(node), ...tail] : tail;
    parentChainCache.set(node, result);
    return result;
  }, structuralParentKeys = (element) => structuralChainFrom(parentElementOrHost(element)), primaryLinks = new WeakMap, isPrimaryLink = (element) => {
    if (element.closest?.("h1, h2, h3, h4, h5, h6, [role='heading']") || element.firstElementChild !== null && element.querySelector?.("h1, h2, h3, h4, h5, h6, [role='heading']"))
      return !0;
    const group = element.closest("article, li, tr, dt, [role='listitem'], [role='row']");
    if (!group || !root.contains(group))
      return !1;
    if (!primaryLinks.has(group)) {
      const rawLinks = Array.from(group.querySelectorAll("a[href]"));
      if ((group.localName === "article" || group.getAttribute("role") === "article") && rawLinks.length > 12) {
        primaryLinks.set(group, null);
        return !1;
      }
      const links = rawLinks.filter(isVisible);
      let primary = null, primaryScore = -1;
      for (const link of links) {
        const name = accessibleName(link), headingBonus = link.closest("h1, h2, h3, h4, h5, h6, [role='heading']") ? 1000 : 0, commentBonus = /\b\d+\s+comments?\b/i.test(name) ? 500 : 0, score = name.length + headingBonus + commentBonus;
        if (score > primaryScore) {
          primary = link;
          primaryScore = score;
        }
      }
      primaryLinks.set(group, primary);
    }
    if (primaryLinks.get(group) !== element)
      return !1;
    if (group.localName === "tr" || group.getAttribute("role") === "row") {
      const groupTextLength = safeText(group).length;
      return groupTextLength > 0 && accessibleName(element).length / groupTextLength >= 0.15;
    }
    return !0;
  }, nestedTableCache = new WeakMap, hasNestedTable = (table) => {
    const cached = nestedTableCache.get(table);
    if (cached !== void 0)
      return cached;
    const result = Boolean(table.querySelector?.("table, [role='table']"));
    nestedTableCache.set(table, result);
    return result;
  }, layoutTableCache = new WeakMap, isLayoutTable = (table) => {
    if (!table || !settings.compact)
      return !1;
    const cached = layoutTableCache.get(table);
    if (cached !== void 0)
      return cached;
    let result;
    if (hasNestedTable(table))
      result = !0;
    else if (Boolean(labelledName(table) || table.caption || table.querySelector?.("th, [role='columnheader'], [role='rowheader']")))
      result = !1;
    else {
      const rowCount = table instanceof HTMLTableElement ? table.rows.length : table.querySelectorAll("tr, [role='row']").length;
      result = rowCount <= 1 || rowCount >= 20;
    }
    layoutTableCache.set(table, result);
    return result;
  }, isRedundantHeadingForLink = (element) => {
    if (!settings.compact || element === root)
      return !1;
    const parentInteractive = element.closest?.("a[href], button, [role='button'], [role='option'], [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']");
    if (parentInteractive && (root.contains?.(parentInteractive) ?? !0) && isVisible(parentInteractive))
      return !0;
    const headingText = accessibleName(element);
    if (!headingText)
      return !1;
    const childLinks = Array.from(element.querySelectorAll?.("a[href]") ?? []).filter(isVisible);
    if (childLinks.length === 1) {
      const linkText = accessibleName(childLinks[0]);
      if (linkText && (linkText === headingText || linkText.startsWith(headingText)))
        return !0;
    }
    const card = element.closest?.("article, [role='article']");
    if (card && (root.contains?.(card) ?? !0)) {
      const rawCardLinks = Array.from(card.querySelectorAll("a[href]"));
      if (rawCardLinks.length <= 12 && rawCardLinks.filter(isVisible).some((link) => accessibleName(link) === headingText))
        return !0;
    }
    return !1;
  }, seenCardLinks = new WeakMap, isDuplicateCardLink = (element, displayName) => {
    if (!settings.compact || !displayName || element.localName !== "a" || !element.hasAttribute("href"))
      return !1;
    const card = element.closest?.("article, [role='article'], li, [role='listitem'], tr, [role='row']");
    if (!card || !(root.contains?.(card) ?? !0))
      return !1;
    const href = element.getAttribute("href") ?? "";
    if (!href)
      return !1;
    let seen = seenCardLinks.get(card);
    if (!seen) {
      seen = new Set;
      seenCardLinks.set(card, seen);
    }
    const key = `${href}\x00${displayName}`;
    if (seen.has(key))
      return !0;
    seen.add(key);
    return !1;
  }, redundantListItemCache = new WeakMap, isRedundantListItem = (element) => {
    if (!settings.compact || element === root)
      return !1;
    const cached = redundantListItemCache.get(element);
    if (cached !== void 0)
      return cached;
    let result = !1;
    if (element.querySelector?.("ul, ol, [role='list'], h1, h2, h3, h4, h5, h6, [role='heading']"))
      result = !0;
    else if (!element.querySelector?.("p")) {
      const controls = Array.from(element.querySelectorAll?.("a[href], button") ?? []).filter(isVisible);
      if (controls.length > 0) {
        const itemLength = safeText(element).length;
        result = itemLength > 0 && controls.some((control) => accessibleName(control).length >= itemLength * 0.65);
      }
    }
    redundantListItemCache.set(element, result);
    return result;
  }, priorityFor = (options) => {
    if (options.role === "alert" || options.role === "status" || options.role === "navigation" || options.structuralEssential || options.inActiveOverlay)
      return -1;
    if (options.role === "heading")
      return 0;
    if (options.role === "link" && options.primaryLink)
      return 0;
    if (options.interactive && (options.role !== "link" || options.primaryLink))
      return 1;
    if (options.role === "link")
      return 3;
    return 2;
  }, entries = [];
  let truncated = !1;
  const add = (entry) => {
    if (entry.depth > settings.depth)
      return;
    if (entries.length >= settings.maxCandidates) {
      truncated = !0;
      return;
    }
    entries.push(entry);
  }, headerSelector = "input, textarea, select, button, [role='searchbox'], [role='combobox'], [role='button'], a[href][aria-label]", headerRoots = autoScopedMain && typeof document.querySelectorAll === "function" ? Array.from(document.querySelectorAll("header, [role='banner']")).filter((h) => isVisible(h) && !root.contains?.(h)) : [], headerCandidateSet = new Set(headerRoots.flatMap((h) => querySelectorAllDeep(h, headerSelector).filter((el) => !el.closest?.("nav, [role='navigation']")))), collapsedNavigation = new Set, nonCollapsibleNavigation = new WeakSet;
  let reservedLists = 0;
  function* iterateCandidates(scope) {
    for (const headerEl of headerCandidateSet)
      yield headerEl;
    if (isCandidateElement(scope))
      yield scope;
    function* visit(node) {
      for (let child = node.firstElementChild;child; child = child.nextElementSibling) {
        if (isCandidateElement(child))
          yield child;
        if (collapsedNavigation.has(child))
          continue;
        if (child.shadowRoot)
          yield* visit(child.shadowRoot);
        if (child.firstElementChild)
          yield* visit(child);
      }
    }
    if (scope.shadowRoot)
      yield* visit(scope.shadowRoot);
    yield* visit(scope);
  }
  for (const element of iterateCandidates(root)) {
    if (entries.length >= settings.maxCandidates) {
      truncated = !0;
      break;
    }
    if (settings.compact && !settings.interactive && !settings.expandNavigation && !headerCandidateSet.has(element)) {
      const navigation = closestDeep(element, "nav, [role='navigation'], aside, [role='complementary'], [data-slot='sidebar'], [data-sidebar='sidebar']");
      if (navigation && collapsedNavigation.has(navigation))
        continue;
      if (navigation && navigation !== root && !navigation.contains?.(root) && !nonCollapsibleNavigation.has(navigation)) {
        const controls = isVisible(navigation) ? visibleControlsIn(navigation) : [];
        if (controls.length > 0 && controls.every((control) => control.matches(menuControlSelector)) && (navigation.matches("nav, [role='navigation']") || controls.filter((control) => control.localName === "a" && control.hasAttribute("href")).length >= 8 && !navigation.querySelector?.("h1, main, [role='main'], input, textarea, select"))) {
          collapsedNavigation.add(navigation);
          const parentKeys = structuralParentKeys(navigation), baseDepth = headingDepth(navigation);
          add({
            depth: baseDepth + parentKeys.length,
            baseDepth,
            ...parentKeys.length > 0 ? { parentKeys } : {},
            role: "navigation",
            name: truncate(labelledName(navigation), 100) || "Navigation",
            details: `${controls.length} controls`,
            priority: 0
          });
          continue;
        }
        nonCollapsibleNavigation.add(navigation);
      }
    }
    if (!isVisible(element))
      continue;
    const role = roleFor(element), isHeading = role === "heading", isFrame = frameTags.has(element.localName);
    if (isFrame) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 20 && rect.height < 20)
        continue;
    }
    if (isHeading && isRedundantHeadingForLink(element))
      continue;
    if (role === "combobox" && !(element instanceof HTMLInputElement || element instanceof HTMLButtonElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) && element.querySelector?.("input, textarea, select"))
      continue;
    if (role === "option" && element.querySelector?.("a[href], button"))
      continue;
    const isInteractive = isInteractiveElement(element), isSafetyText = role === "alert" || role === "status", isParagraph = element.localName === "p", isStructural = isFrame || !isInteractive && isStructuralElement(element);
    if (isStructural) {
      if (role === "listbox" && (element.getAttribute("aria-label") === "slider" || element.getAttribute("aria-roledescription") === "carousel"))
        continue;
      if (role === "listitem" && isRedundantListItem(element))
        continue;
      if (role === "table" && isLayoutTable(element))
        continue;
      if (role === "row") {
        const parentTable = element.closest?.("table, [role='table']") ?? null;
        if (parentTable ? isLayoutTable(parentTable) || hasNestedTable(parentTable) && Boolean(element.querySelector?.("table, [role='table']")) : Boolean(element.querySelector?.("table, [role='table']")))
          continue;
      }
    }
    if (!isHeading && !isInteractive && !isSafetyText && !isStructural && (settings.interactive || !isParagraph))
      continue;
    if (settings.interactive && isParagraph && !isSafetyText)
      continue;
    if (settings.compact && isParagraph && !isSafetyText && element.parentElement !== null && (element.parentElement.localName === "li" || element.parentElement.getAttribute("role") === "listitem") && !isRedundantListItem(element.parentElement) && safeText(element).length >= safeText(element.parentElement).length * 0.8)
      continue;
    const displayName = isFrame ? frameName(element) : isStructural ? structuralName(element, role) : accessibleName(element);
    if (isInteractive && isDuplicateCardLink(element, displayName))
      continue;
    const identityName = isInteractive ? identityNameFor(element, role) : displayName, isDisabled = element.disabled === !0 || element.getAttribute("aria-disabled") === "true";
    if (isInteractive && isDisabled && !displayName && !element.getAttribute("name") && !isNativeTextControl(element))
      continue;
    const fallbackName = role === "group" ? "Group" : role === "dialog" || role === "alertdialog" ? "Dialog" : role === "listbox" ? "Listbox" : role === "menu" ? "Menu" : role === "table" ? "Table" : role === "list" ? "List" : role === "tablist" ? "Tab list" : isInteractive ? element.getAttribute("name") || element.getAttribute("data-testid") || element.getAttribute("data-test-id") || element.getAttribute("data-test") || role : "", name = truncate(displayName || fallbackName, isParagraph || isSafetyText || isStructural ? 180 : 120);
    if (!name)
      continue;
    const details = isHeading ? `level=${headingDepth(element) + 1}` : isFrame ? frameSource(element) : detailsFor(element), primaryLink = role === "link" && isPrimaryLink(element) || headerCandidateSet.has(element), baseDepth = headingDepth(element), parentKeys = structuralParentKeys(element), overlayAncestor = element.closest?.("dialog, [role='dialog'], [role='alertdialog'], [role='listbox'], [role='menu']") ?? null, inActiveOverlay = Boolean((isInteractive || role === "dialog" || role === "alertdialog" || role === "listbox" || role === "menu") && overlayAncestor && overlayAncestor.getAttribute("aria-label") !== "slider" && overlayAncestor.getAttribute("aria-roledescription") !== "carousel"), labelProxy = (() => {
      if (!isInteractive)
        return;
      const label = visibleAssociatedLabel(element);
      if (!label)
        return;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1)
        return label;
      if (styleOf(element).opacity !== "0")
        return;
      return document.elementFromPoint?.(rect.left + rect.width / 2, rect.top + rect.height / 2) === element ? void 0 : label;
    })();
    add({
      depth: baseDepth + parentKeys.length,
      baseDepth,
      ...isStructural ? { key: structuralKey(element) } : {},
      ...parentKeys.length > 0 ? { parentKeys } : {},
      role,
      name,
      ...element === root ? { root: !0 } : {},
      ...isInteractive && identityName && !labelProxy ? { identityName } : {},
      ...labelProxy ? { selectorRole: "label" } : {},
      ...isInteractive ? { interactiveElement: labelProxy ?? element } : isFrame ? { frameElement: element } : {},
      ...details ? { details } : {},
      priority: priorityFor({
        role: headerCandidateSet.has(element) ? "heading" : role,
        interactive: isInteractive,
        primaryLink,
        inActiveOverlay,
        structuralEssential: isStructural && role !== "iframe" && role !== "row" && role !== "listitem" && role !== "code" && (role !== "group" || Boolean(displayName)) && (role !== "list" || reservedLists++ < Math.max(1, Math.floor(settings.maxItems / 10)))
      })
    });
  }
  const selected = entries.map((entry, index) => ({ entry, index })).sort((left, right) => left.entry.priority - right.entry.priority || left.index - right.index).slice(0, settings.expandNavigation ? settings.maxCandidates : settings.maxItems).sort((left, right) => left.index - right.index).map(({ entry: { interactiveElement, frameElement, ...rest } }) => ({
    ...rest,
    ...interactiveElement ? { selector: cssPath(interactiveElement) } : frameElement ? { selector: frameSelector(frameElement), iframe: !0 } : {}
  })), needsSettle = Boolean(!settings.rootSelector && typeof MutationObserver < "u" && document.body && (Boolean(document.querySelector?.("[aria-busy='true'], .skeleton:not(.no-skeleton)")) || !selected.some((entry) => Boolean(entry.selector)) && typeof performance < "u" && performance.now() < 2500));
  return {
    entries: selected,
    truncated: truncated || selected.length < entries.length,
    ...needsSettle ? { needsSettle: !0 } : {},
    ...rootNote ? { notes: [rootNote] } : {}
  };
})(rootOrSettings, locatorSettings, naming)
}
