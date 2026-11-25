//! Letting the user point at elements while a handoff waits: in the tab's main frame, browse's isolated world draws a
//! closed shadow overlay that outlines the element under the pointer, swallows clicks so nothing on the page reacts,
//! and keeps a numbered list of the elements the user picked, each with a note. Each picked element comes back with a
//! selector the page tools can reuse and a short summary (attributes, role and name, text, a few computed styles, its
//! box). Values of sensitive fields (passwords, hidden inputs, card numbers, one-time codes) are never read.
//!
//! The overlay stays before browse's direct-tab handoff card in `<html>`, since that card only takes a click while it
//! is the last child. Clicks on that card, on the extension's card host and on the overlay itself go through; every
//! other click picks, popovers of the page's own included. Listeners the page added earlier on `window` in the capture
//! phase still see events first, so the page can notice clicks and keys, but default actions are prevented.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use browse_core::{Browser, CallOptions, Evaluated, FrameId, PageEvent, Realm, Returns, TabDriver, World};
use serde_json::{Value, json};

use crate::browser::RelayBrowser;
use crate::relay::Relay;

/// How many elements one document can hold.
const MAX_PICKS: usize = 50;

/// Draws the overlay once per picker id per document and starts picking; returns the document's key.
const INSTALL: &str = r##"/*browse-pick:install*/(pickerId, maxPicks) => {
  const g = globalThis;
  if (g.__browsePick?.id === pickerId) return g.__browsePick.doc;
  g.__browsePick?.cleanup();
  const doc = Math.random().toString(36).slice(2);
  const picks = [];
  let general = '';
  let version = 0;
  const changed = () => { version++; g.__browsePick?.wake?.(); };
  const imp = (el, props) => { for (const key of Object.keys(props)) el.style.setProperty(key, props[key], 'important'); };
  const clip = (text, max) => text.length > max ? text.slice(0, max) + '…' : text;
  const squash = (text) => (text || '').replace(/\s+/g, ' ').trim();

  const unique = (selector) => { try { return document.querySelectorAll(selector).length === 1; } catch (e) { return false; } };
  const count = (selector) => { try { return document.querySelectorAll(selector).length; } catch (e) { return 0; } };
  const stableId = (id) => !!id && !/[:\s]|\d{3,}|^[-_\d]|[0-9a-f]{8}/i.test(id);
  const stableClass = (name) => !!name && !/^(css|sc|jsx|emotion|svelte)-/.test(name) && !/[-_][A-Za-z0-9]*\d[A-Za-z0-9]*$/.test(name.replace(/^[^-_]*/, '')) && name.length < 40;
  const attr = (name, value) => `[${name}="${CSS.escape(value)}"]`;
  const tagOf = (el) => CSS.escape(el.localName);
  const classes = (el) => Array.from(el.classList).filter(stableClass).slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
  const own = (el) => {
    const tag = tagOf(el);
    for (const name of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
      const value = el.getAttribute(name);
      if (value && unique(attr(name, value))) return attr(name, value);
    }
    const id = el.getAttribute('id');
    if (stableId(id) && unique('#' + CSS.escape(id))) return '#' + CSS.escape(id);
    for (const name of ['name', 'aria-label', 'placeholder', 'title', 'alt', 'href', 'for']) {
      const value = el.getAttribute(name);
      if (value && value.length <= 80 && unique(tag + attr(name, value))) return tag + attr(name, value);
    }
    const role = el.getAttribute('role');
    if (role && unique(tag + attr('role', role))) return tag + attr('role', role);
    for (const name of Array.from(el.classList).filter(stableClass)) {
      if (unique(tag + '.' + CSS.escape(name))) return tag + '.' + CSS.escape(name);
    }
    const both = tag + classes(el);
    if (both !== tag && unique(both)) return both;
    if (unique(tag)) return tag;
    return null;
  };
  const segment = (el) => {
    const base = tagOf(el) + classes(el);
    const parent = el.parentElement;
    if (!parent) return base;
    const same = Array.from(parent.children).filter((c) => c.localName === el.localName);
    const alike = same.filter((c) => { try { return c.matches(base); } catch (e) { return false; } });
    return alike.length > 1 ? `${base}:nth-of-type(${same.indexOf(el) + 1})` : base;
  };
  const selectorFor = (el) => {
    const parts = [];
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const mine = own(node);
      if (mine) { parts.unshift(mine); break; }
      parts.unshift(segment(node));
    }
    if (parts.length === 0) return 'html';
    const selector = parts.join(' > ');
    return unique(selector) || !el.parentElement ? selector : 'html > ' + selector;
  };
  const label = (el) => {
    const id = el.getAttribute('id');
    const cls = Array.from(el.classList).slice(0, 2).map((c) => '.' + c).join('');
    return el.localName + (id ? '#' + id : '') + cls;
  };

  const sensitive = (el) => {
    if (el instanceof HTMLInputElement && ['password', 'hidden'].includes(el.type)) return true;
    const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
    return /cc-|one-time-code|password/.test(auto);
  };
  const implicitRole = (el) => {
    const tag = el.localName;
    if (el instanceof HTMLInputElement) {
      return { checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button', reset: 'button', image: 'button', search: 'searchbox', number: 'spinbutton' }[el.type] || (el.type === 'hidden' ? undefined : 'textbox');
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return {
      a: el.hasAttribute('href') ? 'link' : undefined, button: 'button', select: 'combobox', textarea: 'textbox', img: 'img',
      nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary', form: 'form',
      ul: 'list', ol: 'list', li: 'listitem', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', dialog: 'dialog',
      section: el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : undefined, summary: 'button',
    }[tag];
  };
  const NAMED_BY_CONTENT = new Set(['button', 'link', 'heading', 'listitem', 'cell', 'columnheader', 'row', 'option', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'treeitem', 'tooltip']);
  const nameFor = (el, role) => {
    const aria = el.getAttribute('aria-label')?.trim();
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = squash(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '));
      if (text) return clip(text, 120);
    }
    if (el.labels?.length) {
      const text = squash(Array.from(el.labels).map((l) => l.textContent).join(' '));
      if (text) return clip(text, 120);
    }
    for (const name of ['alt', 'title', 'placeholder']) {
      const value = el.getAttribute(name)?.trim();
      if (value) return clip(value, 120);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return undefined;
    if (role && !NAMED_BY_CONTENT.has(role)) return undefined;
    const text = squash(el.textContent);
    return text ? clip(text, 120) : undefined;
  };
  const STYLES = ['display', 'position', 'box-sizing', 'width', 'height', 'margin', 'padding', 'border', 'border-radius',
    'gap', 'flex-direction', 'justify-content', 'align-items', 'grid-template-columns', 'color', 'background-color',
    'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'overflow', 'opacity', 'z-index'];
  const SKIP_STYLE = new Set(['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'visible', 'static', 'start']);
  const describe = (el) => {
    const secret = sensitive(el);
    const attributes = {};
    for (const a of Array.from(el.attributes)) {
      if (a.name === 'value' && secret) continue;
      attributes[a.name] = clip(a.value, 200);
    }
    const computed = getComputedStyle(el);
    const styles = {};
    for (const name of STYLES) {
      const value = computed.getPropertyValue(name);
      if (value && !SKIP_STYLE.has(value)) styles[name] = value;
    }
    const clone = el.cloneNode(true);
    for (const field of [clone, ...clone.querySelectorAll('input, textarea')]) {
      if ((field.localName === 'input' || field.localName === 'textarea') && sensitive(field)) {
        field.removeAttribute('value');
        if (field.localName === 'textarea') field.textContent = '';
      }
    }
    const html = clone.outerHTML;
    const r = el.getBoundingClientRect();
    const ancestors = [];
    for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement && ancestors.length < 5; node = node.parentElement) {
      ancestors.push(label(node));
    }
    const role = el.getAttribute('role') || implicitRole(el);
    const name = nameFor(el, role);
    const info = { selector: selectorFor(el), tag: el.localName, url: location.href, attributes };
    if (role) info.role = role;
    if (name) info.name = name;
    if (!secret && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && el.value) info.value = clip(el.value, 200);
    if (secret) info.redacted = true;
    const text = el instanceof HTMLElement ? squash(el.innerText) : '';
    if (text && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) info.text = clip(text, 300);
    info.html = clip(html, 3000);
    if (html.length > 3000) info.htmlLength = html.length;
    info.box = { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) };
    info.styles = styles;
    info.ancestors = ancestors;
    info.matches = count(info.selector);
    return info;
  };

  const host = document.createElement('browse-pick');
  const root = host.attachShadow({ mode: 'closed' });
  const hostStyle = {
    all: 'initial', display: 'block', position: 'fixed', inset: '0', margin: '0', padding: '0', border: '0',
    'z-index': '2147483646', 'pointer-events': 'none', opacity: '1', transform: 'none', filter: 'none', visibility: 'visible',
  };
  const box = (color, fill) => {
    const b = document.createElement('div');
    imp(b, { position: 'fixed', display: 'none', 'box-sizing': 'border-box', border: `2px solid ${color}`, background: fill, 'pointer-events': 'none', 'border-radius': '2px' });
    return b;
  };
  const hover = box('#2563eb', 'rgba(37,99,235,.12)');
  const tip = document.createElement('div');
  imp(tip, {
    position: 'fixed', display: 'none', padding: '2px 6px', background: '#111827', color: '#ffffff', 'border-radius': '4px',
    font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace', 'white-space': 'nowrap', 'pointer-events': 'none',
    'max-width': '60vw', overflow: 'hidden', 'text-overflow': 'ellipsis',
  });
  const panel = document.createElement('div');
  imp(panel, {
    position: 'fixed', left: '16px', bottom: '16px', width: '320px', 'max-width': 'calc(100vw - 32px)', 'max-height': '45vh',
    overflow: 'auto', 'box-sizing': 'border-box', padding: '12px 14px', background: '#ffffff', color: '#111827',
    border: '1px solid #2563eb', 'border-radius': '10px', 'box-shadow': '0 8px 28px rgba(0,0,0,.28)', 'pointer-events': 'auto',
    font: '13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif', 'text-align': 'left',
  });
  const heading = document.createElement('div');
  heading.textContent = 'Click the elements you mean';
  imp(heading, { 'font-weight': '600', color: '#2563eb', 'margin-bottom': '4px' });
  const hint = document.createElement('div');
  hint.textContent = 'Clicks pick elements instead of using the page. Add a note to each, then click Continue.';
  imp(hint, { color: '#4b5563', 'margin-bottom': '8px' });
  const list = document.createElement('div');
  const field = (placeholder, rows) => {
    const t = document.createElement('textarea');
    t.rows = rows;
    t.placeholder = placeholder;
    imp(t, {
      display: 'block', width: '100%', 'box-sizing': 'border-box', margin: '4px 0 0', padding: '4px 6px', resize: 'vertical',
      font: 'inherit', color: '#111827', background: '#ffffff', border: '1px solid #d1d5db', 'border-radius': '6px',
    });
    return t;
  };
  const overall = field('Note for all of them (optional)', 2);
  overall.addEventListener('input', () => { general = overall.value; changed(); });
  panel.append(heading, hint, list, overall);
  const layer = document.createElement('div');
  root.append(layer, hover, tip, panel);

  const renderList = () => {
    list.replaceChildren();
    picks.forEach((pick, i) => {
      const item = document.createElement('div');
      imp(item, { margin: '0 0 8px', 'padding-bottom': '8px', 'border-bottom': '1px solid #e5e7eb' });
      const row = document.createElement('div');
      imp(row, { display: 'flex', gap: '6px', 'align-items': 'center' });
      const badge = document.createElement('span');
      badge.textContent = String(i + 1);
      imp(badge, { background: '#f59e0b', color: '#111827', 'border-radius': '9px', padding: '0 6px', 'font-weight': '600' });
      const name = document.createElement('span');
      name.textContent = clip(label(pick.element), 40) + (pick.element.isConnected ? '' : ' (gone from the page)');
      imp(name, { flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', font: '12px ui-monospace, SFMono-Regular, Menlo, monospace' });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = 'Remove';
      imp(remove, { font: 'inherit', cursor: 'pointer', border: '0', background: 'transparent', color: '#6b7280', padding: '0 4px' });
      remove.addEventListener('click', () => { picks.splice(picks.indexOf(pick), 1); renderList(); changed(); });
      row.append(badge, name, remove);
      const note = field('What about it?', 1);
      note.value = pick.note;
      note.addEventListener('input', () => { pick.note = note.value; changed(); });
      pick.input = note;
      item.append(row, note);
      list.append(item);
    });
    while (layer.children.length > picks.length) layer.lastChild.remove();
    while (layer.children.length < picks.length) {
      const b = box('#f59e0b', 'rgba(245,158,11,.10)');
      const n = document.createElement('span');
      imp(n, { position: 'absolute', left: '-2px', top: '-20px', background: '#f59e0b', color: '#111827', padding: '0 5px', 'border-radius': '4px', font: '600 12px/18px system-ui, sans-serif' });
      b.append(n);
      layer.append(b);
    }
    Array.from(layer.children).forEach((b, i) => { b.firstChild.textContent = String(i + 1); });
  };
  const place = (b, el) => {
    const r = el.isConnected ? el.getBoundingClientRect() : null;
    if (!r || (r.width === 0 && r.height === 0)) { imp(b, { display: 'none' }); return null; }
    imp(b, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    return r;
  };
  let hovered = null;
  let frame = 0;
  // Last in <html>, but before browse's handoff card: it takes a click only while it is the last child.
  const placeHost = () => {
    const el = document.documentElement;
    if (!el) return;
    const card = Array.from(el.children).find((c) => c.localName === 'browse-handoff');
    if (card) {
      if (host.parentNode !== el || !(host.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)) el.insertBefore(host, card);
    } else if (host.parentNode !== el || host.nextSibling !== null) {
      el.appendChild(host);
    }
  };
  const draw = () => {
    frame = requestAnimationFrame(draw);
    placeHost();
    imp(host, hostStyle);
    picks.forEach((pick, i) => { const b = layer.children[i]; if (b) place(b, pick.element); });
    const r = hovered ? place(hover, hovered) : null;
    if (!r) { imp(tip, { display: 'none' }); imp(hover, { display: 'none' }); return; }
    tip.textContent = `${clip(label(hovered), 60)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    imp(tip, { display: 'block', left: Math.max(0, r.left) + 'px', top: (r.top >= 24 ? r.top - 22 : r.bottom + 4) + 'px' });
  };

  // The extension's card host as raise() in src/content/page-status.ts leaves it: an empty div in <html> whose only
  // attribute is popover="manual", its card in a closed shadow root.
  const extensionCard = (node) => node.localName === 'div' && node.parentNode === document.documentElement
    && node.getAttributeNames().join() === 'popover' && node.getAttribute('popover') === 'manual'
    && node.childNodes.length === 0 && node.shadowRoot === null;
  // The card the user continues with (browse's own, or the extension's) and this overlay keep working.
  const ours = (event) => event.composedPath().some((node) => node === host
    || (node instanceof Element && (node.localName === 'browse-handoff' || extensionCard(node))));
  // Keys typed into the notes don't go on to the page's own key listeners (those it added earlier on window still run).
  const KEYS = ['keydown', 'keyup', 'keypress'];
  const keepKeys = (event) => { if (event.composedPath().includes(host)) event.stopImmediatePropagation(); };
  const targetOf = (event) => event.composedPath().find((node) => node instanceof Element && node.getRootNode() === document && node !== document.documentElement) || null;
  const onMove = (event) => {
    if (ours(event)) { hovered = null; return; }
    hovered = targetOf(event);
  };
  const onLeave = (event) => { if (!event.relatedTarget) hovered = null; };
  const swallow = (event) => {
    if (ours(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== 'click' || !event.isTrusted || event.button !== 0) return;
    const el = targetOf(event);
    if (!el) return;
    const existing = picks.find((pick) => pick.element === el);
    if (existing) { existing.input?.focus(); return; }
    if (picks.length >= maxPicks) return;
    picks.push({ element: el, note: '', info: describe(el) });
    renderList();
    changed();
    picks[picks.length - 1].input?.focus();
  };
  const SWALLOWED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick'];
  for (const type of SWALLOWED) addEventListener(type, swallow, true);
  addEventListener('pointermove', onMove, true);
  for (const type of KEYS) addEventListener(type, keepKeys, true);
  document.addEventListener('mouseout', onLeave, true);
  renderList();
  draw();

  const cleanup = () => {
    for (const type of SWALLOWED) removeEventListener(type, swallow, true);
    removeEventListener('pointermove', onMove, true);
    for (const type of KEYS) removeEventListener(type, keepKeys, true);
    document.removeEventListener('mouseout', onLeave, true);
    cancelAnimationFrame(frame);
    host.remove();
    const current = g.__browsePick;
    if (current?.id === pickerId) { delete g.__browsePick; current.wake?.(); }
  };
  const snapshot = () => ({
    doc, version, note: general,
    elements: picks.map((pick) => ({ ...pick.info, note: pick.note, ...(pick.element.isConnected ? {} : { gone: true }) })),
  });
  g.__browsePick = { id: pickerId, doc, cleanup, snapshot, version: () => version };
  return doc;
}"##;

/// Returns the picks once they changed since `seen` (or after `waitMs` regardless); null without this picker.
const TAKE: &str = r#"/*browse-pick:take*/(pickerId, seen, waitMs) => {
  const state = globalThis.__browsePick;
  if (!state || state.id !== pickerId) return Promise.resolve(null);
  if (state.version() !== seen || waitMs <= 0) return Promise.resolve(state.snapshot());
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); state.wake = undefined; resolve(globalThis.__browsePick === state ? state.snapshot() : null); };
    const timer = setTimeout(done, waitMs);
    state.wake = done;
  });
}"#;

const REMOVE: &str = r#"/*browse-pick:remove*/(pickerId) => { const state = globalThis.__browsePick; if (state?.id === pickerId) state.cleanup(); }"#;

/// What each document the user picked in last reported, in the order the documents were first seen.
#[derive(Default)]
struct Picks {
    docs: Vec<(String, Value)>,
}

impl Picks {
    fn update(&mut self, snapshot: Value) {
        let Some(doc) = snapshot["doc"].as_str().map(str::to_string) else { return };
        match self.docs.iter_mut().find(|(key, _)| *key == doc) {
            Some((_, last)) => *last = snapshot,
            None => self.docs.push((doc, snapshot)),
        }
    }

    /// Every picked element, numbered in order, and the notes for all of them.
    fn result(&self) -> (Vec<Value>, String) {
        let mut elements = Vec::new();
        let mut notes = Vec::new();
        for (_, snapshot) in &self.docs {
            for element in snapshot["elements"].as_array().into_iter().flatten() {
                if !element.is_object() || !element["selector"].is_string() {
                    continue;
                }
                let mut element = element.clone();
                element["index"] = json!(elements.len() + 1);
                elements.push(element);
            }
            if let Some(note) = snapshot["note"].as_str().map(str::trim).filter(|n| !n.is_empty()) {
                notes.push(note.to_string());
            }
        }
        (elements, notes.join("\n"))
    }
}

/// One line for a picked element: its number, role and name, selector and the user's note.
pub fn describe_element(element: &Value) -> String {
    let index = element["index"].as_u64().unwrap_or(0);
    let selector = element["selector"].as_str().unwrap_or("");
    let what = match (element["role"].as_str(), element["name"].as_str()) {
        (Some(role), Some(name)) => format!("{role} {name:?}"),
        (Some(role), None) => role.to_string(),
        (None, Some(name)) => format!("{} {name:?}", element["tag"].as_str().unwrap_or("element")),
        (None, None) => element["tag"].as_str().unwrap_or("element").to_string(),
    };
    let mut line = format!("{index}. {what} ({selector})");
    if element["matches"].as_u64().is_some_and(|m| m != 1) {
        line.push_str(&format!(" [selector matches {}]", element["matches"]));
    }
    if element["gone"] == true {
        line.push_str(" [no longer on the page]");
    }
    match element["note"].as_str().map(str::trim).filter(|n| !n.is_empty()) {
        Some(note) => line.push_str(&format!(": {note}")),
        None => line.push_str(": (no note)"),
    }
    line
}

struct Picker {
    driver: Arc<dyn TabDriver>,
    id: String,
    picks: Arc<Mutex<Picks>>,
    realm: Mutex<Option<Realm>>,
    pumps: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl Picker {
    async fn take(&self, realm: &Realm, seen: i64, wait_ms: u64) -> Option<Value> {
        let take = format!("({TAKE})({}, {seen}, {wait_ms})", json!(self.id));
        let opts = CallOptions { returns: Returns::Json, await_promise: true, user_activation: false };
        match self.driver.evaluate(realm, &take, opts).await {
            Ok(Ok(Evaluated::Json(value))) if value.is_object() => Some(value),
            _ => None,
        }
    }

    async fn install(self: &Arc<Self>, frame: FrameId) {
        let realm = Realm { frame, world: World::Isolated };
        let expr = format!("({INSTALL})({}, {MAX_PICKS})", json!(self.id));
        let opts = CallOptions { returns: Returns::Json, await_promise: false, user_activation: false };
        if !matches!(self.driver.evaluate(&realm, &expr, opts).await, Ok(Ok(_))) {
            return;
        }
        *self.realm.lock().unwrap() = Some(realm.clone());
        let picker = self.clone();
        let pump = tokio::spawn(async move {
            let mut seen = -1;
            while let Some(snapshot) = picker.take(&realm, seen, 15_000).await {
                seen = snapshot["version"].as_i64().unwrap_or(-1);
                picker.picks.lock().unwrap().update(snapshot);
            }
        });
        self.pumps.lock().unwrap().push(pump);
    }

    async fn stop(&self) {
        let realm = self.realm.lock().unwrap().clone();
        if let Some(realm) = realm {
            if let Some(snapshot) = self.take(&realm, -1, 0).await {
                self.picks.lock().unwrap().update(snapshot);
            }
            let remove = format!("({REMOVE})({})", json!(self.id));
            let opts = CallOptions { returns: Returns::Json, await_promise: false, user_activation: false };
            let _ = self.driver.evaluate(&realm, &remove, opts).await;
        }
        let mut pumps: Vec<_> = std::mem::take(&mut *self.pumps.lock().unwrap());
        let _ = tokio::time::timeout(Duration::from_secs(2), futures_util::future::join_all(pumps.iter_mut())).await;
        for pump in pumps {
            pump.abort();
        }
    }
}

/// Asks the user to click the elements they mean in the tab, with a note for each, until they continue.
pub async fn pick(relay: &Arc<Relay>, tab: i64, message: &str, timeout: Duration) -> anyhow::Result<Value> {
    let browser = RelayBrowser(relay.clone());
    let driver = browser.tab_driver(tab).await?;
    let picker = Arc::new(Picker {
        driver: driver.clone(),
        id: format!("pick-{}", crate::util::random_hex(6)),
        picks: Arc::new(Mutex::new(Picks::default())),
        realm: Mutex::new(None),
        pumps: Mutex::new(Vec::new()),
    });
    let mut events = driver.events();
    let main_frame = driver.frames().await?.first().map(|f| f.id.clone());
    if let Some(frame) = main_frame.clone() {
        picker.install(frame).await;
    }
    let watcher = {
        let picker = picker.clone();
        tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                if let PageEvent::Committed { frame, .. } = event
                    && main_frame.as_ref() == Some(&frame)
                {
                    picker.install(frame).await;
                }
            }
        })
    };
    let message = if message.trim().is_empty() { "Click the elements you mean, add a note to each, then click Continue" } else { message };
    let outcome = relay.run_handoff(tab, message, timeout).await;
    watcher.abort();
    picker.stop().await;
    let outcome = outcome?;
    let (elements, note) = picker.picks.lock().unwrap().result();
    let url = relay.st().tabs.get(&tab).map(|t| t.url.clone()).unwrap_or_default();
    let summary: Vec<String> = elements.iter().map(describe_element).collect();
    let mut result = json!({ "outcome": outcome.outcome, "url": url, "elements": elements, "summary": summary });
    if !note.is_empty() {
        result["note"] = json!(note);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_elements_across_documents_and_keeps_the_latest_report() {
        let mut picks = Picks::default();
        picks.update(json!({ "doc": "a", "version": 1, "note": "", "elements": [{ "selector": "#one", "tag": "nav" }] }));
        picks.update(json!({ "doc": "a", "version": 2, "note": " all ", "elements": [{ "selector": "#one", "tag": "nav", "note": "fix" }, { "selector": "button.save", "tag": "button" }] }));
        picks.update(json!({ "doc": "b", "version": 1, "note": "", "elements": [{ "selector": "h2", "tag": "h2" }, { "tag": "broken" }] }));
        picks.update(json!({ "version": 3, "elements": [{ "selector": "ignored" }] }));
        let (elements, note) = picks.result();
        let selectors: Vec<_> = elements.iter().map(|e| (e["index"].as_u64().unwrap(), e["selector"].as_str().unwrap())).collect();
        assert_eq!(selectors, vec![(1, "#one"), (2, "button.save"), (3, "h2")]);
        assert_eq!(elements[0]["note"], "fix");
        assert_eq!(note, "all");
    }

    #[test]
    fn describes_an_element_with_its_note() {
        let element = json!({ "index": 2, "selector": "button.save", "tag": "button", "role": "button", "name": "Save", "matches": 1, "note": " smaller " });
        assert_eq!(describe_element(&element), "2. button \"Save\" (button.save): smaller");
        let element = json!({ "index": 1, "selector": "div.card", "tag": "div", "matches": 3, "gone": true });
        assert_eq!(describe_element(&element), "1. div (div.card) [selector matches 3] [no longer on the page]: (no note)");
    }
}
