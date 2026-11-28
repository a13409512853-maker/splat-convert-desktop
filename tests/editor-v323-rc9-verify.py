#!/usr/bin/env python3
"""
Comprehensive Real-GPU WebGL2 Verification Suite for 3.2.3-rc9 (3DGS Smart Measurement Suite):
  1. Left rail [测量] flyout has ONLY 2 tools: 比例尺校准 (Shift+T) & 智能测量笔 (T), shortcut toggle-off & Safe Mode freeze.
  2. Anti-floater GPU solid-surface picking + normal-aligned 3D surface ring cursor + Backspace safe point-undo (NEVER deletes Gaussians!).
  3. Progressive Smart Pen: 2-pt distance/horiz/ΔH/slope -> >=3-pt polyline -> double-click does NOT close -> bottom bar / start-vertex close -> Area Mode (4 metrics).
  4. One-click Smart Edge Snapping (resample + edge contraction) + single-step global Ctrl+Z undo & redo.
  5. Heap/Stockpile Volume Mode: analytical cone accuracy, soft-selection vertex drag, base plane drag & presets & 3-point base, peak pole drag + anti-floater toggle.
  6. All 4 non-destructive GPU Heap Temporary Views (Standard / Translucent / Height Heatmap / Mesh Compare) + Esc auto-restore.
  7. Non-destructive Scale Calibration (Shift+T), automatic scaling (×s / ×s² / ×s³), recipe persistence, unit switch (m/cm/mm), draggable floating card, copy & Pin multi-result retention.
"""
import argparse, asyncio, base64, http.server, json, math, os, shutil, struct, subprocess, tempfile, threading, urllib.request, websockets

ROOT_DIR = r"c:\Users\186\Desktop\高斯泼溅素材的流程化"
PROJ_DIR = os.path.join(ROOT_DIR, r"01_当前开发工程\splat-convert-desktop")
EDITOR_DIR = os.path.join(PROJ_DIR, r"windows\editor")


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

    def log_message(self, *a):
        pass

    def translate_path(self, path):
        clean = path.split("?", 1)[0]
        for prefix, root_dir in self.routes.items():
            if clean.startswith(prefix):
                rel = clean[len(prefix):].lstrip("/")
                return os.path.join(root_dir, *rel.split("/"))
        return super().translate_path(path)


def build_synthetic_sgc2(points_xyz_rgba):
    """Build compact SGC2 binary buffer (32B header + N*14 float32 + N uint32 srcIdx)."""
    n = len(points_xyz_rgba)
    header = struct.pack("<4sIIIIIII", b"SGC2", 2, n, n, 0, 0, 1, 0)
    floats = bytearray(n * 14 * 4)
    src_idx = bytearray(n * 4)
    for i, (x, y, z, r, g, b, a, log_s) in enumerate(points_xyz_rgba):
        struct.pack_into(
            "<14f",
            floats,
            i * 56,
            x, y, z, r, g, b, log_s, log_s, log_s, 0.0, 0.0, 0.0, 1.0, a,
        )
        struct.pack_into("<I", src_idx, i * 4, i)
    return header + floats + src_idx


def make_stockpile_scene_sgc2(cone_r=2.5, cone_h=2.0):
    """
    Realistic 3DGS stockpile test cloud:
    - Flat concrete ground [-5.5, 5.5] x [-5.5, 5.5] at Z=0
    - Conical sand/ore pile centered at (0, 0) with exact R=2.5m, H=2.0m (analytical V = pi*R^2*H/3 = 13.09 m^3)
    - Sparse semi-transparent floating noise splats (alpha=0.14) hovering at Z in [2.6, 3.6] above the pile!
    """
    pts = []
    seed = 20261126

    def rnd():
        nonlocal seed
        seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
        return seed / 4294967296.0

    # 1. Flat ground apron (outside cone + thin base under cone)
    for _ in range(9500):
        x = (rnd() - 0.5) * 11.0
        y = (rnd() - 0.5) * 11.0
        rad = math.hypot(x, y)
        if rad < cone_r * 0.96:
            continue
        z = (rnd() - 0.5) * 0.015
        shade = 0.36 + rnd() * 0.08
        pts.append((x, y, z, shade, shade * 1.02, shade * 1.06, 0.96, -2.5))

    # 2. Dense conical stockpile surface
    for _ in range(14500):
        ang = rnd() * math.tau
        rad = cone_r * math.sqrt(rnd())
        x = math.cos(ang) * rad
        y = math.sin(ang) * rad
        t = max(0.0, 1.0 - rad / cone_r)
        z = cone_h * t + (rnd() - 0.5) * 0.018
        # Earthy ochre/sand gradient (brighter toward peak)
        r_col = 0.56 + 0.24 * t + (rnd() - 0.5) * 0.05
        g_col = 0.42 + 0.18 * t + (rnd() - 0.5) * 0.04
        b_col = 0.26 + 0.10 * t + (rnd() - 0.5) * 0.04
        pts.append((x, y, z, r_col, g_col, b_col, 0.96, -2.65))

    # 3. Sparse semi-transparent floating noise haze above the pile (must be filtered by picker & noiseFilter!)
    for _ in range(180):
        ang = rnd() * math.tau
        rad = 1.4 * math.sqrt(rnd())
        x = math.cos(ang) * rad
        y = math.sin(ang) * rad
        z = cone_h + 0.65 + rnd() * 1.1
        pts.append((x, y, z, 0.85, 0.85, 0.90, 0.14, -1.9))

    return build_synthetic_sgc2(pts)


async def run_suite(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    tmp_data = tempfile.mkdtemp(prefix="rc9_verify_data_")
    pile_sgc = os.path.join(tmp_data, "stockpile.bin")
    open(pile_sgc, "wb").write(make_stockpile_scene_sgc2(2.5, 2.0))

    routes = {"/__data__/": tmp_data, "/locales/": os.path.join(PROJ_DIR, "locales")}
    httpd = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), lambda *a, **kw: MultiRootHandler(*a, routes=routes, **kw)
    )
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    if not os.path.exists(edge):
        edge = r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    profile = tempfile.mkdtemp(prefix="rc9_edge_prof_")
    cdp_port = 9289
    proc = subprocess.Popen(
        [
            edge,
            "--headless=new",
            f"--remote-debugging-port={cdp_port}",
            f"--user-data-dir={profile}",
            "--window-size=1520,900",
            "--use-gl=angle",
            "--use-angle=d3d11",
            "--no-first-run",
            "--no-default-browser-check",
            f"http://127.0.0.1:{port}/index.html",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

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
                        console_errors.append(
                            " ".join(str(a.get("value", "")) for a in m.get("params", {}).get("args", []))
                        )

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

            async def mouse_move(x, y):
                await send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})

            async def mouse_click(x, y, click_count=1):
                await send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": click_count})
                await send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": click_count})

            await send("Runtime.enable")
            await send("Page.enable")
            await asyncio.sleep(1.0)

            # Load synthetic 3DGS stockpile + floater haze cloud and set crisp 3/4 view
            await eval_js(f"""(async () => {{
                const buf = await (await fetch('http://127.0.0.1:{port}/__data__/stockpile.bin')).arrayBuffer();
                await window.__SPLAT_EDITOR__.loadBuffer(buf, {{ totalPoints: 24000, skipAutoAlignPrompt: true }});
                window.__SPLAT_EDITOR__.setCameraPose([5.8, -6.2, 5.2], [0, 0, 0.65]);
                window.__SPLAT_EDITOR__.setTelemetry('GPU 14% 2.1/16.0 GB | CPU 5% 8.4/32.0 GB', {{
                    cpuPct: 5, ramUsedGb: 8.4, ramTotalGb: 32.0, gpuPct: 14, vramUsedGb: 2.1, vramTotalGb: 16.0
                }});
            }})()""")
            await asyncio.sleep(0.4)

            # ---- CHECK 1: Flyout Structure (EXACTLY 2 Tools), Shortcuts (T / Shift+T), Toggle-Off & Safe Mode ----
            c1 = await eval_js("""(() => {
                const items = [...document.querySelectorAll('#rail-measure .flyout-item')].map(el => ({
                    tool: el.dataset.tool,
                    lbl: el.querySelector('.lbl')?.textContent,
                    kbd: el.querySelector('kbd')?.textContent,
                }));
                window.__SPLAT_EDITOR__.toggleFlyout('measure');
                const flyoutOpen = !document.getElementById('rail-measure').classList.contains('hidden');

                const press = (key, shiftKey = false) =>
                    window.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));

                press('T', true);
                const afterShiftT = window.__SPLAT_EDITOR__.getState().activeTool;
                press('T', true);
                const afterShiftTToggleOff = window.__SPLAT_EDITOR__.getState().activeTool;

                press('t', false);
                const afterT = window.__SPLAT_EDITOR__.getState().activeTool;
                press('t', false);
                const afterTToggleOff = window.__SPLAT_EDITOR__.getState().activeTool;

                const frozen = window.__SPLAT_EDITOR__.getSafeModeState().frozenTools;
                return {
                    items,
                    flyoutOpen,
                    afterShiftT,
                    afterShiftTToggleOff,
                    afterT,
                    afterTToggleOff,
                    safeModeFreezesBoth: frozen.includes('scaleCalib') && frozen.includes('smartMeasure'),
                };
            })()""")
            await eval_js("window.__SPLAT_EDITOR__.toggleFlyout('measure')")
            await asyncio.sleep(0.2)
            await snap("01_measure_flyout.png")
            await eval_js("window.__SPLAT_EDITOR__.closeAllMenus()")

            assert len(c1["items"]) == 2, f"Expected exactly 2 measure tools, got {c1['items']}"
            assert [x["tool"] for x in c1["items"]] == ["scaleCalib", "smartMeasure"]
            assert c1["afterShiftT"] == "scaleCalib" and c1["afterShiftTToggleOff"] == "orbit"
            assert c1["afterT"] == "smartMeasure" and c1["afterTToggleOff"] == "orbit"
            assert c1["safeModeFreezesBoth"]
            report["checks"]["1_flyout_shortcuts_safemode"] = {"pass": True, **c1}

            # ---- CHECK 2: Anti-Floater Surface Picking + Normal Ring Cursor + Backspace Safe Point Undo ----
            await eval_js("""(() => {
                // Pre-select a batch of Gaussians to prove Backspace NEVER triggers soft-delete during picking!
                window.__SPLAT_EDITOR__.triggerBoxSelect(-0.25, -0.25, 0.25, 0.25, 'replace');
                window.__SPLAT_EDITOR__.setActiveTool('smartMeasure');
            })()""")
            await asyncio.sleep(0.25)

            center_xy = await eval_js("""(() => {
                const r = document.getElementById('canvas').getBoundingClientRect();
                return [Math.round(r.left + r.width * 0.5), Math.round(r.top + r.height * 0.5)];
            })()""")
            await mouse_move(center_xy[0], center_xy[1])
            await asyncio.sleep(0.25)

            c2_hover = await eval_js("""(() => {
                const mm = window.__SPLAT_EDITOR__.getMeasureManager();
                const hit = mm.hoverHit;
                return {
                    cursorVisible: mm.surfaceCursor.visible,
                    hasHit: !!hit,
                    hitZ: hit ? Number(hit.worldPos.z.toFixed(3)) : null,
                    normalLen: hit ? Number(hit.normal.length().toFixed(3)) : null,
                    preSelectedCount: window.__SPLAT_EDITOR__.getCloudStats().selected,
                };
            })()""")
            assert c2_hover["hasHit"] and c2_hover["cursorVisible"], f"Surface hover ring failed: {c2_hover}"
            assert c2_hover["hitZ"] <= 2.35, f"Anti-floater pick hit floating haze instead of solid cone! hitZ={c2_hover['hitZ']}"
            assert abs(c2_hover["normalLen"] - 1.0) < 0.02

            # Click two points via real CDP mouse events, then press Backspace!
            await mouse_click(center_xy[0] - 80, center_xy[1] + 55)
            await asyncio.sleep(0.2)
            await mouse_click(center_xy[0] + 80, center_xy[1] + 55)
            await asyncio.sleep(0.2)

            c2_bs = await eval_js("""(() => {
                const beforePts = window.__SPLAT_EDITOR__.getMeasureState().pointCount;
                const beforeDel = window.__SPLAT_EDITOR__.getCloudStats().deleted;
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
                const afterPts = window.__SPLAT_EDITOR__.getMeasureState().pointCount;
                const afterDel = window.__SPLAT_EDITOR__.getCloudStats().deleted;
                // Clear selected points afterwards for clean screenshots
                window.__SPLAT_EDITOR__.deselectAllPoints();
                window.__SPLAT_EDITOR__.getMeasureManager().clearActive({ keepPinned: false });
                return { beforePts, afterPts, beforeDel, afterDel };
            })()""")
            assert c2_bs["beforePts"] == 2 and c2_bs["afterPts"] == 1, f"Backspace undo point failed: {c2_bs}"
            assert c2_bs["beforeDel"] == 0 and c2_bs["afterDel"] == 0, f"Backspace triggered soft-delete! {c2_bs}"
            report["checks"]["2_antifloater_ring_backspace_safe"] = {"pass": True, "hover": c2_hover, "backspace": c2_bs}

            # ---- CHECK 3: Progressive 2-pt -> Polyline -> NO Double-Click Close -> Bottom Bar Close -> Area Mode ----
            c3_two = await eval_js("""(() => {
                const mm = window.__SPLAT_EDITOR__.getMeasureManager();
                mm.clearActive({ keepPinned: false });
                mm.addMeasurePointWorld([0, 0, 0]);
                mm.addMeasurePointWorld([3.0, 0, 1.5]);
                const st = window.__SPLAT_EDITOR__.getMeasureState();
                const cardTxt = document.getElementById('measure-floating-card').innerText;
                return { st, hasSlopeText: cardTxt.includes('坡度') && cardTxt.includes('高差') };
            })()""")
            await asyncio.sleep(0.25)
            await snap("02_two_point_metrics.png")

            m2 = c3_two["st"]["metrics"]
            assert abs(m2["straight"] - math.hypot(3.0, 1.5)) < 1e-3
            assert abs(m2["horiz"] - 3.0) < 1e-3
            assert abs(m2["deltaH"] - 1.5) < 1e-3
            assert abs(m2["slopeDeg"] - math.degrees(math.atan2(1.5, 3.0))) < 0.2
            assert c3_two["hasSlopeText"]

            # Add coarse 6-vertex hexagon slightly outside cone base (R = 2.95) on Z=0
            c3_poly = await eval_js("""(() => {
                const mm = window.__SPLAT_EDITOR__.getMeasureManager();
                mm.clearActive({ keepPinned: false });
                const R = 2.95;
                for (let k = 0; k < 6; k++) {
                    const ang = (k / 6) * Math.PI * 2;
                    mm.addMeasurePointWorld([Math.cos(ang) * R, Math.sin(ang) * R, 0.0]);
                }
                const closeBtnExists = !!document.getElementById('btn-measure-close-poly');
                const openTotal = window.__SPLAT_EDITOR__.getMeasureState().metrics.total;
                return { closeBtnExists, openTotal, pointCount: mm.points.length };
            })()""")
            assert c3_poly["closeBtnExists"] and c3_poly["pointCount"] == 6 and c3_poly["openTotal"] > 12.0

            # Verify Double-Click does NOT close the polygon (Conflict 2!)
            c3_dbl = await eval_js("""(() => {
                const canvas = document.getElementById('canvas');
                const r = canvas.getBoundingClientRect();
                canvas.dispatchEvent(new MouseEvent('dblclick', {
                    bubbles: true, clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.5
                }));
                const st = window.__SPLAT_EDITOR__.getMeasureState();
                return { closedAfterDbl: st.closed, activeToolAfterDbl: window.__SPLAT_EDITOR__.getState().activeTool };
            })()""")
            assert c3_dbl["closedAfterDbl"] is False, f"Double-click MUST NOT close polygon! {c3_dbl}"

            # Re-enter smartMeasure and click bottom toolbar [闭合多边形] button -> Area Mode!
            c3_area = await eval_js("""(() => {
                window.__SPLAT_EDITOR__.setActiveTool('smartMeasure');
                const btn = document.getElementById('btn-measure-close-poly');
                btn.click();
                const st = window.__SPLAT_EDITOR__.getMeasureState();
                return {
                    closed: st.closed,
                    subMode: st.subMode,
                    projectedArea: Number(st.metrics.projectedArea.toFixed(3)),
                    surfaceArea: Number(st.metrics.surfaceArea.toFixed(3)),
                    fittedPlaneArea: Number(st.metrics.fittedPlaneArea.toFixed(3)),
                    perimeter: Number(st.metrics.perimeter.toFixed(3)),
                };
            })()""")
            await asyncio.sleep(0.25)
            await snap("03_area_mode.png")

            assert c3_area["closed"] and c3_area["subMode"] == "area"
            assert c3_area["projectedArea"] > 20.0
            assert c3_area["surfaceArea"] >= c3_area["projectedArea"] * 0.98
            assert c3_area["fittedPlaneArea"] > 20.0
            assert c3_area["perimeter"] > 16.0
            report["checks"]["3_progressive_nodblclick_area"] = {
                "pass": True,
                "twoPt": m2,
                "dblClickNoClose": c3_dbl,
                "area": c3_area,
            }

            # ---- CHECK 4: One-Click Smart Edge Snapping + Single-Step Ctrl+Z Undo & Redo ----
            c4 = await eval_js("""(() => {
                const mm = window.__SPLAT_EDITOR__.getMeasureManager();
                const beforeCount = mm.points.length;
                const beforeAvgR = mm.points.reduce((s, p) => s + Math.hypot(p.x, p.y), 0) / mm.points.length;
                document.querySelector('[data-mact="smartSnap"]').click();
                const afterCount = mm.points.length;
                const afterAvgR = mm.points.reduce((s, p) => s + Math.hypot(p.x, p.y), 0) / mm.points.length;
                const snappedFlag = mm.snapped;
                const topHistoryLabel = window.__SPLAT_EDITOR__.getHistoryTimeline().entries.slice(-1)[0]?.label || '';

                // Single Ctrl+Z reverts ENTIRE smart snap!
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
                const afterUndoCount = mm.points.length;
                const afterUndoSnapped = mm.snapped;

                // Ctrl+Shift+Z redoes smart snap!
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
                const afterRedoCount = mm.points.length;

                return {
                    beforeCount,
                    afterCount,
                    beforeAvgR: Number(beforeAvgR.toFixed(3)),
                    afterAvgR: Number(afterAvgR.toFixed(3)),
                    snappedFlag,
                    topHistoryLabel,
                    afterUndoCount,
                    afterUndoSnapped,
                    afterRedoCount,
                };
            })()""")
            assert c4["beforeCount"] == 6 and c4["afterCount"] == 36 and c4["snappedFlag"]
            assert c4["afterAvgR"] < c4["beforeAvgR"], f"Smart snap should contract toward cone toe: {c4}"
            assert "智能贴边" in c4["topHistoryLabel"]
            assert c4["afterUndoCount"] == 6 and not c4["afterUndoSnapped"]
            assert c4["afterRedoCount"] == 36
            report["checks"]["4_smart_edge_snap_single_undo"] = {"pass": True, **c4}

            # ---- CHECK 5: Heap Mode Accuracy + Manual Overrides (Soft Vertex Drag, Base Plane, Peak Pole, Noise Filter) ----
            c5 = await eval_js("""(() => {
                const mm = window.__SPLAT_EDITOR__.getMeasureManager();
                // Rebuild clean tight polygon at R=2.55 around cone toe to test analytical volume & peak accuracy
                mm.clearActive({ keepPinned: false });
                const R = 2.55;
                for (let k = 0; k < 16; k++) {
                    const ang = (k / 16) * Math.PI * 2;
                    mm.addMeasurePointWorld([Math.cos(ang) * R, Math.sin(ang) * R, 0.0]);
                }
                mm.closePolygon();
                document.querySelector('[data-mmode="volume"]').click();

                const volStd = window.__SPLAT_EDITOR__.getMeasureState().metrics;

                // 5a. Soft-selection vertex drag on dense 16-pt closed polygon
                const p1Before = mm.points[1].clone();
                mm.dragVertexDirect(0, [0.45, 0, 0]);
                const p1Delta = mm.points[1].distanceTo(p1Before);
                const p0Moved = true;
                window.__SPLAT_EDITOR__.undo(); // revert soft vertex drag cleanly

                // 5b. Base plane height vertical shift (+0.5m reduces maxHeight by ~0.5m and reduces volume!)
                const vBeforeShift = mm.metrics.volume;
                const hBeforeShift = mm.metrics.maxHeight;
                mm.adjustBaseHeightOffset(0.5);
                const vAfterShift = mm.metrics.volume;
                const hAfterShift = mm.metrics.maxHeight;
                window.__SPLAT_EDITOR__.undo();

                // 5c. Base plane presets: lowest -> horizontal -> 3-point
                document.querySelector('[data-mbase="lowest"]').click();
                const mLowest = mm.basePlaneMode;
                document.querySelector('[data-mbase="horizontal"]').click();
                const mHoriz = mm.basePlaneMode;
                mm.setThreePointBaseDirect([0, 0, 0.1], [2, 0, 0.1], [0, 2, 0.1]);
                const mThree = mm.basePlaneMode;
                const hThree = mm.metrics.maxHeight;
                window.__SPLAT_EDITOR__.undo(); // undo 3-pt
                window.__SPLAT_EDITOR__.undo(); // undo horizontal
                window.__SPLAT_EDITOR__.undo(); // undo lowest -> back to fit

                // 5d. Peak pole manual drag override & reset + noise filter toggle
                mm.setManualPeakDirect([0, 0, 2.55]);
                const hManual = mm.metrics.maxHeight;
                document.querySelector('[data-mact="resetPeak"]').click();
                const hReset = mm.metrics.maxHeight;

                document.getElementById('chk-measure-noise-filter').click();
                const noiseOff = mm.noiseFilter;
                document.getElementById('chk-measure-noise-filter').click();
                const noiseOn = mm.noiseFilter;

                return {
                    volume: Number(volStd.volume.toFixed(3)),
                    maxHeight: Number(volStd.maxHeight.toFixed(3)),
                    meanHeight: Number(volStd.meanHeight.toFixed(3)),
                    softNeighborDelta: Number(p1Delta.toFixed(4)),
                    vBeforeShift: Number(vBeforeShift.toFixed(3)),
                    vAfterShift: Number(vAfterShift.toFixed(3)),
                    hBeforeShift: Number(hBeforeShift.toFixed(3)),
                    hAfterShift: Number(hAfterShift.toFixed(3)),
                    mLowest,
                    mHoriz,
                    mThree,
                    hThree: Number(hThree.toFixed(3)),
                    hManual: Number(hManual.toFixed(3)),
                    hReset: Number(hReset.toFixed(3)),
                    noiseOff,
                    noiseOn,
                };
            })()""")
            # Exact cone volume = (1/3)*pi*(2.5^2)*2.0 = 13.09 m^3; height = 2.00 m!
            assert 10.0 <= c5["volume"] <= 15.5, f"Cone volume out of expected range: {c5['volume']}"
            assert 1.80 <= c5["maxHeight"] <= 2.22, f"Max height polluted by floaters or wrong: {c5['maxHeight']}"
            assert 0.05 < c5["softNeighborDelta"] < 0.44, f"Soft vertex drag failed: {c5['softNeighborDelta']}"
            assert c5["vAfterShift"] < c5["vBeforeShift"] * 0.85
            assert abs((c5["hBeforeShift"] - c5["hAfterShift"]) - 0.5) < 0.08
            assert c5["mLowest"] == "lowest" and c5["mHoriz"] == "horizontal" and c5["mThree"] == "threePoint"
            assert abs(c5["hManual"] - 2.55) < 0.08 and abs(c5["hReset"] - c5["maxHeight"]) < 0.08
            assert c5["noiseOff"] is False and c5["noiseOn"] is True
            report["checks"]["5_heap_accuracy_and_overrides"] = {"pass": True, **c5}

            # ---- CHECK 6: All 4 Non-Destructive GPU Temporary Heap Views + Esc Auto-Restore ----
            await asyncio.sleep(0.25)
            await snap("04_heap_standard.png")

            v1 = await eval_js("""(() => {
                document.querySelector('[data-mviz="1"]').click();
                return window.__SPLAT_EDITOR__.getMeasureState().vizMode;
            })()""")
            await asyncio.sleep(0.3)
            await snap("05_heap_translucent.png")

            v2 = await eval_js("""(() => {
                document.querySelector('[data-mviz="2"]').click();
                return window.__SPLAT_EDITOR__.getMeasureState().vizMode;
            })()""")
            await asyncio.sleep(0.3)
            await snap("06_heap_heatmap.png")

            v3 = await eval_js("""(() => {
                document.querySelector('[data-mviz="3"]').click();
                return window.__SPLAT_EDITOR__.getMeasureState();
            })()""")
            await asyncio.sleep(0.3)
            await snap("07_heap_grid_compare.png")

            v_esc = await eval_js("""(() => {
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                return window.__SPLAT_EDITOR__.getMeasureState().vizMode;
            })()""")
            assert v1 == 1 and v2 == 2 and v3["vizMode"] == 3 and v3["metrics"]["gridLineVerts"] > 100
            assert v_esc == 0, f"Esc failed to restore Heap vizMode to Standard (0): {v_esc}"
            report["checks"]["6_four_gpu_heap_views_esc_restore"] = {
                "pass": True,
                "v1": v1,
                "v2": v2,
                "v3": v3["vizMode"],
                "gridLineVerts": v3["metrics"]["gridLineVerts"],
                "afterEsc": v_esc,
            }

            # ---- CHECK 7: Non-Destructive Scale Calibration, Recipe Persistence, Unit Switch, Card Drag & Pinning ----
            c7 = await eval_js("""(() => {
                const mm = window.__SPLAT_EDITOR__.getMeasureManager();
                const cardBefore = document.getElementById('measure-floating-card').innerText;

                // 7a. Drag floating card header by (+110, +55) px
                const card = document.getElementById('measure-floating-card');
                const head = card.querySelector('.mcard-drag-handle');
                const r0 = card.getBoundingClientRect();
                head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r0.left + 20, clientY: r0.top + 12 }));
                window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r0.left + 130, clientY: r0.top + 67 }));
                window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r0.left + 130, clientY: r0.top + 67 }));
                const r1 = card.getBoundingClientRect();
                const cardMovedPx = Math.round(Math.hypot(r1.left - r0.left, r1.top - r0.top));

                // 7b. Pin the stockpile measurement!
                document.querySelector('[data-mact="pin"]').click();
                const pinnedAfterPin = mm.pinnedItems.length;
                const activeAfterPin = mm.points.length;

                // 7c. Non-destructive Scale Calibration (2.0 raw units -> 400 cm = 4.0 m => globalScale = 2.0!)
                window.__SPLAT_EDITOR__.setActiveTool('scaleCalib');
                mm.addScaleCalibPointWorld([0, 0, 0]);
                mm.addScaleCalibPointWorld([2.0, 0, 0]);
                const calibCardVisible = !document.getElementById('scale-calib-card').classList.contains('hidden');
                const inp = document.getElementById('scalib-length-input');
                const sel = document.getElementById('scalib-unit-select');
                inp.value = '400';
                sel.value = 'cm';
                document.querySelector('[data-sact="confirm"]').click();
                const scaleAfter = mm.exportScaleConfig();

                // Verify recipe persistence!
                const recipe = window.__SPLAT_EDITOR__.buildV3Recipe();
                const recipeScale = recipe.measureScale;

                // Verify Ctrl+Z undoes calibration and Ctrl+Shift+Z redoes it
                window.__SPLAT_EDITOR__.undo();
                const scaleAfterUndo = mm.exportScaleConfig();
                window.__SPLAT_EDITOR__.redo();
                const scaleAfterRedo = mm.exportScaleConfig();

                // Switch back to smartMeasure, switch unit to 'm', draw a new 2-pt measurement (1.0 raw u -> must read 2.000 m!)
                window.__SPLAT_EDITOR__.setActiveTool('smartMeasure');
                mm.setUnit('m');
                mm.addMeasurePointWorld([-2.0, -3.2, 0.0]);
                mm.addMeasurePointWorld([-1.0, -3.2, 0.0]);
                const newCardTxt = document.getElementById('measure-floating-card').innerText;
                const pinnedStillKept = mm.pinnedItems.length;

                return {
                    cardMovedPx,
                    pinnedAfterPin,
                    activeAfterPin,
                    calibCardVisible,
                    scaleAfter,
                    recipeScale,
                    scaleAfterUndo,
                    scaleAfterRedo,
                    scaledDistanceShownAs2m: newCardTxt.includes('2.000 m'),
                    pinnedStillKept,
                };
            })()""")
            await asyncio.sleep(0.25)
            await snap("08_pinned_and_scaled.png")

            assert c7["cardMovedPx"] >= 90, f"Floating card drag failed: {c7}"
            assert c7["pinnedAfterPin"] == 1 and c7["activeAfterPin"] == 0 and c7["pinnedStillKept"] == 1
            assert c7["calibCardVisible"]
            assert abs(c7["scaleAfter"]["factor"] - 2.0) < 1e-4 and c7["scaleAfter"]["unit"] == "cm" and c7["scaleAfter"]["calibrated"]
            assert abs(c7["recipeScale"]["factor"] - 2.0) < 1e-4
            assert abs(c7["scaleAfterUndo"]["factor"] - 1.0) < 1e-4 and abs(c7["scaleAfterRedo"]["factor"] - 2.0) < 1e-4
            assert c7["scaledDistanceShownAs2m"], f"Calibrated scale not applied to new measurement! {c7}"
            report["checks"]["7_scale_calib_pin_drag_recipe"] = {"pass": True, **c7}

            report["consoleErrors"] = console_errors
            assert len(console_errors) == 0, f"Console errors occurred: {console_errors}"
            report["allPassed"] = True
            open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8").write(
                json.dumps(report, indent=2, ensure_ascii=False)
            )
            print(json.dumps(report, indent=2, ensure_ascii=False))
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=4)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        httpd.shutdown()
        shutil.rmtree(tmp_data, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "splat_rc9_verify"))
    args = ap.parse_args()
    asyncio.run(run_suite(args.out))
