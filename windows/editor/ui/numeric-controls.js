/**
 * @module ui/numeric-controls
 * @description Global Editor UI Norm Module (3.2.3-rc12):
 * 1. Horizontal Mouse-Drag Scrubbing on ALL <input type="number"> controls (left = smaller, right = larger;
 *    Shift = 0.1x precision, Alt = 10x coarse; plain click <3px focuses input for direct typing).
 * 2. Click-to-Edit Inline Numeric Input on ALL <input type="range"> controls (clicking the adjacent numeric
 *    readout span/output opens a sleek .cr-val-input box; live-applies on input, commits on Enter/blur,
 *    auto-hides on outside click, Escape reverts).
 */

function clampVal(v, min, max) {
  let out = v;
  if (Number.isFinite(min)) out = Math.max(min, out);
  if (Number.isFinite(max)) out = Math.min(max, out);
  return out;
}

function decimalsFromStep(step) {
  if (!Number.isFinite(step) || step <= 0) return 2;
  const s = String(step);
  const idx = s.indexOf(".");
  if (idx < 0) return 0;
  return Math.min(5, s.length - idx - 1);
}

function roundToStep(val, step) {
  if (!Number.isFinite(step) || step <= 0) return Number(val.toFixed(3));
  const dec = decimalsFromStep(step);
  const snapped = Math.round(val / step) * step;
  return Number(snapped.toFixed(dec));
}

function parseBoundsAndStep(input) {
  const min = input.min !== "" && input.min != null ? Number(input.min) : -Infinity;
  const max = input.max !== "" && input.max != null ? Number(input.max) : Infinity;
  let step = input.step && input.step !== "any" ? Number(input.step) : NaN;
  if (!Number.isFinite(step) || step <= 0) {
    const cur = Math.abs(Number(input.value) || 0);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      const span = max - min;
      step = span <= 2 ? 0.01 : span <= 20 ? 0.05 : span <= 400 ? 1 : Math.max(1, Math.round(span / 200));
    } else {
      step = cur >= 100 ? 1 : 0.05;
    }
  }
  return { min, max, step };
}

function resolveScrubInputFromTarget(target) {
  if (!(target instanceof Element)) return null;
  if (target.matches('input[type="number"]')) {
    return target.disabled || target.readOnly ? null : target;
  }
  // Allow scrubbing from axis-in label (e.g. "X" / "Y" / "Z") or ctx-param label text next to <input type="number">
  const lbl = target.closest("label.axis-in, label.ctx-param, label.cw-rgb-field");
  if (lbl && !target.matches('input[type="range"], input[type="checkbox"], button, select')) {
    const inp = lbl.querySelector('input[type="number"]');
    if (inp && !inp.disabled && !inp.readOnly) return inp;
  }
  return null;
}

let _scrubInstalled = false;

/**
 * Install global horizontal drag scrubbing for EVERY <input type="number"> in the editor.
 * Dragging left decreases value; dragging right increases value. Clicking (<3px) focuses for direct typing.
 */
export function installGlobalNumericScrub(root = document.body) {
  if (_scrubInstalled || !root) return;
  _scrubInstalled = true;

  let activeScrub = null;

  root.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;
      const input = resolveScrubInputFromTarget(e.target);
      if (!input) return;
      // If user already focused this input to select/edit text inside it directly, allow normal caret selection
      // unless they started dragging on the label prefix outside the input.
      if (document.activeElement === input && e.target === input) return;

      const { min, max, step } = parseBoundsAndStep(input);
      const startVal = Number.isFinite(Number(input.value)) ? Number(input.value) : 0;
      const pxPerStep = Number(input.dataset.scrubPxPerStep) || (step >= 1 ? 3.5 : 4.0);

      activeScrub = {
        input,
        pointerId: e.pointerId,
        startX: e.clientX,
        startVal,
        lastVal: startVal,
        min,
        max,
        step,
        pxPerStep,
        dragging: false,
        startedOnInput: e.target === input,
      };
    },
    true,
  );

  window.addEventListener(
    "pointermove",
    (e) => {
      if (!activeScrub) return;
      const dx = e.clientX - activeScrub.startX;
      if (!activeScrub.dragging) {
        if (Math.abs(dx) < 3) return;
        activeScrub.dragging = true;
        document.body.classList.add("num-scrubbing");
        // Cancel accidental focus/selection started on pointerdown
        if (document.activeElement === activeScrub.input) {
          activeScrub.input.blur();
        }
        try {
          window.getSelection()?.removeAllRanges();
        } catch {
          /* ignore */
        }
      }

      e.preventDefault();
      let mult = 1;
      if (e.shiftKey) mult = 0.1;
      else if (e.altKey) mult = 10;

      const deltaSteps = dx / activeScrub.pxPerStep;
      const effStep = activeScrub.step * mult;
      const raw = activeScrub.startVal + deltaSteps * effStep;
      const next = roundToStep(clampVal(raw, activeScrub.min, activeScrub.max), Math.min(activeScrub.step, effStep));

      if (next !== activeScrub.lastVal) {
        activeScrub.lastVal = next;
        activeScrub.input.value = String(next);
        activeScrub.input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },
    { passive: false },
  );

  const finishScrub = () => {
    if (!activeScrub) return;
    const sc = activeScrub;
    activeScrub = null;
    if (sc.dragging) {
      document.body.classList.remove("num-scrubbing");
      if (sc.lastVal !== sc.startVal) {
        sc.input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // Suppress trailing click focus ONLY on the scrubbed input itself (never swallow clicks on other controls!)
      const suppressClick = (ev) => {
        if (ev.target === sc.input || sc.input.parentElement?.contains(ev.target)) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      };
      window.addEventListener("click", suppressClick, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", suppressClick, { capture: true }), 45);
    }
  };

  window.addEventListener("pointerup", finishScrub);
  window.addEventListener("pointercancel", finishScrub);
  window.addEventListener("blur", finishScrub);
}

/**
 * Bind click-to-edit inline numeric input on a single range slider + its numeric readout element.
 * Handles percentage scaling (e.g. range 0..1 displaying "14%") and unit suffixes ("px", "m/s", "m", "%") automatically.
 */
export function enhanceSliderReadout(rangeEl, readoutEl, opts = {}) {
  if (!rangeEl || !readoutEl || readoutEl.dataset.sliderInlineBound === "1") return;
  readoutEl.dataset.sliderInlineBound = "1";
  readoutEl.classList.add("slider-val-editable");
  if (!readoutEl.dataset.tip) {
    readoutEl.title = opts.title || "";
  }

  let activeInput = null;

  const inferScaleAndFormat = () => {
    const txt = (readoutEl.textContent || "").trim();
    const min = Number(rangeEl.min);
    const max = Number(rangeEl.max);
    // Detect 0..1 range displayed as percentage (e.g. "14%", "100%")
    const isPctScaled =
      typeof opts.scale === "number"
        ? opts.scale === 100
        : txt.includes("%") && Number.isFinite(max) && max <= 1.05 && Number.isFinite(min) && min >= -1.05;
    const scale = typeof opts.scale === "number" ? opts.scale : isPctScaled ? 100 : 1;
    const suffixMatch = txt.match(/([a-zA-Z%/°]+(?:\s*\/\s*[a-zA-Z]+)?)$/);
    const suffix = typeof opts.suffix === "string" ? opts.suffix : suffixMatch ? suffixMatch[1] : "";
    return { scale, suffix };
  };

  const openInlineBox = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (rangeEl.disabled || activeInput) return;

    const { scale } = inferScaleAndFormat();
    const min = rangeEl.min !== "" ? Number(rangeEl.min) : -Infinity;
    const max = rangeEl.max !== "" ? Number(rangeEl.max) : Infinity;
    const step = rangeEl.step && rangeEl.step !== "any" ? Number(rangeEl.step) : 1;
    const beforeRangeVal = Number(rangeEl.value);
    const dispVal = Number((beforeRangeVal * scale).toFixed(scale === 100 ? 1 : decimalsFromStep(step)));

    const inp = document.createElement("input");
    inp.type = "text";
    inp.inputMode = "decimal";
    inp.className = "cr-val-input slider-inline-input";
    inp.value = String(dispVal);

    const rect = readoutEl.getBoundingClientRect();
    const targetW = Math.max(46, Math.min(82, Math.ceil(rect.width + 14)));
    inp.style.width = `${targetW}px`;

    activeInput = inp;
    readoutEl.classList.add("hidden");
    readoutEl.insertAdjacentElement("afterend", inp);

    // Emit pointerdown on range so commit-aware listeners (like LUT intensity history) capture before-state cleanly
    rangeEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));

    let finished = false;
    const applyTyped = () => {
      const cleaned = inp.value.replace(/[^\d.+\-eE]/g, "").trim();
      const parsed = Number(cleaned);
      if (!Number.isFinite(parsed)) return false;
      const nextRange = clampVal(parsed / scale, min, max);
      rangeEl.value = String(nextRange);
      rangeEl.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };

    const closeBox = (commit) => {
      if (finished) return;
      finished = true;
      activeInput = null;
      if (commit) {
        applyTyped();
        rangeEl.dispatchEvent(new Event("change", { bubbles: true }));
        rangeEl.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      } else {
        rangeEl.value = String(beforeRangeVal);
        rangeEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
      inp.remove();
      readoutEl.classList.remove("hidden");
    };

    inp.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    inp.addEventListener("click", (ev) => ev.stopPropagation());
    inp.addEventListener("input", () => {
      applyTyped();
    });
    inp.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        closeBox(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        closeBox(false);
      }
    });
    inp.addEventListener("blur", () => closeBox(true));

    inp.focus();
    inp.select();
  };

  readoutEl.addEventListener("click", openInlineBox);
  readoutEl.addEventListener("pointerdown", (e) => {
    // Prevent parent <label> from forwarding click back onto range slider thumb
    e.stopPropagation();
  });
}

function scanAndEnhanceSliders(container) {
  if (!container || !(container instanceof Element)) return;
  const ranges = container.matches('input[type="range"]')
    ? [container]
    : Array.from(container.querySelectorAll('input[type="range"]'));

  for (const rng of ranges) {
    // Color panel .cr-range rows already have dedicated .cr-val-text / .cr-val-input handlers
    if (rng.classList.contains("cr-range")) continue;
    let readout = null;
    const next = rng.nextElementSibling;
    if (next && (next.tagName === "SPAN" || next.tagName === "OUTPUT")) {
      readout = next;
    } else if (rng.parentElement) {
      readout = rng.parentElement.querySelector("output, span.ctx-val, span.fly-speed-val");
    }
    if (readout) {
      enhanceSliderReadout(rng, readout);
    }
  }
}

let _sliderObserver = null;

/**
 * Automatically attach click-to-edit inline numeric input to ALL current and dynamically created
 * <input type="range"> controls across the entire editor DOM.
 */
export function installGlobalSliderInlineInputs(root = document.body) {
  if (!root) return;
  scanAndEnhanceSliders(root);
  if (_sliderObserver) return;
  _sliderObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof Element) scanAndEnhanceSliders(node);
      }
    }
  });
  _sliderObserver.observe(root, { childList: true, subtree: true });
}
