// +Y-Up Alignment & Measure Bottom-Bar Controller (Smooth Quintic Ease-Out + Auto-Align Prompt + Flip/Undo/Repick).
import * as T from "three";
import { computeAutoAlign, computeOpenCvToYUp } from "../alignment.js";
import { t } from "../i18n.js";

export function createAlignmentController(deps) {
  const {
    $,
    getCloud,
    getSceneObjects,
    getEffectiveSelectedObjectIds,
    captureTransformSnapshot,
    applyTransformSnapshot,
    syncObjectMatrices,
    syncTransformInputs,
    fitCameraToCloud,
    requestRender,
    history,
    modelBounds,
    setContextBar,
    setStatus,
    clearMarkers,
    getAlignPoints,
    resetAlignPoints,
    getAlignAppliedState,
    setAlignAppliedState,
    measureMgr,
    setActiveTool,
  } = deps;

  let activeTransformAnim = null;

  function cancelActiveTransformAnim() {
    if (activeTransformAnim && activeTransformAnim.rafId) {
      cancelAnimationFrame(activeTransformAnim.rafId);
    }
    activeTransformAnim = null;
  }

  function showAutoAlignPrompt(info) {
    const el = $("auto-align-prompt");
    const desc = $("auto-align-prompt-desc");
    if (!el) return;
    if (desc && info && typeof info.tiltDeg === "number") {
      desc.textContent = t("editor.banners.autoAlignDescDeg", { deg: info.tiltDeg.toFixed(1) });
    }
    el.classList.remove("hidden");
  }

  function hideAutoAlignPrompt() {
    $("auto-align-prompt")?.classList.add("hidden");
  }

  $("btn-auto-align-accept")?.addEventListener("click", () => {
    hideAutoAlignPrompt();
    executeAutoAlign({ animated: true });
  });
  $("btn-auto-align-dismiss")?.addEventListener("click", () => {
    hideAutoAlignPrompt();
  });

  function applyRigidDeltaToSelectedObjects(deltaMat, label, { animated = false, durationSec = 0.34, fitAfter = true } = {}) {
    cancelActiveTransformAnim();
    const before = captureTransformSnapshot();
    const targetIds = getEffectiveSelectedObjectIds();
    const nodes = getSceneObjects()
      .filter((o) => targetIds.size === 0 || targetIds.has(o.id))
      .map((o) => o.node);

    const startStates = [];
    const endStates = [];
    const nextWorld = new T.Matrix4();
    const parentInv = new T.Matrix4();
    const nextLocal = new T.Matrix4();

    for (const node of nodes) {
      node.updateMatrixWorld(true);
      startStates.push({
        node,
        pos: node.position.clone(),
        quat: node.quaternion.clone(),
        scale: node.scale.clone(),
      });
      nextWorld.multiplyMatrices(deltaMat, node.matrixWorld);
      if (node.parent) {
        node.parent.updateMatrixWorld(true);
        parentInv.copy(node.parent.matrixWorld).invert();
        nextLocal.multiplyMatrices(parentInv, nextWorld);
      } else {
        nextLocal.copy(nextWorld);
      }
      const ep = new T.Vector3();
      const eq = new T.Quaternion();
      const es = new T.Vector3();
      nextLocal.decompose(ep, eq, es);
      endStates.push({ node, pos: ep, quat: eq, scale: es });
      node.position.copy(ep);
      node.quaternion.copy(eq);
      node.scale.copy(es);
    }

    const after = captureTransformSnapshot();
    history.push({
      label,
      undo: () => {
        cancelActiveTransformAnim();
        applyTransformSnapshot(before);
        syncTransformInputs();
        requestRender(true);
      },
      redo: () => {
        cancelActiveTransformAnim();
        applyTransformSnapshot(after);
        syncTransformInputs();
        requestRender(true);
      },
      journalEntry: { type: "transform", snapshot: after },
    });

    if (!animated || durationSec <= 0.02 || nodes.length === 0) {
      syncObjectMatrices(true);
      syncTransformInputs();
      if (fitAfter) fitCameraToCloud(false);
      requestRender(true);
      return;
    }

    for (const st of startStates) {
      st.node.position.copy(st.pos);
      st.node.quaternion.copy(st.quat);
      st.node.scale.copy(st.scale);
    }
    syncObjectMatrices(false);

    const startMs = performance.now();
    const durMs = Math.max(120, durationSec * 1000);
    const animState = { rafId: 0 };
    activeTransformAnim = animState;

    const step = (now) => {
      if (activeTransformAnim !== animState) return;
      const rawT = Math.min(1, Math.max(0, (now - startMs) / durMs));
      const u = rawT - 1;
      const ease = 1 + u * u * u * u * u;
      for (let i = 0; i < startStates.length; i++) {
        const a = startStates[i];
        const b = endStates[i];
        a.node.position.lerpVectors(a.pos, b.pos, ease);
        a.node.quaternion.slerpQuaternions(a.quat, b.quat, ease);
        a.node.scale.lerpVectors(a.scale, b.scale, ease);
      }
      if (rawT < 1) {
        syncObjectMatrices(false);
        syncTransformInputs();
        requestRender(false);
        animState.rafId = requestAnimationFrame(step);
      } else {
        activeTransformAnim = null;
        for (const b of endStates) {
          b.node.position.copy(b.pos);
          b.node.quaternion.copy(b.quat);
          b.node.scale.copy(b.scale);
        }
        syncObjectMatrices(true);
        syncTransformInputs();
        if (fitAfter) fitCameraToCloud(true);
        requestRender(true);
      }
    };
    animState.rafId = requestAnimationFrame(step);
  }

  function executeAutoAlign({ animated = false } = {}) {
    const cloud = getCloud();
    if (!cloud) return;
    hideAutoAlignPrompt();
    try {
      syncObjectMatrices(true);
      const res = computeAutoAlign(cloud, getEffectiveSelectedObjectIds());
      applyRigidDeltaToSelectedObjects(res.deltaMat, t("editor.history.autoAlign"), { animated, durationSec: 0.36, fitAfter: true });
      setStatus(
        t("editor.status.autoAlignDone", {
          detail: res.wallDetected ? t("editor.status.autoAlignWall") : t("editor.status.autoAlignCentered"),
        }),
      );
    } catch (err) {
      setStatus(t("editor.status.autoAlignFailed", { error: err.message }));
    }
  }

  function executeOpenCvToZUp() {
    const cloud = getCloud();
    if (!cloud) return;
    syncObjectMatrices(true);
    const deltaMat = computeOpenCvToYUp(cloud, getEffectiveSelectedObjectIds());
    applyRigidDeltaToSelectedObjects(deltaMat, t("editor.history.opencvZup"), { animated: true, durationSec: 0.34, fitAfter: true });
    setStatus(t("editor.status.opencvZupDone"));
  }

  function flipLastAligned180(label = null) {
    const effLabel = label || t("editor.history.flip180");
    const st = getAlignAppliedState();
    const pivotPt = st?.pivot ? st.pivot.clone() : (modelBounds.getCenter() || new T.Vector3(0, 0, 0));
    const flipMat = new T.Matrix4()
      .makeTranslation(pivotPt.x, pivotPt.y, pivotPt.z)
      .multiply(new T.Matrix4().makeRotationX(Math.PI))
      .multiply(new T.Matrix4().makeTranslation(-pivotPt.x, -pivotPt.y, -pivotPt.z));
    applyRigidDeltaToSelectedObjects(flipMat, effLabel, { animated: true, durationSec: 0.34, fitAfter: false });
  }

  function showVerticalAlignContextBar() {
    setContextBar("align", (el) => {
      const title = document.createElement("span");
      title.className = "ctx-title";
      title.textContent = t("editor.rail.verticalAlignFull");
      el.appendChild(title);

      const st = getAlignAppliedState();
      if (st && st.tool === "verticalAlign") {
        const info = document.createElement("span");
        info.className = "ctx-param";
        info.textContent = t("editor.contextBar.verticalDone");

        const btnFlip = document.createElement("button");
        btnFlip.className = "mini-btn";
        btnFlip.textContent = t("editor.contextBar.flipVertical");
        btnFlip.onclick = () => flipLastAligned180(t("editor.history.verticalFlip"));

        const btnUndo = document.createElement("button");
        btnUndo.className = "mini-btn";
        btnUndo.textContent = t("editor.contextBar.undoShort");
        btnUndo.onclick = () => {
          history.undo();
          setAlignAppliedState(null);
          resetAlignPoints();
          clearMarkers();
          showVerticalAlignContextBar();
          requestRender(true);
        };

        const btnRepick = document.createElement("button");
        btnRepick.className = "primary-pill";
        btnRepick.textContent = t("editor.contextBar.repick");
        btnRepick.onclick = () => {
          setAlignAppliedState(null);
          resetAlignPoints();
          clearMarkers();
          showVerticalAlignContextBar();
          requestRender();
        };

        el.append(info, btnFlip, btnUndo, btnRepick);
        return;
      }

      const pts = getAlignPoints();
      const info = document.createElement("span");
      info.className = "ctx-param";
      info.textContent = pts.length === 0 ? t("editor.contextBar.verticalStep0") : t("editor.contextBar.verticalStep1");

      const btnRepick = document.createElement("button");
      btnRepick.className = "mini-btn";
      btnRepick.textContent = t("editor.contextBar.repick");
      btnRepick.disabled = pts.length === 0;
      btnRepick.onclick = () => {
        resetAlignPoints();
        clearMarkers();
        showVerticalAlignContextBar();
        requestRender();
      };

      el.append(info, btnRepick);
    }, "align:verticalAlign");
  }

  function showGroundAlignContextBar() {
    setContextBar("align", (el) => {
      const title = document.createElement("span");
      title.className = "ctx-title";
      title.textContent = t("editor.rail.groundAlignFull");
      el.appendChild(title);

      const st = getAlignAppliedState();
      if (st && st.tool === "groundAlign") {
        const info = document.createElement("span");
        info.className = "ctx-param";
        info.textContent = t("editor.contextBar.groundDone");

        const btnFlip = document.createElement("button");
        btnFlip.className = "mini-btn";
        btnFlip.textContent = t("editor.contextBar.flipVertical");
        btnFlip.onclick = () => flipLastAligned180(t("editor.history.groundFlip"));

        const btnUndo = document.createElement("button");
        btnUndo.className = "mini-btn";
        btnUndo.textContent = t("editor.contextBar.undoShort");
        btnUndo.onclick = () => {
          history.undo();
          setAlignAppliedState(null);
          resetAlignPoints();
          clearMarkers();
          showGroundAlignContextBar();
          requestRender(true);
        };

        const btnRepick = document.createElement("button");
        btnRepick.className = "primary-pill";
        btnRepick.textContent = t("editor.contextBar.repick");
        btnRepick.onclick = () => {
          setAlignAppliedState(null);
          resetAlignPoints();
          clearMarkers();
          showGroundAlignContextBar();
          requestRender();
        };

        el.append(info, btnFlip, btnUndo, btnRepick);
        return;
      }

      const pts = getAlignPoints();
      const info = document.createElement("span");
      info.className = "ctx-param";
      const guides = [
        t("editor.contextBar.groundStep0"),
        t("editor.contextBar.groundStep1"),
        t("editor.contextBar.groundStep2"),
      ];
      info.textContent = guides[Math.min(2, pts.length)];

      const btnRepick = document.createElement("button");
      btnRepick.className = "mini-btn";
      btnRepick.textContent = t("editor.contextBar.repick");
      btnRepick.disabled = pts.length === 0;
      btnRepick.onclick = () => {
        resetAlignPoints();
        clearMarkers();
        showGroundAlignContextBar();
        requestRender();
      };

      el.append(info, btnRepick);
    }, "align:groundAlign");
  }

  function showScaleCalibContextBar() {
    setContextBar("measure", (el) => {
      const title = document.createElement("span");
      title.className = "ctx-title";
      title.textContent = t("editor.rail.scaleCalibFull");
      const info = document.createElement("span");
      info.className = "ctx-param";
      const sc = measureMgr.scale;
      const statusTag = sc.calibrated
        ? t("editor.contextBar.calibTagCalibrated", { factor: sc.factor.toFixed(4), unit: sc.unit })
        : t("editor.contextBar.calibTagDefault", { unit: sc.unit });
      if (measureMgr.scaleCalibPoints.length === 0) info.textContent = t("editor.contextBar.calibStep0", { tag: statusTag });
      else if (measureMgr.scaleCalibPoints.length === 1) info.textContent = t("editor.contextBar.calibStep1", { tag: statusTag });
      else info.textContent = t("editor.contextBar.calibStep2", { tag: statusTag });

      const repick = document.createElement("button");
      repick.className = "mini-btn";
      repick.textContent = t("editor.contextBar.repickPoints");
      repick.onclick = () => {
        measureMgr.scaleCalibPoints = [];
        measureMgr._hideScaleCalibCard();
        measureMgr._rebuildCalibVisuals();
        measureMgr.renderSvgOverlay();
        showScaleCalibContextBar();
        requestRender();
      };

      const resetBtn = document.createElement("button");
      resetBtn.className = "mini-btn";
      resetBtn.textContent = t("editor.contextBar.resetScale1to1");
      resetBtn.disabled = !sc.calibrated && Math.abs(sc.factor - 1.0) < 1e-6;
      resetBtn.onclick = () => measureMgr.resetScaleCalibration();

      const toPen = document.createElement("button");
      toPen.className = "mini-btn";
      toPen.textContent = t("editor.contextBar.toMeasurePen");
      toPen.onclick = () => setActiveTool("smartMeasure");

      el.append(title, info, repick, resetBtn, toPen);
    }, "measure:scaleCalib");
  }

  function showSmartMeasureContextBar() {
    setContextBar("measure", (el) => {
      const title = document.createElement("span");
      title.className = "ctx-title";
      title.textContent = t("editor.rail.smartMeasureFull");
      const info = document.createElement("span");
      info.className = "ctx-param";
      const n = measureMgr.points.length;
      if (measureMgr.pickingBasePts) {
        info.textContent = t("editor.contextBar.measureBasePick", { count: measureMgr.customBasePts.length });
      } else if (measureMgr.closed) {
        info.textContent = measureMgr.subMode === "volume"
          ? t("editor.contextBar.measureVolumeMode", { count: n })
          : t("editor.contextBar.measureAreaMode", { count: n });
      } else if (n === 0) {
        info.textContent = t("editor.contextBar.measureStep0");
      } else if (n === 1) {
        info.textContent = t("editor.contextBar.measureStep1");
      } else if (n === 2) {
        info.textContent = t("editor.contextBar.measureStep2");
      } else {
        info.textContent = t("editor.contextBar.measureStepPoly", { count: n });
      }

      el.append(title, info);

      if (!measureMgr.closed && !measureMgr.pickingBasePts && n >= 3) {
        const closeBtn = document.createElement("button");
        closeBtn.id = "btn-measure-close-poly";
        closeBtn.className = "primary-pill";
        closeBtn.textContent = t("editor.contextBar.closePolygon");
        closeBtn.onclick = () => measureMgr.closePolygon();
        el.appendChild(closeBtn);
      }

      if (!measureMgr.closed && n > 0 && !measureMgr.pickingBasePts) {
        const undoPt = document.createElement("button");
        undoPt.className = "mini-btn";
        undoPt.textContent = t("editor.contextBar.undoLastPt");
        undoPt.onclick = () => measureMgr.undoLastPoint();
        el.appendChild(undoPt);
      }

      if (measureMgr.pickingBasePts) {
        const cancelBase = document.createElement("button");
        cancelBase.className = "mini-btn";
        cancelBase.textContent = t("editor.contextBar.cancelBasePick");
        cancelBase.onclick = () => measureMgr.handleEscape();
        el.appendChild(cancelBase);
      }

      const clr = document.createElement("button");
      clr.className = "mini-btn";
      clr.textContent = t("editor.contextBar.remeasure");
      clr.onclick = () => measureMgr.clearActive({ keepPinned: true });
      el.appendChild(clr);

      const calibBtn = document.createElement("button");
      calibBtn.className = "mini-btn";
      calibBtn.textContent = measureMgr.scale.calibrated
        ? t("editor.contextBar.scaleCalibFactor", { factor: measureMgr.scale.factor.toFixed(2) })
        : t("editor.rail.scaleCalibFull");
      calibBtn.onclick = () => setActiveTool("scaleCalib");
      el.appendChild(calibBtn);
    }, "measure:smartMeasure");
  }

  return {
    isAnimating: () => !!activeTransformAnim,
    cancelActiveTransformAnim,
    showAutoAlignPrompt,
    hideAutoAlignPrompt,
    applyRigidDeltaToSelectedObjects,
    executeAutoAlign,
    executeOpenCvToZUp,
    flipLastAligned180,
    showVerticalAlignContextBar,
    showGroundAlignContextBar,
    showScaleCalibContextBar,
    showSmartMeasureContextBar,
  };
}
