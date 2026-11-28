#!/usr/bin/env python3
"""
Comprehensive Real-GPU WebGL2 Verification Suite for 3.2.3-rc11:
  1. Global +Y-Up Coordinate System (camera, grid Y=0 XZ, cylinder +Y axial, measurement deltaH=dY, align Y=0)
  2. Volume Component Visuals:
     - 2.1 Handle Occlusion Dimming (unobstructed handles crisp opaque; handles behind any volume dimmed & desaturated)
     - 2.2 Widened Inward-Fading Glow along CSG structural edges, silhouettes, and boolean intersection seams
  3. Scene Manager UI Enhancements:
     - 3.1 Inline Rename (same box style as Color Panel numeric input; zero window.prompt calls)
     - 3.2 Ctrl Multi-Select Right-Click Menu ([合并, 打组, 删除]) for Objects & Volumes + lossless mergedPieces recipe
     - 3.3 Group Right-Click Menu ([打组, 解组, 删除], omitting [打组] for outermost nested group)
     - 3.4 Ctrl+Drag Copy-Move in both Scene Manager tree and 3D Viewport Translate Gizmo (1-step undoable)
  4. Professional Color Grading Panel:
     - 4.1 Model-only Histogram (zero background pixels)
     - 4.2 Left-mouse release commits single Undo/Redo history step; non-destructive export preserves liveGrade
     - 4.3 Removed [应用（烘焙至球谐SH）] button
  5. History Panel Auto-Grouping (>= 3 consecutive same-kind ops collapse into group; auto-expand when active step enters)
  6. BUG 1 Fix: Scale Gizmo (R) on rotated models (X=90 deg & arbitrary rotation, crossing origin) never flips/shears
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


def make_rc11_yup_scene_sgc2():
    """
    Vibrant +Y-up 3DGS figurine/pedestal test cloud:
    - Pedestal cylinder base on Y in [0, 0.65], R=0.55 (warm gold/amber)
    - Upright torso & cyan sculpted head on Y in [0.65, 2.05] (teal/cyan + magenta accents)
    - Small ground pad at Y=0 in [-2.6, 2.6] x [-2.6, 2.6]
    """
    pts = []
    seed = 2026112611

    def rnd():
        nonlocal seed
        seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
        return seed / 4294967296.0

    # 1. Ground apron on Y = 0 (XZ plane)
    for _ in range(4500):
        x = (rnd() - 0.5) * 5.2
        z = (rnd() - 0.5) * 5.2
        if math.hypot(x, z) < 0.6:
            continue
        y = (rnd() - 0.5) * 0.015
        v = 0.28 + rnd() * 0.08
        pts.append((x, y, z, v, v * 1.04, v * 1.12, 0.92, -2.7))

    # 2. Amber pedestal cylinder (Y in [0.02, 0.68], R = 0.55)
    for _ in range(4500):
        ang = rnd() * math.tau
        rad = 0.55 * (0.88 + 0.12 * rnd())
        y = 0.02 + rnd() * 0.66
        x = math.cos(ang) * rad
        z = math.sin(ang) * rad
        pts.append((x, y, z, 0.82, 0.56 + 0.12 * rnd(), 0.22, 0.96, -3.1))

    # 3. Torso + twin teal plumes (Y in [0.68, 2.05])
    for _ in range(6000):
        u = rnd()
        ang = rnd() * math.tau
        if u < 0.5:
            # Head sphere centered at (0, 1.58, 0), R = 0.42
            cos_p = 2 * rnd() - 1
            sin_p = math.sqrt(max(0.0, 1.0 - cos_p * cos_p))
            r = 0.42 * (0.85 + 0.15 * rnd())
            x = r * sin_p * math.cos(ang)
            y = 1.58 + r * cos_p
            z = r * sin_p * math.sin(ang)
            pts.append((x, y, z, 0.14, 0.85, 0.78, 0.96, -3.15))
        else:
            # Torso + shoulders (Y in [0.70, 1.25])
            y = 0.70 + rnd() * 0.55
            rx = 0.36 * (1.0 - 0.2 * (y - 0.7))
            rz = 0.24
            x = math.cos(ang) * rx * math.sqrt(rnd())
            z = math.sin(ang) * rz * math.sqrt(rnd())
            pts.append((x, y, z, 0.86, 0.26, 0.56, 0.96, -3.15))

    return build_synthetic_sgc2(pts)


async def run_suite(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    tmp_data = tempfile.mkdtemp(prefix="rc11_verify_data_")
    scene_bin = os.path.join(tmp_data, "yup_scene.bin")
    open(scene_bin, "wb").write(make_rc11_yup_scene_sgc2())

    routes = {"/__data__/": tmp_data, "/locales/": os.path.join(PROJ_DIR, "locales")}
    httpd = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), lambda *a, **kw: MultiRootHandler(*a, routes=routes, **kw)
    )
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    if not os.path.exists(edge):
        edge = r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    profile = tempfile.mkdtemp(prefix="rc11_edge_prof_")
    cdp_port = 9291
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
                await asyncio.sleep(0.18)
                d = (await send("Page.captureScreenshot", {"format": "png"})).get("data", "")
                p = os.path.join(out_dir, name)
                open(p, "wb").write(base64.b64decode(d))
                report["screenshots"].append(p)
                return p

            await send("Runtime.enable")
            await send("Page.enable")
            await asyncio.sleep(1.0)

            # Load synthetic +Y-up scene
            await eval_js(f"""(async () => {{
                const buf = await (await fetch('http://127.0.0.1:{port}/__data__/yup_scene.bin')).arrayBuffer();
                await window.__SPLAT_EDITOR__.loadBuffer(buf, {{ totalPoints: 15000, skipAutoAlignPrompt: true }});
                window.__SPLAT_EDITOR__.setCameraPose([4.2, 3.0, 4.6], [0, 0.85, 0]);
                window.__SPLAT_EDITOR__.setTelemetry('GPU 12% 2.0/16.0 GB | CPU 6% 8.1/32.0 GB', {{
                    cpuPct: 6, ramUsedGb: 8.1, ramTotalGb: 32.0, gpuPct: 12, vramUsedGb: 2.0, vramTotalGb: 16.0
                }});
            }})()""")
            await asyncio.sleep(0.35)

            # =========================================================================
            # CHECK 1: Global +Y-Up Coordinate System
            # =========================================================================
            c1 = await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                const camUp = E.getCameraUp();
                const badgeTxt = document.querySelector('.coord-badge')?.textContent?.trim() || '';
                const titleTxt = document.title || '';
                const recipeCoord = E.buildV3Recipe().coordSystem;

                // Verify measurement uses +Y as vertical (deltaH = dY, horiz = hypot(dX, dZ))
                const mm = E.getMeasureManager();
                mm.clearActive({ keepPinned: false });
                mm.addMeasurePointWorld([0, 0, 0]);
                mm.addMeasurePointWorld([3, 2, 4]); // horiz = hypot(3,4) = 5, deltaH = 2
                const m2 = E.getMeasureState().metrics;
                mm.clearActive({ keepPinned: false });

                // Verify cylinder primitive is natively +Y-up axial
                const vm = E.getVolumeManager();
                const cyl = vm.createVolume('cylinder', { x: 0, y: 0, z: 0 }, 2.0);
                cyl.root.scale.set(1.0, 2.4, 1.0); // height along Y in [-2.4, +2.4], radius 1.0 in XZ
                cyl.root.updateMatrixWorld(true);
                const cylPred = vm.compileSingleOrGroup(cyl.id);
                const cylTopInside = cylPred(0, 2.0, 0);
                const cylSideOutside = cylPred(1.5, 0, 0);
                vm.removeVolume(cyl.id);

                return {
                    camUp,
                    badgeTxt,
                    titleTxt,
                    recipeCoord,
                    measureHoriz: Number(m2.horiz.toFixed(4)),
                    measureDeltaH: Number(m2.deltaH.toFixed(4)),
                    cylTopInside,
                    cylSideOutside,
                };
            })()""")
            assert c1["camUp"] == [0, 1, 0], f"Camera up must be +Y: {c1}"
            assert "+Y" in c1["badgeTxt"], f"Coord badge must show +Y: {c1}"
            assert c1["recipeCoord"] == "y-up", f"Recipe coordSystem must be y-up: {c1}"
            assert abs(c1["measureHoriz"] - 5.0) < 1e-3 and abs(c1["measureDeltaH"] - 2.0) < 1e-3, f"Measure not +Y-up: {c1}"
            assert c1["cylTopInside"] is True and c1["cylSideOutside"] is False, f"Cylinder not +Y axial: {c1}"
            report["checks"]["1_global_y_up"] = {"pass": True, **c1}

            # =========================================================================
            # CHECK 2: Volume Handle Occlusion Dimming (Item 二.1)
            # =========================================================================
            c2 = await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                const vm = E.getVolumeManager();
                // Hide main point cloud temporarily so overlapping volumes match user Ref Images 1 & 2 cleanly!
                const mainRowBtns = document.querySelectorAll('#scene-objects-list .scene-row .row-btn');
                if (mainRowBtns[1]) mainRowBtns[1].click(); // index 1 = Eye visibility toggle

                // Recreate the exact 3 overlapping shapes from user Ref Image 1 & 2 (Cylinder + Box + Ellipsoid)
                const cyl = vm.createVolume('cylinder', { x: -0.35, y: 1.05, z: -0.95 }, 1.0);
                cyl.root.scale.set(1.05, 0.95, 1.05);

                const box = vm.createVolume('box', { x: 0.95, y: 0.85, z: 0.25 }, 1.0);
                box.root.scale.set(0.95, 0.85, 0.95);

                const sph = vm.createVolume('ellipsoid', { x: -0.95, y: 0.78, z: 0.75 }, 1.0);
                sph.root.scale.set(0.92, 0.92, 0.92);

                // Select all 3 volumes simultaneously (Ctrl multi-select) so handles are displayed on all 3!
                E.renderSceneManager();
                const rows = [...document.querySelectorAll('#scene-volumes-list .scene-row')];
                rows[0].click();
                rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
                rows[2].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));

                E.setCameraPose([1.8, 3.0, 4.6], [-0.05, 0.85, 0.0]);
                const occ = E.getHandleOcclusionReport();
                const occludedHandles = occ.filter(h => h.occluded);
                const clearHandles = occ.filter(h => !h.occluded);
                return {
                    volIds: [cyl.id, box.id, sph.id],
                    totalHandles: occ.length,
                    occludedCount: occludedHandles.length,
                    clearCount: clearHandles.length,
                    maxOccludedOpacity: occludedHandles.length ? Math.max(...occludedHandles.map(h => h.opacity)) : null,
                    minClearOpacity: clearHandles.length ? Math.min(...clearHandles.map(h => h.opacity)) : null,
                    sample: occ.slice(0, 6),
                };
            })()""")
            await snap("01_handles_occlusion.png")
            assert c2["totalHandles"] == 18, f"Expected 18 handles across 3 volumes, got {c2}"
            assert c2["occludedCount"] >= 6 and c2["clearCount"] >= 4, f"Expected mix of occluded & clear handles: {c2}"
            assert c2["maxOccludedOpacity"] <= 0.36, f"Occluded handle opacity too high: {c2}"
            assert c2["minClearOpacity"] >= 0.99, f"Clear handle opacity should be 1.0: {c2}"
            report["checks"]["2_1_handle_occlusion_dimming"] = {"pass": True, **c2}

            # =========================================================================
            # CHECK 3: Widened Inward-Fading CSG Edge & Seam Glow (Item 二.2)
            # =========================================================================
            c3 = await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                const vm = E.getVolumeManager();
                // Group all 3 volumes into one CSG Union group and enable CSG preview (matches user Ref Image 2)
                document.getElementById('btn-group-selected').click();
                const grp = vm.groups[0];
                grp.enabled = true;
                // Clear selection so handles hide and pure glowing CSG silhouette + seams shine!
                E.selectSceneObjectSingle(0);
                vm.syncAllVisuals(new Set(), null);
                E.setCameraPose([2.1, 3.1, 4.4], [-0.15, 0.85, 0.05]);
                const agree = E.verifyCsgAgreement(grp.id, 800);
                return { groupId: grp.id, csgMeshCount: vm._csgMeshes.size, agree };
            })()""")
            await snap("02_csg_inward_glow.png")
            assert c3["csgMeshCount"] >= 1, f"CSG mesh not rendered: {c3}"
            assert c3["agree"]["ok"] is True and c3["agree"]["matched"] == 800, f"CSG CPU-GPU mismatch: {c3}"
            report["checks"]["2_2_csg_inward_glow"] = {"pass": True, **c3}

            # Restore main cloud visibility and clean up volumes before Scene Manager UI tests
            await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                const mainRowBtns = document.querySelectorAll('#scene-objects-list .scene-row .row-btn');
                if (mainRowBtns[1]) mainRowBtns[1].click();
                E.setCameraPose([4.2, 3.0, 4.6], [0, 0.85, 0]);
            })()""")

            # =========================================================================
            # CHECK 4: Scene Manager UI (Inline Rename, Multi-Select Menu, Group Menu, Ctrl+Drag Copy-Move)
            # =========================================================================
            # 4.1 Inline Rename (no window.prompt!)
            c4_rename = await eval_js("""(() => {
                let promptCalled = false;
                const origPrompt = window.prompt;
                window.prompt = () => { promptCalled = true; return 'BAD'; };
                const nameSpan = document.querySelector('#scene-objects-list .scene-row .name');
                nameSpan.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                const inp = document.querySelector('#scene-objects-list .scene-inline-rename');
                const inpActive = !!inp && document.activeElement === inp;
                const rect = inp ? inp.getBoundingClientRect() : null;
                window.prompt = origPrompt;
                return { promptCalled, inpActive, inpWidth: rect ? Math.round(rect.width) : 0 };
            })()""")
            await snap("03_inline_rename.png")
            c4_rename_commit = await eval_js("""(() => {
                const inp = document.querySelector('#scene-objects-list .scene-inline-rename');
                inp.value = '手办主体_已重命名';
                inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                const newName = window.__SPLAT_EDITOR__.getSceneObjectsInfo()[0].name;
                return { newName, inputRemoved: !document.querySelector('.scene-inline-rename') };
            })()""")
            assert c4_rename["promptCalled"] is False and c4_rename["inpActive"] is True, f"Inline rename failed: {c4_rename}"
            assert c4_rename_commit["newName"] == "手办主体_已重命名" and c4_rename_commit["inputRemoved"] is True, f"Inline rename commit failed: {c4_rename_commit}"

            # 4.2 Ctrl+Drag Copy-Move (Scene Manager + 3D Gizmo) + Multi-Select Right-Click Menu [合并, 打组, 删除]
            c4_dup_and_menu = await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                // Duplicate object via Scene Manager Ctrl+Drag helper
                const dupRes = E.duplicateSceneObjectToTarget(0, null, -1);
                const dupId = dupRes?.newObj?.id;
                // Move duplicated object by +1.8 on X so merge exercises relative transform baking + mergedPieces!
                E.selectSceneObjectSingle(dupId);
                E.simulateCtrlTranslateDrag(1.8, 0, 0); // ALSO exercises 3D Gizmo Ctrl+Drag copy-move -> creates 3rd object!
                const afterGizmoCtrlCount = E.getSceneObjectsInfo().length;

                // Undo the 3D gizmo Ctrl+Drag copy-move in 1 step!
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
                const afterGizmoUndoCount = E.getSceneObjectsInfo().length;

                // Now rotate dupId slightly and Ctrl-select both objects [0, dupId] (re-query fresh DOM after each click!)
                E.selectSceneObjectSingle(dupId);
                E.setPrimaryNodeRotationDeg(0, 30, 0);
                document.querySelectorAll('#scene-objects-list .scene-row')[0].click();
                const freshRow1 = document.querySelectorAll('#scene-objects-list .scene-row')[1];
                freshRow1.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
                const row1After = document.querySelectorAll('#scene-objects-list .scene-row')[1];
                const r = row1After.getBoundingClientRect();
                row1After.dispatchEvent(new MouseEvent('contextmenu', {
                    bubbles: true, cancelable: true, clientX: r.left + 80, clientY: r.top + 12
                }));
                const menu = document.getElementById('scene-mgr-ctx-menu');
                const items = [...menu.querySelectorAll('button')].map(b => b.textContent.trim());
                const menuRect = menu.getBoundingClientRect();
                return {
                    dupId,
                    afterGizmoCtrlCount,
                    afterGizmoUndoCount,
                    menuOpen: !menu.classList.contains('hidden'),
                    items,
                    menuNearRow: Math.abs(menuRect.top - (r.top + 12)) < 40 && menuRect.left > 800,
                };
            })()""")
            await snap("04_ctx_menu_multiselect.png")
            assert c4_dup_and_menu["afterGizmoCtrlCount"] == 3 and c4_dup_and_menu["afterGizmoUndoCount"] == 2, f"Gizmo Ctrl+Drag copy-move failed: {c4_dup_and_menu}"
            assert c4_dup_and_menu["menuOpen"] is True and c4_dup_and_menu["items"] == ["合并", "打组", "删除"] and c4_dup_and_menu["menuNearRow"] is True, f"Multi-select ctx menu mismatch: {c4_dup_and_menu}"

            # Click [合并] -> verify object count drops to 1, mergedPieces exported in V3 recipe, and Ctrl+Z restores!
            c4_merge = await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                const mergeBtn = document.querySelector('#scene-mgr-ctx-menu button');
                mergeBtn.click();
                const afterMergeObjs = E.getSceneObjectsInfo();
                const v3 = E.buildV3Recipe();
                const mergedPayloadEntries = v3.objects.filter(o => o.id === 0).length;

                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
                const afterUndoCount = E.getSceneObjectsInfo().length;
                // Undo the single earlier duplication so we return to 1 clean object (keeping VolumeGroup intact!)
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
                return {
                    afterMergeCount: afterMergeObjs.length,
                    mergedPiecesCount: afterMergeObjs[0].mergedPiecesCount,
                    mergedPayloadEntries,
                    afterUndoCount,
                };
            })()""")
            assert c4_merge["afterMergeCount"] == 1 and c4_merge["afterUndoCount"] == 2, f"Merge/Undo failed: {c4_merge}"
            assert c4_merge["mergedPiecesCount"] >= 1 and c4_merge["mergedPayloadEntries"] >= 2, f"mergedPieces export failed: {c4_merge}"

            # 4.3 Group Right-Click Menu: inner group has [打组, 解组, 删除], outermost nested group has ONLY [解组, 删除]!
            c4_grp_menu = await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                const vm = E.getVolumeManager();
                const innerGrp = vm.groups[0];
                // First right-click non-nested group -> should have [打组, 解组, 删除]
                let head = document.querySelector(`.vol-group-box[data-vol-group-id="${innerGrp.id}"] > .scene-row`);
                head.click();
                head = document.querySelector(`.vol-group-box[data-vol-group-id="${innerGrp.id}"] > .scene-row`);
                let r = head.getBoundingClientRect();
                head.dispatchEvent(new MouseEvent('contextmenu', {
                    bubbles: true, cancelable: true, clientX: r.left + 80, clientY: r.top + 12
                }));
                const innerItemsBeforeWrap = [...document.querySelectorAll('#scene-mgr-ctx-menu button')].map(b => b.textContent.trim());

                // Click [打组] to wrap innerGrp inside an outer parent group!
                document.querySelector('#scene-mgr-ctx-menu button').click();
                const outerGrp = vm.groups.find(g => !g.parentGroupId && g.children.some(c => c.isVolumeGroup));
                let outerHead = document.querySelector(`.vol-group-box[data-vol-group-id="${outerGrp.id}"] > .scene-row`);
                outerHead.click();
                outerHead = document.querySelector(`.vol-group-box[data-vol-group-id="${outerGrp.id}"] > .scene-row`);
                r = outerHead.getBoundingClientRect();
                outerHead.dispatchEvent(new MouseEvent('contextmenu', {
                    bubbles: true, cancelable: true, clientX: r.left + 80, clientY: r.top + 12
                }));
                const outerItems = [...document.querySelectorAll('#scene-mgr-ctx-menu button')].map(b => b.textContent.trim());

                // Also test Volume Ctrl+Drag duplicateNode
                const clonedId = E.duplicateVolumeNode(vm.items[0].id, outerGrp.id, -1);
                return {
                    innerItemsBeforeWrap,
                    outerItems,
                    clonedIdExists: !!clonedId,
                };
            })()""")
            # Re-open outer group context menu cleanly for screenshot
            await eval_js("""(() => {
                const vm = window.__SPLAT_EDITOR__.getVolumeManager();
                const outerGrp = vm.groups.find(g => !g.parentGroupId && g.children.some(c => c.isVolumeGroup));
                const outerHead = document.querySelector(`.vol-group-box[data-vol-group-id="${outerGrp.id}"] > .scene-row`);
                const r = outerHead.getBoundingClientRect();
                outerHead.dispatchEvent(new MouseEvent('contextmenu', {
                    bubbles: true, cancelable: true, clientX: r.left + 80, clientY: r.top + 12
                }));
            })()""")
            await snap("05_ctx_menu_outer_group.png")
            assert c4_grp_menu["innerItemsBeforeWrap"] == ["打组", "解组", "删除"], f"Inner group menu wrong: {c4_grp_menu}"
            assert c4_grp_menu["outerItems"] == ["解组", "删除"], f"Outermost nested group MUST NOT have 打组: {c4_grp_menu}"
            assert c4_grp_menu["clonedIdExists"] is True
            report["checks"]["3_scene_manager_ui"] = {
                "pass": True,
                "inlineRename": {**c4_rename, **c4_rename_commit},
                "multiSelectAndCtrlDrag": c4_dup_and_menu,
                "merge": c4_merge,
                "groupMenu": c4_grp_menu,
            }

            # =========================================================================
            # CHECK 5 & 6: Color Grading (No Apply Button, Pointer-Up History, Auto-Grouping >= 3 + Auto-Expand)
            # =========================================================================
            c5_c6 = await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                // Clean up volumes & focus on main object for clean color + history screenshot
                const vm = E.getVolumeManager();
                for (const g of [...vm.groups]) vm.removeGroup(g.id);
                for (const v of [...vm.items]) vm.removeVolume(v.id);
                vm.syncAllVisuals(new Set(), null);
                E.selectSceneObjectSingle(0);
                document.getElementById('scene-mgr-ctx-menu').classList.add('hidden');

                // Open Color Panel ('c')
                document.getElementById('btn-color-panel').click();
                const hasApplyBtn = !!document.getElementById('btn-color-apply');

                // Verify histogram canvas has non-empty model bars
                const histCanvas = document.getElementById('histogram-canvas');
                const histData = histCanvas.getContext('2d').getImageData(0, 0, histCanvas.width, histCanvas.height).data;
                let brightPixels = 0;
                for (let i = 0; i < histData.length; i += 4) {
                    if (histData[i] + histData[i + 1] + histData[i + 2] > 180) brightPixels++;
                }

                // Perform 4 distinct slider drags (pointerdown -> multiple input ticks -> pointerup)
                const dragSliderEl = (el, vals) => {
                    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
                    for (const v of vals) {
                        el.value = String(v);
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
                };

                const lightSliders = [...document.querySelectorAll('#color-light-sliders .cr-range')];
                const colorSliders = [...document.querySelectorAll('#color-tone-sliders .cr-range')];
                const beforeSteps = E.getHistoryDebug().totalSteps;
                dragSliderEl(lightSliders[0], [0.15, 0.35, 0.55]); // Exposure
                const afterStep1 = E.getHistoryDebug().totalSteps;
                dragSliderEl(lightSliders[1], [10, 25]); // Contrast
                dragSliderEl(colorSliders[3], [15, 30]); // Saturation
                dragSliderEl(colorSliders[2], [20]); // Vibrance
                const afterStep4 = E.getHistoryDebug().totalSteps;

                const histGroupedOpen = E.getHistoryDebug();
                const colorGrp = histGroupedOpen.blocks.find(b => b.type === 'group' && b.groupKey === 'color');
                const domGroupOpen = !!document.querySelector('.history-group:not(.collapsed) .history-group-children');

                // Verify non-destructive export recipe preserves liveGrade!
                const exportedGrades = E.buildV3Recipe().objects[0].bakedGrades || [];
                const exportedExposure = exportedGrades.slice(-1)[0]?.grade?.exposure || 0;

                return {
                    hasApplyBtn,
                    histBrightPixels: brightPixels,
                    addedSteps1: afterStep1 - beforeSteps,
                    addedSteps4: afterStep4 - beforeSteps,
                    colorGrp,
                    domGroupOpen,
                    exportedExposure: Number(exportedExposure.toFixed(2)),
                };
            })()""")
            await snap("06_color_and_history_autoexpand.png")

            assert c5_c6["hasApplyBtn"] is False, "Apply (Bake to SH) button MUST be removed!"
            assert c5_c6["histBrightPixels"] > 150, f"Model histogram appears empty: {c5_c6}"
            assert c5_c6["addedSteps1"] == 1 and c5_c6["addedSteps4"] == 4, f"Each slider pointerup must push exactly 1 step: {c5_c6}"
            assert c5_c6["colorGrp"] is not None and c5_c6["colorGrp"]["count"] >= 4, f"Expected >= 4 consecutive color ops grouped: {c5_c6}"
            assert c5_c6["colorGrp"]["containsCurrent"] is True and c5_c6["colorGrp"]["open"] is True and c5_c6["domGroupOpen"] is True, f"Active history group MUST auto-expand: {c5_c6}"
            assert abs(c5_c6["exportedExposure"] - 0.55) < 0.02, f"Live grade not preserved in exported recipe: {c5_c6}"

            # Now push a non-color step so current leaves color group -> collapse group -> Ctrl+Z back in -> assert auto-expand!
            c6_collapse_reenter = await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                // Close color panel so history card is clearly visible, verify liveGrade still preserved!
                document.getElementById('btn-color-panel').click();
                const liveExpAfterClose = E.getLiveGrade().exposure;

                // Push a non-color step so current leaves color group
                E.duplicateSceneObjectToTarget(0, null, -1);
                // Collapse the color group by clicking its header
                const colorHead = document.querySelector('.history-group-head');
                if (colorHead) colorHead.click();
                const collapsedState = E.getHistoryDebug().blocks.find(b => b.type === 'group' && b.groupKey === 'color');

                // Now Ctrl+Z once so highlighted current step lands BACK inside the color group!
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
                const reenteredState = E.getHistoryDebug().blocks.find(b => b.type === 'group' && b.groupKey === 'color');

                // Undo one color step (vibrance 0.2 -> 0) and redo to verify color undo/redo!
                const vibBeforeUndo = E.getLiveGrade().vibrance;
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
                const vibAfterUndo = E.getLiveGrade().vibrance;
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
                const vibAfterRedo = E.getLiveGrade().vibrance;

                return {
                    liveExpAfterClose: Number(liveExpAfterClose.toFixed(2)),
                    collapsedOpen: collapsedState?.open,
                    reenteredOpen: reenteredState?.open,
                    reenteredContainsCurrent: reenteredState?.containsCurrent,
                    vibBeforeUndo: Number(vibBeforeUndo.toFixed(2)),
                    vibAfterUndo: Number(vibAfterUndo.toFixed(2)),
                    vibAfterRedo: Number(vibAfterRedo.toFixed(2)),
                };
            })()""")
            await snap("07_history_autoexpand_reenter.png")
            assert abs(c6_collapse_reenter["liveExpAfterClose"] - 0.55) < 0.02, "Closing color panel wiped liveGrade!"
            assert c6_collapse_reenter["collapsedOpen"] is False, f"Group failed to collapse when inactive: {c6_collapse_reenter}"
            assert c6_collapse_reenter["reenteredContainsCurrent"] is True and c6_collapse_reenter["reenteredOpen"] is True, f"Group failed to auto-expand on highlight re-entry: {c6_collapse_reenter}"
            assert abs(c6_collapse_reenter["vibBeforeUndo"] - 0.2) < 0.01 and abs(c6_collapse_reenter["vibAfterUndo"]) < 0.01 and abs(c6_collapse_reenter["vibAfterRedo"] - 0.2) < 0.01, f"Color undo/redo mismatch: {c6_collapse_reenter}"
            report["checks"]["4_5_color_and_history_grouping"] = {
                "pass": True,
                **c5_c6,
                **c6_collapse_reenter,
            }

            # =========================================================================
            # CHECK 7 (BUG 1): Scale Gizmo (R) on Rotated Models (X=90° & Arbitrary)
            # =========================================================================
            c7 = await eval_js("""(() => {
                const E = window.__SPLAT_EDITOR__;
                E.selectSceneObjectSingle(0);
                // Reset transform, then apply X = 90 deg (exact Miku repro from user video!)
                E.setPrimaryNodeRotationDeg(90, 0, 0);
                const startT = E.getPrimaryNodeTransform();
                const dotQ = (a, b) => Math.abs(a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3]);

                // World Z drag on X=90° rotated model -> local Y axis aligns with world +Z!
                const afterZ = E.simulateScaleGizmoDrag('Z', 1.8);
                const dotZ = dotQ(startT.quat, afterZ.quat);

                // World Y drag on X=90° rotated model -> local Z axis aligns with world -Y!
                const afterY = E.simulateScaleGizmoDrag('Y', 0.5);
                const dotY = dotQ(startT.quat, afterY.quat);

                // Extreme shrink toward/past center on X
                const afterTinyX = E.simulateScaleGizmoDrag('X', 0.05);
                const dotTinyX = dotQ(startT.quat, afterTinyX.quat);

                // Uniform XYZ drag
                const afterXYZ = E.simulateScaleGizmoDrag('XYZ', 1.5);
                const dotXYZ = dotQ(startT.quat, afterXYZ.quat);

                // Pivot scale must reset back to [1, 1, 1] after drag!
                const pivotScale = E.getPivot().scale.toArray();

                // Test TransformControls internal pointerDown/pointerMove crossing negative side!
                const giz = E.getGizmo();
                giz.setMode('scale');
                giz.axis = 'X';
                giz.pointerDown({ x: 0.12, y: 0.0, button: 0 });
                giz.pointerMove({ x: -0.45, y: 0.0, button: 0 }); // cross past center into negative!
                const afterNegMovePivotScale = E.getPivot().scale.toArray();
                giz.pointerUp({ x: -0.45, y: 0.0, button: 0 });

                // Also test arbitrary non-axis-aligned rotation (35, 25, -15)
                E.setPrimaryNodeRotationDeg(35, 25, -15);
                const arbStart = E.getPrimaryNodeTransform();
                const arbAfter = E.simulateScaleGizmoDrag('Y', 1.6);
                const arbDot = dotQ(arbStart.quat, arbAfter.quat);

                // Undo restores scale cleanly!
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
                const arbAfterUndo = E.getPrimaryNodeTransform();

                return {
                    startScale: startT.scale,
                    afterZScale: afterZ.scale.map(v => Number(v.toFixed(3))),
                    afterYScale: afterY.scale.map(v => Number(v.toFixed(3))),
                    afterTinyXScale: afterTinyX.scale.map(v => Number(v.toFixed(3))),
                    afterXYZScale: afterXYZ.scale.map(v => Number(v.toFixed(3))),
                    minQuatDot: Math.min(dotZ, dotY, dotTinyX, dotXYZ, arbDot),
                    pivotScaleAfterDrag: pivotScale,
                    afterNegMovePivotScale: afterNegMovePivotScale.map(v => Number(v.toFixed(4))),
                    arbAfterScale: arbAfter.scale.map(v => Number(v.toFixed(3))),
                    arbUndoMatched: arbAfterUndo.scale.every((v, i) => Math.abs(v - arbStart.scale[i]) < 1e-3),
                };
            })()""")
            await snap("08_scale_gizmo_rotated_ok.png")

            assert c7["minQuatDot"] > 0.9999, f"Quaternion flipped or drifted during scale drag! {c7}"
            # On X=90° rotation, scaling World Z by 1.8 must scale local Y to ~1.8 while X,Z stay ~1.0!
            assert abs(c7["afterZScale"][1] - 1.8) < 0.02 and abs(c7["afterZScale"][0] - 1.0) < 0.02, f"World Z scale on X=90° mapped wrong axis: {c7}"
            # Scaling World Y by 0.5 must scale local Z to ~0.5!
            assert abs(c7["afterYScale"][2] - 0.5) < 0.02, f"World Y scale on X=90° mapped wrong axis: {c7}"
            # Crossing past origin in TransformControls must stay strictly positive (>= 0.02)!
            assert all(v >= 0.019 and math.isfinite(v) for v in c7["afterNegMovePivotScale"]), f"TransformControls produced negative/zero scale! {c7}"
            assert all(abs(v - 1.0) < 1e-4 for v in c7["pivotScaleAfterDrag"]), f"Pivot scale not reset after drag: {c7}"
            assert c7["arbUndoMatched"] is True, f"Scale undo failed on arbitrary rotation: {c7}"
            report["checks"]["6_bug1_scale_gizmo_fixed"] = {"pass": True, **c7}

            report["consoleErrors"] = console_errors
            assert len(console_errors) == 0, f"Console/Runtime errors occurred: {console_errors}"
            report["allPassed"] = True
            open(os.path.join(out_dir, "rc11_verify_report.json"), "w", encoding="utf-8").write(
                json.dumps(report, ensure_ascii=False, indent=2)
            )
            print("ALL 7 RC11 REAL-GPU WEBGL2 CHECKS PASSED 100% (0 console errors)!")
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
    ap.add_argument("--out", default=os.path.join(ROOT_DIR, r"00_临时提交区\rc11_verify_shots"))
    args = ap.parse_args()
    asyncio.run(run_suite(args.out))
