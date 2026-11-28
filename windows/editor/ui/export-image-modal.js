// Export Current View Image Modal Controller (Exact Resolution + Transparent PNG + Helper Hiding).
import * as T from "three";
import { encodePng, uint8ToBase64 } from "../png-writer.js";
import { t } from "../i18n.js";

export function installExportImageModal(deps) {
  const {
    $,
    stage,
    renderer,
    scene,
    perspCam,
    orthoCam,
    getCamera,
    getCloud,
    getDisplayMode,
    getCurrentFileName,
    watchdog,
    infiniteGrid,
    modelBounds,
    volumeMgr,
    gizmo,
    markersGroup,
    measureMgr,
    updateOrthoFrustum,
    syncObjectMatrices,
    openModal,
    closeModal,
    closeAllMenus,
    postHost,
    setStatus,
    requestRender,
  } = deps;

  function openExportImageModal() {
    const w = Math.max(128, Math.round(stage.clientWidth));
    const h = Math.max(128, Math.round(stage.clientHeight));
    $("img-w").value = String(w);
    $("img-h").value = String(h);
    openModal("modal-export-image");
  }

  for (const chip of document.querySelectorAll("#img-res-presets button")) {
    chip.onclick = () => {
      const v = chip.dataset.res;
      if (v === "current") {
        $("img-w").value = String(Math.max(128, Math.round(stage.clientWidth)));
        $("img-h").value = String(Math.max(128, Math.round(stage.clientHeight)));
      } else {
        const [rw, rh] = v.split("x");
        $("img-w").value = rw;
        $("img-h").value = rh;
      }
    };
  }

  $("act-export-view").onclick = () => { closeAllMenus(); openExportImageModal(); };
  $("btn-export-img-top").onclick = openExportImageModal;

  $("btn-confirm-export-image").onclick = async () => {
    const w = Math.max(128, Math.min(7680, Number($("img-w").value) || 1920));
    const h = Math.max(128, Math.min(4320, Number($("img-h").value) || 1080));
    const transparentBg = $("img-transparent").checked;
    const hideHelpers = $("img-hide-helpers").checked;
    const cloud = getCloud();
    const camera = getCamera();

    watchdog.setPaused(true);
    closeModal("modal-export-image");

    const prevGrid = infiniteGrid.visible;
    const prevBounds = modelBounds.visible;
    const prevVol = volumeMgr.container.visible;
    const prevGiz = gizmo.visible;
    const prevMarkers = markersGroup.visible;
    const prevMeasureVis = measureMgr.rootGroup.visible;
    const prevHideSel = cloud ? cloud.material.uniforms.uHideSelectionHighlight.value : 0;
    const prevClearCol = new T.Color();
    renderer.getClearColor(prevClearCol);
    const prevClearAlpha = renderer.getClearAlpha();
    const prevPerspAspect = perspCam.aspect;
    const prevOrtho = [orthoCam.left, orthoCam.right, orthoCam.top, orthoCam.bottom];

    let rt = null;
    try {
      if (hideHelpers) {
        infiniteGrid.visible = false;
        modelBounds.visible = false;
        volumeMgr.setHelpersVisible(false);
        gizmo.visible = false;
        markersGroup.visible = false;
        measureMgr.setHelpersVisible(false);
        if (cloud) cloud.material.uniforms.uHideSelectionHighlight.value = 1.0;
      }

      perspCam.aspect = w / h;
      perspCam.updateProjectionMatrix();
      updateOrthoFrustum(w, h);

      rt = new T.WebGLRenderTarget(w, h, {
        minFilter: T.LinearFilter,
        magFilter: T.LinearFilter,
        format: T.RGBAFormat,
        type: T.UnsignedByteType,
        depthBuffer: true,
      });

      if (cloud) {
        syncObjectMatrices();
        cloud.prepareDraw(cloud.n, getDisplayMode(), camera, w, h, true);
      }

      renderer.setRenderTarget(rt);
      renderer.setClearColor(transparentBg ? 0x000000 : 0x15171b, transparentBg ? 0 : 1);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);

      const glPixels = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, glPixels);

      const topDown = new Uint8Array(w * h * 4);
      const rowBytes = w * 4;
      for (let y = 0; y < h; y++) {
        const srcRow = (h - 1 - y) * rowBytes;
        const dstRow = y * rowBytes;
        for (let x = 0; x < rowBytes; x += 4) {
          const a = glPixels[srcRow + x + 3];
          if (transparentBg && a > 0 && a < 255) {
            const invA = 255 / a;
            topDown[dstRow + x] = Math.min(255, Math.round(glPixels[srcRow + x] * invA));
            topDown[dstRow + x + 1] = Math.min(255, Math.round(glPixels[srcRow + x + 1] * invA));
            topDown[dstRow + x + 2] = Math.min(255, Math.round(glPixels[srcRow + x + 2] * invA));
            topDown[dstRow + x + 3] = a;
          } else {
            topDown[dstRow + x] = glPixels[srcRow + x];
            topDown[dstRow + x + 1] = glPixels[srcRow + x + 1];
            topDown[dstRow + x + 2] = glPixels[srcRow + x + 2];
            topDown[dstRow + x + 3] = transparentBg ? a : 255;
          }
        }
      }

      const pngBytes = await encodePng(topDown, w, h);
      const base64 = uint8ToBase64(pngBytes);
      if (window.chrome?.webview) {
        postHost("exportImage:" + JSON.stringify({ base64, width: w, height: h }));
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([pngBytes], { type: "image/png" }));
        a.download = getCurrentFileName().replace(/\.[^.]+$/, "") + "-view.png";
        a.click();
      }
      setStatus(t("editor.status.viewImageRendered", { w, h }));
    } catch (err) {
      setStatus(t("editor.status.viewImageFailed", { error: err.message }));
    } finally {
      if (rt) rt.dispose();
      renderer.setRenderTarget(null);
      renderer.setClearColor(prevClearCol, prevClearAlpha);
      infiniteGrid.visible = prevGrid;
      modelBounds.visible = prevBounds;
      volumeMgr.setHelpersVisible(prevVol);
      gizmo.visible = prevGiz;
      markersGroup.visible = prevMarkers;
      measureMgr.setHelpersVisible(prevMeasureVis);
      if (cloud) cloud.material.uniforms.uHideSelectionHighlight.value = prevHideSel;
      perspCam.aspect = prevPerspAspect;
      perspCam.updateProjectionMatrix();
      orthoCam.left = prevOrtho[0];
      orthoCam.right = prevOrtho[1];
      orthoCam.top = prevOrtho[2];
      orthoCam.bottom = prevOrtho[3];
      orthoCam.updateProjectionMatrix();
      watchdog.setPaused(false);
      requestRender(true);
    }
  };

  return { openExportImageModal };
}
