/**
 * @module ui/dropdown
 * @description Unified Apple-dark continuous-curvature custom dropdown component.
 * Replaces native OS white <select> popups across display mode, context bars, LUTs, and modals.
 *
 * Design Contract:
 * - Strict dark surface with smooth hover & orange active highlight (matching ReSplat Fig 6).
 * - Supports optional inline SVG icon per option, compact mode, and automatic up/down placement.
 * - Closes reliably on outside click, Escape key, or sibling dropdown open.
 */

const openRegistry = new Set();

export function closeAllCustomDropdowns(except = null) {
  for (const inst of openRegistry) {
    if (inst !== except) inst.close();
  }
}

window.addEventListener("pointerdown", (e) => {
  for (const inst of openRegistry) {
    if (!inst.el.contains(e.target)) inst.close();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllCustomDropdowns();
});

const CHEVRON_SVG = `<svg class="cd-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5L6 7.5L9 4.5"/></svg>`;

/**
 * @typedef {Object} CustomSelectOption
 * @property {string} value
 * @property {string} label
 * @property {string} [iconHtml]
 * @property {string} [hint]
 */

/**
 * Create a unified dark custom dropdown widget.
 * @param {Object} opts
 * @param {CustomSelectOption[]} opts.options
 * @param {string} [opts.value]
 * @param {(val: string) => void} [opts.onChange]
 * @param {string} [opts.className]
 * @param {"down"|"up"|"auto"} [opts.placement="auto"]
 * @param {boolean} [opts.accentActive=true]
 * @param {string} [opts.ariaLabel]
 */
export function createCustomSelect(opts) {
  const options = Array.isArray(opts.options) ? opts.options : [];
  const placement = opts.placement || "auto";
  const accentActive = opts.accentActive !== false;
  let currentValue = opts.value ?? (options[0]?.value ?? "");
  let isOpen = false;

  const root = document.createElement("div");
  root.className = `custom-dropdown ${opts.className || ""}`.trim();

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cd-trigger";
  if (opts.ariaLabel) trigger.setAttribute("aria-label", opts.ariaLabel);

  const triggerContent = document.createElement("span");
  triggerContent.className = "cd-trigger-content";
  const triggerChevron = document.createElement("span");
  triggerChevron.className = "cd-chevron-wrap";
  triggerChevron.innerHTML = CHEVRON_SVG;
  trigger.append(triggerContent, triggerChevron);

  const menu = document.createElement("div");
  menu.className = "cd-menu hidden";
  if (accentActive) menu.classList.add("cd-accent-active");

  root.append(trigger, menu);

  const itemEls = new Map();

  function renderTrigger() {
    const active = options.find((o) => o.value === currentValue) || options[0];
    triggerContent.innerHTML = "";
    if (active) {
      if (active.iconHtml) {
        const ico = document.createElement("span");
        ico.className = "cd-icon";
        ico.innerHTML = active.iconHtml;
        triggerContent.appendChild(ico);
      }
      const lbl = document.createElement("span");
      lbl.className = "cd-label";
      lbl.textContent = active.label;
      triggerContent.appendChild(lbl);
    }
  }

  function rebuildItems() {
    menu.innerHTML = "";
    itemEls.clear();
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cd-item" + (opt.value === currentValue ? " active" : "");
      btn.dataset.value = opt.value;
      if (opt.iconHtml) {
        const ico = document.createElement("span");
        ico.className = "cd-icon";
        ico.innerHTML = opt.iconHtml;
        btn.appendChild(ico);
      }
      const lbl = document.createElement("span");
      lbl.className = "cd-label";
      lbl.textContent = opt.label;
      btn.appendChild(lbl);
      if (opt.hint) {
        const h = document.createElement("span");
        h.className = "cd-hint";
        h.textContent = opt.hint;
        btn.appendChild(h);
      }
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const changed = opt.value !== currentValue;
        setValue(opt.value);
        close();
        if (changed && typeof opts.onChange === "function") opts.onChange(currentValue);
      });
      menu.appendChild(btn);
      itemEls.set(opt.value, btn);
    }
  }

  function open() {
    if (isOpen) return;
    closeAllCustomDropdowns(api);
    isOpen = true;
    root.classList.add("open");
    menu.classList.remove("hidden", "cd-menu-up", "cd-menu-down");
    let useUp = placement === "up";
    if (placement === "auto") {
      const rect = trigger.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      useUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    }
    menu.classList.add(useUp ? "cd-menu-up" : "cd-menu-down");
    openRegistry.add(api);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    root.classList.remove("open");
    menu.classList.add("hidden");
    openRegistry.delete(api);
  }

  function setValue(v) {
    if (!options.some((o) => o.value === v)) return;
    currentValue = v;
    renderTrigger();
    for (const [val, btn] of itemEls.entries()) {
      btn.classList.toggle("active", val === currentValue);
    }
  }

  function setOptions(nextOptions, nextValue) {
    options.length = 0;
    for (const o of nextOptions) options.push(o);
    if (nextValue !== undefined) currentValue = nextValue;
    else if (!options.some((o) => o.value === currentValue)) currentValue = options[0]?.value ?? "";
    rebuildItems();
    renderTrigger();
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isOpen) close();
    else open();
  });

  const api = {
    el: root,
    trigger,
    menu,
    getValue: () => currentValue,
    setValue,
    setOptions,
    open,
    close,
  };

  rebuildItems();
  renderTrigger();
  return api;
}
