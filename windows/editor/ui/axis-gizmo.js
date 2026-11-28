/**
 * @module ui/axis-gizmo
 * @description Restrained +Z-up 3D Navigation Axis Sphere Widget.
 *
 * Visual & Interaction Contract:
 * - Idle State (pointer outside): Completely transparent background (zero dark backdrop,
 *   zero ring border) so the widget floats unobtrusively over the 3D scene.
 * - Hover State (pointer inside/near): Smoothly eases in subtle 3D spherical wireframe
 *   meridian/latitude guide lines that gently react to cursor proximity (local brightening
 *   and delicate parallax tilt), acting as an understated decorative & orientation aid.
 * - Click Interaction: Clicking any ±X/±Y/±Z endpoint smoothly snaps the camera to that axis.
 */
import * as T from "three";

const POSITIVE_AXES = [
  { v: new T.Vector3(1, 0, 0), label: "X", color: "#c96262", bright: "#e27878", pos: true },
  { v: new T.Vector3(0, 1, 0), label: "Y", color: "#58a876", bright: "#6dc48c", pos: true },
  { v: new T.Vector3(0, 0, 1), label: "Z", color: "#5a8cd1", bright: "#74a6eb", pos: true },
  { v: new T.Vector3(-1, 0, 0), label: "-X", color: "rgba(180,92,92,0.55)", bright: "#d47272", pos: false },
  { v: new T.Vector3(0, -1, 0), label: "-Y", color: "rgba(88,168,118,0.55)", bright: "#6dc48c", pos: false },
  { v: new T.Vector3(0, 0, -1), label: "-Z", color: "rgba(90,140,209,0.55)", bright: "#74a6eb", pos: false },
];

export class AxisGizmoWidget {
  /**
   * @param {Object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {() => T.Camera} opts.getCamera
   * @param {(dir: T.Vector3) => void} opts.onSnapAxis
   */
  constructor({ canvas, getCamera, onSnapAxis }) {
    this.canvas = canvas;
    this.getCamera = getCamera;
    this.onSnapAxis = onSnapAxis;

    this._hovered = false;
    this._hoverBlend = 0; // Smoothly animated [0..1]
    this._mouseX = -999;
    this._mouseY = -999;
    this._hoveredAxisIdx = -1;
    this._animId = null;

    // Precompute crisp HiDPI scaling
    this._logicalSize = 96;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this._logicalSize * dpr);
    this.canvas.height = Math.round(this._logicalSize * dpr);
    this.canvas.style.width = `${this._logicalSize}px`;
    this.canvas.style.height = `${this._logicalSize}px`;
    this._dpr = dpr;

    this._bindEvents();
  }

  _bindEvents() {
    this.canvas.addEventListener("pointerenter", (e) => {
      this._hovered = true;
      this._updatePointer(e);
      this._ensureAnim();
    });

    this.canvas.addEventListener("pointermove", (e) => {
      this._hovered = true;
      this._updatePointer(e);
      this._ensureAnim();
    });

    this.canvas.addEventListener("pointerleave", () => {
      this._hovered = false;
      this._hoveredAxisIdx = -1;
      this._mouseX = -999;
      this._mouseY = -999;
      this._ensureAnim();
    });

    this.canvas.addEventListener("click", (e) => {
      this._updatePointer(e);
      const cam = this.getCamera?.();
      if (!cam) return;
      const hit = this._hitTestAxis(cam, this._mouseX, this._mouseY);
      if (hit >= 0 && typeof this.onSnapAxis === "function") {
        this.onSnapAxis(POSITIVE_AXES[hit].v.clone());
      }
    });
  }

  _updatePointer(e) {
    const rect = this.canvas.getBoundingClientRect();
    this._mouseX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * this._logicalSize;
    this._mouseY = ((e.clientY - rect.top) / Math.max(1, rect.height)) * this._logicalSize;
    const cam = this.getCamera?.();
    this._hoveredAxisIdx = cam ? this._hitTestAxis(cam, this._mouseX, this._mouseY) : -1;
    this.canvas.style.cursor = this._hoveredAxisIdx >= 0 ? "pointer" : "default";
  }

  _hitTestAxis(cam, mx, my) {
    const c = this._logicalSize / 2;
    const r = 30;
    const invQ = cam.quaternion.clone().invert();
    let best = -1;
    let bestD = 15;
    for (let i = 0; i < POSITIVE_AXES.length; i++) {
      const p = POSITIVE_AXES[i].v.clone().applyQuaternion(invQ);
      const ax = c + p.x * r;
      const ay = c - p.y * r;
      const d = Math.hypot(ax - mx, ay - my);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  _ensureAnim() {
    if (this._animId) return;
    const step = () => {
      const target = this._hovered ? 1 : 0;
      const diff = target - this._hoverBlend;
      if (Math.abs(diff) < 0.015) {
        this._hoverBlend = target;
        this._animId = null;
        this.draw();
        return;
      }
      this._hoverBlend += diff * 0.22;
      this.draw();
      this._animId = requestAnimationFrame(step);
    };
    this._animId = requestAnimationFrame(step);
  }

  /**
   * Draw a 3D spherical great-circle / latitude arc whose segments brighten gently near the mouse pointer.
   */
  _drawProximityWireArc(ctx, cx, cy, radius, invQ, pointFn, steps, baseAlpha) {
    const mx = this._mouseX;
    const my = this._mouseY;
    const proxRadius = 38;
    const v = new T.Vector3();
    let prevX = 0, prevY = 0, prevZ = 0;

    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      pointFn(t, v);
      v.applyQuaternion(invQ);
      const sx = cx + v.x * radius;
      const sy = cy - v.y * radius;
      const sz = v.z;

      if (i > 0) {
        const midX = (prevX + sx) * 0.5;
        const midY = (prevY + sy) * 0.5;
        const midZ = (prevZ + sz) * 0.5;
        const dMouse = Math.hypot(midX - mx, midY - my);
        // Smooth cursor-proximity glow: wireframe only becomes clearly visible near the cursor!
        const prox = Math.exp(-(dMouse * dMouse) / (2 * proxRadius * proxRadius * 0.45));
        const depthFade = midZ >= 0 ? 1.0 : 0.32;
        const alpha = this._hoverBlend * depthFade * (baseAlpha * 0.28 + baseAlpha * 1.15 * prox);
        if (alpha > 0.015) {
          ctx.beginPath();
          ctx.moveTo(prevX, prevY);
          ctx.lineTo(sx, sy);
          ctx.strokeStyle = `rgba(214, 224, 240, ${Math.min(0.48, alpha).toFixed(3)})`;
          ctx.lineWidth = midZ >= 0 ? 0.95 : 0.65;
          ctx.stroke();
        }
      }
      prevX = sx;
      prevY = sy;
      prevZ = sz;
    }
  }

  draw() {
    const cam = this.getCamera?.();
    const ctx = this.canvas.getContext("2d");
    if (!ctx || !cam) return;

    const S = this._logicalSize;
    const cx = S / 2;
    const cy = S / 2;
    const r = 30;

    ctx.save();
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);

    const invQ = cam.quaternion.clone().invert();

    // Subtle cursor-reactive parallax tilt (max ~4 deg) when hovering over the sphere
    if (this._hoverBlend > 0.01 && this._mouseX > -100) {
      const nx = Math.max(-1, Math.min(1, (this._mouseX - cx) / (S * 0.5)));
      const ny = Math.max(-1, Math.min(1, (this._mouseY - cy) / (S * 0.5)));
      const tiltQ = new T.Quaternion().setFromEuler(
        new T.Euler(ny * 0.075 * this._hoverBlend, nx * 0.075 * this._hoverBlend, 0),
      );
      invQ.premultiply(tiltQ);
    }

    // 1. Hover-only 3D Spherical Structural Wireframe (ZERO dark background circle!)
    if (this._hoverBlend > 0.015) {
      const wireR = r + 7;
      // 3 orthogonal great circles (XZ equator, XY meridian, YZ meridian — +Y-up)
      this._drawProximityWireArc(ctx, cx, cy, wireR, invQ, (t, out) => out.set(Math.cos(t), 0, Math.sin(t)), 44, 0.34);
      this._drawProximityWireArc(ctx, cx, cy, wireR, invQ, (t, out) => out.set(Math.cos(t), Math.sin(t), 0), 44, 0.30);
      this._drawProximityWireArc(ctx, cx, cy, wireR, invQ, (t, out) => out.set(0, Math.cos(t), Math.sin(t)), 44, 0.30);
      // 2 subtle ±45° latitude rings around +Y polar axis for clear 3D spherical volume perception near cursor
      const latR = Math.cos(Math.PI / 4);
      const latY = Math.sin(Math.PI / 4);
      this._drawProximityWireArc(ctx, cx, cy, wireR, invQ, (t, out) => out.set(Math.cos(t) * latR, latY, Math.sin(t) * latR), 36, 0.22);
      this._drawProximityWireArc(ctx, cx, cy, wireR, invQ, (t, out) => out.set(Math.cos(t) * latR, -latY, Math.sin(t) * latR), 36, 0.22);
    }

    // 2. Depth-sorted +Y-up Axis Spokes & Endpoints
    const items = POSITIVE_AXES.map((a, idx) => {
      const p = a.v.clone().applyQuaternion(invQ);
      return { ...a, idx, x: cx + p.x * r, y: cy - p.y * r, z: p.z };
    });
    items.sort((a, b) => a.z - b.z);

    for (const a of items) {
      const isFocus = a.idx === this._hoveredAxisIdx;
      const strokeCol = isFocus ? a.bright : a.color;

      if (a.pos) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(a.x, a.y);
        ctx.strokeStyle = strokeCol;
        ctx.globalAlpha = 0.68 + 0.28 * this._hoverBlend;
        ctx.lineWidth = isFocus ? 2.1 : 1.6;
        ctx.stroke();
      }

      ctx.globalAlpha = a.pos ? (0.82 + 0.18 * this._hoverBlend) : (0.45 + 0.4 * this._hoverBlend);
      const dotR = a.pos ? (isFocus ? 9.5 : 8.2) : (isFocus ? 6.4 : 4.8);
      ctx.beginPath();
      ctx.arc(a.x, a.y, dotR, 0, Math.PI * 2);
      ctx.fillStyle = a.pos ? strokeCol : "rgba(22, 25, 31, 0.55)";
      ctx.fill();

      if (!a.pos || isFocus) {
        ctx.strokeStyle = isFocus ? "#ffffff" : strokeCol;
        ctx.lineWidth = isFocus ? 1.5 : 1.1;
        ctx.stroke();
      }

      if (a.pos) {
        ctx.globalAlpha = 0.94;
        ctx.fillStyle = "#f8fafc";
        ctx.font = "600 9.5px 'Cascadia Mono', Consolas, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(a.label, a.x, a.y + 0.5);
      }
    }

    ctx.restore();
  }

  dispose() {
    if (this._animId) {
      cancelAnimationFrame(this._animId);
      this._animId = null;
    }
  }
}
