using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

sealed class BeginnerTipEntry {
    internal string Title, Tag, Summary, UpEffect, DownEffect, Recommend;
}

static class BeginnerTips {
    static readonly Dictionary<string, BeginnerTipEntry> Zh = new Dictionary<string, BeginnerTipEntry> {
        { "mode", new BeginnerTipEntry {
            Title = "处理模式：批量独立 vs 合并", Tag = "工作流",
            Summary = "决定拖入多个文件时，是逐个分别转换，还是拼成一个大场景。",
            UpEffect = "批量独立转换：拖入 10 个文件，自动按原名分别输出 10 个文件。",
            DownEffect = "合并为一个：把多个局部扫描叠加合并成单个场景文件。",
            Recommend = "批量转格式请选「批量独立转换」。" } },
        { "format", new BeginnerTipEntry {
            Title = "导出格式", Tag = "核心设置",
            Summary = "决定输出文件能在什么软件/网页中打开，以及最终文件体积。",
            UpEffect = "SOG / HTML 压缩率最高（可缩小 10–20 倍）；SPZ 适合跨平台轻量存储。",
            DownEffect = "标准 PLY 体积最大但通用性最强，适合导入编辑器继续精修。",
            Recommend = "网页发布选 SOG，发给客户直接看选 HTML，继续编辑选 PLY。" } },
        { "preset", new BeginnerTipEntry {
            Title = "小白一键预设", Tag = "快速上手",
            Summary = "一键配好保留点数、球谐迭代与打包强度，无需手动猜参数。",
            UpEffect = "极致瘦身：优先最小体积；高质归档：优先保留细节与视角反光。",
            DownEffect = "网页均衡：在体积、画质和耗时之间取得最佳平衡。",
            Recommend = "第一次使用直接点「网页均衡」。" } },
        { "keep", new BeginnerTipEntry {
            Title = "保留点数比例（抽稀减面）", Tag = "瘦身核心",
            Summary = "通过合并冗余高斯点缩小场景规模，让手机和网页也能流畅加载。",
            UpEffect = "100% 完整保留所有点，画质最原汁原味，但文件和显存占用大。",
            DownEffect = "调低（如 50%–75%）可大幅瘦身提速；勾选自适应抽稀能更好保住主体细节和天空。",
            Recommend = "超过 200 万点的场景建议降到 50%–75% 并开启自适应抽稀。" } },
        { "adaptive", new BeginnerTipEntry {
            Title = "自适应抽稀（--decimate-adaptive）", Tag = "3.12 新增",
            Summary = "按局部视觉误差决定删点位置，而不是全图一刀切均匀删点。",
            UpEffect = "开启后对天空、大墙面与精细主体共存的场景画质明显更好。",
            DownEffect = "关闭（均匀抽稀）内存占用略低、速度稍快。",
            Recommend = "需要减面时建议保持开启。" } },
        { "iterations", new BeginnerTipEntry {
            Title = "球谐压缩迭代（SH Iterations）", Tag = "SOG 专属",
            Summary = "控制表面反光与视角变色细节的聚类压缩精度。",
            UpEffect = "调高（如 15–30）反光过渡更细腻，但压缩耗时明显增加。",
            DownEffect = "调低（如 5–10）转换更快，适合快速预览。",
            Recommend = "日常保持默认 10，正式成品可调到 15–20。" } },
        { "effort", new BeginnerTipEntry {
            Title = "WebP 打包强度（Effort 0–9）", Tag = "SOG 专属",
            Summary = "SOG 内部采用无损 WebP 纹理存数据，此项决定压缩压榨程度。",
            UpEffect = "数值越高（最高 9）文件越小，画质完全无损，但 CPU 打包更慢。",
            DownEffect = "默认或较低值打包很快，文件只略大一点点。",
            Recommend = "日常保持默认，上线发布前可调至 6–8。" } },
        { "workers", new BeginnerTipEntry {
            Title = "编码线程数（Max Workers）", Tag = "性能",
            Summary = "同时调用多少个 CPU 线程执行纹理压缩与编码。",
            UpEffect = "调大可缩短打包时间，但 CPU 和内存占用会同步升高。",
            DownEffect = "调小（或 0 串行）更省内存、电脑不易卡顿。",
            Recommend = "默认 4 较稳妥；32G 以上内存可调到 6–8。" } },
        { "voxel", new BeginnerTipEntry {
            Title = "体素分辨率（Voxel Size）", Tag = "Voxel 专属",
            Summary = "导出碰撞体素时，每个小方块的边长（单位：米）。",
            UpEffect = "数值越大（如 0.1–0.2）网格越粗、体积小、速度快。",
            DownEffect = "数值越小（如 0.03–0.05）贴合家具墙面更精细，但更耗显存。",
            Recommend = "室内漫游用 0.05，室外大场景用 0.1。" } },
        { "opacity", new BeginnerTipEntry {
            Title = "体素透明度阈值", Tag = "Voxel 专属",
            Summary = "决定多实心的点云才会被算作碰撞障碍物。",
            UpEffect = "调高可滤掉空气薄雾，避免角色撞上空气墙。",
            DownEffect = "调低会保留更多细小半透明结构。",
            Recommend = "默认 0.1 适合绝大多数场景。" } },
        { "device", new BeginnerTipEntry {
            Title = "计算设备与后端（含 Vulkan 切换）", Tag = "Windows 关键",
            Summary = "SOG 压缩、去飞点和体素生成默认调用显卡加速（比 CPU 快 5–10 倍）。",
            UpEffect = "强制 Vulkan：官方推荐用于绕过 Windows 下 D3D12 驱动偶发崩溃或异常。",
            DownEffect = "纯 CPU：最稳妥的兜底方式，不吃显存但速度慢 5–10 倍。",
            Recommend = "优先选自动显卡；若显卡报错一键切「强制 Vulkan」。" } },
        { "floaters", new BeginnerTipEntry {
            Title = "一键去除空中飞点（--filter-floaters）", Tag = "3.12 新增",
            Summary = "利用 GPU 体素化检测，自动清除漂浮在空中的零散噪点、雾团和伪影。",
            UpEffect = "开启后画面干净很多，并能顺带减小输出文件体积。",
            DownEffect = "关闭则原样保留所有点，速度略快。",
            Recommend = "手机或无人机重建的场景强烈建议开启。" } },
        { "nan", new BeginnerTipEntry {
            Title = "自动清理无效点（NaN / Inf）", Tag = "数据清洗",
            Summary = "剔除坐标损坏、无穷大或旋转异常的坏点，避免导入后黑块或闪烁。",
            UpEffect = "几乎零画质损失且提升后续渲染稳定性。",
            DownEffect = "关闭则不做坏点检查。",
            Recommend = "建议常开。" } },
        { "sh", new BeginnerTipEntry {
            Title = "球谐阶数限制（SH Bands）", Tag = "体积优化",
            Summary = "控制随视角变化的光泽反光数据；高阶 SH 通常占文件一半以上体积。",
            UpEffect = "3 阶保留完整反光细节，但文件最大。",
            DownEffect = "降到 0 阶（仅基础色）或 1 阶，文件直接减半，观感依然自然。",
            Recommend = "网页端展示强烈推荐限制为 1 阶或 0 阶。" } },
        { "engine", new BeginnerTipEntry {
            Title = "引擎独立更新（国内直连多镜像）", Tag = "离线兜底+在线拉取",
            Summary = "引擎与主程序解耦存放，内置 v3.12.0 断网可用，联网可一键拉取新版。",
            UpEffect = "自动按阿里云 / 腾讯云 / 华为云 / 官方源顺序测速拉取，并做 SHA-512 校验。",
            DownEffect = "若新版不兼容，随时可一键回滚到内置版本。",
            Recommend = "点击此徽章即可检测新版或切换国内镜像源。" } }
    };

    internal static BeginnerTipEntry Get(string key) {
        BeginnerTipEntry e;
        return key != null && Zh.TryGetValue(key, out e) ? e : null;
    }
}

sealed class BeginnerTipPopup : Form {
    BeginnerTipEntry current;
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08000000 | 0x00000008 | 0x00000080; // WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TOOLWINDOW
            return cp;
        }
    }

    internal BeginnerTipPopup() {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        DoubleBuffered = true;
        Size = new Size(340, 178);
    }

    internal void ShowFor(string key, Control anchor) {
        var entry = BeginnerTips.Get(key);
        if (entry == null || anchor == null || !anchor.IsHandleCreated) { Hide(); return; }
        current = entry;
        Size = MeasureSize(entry);
        var pt = anchor.PointToScreen(new Point(0, anchor.Height + 6));
        var area = Screen.FromControl(anchor).WorkingArea;
        int x = Math.Max(area.Left + 8, Math.Min(area.Right - Width - 8, pt.X));
        int y = (pt.Y + Height > area.Bottom - 8) ? Math.Max(area.Top + 8, anchor.PointToScreen(Point.Empty).Y - Height - 6) : pt.Y;
        Location = new Point(x, y);
        if (!Visible) Show();
        Invalidate();
    }

    Size MeasureSize(BeginnerTipEntry e) {
        int w = 344;
        int inner = w - 28;
        using (var g = CreateGraphics())
        using (var fBody = new Font("Microsoft YaHei UI", 8.5f)) {
            int h1 = TextRenderer.MeasureText(g, e.Summary, fBody, new Size(inner, 999), TextFormatFlags.WordBreak).Height;
            int h2 = TextRenderer.MeasureText(g, "调大/开启：" + e.UpEffect, fBody, new Size(inner - 14, 999), TextFormatFlags.WordBreak).Height;
            int h3 = TextRenderer.MeasureText(g, "调小/关闭：" + e.DownEffect, fBody, new Size(inner - 14, 999), TextFormatFlags.WordBreak).Height;
            int h4 = TextRenderer.MeasureText(g, "新手建议：" + e.Recommend, fBody, new Size(inner, 999), TextFormatFlags.WordBreak).Height;
            return new Size(w, 42 + h1 + 14 + h2 + h3 + 16 + h4 + 18);
        }
    }

    protected override void OnPaint(PaintEventArgs e) {
        if (current == null) return;
        var p = Theme.Current;
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = Theme.RoundedRect(rect, 10))
        using (var bg = new SolidBrush(p.CardBg))
        using (var border = new Pen(p.BorderStrong, 1f)) {
            g.FillPath(bg, path);
            g.DrawPath(border, path);
        }
        int pad = 14, inner = Width - pad * 2, y = 12;
        using (var fTitle = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold))
        using (var fTag = new Font("Microsoft YaHei UI", 7.5f, FontStyle.Bold))
        using (var fBody = new Font("Microsoft YaHei UI", 8.5f)) {
            TextRenderer.DrawText(g, current.Title, fTitle, new Rectangle(pad, y, inner - 72, 22), p.Ink, TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
            var tagSize = TextRenderer.MeasureText(g, current.Tag, fTag);
            var tagRect = new Rectangle(Width - pad - tagSize.Width - 10, y, tagSize.Width + 10, 19);
            using (var tp = Theme.RoundedRect(tagRect, 5))
            using (var tb = new SolidBrush(p.AccentSoft))
                g.FillPath(tb, tp);
            TextRenderer.DrawText(g, current.Tag, fTag, tagRect, p.Accent, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            y += 26;

            int h1 = TextRenderer.MeasureText(g, current.Summary, fBody, new Size(inner, 999), TextFormatFlags.WordBreak).Height;
            TextRenderer.DrawText(g, current.Summary, fBody, new Rectangle(pad, y, inner, h1 + 4), p.Text2, TextFormatFlags.WordBreak);
            y += h1 + 8;

            string up = "调大/开启：" + current.UpEffect;
            string dn = "调小/关闭：" + current.DownEffect;
            int h2 = TextRenderer.MeasureText(g, up, fBody, new Size(inner - 14, 999), TextFormatFlags.WordBreak).Height;
            int h3 = TextRenderer.MeasureText(g, dn, fBody, new Size(inner - 14, 999), TextFormatFlags.WordBreak).Height;
            var box = new Rectangle(pad, y, inner, h2 + h3 + 16);
            using (var bp = Theme.RoundedRect(box, 6))
            using (var bb = new SolidBrush(p.SubCardBg))
                g.FillPath(bb, bp);
            TextRenderer.DrawText(g, up, fBody, new Rectangle(pad + 7, y + 6, inner - 14, h2 + 2), p.Text2, TextFormatFlags.WordBreak);
            TextRenderer.DrawText(g, dn, fBody, new Rectangle(pad + 7, y + 10 + h2, inner - 14, h3 + 2), p.Text2, TextFormatFlags.WordBreak);
            y = box.Bottom + 8;

            TextRenderer.DrawText(g, "新手建议：" + current.Recommend, fBody, new Rectangle(pad, y, inner, Height - y - 8), p.Accent, TextFormatFlags.WordBreak);
        }
    }
}

sealed class TelemetryChartPopup : Form {
    string metricKey = "cpu";
    TelemetrySnapshot snapshot;
    ResourceSnapshot latestResources;

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08000000 | 0x00000008 | 0x00000080;
            return cp;
        }
    }

    internal TelemetryChartPopup() {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        DoubleBuffered = true;
        Size = new Size(460, 276);
    }

    internal void UpdateData(string metric, TelemetrySnapshot snap, ResourceSnapshot latest, Control anchor) {
        metricKey = metric;
        snapshot = snap;
        latestResources = latest;
        if (anchor != null && anchor.IsHandleCreated) {
            var pt = anchor.PointToScreen(Point.Empty);
            var area = Screen.FromControl(anchor).WorkingArea;
            int x = Math.Max(area.Left + 8, Math.Min(area.Right - Width - 8, pt.X + anchor.Width / 2 - Width / 2));
            int y = Math.Max(area.Top + 8, pt.Y - Height - 8);
            Location = new Point(x, y);
        }
        if (!Visible) Show();
        Invalidate();
    }

    internal void RefreshIfVisible(TelemetrySnapshot snap, ResourceSnapshot latest) {
        snapshot = snap;
        latestResources = latest;
        if (Visible) Invalidate();
    }

    double ReadPct(TelemetrySample s) {
        if (metricKey == "cpu") return s.CpuPct;
        if (metricKey == "ram") return s.RamPct;
        if (metricKey == "gpu") return s.GpuPct;
        return s.VramPct;
    }

    string FormatVal(TelemetrySample s) {
        if (metricKey == "cpu") return s.CpuPct.ToString("0") + "%";
        if (metricKey == "ram") return s.RamUsedGiB.ToString("0.0", CultureInfo.InvariantCulture) + " GiB (" + s.RamPct.ToString("0") + "%)";
        if (metricKey == "gpu") return s.GpuPct.ToString("0") + "%";
        return s.VramUsedGiB.ToString("0.0", CultureInfo.InvariantCulture) + " GiB (" + s.VramPct.ToString("0") + "%)";
    }

    protected override void OnPaint(PaintEventArgs e) {
        var p = Theme.Current;
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        var outer = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = Theme.RoundedRect(outer, 12))
        using (var bg = new SolidBrush(p.CardBg))
        using (var border = new Pen(p.BorderStrong, 1f)) {
            g.FillPath(bg, path);
            g.DrawPath(border, path);
        }

        string title = metricKey == "cpu" ? "CPU 占用历史曲线" : metricKey == "ram" ? "系统内存占用历史曲线" : metricKey == "gpu" ? "GPU 计算引擎历史曲线" : "专用显存（VRAM）历史曲线";
        string hwDetail = "";
        if (latestResources != null) {
            if (metricKey == "cpu") hwDetail = latestResources.CpuName;
            else if (metricKey == "ram") hwDetail = Budget.GB(latestResources.TotalMemory) + " · 可用 " + Budget.GB(latestResources.AvailableMemory);
            else {
                var gpu = latestResources.Gpus.OrderByDescending(x => x.Usage ?? -1).FirstOrDefault();
                if (gpu != null) hwDetail = gpu.Name;
            }
        }
        string modeHint = snapshot != null && snapshot.Mode == TelemetryMode.Recording ? "0.5s 采样 · X轴自适应拉伸（完整保留空闲+压缩）"
            : snapshot != null && snapshot.Mode == TelemetryMode.FrozenRun ? "上次压缩完整曲线已锁定 · 下次压缩开始时刷新"
            : "0.5s 高频采样 · 最近 60 秒";

        using (var fTitle = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold))
        using (var fSub = new Font("Microsoft YaHei UI", 7.8f))
        using (var fBold = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold)) {
            TextRenderer.DrawText(g, title, fTitle, new Rectangle(14, 10, 260, 20), p.Ink, TextFormatFlags.Left);
            TextRenderer.DrawText(g, (String.IsNullOrWhiteSpace(hwDetail) ? "" : hwDetail + " · ") + modeHint, fSub, new Rectangle(14, 30, Width - 28, 18), p.Muted, TextFormatFlags.Left | TextFormatFlags.EndEllipsis);

            // Legend
            using (var penIdle = new Pen(p.ChartIdle, 2.2f))
            using (var penAct = new Pen(p.ChartActive, 2.2f)) {
                g.DrawLine(penIdle, Width - 138, 20, Width - 124, 20);
                TextRenderer.DrawText(g, I18n.T("chartIdle"), fSub, new Rectangle(Width - 122, 12, 48, 16), p.Text2);
                g.DrawLine(penAct, Width - 72, 20, Width - 58, 20);
                TextRenderer.DrawText(g, I18n.T("chartActive"), fSub, new Rectangle(Width - 56, 12, 48, 16), p.Text2);
            }

            // Chart Box
            var chartBox = new Rectangle(14, 52, Width - 28, 146);
            using (var cp = Theme.RoundedRect(chartBox, 8))
            using (var cb = new SolidBrush(p.SubCardBg))
            using (var cpen = new Pen(p.Border, 1f)) {
                g.FillPath(cb, cp);
                g.DrawPath(cpen, cp);
            }

            int padL = chartBox.Left + 34, padR = chartBox.Right - 10, padT = chartBox.Top + 14, padB = chartBox.Bottom - 20;
            int cw = Math.Max(10, padR - padL), ch = Math.Max(10, padB - padT);

            using (var gridPen = new Pen(p.ChartGrid, 1f)) {
                foreach (int pct in new[] { 0, 50, 100 }) {
                    float gy = padT + ch * (1f - pct / 100f);
                    g.DrawLine(gridPen, padL, gy, padR, gy);
                    TextRenderer.DrawText(g, pct + "%", fSub, new Rectangle(chartBox.Left + 2, (int)gy - 7, 32, 14), p.Muted, TextFormatFlags.Right);
                }
            }

            var pts = snapshot != null && snapshot.Points != null ? snapshot.Points : new TelemetrySample[0];
            if (pts.Length >= 2) {
                int startIdx = snapshot.StartIndex;
                var coords = new PointF[pts.Length];
                for (int i = 0; i < pts.Length; i++) {
                    float x = padL + (i / (float)(pts.Length - 1)) * cw;
                    float y = padT + ch * (1f - (float)(ReadPct(pts[i]) / 100d));
                    coords[i] = new PointF(x, y);
                }

                // Draw segment-by-segment: strictly BEFORE startIdx = Idle Blue; strictly AT/AFTER startIdx = Active Orange!
                // Because startIdx is the exact anchor point where compression started, the orange ramp begins EXACTLY on the dashed line!
                using (var idlePen = new Pen(p.ChartIdle, 2.0f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                using (var actPen = new Pen(p.ChartActive, 2.3f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                using (var idleFill = new SolidBrush(Color.FromArgb(30, p.ChartIdle)))
                using (var actFill = new SolidBrush(Color.FromArgb(42, p.ChartActive))) {
                    for (int i = 1; i < coords.Length; i++) {
                        bool isAct = startIdx >= 0 && (i - 1) >= startIdx;
                        var poly = new[] { coords[i - 1], coords[i], new PointF(coords[i].X, padB), new PointF(coords[i - 1].X, padB) };
                        g.FillPolygon(isAct ? actFill : idleFill, poly);
                        g.DrawLine(isAct ? actPen : idlePen, coords[i - 1], coords[i]);
                    }
                }

                // Exact Vertical Dashed Marker at StartIndex
                if (startIdx >= 0 && startIdx < coords.Length) {
                    float mx = coords[startIdx].X;
                    using (var dashPen = new Pen(p.ChartActive, 1.3f) { DashStyle = DashStyle.Dash })
                        g.DrawLine(dashPen, mx, padT, mx, padB);
                    int labelX = (int)Math.Min(padR - 56, mx + 4);
                    TextRenderer.DrawText(g, I18n.T("chartStartMark"), fSub, new Rectangle(labelX, padT - 2, 62, 16), p.ChartActive);
                }

                // Time span labels along X-axis
                double totalSec = Math.Max(0.5, (pts[pts.Length - 1].Timestamp - pts[0].Timestamp).TotalSeconds);
                TextRenderer.DrawText(g, "0s", fSub, new Rectangle(padL, padB + 2, 40, 15), p.Muted, TextFormatFlags.Left);
                TextRenderer.DrawText(g, totalSec.ToString("0.0", CultureInfo.InvariantCulture) + "s", fSub, new Rectangle(padR - 54, padB + 2, 54, 15), p.Muted, TextFormatFlags.Right);

                // Latest dot
                var lastPt = coords[coords.Length - 1];
                bool lastAct = startIdx >= 0 && (coords.Length - 1) > startIdx;
                using (var dot = new SolidBrush(lastAct ? p.ChartActive : p.ChartIdle))
                    g.FillEllipse(dot, lastPt.X - 3.5f, lastPt.Y - 3.5f, 7f, 7f);
            }

            // Bottom 3 Stat Cards
            int cardY = 208, cardW = (Width - 28 - 16) / 3, cardH = 54;
            string curText = pts.Length > 0 ? FormatVal(pts[pts.Length - 1]) : "--";
            string peakText = "--";
            string idleAvgText = "--";
            if (pts.Length > 0) {
                int sIdx = snapshot.StartIndex;
                var actList = sIdx >= 0 ? pts.Skip(sIdx + 1).ToArray() : new TelemetrySample[0];
                if (actList.Length > 0) {
                    var peakSample = actList.OrderByDescending(ReadPct).First();
                    peakText = FormatVal(peakSample);
                }
                var idleList = sIdx >= 0 ? pts.Take(sIdx + 1).ToArray() : pts;
                if (idleList.Length > 0) {
                    double avg = idleList.Average(ReadPct);
                    idleAvgText = avg.ToString("0") + "%";
                }
            }
            DrawStatCard(g, new Rectangle(14, cardY, cardW, cardH), I18n.T("chartCurrent"), curText, p.Ink, fSub, fBold);
            DrawStatCard(g, new Rectangle(14 + cardW + 8, cardY, cardW, cardH), I18n.T("chartPeak"), peakText, p.ChartActive, fSub, fBold);
            DrawStatCard(g, new Rectangle(14 + (cardW + 8) * 2, cardY, cardW, cardH), I18n.T("chartIdleAvg"), idleAvgText, p.ChartIdle, fSub, fBold);
        }
    }

    void DrawStatCard(Graphics g, Rectangle rect, string label, string val, Color valColor, Font fSub, Font fBold) {
        var p = Theme.Current;
        using (var path = Theme.RoundedRect(rect, 7))
        using (var bg = new SolidBrush(p.SubCardBg))
        using (var pen = new Pen(p.Border, 1f)) {
            g.FillPath(bg, path);
            g.DrawPath(pen, path);
        }
        TextRenderer.DrawText(g, label, fSub, new Rectangle(rect.X + 4, rect.Y + 6, rect.Width - 8, 16), p.Muted, TextFormatFlags.HorizontalCenter);
        TextRenderer.DrawText(g, val, fBold, new Rectangle(rect.X + 4, rect.Y + 25, rect.Width - 8, 22), valColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.EndEllipsis);
    }
}

sealed class EngineUpdateDialog : Form {
    readonly Label currentLabel = new Label { AutoSize = true };
    readonly Label statusLabel = new Label { AutoSize = false, Height = 44 };
    readonly ComboBox mirrorBox = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 360 };
    readonly TextBox logBox = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill };
    readonly Button btnCheck = new Button { Width = 120, Height = 34 };
    readonly Button btnPull = new Button { Width = 130, Height = 34, Enabled = false };
    readonly Button btnRollback = new Button { Width = 125, Height = 34 };
    readonly Action onVersionChanged;
    EngineCheckResult lastCheck;
    CancellationTokenSource cts;

    internal EngineUpdateDialog(Form owner, Action onChanged) {
        onVersionChanged = onChanged;
        var p = Theme.Current;
        Text = I18n.T("engineUpdate");
        Font = owner.Font;
        BackColor = p.WindowBg;
        ForeColor = p.Ink;
        ClientSize = new Size(560, 400);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = MaximizeBox = false;
        Padding = new Padding(16);

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5 };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));

        RefreshHeader();
        root.Controls.Add(currentLabel, 0, 0);

        var mirrorRow = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        mirrorRow.Controls.Add(new Label { Text = I18n.T("engineMirrors") + ":", AutoSize = true, Margin = new Padding(0, 8, 8, 0), ForeColor = p.Text2 });
        foreach (var m in EngineManager.Mirrors) mirrorBox.Items.Add(m.Name);
        mirrorBox.SelectedIndex = 0;
        mirrorBox.BackColor = p.InputBg; mirrorBox.ForeColor = p.Ink;
        mirrorRow.Controls.Add(mirrorBox);
        root.Controls.Add(mirrorRow, 0, 1);

        statusLabel.Dock = DockStyle.Fill;
        statusLabel.ForeColor = p.Accent;
        statusLabel.Text = "引擎已剥离至 LocalAppData，支持国内镜像直连拉取新版 @playcanvas/splat-transform。";
        root.Controls.Add(statusLabel, 0, 2);

        logBox.BackColor = p.LogBg; logBox.ForeColor = p.Text2; logBox.BorderStyle = BorderStyle.FixedSingle;
        logBox.Font = new Font("Consolas", 8.5f);
        root.Controls.Add(logBox, 0, 3);

        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 8, 0, 0) };
        StyleBtn(btnPull, I18n.T("enginePull"), true);
        StyleBtn(btnCheck, I18n.T("engineLatest"), false);
        StyleBtn(btnRollback, I18n.T("engineRollback"), false);
        actions.Controls.Add(btnPull);
        actions.Controls.Add(btnCheck);
        actions.Controls.Add(btnRollback);
        root.Controls.Add(actions, 0, 4);

        Controls.Add(root);

        btnCheck.Click += (s, e) => DoCheck();
        btnPull.Click += (s, e) => DoPull();
        btnRollback.Click += (s, e) => DoRollback();
        HandleCreated += (s, e) => Theme.ApplyWindowChrome(this);
        FormClosing += (s, e) => { if (cts != null) cts.Cancel(); };
    }

    void StyleBtn(Button b, string text, bool primary) {
        var p = Theme.Current;
        b.Text = text;
        b.FlatStyle = FlatStyle.Flat;
        b.BackColor = primary ? p.Accent : p.CardBg;
        b.ForeColor = primary ? p.AccentText : p.Ink;
        b.FlatAppearance.BorderColor = primary ? p.Accent : p.BorderStrong;
    }

    void RefreshHeader() {
        currentLabel.Text = "当前运行引擎：v" + EngineManager.ActiveVersion + (EngineManager.IsUsingBundled ? "（内置兜底版）" : "（在线更新版）")
            + "   ·   内置版本：v" + EngineManager.BundledVersion;
    }

    void Append(string msg) {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(new Action(() => Append(msg))); return; }
        logBox.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + msg + "\r\n");
    }

    async void DoCheck() {
        btnCheck.Enabled = btnPull.Enabled = btnRollback.Enabled = false;
        statusLabel.Text = "正在测速并检查国内镜像最新版本...";
        string prefId = EngineManager.Mirrors[Math.Max(0, mirrorBox.SelectedIndex)].Id;
        Append("开始连接镜像源（优先：" + prefId + "）...");
        try {
            var res = await Task.Run(() => EngineManager.CheckBestMirror(prefId));
            lastCheck = res;
            if (!res.Success) {
                statusLabel.Text = "检查失败：" + res.Error;
                Append("错误：" + res.Error);
            } else {
                Append("命中镜像：" + res.MirrorName + "（" + res.LatencyMs + " ms），最新版本：v" + res.LatestVersion);
                statusLabel.Text = "检测到最新版本：v" + res.LatestVersion + "（来自 " + res.MirrorName + "，" + res.LatencyMs + " ms）";
                btnPull.Enabled = true;
            }
        } finally {
            btnCheck.Enabled = btnRollback.Enabled = true;
        }
    }

    async void DoPull() {
        if (lastCheck == null || !lastCheck.Success) return;
        btnCheck.Enabled = btnPull.Enabled = btnRollback.Enabled = false;
        cts = new CancellationTokenSource();
        statusLabel.Text = "正在拉取并校验 v" + lastCheck.LatestVersion + " ...";
        try {
            string ver = await Task.Run(() => EngineManager.PullUpdate(lastCheck, cts.Token, Append));
            RefreshHeader();
            statusLabel.Text = "更新成功！已切换至引擎 v" + ver + "。";
            if (onVersionChanged != null) onVersionChanged();
        } catch (Exception ex) {
            statusLabel.Text = "更新失败（已保持原引擎不受影响）：" + ex.Message;
            Append("更新失败：" + ex.Message);
        } finally {
            cts.Dispose(); cts = null;
            btnCheck.Enabled = btnRollback.Enabled = true;
        }
    }

    async void DoRollback() {
        btnCheck.Enabled = btnPull.Enabled = btnRollback.Enabled = false;
        cts = new CancellationTokenSource();
        try {
            await Task.Run(() => EngineManager.RollbackToBundled(cts.Token));
            RefreshHeader();
            statusLabel.Text = "已恢复至内置引擎 v" + EngineManager.BundledVersion + "。";
            Append("已回滚至内置兜底版 v" + EngineManager.BundledVersion);
            if (onVersionChanged != null) onVersionChanged();
        } catch (Exception ex) {
            statusLabel.Text = "恢复失败：" + ex.Message;
        } finally {
            cts.Dispose(); cts = null;
            btnCheck.Enabled = btnRollback.Enabled = true;
        }
    }
}
