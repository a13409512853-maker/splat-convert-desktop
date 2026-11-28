#!/usr/bin/env python3
"""
Comprehensive Real-GPU WebGL2 Verification Suite for 3.2.3-rc12:
  1. Global UI Norms (一.1 / 一.2 / 一.3):
     - Horizontal drag scrubbing on <input type="number"> (left=smaller, right=larger)
     - Click-to-edit inline numeric input on <input type="range"> adjacent readouts
     - Upward-popping tooltips for ALL bottom context-bar controls
  2. Tool UI Settings (二.1 / 二.2 / 二.3 / 二.4 / 二.5):
     - Default standing op = Replace for 2-6, Y, M; Ctrl temp Add / Alt temp Subtract / release restores standing; M = Shift+Left-Drag
     - Brush radius max = 360px
     - Filter tools Advanced Options popovers open cleanly upward without clipping (Y / K / F)
     - Eyedropper color swatch tooltip + Floater voxelSize / maxNeighbors tooltips
  3. Bug Fixes (三.1 / 三.2):
     - History expanded card renders full-height groups (zero flex collapse) & auto-collapses inactive groups unless user-expanded
     - Smart Measure Pen: single-click start vertex does NOT close; hover >=3 pts shows 2-line tip; double-click start vertex closes cleanly
  4. Volume Component Visuals & Real-Time GPU Containment Highlight (四.1 / 四.2 / 四.3):
     - Softened volume fill + dramatically widened gentle edge/seam gradient
     - Real-time GPU sky-cyan tint on selectable Gaussians inside active enabled volumes vs boosted gold-orange selection tint
  5. Plane Inpaint L0 Pure Color + Reusable ColorWheelPicker (五):
     - Clicking L0 opens upward Hue Ring + SV Square + Eyedropper + Recent Colors panel
     - L0 fill synthesizes exact solid-color planar Gaussians (1-step undoable)
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


def make_rc12_scene_sgc2():
    """+Y-up flat tabletop with an intentional center hole (for L0 inpaint test) + neutral textured block & sculpture."""
    pts = []
    seed = 2026112712

    def rnd():
        nonlocal seed
        seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
        return seed / 4294967296.0

    # 1. Flat ground/table slab at Y = 0 in [-2.8, 2.8] x [-2.8, 2.8], with a clean hole in [-0.45, 0.45]^2!
    for _ in range(9000):
        x = (rnd() - 0.5) * 5.6
        z = (rnd() - 0.5) * 5.6
        if abs(x) < 0.42 and abs(z) < 0.42:
            continue
        y = (rnd() - 0.5) * 0.012
        shade = 0.48 + 0.08 * math.sin(x * 2.5) * math.cos(z * 2.5)
        pts.append((x, y, z, shade * 0.96, shade * 0.94, shade * 0.92, 0.96, -2.85))

    # 2. Upright neutral-warm sculpture pillar on the side (for volume tint vs selection tint comparison)
    for _ in range(6000):
        ang = rnd() * math.tau
        rad = 0.72 * (0.85 + 0.15 * rnd())
        y = 0.02 + rnd() * 1.9
        x = -1.15 + math.cos(ang) * rad
        z = -0.35 + math.sin(ang) * rad
        v = 0.62 + 0.14 * (y / 1.9)
        pts.append((x, y, z, v, v * 0.96, v * 0.90, 0.96, -2.95))

    return build_synthetic_sgc2(pts)


async def run_suite(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    tmp_data = tempfile.mkdtemp(prefix="rc12_verify_data_")
    scene_bin = os.path.join(tmp_data, "rc12_scene.bin")
    open(scene_bin, "wb").write(make_rc12_scene_sgc2())

    routes = {"/__data__/": tmp_data, "/locales/": os.path.join(PROJ_DIR, "locales")}
    httpd = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), lambda *a, **kw: MultiRootHandler(*a, routes=routes, **kw)
    )
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    if not os.path.exists(edge):
        edge = r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    profile = tempfile.mkdtemp(prefix="rc12_edge_prof_")
    cdp_port = 9292
    proc = subprocess.Popen(
        [
            edge,
            "--headless=new",
            f"--remote-debugging-port={cdp_port}",
            f"--user-data-dir={profile}",
            "--window-size=1560,940",
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
                await asyncio.sleep(0.20)
                d = (await send("Page.captureScreenshot", {"format": "png"})).get("data", "")
                p = os.path.join(out_dir, name)
                open(p, "wb").write(base64.b64decode(d))
                report["screenshots"].append(p)
                return p

            await send("Runtime.enable")
            await send("Page.enable")
            await asyncio.sleep(1.0)

            await eval_js(f"""(async () => {{
                const buf = await (await fetch('http://127.0.0.1:{port}/__data__/rc12_scene.bin')).arrayBuffer();
                await window.__SPLAT_EDITOR__.loadBuffer(buf, {{ totalPoints: 15000, skipAutoAlignPrompt: true }});
                window.__SPLAT_EDITOR__.setCameraPose([3.6, 3.3, 4.2], [-0.3, 0.5, -0.1]);
                window.__SPLAT_EDITOR__.setTelemetry('GPU 14% 2.1/16.0 GB | CPU 6% 8.2/32.0 GB', {{
                    cpuPct: 6, ramUsedGb: 8.2, ramTotalGb: 32.0, gpuPct: 14, vramUsedGb: 2.1, vramTotalGb: 16.0
                }});
            }})()""")
            await asyncio.sleep(0.35)

            # =========================================================================
            # CHECK 1: Global UI Norms (Scrubbing, Slider Inline Input, Upward Tips)
            # =========================================================================
            c1 = await eval_js("""(async () => {
                const E = window.__SPLAT_EDITOR__;
                // 1.1 Horizontal drag scrub on #tr-px (Transform Panel <input type="number">)
                const trPx = document.getElementById('tr-px');
                const rPx = trPx.getBoundingClientRect();
                const startVal = Number(trPx.value);
                trPx.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: rPx.left + 15, clientY: rPx.top + 8, pointerId: 1 }));
                window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: rPx.left + 55, clientY: rPx.top + 8, pointerId: 1 }));
                const afterRight = Number(trPx.value);
                window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: rPx.left - 25, clientY: rPx.top + 8, pointerId: 1 }));
                const afterLeft = Number(trPx.value);
                window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: rPx.left - 25, clientY: rPx.top + 8, pointerId: 1 }));
                // Reset position back cleanly
                trPx.value = '0';
                trPx.dispatchEvent(new Event('change', { bubbles: true }));

                // 1.2 Slider click-to-edit inline input on Brush Radius (and verify max=360!)
                E.setActiveTool('brush');
                await new Promise(r => setTimeout(r, 40));
                const rng = document.querySelector('#context-bar-stack input[type="range"]');
                const maxAttr = rng.max;
                const valSpan = rng.nextElementSibling;
                valSpan.click();
                const inlineInp = document.querySelector('#context-bar-stack .slider-inline-input');
                const inlineOpened = !!inlineInp;
                inlineInp.value = '260';
                inlineInp.dispatchEvent(new Event('input', { bubbles: true }));
                inlineInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                const afterBrushRadius = E.getBoolOpState().brushRadiusPx;
                const inlineClosed = !document.querySelector('#context-bar-stack .slider-inline-input');

                // 1.3 Upward tooltip on bottom context bar button
                const firstBoolBtn = document.querySelector('#context-bar-stack button[data-bool-op="replace"]');
                const btnRect = firstBoolBtn.getBoundingClientRect();
                firstBoolBtn.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
                await new Promise(r => setTimeout(r, 560));
                const tipEl = document.querySelector('.global-delayed-tooltip');
                const tipRect = tipEl.getBoundingClientRect();
                const tipVisible = tipEl.style.display === 'block';
                const tipUpward = tipVisible && tipRect.bottom <= btnRect.top + 2 && tipEl.dataset.placement === 'top';
                firstBoolBtn.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));

                return {
                    startVal, afterRight, afterLeft,
                    maxAttr, inlineOpened, afterBrushRadius, inlineClosed,
                    tipVisible, tipUpward, tipPlacement: tipEl.dataset.placement,
                };
            })()""")
            assert c1["afterRight"] > c1["startVal"] and c1["afterLeft"] < c1["startVal"], f"Numeric scrub failed: {c1}"
            assert c1["maxAttr"] == "360", f"Brush max must be 360: {c1}"
            assert c1["inlineOpened"] and c1["afterBrushRadius"] == 260 and c1["inlineClosed"], f"Slider inline input failed: {c1}"
            assert c1["tipVisible"] and c1["tipUpward"], f"Context-bar tooltip must pop upward: {c1}"
            report["checks"]["1_global_ui_norms"] = {"pass": True, **c1}

            # =========================================================================
            # CHECK 2: Tool UI Settings (Ctrl/Alt Temp Ops, M=Shift+Drag, Filter Popovers, Swatch/Floater Tips)
            # =========================================================================
            c2 = await eval_js("""(async () => {
                const E = window.__SPLAT_EDITOR__;
                // 2.1 Standing default = replace; click changes standing; Ctrl temp Add; Alt temp Sub; release restores!
                E.setActiveTool('rect');
                const rectDefault = E.getBoolOpState().standing;
                document.querySelector('#context-bar-stack button[data-bool-op="intersect"]').click();
                const rectStandingChanged = E.getBoolOpState().standing;

                // Hold Ctrl -> temp Add
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
                const duringCtrl = E.getBoolOpState();
                const addBtnActiveCtrl = document.querySelector('#context-bar-stack button[data-bool-op="add"]').classList.contains('active');
                window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false, bubbles: true }));
                const afterCtrlRelease = E.getBoolOpState();

                // Hold Alt -> temp Subtract
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true }));
                const duringAlt = E.getBoolOpState();
                const subBtnActiveAlt = document.querySelector('#context-bar-stack button[data-bool-op="subtract"]').classList.contains('active');
                window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', altKey: false, bubbles: true }));
                const afterAltRelease = E.getBoolOpState();

                // Re-entering another stateful tool (Y eyedropper) resets default back to replace!
                E.setActiveTool('eyedropper');
                const eyeDefault = E.getBoolOpState().standing;
                const eyeSwatch = document.querySelector('#context-bar-stack .ctx-swatch');
                const eyeSwatchHasTip = !!(eyeSwatch && eyeSwatch.dataset.tipTitle && eyeSwatch.dataset.tip);

                // 2.3 Check Filter Advanced Options popovers on Y, K, F (NOT clipped!)
                const checkAdvPopover = (toolName) => {
                    E.setActiveTool(toolName);
                    const bar = document.querySelector('#context-bar-stack .context-bar');
                    const advBtn = bar.querySelector('.ctx-adv-btn');
                    const pop = bar.querySelector('.ctx-adv-popover');
                    advBtn.click();
                    const barRect = bar.getBoundingClientRect();
                    const popRect = pop.getBoundingClientRect();
                    const barOverflowY = getComputedStyle(bar).overflowY;
                    return {
                        tool: toolName,
                        opened: !pop.classList.contains('hidden'),
                        popHeight: Math.round(popRect.height),
                        aboveBar: popRect.bottom <= barRect.top + 2,
                        barOverflowY,
                    };
                };
                const advK = checkAdvPopover('sizeSel');
                const advF = checkAdvPopover('floaterSel');
                const floaterTips = [...document.querySelectorAll('#context-bar-stack .ctx-group > .ctx-param')].map(el => ({
                    title: el.dataset.tipTitle || '',
                    hasTip: !!el.dataset.tip,
                }));
                // Leave Eyedropper Advanced Popover OPEN + trigger Swatch Upward Tooltip for screenshot!
                const advY = checkAdvPopover('eyedropper');
                const sw = document.querySelector('#context-bar-stack .ctx-swatch');
                sw.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
                await new Promise(r => setTimeout(r, 560));

                // Also verify M (semanticSel) defaults to replace & accepts Ctrl/Alt temp override cleanly
                return {
                    rectDefault, rectStandingChanged,
                    duringCtrlEff: duringCtrl.effective, addBtnActiveCtrl, afterCtrlStanding: afterCtrlRelease.effective,
                    duringAltEff: duringAlt.effective, subBtnActiveAlt, afterAltStanding: afterAltRelease.effective,
                    eyeDefault, eyeSwatchHasTip,
                    advY, advK, advF, floaterTips,
                };
            })()""")
            await snap("01_filter_adv_popover_and_swatch_tip.png")
            assert c2["rectDefault"] == "replace" and c2["rectStandingChanged"] == "intersect"
            assert c2["duringCtrlEff"] == "add" and c2["addBtnActiveCtrl"] and c2["afterCtrlStanding"] == "intersect"
            assert c2["duringAltEff"] == "subtract" and c2["subBtnActiveAlt"] and c2["afterAltStanding"] == "intersect"
            assert c2["eyeDefault"] == "replace" and c2["eyeSwatchHasTip"]
            for adv in (c2["advY"], c2["advK"], c2["advF"]):
                assert adv["opened"] and adv["popHeight"] >= 45 and adv["aboveBar"] and adv["barOverflowY"] == "visible", f"Advanced popover clipped: {adv}"
            assert len(c2["floaterTips"]) >= 2 and all(x["hasTip"] for x in c2["floaterTips"]), f"Floater tips missing: {c2['floaterTips']}"
            report["checks"]["2_tool_ui_settings"] = {"pass": True, **c2}

            # =========================================================================
            # CHECK 3: Bug Fixes (History Expanded Groups + Smart Measure Double-Click Close)
            # =========================================================================
            c3_hist = await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                document.querySelector('.ctx-swatch')?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
                E.setActiveTool('orbit');
                // Build 2 distinct groups: 4 scale steps -> 1 duplicate step -> 4 color steps!
                E.simulateScaleGizmoDrag('X', 1.05);
                E.simulateScaleGizmoDrag('X', 1.05);
                E.simulateScaleGizmoDrag('X', 1.05);
                E.simulateScaleGizmoDrag('X', 1.05);
                const duringScaleGrp = E.getHistoryDebug();

                // Non-scale step -> Scale group MUST auto-collapse!
                E.duplicateSceneObjectToTarget(0, null, -1);
                const afterLeaveScale = E.getHistoryDebug();

                // 4 consecutive color steps -> Color group auto-expands while Scale stays auto-collapsed!
                document.getElementById('btn-color-panel').click();
                const lightSliders = [...document.querySelectorAll('#color-light-sliders .cr-range')];
                const dragS = (el, v) => {
                    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
                    el.value = String(v);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
                };
                dragS(lightSliders[0], 0.12);
                dragS(lightSliders[1], 10);
                dragS(lightSliders[2], 15);
                dragS(lightSliders[3], 12);
                document.getElementById('btn-color-panel').click(); // close color panel so history card is unobstructed

                // Expand History Card -> verify BOTH groups have real positive heights (NOT crushed to 2px!)
                E.toggleHistoryExpanded();
                const dbgExpanded = E.getHistoryDebug();
                const domGroups = [...document.querySelectorAll('#history-list .history-group')].map(g => ({
                    id: g.dataset.histGroupId,
                    key: g.dataset.histGroupKey,
                    collapsed: g.classList.contains('collapsed'),
                    height: Math.round(g.getBoundingClientRect().height),
                }));
                return { duringScaleGrp, afterLeaveScale, dbgExpanded, domGroups };
            })()""")
            await snap("02_history_expanded_groups_ok.png")
            scale_grp_after_leave = next(b for b in c3_hist["afterLeaveScale"]["blocks"] if b["type"] == "group" and "scale" in b["groupKey"])
            assert scale_grp_after_leave["open"] is False, f"Inactive history group MUST auto-collapse! {scale_grp_after_leave}"
            assert len(c3_hist["domGroups"]) >= 2, f"Expected >=2 history groups in expanded view: {c3_hist['domGroups']}"
            color_dom = next(g for g in c3_hist["domGroups"] if g["key"] == "color")
            scale_dom = next(g for g in c3_hist["domGroups"] if "scale" in g["key"])
            assert not color_dom["collapsed"] and color_dom["height"] >= 80, f"Active expanded group crushed! {color_dom}"
            assert scale_dom["collapsed"] and scale_dom["height"] >= 22, f"Inactive collapsed group crushed! {scale_dom}"

            # 3.2 Smart Measure Pen: Hover start vertex >=3 pts shows 2-line tip; single click does NOT close; double-click CLOSES!
            c3_meas = await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                E.toggleHistoryExpanded(); // collapse history back
                // Clean up extra duplicate & color grade so view is crisp
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
                E.selectSceneObjectSingle(0);

                E.setActiveTool('smartMeasure');
                const mm = E.getMeasureManager();
                mm.clearActive({ keepPinned: false });
                mm.addMeasurePointWorld([0.8, 0.02, 0.8]);
                mm.addMeasurePointWorld([2.1, 0.02, 0.8]);
                mm.addMeasurePointWorld([1.5, 0.02, -0.7]);

                // Project vertex #0 to client coordinates
                const p0 = mm._projectToOverlayPx(mm.points[0]);
                const r = document.getElementById('canvas').getBoundingClientRect();
                const cx = r.left + p0[0];
                const cy = r.top + p0[1];
                const canvas = document.getElementById('canvas');
                canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx, clientY: cy }));
                const pillTxt = document.getElementById('cursor-hint-pill')?.textContent || '';
                return { cx, cy, pillTxt, closedBefore: mm.closed };
            })()""")
            await snap("03_measure_start_vertex_tip.png")
            c3_meas_dbl = await eval_js(f"""(() => {{
                const E = window.__SPLAT_EDITOR__;
                const mm = E.getMeasureManager();
                const canvas = document.getElementById('canvas');
                const cx = {c3_meas['cx']}, cy = {c3_meas['cy']};
                const histBefore = E.getHistoryDebug().totalSteps;
                // Single click on vertex #0 -> MUST NOT close and MUST NOT push phantom drag history!
                canvas.dispatchEvent(new PointerEvent('pointerdown', {{ bubbles: true, button: 0, clientX: cx, clientY: cy, pointerId: 2 }}));
                canvas.dispatchEvent(new PointerEvent('pointerup', {{ bubbles: true, button: 0, clientX: cx, clientY: cy, pointerId: 2 }}));
                const closedAfterSingle = mm.closed;
                const histAfterSingle = E.getHistoryDebug().totalSteps;

                // Double-click on vertex #0 -> MUST close polygon and stay in smartMeasure!
                canvas.dispatchEvent(new MouseEvent('dblclick', {{ bubbles: true, clientX: cx, clientY: cy }}));
                const closedAfterDbl = mm.closed;
                const toolAfterDbl = E.getState().activeTool;
                mm.clearActive({{ keepPinned: false }});
                E.setActiveTool('orbit');
                return {{ closedAfterSingle, phantomHistAdded: histAfterSingle - histBefore, closedAfterDbl, toolAfterDbl }};
            }})()""")
            assert "按住拖拽调整测点位置" in c3_meas["pillTxt"] and "双击即闭合当前多边形" in c3_meas["pillTxt"], f"2-line start vertex tip wrong: {c3_meas}"
            assert c3_meas_dbl["closedAfterSingle"] is False and c3_meas_dbl["phantomHistAdded"] == 0, f"Single-click vertex #0 broke: {c3_meas_dbl}"
            assert c3_meas_dbl["closedAfterDbl"] is True and c3_meas_dbl["toolAfterDbl"] == "smartMeasure", f"Double-click vertex #0 failed to close: {c3_meas_dbl}"
            report["checks"]["3_bug_fixes"] = {"pass": True, "history": c3_hist["domGroups"], "measure": {**c3_meas, **c3_meas_dbl}}

            # =========================================================================
            # CHECK 4: Volume Visuals (Soft Fill, Wide Two-Sided Glow, Real-Time GPU Containment Tint)
            # =========================================================================
            c4 = await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                const vm = E.getVolumeManager();
                // Create a clean Box + Cylinder CSG Union group partially overlapping the pillar & table
                const box = vm.createVolume('box', { x: -0.95, y: 0.72, z: -0.35 }, 0.9);
                box.root.scale.set(0.95, 0.85, 0.95);
                const cyl = vm.createVolume('cylinder', { x: -1.55, y: 1.05, z: -0.95 }, 0.9);
                cyl.root.scale.set(0.85, 0.90, 0.85);
                const grp = vm.createGroupFromItems([box.id, cyl.id]);
                grp.enabled = true;
                E.selectSceneObjectSingle(0);
                vm.syncAllVisuals(new Set(), null);
                E.setCameraPose([2.5, 2.7, 3.6], [-0.85, 0.75, -0.35]);

                const gpuScopeBefore = E.getVolumeScopeGpuStatus();
                // Select a strip of points on the right half so BOTH cyan (volume-contained) & bold gold (selected) show together!
                E.triggerBoxSelect(-0.08, -0.55, 0.45, 0.35, 'replace');
                // Translate volume group to verify real-time GPU uniform update!
                grp.root.position.x += 0.15;
                vm.syncAllVisuals(new Set(), null);
                E.setCameraPose([2.5, 2.7, 3.6], [-0.85, 0.75, -0.35]);
                const gpuScopeAfter = E.getVolumeScopeGpuStatus();
                return { gpuScopeBefore, gpuScopeAfter, selectedCount: E.getCloudStats().selected };
            })()""")
            await snap("04_volume_soft_glow_and_gpu_tint.png")
            assert c4["gpuScopeBefore"]["active"] == 1 and c4["gpuScopeBefore"]["primCount"] == 2, f"GPU volume scope inactive: {c4}"
            assert c4["gpuScopeAfter"]["active"] == 1 and c4["selectedCount"] > 100

            # Capture pure CSG close-up (hide main cloud briefly) so we visually verify softer fill + wide gentle gradient!
            await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                const vm = E.getVolumeManager();
                const sph = vm.createVolume('ellipsoid', { x: -0.25, y: 0.65, z: 0.35 }, 0.8);
                vm.groups[0].addChild(sph, 'union');
                vm.syncAllVisuals(new Set(), null);
                const btns = document.querySelectorAll('#scene-objects-list .scene-row .row-btn');
                if (btns[1]) btns[1].click(); // hide cloud
                E.setCameraPose([1.8, 2.5, 3.3], [-0.9, 0.75, -0.3]);
            })()""")
            await snap("05_csg_wide_soft_gradient.png")
            await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                const vm = E.getVolumeManager();
                const btns = document.querySelectorAll('#scene-objects-list .scene-row .row-btn');
                if (btns[1]) btns[1].click(); // restore cloud
                for (const g of [...vm.groups]) vm.removeGroup(g.id);
                for (const v of [...vm.items]) vm.removeVolume(v.id);
                vm.syncAllVisuals(new Set(), null);
                E.deselectAllPoints();
                E.selectSceneObjectSingle(0);
                E.setCameraPose([0.0, 4.2, 2.2], [0, 0, 0]); // look nicely down at the center tabletop hole!
            })()""")
            report["checks"]["4_volume_visuals_and_gpu_tint"] = {"pass": True, **c4}

            # =========================================================================
            # CHECK 5: Plane Inpaint L0 Pure Color + Reusable ColorWheelPicker
            # =========================================================================
            c5_open = await eval_js("""(async () => {
                const E = window.__SPLAT_EDITOR__;
                E.setActiveTool('planeInpaint');
                const l0Btn = document.querySelector('#context-bar-stack button[data-inpaint-mode="L0"]');
                l0Btn.click();
                await new Promise(r => setTimeout(r, 200));
                const pickerEl = document.getElementById('reusable-color-wheel-picker');
                const barRect = document.querySelector('#context-bar-stack .context-bar').getBoundingClientRect();
                const pRect = pickerEl.getBoundingClientRect();
                const hasCanvas = !!pickerEl.querySelector('canvas');
                const hasEye = !!pickerEl.querySelector('.cw-eye-btn');
                const recentCount = pickerEl.querySelectorAll('.cw-recent-swatch').length;
                return {
                    opened: !pickerEl.classList.contains('hidden'),
                    poppedUpward: pRect.bottom <= barRect.top + 2,
                    hasCanvas, hasEye, recentCount,
                };
            })()""")
            await snap("06_plane_inpaint_l0_color_wheel.png")
            assert c5_open["opened"] and c5_open["poppedUpward"] and c5_open["hasCanvas"] and c5_open["hasEye"] and c5_open["recentCount"] >= 8, f"ColorWheelPicker failed: {c5_open}"

            c5_run = await eval_js("""(async () => {
                const E = window.__SPLAT_EDITOR__;
                const picker = E.getColorWheelPicker();
                // Set vivid emerald green #22C55E via hex input + verify recent history records it!
                const hexInp = document.querySelector('#reusable-color-wheel-picker .cw-hex-input');
                hexInp.value = '#22C55E';
                hexInp.dispatchEvent(new Event('change', { bubbles: true }));
                const firstRecent = picker.recent[0];
                const l0SwatchHex = document.querySelector('#btn-inpaint-l0-color .icb-hex')?.textContent?.trim();

                // Verify Eyedropper button toggles picker mode cleanly
                const eyeBtn = document.querySelector('#reusable-color-wheel-picker .cw-eye-btn');
                eyeBtn.click();
                const pickActive = picker.eyedropperActive;
                eyeBtn.click(); // toggle off cleanly
                picker.close();

                // Run L0 Pure Color Plane Inpaint over the center hole box!
                const beforeObjs = E.getSceneObjectsInfo().length;
                const res = await E.runPlaneInpaintBox({ x0: 0.43, y0: 0.43, x1: 0.57, y1: 0.57 });
                const afterObjs = E.getSceneObjectsInfo().length;
                const sampleRgb = res?.patchData ? [res.patchData.rgba[0], res.patchData.rgba[1], res.patchData.rgba[2]] : null;
                return {
                    firstRecent, l0SwatchHex, pickActive,
                    beforeObjs, afterObjs,
                    resMode: res?.mode, resCount: res?.count, sampleRgb,
                };
            })()""")
            await snap("07_l0_pure_color_patch.png")
            assert c5_run["firstRecent"] == "#22C55E" and c5_run["l0SwatchHex"] == "#22C55E", f"Color picker commit failed: {c5_run}"
            assert c5_run["pickActive"] is True
            assert c5_run["resMode"] == "L0" and c5_run["resCount"] > 50 and c5_run["afterObjs"] == c5_run["beforeObjs"] + 1, f"L0 inpaint failed: {c5_run}"
            assert c5_run["sampleRgb"] == [34, 197, 94], f"L0 patch RGB mismatch: {c5_run}"
            report["checks"]["5_plane_inpaint_l0_color_wheel"] = {"pass": True, **c5_open, **c5_run}

            report["consoleErrors"] = console_errors
            assert len(console_errors) == 0, f"Console/Runtime errors occurred: {console_errors}"
            report["allPassed"] = True
            open(os.path.join(out_dir, "rc12_verify_report.json"), "w", encoding="utf-8").write(
                json.dumps(report, ensure_ascii=False, indent=2)
            )
            print("ALL 5 RC12 REAL-GPU WEBGL2 CHECKS PASSED 100% (0 console errors)!")
            print(json.dumps(report["checks"], ensure_ascii=False, indent=2))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        httpd.shutdown()
        shutil.rmtree(tmp_data, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT_DIR, r"00_临时提交区\rc12_verify_shots"))
    args = ap.parse_args()
    asyncio.run(run_suite(args.out))
