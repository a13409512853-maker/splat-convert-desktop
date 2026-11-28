#!/usr/bin/env python3
"""
Focused Real-GPU Verification Suite for 3.2.3-rc7:
  1. Elongated & Rotated Box 6-Face Handles: zero shear (col0 ⊥ col1, |col0|==|col1|) and 1:1 screen-space
     square projection across multiple oblique camera angles (never deforms into parallelograms!).
  2. Auto-hide Gaussian Model Gizmo on ALL non-Browse tools (2-6 basic selection + Filter / Smart / Align)
     AND double-clicking a Gaussian point to summon Gizmo automatically cancels active tool back to Browse (1).
  3. Fly Camera Speed Slider: hidden in Orbit mode, appears directly left of W/E/R cluster (Fig 2 position)
     in Fly mode, min/default/max speed auto-calibrated from initial loaded model span across small/med/large models,
     live slider update + double-click reset to default speed.
"""
import argparse, asyncio, base64, http.server, json, os, shutil, subprocess, tempfile, threading, urllib.request, websockets

ROOT_DIR = r"c:\Users\186\Desktop\高斯泼溅素材的流程化"
PROJ_DIR = os.path.join(ROOT_DIR, r"01_当前开发工程\splat-convert-desktop")
EDITOR_DIR = os.path.join(PROJ_DIR, r"windows\editor")
DEMO_PLY = os.path.join(ROOT_DIR, r"06_测试素材\scene-demo-24k.ply")

class MultiRootHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".wasm": "application/wasm",
    }
    def __init__(self, *a, routes=None, **kw):
        self.routes = routes or {}
        super().__init__(*a, directory=EDITOR_DIR, **kw)
    def log_message(self, *a): pass
    def translate_path(self, path):
        clean = path.split("?", 1)[0]
        for prefix, root_dir in self.routes.items():
            if clean.startswith(prefix):
                rel = clean[len(prefix):].lstrip("/")
                return os.path.join(root_dir, *rel.split("/"))
        return super().translate_path(path)

async def run_suite(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    tmp_data = tempfile.mkdtemp(prefix="rc7_verify_data_")
    demo_sgc = os.path.join(tmp_data, "demo24k.bin")
    node_exe = shutil.which("node")
    subprocess.run([node_exe, os.path.join(EDITOR_DIR, "worker.mjs"), "sample", DEMO_PLY, demo_sgc, "full", PROJ_DIR], check=True)

    routes = {"/__data__/": tmp_data, "/locales/": os.path.join(PROJ_DIR, "locales")}
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **kw: MultiRootHandler(*a, routes=routes, **kw))
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    if not os.path.exists(edge):
        edge = r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    profile = tempfile.mkdtemp(prefix="rc7_edge_prof_")
    cdp_port = 9279
    proc = subprocess.Popen([
        edge, "--headless=new", f"--remote-debugging-port={cdp_port}",
        f"--user-data-dir={profile}", "--window-size=1520,900",
        "--use-gl=angle", "--use-angle=d3d11", "--no-first-run", "--no-default-browser-check",
        f"http://127.0.0.1:{port}/index.html"
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    console_errors = []
    report = {"checks": {}, "screenshots": [], "consoleErrors": []}
    try:
        ws_url = None
        for _ in range(45):
            try:
                tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json").read())
                for t in tabs:
                    if t.get("type") == "page" and "webSocketDebuggerUrl" in t:
                        ws_url = t["webSocketDebuggerUrl"]
                        break
                if ws_url:
                    break
            except Exception:
                pass
            await asyncio.sleep(0.25)
        assert ws_url, "Failed to attach Edge CDP"

        async with websockets.connect(ws_url, max_size=25 * 1024 * 1024) as ws:
            mid = 0
            async def send(method, params=None):
                nonlocal mid
                mid += 1
                cid = mid
                await ws.send(json.dumps({"id": cid, "method": method, "params": params or {}}))
                while True:
                    m = json.loads(await ws.recv())
                    if m.get("id") == cid:
                        if "error" in m:
                            raise RuntimeError(m["error"])
                        return m.get("result", {})
                    if m.get("method") == "Runtime.exceptionThrown":
                        console_errors.append(str(m.get("params", {}).get("exceptionDetails", {}).get("text", "")))
                    elif m.get("method") == "Runtime.consoleAPICalled" and m.get("params", {}).get("type") == "error":
                        console_errors.append(" ".join(str(a.get("value", "")) for a in m.get("params", {}).get("args", [])))

            async def eval_js(expr):
                r = await send("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
                if "exceptionDetails" in r:
                    raise RuntimeError(f"JS Exception: {r['exceptionDetails']}")
                return r.get("result", {}).get("value")

            async def snap(name):
                d = (await send("Page.captureScreenshot", {"format": "png"})).get("data", "")
                p = os.path.join(out_dir, name)
                open(p, "wb").write(base64.b64decode(d))
                report["screenshots"].append(p)
                return p

            await send("Runtime.enable")
            await send("Page.enable")
            await asyncio.sleep(1.0)

            await eval_js(f"""(async () => {{
                const buf = await (await fetch('http://127.0.0.1:{port}/__data__/demo24k.bin')).arrayBuffer();
                await window.__SPLAT_EDITOR__.loadBuffer(buf, {{ totalPoints: 24000 }});
                window.__SPLAT_EDITOR__.setTelemetry('GPU 11% 2.9/16.0 GB | CPU 5% 10.1/32.0 GB', {{
                    cpuPct: 5, ramUsedGb: 10.1, ramTotalGb: 32.0, gpuPct: 11, vramUsedGb: 2.9, vramTotalGb: 16.0
                }});
            }})()""")
            await asyncio.sleep(0.35)

            # ---- CHECK 1: Elongated Non-Uniform Rotated Box Handles Stay Perfect 1:1 Squares Across Oblique Angles ----
            c1 = await eval_js("""(() => {
                const vm = window.__SPLAT_EDITOR__.getVolumeManager();
                const box = vm.createVolume('box', { x: 0, y: 0, z: 0.6, clone(){return this;} }, 1.0);
                // Extreme elongated box (4.2 : 1.0 : 0.65) + oblique rotation!
                box.root.position.set(0, 0, 0.6);
                box.root.rotation.set(0.18, -0.22, 0.55);
                box.root.scale.set(3.8, 0.9, 0.65);
                box.captureInitialTransform();
                box.enabled = false;
                const cyl = vm.createVolume('cylinder', { x: 0.5, y: 0.2, z: 0.7, clone(){return this;} }, 0.8);
                cyl.root.position.set(0.5, 0.2, 0.7);
                cyl.root.scale.set(0.75, 0.75, 0.85);
                window.__SPLAT_EDITOR__.selectVolumeOrGroup(box.id, false);

                const poses = [
                    [3.5, -5.8, 4.2],
                    [-4.6, -4.2, 2.6],
                    [2.2, 5.4, 3.8],
                ];
                let maxShear = 0;
                let maxAspectErr = 0;
                for (const p of poses) {
                    window.__SPLAT_EDITOR__.setCameraPose(p, [0, 0, 0.6]);
                    for (const h of box.handles) {
                        h.updateMatrixWorld(true);
                        const e = h.matrixWorld.elements;
                        // Column 0 (X axis) & Column 1 (Y axis) in world space
                        const c0x = e[0], c0y = e[1], c0z = e[2];
                        const c1x = e[4], c1y = e[5], c1z = e[6];
                        const l0 = Math.hypot(c0x, c0y, c0z);
                        const l1 = Math.hypot(c1x, c1y, c1z);
                        const cosAngle = Math.abs((c0x*c1x + c0y*c1y + c0z*c1z) / Math.max(1e-9, l0 * l1));
                        const aspectErr = Math.abs((l0 / Math.max(1e-9, l1)) - 1.0);
                        if (cosAngle > maxShear) maxShear = cosAngle;
                        if (aspectErr > maxAspectErr) maxAspectErr = aspectErr;
                    }
                }
                // Pose similar to user's Screenshot 1 for crisp visual check!
                window.__SPLAT_EDITOR__.setCameraPose([3.2, -5.8, 4.4], [0, 0, 0.6]);
                return { handleCount: box.handles.length, maxShear, maxAspectErr, handleParentIsRoot: box.handles[0].parent === box.root };
            })()""")
            await asyncio.sleep(0.25)
            await snap("01_rc7_elongated_box_perfect_square_handles.png")
            assert c1["handleCount"] == 6 and (not c1["handleParentIsRoot"])
            assert c1["maxShear"] < 1e-5 and c1["maxAspectErr"] < 1e-5, f"Handles still sheared/deformed! {c1}"
            report["checks"]["1_elongated_box_handles_zero_shear_square"] = {"pass": True, **c1}
            print(f"[PASS] 1_elongated_box_handles_zero_shear_square (maxShear={c1['maxShear']:.2e}, maxAspectErr={c1['maxAspectErr']:.2e})")

            # ---- CHECK 2: Auto-Hide Gaussian Gizmo on ALL Non-Browse Tools + Double-Click Summons Gizmo & Cancels Tool + W/E/R Toggle Hide ----
            c2 = await eval_js("""(() => {
                // Clear volumes and frame demo cloud cleanly
                const vm = window.__SPLAT_EDITOR__.getVolumeManager();
                vm.restoreSnapshot({ topLevelOrder: [], groups: [], items: [] });
                window.__SPLAT_EDITOR__.setCameraPose([0.1, -4.5, 1.8], [0, 0, 0.5]);
                const canvas = document.getElementById('canvas');
                const rect = canvas.getBoundingClientRect();
                const dblCenter = () => canvas.dispatchEvent(new MouseEvent('dblclick', {
                    bubbles: true, clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5
                }));
                const pressKey = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

                // 1. Double-click in Browse -> summons Translate gizmo
                dblCenter();
                const s0 = window.__SPLAT_EDITOR__.getRc5State();
                const m0 = window.__SPLAT_EDITOR__.getState().gizmoMode;

                // 1b. In Browse (1) while in Translate gizmo: press W -> MUST hide gizmo!
                pressKey('w');
                const hidByW = !window.__SPLAT_EDITOR__.getRc5State().gizmoVisible;
                // Press E while hidden -> shows Rotate gizmo!
                pressKey('e');
                const showRotate = window.__SPLAT_EDITOR__.getRc5State().gizmoVisible && window.__SPLAT_EDITOR__.getState().gizmoMode === 'rotate';
                // Press R while in Rotate -> switches to Scale (stays visible)!
                pressKey('r');
                const switchScale = window.__SPLAT_EDITOR__.getRc5State().gizmoVisible && window.__SPLAT_EDITOR__.getState().gizmoMode === 'scale';
                // Click active [缩放] button -> MUST hide gizmo!
                document.querySelector('#top-gizmo-cluster [data-gizmo="scale"]').click();
                const hidByScaleBtn = !window.__SPLAT_EDITOR__.getRc5State().gizmoVisible;
                // Double-click in Browse while gizmo is hidden (last mode was scale!) -> MUST auto-activate Translate gizmo!
                dblCenter();
                const dblAutoTranslate = window.__SPLAT_EDITOR__.getRc5State().gizmoVisible && window.__SPLAT_EDITOR__.getState().gizmoMode === 'translate';
                // Click active [移动] button -> MUST hide gizmo!
                document.querySelector('#top-gizmo-cluster [data-gizmo="translate"]').click();
                const hidByMoveBtn = !window.__SPLAT_EDITOR__.getRc5State().gizmoVisible;
                // Re-summon via double-click for tool auto-hide tests
                dblCenter();

                // 2. Activate rect (2) -> Gaussian gizmo MUST auto-hide!
                window.__SPLAT_EDITOR__.setActiveToolUser('rect');
                const sRect = { gizVis: window.__SPLAT_EDITOR__.getRc5State().gizmoVisible, tool: window.__SPLAT_EDITOR__.getState().activeTool };

                // 3. Double-click while in rect (2) -> summons Translate gizmo AND cancels rect back to Browse (1)!
                dblCenter();
                const sDblFromRect = {
                    gizVis: window.__SPLAT_EDITOR__.getRc5State().gizmoVisible,
                    gizMode: window.__SPLAT_EDITOR__.getState().gizmoMode,
                    gizPivot: window.__SPLAT_EDITOR__.getRc5State().gizmoAttachedToPivot,
                    tool: window.__SPLAT_EDITOR__.getState().activeTool,
                    bars: window.__SPLAT_EDITOR__.getState().contextBarCount
                };

                // 4. Activate opacitySel (Filter) -> Gaussian gizmo MUST auto-hide!
                window.__SPLAT_EDITOR__.setActiveToolUser('opacitySel');
                const sOpacity = { gizVis: window.__SPLAT_EDITOR__.getRc5State().gizmoVisible, tool: window.__SPLAT_EDITOR__.getState().activeTool };

                // 5. Double-click while in opacitySel -> summons Translate gizmo AND cancels opacitySel back to Browse (1)!
                dblCenter();
                const sDblFromOpacity = {
                    gizVis: window.__SPLAT_EDITOR__.getRc5State().gizmoVisible,
                    gizMode: window.__SPLAT_EDITOR__.getState().gizmoMode,
                    tool: window.__SPLAT_EDITOR__.getState().activeTool,
                    bars: window.__SPLAT_EDITOR__.getState().contextBarCount
                };

                // 6. Activate planeInpaint (Smart) & verticalAlign (Align) -> gizmo MUST auto-hide on both!
                window.__SPLAT_EDITOR__.setActiveToolUser('planeInpaint');
                const gizAfterSmart = window.__SPLAT_EDITOR__.getRc5State().gizmoVisible;
                dblCenter();
                const toolAfterSmartDbl = window.__SPLAT_EDITOR__.getState().activeTool;
                const gizAfterSmartDbl = window.__SPLAT_EDITOR__.getRc5State().gizmoVisible;

                window.__SPLAT_EDITOR__.setActiveToolUser('verticalAlign');
                const gizAfterAlign = window.__SPLAT_EDITOR__.getRc5State().gizmoVisible;
                dblCenter();
                const toolAfterAlignDbl = window.__SPLAT_EDITOR__.getState().activeTool;
                const gizAfterAlignDbl = window.__SPLAT_EDITOR__.getRc5State().gizmoVisible;

                return {
                    initialSummoned: s0.gizmoVisible && s0.gizmoAttachedToPivot && m0 === 'translate',
                    hidByW, showRotate, switchScale, hidByScaleBtn, dblAutoTranslate, hidByMoveBtn,
                    sRect, sDblFromRect, sOpacity, sDblFromOpacity,
                    gizAfterSmart, toolAfterSmartDbl, gizAfterSmartDbl,
                    gizAfterAlign, toolAfterAlignDbl, gizAfterAlignDbl
                };
            })()""")
            assert c2["initialSummoned"] and c2["hidByW"] and c2["showRotate"] and c2["switchScale"] and c2["hidByScaleBtn"] and c2["dblAutoTranslate"] and c2["hidByMoveBtn"], f"W/E/R toggle or dblclick auto-translate failed: {c2}"
            assert (not c2["sRect"]["gizVis"]) and c2["sRect"]["tool"] == "rect", f"Rect didn't hide gizmo: {c2}"
            assert c2["sDblFromRect"]["gizVis"] and c2["sDblFromRect"]["gizMode"] == "translate" and c2["sDblFromRect"]["gizPivot"] and c2["sDblFromRect"]["tool"] == "orbit" and c2["sDblFromRect"]["bars"] == 0, f"Dblclick from rect failed: {c2}"
            assert (not c2["sOpacity"]["gizVis"]) and c2["sOpacity"]["tool"] == "opacitySel", f"OpacitySel didn't hide gizmo: {c2}"
            assert c2["sDblFromOpacity"]["gizVis"] and c2["sDblFromOpacity"]["gizMode"] == "translate" and c2["sDblFromOpacity"]["tool"] == "orbit" and c2["sDblFromOpacity"]["bars"] == 0, f"Dblclick from opacity failed: {c2}"
            assert (not c2["gizAfterSmart"]) and c2["toolAfterSmartDbl"] == "orbit" and c2["gizAfterSmartDbl"]
            assert (not c2["gizAfterAlign"]) and c2["toolAfterAlignDbl"] == "orbit" and c2["gizAfterAlignDbl"]
            report["checks"]["2_gizmo_autohide_wer_toggle_and_dblclick_translate"] = {"pass": True, **c2}
            print("[PASS] 2_gizmo_autohide_wer_toggle_and_dblclick_translate")

            # ---- CHECK 3: Fly Camera Speed Slider Below Top Toolbar (Fig 2) + Model-Size Calibration ----
            c3 = await eval_js("""(async () => {
                const bar = document.getElementById('fly-speed-bar');
                const slider = document.getElementById('fly-speed-slider');
                const out = document.getElementById('fly-speed-value');
                const gizCluster = document.getElementById('top-gizmo-cluster');
                const topRow = document.querySelector('#top-right-tools .top-icon-row');

                const hiddenInOrbit = bar.classList.contains('hidden');
                const initCfg = window.__SPLAT_EDITOR__.getFlySpeedConfig();

                // Verify monotonic calibration across small (0.5m), medium (35m), and large (180m) model spans!
                const smallCfg = window.__SPLAT_EDITOR__.calibrateFlySpeedFromSpan(0.5);
                const medCfg   = window.__SPLAT_EDITOR__.calibrateFlySpeedFromSpan(35);
                const bigCfg   = window.__SPLAT_EDITOR__.calibrateFlySpeedFromSpan(180);
                // Restore initial demo-24k model calibration
                const restored = window.__SPLAT_EDITOR__.calibrateFlySpeedFromSpan(initCfg.span);

                // Switch to Fly Camera mode & wait 220ms for uiPopDown animation to settle before measuring rect!
                window.__SPLAT_EDITOR__.setCameraControlMode('fly');
                await new Promise(r => setTimeout(r, 220));
                const visibleInFly = !bar.classList.contains('hidden');
                const br = bar.getBoundingClientRect();
                const gr = gizCluster.getBoundingClientRect();
                const tr = topRow.getBoundingClientRect();
                const sameRowAsGizmo = Math.abs(br.top - gr.top) <= 2 && Math.abs(br.height - gr.height) <= 2;
                const leftOfGizmo = br.right <= gr.left + 1;
                const belowTopRow = br.top >= tr.bottom - 1;

                // Test live slider input + double-click reset to calibrated default!
                slider.value = String(restored.max);
                slider.dispatchEvent(new Event('input', { bubbles: true }));
                const afterDragVal = window.__SPLAT_EDITOR__.getFlySpeedConfig().value;
                const afterDragTxt = out.textContent.trim();
                out.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                const afterResetVal = window.__SPLAT_EDITOR__.getFlySpeedConfig().value;
                const afterResetTxt = out.textContent.trim();

                return {
                    hiddenInOrbit, visibleInFly, sameRowAsGizmo, leftOfGizmo, belowTopRow,
                    initCfg, smallCfg, medCfg, bigCfg, afterDragVal, afterDragTxt, afterResetVal, afterResetTxt
                };
            })()""")
            await asyncio.sleep(0.25)
            await snap("02_rc7_fly_camera_speed_slider_position.png")
            assert c3["hiddenInOrbit"] and c3["visibleInFly"] and c3["sameRowAsGizmo"] and c3["leftOfGizmo"] and c3["belowTopRow"], f"Fly speed bar placement wrong: {c3}"
            assert c3["smallCfg"]["defaultSpeed"] < c3["medCfg"]["defaultSpeed"] < c3["bigCfg"]["defaultSpeed"], f"Default speed didn't scale with model span: {c3}"
            assert c3["smallCfg"]["max"] < c3["medCfg"]["max"] < c3["bigCfg"]["max"], f"Max speed didn't scale with model span: {c3}"
            assert abs(c3["afterDragVal"] - c3["initCfg"]["max"]) < 1e-3 and "m/s" in c3["afterDragTxt"]
            assert abs(c3["afterResetVal"] - c3["initCfg"]["defaultSpeed"]) < 1e-3
            report["checks"]["3_fly_camera_calibrated_speed_slider"] = {"pass": True, **c3}
            print(f"[PASS] 3_fly_camera_calibrated_speed_slider (demo24k default={c3['initCfg']['defaultSpeed']}m/s max={c3['initCfg']['max']}m/s; 0.5m->{c3['smallCfg']['defaultSpeed']}/{c3['smallCfg']['max']}; 35m->{c3['medCfg']['defaultSpeed']}/{c3['medCfg']['max']}; 180m->{c3['bigCfg']['defaultSpeed']}/{c3['bigCfg']['max']})")

            report["consoleErrors"] = console_errors
            assert len(console_errors) == 0, f"Console errors: {console_errors}"
            rep_path = os.path.join(out_dir, "rc7_verify_report.json")
            open(rep_path, "w", encoding="utf-8").write(json.dumps(report, indent=2, ensure_ascii=False))
            print(f"\nALL 3 RC7 VERIFICATION CHECKS PASSED! Report: {rep_path}")
    finally:
        proc.terminate()
        httpd.shutdown()
        shutil.rmtree(tmp_data, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    asyncio.run(run_suite(args.out))
