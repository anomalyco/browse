import { ghostCursorClientVersion } from "./types.ts"

// Second half of ghostCursorClientSource: camera zoom, spotlight, key badges, captions, callouts, and global binding.
export const ghostCursorOverlaysSource = `  const zoomTo = (payload) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const S = clamp(typeof payload?.scale === "number" ? payload.scale : 1, 1, 3.2);
    const durationMs = clamp(typeof payload?.durationMs === "number" ? payload.durationMs : 360, 80, 1200);
    const fx0 = (vw / 2 - state.camera.tx) / state.camera.scale;
    const fy0 = (vh / 2 - state.camera.ty) / state.camera.scale;
    let fx1 = vw / 2;
    let fy1 = vh / 2;
    if (payload?.rect && S > 1.001) {
      const cx = payload.rect.x + payload.rect.width / 2;
      const cy = payload.rect.y + payload.rect.height / 2;
      const ux = (cx - state.camera.tx) / state.camera.scale;
      const uy = (cy - state.camera.ty) / state.camera.scale;
      const halfVisW = (vw * 0.5) / S;
      const halfVisH = (vh * 0.5) / S;
      fx1 = clamp(ux, halfVisW, vw - halfVisW);
      fy1 = clamp(uy, halfVisH, vh - halfVisH);
    }
    const cursorPageX = (state.renderedX - state.camera.tx) / state.camera.scale;
    const cursorPageY = (state.renderedY - state.camera.ty) / state.camera.scale;
    return new Promise((resolve) => {
      state.cameraAnim = {
        startTime: performance.now(),
        durationMs,
        logS0: Math.log(Math.max(1, state.camera.scale)),
        logS1: Math.log(S),
        fx0,
        fy0,
        fx1,
        fy1,
        cursorPageX,
        cursorPageY,
        resolve,
      };
      state.activeUntil = performance.now() + durationMs + 60;
      startLoop();
    });
  };

  const setSpotlight = (payload) => {
    const stage = ensureStage();
    if (!payload?.rect) {
      if (!state.spotlight) return Promise.resolve();
      const sp = state.spotlight;
      return new Promise((resolve) => {
        state.spotlightAnim = {
          startTime: performance.now(),
          durationMs: 200,
          x0: sp.x, y0: sp.y, w0: sp.w, h0: sp.h, a0: sp.alpha,
          x1: sp.x, y1: sp.y, w1: sp.w, h1: sp.h, a1: 0,
          resolve,
        };
        state.activeUntil = performance.now() + 240;
        startLoop();
      });
    }
    const pad = typeof payload.options?.padding === "number" ? payload.options.padding : 10;
    const dim = typeof payload.options?.dim === "number" ? payload.options.dim : 0.56;
    const toneColor = tones[payload.options?.tone] || tones.neutral;
    const x1 = payload.rect.x - pad;
    const y1 = payload.rect.y - pad;
    const w1 = payload.rect.width + pad * 2;
    const h1 = payload.rect.height + pad * 2;

    if (!state.spotlight) {
      const container = document.createElement("div");
      container.id = spotlightId;
      container.style.cssText = "position:fixed;inset:0;pointer-events:none;";
      const hole = document.createElement("div");
      const chip = document.createElement("div");
      container.append(hole, chip);
      stage.appendChild(container);
      state.spotlight = {
        el: container,
        hole,
        chip,
        x: x1, y: y1, w: w1, h: h1,
        alpha: 0,
        dim,
        toneColor,
        label: "",
        render() {
          const sp = this;
          sp.hole.style.cssText = [
            "position:fixed",
            "left:" + formatCoord(sp.x) + "px",
            "top:" + formatCoord(sp.y) + "px",
            "width:" + formatCoord(sp.w) + "px",
            "height:" + formatCoord(sp.h) + "px",
            "border-radius:10px",
            "border:2px solid " + sp.toneColor,
            "box-shadow:0 0 0 9999px rgba(8, 8, 10, " + formatCoord(sp.dim * sp.alpha) + "), 0 0 28px rgba(224,179,90," + formatCoord(0.26 * sp.alpha) + ")",
            "opacity:" + formatCoord(sp.alpha),
            "box-sizing:border-box",
          ].join(";");
          if (sp.label) {
            styleChipAtRect(sp.chip, sp.x, sp.y, sp.h, sp.alpha);
          }
        },
      };
    }
    const sp = state.spotlight;
    sp.dim = dim;
    sp.toneColor = toneColor;
    sp.label = payload.options?.label || "";
    populateChip(sp.chip, toneColor, sp.label, payload.options?.detail);

    return new Promise((resolve) => {
      state.spotlightAnim = {
        startTime: performance.now(),
        durationMs: 240,
        x0: sp.x, y0: sp.y, w0: sp.w, h0: sp.h, a0: sp.alpha,
        x1, y1, w1, h1, a1: 1,
        resolve,
      };
      state.activeUntil = performance.now() + 270;
      startLoop();
    });
  };

  const showKeys = (payload) => {
    if (!payload?.keys?.length) return;
    const stage = ensureStage();
    root?.getElementById(keysId)?.remove();
    if (state.keysTimer !== undefined) window.clearTimeout(state.keysTimer);
    const badge = document.createElement("div");
    badge.id = keysId;
    badge.style.cssText = [
      "position:fixed",
      "right:28px",
      "bottom:24px",
      "display:inline-flex",
      "align-items:center",
      "gap:6px",
      "padding:7px 11px",
      "background:rgba(16, 16, 15, 0.92)",
      "backdrop-filter:blur(14px)",
      "-webkit-backdrop-filter:blur(14px)",
      "border:1px solid rgba(255,255,255,0.14)",
      "border-radius:10px",
      "box-shadow:0 12px 28px rgba(0,0,0,0.38)",
      "color:#f4f3ef",
    ].join(";");
    for (const k of payload.keys) {
      const kbd = document.createElement("kbd");
      kbd.textContent = k;
      kbd.style.cssText = [
        "display:inline-flex",
        "align-items:center",
        "justify-content:center",
        "min-width:22px",
        "height:22px",
        "padding:0 6px",
        "font-family:ui-monospace,SFMono-Regular,Menlo,monospace",
        "font-size:12px",
        "font-weight:600",
        "color:#fafafa",
        "background:rgba(255,255,255,0.11)",
        "border:1px solid rgba(255,255,255,0.2)",
        "border-bottom-width:2px",
        "border-radius:5px",
      ].join(";");
      badge.appendChild(kbd);
    }
    if (payload.label) {
      const lbl = document.createElement("span");
      lbl.textContent = payload.label;
      lbl.style.cssText = "font-size:12px;font-weight:500;color:#a1a1aa;margin-left:4px;";
      badge.appendChild(lbl);
    }
    stage.appendChild(badge);
    state.keysTimer = window.setTimeout(() => {
      badge.remove();
      state.keysTimer = undefined;
      releaseRoot();
    }, 1500);
  };

  const setCaption = (payload) => {
    const existing = root?.getElementById(captionId);
    if (!payload || !payload.title) {
      if (existing) existing.remove();
      releaseRoot();
      return;
    }
    const stage = ensureStage();
    if (existing) existing.remove();
    const wrap = document.createElement("div");
    wrap.id = captionId;
    wrap.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:24px",
      "transform:translate3d(-50%, 0, 0)",
      "display:flex",
      "align-items:stretch",
      "gap:12px",
      "padding:10px 16px 10px 12px",
      "background:rgba(14, 14, 13, 0.88)",
      "backdrop-filter:blur(14px)",
      "-webkit-backdrop-filter:blur(14px)",
      "border:1px solid rgba(255, 255, 255, 0.12)",
      "border-radius:10px",
      "box-shadow:0 12px 32px rgba(0, 0, 0, 0.35)",
      "color:#e2dfd9",
      "pointer-events:none",
      "max-width:min(680px, 88vw)",
    ].join(";");
    const barColor = tones[payload.options?.tone] || tones.neutral;
    const bar = document.createElement("div");
    bar.style.cssText = "width:3.5px;border-radius:999px;background:" + barColor + ";";
    const textCol = document.createElement("div");
    textCol.style.cssText = "display:flex;flex-direction:column;justify-content:center;gap:2px;overflow:hidden;";
    const titleRow = document.createElement("div");
    titleRow.style.cssText = "display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;letter-spacing:-0.01em;color:#f4f3ef;white-space:nowrap;";
    if (payload.options?.step) {
      const stepBadge = document.createElement("span");
      stepBadge.textContent = payload.options.step;
      stepBadge.style.cssText = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;background:rgba(255,255,255,0.09);color:" + barColor + ";";
      titleRow.appendChild(stepBadge);
    }
    const titleSpan = document.createElement("span");
    titleSpan.textContent = payload.title;
    titleRow.appendChild(titleSpan);
    textCol.appendChild(titleRow);
    if (payload.options?.subtitle) {
      const sub = document.createElement("div");
      sub.textContent = payload.options.subtitle;
      sub.style.cssText = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      textCol.appendChild(sub);
    }
    wrap.append(bar, textCol);
    stage.appendChild(wrap);
  };
  const clearCallouts = () => {
    const stage = root?.getElementById(stageId);
    if (!stage) return;
    for (const node of Array.from(stage.querySelectorAll("[data-bc-callout='true']"))) {
      node.remove();
    }
    releaseRoot();
  };
  const showCallout = (payload) => {
    if (!payload?.rect) return;
    clearCallouts();
    const stage = ensureStage();
    const toneColor = tones[payload.options?.tone] || tones.neutral;
    const { x, y, width, height } = payload.rect;
    const container = document.createElement("div");
    container.dataset.bcCallout = "true";
    container.style.cssText = "position:fixed;inset:0;pointer-events:none;";

    const ring = document.createElement("div");
    ring.style.cssText = [
      "position:fixed",
      "left:" + formatCoord(x - 4) + "px",
      "top:" + formatCoord(y - 4) + "px",
      "width:" + formatCoord(width + 8) + "px",
      "height:" + formatCoord(height + 8) + "px",
      "border-radius:8px",
      "border:1.75px solid " + toneColor,
      "box-shadow:0 0 0 1px rgba(14,14,13,0.5), 0 0 20px rgba(224,179,90,0.22)",
      "box-sizing:border-box",
    ].join(";");

    const chip = document.createElement("div");
    populateChip(chip, toneColor, payload.label, payload.options?.detail);
    styleChipAtRect(chip, x, y, height, 1);
    container.append(ring, chip);
    stage.appendChild(container);
  };
  globalThis.__opencodeBrowserGhostCursor = {
    version: ${ghostCursorClientVersion},
    show,
    hide,
    restore,
    applyMouseEvent,
    setCaption,
    showCallout,
    clearCallouts,
    zoomTo,
    setSpotlight,
    showKeys,
    isVisible: () => state.mode !== "disabled" && Boolean(state.element),
  };
})();`
