#!/usr/bin/env python3
"""
Reusable, strictly isolated Real-GPU Benchmark Suite for Splat Convert Desktop.
Measures 3 repeated runs per scene on:
  - 展览馆-converted.sog (14,619,036 splats)
  - 妖娆塞上.sog        (34,873,964 splats)

Separates:
  - Full quality (adaptive=False, 100% points) vs Adaptive (adaptive=True)
  - Engine mode: 'native' (3.2.1 / 3.2.3 Three.js SGC3, SH0) vs 'resplat' (3.2.2 PlayCanvas, full SH3)

Records per run:
  - Cold/Warm decode & first-editable-frame time (s)
  - Orbit frame times (30 frames, fixed angular velocity): P50, P95, P99, Avg (ms), drawnInstances
  - Box-select latency (ms) & selected count
  - System VRAM idle / peak / post-exit (MiB via nvidia-smi) and Chromium process tree RSS peak / post-exit (MiB)
  - Zero console errors, zero WebGL errors
"""
import argparse
import asyncio
import http.server
import json
import math
import os
import shutil
import socketserver
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile
import websockets

ROOT_DIR = r"c:\Users\186\Desktop\高斯泼溅素材的流程化"
PROJ_DIR = os.path.join(ROOT_DIR, r"01_当前开发工程\splat-convert-desktop")
REAL_DIR = os.path.join(ROOT_DIR, r"06_测试素材\真实场景")
ENGINE_ZIP = os.path.join(PROJ_DIR, r".cache\engine-win32-x64.zip")
CHROME_EXE = r"C:\Users\186\AppData\Local\ms-playwright\chromium-1248\chrome-win64\chrome.exe"

SCENES = [
    {"id": "hall", "file": "展览馆-converted.sog", "expected_pts": 14619036},
    {"id": "saishang", "file": "妖娆塞上.sog", "expected_pts": 34873964},
]


def query_vram_mib():
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            text=True, timeout=5
        ).strip().splitlines()[0]
        return int(out.strip())
    except Exception:
        return None


def query_gpu_meta():
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
            text=True, timeout=5
        ).strip().splitlines()[0]
        parts = [p.strip() for p in out.split(",")]
        return {"gpu": parts[0], "driver": parts[1], "vramTotal": parts[2]}
    except Exception:
        return {"gpu": "unknown", "driver": "unknown", "vramTotal": "unknown"}


def query_chrome_rss_mib(root_pid):
    try:
        ps_cmd = (
            f"$pids=@({root_pid});"
            f"$all=Get-CimInstance Win32_Process;"
            f"$q=New-Object System.Collections.Generic.Queue[int];$q.Enqueue({root_pid});"
            f"$sum=0L;$seen=@{{}};"
            f"while($q.Count -gt 0){{$p=$q.Dequeue();if($seen[$p]){{continue}};$seen[$p]=$true;"
            f"$proc=$all|Where-Object{{$_.ProcessId -eq $p}};if($proc){{$sum+=[int64]$proc.WorkingSetSize}};"
            f"foreach($c in ($all|Where-Object{{$_.ParentProcessId -eq $p}})){{$q.Enqueue([int]$c.ProcessId)}}}};"
            f"[math]::Round($sum/1048576.0,1)"
        )
        out = subprocess.check_output(
            ["powershell.exe", "-NoProfile", "-Command", ps_cmd],
            text=True, timeout=8
        ).strip()
        return float(out) if out else None
    except Exception:
        return None


def percentile(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    idx = min(len(s) - 1, max(0, int(math.ceil((p / 100.0) * len(s))) - 1))
    return round(s[idx], 2)


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def make_handler(serve_dir, bin_map):
    class Handler(http.server.SimpleHTTPRequestHandler):
        extensions_map = {
            **http.server.SimpleHTTPRequestHandler.extensions_map,
            ".js": "application/javascript; charset=utf-8",
            ".mjs": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".wasm": "application/wasm",
            ".bin": "application/octet-stream",
            ".json": "application/json",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".PNG": "image/png",
        }

        def translate_path(self, path):
            clean = path.split("?", 1)[0]
            if clean in bin_map:
                return bin_map[clean]
            if clean.startswith("/__real__/"):
                return os.path.join(REAL_DIR, urllib.parse.unquote(clean[len("/__real__/"):]).replace("/", os.sep))
            if clean == "/" or clean == "":
                clean = "/index.html"
            return os.path.join(serve_dir, clean.lstrip("/").replace("/", os.sep))

        def do_HEAD(self):
            fpath = self.translate_path(self.path)
            if not os.path.isfile(fpath):
                self.send_error(404)
                return
            size = os.path.getsize(fpath)
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(fpath))
            self.send_header("Content-Length", str(size))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()

        def do_GET(self):
            fpath = self.translate_path(self.path)
            if not os.path.isfile(fpath):
                self.send_error(404)
                return
            size = os.path.getsize(fpath)
            rng = self.headers.get("Range")
            if rng and rng.startswith("bytes="):
                part = rng[6:].split(",")[0].strip()
                s, e = part.split("-", 1)
                start = int(s) if s else 0
                end = min(int(e) if e else size - 1, size - 1)
                length = max(0, end - start + 1)
                self.send_response(206)
                self.send_header("Content-Type", self.guess_type(fpath))
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                with open(fpath, "rb") as f:
                    f.seek(start)
                    rem = length
                    while rem > 0:
                        chunk = f.read(min(1024 * 1024, rem))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        rem -= len(chunk)
                return
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(fpath))
            self.send_header("Content-Length", str(size))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            with open(fpath, "rb") as f:
                shutil.copyfileobj(f, self.wfile, 1024 * 1024)

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
        return await asyncio.wait_for(fut, timeout=240)

    async def eval_js(self, expr):
        res = await self.call("Runtime.evaluate", {
            "expression": expr, "awaitPromise": True, "returnByValue": True
        })
        if "exceptionDetails" in res:
            raise RuntimeError(str(res["exceptionDetails"]))
        return res.get("result", {}).get("value")

    async def close(self):
        self._task.cancel()


async def start_chrome():
    user_dir = tempfile.mkdtemp(prefix="splat-bench-cdp-")
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
            "--enable-precise-memory-info",
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
    if not ws_url:
        chrome.kill()
        raise RuntimeError("Failed to launch headless Chromium CDP")
    debug_port = ws_url.split(":")[2].split("/")[0]
    pages = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json").read().decode())
    page_ws = next(p["webSocketDebuggerUrl"] for p in pages if p.get("type") == "page")
    ws = await websockets.connect(page_ws, max_size=64 * 1024 * 1024)
    cdp = CDP(ws)
    await cdp.call("Page.enable")
    await cdp.call("Runtime.enable")
    await cdp.call("Emulation.setDeviceMetricsOverride", {
        "width": 1520, "height": 900, "deviceScaleFactor": 1, "mobile": False
    })
    return chrome, user_dir, ws, cdp


async def stop_chrome(chrome, user_dir, ws, cdp):
    try:
        await cdp.close()
    except Exception:
        pass
    try:
        await ws.close()
    except Exception:
        pass
    chrome.terminate()
    try:
        chrome.wait(timeout=5)
    except Exception:
        chrome.kill()
    shutil.rmtree(user_dir, ignore_errors=True)


def ensure_node_runtime(runtime_dir):
    if not os.path.exists(os.path.join(runtime_dir, "node.exe")):
        with zipfile.ZipFile(ENGINE_ZIP, "r") as zf:
            zf.extractall(runtime_dir)


def decode_sog_to_sgc3(worker_js, runtime_dir, sog_path, out_bin):
    node_exe = os.path.join(runtime_dir, "node.exe")
    if not os.path.exists(node_exe):
        node_exe = "node"
    t0 = time.perf_counter()
    proc = subprocess.run(
        [node_exe, worker_js, "sample", sog_path, out_bin, "0", runtime_dir],
        capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    dt = time.perf_counter() - t0
    if proc.returncode != 0:
        raise RuntimeError(f"SGC3 decode failed: {proc.stderr[-800:]}")
    return round(dt, 3)


async def bench_native_run(port, bin_url, expected_pts, decode_s, run_idx):
    vram_idle = query_vram_mib()
    chrome, udir, ws, cdp = await start_chrome()
    try:
        await cdp.call("Page.navigate", {"url": f"http://127.0.0.1:{port}/index.html"})
        await asyncio.sleep(1.0)
        t_mount0 = time.perf_counter()
        await cdp.eval_js(f"""(async () => {{
          const r = await fetch('{bin_url}');
          const buf = await r.arrayBuffer();
          await window.__SPLAT_EDITOR__.loadBuffer(buf, {{ totalPoints: {expected_pts} }});
          await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
        }})()""")
        mount_s = round(time.perf_counter() - t_mount0, 3)
        await asyncio.sleep(0.8)

        # Measure FULL (adaptive=False, 100% points) and ADAPTIVE (adaptive=True) strictly separately!
        async def orbit_pass(adaptive):
            res = await cdp.eval_js(f"""(async () => {{
              window.__SPLAT_EDITOR__.setDisplayMode("{ 'centers' if adaptive else 'splat' }" === 'centers' && typeof window.__SPLAT_EDITOR__.setInteractiveDownsample !== 'function' ? "centers" : "splat");
              if (typeof window.__SPLAT_EDITOR__.setInteractiveDownsample === 'function') {{
                window.__SPLAT_EDITOR__.setInteractiveDownsample({str(adaptive).lower()});
              }}
              for (let w = 0; w < 4; w++) {{
                window.__SPLAT_EDITOR__.orbitCameraStep(0.045, 0.0);
                await new Promise(r => requestAnimationFrame(r));
              }}
              const dts = [];
              let prev = performance.now();
              for (let i = 0; i < 30; i++) {{
                window.__SPLAT_EDITOR__.orbitCameraStep(0.055, 0.0);
                await new Promise(r => requestAnimationFrame(r));
                const now = performance.now();
                dts.push(now - prev);
                prev = now;
              }}
              const perf = window.__SPLAT_EDITOR__.getPerfStats();
              window.__SPLAT_EDITOR__.endOrbitTest();
              await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
              const gl = document.getElementById('canvas').getContext('webgl2');
              return {{
                dts,
                drawn: perf.drawnInstances,
                total: perf.totalPoints,
                ratio: Number(perf.adaptiveDrawRatio.toFixed(3)),
                glErr: gl ? gl.getError() : -1,
                jsHeapMB: performance.memory ? Number((performance.memory.usedJSHeapSize / 1048576).toFixed(1)) : null
              }};
            }})()""")
            dts = res["dts"]
            return {
                "p50Ms": percentile(dts, 50),
                "p95Ms": percentile(dts, 95),
                "p99Ms": percentile(dts, 99),
                "avgMs": round(statistics.mean(dts), 2),
                "drawnInstances": res["drawn"],
                "totalPoints": res["total"],
                "adaptiveRatio": res["ratio"],
                "glErr": res["glErr"],
                "jsHeapMB": res["jsHeapMB"],
            }

        full_stats = await orbit_pass(False)
        vram_peak_full = query_vram_mib()
        rss_peak = query_chrome_rss_mib(chrome.pid)

        adaptive_stats = await orbit_pass(True)
        vram_peak_adap = query_vram_mib()
        vram_peak = max(v for v in [vram_peak_full, vram_peak_adap] if v is not None) if vram_peak_full is not None else None

        # Measure Box-Select latency (central 25% rect, through-selection)
        box_sel = await cdp.eval_js("""(async () => {
          const canvas = document.getElementById('canvas');
          const r = canvas.getBoundingClientRect();
          window.__SPLAT_EDITOR__.setActiveTool('rect');
          const t0 = performance.now();
          if (typeof window.__SPLAT_EDITOR__.triggerBoxSelect === 'function') {
            window.__SPLAT_EDITOR__.triggerBoxSelect(-0.24, -0.24, 0.24, 0.24, 'replace');
          } else {
            const x0 = r.left + r.width * 0.38, y0 = r.top + r.height * 0.38;
            const x1 = r.left + r.width * 0.62, y1 = r.top + r.height * 0.62;
            canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x0, clientY: y0 }));
            canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, clientX: x1, clientY: y1 }));
            canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: x1, clientY: y1 }));
          }
          await new Promise(res => requestAnimationFrame(res));
          const dt = performance.now() - t0;
          const selText = document.getElementById('stat-selected')?.textContent || '0';
          window.__SPLAT_EDITOR__.deselectAllPoints();
          window.__SPLAT_EDITOR__.setActiveTool('orbit');
          return { boxSelectMs: Number(dt.toFixed(1)), selectedText: selText };
        })()""")

        # Trigger explicit unload/dispose & check memory reclamation
        await cdp.eval_js("window.dispatchEvent(new Event('beforeunload'))")
        await asyncio.sleep(0.5)
        errs = list(cdp.errs)
    finally:
        await stop_chrome(chrome, udir, ws, cdp)

    await asyncio.sleep(1.5)
    vram_after = query_vram_mib()
    return {
        "run": run_idx,
        "decodeSec": decode_s,
        "mountSec": mount_s,
        "firstEditableSec": round(decode_s + mount_s, 3),
        "full": full_stats,
        "adaptive": adaptive_stats,
        "boxSelectMs": box_sel["boxSelectMs"],
        "boxSelectedText": box_sel["selectedText"],
        "vramIdleMiB": vram_idle,
        "vramPeakMiB": vram_peak,
        "vramDeltaPeakMiB": (vram_peak - vram_idle) if (vram_peak is not None and vram_idle is not None) else None,
        "vramAfterExitMiB": vram_after,
        "vramReclaimedMiB": (vram_peak - vram_after) if (vram_peak is not None and vram_after is not None) else None,
        "chromeRssPeakMiB": rss_peak,
        "consoleErrors": len(errs),
        "errorSamples": errs[:5],
    }


async def bench_resplat_run(port, sog_file, run_idx):
    vram_idle = query_vram_mib()
    chrome, udir, ws, cdp = await start_chrome()
    try:
        scene_url = f"http://127.0.0.1:{port}/__real__/{urllib.parse.quote(sog_file)}"
        nav_url = f"http://127.0.0.1:{port}/index.html?lng=zh-CN&load={urllib.parse.quote(scene_url, safe='')}&filename={urllib.parse.quote(sog_file)}"
        t0 = time.perf_counter()
        await cdp.call("Page.navigate", {"url": nav_url})
        for _ in range(480):
            val = await cdp.eval_js("""(() => {
              const s = window.scene;
              const api = window.__RESPLAT_DESKTOP__;
              if (!s || !api) return { ready: false };
              const splats = s.elements.filter(e => e.type === 'splat');
              if (splats.length === 0) return { ready: false };
              return { ready: splats[0].changedCounter > 0, count: splats[0].numSplats };
            })()""")
            if val.get("ready"):
                break
            await asyncio.sleep(0.25)
        else:
            raise RuntimeError(f"Timeout loading {sog_file} in ReSplat")
        first_editable_s = round(time.perf_counter() - t0, 3)

        await cdp.eval_js("""(async () => {
          window.__RESPLAT_DESKTOP__.focusCamera();
          for (let i = 0; i < 4; i++) {
            window.scene.forceRender = true;
            await new Promise(r => requestAnimationFrame(r));
          }
        })()""")

        async def orbit_pass(adaptive):
            res = await cdp.eval_js(f"""(async () => {{
              const s = window.scene;
              const cam = s.camera;
              s.interactiveDownsample = {str(adaptive).lower()};
              if (!{str(adaptive).lower()}) s.adaptiveDrawStride = 1;
              window.__RESPLAT_DESKTOP__.setSimulatingInteraction(true);
              for (let w = 0; w < 4; w++) {{
                cam.setAzimElev(cam.azim + 2.5, cam.elevation, 0);
                s.forceRender = true;
                await new Promise(r => requestAnimationFrame(r));
              }}
              const dts = [];
              let maxStride = 1;
              let prev = performance.now();
              for (let i = 0; i < 30; i++) {{
                cam.setAzimElev(cam.azim + 3.0, cam.elevation, 0);
                s.forceRender = true;
                await new Promise(r => requestAnimationFrame(r));
                const now = performance.now();
                dts.push(now - prev);
                prev = now;
                if (s.adaptiveDrawStride > maxStride) maxStride = s.adaptiveDrawStride;
              }}
              window.__RESPLAT_DESKTOP__.setSimulatingInteraction(false);
              await new Promise(r => setTimeout(r, 120));
              s.forceRender = true;
              await new Promise(r => requestAnimationFrame(r));
              const gl = s.app.graphicsDevice.gl;
              const sp = s.elements.find(e => e.type === 'splat');
              return {{
                dts,
                total: sp ? sp.numSplats : 0,
                maxStride,
                restoredStride: s.adaptiveDrawStride,
                glErr: gl ? gl.getError() : -1,
                jsHeapMB: performance.memory ? Number((performance.memory.usedJSHeapSize / 1048576).toFixed(1)) : null
              }};
            }})()""")
            dts = res["dts"]
            return {
                "p50Ms": percentile(dts, 50),
                "p95Ms": percentile(dts, 95),
                "p99Ms": percentile(dts, 99),
                "avgMs": round(statistics.mean(dts), 2),
                "totalPoints": res["total"],
                "maxStride": res["maxStride"],
                "restoredStride": res["restoredStride"],
                "glErr": res["glErr"],
                "jsHeapMB": res["jsHeapMB"],
            }

        full_stats = await orbit_pass(False)
        vram_peak_full = query_vram_mib()
        rss_peak = query_chrome_rss_mib(chrome.pid)
        adaptive_stats = await orbit_pass(True)
        vram_peak_adap = query_vram_mib()
        vram_peak = max(v for v in [vram_peak_full, vram_peak_adap] if v is not None) if vram_peak_full is not None else None

        # Box-select latency via ReSplat rectSelection event
        box_sel = await cdp.eval_js("""(async () => {
          const t0 = performance.now();
          window.scene.events.fire('select.rect', 'set', { start: { x: 0.38, y: 0.38 }, end: { x: 0.62, y: 0.62 } });
          await new Promise(r => requestAnimationFrame(r));
          const dt = performance.now() - t0;
          const sp = window.scene.elements.find(e => e.type === 'splat');
          const selCount = sp ? sp.numSelected : 0;
          window.scene.events.fire('select.none');
          return { boxSelectMs: Number(dt.toFixed(1)), selectedText: String(selCount) };
        })()""")
        errs = list(cdp.errs)
    finally:
        await stop_chrome(chrome, udir, ws, cdp)

    await asyncio.sleep(1.5)
    vram_after = query_vram_mib()
    return {
        "run": run_idx,
        "decodeSec": None,
        "mountSec": None,
        "firstEditableSec": first_editable_s,
        "full": full_stats,
        "adaptive": adaptive_stats,
        "boxSelectMs": box_sel["boxSelectMs"],
        "boxSelectedText": box_sel["selectedText"],
        "vramIdleMiB": vram_idle,
        "vramPeakMiB": vram_peak,
        "vramDeltaPeakMiB": (vram_peak - vram_idle) if (vram_peak is not None and vram_idle is not None) else None,
        "vramAfterExitMiB": vram_after,
        "vramReclaimedMiB": (vram_peak - vram_after) if (vram_peak is not None and vram_after is not None) else None,
        "chromeRssPeakMiB": rss_peak,
        "consoleErrors": len(errs),
        "errorSamples": errs[:5],
    }


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["native", "resplat"], required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--serve-dir", required=True)
    ap.add_argument("--worker-js", default=os.path.join(PROJ_DIR, r"windows\editor\worker.mjs"))
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--out-json", required=True)
    args = ap.parse_args()

    tmp_root = tempfile.mkdtemp(prefix="splat-bench-work-")
    runtime_dir = os.path.join(tmp_root, "engine")
    bin_map = {}

    if args.mode == "native":
        ensure_node_runtime(runtime_dir)

    server = ThreadedHTTPServer(("127.0.0.1", 0), make_handler(args.serve_dir, bin_map))
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    report = {
        "label": args.label,
        "mode": args.mode,
        "serveDir": args.serve_dir,
        "shDegree": "SH0 (DC linear RGBA8, SGC3)" if args.mode == "native" else "SH3 Full (bands 0-3, PlayCanvas GSplat)",
        "window": "1520x900 dpr=1",
        "orbitTrajectory": "30 frames @ dAzim=0.055 rad/frame (native) or 3.0 deg/frame (resplat), 4 warmup frames",
        "hardware": query_gpu_meta(),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "scenes": {},
    }

    try:
        for sc in SCENES:
            sog_path = os.path.join(REAL_DIR, sc["file"])
            sc_runs = []
            print(f"\n=== [{args.label}] Scene: {sc['file']} ({sc['expected_pts']:,} pts), {args.runs} runs ===", flush=True)
            for r in range(1, args.runs + 1):
                if args.mode == "native":
                    out_bin = os.path.join(tmp_root, f"{sc['id']}_run{r}.sgc3.bin")
                    dec_s = decode_sog_to_sgc3(args.worker_js, runtime_dir, sog_path, out_bin)
                    bin_url = f"/{sc['id']}_run{r}.bin"
                    bin_map[bin_url] = out_bin
                    res = await bench_native_run(port, bin_url, sc["expected_pts"], dec_s, r)
                    try:
                        os.remove(out_bin)
                    except OSError:
                        pass
                else:
                    res = await bench_resplat_run(port, sc["file"], r)
                sc_runs.append(res)
                print(
                    f"  Run {r}: firstEditable={res['firstEditableSec']}s | "
                    f"FULL P50={res['full']['p50Ms']}ms P95={res['full']['p95Ms']}ms P99={res['full']['p99Ms']}ms | "
                    f"ADAP P50={res['adaptive']['p50Ms']}ms P95={res['adaptive']['p95Ms']}ms | "
                    f"boxSel={res['boxSelectMs']}ms | VRAM peak={res['vramPeakMiB']}MiB (+{res['vramDeltaPeakMiB']}) after={res['vramAfterExitMiB']}MiB | "
                    f"RSS={res['chromeRssPeakMiB']}MiB | errs={res['consoleErrors']}",
                    flush=True
                )
            report["scenes"][sc["id"]] = {
                "file": sc["file"],
                "expectedPoints": sc["expected_pts"],
                "runs": sc_runs,
            }
    finally:
        server.shutdown()
        shutil.rmtree(tmp_root, ignore_errors=True)

    os.makedirs(os.path.dirname(os.path.abspath(args.out_json)), exist_ok=True)
    with open(args.out_json, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\nSaved benchmark report -> {args.out_json}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
