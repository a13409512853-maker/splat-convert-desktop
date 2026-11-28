// Dual-Stack Bottom-Center Context Toolbar Host (Max 2 Bars, In-Place Zero-Flash Updates — rc8 #4c & rc12 #2.1).
// Owns #context-bar-stack DOM lifecycle, standing/temporary Ctrl/Alt boolean op highlight, and boolean buttons.
import { BOOL_OPS } from "../constants.js";

export class ContextBarHost {
  constructor({ rootEl, statefulBoolTools, getActiveTool, getActiveBoolOp, bindTip }) {
    this.rootEl = rootEl;
    this.statefulBoolTools = statefulBoolTools;
    this.getActiveTool = getActiveTool;
    this.getActiveBoolOp = getActiveBoolOp;
    this.bindTip = bindTip;
    this.bars = []; // ordered oldest -> newest: { category, key, renderFn, el, needsEnterAnim }
    this.tempModifierBoolOp = null;
  }

  get count() {
    return this.bars.length;
  }

  set(category, renderFn, key = null) {
    const barKey = key || `${category}:${this.getActiveTool()}`;
    const idx = this.bars.findIndex((b) => b.category === category);
    if (idx >= 0 && renderFn) {
      const existing = this.bars[idx];
      const sameIdentity = existing.key === barKey && existing.el && existing.el.isConnected;
      existing.key = barKey;
      existing.renderFn = renderFn;
      if (sameIdentity) {
        // Update contents IN-PLACE with ZERO animation replay / flash (#4c)!
        existing.el.innerHTML = "";
        renderFn(existing.el);
        return;
      }
      this.bars.splice(idx, 1);
    } else if (idx >= 0) {
      this.bars.splice(idx, 1);
    }
    if (renderFn) {
      this.bars.push({ category, key: barKey, renderFn, el: null, needsEnterAnim: true });
      while (this.bars.length > 2) this.bars.shift();
    }
    this.render();
  }

  clear(category) {
    const idx = this.bars.findIndex((b) => b.category === category);
    if (idx >= 0) {
      this.bars.splice(idx, 1);
      this.render();
    }
  }

  clearAll() {
    this.bars.length = 0;
    this.render();
  }

  render() {
    const root = this.rootEl;
    if (!root) return;
    const keepSet = new Set();
    for (const bar of this.bars) {
      let el = bar.el;
      if (!el) {
        el = document.createElement("div");
        el.className = "context-bar";
        el.dataset.category = bar.category;
        el.dataset.barKey = bar.key;
        bar.el = el;
      }
      el.innerHTML = "";
      bar.renderFn(el);
      if (bar.needsEnterAnim) {
        bar.needsEnterAnim = false;
        el.classList.add("ctx-bar-enter");
        el.addEventListener("animationend", () => el.classList.remove("ctx-bar-enter"), { once: true });
      }
      keepSet.add(el);
      if (el.parentElement !== root) {
        root.appendChild(el);
      }
    }
    for (const child of Array.from(root.children)) {
      if (!keepSet.has(child)) child.remove();
    }
  }

  getEffectiveBoolOp(e = null) {
    if (e) {
      const ctrl = !!(e.ctrlKey || e.metaKey);
      const alt = !!e.altKey;
      if (ctrl && alt) return "intersect";
      if (ctrl) return "add";
      if (alt) return "subtract";
      return this.getActiveBoolOp();
    }
    return this.tempModifierBoolOp || this.getActiveBoolOp();
  }

  syncTempModifierBoolUI(e = null) {
    let nextTemp = null;
    if (e) {
      const ctrl = !!(e.ctrlKey || e.metaKey);
      const alt = !!e.altKey;
      if (ctrl && alt) nextTemp = "intersect";
      else if (ctrl) nextTemp = "add";
      else if (alt) nextTemp = "subtract";
    }
    if (nextTemp === this.tempModifierBoolOp) return;
    this.tempModifierBoolOp = nextTemp;
    if (!this.statefulBoolTools.has(this.getActiveTool())) return;
    const eff = this.getEffectiveBoolOp();
    const standing = this.getActiveBoolOp();
    const btns = document.querySelectorAll('#context-bar-stack .context-bar[data-stateful-bool="1"] button[data-bool-op]');
    for (const b of btns) {
      const isAct = b.dataset.boolOp === eff;
      b.classList.toggle("active", isAct);
      b.classList.toggle("temp-override", isAct && !!this.tempModifierBoolOp && this.tempModifierBoolOp !== standing);
    }
  }

  buildBoolButtons(container, activeVal, onPick, executeImmediate = false) {
    if (!executeImmediate && container) {
      container.dataset.statefulBool = "1";
    }
    const standing = this.getActiveBoolOp();
    const grp = document.createElement("div");
    grp.className = "ctx-group";
    for (const op of BOOL_OPS) {
      const b = document.createElement("button");
      const isAct = !executeImmediate && activeVal === op.id;
      const isTemp = isAct && !!this.tempModifierBoolOp && this.tempModifierBoolOp !== standing;
      b.className = "mini-btn" + (isAct ? " active" : "") + (isTemp ? " temp-override" : "");
      b.dataset.boolOp = op.id;
      b.textContent = op.label;
      this.bindTip(b, { title: op.label, tip: op.desc, region: "toolbar", placement: "top" });
      b.onclick = () => onPick(op.id);
      grp.appendChild(b);
    }
    container.appendChild(grp);
  }
}
