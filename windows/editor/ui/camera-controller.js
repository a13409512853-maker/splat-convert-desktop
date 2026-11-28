/**
 * @module ui/camera-controller
 * @description Unified strict +Z-up Smooth Dual Camera Controller (ReSplat-grade quintic feel):
 *  - "orbit" (轨道相机): Smooth damped revolve around focal target, damped pan, silky exponential
 *                        scroll-wheel zoom (zero choppy discrete notch jumps!).
 *  - "fly"   (漫游相机): First-person free roam with damped mouse look, damped pan, smooth
 *                        wheel forward/back dolly, and inertia-smoothed WASD + Q/E movement.
 *  - Pose Transitions  : Quintic ease-out (`(t - 1)^5 + 1`) spherical flight for Axis Sphere
 *                        axis snaps, double-click focal point focus, and Space fit-to-scene.
 *  - Demand-Driven RAF : Runs smoothly at full monitor refresh rate while moving/settling, then
 *                        fires one exact final sort (`onRender(true)`) and sleeps at 0% idle!
 */
import * as T from "three";

const quinticEaseOut = (t) => {
  const u = Math.max(0, Math.min(1, t)) - 1;
  return u * u * u * u * u + 1;
};

const TWO_PI = Math.PI * 2;
const normalizeAngleDelta = (delta) => {
  let d = delta % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
};

function roundNiceSpeed(v) {
  if (!Number.isFinite(v) || v <= 0) return 0.1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const mant = v / base;
  const snapped = Math.max(1.0, Math.round(mant * 2) / 2);
  return Number((snapped * base).toPrecision(3));
}

export class DualCameraController {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.canvas
   * @param {import("../vendor/OrbitControls.js").OrbitControls} opts.orbit
   * @param {() => T.Camera} opts.getCamera
   * @param {() => boolean} opts.canNavigate
   * @param {() => boolean} opts.isGizmoBusy
   * @param {(forceSort?: boolean) => void} opts.onRender
   * @param {(interacting: boolean) => void} opts.onInteractChange
   * @param {(mode: "orbit"|"fly") => void} [opts.onModeChange]
   */
  constructor(opts) {
    this.canvas = opts.canvas;
    this.orbit = opts.orbit;
    this.getCamera = opts.getCamera;
    this.canNavigate = opts.canNavigate;
    this.isGizmoBusy = opts.isGizmoBusy;
    this.onRender = opts.onRender;
    this.onInteractChange = opts.onInteractChange;
    this.onModeChange = opts.onModeChange;

    this.mode = "orbit"; // "orbit" | "fly"
    this.flySpeed = 1.0;
    this.sceneScale = 4.0;
    this.flyMinSpeed = 0.08;
    this.flyDefaultSpeed = 0.85;
    this.flyMaxSpeed = 4.5;
    this.flyStep = 0.05;
    this.flySpeedMps = 0.85;
    this.calibratedSpan = 4.0;

    // Configure crisp, responsive damping on OrbitControls (we handle smooth wheel zoom ourselves!)
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.14;
    this.orbit.enableZoom = false; // replaced with silky exponential wheel zoom below

    // Smooth wheel zoom state (Orbit perspective distance & ortho zoom)
    this._zoomTargetDist = null;
    this._zoomTargetOrtho = null;

    // Fly mode smooth state
    this._yaw = 0;
    this._pitch = 0;
    this._targetYaw = 0;
    this._targetPitch = 0;
    this._flyVel = new T.Vector3();
    this._flyDragBtn = -1;
    this._lastX = 0;
    this._lastY = 0;
    this._keys = new Set();
    this._shiftDown = false;
    this._altDown = false;

    // Quintic pose transition state (Axis Sphere click, double-click focus, Space fit-camera)
    this._poseAnim = null;

    // Unified demand-driven animation & damping settle loop
    this._animRaf = null;
    this._lastAnimTs = 0;
    this._prevCamPos = new T.Vector3();
    this._prevTarget = new T.Vector3();
    this._dampingWarmFrames = 0;

    this._wheelTimer = null;
    this._pointerActive = false;
    this._wheelActive = false;
    this._keysActive = false;
    this._interacting = false;

    this._bindEvents();
  }

  setSceneScale(span) {
    this.sceneScale = Math.max(0.15, Math.min(2000, Number(span) || 4.0));
  }

  /**
   * Calibrate Fly Camera min/default/max physical speed (m/s) once from initial loaded model diagonal span.
   * Default traverses full model in ~5.5s; max traverses full model in ~1s (plus 2.8x Shift / 0.3x Alt).
   */
  calibrateFlySpeedFromSpan(span) {
    const s = Math.max(0.15, Number(span) || 4.0);
    this.calibratedSpan = s;
    const defaultSpeed = roundNiceSpeed(Math.max(0.05, s * 0.18));
    const maxSpeed = roundNiceSpeed(Math.max(defaultSpeed * 5, s * 1.0));
    const step = roundNiceSpeed(Math.max(0.005, maxSpeed / 100));
    // Snap minSpeed to a clean multiple of step so dragging slider to right end hits exact maxSpeed!
    const rawMin = Math.max(step, Math.min(defaultSpeed * 0.1, defaultSpeed * 0.25));
    const minSpeed = Number((Math.max(1, Math.round(rawMin / step)) * step).toFixed(4));
    this.flyMinSpeed = minSpeed;
    this.flyDefaultSpeed = defaultSpeed;
    this.flyMaxSpeed = maxSpeed;
    this.flyStep = step;
    this.flySpeedMps = defaultSpeed;
    return this.getFlySpeedConfig();
  }

  setFlySpeedMps(speed) {
    const v = Number(speed);
    if (!Number.isFinite(v)) return this.flySpeedMps;
    this.flySpeedMps = Math.max(this.flyMinSpeed, Math.min(this.flyMaxSpeed, v));
    return this.flySpeedMps;
  }

  getFlySpeedConfig() {
    return {
      min: this.flyMinSpeed,
      max: this.flyMaxSpeed,
      step: this.flyStep,
      defaultSpeed: this.flyDefaultSpeed,
      value: this.flySpeedMps,
      span: this.calibratedSpan,
    };
  }

  isAnimating() {
    return !!(
      this._poseAnim ||
      this._zoomTargetDist !== null ||
      this._zoomTargetOrtho !== null ||
      this._flyVel.lengthSq() > 1e-8 ||
      this._dampingWarmFrames > 0 ||
      this._interacting
    );
  }

  cancelAnimation() {
    this._poseAnim = null;
    this._zoomTargetDist = null;
    this._zoomTargetOrtho = null;
  }

  snapImmediate() {
    this.cancelAnimation();
    this._flyVel.set(0, 0, 0);
    this._dampingWarmFrames = 0;
    this._stopAnimLoop();
    const cam = this.getCamera();
    if (cam) {
      this._prevCamPos.copy(cam.position);
      this._prevTarget.copy(this.orbit.target);
    }
  }

  /**
   * Smoothly orbit/glide camera to a new world (position, target, up) using ReSplat-style quintic ease-out.
   * Uses spherical interpolation around the target so Axis Sphere snaps glide gracefully around the model.
   */
  animateToPose({ position, target, up = null, durationSec = 0.30 }) {
    const cam = this.getCamera();
    if (!cam) return;
    this._zoomTargetDist = null;
    this._zoomTargetOrtho = null;

    const startTarget = this.orbit.target.clone();
    const endTarget = target ? target.clone() : startTarget.clone();
    const startOffset = cam.position.clone().sub(startTarget);
    const endOffset = position.clone().sub(endTarget);

    const startDist = Math.max(0.02, startOffset.length());
    const endDist = Math.max(0.02, endOffset.length());

    // Strict +Y-up spherical coordinates: azim in XZ plane, elev from XZ plane [-pi/2, +pi/2]
    const sAzim = Math.atan2(startOffset.x, startOffset.z);
    const sElev = Math.asin(Math.max(-0.9995, Math.min(0.9995, startOffset.y / startDist)));
    const eAzim = Math.atan2(endOffset.x, endOffset.z);
    const eElev = Math.asin(Math.max(-0.9995, Math.min(0.9995, endOffset.y / endDist)));

    // Keep shortest angular arc
    const dAzim = normalizeAngleDelta(eAzim - sAzim);
    const startUp = cam.up.clone().normalize();
    const endUp = up ? up.clone().normalize() : new T.Vector3(0, 1, 0);

    this._poseAnim = {
      kind: "spherical",
      elapsed: 0,
      duration: Math.max(0.08, durationSec),
      startTarget,
      endTarget,
      sAzim,
      dAzim,
      sElev,
      eElev,
      startDist,
      endDist,
      startUp,
      endUp,
    };
    this._updateInteracting(false);
    this._ensureAnimLoop();
  }

  /**
   * Smoothly glide camera focal target to `newTarget` while preserving viewing direction/distance
   * (used for double-click point focus!).
   */
  animateTargetTo(newTarget, durationSec = 0.26) {
    const cam = this.getCamera();
    if (!cam) return;
    const offset = cam.position.clone().sub(this.orbit.target);
    const endTarget = newTarget.clone();
    const endPos = endTarget.clone().add(offset);
    this._zoomTargetDist = null;
    this._zoomTargetOrtho = null;

    this._poseAnim = {
      kind: "linear",
      elapsed: 0,
      duration: Math.max(0.08, durationSec),
      startTarget: this.orbit.target.clone(),
      endTarget,
      startPos: cam.position.clone(),
      endPos,
      startUp: cam.up.clone().normalize(),
      endUp: cam.up.clone().normalize(),
    };
    this._updateInteracting(false);
    this._ensureAnimLoop();
  }

  /**
   * Smoothly snap camera onto a cardinal axis direction (+X, -X, +Y, -Y, +Z, -Z) around current target.
   */
  animateToAxis(dir, durationSec = 0.28) {
    const cam = this.getCamera();
    if (!cam) return;
    const dist = Math.max(0.5, cam.position.distanceTo(this.orbit.target));
    const endPos = this.orbit.target.clone().addScaledVector(dir, dist);
    const endUp = Math.abs(dir.y) > 0.9
      ? new T.Vector3(0, 0, dir.y > 0 ? -1 : 1)
      : new T.Vector3(0, 1, 0);
    this.animateToPose({
      position: endPos,
      target: this.orbit.target.clone(),
      up: endUp,
      durationSec,
    });
  }

  _updateInteracting(forceEndSort = false) {
    const next = this._pointerActive || this._wheelActive || this._keysActive || !!this._poseAnim;
    if (next !== this._interacting) {
      this._interacting = next;
      if (typeof this.onInteractChange === "function") this.onInteractChange(next);
      if (!next && forceEndSort) this.onRender(true);
    }
  }

  _syncYawPitchFromCamera() {
    const cam = this.getCamera();
    const dir = new T.Vector3();
    cam.getWorldDirection(dir);
    dir.normalize();
    this._pitch = Math.asin(Math.max(-0.999, Math.min(0.999, dir.y)));
    this._yaw = Math.atan2(-dir.x, -dir.z);
    this._targetPitch = this._pitch;
    this._targetYaw = this._yaw;
  }

  _applyYawPitchToCamera() {
    const cam = this.getCamera();
    const cp = Math.cos(this._pitch);
    const dir = new T.Vector3(-Math.sin(this._yaw) * cp, Math.sin(this._pitch), -Math.cos(this._yaw) * cp);
    const dist = Math.max(0.5, cam.position.distanceTo(this.orbit.target));
    this.orbit.target.copy(cam.position).addScaledVector(dir, dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.orbit.target);
    cam.updateMatrixWorld();
  }

  setMode(nextMode) {
    const normalized = nextMode === "fly" ? "fly" : "orbit";
    if (normalized === this.mode) return;
    this.mode = normalized;
    this.cancelAnimation();
    this._keys.clear();
    this._keysActive = false;
    this._flyDragBtn = -1;
    this._flyVel.set(0, 0, 0);
    this._pointerActive = false;
    this._dampingWarmFrames = 0;

    if (this.mode === "fly") {
      this._syncYawPitchFromCamera();
      this.orbit.enabled = false;
    } else {
      this.orbit.enabled = !this.isGizmoBusy();
      this.orbit.update();
    }
    this._updateInteracting(true);
    if (typeof this.onModeChange === "function") this.onModeChange(this.mode);
    this.onRender(true);
  }

  syncOrbitEnabled(enabled) {
    if (this.mode === "orbit") {
      this.orbit.enabled = !!enabled;
    } else {
      this.orbit.enabled = false;
    }
  }

  _markWheelPulse() {
    this._wheelActive = true;
    this._updateInteracting(false);
    if (this._wheelTimer) clearTimeout(this._wheelTimer);
    this._wheelTimer = setTimeout(() => {
      this._wheelTimer = null;
      this._wheelActive = false;
      this._updateInteracting(false);
    }, 180);
  }

  _ensureAnimLoop() {
    if (this._animRaf !== null) return;
    const cam = this.getCamera();
    if (cam) {
      this._prevCamPos.copy(cam.position);
      this._prevTarget.copy(this.orbit.target);
    }
    this._lastAnimTs = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - this._lastAnimTs) / 1000));
      this._lastAnimTs = now;
      const c = this.getCamera();
      let keepAlive = false;

      // 1. Quintic Pose Flight Animation (Axis Sphere / Double-Click Focus / Fit Camera)
      if (this._poseAnim && c) {
        const a = this._poseAnim;
        a.elapsed = Math.min(a.duration, a.elapsed + dt);
        const k = quinticEaseOut(a.elapsed / a.duration);

        if (a.kind === "spherical") {
          const tNow = new T.Vector3().lerpVectors(a.startTarget, a.endTarget, k);
          const az = a.sAzim + a.dAzim * k;
          const el = a.sElev + (a.eElev - a.sElev) * k;
          const dist = a.startDist + (a.endDist - a.startDist) * k;
          const ce = Math.cos(el);
          c.position.set(
            tNow.x + Math.sin(az) * ce * dist,
            tNow.y + Math.sin(el) * dist,
            tNow.z + Math.cos(az) * ce * dist,
          );
          this.orbit.target.copy(tNow);
          c.up.lerpVectors(a.startUp, a.endUp, k).normalize();
          c.lookAt(this.orbit.target);
        } else {
          this.orbit.target.lerpVectors(a.startTarget, a.endTarget, k);
          c.position.lerpVectors(a.startPos, a.endPos, k);
          c.up.lerpVectors(a.startUp, a.endUp, k).normalize();
          c.lookAt(this.orbit.target);
        }
        c.updateMatrixWorld();

        if (a.elapsed >= a.duration) {
          this._poseAnim = null;
          // Reset OrbitControls internal spherical delta so damping doesn't fight end pose
          const prevDamp = this.orbit.enableDamping;
          this.orbit.enableDamping = false;
          this.orbit.update();
          this.orbit.enableDamping = prevDamp;
          this._updateInteracting(false);
          this.onRender(true);
        } else {
          keepAlive = true;
          this.onRender(false);
        }
      } else if (this.mode === "orbit" && c) {
        // 2. Smooth Exponential Scroll-Wheel Zoom (zero choppy discrete notch jumps!)
        const zoomBlend = 1 - Math.exp(-15 * dt);
        if (this._zoomTargetDist !== null && !c.isOrthographicCamera) {
          const offset = c.position.clone().sub(this.orbit.target);
          const curDist = offset.length();
          const diff = this._zoomTargetDist - curDist;
          if (Math.abs(diff) <= Math.max(1e-4, curDist * 0.0008)) {
            offset.setLength(this._zoomTargetDist);
            c.position.copy(this.orbit.target).add(offset);
            this._zoomTargetDist = null;
          } else {
            offset.setLength(curDist + diff * zoomBlend);
            c.position.copy(this.orbit.target).add(offset);
            keepAlive = true;
          }
        } else if (this._zoomTargetOrtho !== null && c.isOrthographicCamera) {
          const diff = this._zoomTargetOrtho - c.zoom;
          if (Math.abs(diff) <= Math.max(1e-4, c.zoom * 0.001)) {
            c.zoom = this._zoomTargetOrtho;
            c.updateProjectionMatrix();
            this._zoomTargetOrtho = null;
          } else {
            c.zoom += diff * zoomBlend;
            c.updateProjectionMatrix();
            keepAlive = true;
          }
        }

        // 3. OrbitControls Damping Tick (smooth ease-out after drag/pan release!)
        if (this.orbit.enabled && this.orbit.enableDamping) {
          this.orbit.update();
          const posMoved = c.position.distanceToSquared(this._prevCamPos);
          const tgtMoved = this.orbit.target.distanceToSquared(this._prevTarget);
          const eps = Math.max(1e-9, this.sceneScale * this.sceneScale * 1e-10);
          if (posMoved > eps || tgtMoved > eps) {
            keepAlive = true;
          }
        }

        if (this._pointerActive || this._wheelActive) keepAlive = true;
        if (this._dampingWarmFrames > 0) {
          this._dampingWarmFrames--;
          keepAlive = true;
        }
        this._prevCamPos.copy(c.position);
        this._prevTarget.copy(this.orbit.target);
        this.onRender(false);
      } else if (this.mode === "fly" && c) {
        // 4. Fly Mode Smooth Look + Smooth WASD/QE Velocity Inertia
        const lookBlend = 1 - Math.exp(-24 * dt);
        const dyaw = normalizeAngleDelta(this._targetYaw - this._yaw);
        const dpitch = this._targetPitch - this._pitch;
        if (Math.abs(dyaw) > 1e-5 || Math.abs(dpitch) > 1e-5) {
          this._yaw += dyaw * lookBlend;
          this._pitch += dpitch * lookBlend;
          this._applyYawPitchToCamera();
          keepAlive = true;
        }

        // Compute desired WASD+QE velocity vector
        const desired = new T.Vector3();
        if (this._keys.size > 0) {
          const forward = new T.Vector3();
          c.getWorldDirection(forward).normalize();
          const right = new T.Vector3().crossVectors(forward, new T.Vector3(0, 1, 0));
          if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
          else right.normalize();

          if (this._keys.has("w") || this._keys.has("arrowup")) desired.add(forward);
          if (this._keys.has("s") || this._keys.has("arrowdown")) desired.sub(forward);
          if (this._keys.has("d") || this._keys.has("arrowright")) desired.add(right);
          if (this._keys.has("a") || this._keys.has("arrowleft")) desired.sub(right);
          if (this._keys.has("e")) desired.y += 1;
          if (this._keys.has("q")) desired.y -= 1;

          if (desired.lengthSq() > 1e-6) {
            const boost = this._shiftDown ? 2.8 : this._altDown ? 0.3 : 1.0;
            desired.normalize().multiplyScalar(this.flySpeedMps * boost);
          }
        }

        // Smooth acceleration & glide deceleration
        const velBlend = 1 - Math.exp((this._keys.size > 0 ? -14 : -10) * dt);
        this._flyVel.lerp(desired, velBlend);
        const speedSq = this._flyVel.lengthSq();
        if (speedSq > Math.max(1e-7, this.flySpeedMps * this.flySpeedMps * 1e-6)) {
          const step = this._flyVel.clone().multiplyScalar(dt);
          c.position.add(step);
          this.orbit.target.add(step);
          c.updateMatrixWorld();
          keepAlive = true;
        } else {
          this._flyVel.set(0, 0, 0);
        }

        if (this._pointerActive || this._wheelActive || this._keysActive) keepAlive = true;
        this.onRender(false);
      }

      if (keepAlive) {
        this._animRaf = requestAnimationFrame(tick);
      } else {
        this._animRaf = null;
        this._updateInteracting(false);
        // Trigger ONE exact final depth sort on settle so resting image is crystal sharp!
        this.onRender(true);
      }
    };
    this._animRaf = requestAnimationFrame(tick);
  }

  _stopAnimLoop() {
    if (this._animRaf !== null) {
      cancelAnimationFrame(this._animRaf);
      this._animRaf = null;
    }
  }

  _bindEvents() {
    this.orbit.addEventListener("start", () => {
      if (this.mode !== "orbit") return;
      this.cancelAnimation();
      this._pointerActive = true;
      this._dampingWarmFrames = 4;
      this._updateInteracting(false);
      this._ensureAnimLoop();
    });
    this.orbit.addEventListener("change", () => {
      if (this.mode !== "orbit") return;
      if (this._animRaf === null) {
        this.onRender(false);
      }
    });
    this.orbit.addEventListener("end", () => {
      if (this.mode !== "orbit") return;
      this._pointerActive = false;
      this._dampingWarmFrames = 6; // Let damping glide smoothly to rest before settling
      this._updateInteracting(false);
      this._ensureAnimLoop();
    });

    // Smooth wheel zoom in Orbit mode & smooth forward/back glide in Fly mode
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        if (this.isGizmoBusy()) return;
        e.preventDefault();
        this._poseAnim = null;
        this._markWheelPulse();
        const cam = this.getCamera();
        if (!cam) return;

        // Normalize pixel/line/page wheel deltas so trackpad & notched mice both feel silky!
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 32;
        else if (e.deltaMode === 2) dy *= 240;
        dy = Math.max(-280, Math.min(280, dy));

        if (this.mode === "fly") {
          const dir = new T.Vector3();
          cam.getWorldDirection(dir);
          const impulse = (-dy / 120) * this.flySpeedMps * 0.9 * (e.shiftKey ? 2.4 : 1.0);
          this._flyVel.addScaledVector(dir, impulse);
          this._ensureAnimLoop();
          return;
        }

        // Orbit mode: silky exponential zoom target
        const zoomFactor = Math.exp(dy * 0.00145);
        if (cam.isOrthographicCamera) {
          const baseZoom = this._zoomTargetOrtho !== null ? this._zoomTargetOrtho : cam.zoom;
          this._zoomTargetOrtho = Math.max(0.01, Math.min(200, baseZoom / zoomFactor));
        } else {
          const curDist = cam.position.distanceTo(this.orbit.target);
          const baseDist = this._zoomTargetDist !== null ? this._zoomTargetDist : curDist;
          const minD = Math.max(0.01, this.sceneScale * 0.002);
          const maxD = Math.max(200, this.sceneScale * 60);
          this._zoomTargetDist = Math.max(minD, Math.min(maxD, baseDist * zoomFactor));
        }
        this._ensureAnimLoop();
      },
      { passive: false },
    );

    // Fly mode pointer look / pan
    this.canvas.addEventListener("pointerdown", (e) => {
      if (this.mode !== "fly" || this.isGizmoBusy()) return;
      if (e.button === 0 && !this.canNavigate()) return;
      if (e.button === 0 || e.button === 1 || e.button === 2) {
        this.cancelAnimation();
        this._flyDragBtn = e.button;
        this._lastX = e.clientX;
        this._lastY = e.clientY;
        this._syncYawPitchFromCamera();
        this._pointerActive = true;
        this._updateInteracting(false);
        this._ensureAnimLoop();
      }
    });

    window.addEventListener("pointermove", (e) => {
      if (this.mode !== "fly" || this._flyDragBtn < 0) return;
      const dx = e.clientX - this._lastX;
      const dy = e.clientY - this._lastY;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;

      if (this._flyDragBtn === 0) {
        const sens = 0.0036;
        this._targetYaw -= dx * sens;
        this._targetPitch = Math.max(-1.55, Math.min(1.55, this._targetPitch - dy * sens));
        this._ensureAnimLoop();
      } else {
        const cam = this.getCamera();
        const right = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
        const up = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
        const panScale = this.flySpeedMps * 0.004;
        const delta = new T.Vector3()
          .addScaledVector(right, -dx * panScale)
          .addScaledVector(up, dy * panScale);
        cam.position.add(delta);
        this.orbit.target.add(delta);
        cam.updateMatrixWorld();
        this._ensureAnimLoop();
      }
    });

    window.addEventListener("pointerup", () => {
      if (this._flyDragBtn < 0) return;
      this._flyDragBtn = -1;
      this._pointerActive = false;
      this._updateInteracting(false);
      this._ensureAnimLoop();
    });

    const FLY_KEYS = new Set(["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright"]);
    window.addEventListener("keydown", (e) => {
      if (this.mode !== "fly") return;
      this._shiftDown = e.shiftKey;
      this._altDown = e.altKey;
      if (e.ctrlKey || e.metaKey) return;
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const k = e.key.toLowerCase();
      if (!FLY_KEYS.has(k)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancelAnimation();
      this._keys.add(k);
      this._keysActive = true;
      this._updateInteracting(false);
      this._ensureAnimLoop();
    }, true);

    window.addEventListener("keyup", (e) => {
      if (this.mode !== "fly") return;
      this._shiftDown = e.shiftKey;
      this._altDown = e.altKey;
      const k = e.key.toLowerCase();
      if (this._keys.delete(k) && this._keys.size === 0) {
        this._keysActive = false;
        this._updateInteracting(false);
        this._ensureAnimLoop(); // Smooth deceleration tail!
      }
    });

    window.addEventListener("blur", () => {
      this._shiftDown = false;
      this._altDown = false;
      if (this._keys.size > 0) {
        this._keys.clear();
        this._keysActive = false;
        this._flyVel.set(0, 0, 0);
        this._updateInteracting(true);
      }
    });
  }
}
