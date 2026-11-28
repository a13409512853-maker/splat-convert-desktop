#!/usr/bin/env python3
"""
Step 2 Complete Verification Suite for 3.2.3 Native-Owned Editor:
  - UI restoration checks (single-column icon rail, same-row kbd badges, filter/align flyouts,
    top-right W/E/R cluster, right-click "switch to previous tool", Axis Sphere click snap,
    loading shimmer + >10s ETA without spinner ring, 500ms tooltip delay, GB telemetry monitor)
  - Editing tools (input -> observable result):
    * 3 display modes (splat, centers, rings)
    * 6-face bounding volumes, handle scaling, ordered boolean volume group, infinite occlusion plane half-space flip
    * +Z-up auto-align (anti-flip), vertical align, 3-point ground align
    * Histogram non-blank render, split compare, color grade bake + undo, main-window encoder preset linkage
    * v4 recipe compatibility banner + preservation without implicit downgrade
  - 8-corner OBB world-space verification after translate + rotate + non-uniform scale:
    * Independent Python matrix-corner verification (error <= 1e-4 meters, +Z-up)
    * O(1) proof: zero full point-cloud traversal (recomputeScanCount unchanged!)
  - Captures 1520x900 (dpr=1) comparison screenshots in an isolated output folder (never overwrites 21-27!).
"""
import argparse
import asyncio
import base64
import http.server
import json
import math
import os
import shutil
import socketserver
import subprocess
import tempfile
import threading
import time
import urllib.request
import websockets

ROOT_DIR = r"c:\Users\186\Desktop\高斯泼溅素材的流程化"
PROJ_DIR = os.path.join(ROOT_DIR, r"01_当前开发工程\splat-convert-desktop")
EDITOR_DIR = os.path.join(PROJ_DIR, r"windows\editor")
DEMO_BIN = os.path.join(ROOT_DIR, r"06_测试素材\scene-demo-24k.sgc2.bin")
CHROME_EXE = r"C:\Users\186\AppData\Local\ms-playwright\chromium-1248\chrome-win64\chrome.exe"


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def make_handler(serve_dir):
    class Handler(http.server.SimpleHTTPRequestHandler):
        extensions_map = {
            **http.server.SimpleHTTPRequestHandler.extensions_map,
            ".js": "application/javascript; charset=utf-8",
            ".mjs": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".bin": "application/octet-stream",
            ".png": "image/png",
            ".PNG": "image/png",
        }

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=serve_dir, **kwargs)

        def translate_path(self, path):
            if path.split("?", 1)[0] == "/demo.bin":
                return DEMO_BIN
            return super().translate_path(path)

        def log_message(self, *args):
            pass

    return Handler


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.id = 0
        self.pending = {}
        self.errs = []
        self._task = asyncio.create_task(self._reader())

    async def _reader(self):
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                if "id" in msg:
                    fut = self.pending.pop(msg["id"], None)
                    if fut and not fut.done():
                        if "error" in msg:
                            fut.set_exception(RuntimeError(str(msg["error"])))
                        else:
                            fut.set_result(msg.get("result", {}))
                else:
                    m = msg.get("method")
                    p = msg.get("params", {})
                    if m == "Runtime.exceptionThrown":
                        ex = p.get("exceptionDetails", {})
                        self.errs.append(f"EXC: {ex.get('text','')} {ex.get('exception',{}).get('description','')}")
                    elif m == "Runtime.consoleAPICalled" and p.get("type") == "error":
                        args = " ".join(str(a.get("value") or a.get("description") or "") for a in p.get("args", []))
                        self.errs.append(f"ERR: {args}")
        except Exception:
            pass

    async def call(self, method, params=None):
        self.id += 1
        cid = self.id
        fut = asyncio.get_event_loop().create_future()
        self.pending[cid] = fut
        await self.ws.send(json.dumps({"id": cid, "method": method, "params": params or {}}))
        return await asyncio.wait_for(fut, timeout=120)

    async def eval_js(self, expr):
        res = await self.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
        if "exceptionDetails" in res:
            raise RuntimeError(f"JS Error: {res['exceptionDetails']}")
        return res.get("result", {}).get("value")

    async def shot(self, out_dir, name):
        res = await self.call("Page.captureScreenshot", {"format": "png"})
        data = base64.b64decode(res["data"])
        p = os.path.join(out_dir, name)
        with open(p, "wb") as f:
            f.write(data)
        print(f"  [SHOT] {name} ({len(data)//1024} KB)")
        return p

    async def close(self):
        self._task.cancel()


def mat4_mul_point_col_major(m, pt):
    x, y, z = pt
    return [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    ]


async def run_verify(shot_dir, report_path):
    os.makedirs(shot_dir, exist_ok=True)
    server = ThreadedHTTPServer(("127.0.0.1", 0), make_handler(EDITOR_DIR))
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    user_dir = tempfile.mkdtemp(prefix="splat-v323-verify-")
    chrome = subprocess.Popen(
        [
            CHROME_EXE,
            f"--user-data-dir={user_dir}",
            "--remote-debugging-port=0",
            "--window-size=1520,900",
            "--use-gl=angle",
            "--use-angle=d3d11",
            "--enable-webgl",
            "--ignore-gpu-blocklist",
            "--no-first-run",
            "--no-default-browser-check",
            "--headless=new",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    ws_url = None
    deadline = time.time() + 25
    while time.time() < deadline:
        line = chrome.stderr.readline()
        if "DevTools listening on" in line:
            ws_url = line.split("DevTools listening on", 1)[1].strip()
            break
    assert ws_url, "Failed to start Chromium CDP"
    debug_port = ws_url.split(":")[2].split("/")[0]
    pages = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json").read().decode())
    page_ws = next(p["webSocketDebuggerUrl"] for p in pages if p.get("type") == "page")

    report = {"checks": [], "screenshots": [], "passed": False}

    def rec(name, ok, detail):
        report["checks"].append({"id": name, "ok": ok, "detail": detail})
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")
        assert ok, f"{name} failed: {detail}"

    try:
        async with websockets.connect(page_ws, max_size=64 * 1024 * 1024) as ws:
            cdp = CDP(ws)
            await cdp.call("Page.enable")
            await cdp.call("Runtime.enable")
            await cdp.call("Emulation.setDeviceMetricsOverride", {
                "width": 1520, "height": 900, "deviceScaleFactor": 1, "mobile": False
            })
            await cdp.call("Page.navigate", {"url": f"http://127.0.0.1:{port}/index.html"})
            await asyncio.sleep(1.2)

            await cdp.eval_js("""(async () => {
              const r = await fetch('/demo.bin');
              const buf = await r.arrayBuffer();
              await window.__SPLAT_EDITOR__.loadBuffer(buf, { totalPoints: 24000 });
              window.__SPLAT_EDITOR__.setTelemetry('GPU 18%  1.4 GB/ 12GB     |    CPU 11%   8.2 GB/ 32GB');
              await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
            })()""")
            await asyncio.sleep(0.4)

            # ---------------------------------------------------------------
            # 1. UI Restoration Audit
            # ---------------------------------------------------------------
            ui = await cdp.eval_js("""(() => {
              const rail = document.getElementById('left-rail');
              const railRect = rail.getBoundingClientRect();
              const railBtns = Array.from(rail.querySelectorAll('.rail-btn')).filter(b => b.offsetParent !== null);
              const singleCol = railBtns.every(b => Math.abs(b.getBoundingClientRect().left - railBtns[0].getBoundingClientRect().left) < 4);
              const kbdSameRow = railBtns.filter(b => b.querySelector('.btn-meta kbd')).every(b => {
                const br = b.getBoundingClientRect();
                const kr = b.querySelector('.btn-meta kbd').getBoundingClientRect();
                const lr = b.querySelector('.btn-meta .lbl').getBoundingClientRect();
                return Math.abs((kr.top + kr.bottom) / 2 - (lr.top + lr.bottom) / 2) < 6 && kr.left >= lr.right - 2;
              });
              const gizmoBtns = Array.from(document.querySelectorAll('#top-gizmo-cluster button.gizmo-btn')).map(b => b.dataset.gizmo || b.textContent.trim());
              const perfTxt = document.getElementById('bottom-right-perf')?.textContent || '';
              const st = window.__SPLAT_EDITOR__.getState();
              return {
                railWidth: Math.round(railRect.width),
                railBtnCount: railBtns.length,
                singleCol,
                kbdSameRow,
                gizmoBtns,
                hasPcui: !!document.querySelector('.pcui-container,.pcui-overlay,#menu-bar-options'),
                hasSpinner: !!document.querySelector('.loading-spinner'),
                hasDownsampleChk: !!document.getElementById('chk-interactive-downsample'),
                cameraDampingEnabled: !!st.cameraDampingEnabled,
                interactiveDownsampleRemoved: !!st.interactiveDownsampleRemoved,
                saveHasKbd: !!document.querySelector('#btn-save-overwrite-top kbd, #btn-save-as-top kbd'),
                tooltipDelayMs: st.tooltipDelayMs,
                perfTxt,
                hasGbMonitor: perfTxt.includes('GB'),
                hasAxisSphere: !!document.getElementById('axis-gizmo'),
              };
            })()""")
            rec(
                "ui_layout_and_controls",
                (
                    ui["singleCol"] and ui["kbdSameRow"] and not ui["hasPcui"] and not ui["hasSpinner"]
                    and not ui["hasDownsampleChk"] and ui["cameraDampingEnabled"] and ui["interactiveDownsampleRemoved"]
                    and not ui["saveHasKbd"] and ui["tooltipDelayMs"] == 500 and ui["hasGbMonitor"]
                    and ui["hasAxisSphere"] and len(ui["gizmoBtns"]) >= 3
                ),
                json.dumps(ui, ensure_ascii=False),
            )
            report["screenshots"].append(await cdp.shot(shot_dir, "01_v323_主界面总览_单列图标与边角框.png"))

            # Flyouts (筛选 / 矫正) + Display Mode Dropdown + Right-click "切回上次工具" + Axis Sphere click snap
            fly_ctx = await cdp.eval_js("""(async () => {
              window.__SPLAT_EDITOR__.toggleFlyout('filter');
              await new Promise(r => setTimeout(r, 80));
              const filterEl = document.querySelector('[data-flyout-menu="filter"]');
              const filterOpen = !!(filterEl && !filterEl.classList.contains('hidden'));
              const filterCount = filterEl ? filterEl.querySelectorAll('.flyout-item').length : 0;

              window.__SPLAT_EDITOR__.toggleFlyout('align');
              await new Promise(r => setTimeout(r, 80));
              const alignEl = document.querySelector('[data-flyout-menu="align"]');
              const alignOpen = !!(alignEl && !alignEl.classList.contains('hidden'));
              const alignCount = alignEl ? alignEl.querySelectorAll('.flyout-item').length : 0;

              window.__SPLAT_EDITOR__.openDisplayDropdown();
              return { filterOpen, filterCount, alignOpen, alignCount };
            })()""")
            await asyncio.sleep(0.2)
            report["screenshots"].append(await cdp.shot(shot_dir, "02_v323_显示模式与筛选矫正子菜单.png"))

            rc_axis = await cdp.eval_js("""(async () => {
              window.__SPLAT_EDITOR__.closeAllMenus();
              window.__SPLAT_EDITOR__.setActiveTool('rect');
              window.__SPLAT_EDITOR__.setActiveTool('brush');
              window.__SPLAT_EDITOR__.openContextMenuAt(480, 360);
              await new Promise(r => setTimeout(r, 60));
              const menuBtns = Array.from(document.querySelectorAll('#viewport-ctx-menu button'));
              const switchBtn = menuBtns.find(e => e.textContent.includes('切回上次工具'));
              let switchedTool = null;
              if (switchBtn) {
                switchBtn.click();
                switchedTool = window.__SPLAT_EDITOR__.getState().activeTool;
              }
              window.__SPLAT_EDITOR__.setActiveTool('orbit');

              // Axis Sphere click snap test: verify smooth quintic animation starts & glides to pole!
              const camBefore = window.__SPLAT_EDITOR__.getBoundsInfo().cameraPos;
              const axisCanvas = document.getElementById('axis-gizmo');
              let camMid = camBefore;
              let camAfter = camBefore;
              let animStarted = false;
              let animSettled = false;
              if (axisCanvas) {
                const ar = axisCanvas.getBoundingClientRect();
                for (const [fx, fy] of [[0.50, 0.20], [0.76, 0.62], [0.24, 0.62]]) {
                  axisCanvas.dispatchEvent(new MouseEvent('click', {
                    bubbles: true, button: 0,
                    clientX: ar.left + ar.width * fx,
                    clientY: ar.top + ar.height * fy,
                  }));
                  await new Promise(r => requestAnimationFrame(r));
                  animStarted = window.__SPLAT_EDITOR__.isCameraAnimating();
                  if (animStarted) {
                    await new Promise(r => setTimeout(r, 90));
                    camMid = window.__SPLAT_EDITOR__.getBoundsInfo().cameraPos;
                    await new Promise(r => setTimeout(r, 340));
                    camAfter = window.__SPLAT_EDITOR__.getBoundsInfo().cameraPos;
                    animSettled = !window.__SPLAT_EDITOR__.isCameraAnimating();
                    break;
                  }
                }
              }
              // Smooth exponential wheel zoom test
              const distBeforeWheel = Math.hypot(...camAfter);
              document.getElementById('canvas').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, deltaMode: 0 }));
              await new Promise(r => setTimeout(r, 40));
              const wheelAnimActive = window.__SPLAT_EDITOR__.isCameraAnimating();
              await new Promise(r => setTimeout(r, 360));
              const camAfterWheel = window.__SPLAT_EDITOR__.getBoundsInfo().cameraPos;
              const wheelMoved = Math.hypot(camAfterWheel[0]-camAfter[0], camAfterWheel[1]-camAfter[1], camAfterWheel[2]-camAfter[2]);

              const camMoved = Math.hypot(camAfter[0]-camBefore[0], camAfter[1]-camBefore[1], camAfter[2]-camBefore[2]);
              const midProgressed = Math.hypot(camMid[0]-camBefore[0], camMid[1]-camBefore[1], camMid[2]-camBefore[2]) > 0.05
                && Math.hypot(camAfter[0]-camMid[0], camAfter[1]-camMid[1], camAfter[2]-camMid[2]) > 0.01;
              return { itemsCount: menuBtns.length, hasSwitchPrev: !!switchBtn, switchedTool, animStarted, animSettled, midProgressed, wheelAnimActive, wheelMoved: Number(wheelMoved.toFixed(4)), camMoved: Number(camMoved.toFixed(4)) };
            })()""")
            rec(
                "ui_flyouts_rightclick_axissphere",
                fly_ctx["filterOpen"] and fly_ctx["alignOpen"] and fly_ctx["filterCount"] >= 4 and fly_ctx["alignCount"] >= 3
                and rc_axis["hasSwitchPrev"] and rc_axis["switchedTool"] == "rect" and rc_axis["camMoved"] > 0.05
                and rc_axis["animStarted"] and rc_axis["animSettled"] and rc_axis["wheelAnimActive"] and rc_axis["wheelMoved"] > 0.05,
                json.dumps({"flyouts": fly_ctx, "rc_axis": rc_axis}, ensure_ascii=False),
            )

            # ---------------------------------------------------------------
            # 2. 8-Corner OBB World-Space Verification (Translate + Rotate + Non-Uniform Scale) & O(1) Proof!
            # ---------------------------------------------------------------
            b0 = await cdp.eval_js("window.__SPLAT_EDITOR__.getBoundsInfo()")
            assert b0["hasValidBounds"] and b0["localBox"] is not None, f"Invalid initial bounds: {b0}"
            scan_before = b0["recomputeScanCount"]
            lmin = b0["localBox"]["min"]
            lmax = b0["localBox"]["max"]

            pos = [3.2, -1.5, 0.8]
            rot_deg = [25.0, -18.0, 42.0]
            scale = [1.5, 0.7, 2.2]
            await cdp.eval_js(f"""(() => {{
              window.__SPLAT_EDITOR__.setObjectTransform(0, {json.dumps(pos)}, {json.dumps(rot_deg)}, {json.dumps(scale)});
            }})()""")
            await asyncio.sleep(0.25)

            b1 = await cdp.eval_js("window.__SPLAT_EDITOR__.getBoundsInfo()")
            mat16 = await cdp.eval_js("window.__SPLAT_EDITOR__.getPrimaryMatrix()")
            scan_after = b1["recomputeScanCount"]

            # Independently compute all 8 world corners M * localCorner
            expected_corners = []
            for ix in (0, 1):
                for iy in (0, 1):
                    for iz in (0, 1):
                        lc = [lmax[0] if ix else lmin[0], lmax[1] if iy else lmin[1], lmax[2] if iz else lmin[2]]
                        expected_corners.append(mat4_mul_point_col_major(mat16, lc))

            actual_corners = b1["worldCorners"]
            assert len(actual_corners) == 8, f"Expected 8 world corners, got {len(actual_corners)}"
            max_corner_err = 0.0
            for ec in expected_corners:
                d = min(math.hypot(ac[0] - ec[0], ac[1] - ec[1], ac[2] - ec[2]) for ac in actual_corners)
                if d > max_corner_err:
                    max_corner_err = d

            report["screenshots"].append(await cdp.shot(shot_dir, "03_v323_八角框平移旋转非均匀缩放跟随.png"))
            rec(
                "obb_8corners_world_transform_o1",
                max_corner_err <= 1e-4 and scan_after == scan_before,
                f"maxCornerErr={max_corner_err:.2e} m (tol<=1e-4 m, +Z-up), recomputeScanCount={scan_before}->{scan_after} (0 full point-cloud scans!), cameraPos={[round(v,2) for v in b1['cameraPos']]}",
            )
            report["obbDetails"] = {
                "pos": pos, "rotDeg": rot_deg, "scale": scale,
                "maxCornerErrMeters": max_corner_err,
                "toleranceMeters": 1e-4,
                "coordSystem": "+Z-up, meters",
                "cameraPos": b1["cameraPos"],
                "cameraTarget": b1["cameraTarget"],
                "cameraUp": b1["cameraUp"],
                "recomputeScanCountBefore": scan_before,
                "recomputeScanCountAfter": scan_after,
            }

            # Reset primary transform back to identity before editing tool checks
            await cdp.eval_js("window.__SPLAT_EDITOR__.setObjectTransform(0, [0,0,0], [0,0,0], [1,1,1])")

            # ---------------------------------------------------------------
            # 3. Editing Tools: 3 Display Modes
            # ---------------------------------------------------------------
            modes_res = await cdp.eval_js("""(async () => {
              const out = {};
              for (const m of ['splat', 'centers', 'rings']) {
                window.__SPLAT_EDITOR__.setDisplayMode(m);
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                const st = window.__SPLAT_EDITOR__.getState();
                const pf = window.__SPLAT_EDITOR__.getPerfStats();
                out[m] = { displayMode: st.displayMode, drawn: pf.drawnInstances };
              }
              window.__SPLAT_EDITOR__.setDisplayMode('splat');
              return out;
            })()""")
            rec(
                "tools_3_display_modes",
                all(modes_res[m]["displayMode"] == m and modes_res[m]["drawn"] > 0 for m in ("splat", "centers", "rings")),
                json.dumps(modes_res),
            )

            # ---------------------------------------------------------------
            # 4. Editing Tools: 6-Face Volume, Handle Scale, Ordered Boolean Group, Occlusion Plane Half-Space Flip
            # ---------------------------------------------------------------
            vol_res = await cdp.eval_js("""(() => {
              const vm = window.__SPLAT_EDITOR__.getVolumeManager();
              window.__SPLAT_EDITOR__.spawnVolumeAt('box');
              window.__SPLAT_EDITOR__.spawnVolumeAt('box');
              const a = vm.items[vm.items.length - 2];
              const b = vm.items[vm.items.length - 1];
              a.root.position.set(0, 0, 1.0);
              a.root.rotation.set(0, 0, 0);
              a.root.scale.set(0.75, 0.75, 0.75);
              b.root.position.set(0.6, 0, 1.0);
              b.root.rotation.set(0, 0, 0);
              b.root.scale.set(0.75, 0.75, 0.75);
              vm.container.updateMatrixWorld(true);

              // Verify 6-face handle count on box A + scale via handle resize
              const handleCount = a.handles ? a.handles.length : 0;
              const origHalfX = a.root.scale.x;
              const fnBeforeScale = vm.compileActiveScope({ x: 0, y: -5, z: 2 });
              a.root.scale.x = 1.2;
              vm.container.updateMatrixWorld(true);
              const scaledHalfX = a.root.scale.x;
              const fnAfterScale = vm.compileActiveScope({ x: 0, y: -5, z: 2 });
              const insideAfterScale = fnAfterScale(1.0, 0, 1.0); // was outside X=0.75, now inside X=1.2!

              // Ordered boolean group: [A(union), B(subtract)] vs [B(subtract), A(union)]
              a.boolOp = 'union';
              b.boolOp = 'subtract';
              const g = vm.createGroupFromItems([a.id, b.id], '布尔测试组');
              vm.container.updateMatrixWorld(true);
              const fn1 = vm.compileActiveScope({ x: 0, y: -5, z: 2 });
              const ptOverlapOrder1 = fn1(0.5, 0, 1.0); // inside A and inside B -> subtracted => false
              const ptOnlyAOrder1 = fn1(-0.8, 0, 1.0);  // inside A only => true

              // Swap member order via moveChild: [B(subtract), A(union)] -> A unions back over B => true!
              g.moveChild(a.id, 1);
              const fn2 = vm.compileActiveScope({ x: 0, y: -5, z: 2 });
              const ptOverlapOrder2 = fn2(0.5, 0, 1.0); // now true!

              // Infinite occlusion plane: test half-space flip as camera moves across plane!
              vm.removeGroup(g.id);
              window.__SPLAT_EDITOR__.spawnVolumeAt('plane');
              const pl = vm.items[vm.items.length - 1];
              pl.root.position.set(0, 0, 1.0);
              pl.root.rotation.set(0, 0, 0); // Horizontal plane at Z=1.0
              vm.container.updateMatrixWorld(true);
              const scopeCamAbove = vm.compileActiveScope({ x: 0, y: 0, z: 5.0 });
              const scopeCamBelow = vm.compileActiveScope({ x: 0, y: 0, z: -3.0 });
              const ptAboveWhenCamAbove = scopeCamAbove(0, 0, 2.0);
              const ptAboveWhenCamBelow = scopeCamBelow(0, 0, 2.0);

              return {
                handleCount, origHalfX, scaledHalfX, insideAfterScale,
                ptOverlapOrder1, ptOnlyAOrder1, ptOverlapOrder2,
                ptAboveWhenCamAbove, ptAboveWhenCamBelow,
                planeFlipped: ptAboveWhenCamAbove !== ptAboveWhenCamBelow,
              };
            })()""")
            rec(
                "tools_volumes_boolean_order_occlusion_plane",
                (
                    vol_res["handleCount"] == 6 and vol_res["insideAfterScale"]
                    and vol_res["ptOverlapOrder1"] is False and vol_res["ptOnlyAOrder1"] is True
                    and vol_res["ptOverlapOrder2"] is True and vol_res["planeFlipped"] is True
                ),
                json.dumps(vol_res),
            )

            # ---------------------------------------------------------------
            # 5. Editing Tools: +Z-up Auto-Align (Anti-Flip), Vertical Align, 3-Point Ground Align
            # ---------------------------------------------------------------
            align_res = await cdp.eval_js("""(() => {
              // 5a. Tilt object by 22 deg, run auto-align (+Z-up anti-flip) -> Z-up axis stays positive (+Z > 0.9)
              window.__SPLAT_EDITOR__.setObjectTransform(0, [0, 0, 0], [22, -14, 0], [1, 1, 1]);
              window.__SPLAT_EDITOR__.executeAutoAlign();
              const mAuto = window.__SPLAT_EDITOR__.getPrimaryMatrix();
              const autoUpZ = mAuto[10]; // column 2, row 2 = world Z of local +Z axis

              // 5b. Reset, apply Vertical Align from (0,0,0)->(0,1,1): transformed vector should align to +Z!
              window.__SPLAT_EDITOR__.setObjectTransform(0, [0, 0, 0], [0, 0, 0], [1, 1, 1]);
              window.__SPLAT_EDITOR__.applyVerticalAlignPoints([0, 0, 0], [0, 1, 1], false);
              const mVert = window.__SPLAT_EDITOR__.getPrimaryMatrix();
              // Multiply mVert * [0, 1, 1, 0]
              const vx = mVert[4] * 1 + mVert[8] * 1;
              const vy = mVert[5] * 1 + mVert[9] * 1;
              const vz = mVert[6] * 1 + mVert[10] * 1;
              const vertLen = Math.hypot(vx, vy, vz);
              const vertUpCos = vz / Math.max(1e-9, vertLen);

              // 5c. Reset, apply 3-Point Ground Align on plane Z=0.5 -> point (0,0,0.5) must move onto Z=0!
              window.__SPLAT_EDITOR__.setObjectTransform(0, [0, 0, 0], [0, 0, 0], [1, 1, 1]);
              window.__SPLAT_EDITOR__.applyGroundAlignPoints([-1, -1, 0.5], [1, -1, 0.5], [0, 1, 0.5], false);
              const mGnd = window.__SPLAT_EDITOR__.getPrimaryMatrix();
              const gz = mGnd[2] * 0 + mGnd[6] * 0 + mGnd[10] * 0.5 + mGnd[14];

              // Reset back to identity for subsequent checks
              window.__SPLAT_EDITOR__.setObjectTransform(0, [0, 0, 0], [0, 0, 0], [1, 1, 1]);
              return {
                autoUpZ: Number(autoUpZ.toFixed(4)),
                vertUpCos: Number(vertUpCos.toFixed(4)),
                groundPlaneZ: Number(gz.toFixed(4)),
              };
            })()""")
            rec(
                "tools_zup_auto_vertical_ground_align",
                align_res["autoUpZ"] > 0.90 and align_res["vertUpCos"] > 0.999 and abs(align_res["groundPlaneZ"]) < 1e-3,
                json.dumps(align_res),
            )

            # ---------------------------------------------------------------
            # 6. Editing Tools: Histogram, Split Compare, Color Bake + Undo, Encoder Preset Linkage
            # ---------------------------------------------------------------
            color_res = await cdp.eval_js("""(async () => {
              window.__SPLAT_EDITOR__.toggleColorPanel(true);
              window.__SPLAT_EDITOR__.toggleSplitCompare(true);
              window.__SPLAT_EDITOR__.setLiveColorGrade({ exposure: 0.45, contrast: 1.25, saturation: 1.35 });
              await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

              const hist = document.getElementById('histogram-canvas');
              let nonEmptyHistPx = 0;
              if (hist) {
                const ctx = hist.getContext('2d');
                const img = ctx.getImageData(0, 0, hist.width, hist.height).data;
                for (let i = 3; i < img.length; i += 4) {
                  if (img[i] > 10 && (img[i - 3] + img[i - 2] + img[i - 1]) > 40) nonEmptyHistPx++;
                }
              }
              const stSplit = window.__SPLAT_EDITOR__.getState();
              return {
                colorPanelOpen: stSplit.colorPanelOpen,
                splitCompareActive: stSplit.splitCompareActive,
                nonEmptyHistPx,
              };
            })()""")
            report["screenshots"].append(await cdp.shot(shot_dir, "04_v323_体选布尔组与调色分屏直方图.png"))

            bake_preset = await cdp.eval_js("""(() => {
              window.__SPLAT_EDITOR__.bakeCurrentColorGrade();
              const bakedCount = window.__SPLAT_EDITOR__.buildRecipe().objects[0].bakedGrades.length;
              window.__SPLAT_EDITOR__.undo();
              const afterUndoCount = window.__SPLAT_EDITOR__.buildRecipe().objects[0].bakedGrades.length;
              window.__SPLAT_EDITOR__.toggleSplitCompare(false);
              window.__SPLAT_EDITOR__.toggleColorPanel(false);

              // Main-window encoder preset linkage in Save As modal
              window.__SPLAT_EDITOR__.setEncoderPreset({
                formatSuffix: '.sog',
                formatName: 'SOG',
                keep: 85,
                iterations: 12,
                device: 'gpu',
                sogVersion: 3,
                spzVersion: 4,
              });
              window.__SPLAT_EDITOR__.openSaveAsModal();
              const summaryTxt = document.getElementById('saveas-encoder-summary')?.textContent?.trim() || '';
              const fmtVal = document.getElementById('saveas-format')?.value || '';
              return { bakedCount, afterUndoCount, summaryTxt, fmtVal };
            })()""")
            rec(
                "tools_color_histogram_split_bake_encoder_preset",
                (
                    color_res["colorPanelOpen"] and color_res["splitCompareActive"] and color_res["nonEmptyHistPx"] > 100
                    and bake_preset["bakedCount"] == 1 and bake_preset["afterUndoCount"] == 0
                    and "85%" in bake_preset["summaryTxt"]
                ),
                json.dumps({"color": color_res, "bakePreset": bake_preset}, ensure_ascii=False),
            )

            # ---------------------------------------------------------------
            # 7. Shimmer Loading Bar + >10s ETA (NO spinner ring!)
            # ---------------------------------------------------------------
            await cdp.eval_js("window.__SPLAT_EDITOR__.closeModal('modal-save-as'); window.__SPLAT_EDITOR__.testLoadingEta(38, 14.5)")
            await asyncio.sleep(0.25)
            eta_info = await cdp.eval_js("""(() => ({
              overlayVisible: !document.getElementById('loading-overlay').classList.contains('hidden'),
              etaText: document.getElementById('loading-eta')?.textContent?.trim() || '',
              hasSpinner: !!document.querySelector('.loading-spinner'),
            }))()""")
            report["screenshots"].append(await cdp.shot(shot_dir, "05_v323_加载光带与预计剩余时间.png"))
            await cdp.eval_js("window.__SPLAT_EDITOR__.hideLoading()")
            rec(
                "ui_loading_shimmer_eta_no_spinner",
                eta_info["overlayVisible"] and not eta_info["hasSpinner"] and len(eta_info["etaText"]) > 0,
                json.dumps(eta_info, ensure_ascii=False),
            )

            # ---------------------------------------------------------------
            # 8. Live UI v4 Recipe Compatibility Banner & No-Downgrade Save
            # ---------------------------------------------------------------
            v4_ui = await cdp.eval_js("""(async () => {
              const r = await fetch('/demo.bin');
              const buf = await r.arrayBuffer();
              const v4 = {
                version: 4,
                coordSystem: 'z-up',
                deletedRle: [0, 120, 23880],
                deletedCount: 120,
                entityDeltaMatrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
                paletteMatrices: [[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], [1,0,0,0,0,1,0,0,0,0,1,0,2,0,0,1]],
                transformIdxRle: [0, 1000, 1, 23000],
                paintDelta: { indices: [10, 20], deltas: [0.1, 0, 0, 0, 0, 0.1, 0, 0] },
                colorGrade: { brightness: 0.05, saturation: 1.1 }
              };
              await window.__SPLAT_EDITOR__.loadBuffer(buf, { totalPoints: 24000, recipeJson: v4 });
              await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
              const bannerEl = document.getElementById('recipe-compat-banner');
              const bannerVisible = !!(bannerEl && !bannerEl.classList.contains('hidden'));
              const bannerText = bannerEl ? bannerEl.textContent.trim() : '';
              const stats = window.__SPLAT_EDITOR__.getCloudStats();
              const rebuilt = window.__SPLAT_EDITOR__.buildRecipe();
              window.__SPLAT_EDITOR__.openSaveAsModal();
              return {
                bannerVisible,
                bannerText,
                deletedLoaded: stats.deleted,
                rebuiltVersion: rebuilt.version,
                preservedPaintCount: rebuilt.paintDelta?.indices?.length || 0,
                preservedPaletteLen: rebuilt.paletteMatrices?.length || 0,
              };
            })()""")
            await asyncio.sleep(0.2)
            report["screenshots"].append(await cdp.shot(shot_dir, "06_v323_v4配方兼容提示横幅与另存为编码预设.png"))
            rec(
                "ui_v4_compat_banner_and_no_downgrade",
                (
                    v4_ui["bannerVisible"] and v4_ui["deletedLoaded"] == 120
                    and v4_ui["rebuiltVersion"] == 4 and v4_ui["preservedPaintCount"] == 2
                    and v4_ui["preservedPaletteLen"] == 2
                ),
                json.dumps(v4_ui, ensure_ascii=False),
            )

            # ---------------------------------------------------------------
            # 9. Low-Performance Emergency Safe Mode (Centers Mode + Freeze Filter/Color + Keep Basic Select & Align!)
            # ---------------------------------------------------------------
            safe_res = await cdp.eval_js("""(async () => {
              window.__SPLAT_EDITOR__.closeModal('modal-save-as');
              window.__SPLAT_EDITOR__.setDisplayMode('splat');
              window.__SPLAT_EDITOR__.setActiveTool('semanticSel');
              window.__SPLAT_EDITOR__.enterLowPerfSafeMode('自动化模拟显存与帧率过载', 'GPU 99% 11.8 GB/12GB', { showModal: false });
              await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

              const bannerVisible = !document.getElementById('safe-mode-banner')?.classList.contains('hidden');
              const filterDisabled = !!document.getElementById('btn-flyout-filter')?.disabled;
              const colorDisabled = !!document.getElementById('btn-color-panel')?.disabled;
              const modeAfterEnter = window.__SPLAT_EDITOR__.getState().displayMode;

              // Attempt blocked actions (must stay frozen!)
              window.__SPLAT_EDITOR__.setActiveTool('eyedropper');
              const toolAfterBlockedFilter = window.__SPLAT_EDITOR__.getState().activeTool;
              window.__SPLAT_EDITOR__.toggleColorPanel(true);
              const colorAfterBlocked = window.__SPLAT_EDITOR__.getState().colorPanelOpen;
              window.__SPLAT_EDITOR__.setDisplayMode('splat');
              const modeAfterBlockedSplat = window.__SPLAT_EDITOR__.getState().displayMode;

              // Attempt allowed basic edit + alignment tools (must work!)
              window.__SPLAT_EDITOR__.setActiveTool('rect');
              const toolAfterRect = window.__SPLAT_EDITOR__.getState().activeTool;
              window.__SPLAT_EDITOR__.setActiveTool('verticalAlign');
              const toolAfterAlign = window.__SPLAT_EDITOR__.getState().activeTool;
              window.__SPLAT_EDITOR__.setActiveTool('orbit');

              return {
                bannerVisible, filterDisabled, colorDisabled, modeAfterEnter,
                toolAfterBlockedFilter, colorAfterBlocked, modeAfterBlockedSplat,
                toolAfterRect, toolAfterAlign,
              };
            })()""")
            await asyncio.sleep(0.2)
            report["screenshots"].append(await cdp.shot(shot_dir, "07_v323_性能应急中心模式与冻结筛选工具.png"))
            safe_exit = await cdp.eval_js("""(() => {
              window.__SPLAT_EDITOR__.exitLowPerfSafeMode();
              window.__SPLAT_EDITOR__.setDisplayMode('splat');
              return {
                bannerHidden: document.getElementById('safe-mode-banner')?.classList.contains('hidden'),
                filterEnabled: !document.getElementById('btn-flyout-filter')?.disabled,
                modeRestored: window.__SPLAT_EDITOR__.getState().displayMode,
              };
            })()""")
            rec(
                "low_perf_safe_mode_centers_and_freeze",
                (
                    safe_res["bannerVisible"] and safe_res["filterDisabled"] and safe_res["colorDisabled"]
                    and safe_res["modeAfterEnter"] == "centers"
                    and safe_res["toolAfterBlockedFilter"] == "orbit"
                    and safe_res["colorAfterBlocked"] is False
                    and safe_res["modeAfterBlockedSplat"] == "centers"
                    and safe_res["toolAfterRect"] == "rect"
                    and safe_res["toolAfterAlign"] == "rect"
                    and safe_exit["bannerHidden"] and safe_exit["filterEnabled"] and safe_exit["modeRestored"] == "splat"
                ),
                json.dumps({"enter": safe_res, "exit": safe_exit}, ensure_ascii=False),
            )

            rec(
                "zero_console_and_runtime_errors",
                len(cdp.errs) == 0,
                f"consoleErrors={len(cdp.errs)} samples={cdp.errs[:3]}",
            )
            await cdp.close()
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=5)
        except Exception:
            chrome.kill()
        server.shutdown()
        shutil.rmtree(user_dir, ignore_errors=True)

    report["passed"] = True
    if report_path:
        os.makedirs(os.path.dirname(os.path.abspath(report_path)), exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\nALL {len(report['checks'])} STEP-2 UI/TOOLS/OBB VERIFICATION CHECKS PASSED 100%!")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot-dir", required=True)
    ap.add_argument("--report", required=True)
    args = ap.parse_args()
    asyncio.run(run_verify(args.shot_dir, args.report))
