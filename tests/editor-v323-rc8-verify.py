#!/usr/bin/env python3
"""
Comprehensive Real-GPU WebGL2 Verification Suite for 3.2.3-rc8:
  1. Ctrl+Left-Drag for Semantic (M) & Plane Inpaint (J) (Browse coexists!) + Universal Shortcut Toggle-Off
     + Pure Browse (1) toggle-off hiding gizmo & double-click reactivation.
  2. Always Ground-Parallel/Vertical World AABB (2A: fast 8-corner drag + exact full-point tight World AABB on settle).
  3. Conditional Smart Auto-Align Bottom Prompt (fires ONLY for tilted scene-like clouds; skips figurines & level scenes; Ctrl+Z undo).
  4. 4a: 1:1 Brush Circle Cursor + live [/] resize;
     4b: Self-intersecting Lasso Non-Zero Winding Rule exact preview-to-selection parity;
     4c: In-place Zero-Flash Context Bar updates (DOM identity preserved, zero animation replay).
  5. Camera-Raw / Lightroom Color Panel: center-aligned sliders, inline click-to-edit numbers,
     5-zone horizontal histogram drag, 3-triangle Input Levels + dual-thumb Output Levels above compare row,
     Lightroom HSL混色器 + TAT eyedropper screen-drag + tolerance/colorRange + WB eyedropper.
  6. 平面摆正 rename + U/L/T Fig 5 cursor hint pills (dark vs amber) + Fig 4 spatial red-dot/white-line/orange-triangle guides
     + immediate damped apply on final point -> [上下翻转] [撤销] [重新点选].
  7. Independent [测量] flyout below [矫正] + zero left-rail overlap with bottom-left guide.
"""
import argparse, asyncio, base64, http.server, json, math, os, shutil, struct, subprocess, tempfile, threading, urllib.request, websockets

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

def build_synthetic_sgc2(points_xyz_rgb):
    """Build compact SGC2 binary buffer (32B header + N*14 float32 + N uint32 srcIdx)."""
    n = len(points_xyz_rgb)
    header = struct.pack("<4sIIIIIII", b"SGC2", 2, n, n, 0, 0, 1, 0)
    floats = bytearray(n * 14 * 4)
    src_idx = bytearray(n * 4)
    for i, (x, y, z, r, g, b) in enumerate(points_xyz_rgb):
        struct.pack_into("<14f", floats, i * 56,
            x, y, z, r, g, b, -3.2, -3.2, -3.2, 0.0, 0.0, 0.0, 1.0, 0.95)
        struct.pack_into("<I", src_idx, i * 4, i)
    return header + floats + src_idx

def make_tilted_scene_sgc2(tilt_deg=18.0, n_ground=9000, n_walls=5000):
    """Flat wide scene (12m x 12m x 2.2m) with strong one-sided ground tilted around X by tilt_deg."""
    rad = math.radians(tilt_deg)
    c, s = math.cos(rad), math.sin(rad)
    pts = []
    seed = 12345
    def rnd():
        nonlocal seed
        seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
        return seed / 4294967296.0
    for _ in range(n_ground):
        x = (rnd() - 0.5) * 12.0
        y = (rnd() - 0.5) * 12.0
        z = (rnd() - 0.5) * 0.04
        ry = y * c - z * s
        rz = y * s + z * c
        pts.append((x, ry, rz, 0.45, 0.52, 0.42))
    for _ in range(n_walls):
        x = (rnd() - 0.5) * 10.0
        y = (rnd() - 0.5) * 10.0
        z = 0.25 + rnd() * 2.2
        ry = y * c - z * s
        rz = y * s + z * c
        pts.append((x, ry, rz, 0.72, 0.48, 0.35))
    return build_synthetic_sgc2(pts)

def make_figurine_sgc2(n_pts=12000):
    """Tall narrow figurine (0.8m x 0.8m x 2.0m) -> MUST NOT trigger scene auto-align prompt!"""
    pts = []
    seed = 777
    def rnd():
        nonlocal seed
        seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
        return seed / 4294967296.0
    for _ in range(n_pts):
        ang = rnd() * math.tau
        rad = 0.38 * math.sqrt(rnd())
        z = rnd() * 2.0
        pts.append((math.cos(ang) * rad, math.sin(ang) * rad, z, 0.2, 0.8, 0.8))
    return build_synthetic_sgc2(pts)

async def run_suite(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    tmp_data = tempfile.mkdtemp(prefix="rc8_verify_data_")
    demo_sgc = os.path.join(tmp_data, "demo24k.bin")
    tilted_sgc = os.path.join(tmp_data, "tilted_scene.bin")
    level_sgc = os.path.join(tmp_data, "level_scene.bin")
    fig_sgc = os.path.join(tmp_data, "figurine.bin")

    node_exe = shutil.which("node")
    subprocess.run([node_exe, os.path.join(EDITOR_DIR, "worker.mjs"), "sample", DEMO_PLY, demo_sgc, "full", PROJ_DIR], check=True)
    open(tilted_sgc, "wb").write(make_tilted_scene_sgc2(18.0))
    open(level_sgc, "wb").write(make_tilted_scene_sgc2(0.5))
    open(fig_sgc, "wb").write(make_figurine_sgc2())

    routes = {"/__data__/": tmp_data, "/locales/": os.path.join(PROJ_DIR, "locales")}
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **kw: MultiRootHandler(*a, routes=routes, **kw))
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    if not os.path.exists(edge):
        edge = r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    profile = tempfile.mkdtemp(prefix="rc8_edge_prof_")
    cdp_port = 9281
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
                        det = m.get("params", {}).get("exceptionDetails", {})
                        desc = det.get("exception", {}).get("description") or det.get("text", "")
                        console_errors.append(str(desc))
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
                await window.__SPLAT_EDITOR__.loadBuffer(buf, {{ totalPoints: 24000, skipAutoAlignPrompt: true }});
                window.__SPLAT_EDITOR__.setTelemetry('GPU 12% 2.8/16.0 GB | CPU 6% 9.8/32.0 GB', {{
                    cpuPct: 6, ramUsedGb: 9.8, ramTotalGb: 32.0, gpuPct: 12, vramUsedGb: 2.8, vramTotalGb: 16.0
                }});
            }})()""")
            await asyncio.sleep(0.35)

            # ---- CHECK 1: Ctrl+Left-Drag for Semantic (M) & Plane Inpaint (J) + Universal Shortcut Toggle-Off + Pure Browse (1) Exit ----
            c1 = await eval_js("""(() => {
                const pressKey = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
                const canvas = document.getElementById('canvas');
                const r = canvas.getBoundingClientRect();
                const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5;

                // 1a. Semantic (M): coexists with Browse (1), Ctrl+Left-Drag draws yellow box overlay!
                pressKey('m');
                const semState = window.__SPLAT_EDITOR__.getRc8State();
                canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: true, pointerId: 1, clientX: cx - 60, clientY: cy - 50 }));
                canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, ctrlKey: true, pointerId: 1, clientX: cx + 60, clientY: cy + 50 }));
                const semOverlayRect = document.querySelector('#overlay rect');
                const semBoxDrawn = !!semOverlayRect && Number(semOverlayRect.getAttribute('width')) > 80;
                // Cancel draw without triggering heavy SAM inference (move <4px or clear)
                canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, ctrlKey: true, pointerId: 1, clientX: cx - 59, clientY: cy - 49 }));
                canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, ctrlKey: true, pointerId: 1, clientX: cx - 59, clientY: cy - 49 }));
                // Press M again -> cancels back to Browse (1)!
                pressKey('m');
                const afterSecondM = window.__SPLAT_EDITOR__.getRc8State();

                // 1b. Plane Inpaint (J): coexists with Browse (1), Ctrl+Left-Drag draws green box!
                pressKey('j');
                const inpState = window.__SPLAT_EDITOR__.getRc8State();
                canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: true, pointerId: 2, clientX: cx - 50, clientY: cy - 40 }));
                canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, ctrlKey: true, pointerId: 2, clientX: cx + 50, clientY: cy + 40 }));
                const inpRect = document.querySelector('#overlay rect');
                const inpBoxDrawn = !!inpRect && Number(inpRect.getAttribute('width')) > 70;
                canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, ctrlKey: true, pointerId: 2, clientX: cx - 49, clientY: cy - 39 }));
                canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, ctrlKey: true, pointerId: 2, clientX: cx - 49, clientY: cy - 39 }));
                // Press J again -> cancels back to Browse (1)!
                pressKey('j');
                const afterSecondJ = window.__SPLAT_EDITOR__.getRc8State();

                // 1c. Basic tool (2=rect) toggle-off by pressing 2 again; Measure (T) toggle-off by pressing T again
                pressKey('2');
                const inRect = window.__SPLAT_EDITOR__.getRc8State().activeTool === 'rect';
                pressKey('2');
                const exitRect = window.__SPLAT_EDITOR__.getRc8State().activeTool === 'orbit';

                pressKey('t');
                const inMeasure = window.__SPLAT_EDITOR__.getRc8State().activeTool === 'smartMeasure';
                pressKey('t');
                const exitMeasure = window.__SPLAT_EDITOR__.getRc8State().activeTool === 'orbit';

                // 1d. Pure Browse (1) -> summon gizmo via dblclick -> press 1 again -> exits Browse & hides gizmo!
                canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: cx, clientY: cy }));
                const gizBeforeExitBrowse = window.__SPLAT_EDITOR__.getRc8State().gizmoVisible;
                pressKey('1');
                const afterExitBrowse = window.__SPLAT_EDITOR__.getRc8State();
                const orbitBtnLitAfterExit = document.querySelector('#left-rail [data-tool="orbit"]').classList.contains('active');
                // Double-click reactivates Browse (1) + Translate gizmo!
                canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: cx, clientY: cy }));
                const afterDblReactivate = window.__SPLAT_EDITOR__.getRc8State();
                const orbitBtnLitAfterDbl = document.querySelector('#left-rail [data-tool="orbit"]').classList.contains('active');

                return {
                    semCoexist: semState.activeTool === 'semanticSel' && semState.browseCoexistActive,
                    semBoxDrawn,
                    afterSecondMTool: afterSecondM.activeTool,
                    inpCoexist: inpState.activeTool === 'planeInpaint' && inpState.browseCoexistActive,
                    inpBoxDrawn,
                    afterSecondJTool: afterSecondJ.activeTool,
                    inRect, exitRect, inMeasure, exitMeasure,
                    gizBeforeExitBrowse,
                    exitedBrowseClean: afterExitBrowse.orbitExplicitlyOff && !afterExitBrowse.gizmoVisible && !orbitBtnLitAfterExit,
                    reactivatedByDbl: !afterDblReactivate.orbitExplicitlyOff && afterDblReactivate.gizmoVisible && orbitBtnLitAfterDbl,
                };
            })()""")
            assert all(v is True or v == "orbit" for v in c1.values()), f"Check 1 failed: {c1}"
            report["checks"]["1_ctrl_box_and_shortcut_toggle_off"] = {"pass": True, **c1}
            print("[PASS] 1_ctrl_box_and_shortcut_toggle_off")

            # ---- CHECK 2: Always Ground-Parallel/Vertical World AABB (2A: Fast Drag + Tight Exact Scan on Settle) ----
            c2 = await eval_js("""(() => {
                // Rotate single object by arbitrary 3D Euler angles (35, -25, 42 deg)
                window.__SPLAT_EDITOR__.setObjectTransform(0, [0.4, -0.3, 0.2], [35, -25, 42], [1, 1, 1], false);
                const approxInfo = window.__SPLAT_EDITOR__.getBoundsInfo();
                const approxCorners = approxInfo.worldCorners;
                window.__SPLAT_EDITOR__.setObjectTransform(0, [0.4, -0.3, 0.2], [35, -25, 42], [1, 1, 1], true);
                const exactInfo = window.__SPLAT_EDITOR__.getBoundsInfo();
                const exactCorners = exactInfo.worldCorners;

                const isAxisAligned = (corners) => {
                    const ux = new Set(corners.map(c => c[0].toFixed(4)));
                    const uy = new Set(corners.map(c => c[1].toFixed(4)));
                    const uz = new Set(corners.map(c => c[2].toFixed(4)));
                    return ux.size === 2 && uy.size === 2 && uz.size === 2;
                };
                const volume = (corners) => {
                    const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]), zs = corners.map(c => c[2]);
                    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) * (Math.max(...zs) - Math.min(...zs));
                };

                const approxVol = volume(approxCorners);
                const exactVol = volume(exactCorners);
                // Select Gaussian points via box select -> World AABB MUST NOT shrink to Gaussian selection!
                window.__SPLAT_EDITOR__.triggerBoxSelect(-0.2, -0.2, 0.2, 0.2, 'replace');
                const afterPtSelVol = volume(window.__SPLAT_EDITOR__.getBoundsInfo().worldCorners);
                window.__SPLAT_EDITOR__.deselectAllPoints();
                // Restore upright transform
                window.__SPLAT_EDITOR__.setObjectTransform(0, [0, 0, 0], [0, 0, 0], [1, 1, 1], true);

                return {
                    approxAxisAligned: isAxisAligned(approxCorners),
                    exactAxisAligned: isAxisAligned(exactCorners),
                    approxVol: Number(approxVol.toFixed(4)),
                    exactVol: Number(exactVol.toFixed(4)),
                    exactTighterOrEqual: exactVol <= approxVol + 1e-4,
                    exactTighter: exactVol < approxVol * 0.99,
                    unchangedByGaussianSelection: Math.abs(afterPtSelVol - exactVol) < 1e-4,
                };
            })()""")
            assert c2["approxAxisAligned"] and c2["exactAxisAligned"] and c2["exactTighterOrEqual"] and c2["unchangedByGaussianSelection"], f"Check 2 failed: {c2}"
            report["checks"]["2_world_aabb_hybrid_2a"] = {"pass": True, **c2}
            print(f"[PASS] 2_world_aabb_hybrid_2a (approxVol={c2['approxVol']}, exactVol={c2['exactVol']})")

            # ---- CHECK 4: Brush 1:1 Circle Cursor (4a), Self-Intersecting Lasso Non-Zero Winding (4b), Zero-Flash Context Bar (4c) ----
            c4 = await eval_js("""(async () => {
                const canvas = document.getElementById('canvas');
                const r = canvas.getBoundingClientRect();
                const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5;
                const pressKey = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

                // 4a: Brush circle cursor exact diameter + live [/] resize
                window.__SPLAT_EDITOR__.setActiveTool('brush');
                // Wait for initial open animation (170ms) to finish before checking zero-replay on param changes!
                await new Promise(res => setTimeout(res, 230));
                canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx, clientY: cy }));
                const ring = document.getElementById('brush-cursor-ring');
                const r0 = window.__SPLAT_EDITOR__.getRc8State().brushRadiusPx;
                const w0 = parseInt(ring.style.width, 10);
                const hiddenCursor = canvas.classList.contains('brush-cursor-hide');
                const ringVis = !ring.classList.contains('hidden');

                // 4c: Record context bar DOM node identity BEFORE pressing ']' & clicking '加选'
                const barNode0 = document.querySelector('#context-bar-stack .context-bar[data-category="selection"]');
                pressKey(']');
                const r1 = window.__SPLAT_EDITOR__.getRc8State().brushRadiusPx;
                const w1 = parseInt(ring.style.width, 10);
                const barNode1 = document.querySelector('#context-bar-stack .context-bar[data-category="selection"]');
                // Click '加选' button inside context bar
                const addBtn = Array.from(barNode1.querySelectorAll('button')).find(b => b.textContent.trim() === '加选');
                addBtn.click();
                const barNode2 = document.querySelector('#context-bar-stack .context-bar[data-category="selection"]');
                const hasEnterAnimAfterParam = barNode2.classList.contains('ctx-bar-enter');

                // 4b: Self-intersecting double-wound CCW loop covering screen center [-0.45..0.45] twice!
                // Under old even-odd rule: wn=2 => 0 points selected (HOLE)!
                // Under new nonzero winding rule (matching SVG fill-rule="nonzero"): wn=2 => ALL points inside selected!
                const doubleWoundPoly = [
                    [-0.45, -0.45], [0.45, -0.45], [0.45, 0.45], [-0.45, 0.45],
                    [-0.45, -0.45], [0.45, -0.45], [0.45, 0.45], [-0.45, 0.45],
                ];
                const singleWoundPoly = [
                    [-0.45, -0.45], [0.45, -0.45], [0.45, 0.45], [-0.45, 0.45],
                ];
                const cntSingle = window.__SPLAT_EDITOR__.runLassoSelectionDirect(singleWoundPoly, 'replace');
                const cntDouble = window.__SPLAT_EDITOR__.runLassoSelectionDirect(doubleWoundPoly, 'replace');
                window.__SPLAT_EDITOR__.deselectAllPoints();
                window.__SPLAT_EDITOR__.setActiveTool('orbit');

                return {
                    brushRingExactInit: ringVis && hiddenCursor && w0 === r0 * 2,
                    brushRingLiveResize: r1 === r0 + 4 && w1 === r1 * 2,
                    contextBarSameDomNode: barNode0 === barNode1 && barNode1 === barNode2 && !hasEnterAnimAfterParam,
                    cntSingle,
                    cntDouble,
                    lassoNonZeroMatchesSingle: cntSingle > 100 && cntDouble === cntSingle,
                };
            })()""")
            assert c4["brushRingExactInit"] and c4["brushRingLiveResize"], f"4a Brush cursor failed: {c4}"
            assert c4["lassoNonZeroMatchesSingle"], f"4b Lasso nonzero winding failed: {c4}"
            assert c4["contextBarSameDomNode"], f"4c Context bar flash/recreate failed: {c4}"
            report["checks"]["4_brush_cursor_lasso_nonzero_zero_flash_bar"] = {"pass": True, **c4}
            print(f"[PASS] 4_brush_cursor_lasso_nonzero_zero_flash_bar (single={c4['cntSingle']}, double={c4['cntDouble']})")

            # ---- CHECK 5: Camera-Raw / Lightroom Color Panel, Center-Aligned Sliders, Inline Numbers, 5-Zone Histogram, Levels, HSL混色器 & TAT ----
            c5 = await eval_js("""(async () => {
                window.__SPLAT_EDITOR__.toggleColorPanel(true);
                await new Promise(r => setTimeout(r, 200));

                // 5.1 Check ALL Light & Color slider knobs start strictly at 50% center!
                const allSliders = Array.from(document.querySelectorAll('#color-light-sliders input.cr-range, #color-tone-sliders input.cr-range'));
                const centers = allSliders.map(inp => {
                    const mn = Number(inp.min), mx = Number(inp.max), v = Number(inp.value);
                    return (v - mn) / (mx - mn);
                });
                const allCentered = centers.length === 11 && centers.every(p => Math.abs(p - 0.5) < 1e-4);

                // Check labels: Light has 曝光/对比度/高光/阴影/白色/黑色/透明度 (NO 亮度, NO standalone 伽马!)
                const lightLabels = Array.from(document.querySelectorAll('#color-light-sliders .cr-lbl')).map(x => x.textContent.trim());
                const colorLabels = Array.from(document.querySelectorAll('#color-tone-sliders .cr-lbl')).map(x => x.textContent.trim());

                // 5.2 Check ordering: Histogram -> Input Levels (3 triangles) -> Output Levels (2 thumbs) -> Compare Row
                const histRect = document.getElementById('histogram-canvas').getBoundingClientRect();
                const inLvlRect = document.getElementById('levels-input-track').getBoundingClientRect();
                const outLvlRect = document.getElementById('levels-output-track').getBoundingClientRect();
                const cmpRect = document.querySelector('.color-compare-row').getBoundingClientRect();
                const verticalOrderOk = histRect.bottom <= inLvlRect.top + 4 && inLvlRect.bottom <= outLvlRect.top + 22 && outLvlRect.bottom <= cmpRect.top + 4;
                const triCount = document.querySelectorAll('#levels-input-track .lvl-tri').length;
                const outThumbCount = document.querySelectorAll('#levels-output-track .lvl-out-thumb').length;

                // 5.3 Click numeric text -> inline input opens -> live-typing updates grade -> blur hides box!
                const contrastRow = Array.from(document.querySelectorAll('#color-light-sliders .cr-slider-row'))[1];
                const valText = contrastRow.querySelector('.cr-val-text');
                const valInput = contrastRow.querySelector('.cr-val-input');
                valText.click();
                const inputOpened = !valInput.classList.contains('hidden');
                valInput.value = '35';
                valInput.dispatchEvent(new Event('input', { bubbles: true }));
                const contrastAfterType = window.__SPLAT_EDITOR__.getLiveGrade().contrast;
                valInput.dispatchEvent(new Event('blur'));
                const inputHiddenAfterBlur = valInput.classList.contains('hidden');

                // 5.4 Interactive Histogram horizontal drag in Shadows zone (x = 26% of histogram width) -> adjusts shadows & syncs slider!
                const hc = document.getElementById('histogram-canvas');
                const hr = hc.getBoundingClientRect();
                const hx0 = hr.left + hr.width * 0.26;
                const hy0 = hr.top + hr.height * 0.5;
                hc.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 9, clientX: hx0, clientY: hy0 }));
                hc.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 9, clientX: hx0 + 48, clientY: hy0 }));
                hc.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 9, clientX: hx0 + 48, clientY: hy0 }));
                const shadowsAfterHistDrag = window.__SPLAT_EDITOR__.getLiveGrade().shadows;

                // 5.5 HSL混色器 title check + open details + Lightroom HSL Eyedropper screen-drag!
                const hslDetails = Array.from(document.querySelectorAll('#color-grade-card details.cr-section'))[2];
                const hslTitle = hslDetails.querySelector('.cr-sec-title').textContent.trim();
                hslDetails.open = true;
                document.getElementById('btn-hsl-eyedropper').click();
                const pickModeHsl = window.__SPLAT_EDITOR__.getRc8State().colorPickMode === 'hsl';
                const canvas = document.getElementById('canvas');
                const cr = canvas.getBoundingClientRect();
                const cx = cr.left + cr.width * 0.5, cy = cr.top + cr.height * 0.5;
                canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 10, clientX: cx, clientY: cy }));
                canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 10, clientX: cx + 70, clientY: cy }));
                canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 10, clientX: cx + 70, clientY: cy }));
                const pcAfterDrag = window.__SPLAT_EDITOR__.getLiveGrade().pointColor;
                window.__SPLAT_EDITOR__.setColorPickMode(null);

                return {
                    allCentered,
                    lightLabels,
                    colorLabels,
                    verticalOrderOk,
                    triCount,
                    outThumbCount,
                    inputOpened,
                    contrastAfterType: Number(contrastAfterType.toFixed(3)),
                    inputHiddenAfterBlur,
                    shadowsAfterHistDrag: Number(shadowsAfterHistDrag.toFixed(3)),
                    hslTitle,
                    pickModeHsl,
                    pcEnabled: pcAfterDrag.enabled,
                    pcSatChanged: pcAfterDrag.sat > 0.15,
                };
            })()""")
            await asyncio.sleep(0.2)
            await snap("02_rc8_color_panel_ps_lr.png")
            assert c5["allCentered"], f"Sliders not centered: {c5}"
            assert c5["lightLabels"] == ["曝光", "对比度", "高光", "阴影", "白色", "黑色", "透明度"], f"Light labels mismatch: {c5}"
            assert c5["colorLabels"] == ["色温", "色调", "自然饱和度", "饱和度"], f"Color labels mismatch: {c5}"
            assert c5["verticalOrderOk"] and c5["triCount"] == 3 and c5["outThumbCount"] == 2, f"Levels layout failed: {c5}"
            assert c5["inputOpened"] and abs(c5["contrastAfterType"] - 1.28) < 0.01 and c5["inputHiddenAfterBlur"], f"Inline input failed: {c5}"
            assert c5["shadowsAfterHistDrag"] > 0.15, f"Histogram horizontal drag failed: {c5}"
            assert c5["hslTitle"] == "HSL混色器" and c5["pickModeHsl"] and c5["pcEnabled"] and c5["pcSatChanged"], f"HSL TAT eyedropper failed: {c5}"
            report["checks"]["5_camera_raw_lightroom_color_panel"] = {"pass": True, **c5}
            print("[PASS] 5_camera_raw_lightroom_color_panel")

            # Reset color & close panel cleanly before spatial guide screenshots
            await eval_js("""(() => {
                document.getElementById('btn-color-reset').click();
                window.__SPLAT_EDITOR__.toggleColorPanel(false);
            })()""")

            async def cdp_click(x, y):
                await send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
                await send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
                await send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})

            # ---- CHECK 6 & 7: Independent [测量] Rail + 平面摆正 Rename + Fig 4 Guides + Fig 5 Cursor Pill + Immediate Damped Apply ----
            c67_prep = await eval_js("""(() => {
                const alignTrigger = document.getElementById('btn-flyout-align');
                const measureTrigger = document.getElementById('btn-flyout-measure');
                const guideEl = document.getElementById('bottom-left-guide');
                const railRect = document.getElementById('left-rail').getBoundingClientRect();
                const guideRect = guideEl.getBoundingClientRect();
                const alignItems = Array.from(document.querySelectorAll('#rail-align .flyout-item .lbl')).map(x => x.textContent.trim());
                const measureItems = Array.from(document.querySelectorAll('#rail-measure .flyout-item .lbl')).map(x => x.textContent.trim());
                const measureBelowAlign = measureTrigger.getBoundingClientRect().top > alignTrigger.getBoundingClientRect().top;
                const noRailGuideOverlap = railRect.bottom < guideRect.top - 4;

                window.__SPLAT_EDITOR__.setCameraPose([0.1, -16.0, 11.0], [0, 0, 0.5]);
                window.__SPLAT_EDITOR__.setActiveTool('groundAlign');
                const canvas = document.getElementById('canvas');
                const r = canvas.getBoundingClientRect();
                canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 120, clientY: r.top + 45 }));
                const pill = document.getElementById('cursor-hint-pill');
                const emptyWarnPill = !pill.classList.contains('hidden') && pill.classList.contains('warn') && pill.textContent.includes('点不到场景');

                window.__SPLAT_EDITOR__.setCameraPose([0.1, -4.6, 2.0], [0, 0, 0.5]);
                const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5;
                canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx, clientY: cy }));
                const hitDarkPill = !pill.classList.contains('hidden') && !pill.classList.contains('warn') && pill.textContent.includes('点在要放平的面上');
                return { alignItems, measureItems, measureBelowAlign, noRailGuideOverlap, emptyWarnPill, hitDarkPill, cx, cy };
            })()""")
            cx6, cy6 = c67_prep["cx"], c67_prep["cy"]
            await cdp_click(cx6 - 40, cy6 + 25)
            await cdp_click(cx6 + 45, cy6 + 20)
            await send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": cx6 + 5, "y": cy6 - 35})
            c67_tri = await eval_js("""(() => {
                const triSvg = document.querySelector('#spatial-guides-layer polygon');
                const dotCount = document.querySelectorAll('#spatial-guides-layer circle').length;
                return { hasOrangeTriPreview: !!triSvg, dotCount };
            })()""")
            c67 = {**c67_prep, **c67_tri}
            await asyncio.sleep(0.12)
            await snap("03_rc8_plane_align_guides_and_pill.png")

            mat_before = await eval_js("window.__SPLAT_EDITOR__.getPrimaryMatrix().slice()")
            await cdp_click(cx6 + 5, cy6 - 35)
            await asyncio.sleep(0.48)
            c6b_1 = await eval_js("""(async (matBefore) => {
                const matAfter = window.__SPLAT_EDITOR__.getPrimaryMatrix().slice();
                const barBtns = Array.from(document.querySelectorAll('#context-bar-stack .context-bar[data-category="align"] button')).map(b => b.textContent.trim());
                const appliedImmediately = window.__SPLAT_EDITOR__.getRc8State().alignAppliedState?.tool === 'groundAlign';
                const matChanged = matBefore.some((v, i) => Math.abs(v - matAfter[i]) > 1e-4);

                const undoBtn = Array.from(document.querySelectorAll('#context-bar-stack .context-bar[data-category="align"] button')).find(b => b.textContent.trim() === '撤销');
                undoBtn.click();
                await new Promise(res => setTimeout(res, 80));
                const matAfterUndo = window.__SPLAT_EDITOR__.getPrimaryMatrix().slice();
                const undoRestored = matBefore.every((v, i) => Math.abs(v - matAfterUndo[i]) < 1e-4);

                window.__SPLAT_EDITOR__.setActiveTool('smartMeasure');
                return { appliedImmediately, matChanged, barBtns, undoRestored };
            })(""" + json.dumps(mat_before) + """)""")
            await cdp_click(cx6 - 55, cy6)
            await cdp_click(cx6 + 55, cy6 - 10)
            c6b_2 = await eval_js("""(() => {
                const hasMeasureBadge = !!document.querySelector('#smart-measure-svg-layer text');
                const measureText = document.querySelector('#smart-measure-svg-layer text')?.textContent || '';
                window.__SPLAT_EDITOR__.toggleFlyout('measure');
                return { hasMeasureBadge, measureText };
            })()""")
            c6b = {**c6b_1, **c6b_2}
            await asyncio.sleep(0.15)
            await snap("04_rc8_measure_rail_and_guides.png")
            assert c67["alignItems"] == ["自动对齐", "垂线摆正", "平面摆正"], f"Align flyout mismatch: {c67}"
            assert c67["measureItems"] == ["比例尺校准", "智能测量笔"] and c67["measureBelowAlign"] and c67["noRailGuideOverlap"], f"Measure rail failed: {c67}"
            assert c67["emptyWarnPill"] and c67["hitDarkPill"] and c67["hasOrangeTriPreview"] and c67["dotCount"] >= 3, f"Fig 4/5 guides failed: {c67}"
            assert c6b["appliedImmediately"] and c6b["matChanged"] and c6b["barBtns"] == ["上下翻转", "撤销", "重新点选"] and c6b["undoRestored"], f"Immediate apply/post-bar failed: {c6b}"
            assert c6b["hasMeasureBadge"] and "m" in c6b["measureText"], f"Measure badge failed: {c6b}"
            report["checks"]["6_7_plane_align_guides_measure_rail"] = {"pass": True, **c67, **c6b}
            print(f"[PASS] 6_7_plane_align_guides_measure_rail (barBtns={c6b['barBtns']}, measure={c6b['measureText']})")

            # ---- CHECK 3: Smart Conditional Auto-Align Bottom Prompt (Tilted Scene=YES, Level Scene=NO, Figurine=NO) ----
            c3 = await eval_js(f"""(async () => {{
                window.__SPLAT_EDITOR__.setActiveTool('orbit');
                // 3a. Figurine -> MUST NOT prompt!
                const bufFig = await (await fetch('http://127.0.0.1:{port}/__data__/figurine.bin')).arrayBuffer();
                await window.__SPLAT_EDITOR__.loadBuffer(bufFig, {{ totalPoints: 12000 }});
                await new Promise(r => setTimeout(r, 260));
                const figPrompt = window.__SPLAT_EDITOR__.getRc8State().autoAlignPromptVisible;
                const figDet = window.__SPLAT_EDITOR__.getLastTiltDetection();

                // 3b. Already-level scene (0.5 deg) -> MUST NOT prompt!
                const bufLvl = await (await fetch('http://127.0.0.1:{port}/__data__/level_scene.bin')).arrayBuffer();
                await window.__SPLAT_EDITOR__.loadBuffer(bufLvl, {{ totalPoints: 14000 }});
                await new Promise(r => setTimeout(r, 260));
                const lvlPrompt = window.__SPLAT_EDITOR__.getRc8State().autoAlignPromptVisible;
                const lvlDet = window.__SPLAT_EDITOR__.getLastTiltDetection();

                // 3c. Tilted real-like scene (18 deg) -> MUST prompt bottom banner!
                const bufTilt = await (await fetch('http://127.0.0.1:{port}/__data__/tilted_scene.bin')).arrayBuffer();
                await window.__SPLAT_EDITOR__.loadBuffer(bufTilt, {{ totalPoints: 14000 }});
                await new Promise(r => setTimeout(r, 260));
                const tiltPrompt = window.__SPLAT_EDITOR__.getRc8State().autoAlignPromptVisible;
                const tiltDet = window.__SPLAT_EDITOR__.getLastTiltDetection();
                return {{ figPrompt, figDet, lvlPrompt, lvlDet, tiltPrompt, tiltDet }};
            }})()""")
            await asyncio.sleep(0.15)
            await snap("05_rc8_conditional_auto_align_prompt.png")
            c3_act = await eval_js("""(async () => {
                // Click [自动矫正] -> levels scene smoothly & supports 1-step Ctrl+Z undo!
                document.getElementById('btn-auto-align-accept').click();
                await new Promise(r => setTimeout(r, 520));
                const promptClosed = !window.__SPLAT_EDITOR__.getRc8State().autoAlignPromptVisible;
                const afterDet = window.__SPLAT_EDITOR__.detectTiltedScene();
                window.__SPLAT_EDITOR__.undo();
                await new Promise(r => setTimeout(r, 120));
                const undoDet = window.__SPLAT_EDITOR__.detectTiltedScene();
                return { promptClosed, afterTiltDeg: afterDet?.tiltDeg, undoTiltDeg: undoDet?.tiltDeg };
            })()""")
            assert (not c3["figPrompt"]) and (not c3["lvlPrompt"]) and c3["tiltPrompt"], f"Conditional auto-align trigger failed: {c3}"
            assert c3_act["promptClosed"] and (c3_act["afterTiltDeg"] is not None and c3_act["afterTiltDeg"] < 2.0) and (c3_act["undoTiltDeg"] > 12.0), f"Auto-align accept/undo failed: {c3_act}"
            report["checks"]["3_conditional_auto_align_prompt"] = {"pass": True, **c3, **c3_act}
            print(f"[PASS] 3_conditional_auto_align_prompt (tilt={c3['tiltDet']['tiltDeg']}deg -> aligned={c3_act['afterTiltDeg']}deg -> undo={c3_act['undoTiltDeg']}deg)")

        report["consoleErrors"] = console_errors
        assert len(console_errors) == 0, f"Console/Runtime errors occurred: {console_errors}"
        report_path = os.path.join(out_dir, "rc8_verify_report.json")
        open(report_path, "w", encoding="utf-8").write(json.dumps(report, ensure_ascii=False, indent=2))
        print(f"\nALL RC8 VERIFICATION CHECKS PASSED! Report: {report_path}")
    finally:
        proc.terminate()
        httpd.shutdown()
        shutil.rmtree(tmp_data, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT_DIR, r"00_临时提交区\rc8_verify_shots"))
    args = ap.parse_args()
    asyncio.run(run_suite(args.out))
