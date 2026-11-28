#!/usr/bin/env python3
"""
002-A Frozen-EXE Real-GPU Benchmark Suite for Splat Convert Desktop.

Extracts the EXACT embedded editor assets + Node engine directly from a packaged
portable single-file EXE (e.g. frozen 3.2.3-rc12 or candidate 002-A EXE) into an
isolated temp directory, then measures >=3 runs on:
  - 展览馆-converted.sog (14,619,036 splats)
  - 妖娆塞上.sog        (34,873,964 splats)

Zero foreground mouse/keyboard input. Never mutates source assets or EXE files.

Records per run (with Cold Run 1 vs Warm Runs 2..N separated):
  - Fixed hardware, NVIDIA driver, active Windows power plan, OS, window size,
    SH degree (SH0 SGC3), 100% point count, camera trajectory, EXE SHA-256 & assetsHash
  - decodeSec, mountSec, firstEditableSec
  - Full Splat (100% points, sorted): P50/P95/P99/Avg + raw 30-frame frameTimesMs
  - Centers Mode (100% points, zero sort): P50/P95/P99/Avg + raw 30-frame frameTimesMs
  - Box-select latency (ms), Soft-delete latency (ms), Undo-delete latency (ms),
    Undo-select latency (ms), plus optional syncTelemetry if exposed by candidate
  - Process-tree RSS peak (MiB), VRAM idle / peak / delta / post-exit / reclaimed (MiB)
  - Console & WebGL error counts
"""
import argparse
import asyncio
import hashlib
import http.server
import json
import math
import os
import platform
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
REAL_DIR = os.path.join(ROOT_DIR, r"06_测试素材\真实场景")
CHROME_EXE = r"C:\Users\186\AppData\Local\ms-playwright\chromium-1248\chrome-win64\chrome.exe"

SCENES = [
    {"id": "hall", "file": "展览馆-converted.sog", "expected_pts": 14619036},
    {"id": "saishang", "file": "妖娆塞上.sog", "expected_pts": 34873964},
]


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(4 * 1024 * 1024)
            if not b:
                break
            h.update(b)
    return h.hexdigest().upper()


def query_vram_mib():
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            text=True, timeout=5
        ).strip().splitlines()[0]
        return int(out.strip())
    except Exception:
        return None


def query_env_meta():
    meta = {
        "os": platform.platform(),
        "cpuCount": os.cpu_count(),
        "gpu": "unknown",
        "driver": "unknown",
        "vramTotal": "unknown",
        "powerPlan": "unknown",
    }
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
            text=True, timeout=5
        ).strip().splitlines()[0]
        parts = [p.strip() for p in out.split(",")]
        meta["gpu"] = parts[0]
        meta["driver"] = parts[1]
        meta["vramTotal"] = parts[2]
    except Exception:
        pass
    try:
        out = subprocess.check_output(
            ["powercfg", "/getactivescheme"],
            text=True, timeout=5, errors="replace"
        ).strip()
        meta["powerPlan"] = out
    except Exception:
        pass
    try:
        ps = "(Get-CimInstance Win32_Processor | Select-Object -First 1).Name + ' | RAM=' + [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1) + 'GB'"
        out = subprocess.check_output(
            ["powershell.exe", "-NoProfile", "-Command", ps],
            text=True, timeout=8, errors="replace"
        ).strip()
        if out:
            meta["cpuAndRam"] = out
    except Exception:
        pass
    return meta


def query_chrome_rss_mib(root_pid):
    try:
        ps_cmd = (
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
            text=True, timeout=10
        ).strip()
        return float(out) if out else None
    except Exception:
        return None


def extract_packaged_exe_assets(exe_path, target_dir):
    """Extract embedded editor.* resources, editor.manifest.json, and engine.zip directly from the packaged EXE."""
    editor_dir = os.path.join(target_dir, "editor")
    engine_dir = os.path.join(target_dir, "engine")
    os.makedirs(editor_dir, exist_ok=True)
    os.makedirs(engine_dir, exist_ok=True)
    engine_zip = os.path.join(target_dir, "engine.zip")
    manifest_out = os.path.join(target_dir, "editor.manifest.json")

    ps_script = f"""
$ErrorActionPreference = 'Stop'
$asm = [Reflection.Assembly]::LoadFile('{exe_path}')
$names = $asm.GetManifestResourceNames()
foreach ($n in $names) {{
  if ($n -eq 'editor.manifest.json') {{
    $s = $asm.GetManifestResourceStream($n)
    $f = [IO.File]::Create('{manifest_out}')
    try {{ $s.CopyTo($f) }} finally {{ $f.Dispose(); $s.Dispose() }}
  }} elseif ($n -eq 'engine.zip') {{
    $s = $asm.GetManifestResourceStream($n)
    $f = [IO.File]::Create('{engine_zip}')
    try {{ $s.CopyTo($f) }} finally {{ $f.Dispose(); $s.Dispose() }}
  }} elseif ($n.StartsWith('editor.')) {{
    $rel = $n.Substring(7).Replace('/', [IO.Path]::DirectorySeparatorChar)
    $dst = Join-Path '{editor_dir}' $rel
    $dir = [IO.Path]::GetDirectoryName($dst)
    if ($dir -and !(Test-Path -LiteralPath $dir)) {{ [IO.Directory]::CreateDirectory($dir) | Out-Null }}
    $s = $asm.GetManifestResourceStream($n)
    $f = [IO.File]::Create($dst)
    try {{ $s.CopyTo($f) }} finally {{ $f.Dispose(); $s.Dispose() }}
  }}
}}
Write-Output 'EXTRACTED_OK'
"""
    proc = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", ps_script],
        capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if proc.returncode != 0 or "EXTRACTED_OK" not in proc.stdout:
        raise RuntimeError(f"Failed to extract EXE resources: {proc.stderr}\n{proc.stdout}")

    with zipfile.ZipFile(engine_zip, "r") as zf:
        zf.extractall(engine_dir)
    os.remove(engine_zip)

    with open(manifest_out, "r", encoding="utf-8-sig") as f:
        manifest = json.load(f)

    return editor_dir, engine_dir, manifest


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
            if clean == "/" or clean == "":
                clean = "/index.html"
            return os.path.join(serve_dir, clean.lstrip("/").replace("/", os.sep))

        def do_GET(self):
            fpath = self.translate_path(self.path)
            if not os.path.isfile(fpath):
                self.send_error(404)
                return
            size = os.path.getsize(fpath)
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(fpath))
            self.send_header("Content-Length", str(size))
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


async def start_chrome(user_dir):
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
    return chrome, ws, cdp


async def stop_chrome(chrome, ws, cdp):
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


def decode_sog_to_sgc3(worker_js, engine_dir, sog_path, out_bin):
    node_exe = os.path.join(engine_dir, "node.exe")
    if not os.path.exists(node_exe):
        node_exe = "node"
    t0 = time.perf_counter()
    proc = subprocess.run(
        [node_exe, worker_js, "sample", sog_path, out_bin, "0", engine_dir],
        capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    dt = time.perf_counter() - t0
    if proc.returncode != 0:
        raise RuntimeError(f"SGC3 decode failed: {proc.stderr[-800:]}")
    return round(dt, 3)


async def bench_run(port, bin_url, expected_pts, decode_s, run_idx, cache_cond, user_dir):
    vram_idle = query_vram_mib()
    chrome, ws, cdp = await start_chrome(user_dir)
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

        async def orbit_pass(mode):
            res = await cdp.eval_js(f"""(async () => {{
              window.__SPLAT_EDITOR__.setDisplayMode("{mode}");
              await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
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
                dts.push(Number((now - prev).toFixed(2)));
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
                "glErr": res["glErr"],
                "jsHeapMB": res["jsHeapMB"],
                "frameTimesMs": dts,
            }

        full_splat = await orbit_pass("splat")
        vram_peak_splat = query_vram_mib()
        rss_peak = query_chrome_rss_mib(chrome.pid)

        centers_mode = await orbit_pass("centers")
        vram_peak_centers = query_vram_mib()
        vram_peak = max(v for v in [vram_peak_splat, vram_peak_centers] if v is not None) if vram_peak_splat is not None else None

        # Switch back to splat mode, then measure: Box-Select -> Soft-Delete -> Undo Delete -> Undo Select
        gestures = await cdp.eval_js("""(async () => {
          const api = window.__SPLAT_EDITOR__;
          api.setDisplayMode('splat');
          await new Promise(r => requestAnimationFrame(r));
          if (typeof api.resetSyncTelemetry === 'function') api.resetSyncTelemetry();

          api.setActiveTool('rect');
          const tSel0 = performance.now();
          api.triggerBoxSelect(-0.24, -0.24, 0.24, 0.24, 'replace');
          await new Promise(r => requestAnimationFrame(r));
          const boxSelectMs = Number((performance.now() - tSel0).toFixed(2));
          const afterSel = api.getEditSessionStats ? api.getEditSessionStats() : null;
          const selText = document.getElementById('stat-selected')?.textContent || '0';

          const tDel0 = performance.now();
          api.softDeleteSelected();
          await new Promise(r => requestAnimationFrame(r));
          const softDeleteMs = Number((performance.now() - tDel0).toFixed(2));
          const afterDel = api.getEditSessionStats ? api.getEditSessionStats() : null;

          const tUndoDel0 = performance.now();
          api.undo();
          await new Promise(r => requestAnimationFrame(r));
          const undoDeleteMs = Number((performance.now() - tUndoDel0).toFixed(2));
          const afterUndoDel = api.getEditSessionStats ? api.getEditSessionStats() : null;

          const tUndoSel0 = performance.now();
          api.undo();
          await new Promise(r => requestAnimationFrame(r));
          const undoSelectMs = Number((performance.now() - tUndoSel0).toFixed(2));
          const afterUndoSel = api.getEditSessionStats ? api.getEditSessionStats() : null;

          const syncTel = typeof api.getSyncTelemetry === 'function' ? api.getSyncTelemetry() : null;
          api.setActiveTool('orbit');
          return {
            boxSelectMs,
            softDeleteMs,
            undoDeleteMs,
            undoSelectMs,
            selectedText: selText,
            afterSel,
            afterDel,
            afterUndoDel,
            afterUndoSel,
            syncTelemetry: syncTel,
          };
        })()""")

        await cdp.eval_js("window.dispatchEvent(new Event('beforeunload'))")
        await asyncio.sleep(0.5)
        errs = list(cdp.errs)
    finally:
        await stop_chrome(chrome, ws, cdp)

    await asyncio.sleep(1.5)
    vram_after = query_vram_mib()
    return {
        "run": run_idx,
        "cacheCondition": cache_cond,
        "decodeSec": decode_s,
        "mountSec": mount_s,
        "firstEditableSec": round(decode_s + mount_s, 3),
        "fullSplat": full_splat,
        "centersMode": centers_mode,
        "boxSelectMs": gestures["boxSelectMs"],
        "softDeleteMs": gestures["softDeleteMs"],
        "undoDeleteMs": gestures["undoDeleteMs"],
        "undoSelectMs": gestures["undoSelectMs"],
        "boxSelectedText": gestures["selectedText"],
        "sessionStats": {
            "afterSelect": gestures["afterSel"],
            "afterDelete": gestures["afterDel"],
            "afterUndoDelete": gestures["afterUndoDel"],
            "afterUndoSelect": gestures["afterUndoSel"],
        },
        "syncTelemetry": gestures["syncTelemetry"],
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
    ap.add_argument("--exe", required=True, help="Packaged portable single-file EXE to benchmark")
    ap.add_argument("--label", required=True)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--out-json", required=True)
    args = ap.parse_args()

    exe_path = os.path.abspath(args.exe)
    exe_sha = sha256_file(exe_path)
    tmp_root = tempfile.mkdtemp(prefix="splat-bench-002-")
    print(f"[{args.label}] Extracting assets from packaged EXE: {exe_path} (SHA256={exe_sha[:16]}...)", flush=True)
    editor_dir, engine_dir, manifest = extract_packaged_exe_assets(exe_path, tmp_root)
    worker_js = os.path.join(editor_dir, "worker.mjs")
    bin_map = {}

    server = ThreadedHTTPServer(("127.0.0.1", 0), make_handler(editor_dir, bin_map))
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    report = {
        "schema": "splat-bench-002-v1",
        "label": args.label,
        "exePath": exe_path,
        "exeSha256": exe_sha,
        "exeSizeBytes": os.path.getsize(exe_path),
        "manifestVersion": manifest.get("version"),
        "manifestAssetsHash": manifest.get("assetsHash"),
        "manifestFileCount": manifest.get("fileCount"),
        "shDegree": "SH0 (DC linear RGBA8, SGC3, 100% full points, zero downsampling)",
        "window": "1520x900 dpr=1",
        "orbitTrajectory": "4 warmup (@0.045 rad) + 30 measured frames (@0.055 rad/frame, fixed elevation)",
        "samplingMode": "full (100% points; splat sorted + centers unsorted)",
        "cachePolicy": "Run 1 = cold fresh Chromium user-data-dir + fresh SGC3 decode; Runs 2..N = warm reused Chromium shader cache + warm OS page cache decode",
        "environment": query_env_meta(),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "scenes": {},
    }

    try:
        for sc in SCENES:
            sog_path = os.path.join(REAL_DIR, sc["file"])
            sog_sha = sha256_file(sog_path)
            sc_runs = []
            warm_user_dir = os.path.join(tmp_root, f"chrome-warm-{sc['id']}")
            os.makedirs(warm_user_dir, exist_ok=True)
            print(f"\n=== [{args.label}] Scene: {sc['file']} ({sc['expected_pts']:,} pts), {args.runs} runs ===", flush=True)
            for r in range(1, args.runs + 1):
                is_cold = (r == 1)
                cache_cond = "cold" if is_cold else "warm"
                run_user_dir = tempfile.mkdtemp(prefix=f"splat-cold-{sc['id']}-") if is_cold else warm_user_dir
                out_bin = os.path.join(tmp_root, f"{sc['id']}_run{r}.sgc3.bin")
                dec_s = decode_sog_to_sgc3(worker_js, engine_dir, sog_path, out_bin)
                bin_url = f"/{sc['id']}_run{r}.bin"
                bin_map[bin_url] = out_bin
                try:
                    res = await bench_run(port, bin_url, sc["expected_pts"], dec_s, r, cache_cond, run_user_dir)
                finally:
                    try:
                        os.remove(out_bin)
                    except OSError:
                        pass
                    if is_cold:
                        shutil.rmtree(run_user_dir, ignore_errors=True)
                sc_runs.append(res)
                print(
                    f"  Run {r} ({cache_cond}): firstEdit={res['firstEditableSec']}s (dec={res['decodeSec']}s+mnt={res['mountSec']}s) | "
                    f"SPLAT P50={res['fullSplat']['p50Ms']} P95={res['fullSplat']['p95Ms']} P99={res['fullSplat']['p99Ms']}ms | "
                    f"CTR P50={res['centersMode']['p50Ms']} P95={res['centersMode']['p95Ms']}ms | "
                    f"box={res['boxSelectMs']}ms del={res['softDeleteMs']}ms undoDel={res['undoDeleteMs']}ms undoSel={res['undoSelectMs']}ms | "
                    f"VRAM {res['vramIdleMiB']}->{res['vramPeakMiB']}(+{res['vramDeltaPeakMiB']})->{res['vramAfterExitMiB']}MiB | "
                    f"RSS={res['chromeRssPeakMiB']}MiB | errs={res['consoleErrors']}",
                    flush=True
                )
            report["scenes"][sc["id"]] = {
                "file": sc["file"],
                "sha256": sog_sha,
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
