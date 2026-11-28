/**
 * @module ui/context-menu
 * @description Smart Viewport Right-Click Floating Menu.
 *
 * Features:
 * - Dynamic "上次使用的工具" (Last-Used Tool) quick switch right at the top.
 * - Direct Undo / Redo actions with live stack enabled state (moved cleanly out of left rail).
 * - Frequently used studio actions (display mode cycle, fit view, color panel, invert/deselect).
 * - Bounding Volume & Occlusion Plane creation + selection operations.
 */

import { t } from "../i18n.js";

export class ViewportContextMenu {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.menuEl
   * @param {HTMLElement} opts.stageEl
   * @param {() => { id: string, label: string, key: string, ico: string } | null} opts.getLastTool
   * @param {() => { canUndo: boolean, canRedo: boolean, hasSelection: boolean }} opts.getActionState
   * @param {(action: string, payload?: any) => void} opts.onAction
   */
  constructor({ menuEl, stageEl, getLastTool, getActionState, onAction }) {
    this.menuEl = menuEl;
    this.stageEl = stageEl;
    this.getLastTool = getLastTool;
    this.getActionState = getActionState;
    this.onAction = onAction;

    this._lastClientX = 0;
    this._lastClientY = 0;

    window.addEventListener("pointerdown", (e) => {
      if (!this.menuEl.classList.contains("hidden") && !this.menuEl.contains(e.target)) {
        this.hide();
      }
    });
  }

  showAt(clientX, clientY) {
    this._lastClientX = clientX;
    this._lastClientY = clientY;
    this._rebuild();

    const rect = this.stageEl.getBoundingClientRect();
    this.menuEl.classList.remove("hidden");
    const mw = this.menuEl.offsetWidth || 230;
    const mh = this.menuEl.offsetHeight || 340;
    const left = Math.max(8, Math.min(rect.width - mw - 8, clientX - rect.left));
    const top = Math.max(8, Math.min(rect.height - mh - 8, clientY - rect.top));
    this.menuEl.style.left = `${left}px`;
    this.menuEl.style.top = `${top}px`;
  }

  hide() {
    this.menuEl.classList.add("hidden");
  }

  _rebuild() {
    const lastTool = this.getLastTool?.();
    const st = this.getActionState?.() || { canUndo: false, canRedo: false, hasSelection: false };
    const el = this.menuEl;
    el.innerHTML = "";

    const addBtn = (label, kbd, action, { disabled = false, danger = false, accent = false, payload = null } = {}) => {
      const b = document.createElement("button");
      if (danger) b.classList.add("danger");
      if (accent) b.classList.add("ctx-accent");
      b.disabled = !!disabled;
      const span = document.createElement("span");
      span.textContent = label;
      b.appendChild(span);
      if (kbd) {
        const k = document.createElement("kbd");
        k.textContent = kbd;
        b.appendChild(k);
      }
      b.onclick = () => {
        this.hide();
        this.onAction?.(action, payload ?? { clientX: this._lastClientX, clientY: this._lastClientY });
      };
      el.appendChild(b);
    };

    const addSep = () => {
      const d = document.createElement("div");
      d.className = "menu-sep";
      el.appendChild(d);
    };

    const addSectionLabel = (txt) => {
      const d = document.createElement("div");
      d.className = "ctx-sec-label";
      d.textContent = txt;
      el.appendChild(d);
    };

    // 1. Dynamic Last-Used Tool + Undo / Redo (fast recall without cluttering viewport!)
    if (lastTool) {
      addBtn(t("editor.contextMenu.recallTool", { ico: lastTool.ico, label: lastTool.label }), lastTool.key, "recallTool", {
        accent: true,
        payload: lastTool.id,
      });
    }
    addBtn(t("editor.contextMenu.undo"), "Ctrl+Z", "undo", { disabled: !st.canUndo });
    addBtn(t("editor.contextMenu.redo"), "Ctrl+Shift+Z", "redo", { disabled: !st.canRedo });
    addSep();

    // 2. High-Frequency Studio Actions
    addSectionLabel(t("editor.contextMenu.secQuick"));
    addBtn(t("editor.contextMenu.cycleMode"), "Tab", "cycleMode");
    addBtn(t("editor.contextMenu.colorPanel"), "C", "toggleColor");
    addBtn(t("editor.contextMenu.fitView"), "Space", "fitView");
    addBtn(t("editor.contextMenu.autoAlign"), "A", "autoAlign");
    addSep();

    // 3. Bounding Volumes & Infinite Occlusion Plane
    addSectionLabel(t("editor.contextMenu.secVolumes"));
    addBtn(t("editor.contextMenu.volBox"), "", "vol-box");
    addBtn(t("editor.contextMenu.volEllipsoid"), "", "vol-ellipsoid");
    addBtn(t("editor.contextMenu.volCylinder"), "", "vol-cylinder");
    addBtn(t("editor.contextMenu.volPlane"), "", "vol-plane");
    addSep();

    // 4. Selection & Object Actions
    addSectionLabel(t("editor.contextMenu.secSelection"));
    addBtn(t("editor.contextMenu.isolate"), "Shift+I", "isolate", { disabled: !st.hasSelection });
    addBtn(t("editor.contextMenu.hide"), "H", "hide", { disabled: !st.hasSelection });
    addBtn(t("editor.contextMenu.showAll"), "Alt+H", "showall");
    addBtn(t("editor.contextMenu.split"), "P", "split", { disabled: !st.hasSelection });
    addBtn(t("editor.contextMenu.dup"), "Shift+D", "dup", { disabled: !st.hasSelection });
    addBtn(t("editor.contextMenu.delete"), "Del", "delete", { disabled: !st.hasSelection, danger: true });
  }
}
