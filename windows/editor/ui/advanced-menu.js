/**
 * @module ui/advanced-menu
 * @description Controller for the Top Menu -> 高级选项 2nd/3rd-level cascading submenus (M11):
 * - 工具高级选项 ▸ : 3D 语义无感选择开关 / 3D 语义采样视角数 (4/6/8/12) / 3D 语义模型下载与切换 / L2 平面补洞模型下载
 * - 性能监控显示设置 ▸ : 右下角自定义硬件与 FPS 显示项
 *
 * Strictly follows Global Multi-Mirror Download UX (UI与模块化工程设计规范.md §5.1):
 * - Exposes only a single "下载" button per downloadable model (CN/INTL mirror failover is 100% automatic).
 * - Rich delayed Tooltip on every model explains speed, accuracy, and VRAM differences.
 */

import { t } from "../i18n.js";

const SEMANTIC_PREFS_KEY = "splat_semantic_adv_prefs_v1";

export class AdvancedMenuController {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.menuPopupEl
   * @param {import('./perf-hud.js').PerfHudController} opts.perfHud
   * @param {(el: HTMLElement, tip: object) => void} opts.bindTip
   * @param {(msg: string) => void} opts.postHost
   * @param {(prefs: { silent3D: boolean, viewCount3D: number }) => void} opts.onSemanticPrefsChange
   * @param {(modelId: string) => void} [opts.onModelSelected]
   */
  constructor({ menuPopupEl, perfHud, bindTip, postHost, onSemanticPrefsChange, onModelSelected }) {
    this.menuPopupEl = menuPopupEl;
    this.perfHud = perfHud;
    this.bindTip = bindTip;
    this.postHost = postHost;
    this.onSemanticPrefsChange = onSemanticPrefsChange;
    this.onModelSelected = onModelSelected;

    this.prefs = this._loadPrefs();
    this._modelsPayload = null;
    this._downloadProgress = new Map(); // modelId -> { percent, stage }
    this._openSub = null;

    this._initDom();
  }

  _loadPrefs() {
    const def = { silent3D: true, viewCount3D: 6 };
    try {
      const saved = JSON.parse(localStorage.getItem(SEMANTIC_PREFS_KEY) || "null");
      if (saved && typeof saved === "object") {
        if (typeof saved.silent3D === "boolean") def.silent3D = saved.silent3D;
        if ([4, 6, 8, 12].includes(Number(saved.viewCount3D))) def.viewCount3D = Number(saved.viewCount3D);
      }
    } catch { /* ignore */ }
    return def;
  }

  _savePrefs() {
    try { localStorage.setItem(SEMANTIC_PREFS_KEY, JSON.stringify(this.prefs)); } catch { /* ignore */ }
    if (typeof this.onSemanticPrefsChange === "function") this.onSemanticPrefsChange({ ...this.prefs });
  }

  _initDom() {
    if (!this.menuPopupEl) return;

    // 2nd -> 3rd level cascading submenu hover & click wiring
    this.menuPopupEl.querySelectorAll(".menu-sub-wrap").forEach((wrap) => {
      const trig = wrap.querySelector(".menu-sub-trigger");
      const subId = trig?.dataset?.submenu;
      if (!trig || !subId) return;
      wrap.addEventListener("pointerenter", () => this.openSubmenu(subId));
      trig.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openSubmenu(this._openSub === subId ? null : subId);
      });
    });

    // Silent 3D switch
    const chkSilent = document.getElementById("chk-semantic-silent-3d");
    if (chkSilent) {
      chkSilent.checked = this.prefs.silent3D;
      chkSilent.addEventListener("change", () => {
        this.prefs.silent3D = chkSilent.checked;
        this._savePrefs();
      });
    }

    // 3D view count presets (4 / 6 / 8 / 12)
    const viewsRow = document.getElementById("adv-semantic-views-row");
    if (viewsRow) {
      const syncBtns = () => {
        viewsRow.querySelectorAll("[data-sem-views]").forEach((b) => {
          b.classList.toggle("active", Number(b.dataset.semViews) === this.prefs.viewCount3D);
        });
      };
      viewsRow.querySelectorAll("[data-sem-views]").forEach((b) => {
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          this.prefs.viewCount3D = Number(b.dataset.semViews) || 6;
          syncBtns();
          this._savePrefs();
        });
      });
      syncBtns();
    }

    // Mount 3rd-level performance HUD settings list
    const perfList = document.getElementById("adv-perf-fields-list");
    if (perfList && this.perfHud) {
      this.perfHud.mountSettingsMenu(perfList, this.bindTip);
    }

    // Render fallback placeholder catalog until host pushes live modelsStatus
    this._renderModelCards();
  }

  openSubmenu(subId) {
    this._openSub = subId;
    if (!this.menuPopupEl) return;
    this.menuPopupEl.querySelectorAll(".menu-sub-wrap").forEach((wrap) => {
      const trig = wrap.querySelector(".menu-sub-trigger");
      const pop = wrap.querySelector(".menu-sub-popup");
      const active = trig?.dataset?.submenu === subId;
      trig?.classList.toggle("open", active);
      pop?.classList.toggle("hidden", !active);
    });
  }

  closeSubmenus() {
    this.openSubmenu(null);
  }

  getPrefs() {
    return { ...this.prefs };
  }

  setModelsPayload(payload) {
    this._modelsPayload = payload || null;
    if (payload?.models) {
      for (const m of payload.models) {
        if (!m.downloading) this._downloadProgress.delete(m.id);
      }
    }
    this._renderModelCards();
  }

  updateDownloadProgress(modelId, percent, stage) {
    this._downloadProgress.set(modelId, { percent, stage });
    this._renderModelCards();
  }

  clearDownloadProgress(modelId) {
    this._downloadProgress.delete(modelId);
    this._renderModelCards();
  }

  refreshLanguage() {
    this._renderModelCards();
  }

  _getFallbackCatalog() {
    return {
      activeSemanticModel: "sam21-tiny-fp16",
      models: [
        {
          id: "sam21-tiny-fp16",
          category: "semantic",
          displayName: t("app.models.sam21TinyName"),
          shortBadge: t("app.models.sam21TinyBadge"),
          tooltip: t("app.models.sam21TinyTooltip"),
          bundled: true,
          installed: true,
          downloading: false,
          approxSizeMb: 74,
        },
        {
          id: "mobilesam",
          category: "semantic",
          displayName: t("app.models.mobileSamName"),
          shortBadge: t("app.models.mobileSamBadge"),
          tooltip: t("app.models.mobileSamTooltip"),
          bundled: false,
          installed: false,
          downloading: false,
          approxSizeMb: 43,
        },
        {
          id: "sam21-small-fp16",
          category: "semantic",
          displayName: t("app.models.sam21SmallName"),
          shortBadge: t("app.models.sam21SmallBadge"),
          tooltip: t("app.models.sam21SmallTooltip"),
          bundled: false,
          installed: false,
          downloading: false,
          approxSizeMb: 88,
        },
        {
          id: "lama-fp32",
          category: "inpaint",
          displayName: t("app.models.lamaName"),
          shortBadge: t("app.models.lamaBadge"),
          tooltip: t("app.models.lamaTooltip"),
          bundled: false,
          installed: false,
          downloading: false,
          approxSizeMb: 198,
        },
      ],
    };
  }

  _renderModelCards() {
    const semContainer = document.getElementById("adv-semantic-models-list");
    const inpContainer = document.getElementById("adv-inpaint-models-list");
    if (!semContainer && !inpContainer) return;

    const payload = this._modelsPayload || this._getFallbackCatalog();
    const activeSem = payload.activeSemanticModel || "sam21-tiny-fp16";
    const list = Array.isArray(payload.models) ? payload.models : [];

    const renderGroup = (container, category) => {
      if (!container) return;
      container.innerHTML = "";
      for (const m of list.filter((x) => x.category === category)) {
        const dl = this._downloadProgress.get(m.id);
        const isDownloading = !!dl || !!m.downloading;
        const isInstalled = !!m.installed || (!!m.bundled && !!m.hasEmbeddedBundle);
        const isActive = category === "semantic" ? activeSem === m.id : isInstalled;

        const card = document.createElement("div");
        card.className = "model-card-item" + (isActive && category === "semantic" ? " active-model" : "");
        card.dataset.modelId = m.id;

        const top = document.createElement("div");
        top.className = "model-card-top";
        const nameEl = document.createElement("span");
        nameEl.className = "model-card-name";
        nameEl.textContent = m.displayName;
        const badge = document.createElement("span");
        badge.className = "model-card-badge" + (isInstalled ? " ready" : "");
        badge.textContent = m.bundled
          ? (isActive && category === "semantic" ? t("editor.advMenu.bundledActive") : t("editor.advMenu.bundledDefault"))
          : isInstalled
            ? (isActive && category === "semantic" ? t("editor.advMenu.installedActive") : t("editor.advMenu.ready"))
            : t("editor.advMenu.notDownloaded", { mb: m.approxSizeMb });
        top.append(nameEl, badge);
        card.appendChild(top);

        if (isDownloading) {
          const pct = dl ? dl.percent : 2;
          const stage = dl ? dl.stage : t("editor.advMenu.connecting");
          const bar = document.createElement("div");
          bar.className = "model-dl-bar";
          bar.innerHTML = `<div class="model-dl-bar-fill" style="width:${pct}%"></div>`;
          const actRow = document.createElement("div");
          actRow.className = "model-card-actions";
          const stTxt = document.createElement("span");
          stTxt.textContent = `${stage} (${pct}%)`;
          const btnCancel = document.createElement("button");
          btnCancel.type = "button";
          btnCancel.className = "tiny-btn";
          btnCancel.textContent = t("common.cancel");
          btnCancel.onclick = (e) => {
            e.stopPropagation();
            this.postHost("modelCancelDownload:" + m.id);
          };
          actRow.append(stTxt, btnCancel);
          card.append(bar, actRow);
        } else {
          const actRow = document.createElement("div");
          actRow.className = "model-card-actions";
          const sizeMeta = document.createElement("span");
          sizeMeta.textContent = t("editor.advMenu.sizeMeta", { badge: m.shortBadge, mb: m.approxSizeMb });
          actRow.appendChild(sizeMeta);

          if (!isInstalled && !m.bundled) {
            // Single Download button only — CN/INTL mirror failover is completely automatic in host ModelManager!
            const btnDl = document.createElement("button");
            btnDl.type = "button";
            btnDl.className = "tiny-btn accent";
            btnDl.textContent = t("editor.advMenu.downloadBtn");
            btnDl.onclick = (e) => {
              e.stopPropagation();
              this._downloadProgress.set(m.id, { percent: 1, stage: t("editor.advMenu.probing") });
              this._renderModelCards();
              this.postHost("modelDownload:" + m.id);
            };
            actRow.appendChild(btnDl);
          } else if (category === "semantic" && !isActive) {
            const btnUse = document.createElement("button");
            btnUse.type = "button";
            btnUse.className = "tiny-btn";
            btnUse.textContent = t("editor.advMenu.switchUseBtn");
            btnUse.onclick = (e) => {
              e.stopPropagation();
              this.postHost("modelSelect:" + m.id);
              if (typeof this.onModelSelected === "function") this.onModelSelected(m.id);
            };
            actRow.appendChild(btnUse);
          }
          card.appendChild(actRow);
        }

        if (this.bindTip) {
          this.bindTip(card, { title: m.displayName, tip: m.tooltip || m.displayName, region: "toolbar" });
        }
        container.appendChild(card);
      }
    };

    renderGroup(semContainer, "semantic");
    renderGroup(inpContainer, "inpaint");
  }
}
