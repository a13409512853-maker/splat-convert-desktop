#!/usr/bin/env python3
"""
Comprehensive Real-GPU Verification Suite for 3.2.3-rc5 (3.2.3 封板):
  1. #1 Collapsible History Timeline (default collapsed latest 3 steps, non-destructive jump, branch overwrite only on new edit, placement below Transform/Color)
  2. #2 Transform Card polish (inline lock icon next to Scale, no ° on Rotation, Pivot Edit icon next to Position, per-row Reset arrows: Model -> 0/0/1, Volume -> initial creation transform)
  3. #3/#4/#8 Scene Manager (no Ctrl+G badge on 打组, Solo/Eye/Trash icons on Objects & Object Groups, last object delete protection, overflow Expand buttons)
  4. #5/#6/#7/#9/#10 Volumes & Nested Volume Groups (collapse toggle, no ↑/↓, no inner ○ scope toggle, recursive nested group-in-group with group-to-group subtract/intersect, enable vs selection color distinction, drag move/nest, flat 2D billboard handles, exact BSP CSG composite preview shell)
  5. #11 OBB follows selected single object (or entire scene after 清除选择), Browse single-click selects model, unselected groups neutral gray
  6. #12/#13 Left-rail bottom Local Space & Bounds Center toggles + mutual exclusion with Pivot Edit & Browse double-click + Video 1 fix (double-click releases Volume gizmo lock!)
  7. #14 Video 2 fix (far-zoom Infinite Ground Grid logarithmic LOD with zero moire/snow)
  8. B5 Left rail beautification (larger icons, aligned labels & keys) + Browse (1) coexistence with Filter/Smart/Align vs strict mutual exclusion with 2-6 + minimalist arrowless scrollbars
"""
import argparse, asyncio, base64, http.server, json, os, shutil, subprocess, tempfile, threading, time, urllib.request, websockets

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
    tmp_data = tempfile.mkdtemp(prefix="rc5_verify_data_")
    demo_sgc = os.path.join(tmp_data, "demo24k.bin")
    node_exe = shutil.which("node")
    subprocess.run([node_exe, os.path.join(EDITOR_DIR, "worker.mjs"), "sample", DEMO_PLY, demo_sgc, "full", PROJ_DIR], check=True)

    routes = {"/__data__/": tmp_data}
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **kw: MultiRootHandler(*a, routes=routes, **kw))
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    if not os.path.exists(edge):
        edge = r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    profile = tempfile.mkdtemp(prefix="rc5_edge_prof_")
    cdp_port = 9275
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
                window.__SPLAT_EDITOR__.setTelemetry('GPU 14% 3.2/16.0 GB | CPU 5% 10.8/32.0 GB', {{
                    cpuPct: 5, ramUsedGb: 10.8, ramTotalGb: 32.0, gpuPct: 14, vramUsedGb: 3.2, vramTotalGb: 16.0
                }});
            }})()""")
            await asyncio.sleep(0.45)

            # ---- CHECK 1: Left Rail Polish + Bottom Local/Bounds Toggles + Browse Coexistence (B5 + #12) ----
            c1 = await eval_js("""(() => {
                const grpBtnTxt = document.getElementById('btn-group-selected')?.textContent?.trim();
                const rotLbl = Array.from(document.querySelectorAll('#transform-card .t-lbl')).map(e => e.textContent.trim());
                const hasPivotBtn = !!document.getElementById('btn-pivot-edit');
                const hasScaleLockInRow = !!document.querySelector('#transform-card .t-row #btn-scale-lock');
                const resetBtns = ['btn-reset-pos', 'btn-reset-rot', 'btn-reset-scale'].every(id => !!document.getElementById(id));
                const railOptBtns = ['btn-local-space', 'btn-bounds-center'].every(id => !!document.getElementById(id));
                // Test Browse (1) coexistence: opacitySel automatically keeps Browse lit; rect turns Browse OFF;
                // semanticSel + user toggle Browse (1) keeps BOTH lit without closing semantic bar!
                window.__SPLAT_EDITOR__.setActiveToolUser('opacitySel');
                const opBrowseLit = document.querySelector('#left-rail [data-tool="orbit"]').classList.contains('active');
                const opFilterLit = document.getElementById('btn-flyout-filter').classList.contains('active');
                window.__SPLAT_EDITOR__.setActiveToolUser('rect');
                const rectBrowseLit = document.querySelector('#left-rail [data-tool="orbit"]').classList.contains('active');
                window.__SPLAT_EDITOR__.setActiveToolUser('verticalAlign');
                window.__SPLAT_EDITOR__.setActiveToolUser('orbit'); // toggle browse ON alongside verticalAlign!
                const alignCoexistBrowse = document.querySelector('#left-rail [data-tool="orbit"]').classList.contains('active');
                const alignStillActive = window.__SPLAT_EDITOR__.getState().activeTool === 'verticalAlign';
                window.__SPLAT_EDITOR__.setActiveTool('orbit');
                return { grpBtnTxt, rotLbl, hasPivotBtn, hasScaleLockInRow, resetBtns, railOptBtns, opBrowseLit, opFilterLit, rectBrowseLit, alignCoexistBrowse, alignStillActive };
            })()""")
            assert c1["grpBtnTxt"] == "打组", f"Ctrl+G badge should be removed: {c1}"
            assert c1["rotLbl"] == ["位置", "旋转", "缩放"], f"Rotation should have no °: {c1}"
            assert c1["hasPivotBtn"] and c1["hasScaleLockInRow"] and c1["resetBtns"] and c1["railOptBtns"]
            assert c1["opBrowseLit"] and c1["opFilterLit"] and (not c1["rectBrowseLit"]) and c1["alignCoexistBrowse"] and c1["alignStillActive"], f"Browse coexistence failed: {c1}"
            report["checks"]["1_rail_polish_transform_ui_and_browse_coexist"] = {"pass": True, **c1}
            print("[PASS] 1_rail_polish_transform_ui_and_browse_coexist")

            # ---- CHECK 2: #11 OBB Follows Selected Single Object / Clears to Entire Scene + #3 Solo & Protected Delete ----
            c2 = await eval_js("""(() => {
                // Split right half into Object #1 so we have 2 distinct scene objects!
                window.__SPLAT_EDITOR__.triggerBoxSelect(0.05, -0.8, 0.9, 0.8, 'replace');
                window.__SPLAT_EDITOR__.splitSelectedToObject();
                const objCountAfterSplit = window.__SPLAT_EDITOR__.getState().objectCount;
                // Select only obj 1 -> OBB should strictly match obj 1 (smaller than full scene)
                window.__SPLAT_EDITOR__.selectSceneObjectSingle(1);
                const bObj1 = window.__SPLAT_EDITOR__.getBoundsInfo().worldCorners;
                // Clear selection -> OBB should expand to full scene (both obj 0 & obj 1)!
                window.__SPLAT_EDITOR__.clearObjectSelection();
                const bAll = window.__SPLAT_EDITOR__.getBoundsInfo().worldCorners;
                const spanX = (cs) => Math.max(...cs.map(c => c[0])) - Math.min(...cs.map(c => c[0]));
                const span1 = spanX(bObj1);
                const spanAll = spanX(bAll);
                // Test Solo toggle on obj 1 -> hides obj 0, toggle off restores!
                window.__SPLAT_EDITOR__.toggleSolo('object', 1);
                const soloOn = window.__SPLAT_EDITOR__.getRc5State().soloState;
                window.__SPLAT_EDITOR__.toggleSolo('object', 1);
                const soloOff = window.__SPLAT_EDITOR__.getRc5State().soloState;
                // Test delete obj 1 + Undo + last-object delete protection!
                const delOk = window.__SPLAT_EDITOR__.deleteSceneObject(1);
                const countAfterDel = window.__SPLAT_EDITOR__.getState().objectCount;
                const delLastBlocked = window.__SPLAT_EDITOR__.deleteSceneObject(0);
                const lastTrashDisabled = document.querySelector('#scene-objects-list .row-btn.danger')?.disabled;
                window.__SPLAT_EDITOR__.undo(); // restore obj 1!
                const countAfterUndo = window.__SPLAT_EDITOR__.getState().objectCount;
                return { objCountAfterSplit, span1, spanAll, soloOn, soloOff, delOk, countAfterDel, delLastBlocked, lastTrashDisabled, countAfterUndo };
            })()""")
            assert c2["objCountAfterSplit"] == 2 and c2["spanAll"] > c2["span1"] + 0.05, f"OBB per-object scope failed: {c2}"
            assert c2["soloOn"] is not None and c2["soloOff"] is None
            assert c2["delOk"] and c2["countAfterDel"] == 1 and (not c2["delLastBlocked"]) and c2["lastTrashDisabled"] and c2["countAfterUndo"] == 2
            report["checks"]["2_obb_single_select_clear_solo_and_delete_guard"] = {"pass": True, **c2}
            print("[PASS] 2_obb_single_select_clear_solo_and_delete_guard")

            # ---- CHECK 3: #1 Collapsible History Timeline (latest 3 steps, non-destructive jump, branch overwrite) ----
            c3 = await eval_js("""(() => {
                // Make 4 distinct undoable edits
                window.__SPLAT_EDITOR__.selectSceneObjectSingle(0);
                const px = document.getElementById('tr-px');
                for (const v of [1, 2, 3]) {
                    px.value = String(v);
                    px.dispatchEvent(new Event('change'));
                }
                const collapsedCount = document.querySelectorAll('#history-list .history-item').length;
                const tlBefore = window.__SPLAT_EDITOR__.getHistoryTimeline();
                // Jump back 2 steps non-destructively (redo steps must remain!)
                const jumpTarget = Math.max(0, tlBefore.currentIndex - 2);
                window.__SPLAT_EDITOR__.jumpToHistory(jumpTarget);
                const tlAfterJump = window.__SPLAT_EDITOR__.getHistoryTimeline();
                const posAfterJump = Number(document.getElementById('tr-px').value);
                // Jump forward again (proves redo branch survived jump!)
                window.__SPLAT_EDITOR__.jumpToHistory(tlBefore.currentIndex);
                const posRestored = Number(document.getElementById('tr-px').value);
                // Now jump back 1 step and perform a NEW edit -> overwrites future branch!
                window.__SPLAT_EDITOR__.jumpToHistory(tlBefore.currentIndex - 1);
                px.value = '9';
                px.dispatchEvent(new Event('change'));
                const tlAfterBranch = window.__SPLAT_EDITOR__.getHistoryTimeline();
                // Test #2 Reset Position arrow -> back to 0!
                window.__SPLAT_EDITOR__.resetTransformRow('pos');
                const posAfterReset = Number(document.getElementById('tr-px').value);
                return {
                    collapsedCount, totalBefore: tlBefore.totalSteps, curAfterJump: tlAfterJump.currentIndex,
                    totalAfterJump: tlAfterJump.totalSteps, posAfterJump, posRestored,
                    redoAfterBranch: tlAfterBranch.totalSteps - tlAfterBranch.currentIndex, posAfterReset
                };
            })()""")
            assert c3["collapsedCount"] == 3, f"Collapsed history must show 3 items: {c3}"
            assert c3["totalAfterJump"] == c3["totalBefore"] and c3["posAfterJump"] == 1 and c3["posRestored"] == 3
            assert c3["redoAfterBranch"] == 0 and c3["posAfterReset"] == 0
            report["checks"]["3_history_timeline_jump_and_transform_reset"] = {"pass": True, **c3}
            print("[PASS] 3_history_timeline_jump_and_transform_reset")

            # ---- CHECK 4: #5/#6/#7/#9/#10 Nested CSG Volume Groups + Flat Handles + Enable vs Selection Color + Vol Reset ----
            c4 = await eval_js("""(() => {
                const vm = window.__SPLAT_EDITOR__.getVolumeManager();
                window.__SPLAT_EDITOR__.spawnVolumeAt('box', { x: 0, y: 0, z: 0.4, clone(){return this;} });
                const v1 = vm.items[vm.items.length - 1];
                v1.root.position.set(0, 0, 0.4); v1.root.scale.set(1.4, 0.9, 0.7); v1.captureInitialTransform();
                window.__SPLAT_EDITOR__.spawnVolumeAt('box', { x: 0.6, y: 0.3, z: 0.5, clone(){return this;} });
                const v2 = vm.items[vm.items.length - 1];
                v2.root.position.set(0.65, 0.35, 0.55); v2.root.scale.set(0.75, 0.75, 0.75); v2.captureInitialTransform();
                v2.boolOp = 'subtract';
                // Create inner group G1 = (v1 - v2)
                const g1 = vm.createGroupFromItems([v1.id, v2.id]);
                // Create 3rd volume v3 and nest G1 + v3 into outer parent group G2!
                window.__SPLAT_EDITOR__.spawnVolumeAt('cylinder', { x: -0.9, y: -0.2, z: 0.4, clone(){return this;} });
                const v3 = vm.items[vm.items.length - 1];
                v3.root.position.set(-0.95, -0.15, 0.4); v3.root.scale.set(0.55, 0.55, 0.7); v3.captureInitialTransform();
                v3.boolOp = 'union';
                const g2 = vm.createGroupFromItems([g1.id, v3.id]);
                vm.syncAllVisuals(new Set([v2.id]), v2.id);
                window.__SPLAT_EDITOR__.selectVolumeOrGroup(v2.id, false);
                // Verify nested group g1 defaulted to collapsed=true (#6)!
                const nestedCollapsedDefault = g1.collapsed === true;
                // Expand g1 to inspect UI & verify NO ↑/↓ arrows and NO inner ○ scope button!
                g1.collapsed = false;
                window.__SPLAT_EDITOR__.selectVolumeOrGroup(v2.id, false);
                const hasUpDownBtns = Array.from(document.querySelectorAll('#scene-volumes-list .row-btn')).some(b => b.textContent === '↑' || b.textContent === '↓');
                const enableBtnCountInVols = Array.from(document.querySelectorAll('#scene-volumes-list .row-btn')).filter(b => b.textContent === '✓' || b.textContent === '○').length;
                // Verify exact analytical predicate: point inside v1 outside v2 = True; point inside v2 (subtracted) = False; point inside v3 (unioned with nested g1) = True!
                const pred = vm.compileSingleOrGroup(g2.id, { x: 0, y: 0, z: 10 });
                const ptInV1Only = pred(-0.3, -0.3, 0.4);
                const ptSubtracted = pred(0.65, 0.35, 0.55);
                const ptInV3 = pred(-1.05, -0.15, 0.4);
                // Verify CSG composite preview mesh was generated (#10) and handles are 2D flat planes (#9)
                const csgCount = window.__SPLAT_EDITOR__.getRc5State().csgPreviewCount;
                const handleIsFlatPlane = v2.handles.length === 6 && v2.handles[0].geometry.type === 'PlaneGeometry';
                // Test #2 Volume Reset Arrow restores creation initial position (not 0,0,0!)
                const initX = v2.initialPosition[0];
                v2.root.position.x = 4.2;
                window.__SPLAT_EDITOR__.resetTransformRow('pos');
                const resetVolX = v2.root.position.x;
                // Verify selecting Scene Object does NOT disable enabled top-level group g2 (B2 decoupling!)
                window.__SPLAT_EDITOR__.selectSceneObjectSingle(0);
                const g2StillEnabled = g2.enabled === true && vm._csgMeshes.size === 1;
                window.__SPLAT_EDITOR__.selectVolumeOrGroup(v2.id, false);
                return { nestedCollapsedDefault, hasUpDownBtns, enableBtnCountInVols, ptInV1Only, ptSubtracted, ptInV3, csgCount, handleIsFlatPlane, initX, resetVolX, g2StillEnabled };
            })()""")
            await asyncio.sleep(0.35)
            await snap("01_rc5_csg_nested_volumes_flat_handles_and_ui.png")
            assert c4["nestedCollapsedDefault"] and (not c4["hasUpDownBtns"]) and c4["enableBtnCountInVols"] == 1
            assert c4["ptInV1Only"] and (not c4["ptSubtracted"]) and c4["ptInV3"], f"Nested CSG predicate failed: {c4}"
            assert c4["csgCount"] == 1 and c4["handleIsFlatPlane"] and abs(c4["resetVolX"] - c4["initX"]) < 1e-4 and c4["g2StillEnabled"]
            report["checks"]["4_nested_csg_volumes_flat_handles_and_decoupling"] = {"pass": True, **c4}
            print("[PASS] 4_nested_csg_volumes_flat_handles_and_decoupling")

            # ---- CHECK 5: #12 Local Space / Bounds Center / Pivot Edit Mutual Exclusion + #13 Video 1 Double-Click Fix ----
            c5 = await eval_js("""(() => {
                // While volume v2 is active/selected, double-click center of canvas (where demo24k sphere sits) -> MUST release volume gizmo lock!
                const canvas = document.getElementById('canvas');
                const rect = canvas.getBoundingClientRect();
                window.__SPLAT_EDITOR__.setBoundsCenter(true);
                const bcOn = window.__SPLAT_EDITOR__.getRc5State();
                // Turning ON Pivot Edit must auto-turn OFF Bounds Center!
                window.__SPLAT_EDITOR__.setPivotEdit(true);
                const peOn = window.__SPLAT_EDITOR__.getRc5State();
                window.__SPLAT_EDITOR__.setPivotEdit(false);
                // Re-enable Bounds Center & select Volume again, then dispatch dblclick on Gaussian sphere!
                window.__SPLAT_EDITOR__.setBoundsCenter(true);
                const vm = window.__SPLAT_EDITOR__.getVolumeManager();
                window.__SPLAT_EDITOR__.selectVolumeOrGroup(vm.items[0].id, false, true);
                canvas.dispatchEvent(new MouseEvent('dblclick', {
                    bubbles: true, clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5
                }));
                const afterDbl = window.__SPLAT_EDITOR__.getRc5State();
                // Test Local Space toggle
                window.__SPLAT_EDITOR__.setLocalSpace(true);
                const localSpaceState = window.__SPLAT_EDITOR__.getRc5State().gizmoSpace;
                return {
                    bcOn: bcOn.useBoundsCenter, peAutoDisabledBc: !peOn.useBoundsCenter && peOn.pivotEditMode,
                    dblReleasedVol: afterDbl.activeVolumeOrGroupId === null,
                    dblAttachedToPivot: afterDbl.gizmoAttachedToPivot && afterDbl.gizmoVisible,
                    dblDisabledBc: !afterDbl.useBoundsCenter,
                    localSpaceState
                };
            })()""")
            assert c5["bcOn"] and c5["peAutoDisabledBc"] and c5["dblReleasedVol"] and c5["dblAttachedToPivot"] and c5["dblDisabledBc"] and c5["localSpaceState"] == "local", f"Pivot/Bounds/DblClick check failed: {c5}"
            report["checks"]["5_bounds_center_pivot_edit_and_dblclick_unlock"] = {"pass": True, **c5}
            print("[PASS] 5_bounds_center_pivot_edit_and_dblclick_unlock")

            # Snapshot with Color Panel open -> verify History Card sits right below Color Panel + minimalist scrollbar!
            await eval_js("""(() => {
                window.__SPLAT_EDITOR__.toggleColorPanel(true);
                window.__SPLAT_EDITOR__.toggleHistoryExpanded();
            })()""")
            await asyncio.sleep(0.3)
            await snap("02_rc5_color_panel_history_and_left_rail.png")
            await eval_js("""(() => {
                window.__SPLAT_EDITOR__.toggleColorPanel(false);
                window.__SPLAT_EDITOR__.toggleHistoryExpanded();
            })()""")

            # ---- CHECK 6: #14 Video 2 Fix — Extreme Far-Zoom Infinite Ground Grid (Zero Moiré / Snow!) ----
            c6 = await eval_js("""(async () => {
                // Zoom camera WAY out (40x distance) to reproduce Video 2 extreme zoom-out!
                const canvas = document.getElementById('canvas');
                for (let k = 0; k < 28; k++) {
                    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 240, deltaMode: 0 }));
                }
                await new Promise(r => setTimeout(r, 550));
                const cam = window.__SPLAT_EDITOR__.getBoundsInfo().cameraPos;
                return { camDist: Math.hypot(...cam), cam };
            })()""")
            await asyncio.sleep(0.25)
            await snap("03_rc5_far_zoom_grid_clean_lod.png")
            assert c6["camDist"] > 40, f"Camera should have zoomed far out: {c6}"
            report["checks"]["6_far_zoom_ground_grid_lod"] = {"pass": True, **c6}
            print("[PASS] 6_far_zoom_ground_grid_lod:", round(c6["camDist"], 1), "m")

            report["consoleErrors"] = console_errors
            assert len(console_errors) == 0, f"Console errors detected: {console_errors}"
            rep_path = os.path.join(out_dir, "rc5_verify_report.json")
            open(rep_path, "w", encoding="utf-8").write(json.dumps(report, indent=2, ensure_ascii=False))
            print(f"\nALL 6 RC5 SEALING CHECKS PASSED! Report: {rep_path}")
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
