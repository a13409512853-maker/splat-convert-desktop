// Global Delayed Tooltip System (single unified hover delay constant synced with C# TooltipConfig
// + per-region veteran switches: toolbar / scene / color / modals).
import { DEFAULT_TOOLTIP_DELAY_MS } from "./constants.js";

export class DelayedTooltipManager {
  constructor(delayMs = DEFAULT_TOOLTIP_DELAY_MS) {
    this.delayMs = Math.max(150, Number(delayMs) || DEFAULT_TOOLTIP_DELAY_MS);
    this.regionEnabled = {
      toolbar: true,
      scene: true,
      color: true,
      modals: true,
    };
    this._timer = null;
    this._activeEl = null;

    this.el = document.createElement("div");
    this.el.className = "global-delayed-tooltip";
    this.el.style.display = "none";
    document.body.appendChild(this.el);

    document.addEventListener("pointerover", (e) => this._onOver(e), true);
    document.addEventListener("pointerout", (e) => this._onOut(e), true);
    document.addEventListener("pointerdown", () => this.hide(), true);
    window.addEventListener("blur", () => this.hide());
  }

  configure(opts = {}) {
    if (typeof opts.delayMs === "number" && opts.delayMs >= 150) {
      this.delayMs = opts.delayMs;
    }
    if (opts.regions && typeof opts.regions === "object") {
      Object.assign(this.regionEnabled, opts.regions);
    }
  }

  _findTarget(node) {
    let cur = node;
    while (cur && cur !== document.body) {
      if (cur.dataset && cur.dataset.tip) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  _onOver(e) {
    const target = this._findTarget(e.target);
    if (!target || target === this._activeEl) return;
    const region = target.dataset.tipRegion || "toolbar";
    if (this.regionEnabled[region] === false) return;

    this.hide();
    this._activeEl = target;
    this._timer = window.setTimeout(() => {
      if (this._activeEl === target && target.isConnected) {
        this._show(target);
      }
    }, this.delayMs);
  }

  _onOut(e) {
    if (!this._activeEl) return;
    if (e.relatedTarget && this._activeEl.contains(e.relatedTarget)) return;
    this.hide();
  }

  _show(target) {
    const title = target.dataset.tipTitle || "";
    const body = target.dataset.tip || "";
    const shortcut = target.dataset.tipKey || "";
    if (!body && !title) return;

    this.el.innerHTML = "";
    if (title || shortcut) {
      const head = document.createElement("div");
      head.className = "gtt-head";
      if (title) {
        const t = document.createElement("span");
        t.className = "gtt-title";
        t.textContent = title;
        head.appendChild(t);
      }
      if (shortcut) {
        const k = document.createElement("kbd");
        k.className = "gtt-key";
        k.textContent = shortcut;
        head.appendChild(k);
      }
      this.el.appendChild(head);
    }
    if (body) {
      const p = document.createElement("div");
      p.className = "gtt-body";
      p.textContent = body;
      this.el.appendChild(p);
    }

    this.el.style.display = "block";
    const r = target.getBoundingClientRect();
    const tw = this.el.offsetWidth;
    const th = this.el.offsetHeight;
    // Global UI Norm (rc12 #1.3): tooltips inside bottom tool context bars ALWAYS pop upward!
    const forceTop =
      target.dataset.tipPlacement === "top" ||
      !!target.closest("#context-bar-stack, .context-bar, .ctx-adv-popover, .color-wheel-popover");
    let x = r.left + r.width / 2 - tw / 2;
    let y;
    if (forceTop) {
      y = r.top - th - 8;
      if (y < 10) y = r.bottom + 8;
    } else {
      y = r.bottom + 8;
      if (y + th > window.innerHeight - 10) {
        y = r.top - th - 8;
      }
    }
    x = Math.max(10, Math.min(window.innerWidth - tw - 10, x));
    y = Math.max(10, Math.min(window.innerHeight - th - 10, y));
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
    this.el.dataset.placement = y < r.top ? "top" : "bottom";
  }

  hide() {
    if (this._timer) {
      window.clearTimeout(this._timer);
      this._timer = null;
    }
    this._activeEl = null;
    this.el.style.display = "none";
  }
}

export function bindTip(el, { title = "", tip = "", key = "", region = "toolbar", placement = "" }) {
  if (!el) return el;
  if (title) el.dataset.tipTitle = title;
  if (tip) el.dataset.tip = tip;
  if (key) el.dataset.tipKey = key;
  if (placement) el.dataset.tipPlacement = placement;
  el.dataset.tipRegion = region;
  el.removeAttribute("title");
  return el;
}
