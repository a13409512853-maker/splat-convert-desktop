/**
 * @module ui/tool-rail
 * @description Unified single-column left tool rail with uniform 22px crisp SVG icons,
 * centered understated labels, whisper-subtle top-right corner shortcut badges, collapsible
 * secondary flyout menus ("筛选", "智能", "矫正"), and top-right W/E/R Gizmo cluster sync.
 */

import { t } from "../i18n.js";

const svg = (body) =>
  `<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const FLYOUT_DEFAULT_SVGS = {
  filter:  svg(`<path d="M12 3.2 14.3 9.7 20.8 12 14.3 14.3 12 20.8 9.7 14.3 3.2 12 9.7 9.7 12 3.2Z"/>`),
  smart:   svg(`<rect x="6.5" y="6.5" width="11" height="11" rx="2" transform="rotate(45 12 12)"/><circle cx="12" cy="12" r="2.2"/>`),
  align:   svg(`<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 4v16M4 12h16"/>`),
  measure: svg(`<path d="M4.5 16.5 16.5 4.5l3 3-12 12-3-3Z"/><path d="m11 10 1.8 1.8M8.3 12.7l1.8 1.8M13.7 7.3l1.8 1.8"/>`),
};

export const TOOL_META = {
  orbit:         { get label() { return t("editor.rail.orbit"); },   key: "1", ico: "◎", group: "basic" },
  rect:          { get label() { return t("editor.rail.rect"); },    key: "2", ico: "▭", group: "basic" },
  lasso:         { get label() { return t("editor.rail.lasso"); },   key: "3", ico: "∿", group: "basic" },
  ellipse:       { get label() { return t("editor.rail.ellipse"); }, key: "4", ico: "⬭", group: "basic" },
  poly:          { get label() { return t("editor.rail.poly"); },    key: "5", ico: "⬠", group: "basic" },
  brush:         { get label() { return t("editor.rail.brush"); },   key: "6", ico: "✎", group: "basic" },
  eyedropper:    {
    get label() { return t("editor.rail.eyedropper"); }, key: "Y", ico: "💧", group: "filter",
    svg: svg(`<path d="m18.5 3.5 2 2a1.8 1.8 0 0 1 0 2.6l-2.3 2.3-4.6-4.6 2.3-2.3a1.8 1.8 0 0 1 2.6 0Z"/><path d="m14.8 7.2-8.4 8.4a2.2 2.2 0 0 0-.6 1.2L5 20l3.2-.8c.4-.1.9-.3 1.2-.6l8.4-8.4"/>`),
  },
  opacitySel:    {
    get label() { return t("editor.rail.opacitySel"); }, key: "O", ico: "◐", group: "filter",
    svg: svg(`<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none"/>`),
  },
  sizeSel:       {
    get label() { return t("editor.rail.sizeSel"); }, key: "K", ico: "⤢", group: "filter",
    svg: svg(`<path d="M15 4h5v5M9 20H4v-5M20 4l-6.5 6.5M4 20l6.5-6.5"/>`),
  },
  semanticSel:   {
    get label() { return t("editor.rail.semanticSel"); }, key: "M", ico: "✦", group: "filter",
    svg: svg(`<path d="M12 3.2 14.3 9.7 20.8 12 14.3 14.3 12 20.8 9.7 14.3 3.2 12 9.7 9.7 12 3.2Z"/>`),
  },
  floaterSel:    {
    get label() { return t("editor.rail.floaterSel"); }, key: "F", ico: "◌", group: "filter",
    svg: svg(`<circle cx="12" cy="12" r="7.5" stroke-dasharray="3 3"/><circle cx="12" cy="12" r="2"/>`),
  },
  planeInpaint:  {
    get label() { return t("editor.rail.planeInpaint"); }, key: "J", ico: "❖", group: "smart",
    svg: svg(`<rect x="6.5" y="6.5" width="11" height="11" rx="2" transform="rotate(45 12 12)"/><path d="M12 9.2v5.6M9.2 12h5.6"/>`),
  },
  autoAlign:     {
    get label() { return t("editor.rail.autoAlign"); }, key: "A", ico: "⊞", group: "align",
    svg: svg(`<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 4v16M4 12h16"/>`),
  },
  verticalAlign: {
    get label() { return t("editor.rail.verticalAlign"); }, key: "U", ico: "┃", group: "align",
    svg: svg(`<path d="M12 3.5v17M8.5 7 12 3.5 15.5 7M8.5 17 12 20.5 15.5 17"/>`),
  },
  groundAlign:   {
    get label() { return t("editor.rail.groundAlign"); }, key: "L", ico: "⊿", group: "align",
    svg: svg(`<path d="M3.5 18.5h17"/><polygon points="7 15 12 6 17 15"/>`),
  },
  scaleCalib:    {
    get label() { return t("editor.rail.scaleCalib"); }, key: "Shift+T", ico: "⚖", group: "measure",
    svg: svg(`<path d="M4 17h16M6 17v-4M10 17v-2.5M14 17v-4M18 17v-2.5"/><path d="M7 9l5-4 5 4"/><path d="M12 5v7"/>`),
  },
  smartMeasure:  {
    get label() { return t("editor.rail.smartMeasure"); }, key: "T", ico: "✎", group: "measure",
    svg: svg(`<path d="M4.5 16.5 16.5 4.5l3 3-12 12-3-3Z"/><path d="m11 10 1.8 1.8M8.3 12.7l1.8 1.8M13.7 7.3l1.8 1.8"/>`),
  },
};

export class ToolRailController {
  constructor({ railEl, gizmoClusterEl, onSelectTool, onSelectGizmo }) {
    this.railEl = railEl;
    this.gizmoClusterEl = gizmoClusterEl;
    this.onSelectTool = onSelectTool;
    this.onSelectGizmo = onSelectGizmo;

    this._currentTool = "orbit";
    this._lastTool = null;
    this._openFlyout = null;

    this._bindEvents();
  }

  _bindEvents() {
    this.railEl.querySelectorAll("[data-tool]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const tool = btn.dataset.tool;
        this.closeFlyouts();
        if (typeof this.onSelectTool === "function") this.onSelectTool(tool);
      });
    });

    this.railEl.querySelectorAll("[data-flyout-trigger]").forEach((trigger) => {
      const name = trigger.dataset.flyoutTrigger;
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleFlyout(name);
      });
    });

    if (this.gizmoClusterEl) {
      this.gizmoClusterEl.querySelectorAll("[data-gizmo]").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (typeof this.onSelectGizmo === "function") this.onSelectGizmo(btn.dataset.gizmo);
        });
      });
    }

    window.addEventListener("pointerdown", (e) => {
      if (this._openFlyout && !e.target.closest(".rail-flyout-wrap")) {
        this.closeFlyouts();
      }
    });
  }

  toggleFlyout(name) {
    const next = this._openFlyout === name ? null : name;
    this._openFlyout = next;
    this.railEl.querySelectorAll(".rail-flyout-menu").forEach((m) => {
      m.classList.toggle("hidden", m.dataset.flyoutMenu !== next);
    });
    this.railEl.querySelectorAll("[data-flyout-trigger]").forEach((t) => {
      t.classList.toggle("open", t.dataset.flyoutTrigger === next);
    });
  }

  closeFlyouts() {
    if (!this._openFlyout) return;
    this._openFlyout = null;
    this.railEl.querySelectorAll(".rail-flyout-menu").forEach((m) => m.classList.add("hidden"));
    this.railEl.querySelectorAll("[data-flyout-trigger]").forEach((t) => t.classList.remove("open"));
  }

  _syncFlyoutTrigger(groupName, defaultLabel, meta) {
    const trigger = this.railEl.querySelector(`[data-flyout-trigger="${groupName}"]`);
    if (!trigger) return;
    const isActive = meta?.group === groupName;
    trigger.classList.toggle("active", isActive);
    const icoEl = trigger.querySelector(".ico");
    const lblEl = trigger.querySelector(".lbl");
    const kbdEl = trigger.querySelector("kbd");
    const caretEl = trigger.querySelector(".fly-caret");
    if (isActive) {
      if (icoEl) icoEl.innerHTML = meta.svg || FLYOUT_DEFAULT_SVGS[groupName] || "";
      if (lblEl) lblEl.textContent = meta.label;
      if (kbdEl) { kbdEl.textContent = meta.key; kbdEl.classList.remove("hidden"); }
      if (caretEl) caretEl.classList.add("hidden");
    } else {
      if (icoEl) icoEl.innerHTML = FLYOUT_DEFAULT_SVGS[groupName] || "";
      if (lblEl) lblEl.textContent = defaultLabel;
      if (kbdEl) { kbdEl.textContent = ""; kbdEl.classList.add("hidden"); }
      if (caretEl) caretEl.classList.remove("hidden");
    }
  }

  /**
   * Synchronize active visual highlights across primary buttons, flyout submenus, and last-tool recall.
   * Browse ("orbit", key 1) is ONLY mutually exclusive with basic tools 2-6; it highlights simultaneously
   * alongside Filter / Smart / Align tools when `browseActive` is true.
   */
  syncActiveTool(toolId, browseActive = false, orbitIdle = false) {
    if (toolId && toolId !== this._currentTool && TOOL_META[this._currentTool]) {
      this._lastTool = this._currentTool;
    }
    this._currentTool = toolId;

    const isBrowseLit = toolId === "orbit" ? !orbitIdle : !!browseActive;
    this.railEl.querySelectorAll("[data-tool]").forEach((btn) => {
      const t = btn.dataset.tool;
      const on = t === "orbit" ? isBrowseLit : t === toolId;
      btn.classList.toggle("active", on);
    });

    const meta = TOOL_META[toolId];
    this._syncFlyoutTrigger("filter",  t("editor.rail.filter"), meta);
    this._syncFlyoutTrigger("smart",   t("editor.rail.smart"), meta);
    this._syncFlyoutTrigger("align",   t("editor.rail.align"), meta);
    this._syncFlyoutTrigger("measure", t("editor.rail.measure"), meta);
  }

  refreshLabels() {
    const meta = TOOL_META[this._currentTool];
    this._syncFlyoutTrigger("filter",  t("editor.rail.filter"), meta);
    this._syncFlyoutTrigger("smart",   t("editor.rail.smart"), meta);
    this._syncFlyoutTrigger("align",   t("editor.rail.align"), meta);
    this._syncFlyoutTrigger("measure", t("editor.rail.measure"), meta);
  }

  syncGizmoMode(mode, gizmoVisible) {
    if (!this.gizmoClusterEl) return;
    this.gizmoClusterEl.querySelectorAll("[data-gizmo]").forEach((btn) => {
      btn.classList.toggle("active", gizmoVisible && btn.dataset.gizmo === mode);
    });
  }

  getLastTool() {
    if (!this._lastTool || !TOOL_META[this._lastTool]) return null;
    return { id: this._lastTool, ...TOOL_META[this._lastTool] };
  }
}
