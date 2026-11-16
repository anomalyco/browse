// Generated from cli/src/snapshot/naming.ts by js/generate.sh. Do not edit.
(() => {
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
    const placeholder = element.getAttribute("placeholder");
    if (placeholder)
      return normalize(placeholder);
    const ariaPlaceholder = element.getAttribute("aria-placeholder");
    if (ariaPlaceholder)
      return normalize(ariaPlaceholder);
    return "";
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
      const raw = element.getAttribute("alt") || safeText(element) || titleName(element) || element.querySelector?.("[aria-label]")?.getAttribute("aria-label") || element.querySelector?.("svg title")?.textContent || "";
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
})
