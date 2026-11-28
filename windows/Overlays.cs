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
    internal static string KeyForStepFlag(string flag) {
        if (flag == "--filter-nan") return "nan";
        if (flag == "--filter-floaters") return "floaters";
        if (flag == "--filter-cluster") return "cluster";
        if (flag == "--filter-harmonics") return "sh";
        if (flag == "--translate") return "translate";
        if (flag == "--rotate") return "rotate";
        if (flag == "--scale") return "scale";
        if (flag == "--filter-box") return "box";
        if (flag == "--filter-sphere") return "sphere";
        return null;
    }

    static readonly HashSet<string> KnownKeys = new HashSet<string>(StringComparer.Ordinal) {
        "mode", "format", "preset", "keep", "adaptive", "iterations", "effort", "workers",
        "voxel", "opacity", "device", "floaters", "cluster", "nan", "sh", "translate",
        "rotate", "scale", "box", "sphere", "estOutput", "engine", "preview3d",
        "advTargetCap", "advMinKeep", "advSogVer", "advShErr", "advSpzVer", "advPlyLogit",
        "advHtmlUnbundled", "advVoxelFlags", "advTipDelay", "advHistoryLimit", "advVeteranTips",
        "inspectDeep", "jobsResume"
    };

    internal static BeginnerTipEntry Get(string key) {
        if (String.IsNullOrEmpty(key) || !KnownKeys.Contains(key)) return null;
        string prefix = "app.tips." + key + ".";
        return new BeginnerTipEntry {
            Title = I18n.T(prefix + "title"),
            Tag = I18n.T(prefix + "tag"),
            Summary = I18n.T(prefix + "summary"),
            UpEffect = I18n.T(prefix + "up"),
            DownEffect = I18n.T(prefix + "down"),
            Recommend = I18n.T(prefix + "recommend")
        };
    }
}

// Unified Global Delayed Tooltip Controller & Per-Region Veteran Switches (persisted in data/config/settings.json)
static class TooltipConfig {
    public const int DefaultHoverDelayMs = 500;
    public static int HoverDelayMs = DefaultHoverDelayMs;
    public static int EditorMaxHistorySteps = 50;

    public static bool ShowInputTips = true;
    public static bool ShowPipelineTips = true;
    public static bool ShowOutputTips = true;
    public static bool ShowExternalDialogTips = true;
    public static bool ShowEditorToolbarTips = true;
    public static bool ShowEditorSceneTips = true;
    public static bool ShowEditorColorTips = true;
    public static bool ShowEditorModalTips = true;

    internal static void Load() {
        var s = PortablePaths.LoadSettings();
        HoverDelayMs = Math.Max(150, Math.Min(5000, s.TooltipHoverDelayMs > 0 ? s.TooltipHoverDelayMs : DefaultHoverDelayMs));
        EditorMaxHistorySteps = Math.Max(10, Math.Min(300, s.EditorMaxHistorySteps > 0 ? s.EditorMaxHistorySteps : 50));
        ShowInputTips = s.TipRegionInput;
        ShowPipelineTips = s.TipRegionPipeline;
        ShowOutputTips = s.TipRegionOutput;
        ShowExternalDialogTips = s.TipRegionDialog;
        ShowEditorToolbarTips = s.TipRegionEditorToolbar;
        ShowEditorSceneTips = s.TipRegionEditorScene;
        ShowEditorColorTips = s.TipRegionEditorColor;
        ShowEditorModalTips = s.TipRegionEditorModal;
    }

    internal static void Save() {
        PortablePaths.SaveSettings(s => {
            s.TooltipHoverDelayMs = HoverDelayMs;
            s.EditorMaxHistorySteps = EditorMaxHistorySteps;
            s.TipRegionInput = ShowInputTips;
            s.TipRegionPipeline = ShowPipelineTips;
            s.TipRegionOutput = ShowOutputTips;
            s.TipRegionDialog = ShowExternalDialogTips;
            s.TipRegionEditorToolbar = ShowEditorToolbarTips;
            s.TipRegionEditorScene = ShowEditorSceneTips;
            s.TipRegionEditorColor = ShowEditorColorTips;
            s.TipRegionEditorModal = ShowEditorModalTips;
        });
    }

    internal static bool IsRegionEnabled(string region) {
        if (region == "input") return ShowInputTips;
        if (region == "pipeline") return ShowPipelineTips;
        if (region == "output") return ShowOutputTips;
        if (region == "dialog") return ShowExternalDialogTips;
        if (region == "editorToolbar") return ShowEditorToolbarTips;
        if (region == "editorScene") return ShowEditorSceneTips;
        if (region == "editorColor") return ShowEditorColorTips;
        if (region == "editorModal") return ShowEditorModalTips;
        return ShowOutputTips;
    }
}

sealed class BeginnerTipPopup : Form {
    BeginnerTipEntry current;
    readonly System.Windows.Forms.Timer delayTimer = new System.Windows.Forms.Timer();
    string pendingKey;
    Control pendingAnchor;
    Rectangle? pendingRect;

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08000000 | 0x00000008 | 0x00000080;
            return cp;
        }
    }

    internal BeginnerTipPopup() {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        DoubleBuffered = true;
        Size = new Size(344, 178);
        delayTimer.Tick += (s, e) => {
            delayTimer.Stop();
            if (IsDisposed || String.IsNullOrEmpty(pendingKey)) return;
            if (pendingRect.HasValue) ShowForRect(pendingKey, pendingRect.Value);
            else if (pendingAnchor != null && !pendingAnchor.IsDisposed && pendingAnchor.IsHandleCreated) ShowFor(pendingKey, pendingAnchor);
        };
    }

    protected override void Dispose(bool disposing) {
        if (disposing) delayTimer.Dispose();
        base.Dispose(disposing);
    }

    internal void ScheduleShowFor(string key, Control anchor, string region = "output") {
        CancelPending();
        if (anchor == null || anchor.IsDisposed || !TooltipConfig.IsRegionEnabled(region)) { Hide(); return; }
        pendingKey = key;
        pendingAnchor = anchor;
        pendingRect = null;
        delayTimer.Interval = Math.Max(150, TooltipConfig.HoverDelayMs);
        delayTimer.Start();
    }

    internal void ScheduleShowForRect(string key, Rectangle rect, string region = "pipeline") {
        CancelPending();
        if (!TooltipConfig.IsRegionEnabled(region)) { Hide(); return; }
        pendingKey = key;
        pendingAnchor = null;
        pendingRect = rect;
        delayTimer.Interval = Math.Max(150, TooltipConfig.HoverDelayMs);
        delayTimer.Start();
    }

    internal void CancelAndHide() {
        CancelPending();
        if (Visible) Hide();
    }

    void CancelPending() {
        delayTimer.Stop();
        pendingKey = null;
        pendingAnchor = null;
        pendingRect = null;
    }

    internal static void Bind(BeginnerTipPopup popup, Control ctrl, string key, string region) {
        if (popup == null || ctrl == null) return;
        ctrl.MouseEnter += (s, e) => popup.ScheduleShowFor(key, ctrl, region);
        ctrl.MouseLeave += (s, e) => popup.CancelAndHide();
        ctrl.MouseDown += (s, e) => popup.CancelAndHide();
        foreach (Control child in ctrl.Controls) Bind(popup, child, key, region);
    }

    internal void ShowFor(string key, Control anchor) {
        if (anchor == null || !anchor.IsHandleCreated) { Hide(); return; }
        var pt = anchor.PointToScreen(Point.Empty);
        ShowForRect(key, new Rectangle(pt.X, pt.Y, anchor.Width, anchor.Height));
    }

    internal void ShowForRect(string key, Rectangle anchorScreenRect) {
        var entry = BeginnerTips.Get(key);
        if (entry == null) { Hide(); return; }
        current = entry;
        BackColor = Theme.Current.CardBg;
        Size = MeasureSize(entry);
        Theme.ApplyRoundedWindowRegion(this, 11);
        Theme.ApplyWindowChrome(this);
        var area = Screen.FromRectangle(anchorScreenRect).WorkingArea;
        int x = Math.Max(area.Left + 8, Math.Min(area.Right - Width - 8, anchorScreenRect.Left));
        int y = (anchorScreenRect.Bottom + 6 + Height > area.Bottom - 8)
            ? Math.Max(area.Top + 8, anchorScreenRect.Top - Height - 6)
            : anchorScreenRect.Bottom + 6;
        Location = new Point(x, y);
        if (!Visible) Show();
        Invalidate();
    }

    string UpPrefix { get { return I18n.T("app.tips.upPrefix"); } }
    string DownPrefix { get { return I18n.T("app.tips.downPrefix"); } }
    string RecPrefix { get { return I18n.T("app.tips.recPrefix"); } }

    Size MeasureSize(BeginnerTipEntry e) {
        int w = 348, inner = w - 28;
        using (var g = CreateGraphics())
        using (var fBody = new Font("Microsoft YaHei UI", 8.5f)) {
            int h1 = TextRenderer.MeasureText(g, e.Summary, fBody, new Size(inner, 999), TextFormatFlags.WordBreak).Height;
            int h2 = TextRenderer.MeasureText(g, UpPrefix + e.UpEffect, fBody, new Size(inner - 14, 999), TextFormatFlags.WordBreak).Height;
            int h3 = TextRenderer.MeasureText(g, DownPrefix + e.DownEffect, fBody, new Size(inner - 14, 999), TextFormatFlags.WordBreak).Height;
            int h4 = TextRenderer.MeasureText(g, RecPrefix + e.Recommend, fBody, new Size(inner, 999), TextFormatFlags.WordBreak).Height;
            return new Size(w, 42 + h1 + 14 + h2 + h3 + 16 + h4 + 18);
        }
    }

    protected override void OnPaint(PaintEventArgs e) {
        if (current == null) return;
        var p = Theme.Current;
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(p.CardBg);
        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = Theme.RoundedRect(rect, 10))
        using (var bg = new SolidBrush(p.CardBg))
        using (var border = new Pen(p.BorderStrong, 1f)) {
            g.FillPath(bg, path); g.DrawPath(border, path);
        }
        int pad = 14, inner = Width - pad * 2, y = 12;
        using (var fTitle = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold))
        using (var fTag = new Font("Microsoft YaHei UI", 7.5f, FontStyle.Bold))
        using (var fBody = new Font("Microsoft YaHei UI", 8.5f)) {
            TextRenderer.DrawText(g, current.Title, fTitle, new Rectangle(pad, y, inner - 76, 22), p.Ink, TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
            var tagSize = TextRenderer.MeasureText(g, current.Tag, fTag);
            var tagRect = new Rectangle(Width - pad - tagSize.Width - 10, y, tagSize.Width + 10, 19);
            using (var tp = Theme.RoundedRect(tagRect, 5))
            using (var tb = new SolidBrush(p.AccentSoft)) g.FillPath(tb, tp);
            TextRenderer.DrawText(g, current.Tag, fTag, tagRect, p.Accent, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            y += 26;

            int h1 = TextRenderer.MeasureText(g, current.Summary, fBody, new Size(inner, 999), TextFormatFlags.WordBreak).Height;
            TextRenderer.DrawText(g, current.Summary, fBody, new Rectangle(pad, y, inner, h1 + 4), p.Text2, TextFormatFlags.WordBreak);
            y += h1 + 8;

            string up = UpPrefix + current.UpEffect;
            string dn = DownPrefix + current.DownEffect;
            int h2 = TextRenderer.MeasureText(g, up, fBody, new Size(inner - 14, 999), TextFormatFlags.WordBreak).Height;
            int h3 = TextRenderer.MeasureText(g, dn, fBody, new Size(inner - 14, 999), TextFormatFlags.WordBreak).Height;
            var box = new Rectangle(pad, y, inner, h2 + h3 + 16);
            using (var bp = Theme.RoundedRect(box, 6))
            using (var bb = new SolidBrush(p.SubCardBg)) g.FillPath(bb, bp);
            TextRenderer.DrawText(g, up, fBody, new Rectangle(pad + 7, y + 6, inner - 14, h2 + 2), p.Text2, TextFormatFlags.WordBreak);
            TextRenderer.DrawText(g, dn, fBody, new Rectangle(pad + 7, y + 10 + h2, inner - 14, h3 + 2), p.Text2, TextFormatFlags.WordBreak);
            y = box.Bottom + 8;

            TextRenderer.DrawText(g, RecPrefix + current.Recommend, fBody, new Rectangle(pad, y, inner, Height - y - 8), p.Accent, TextFormatFlags.WordBreak);
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
        Size = new Size(466, 278);
    }

    internal void UpdateData(string metric, TelemetrySnapshot snap, ResourceSnapshot latest, Control anchor) {
        metricKey = metric; snapshot = snap; latestResources = latest;
        BackColor = Theme.Current.CardBg;
        Theme.ApplyRoundedWindowRegion(this, 13);
        Theme.ApplyWindowChrome(this);
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
        snapshot = snap; latestResources = latest;
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
        if (metricKey == "ram") return s.RamUsedGiB.ToString("0.0", CultureInfo.InvariantCulture) + " GB (" + s.RamPct.ToString("0") + "%)";
        if (metricKey == "gpu") return s.GpuPct.ToString("0") + "%";
        return s.VramUsedGiB.ToString("0.0", CultureInfo.InvariantCulture) + " GB (" + s.VramPct.ToString("0") + "%)";
    }

    protected override void OnPaint(PaintEventArgs e) {
        var p = Theme.Current;
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        g.Clear(p.CardBg);
        var outer = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = Theme.RoundedRect(outer, 12))
        using (var bg = new SolidBrush(p.CardBg))
        using (var border = new Pen(p.BorderStrong, 1f)) {
            g.FillPath(bg, path); g.DrawPath(border, path);
        }

        string title = metricKey == "cpu" ? I18n.T("app.metrics.historyCpu")
            : metricKey == "ram" ? I18n.T("app.metrics.historyRam")
            : metricKey == "gpu" ? I18n.T("app.metrics.historyGpu")
            : I18n.T("app.metrics.historyVram");
        string hwDetail = "";
        if (latestResources != null) {
            if (metricKey == "cpu") hwDetail = latestResources.CpuName;
            else if (metricKey == "ram") hwDetail = Budget.GB(latestResources.TotalMemory) + " · " + I18n.T("app.metrics.available") + " " + Budget.GB(latestResources.AvailableMemory);
            else {
                var gpu = latestResources.Gpus.OrderByDescending(x => x.Usage ?? -1).FirstOrDefault();
                if (gpu != null) hwDetail = gpu.Name;
            }
        }
        string modeHint = snapshot != null && snapshot.Mode == TelemetryMode.Recording ? I18n.T("app.metrics.modeRecording")
            : snapshot != null && snapshot.Mode == TelemetryMode.FrozenRun ? I18n.T("app.metrics.modeFrozen")
            : I18n.T("app.metrics.modeIdle");

        using (var fTitle = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold))
        using (var fSub = new Font("Microsoft YaHei UI", 7.8f))
        using (var fBold = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold)) {
            TextRenderer.DrawText(g, title, fTitle, new Rectangle(14, 10, 260, 20), p.Ink, TextFormatFlags.Left);
            TextRenderer.DrawText(g, (String.IsNullOrWhiteSpace(hwDetail) ? "" : hwDetail + " · ") + modeHint, fSub, new Rectangle(14, 30, Width - 28, 18), p.Muted, TextFormatFlags.Left | TextFormatFlags.EndEllipsis);

            using (var penIdle = new Pen(p.ChartIdle, 2.2f))
            using (var penAct = new Pen(p.ChartActive, 2.2f)) {
                g.DrawLine(penIdle, Width - 154, 20, Width - 140, 20);
                TextRenderer.DrawText(g, I18n.T("app.metrics.chartIdle"), fSub, new Rectangle(Width - 138, 12, 54, 16), p.Text2);
                g.DrawLine(penAct, Width - 82, 20, Width - 68, 20);
                TextRenderer.DrawText(g, I18n.T("app.metrics.chartActive"), fSub, new Rectangle(Width - 66, 12, 60, 16), p.Text2);
            }

            var chartBox = new Rectangle(14, 52, Width - 28, 146);
            using (var cp = Theme.RoundedRect(chartBox, 8))
            using (var cb = new SolidBrush(p.SubCardBg))
            using (var cpen = new Pen(p.Border, 1f)) {
                g.FillPath(cb, cp); g.DrawPath(cpen, cp);
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

                if (startIdx >= 0 && startIdx < coords.Length) {
                    float mx = coords[startIdx].X;
                    using (var dashPen = new Pen(p.ChartActive, 1.3f) { DashStyle = DashStyle.Dash })
                        g.DrawLine(dashPen, mx, padT, mx, padB);
                    int labelX = (int)Math.Min(padR - 58, mx + 4);
                    TextRenderer.DrawText(g, I18n.T("app.metrics.chartStartMark"), fSub, new Rectangle(labelX, padT - 2, 62, 16), p.ChartActive);
                }

                double totalSec = Math.Max(0.5, (pts[pts.Length - 1].Timestamp - pts[0].Timestamp).TotalSeconds);
                TextRenderer.DrawText(g, "0s", fSub, new Rectangle(padL, padB + 2, 40, 15), p.Muted, TextFormatFlags.Left);
                TextRenderer.DrawText(g, totalSec.ToString("0.0", CultureInfo.InvariantCulture) + "s", fSub, new Rectangle(padR - 54, padB + 2, 54, 15), p.Muted, TextFormatFlags.Right);

                var lastPt = coords[coords.Length - 1];
                bool lastAct = startIdx >= 0 && (coords.Length - 1) > startIdx;
                using (var dot = new SolidBrush(lastAct ? p.ChartActive : p.ChartIdle))
                    g.FillEllipse(dot, lastPt.X - 3.5f, lastPt.Y - 3.5f, 7f, 7f);
            }

            int cardY = 208, cardW = (Width - 28 - 16) / 3, cardH = 54;
            string curText = pts.Length > 0 ? FormatVal(pts[pts.Length - 1]) : "--";
            string peakText = "--", idleAvgText = "--";
            if (pts.Length > 0) {
                int sIdx = snapshot.StartIndex;
                var actList = sIdx >= 0 ? pts.Skip(sIdx + 1).ToArray() : new TelemetrySample[0];
                if (actList.Length > 0) {
                    var peakSample = actList.OrderByDescending(x => ReadPct(x)).First();
                    peakText = FormatVal(peakSample);
                }
                var idleList = sIdx >= 0 ? pts.Take(sIdx + 1).ToArray() : pts;
                if (idleList.Length > 0) {
                    double avg = idleList.Average(x => ReadPct(x));
                    idleAvgText = avg.ToString("0") + "%";
                }
            }
            DrawStatCard(g, new Rectangle(14, cardY, cardW, cardH), I18n.T("app.metrics.chartCurrent"), curText, p.Ink, fSub, fBold);
            DrawStatCard(g, new Rectangle(14 + cardW + 8, cardY, cardW, cardH), I18n.T("app.metrics.chartPeak"), peakText, p.ChartActive, fSub, fBold);
            DrawStatCard(g, new Rectangle(14 + (cardW + 8) * 2, cardY, cardW, cardH), I18n.T("app.metrics.chartIdleAvg"), idleAvgText, p.ChartIdle, fSub, fBold);
        }
    }

    void DrawStatCard(Graphics g, Rectangle rect, string label, string val, Color valColor, Font fSub, Font fBold) {
        var p = Theme.Current;
        using (var path = Theme.RoundedRect(rect, 7))
        using (var bg = new SolidBrush(p.SubCardBg))
        using (var pen = new Pen(p.Border, 1f)) {
            g.FillPath(bg, path); g.DrawPath(pen, path);
        }
        TextRenderer.DrawText(g, label, fSub, new Rectangle(rect.X + 4, rect.Y + 6, rect.Width - 8, 16), p.Muted, TextFormatFlags.HorizontalCenter);
        TextRenderer.DrawText(g, val, fBold, new Rectangle(rect.X + 4, rect.Y + 25, rect.Width - 8, 22), valColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.EndEllipsis);
    }
}

sealed class EngineUpdateDialog : Form {
    readonly Label currentLabel = new Label { AutoSize = true };
    readonly Label statusLabel = new Label { AutoSize = false, Height = 38 };
    readonly FluentDropdown mirrorBox = new FluentDropdown { Width = 360 };
    readonly TextBox logBox = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill };
    readonly FluentButton btnCheck = new FluentButton { Width = 136, Height = 34 };
    readonly FluentButton btnPull = new FluentButton { Width = 148, Height = 34, Primary = true, Enabled = false };
    readonly FluentButton btnRollback = new FluentButton { Width = 148, Height = 34 };
    readonly Action onVersionChanged;
    EngineCheckResult lastCheck;
    CancellationTokenSource cts;

    internal EngineUpdateDialog(Form owner, Action onChanged) {
        onVersionChanged = onChanged;
        var p = Theme.Current;
        Text = I18n.T("app.engine.updateTitle");
        Font = owner.Font; Icon = owner.Icon;
        BackColor = p.WindowBg; ForeColor = p.Ink;
        ClientSize = new Size(640, 480);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = MaximizeBox = false;
        Padding = new Padding(18);

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6 };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 82));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));

        var creditCard = new CardPanel { UseSubCard = true, Radius = 9, Dock = DockStyle.Fill, Padding = new Padding(14, 9, 14, 9), Margin = new Padding(0, 0, 0, 8) };
        var creditText = new Label { Dock = DockStyle.Top, Height = 36, ForeColor = p.Text2, BackColor = p.SubCardBg, Text = I18n.T("app.licenses.engineCredit") };
        var creditLink = new LinkLabel {
            Dock = DockStyle.Bottom, Height = 20, LinkColor = p.Accent, ActiveLinkColor = p.AccentHover, BackColor = p.SubCardBg, AutoEllipsis = true,
            Text = I18n.T("app.star.upstreamLink") + App.UpstreamRepository
        };
        creditLink.LinkClicked += (s, e) => {
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(App.UpstreamRepository) { UseShellExecute = true }); } catch { }
        };
        creditCard.Controls.Add(creditText);
        creditCard.Controls.Add(creditLink);
        root.Controls.Add(creditCard, 0, 0);

        RefreshHeader();
        root.Controls.Add(currentLabel, 0, 1);

        var mirrorRow = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        mirrorRow.Controls.Add(new Label { Text = I18n.T("app.engine.mirrorsLabel") + ":", AutoSize = true, Margin = new Padding(0, 8, 8, 0), ForeColor = p.Text2 });
        mirrorBox.SetItems(EngineManager.Mirrors.Select(m => (object)m.Name), 0);
        mirrorRow.Controls.Add(mirrorBox);
        root.Controls.Add(mirrorRow, 0, 2);

        statusLabel.Dock = DockStyle.Fill; statusLabel.ForeColor = p.Accent;
        statusLabel.Text = I18n.T("app.engine.decoupledHint");
        root.Controls.Add(statusLabel, 0, 3);

        logBox.BackColor = p.LogBg; logBox.ForeColor = p.Text2; logBox.BorderStyle = BorderStyle.FixedSingle;
        logBox.Font = new Font("Consolas", 8.5f);
        root.Controls.Add(logBox, 0, 4);

        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 10, 0, 0) };
        btnPull.Text = I18n.T("app.engine.pullUpdate"); btnPull.Margin = new Padding(8, 0, 0, 0);
        btnCheck.Text = I18n.T("app.engine.checkUpdates"); btnCheck.Margin = new Padding(8, 0, 0, 0);
        btnRollback.Text = I18n.T("app.engine.rollback");
        actions.Controls.Add(btnPull); actions.Controls.Add(btnCheck); actions.Controls.Add(btnRollback);
        root.Controls.Add(actions, 0, 5);

        Controls.Add(root);

        btnCheck.Click += (s, e) => DoCheck();
        btnPull.Click += (s, e) => DoPull();
        btnRollback.Click += (s, e) => DoRollback();
        HandleCreated += (s, e) => { Theme.ApplyWindowChrome(this); Theme.ApplyDarkScrollbars(this); };
        FormClosing += (s, e) => { if (cts != null) cts.Cancel(); };
    }

    void RefreshHeader() {
        currentLabel.Text = I18n.F(
            EngineManager.IsUsingBundled ? "app.engine.activeStatusBundled" : "app.engine.activeStatusUpdated",
            "active", EngineManager.ActiveVersion,
            "bundled", EngineManager.BundledVersion);
    }

    void Append(string msg) {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(new Action(() => Append(msg))); return; }
        logBox.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + msg + "\r\n");
    }

    async void DoCheck() {
        btnCheck.Enabled = btnPull.Enabled = btnRollback.Enabled = false;
        statusLabel.Text = I18n.T("app.engine.checkingMirrors");
        string prefId = EngineManager.Mirrors[Math.Max(0, mirrorBox.SelectedIndex)].Id;
        Append(I18n.F("app.engine.connectingMirror", "mirrorId", prefId));
        try {
            var res = await Task.Run(() => EngineManager.CheckBestMirror(prefId));
            lastCheck = res;
            if (!res.Success) {
                statusLabel.Text = res.Error;
                Append(I18n.F("app.engine.errLog", "error", res.Error));
            } else {
                Append(I18n.F("app.engine.mirrorResult", "mirror", res.MirrorName, "latency", res.LatencyMs, "version", res.LatestVersion));
                statusLabel.Text = "v" + res.LatestVersion + " (" + res.MirrorName + ", " + res.LatencyMs + " ms)";
                btnPull.Enabled = true;
            }
        } finally { btnCheck.Enabled = btnRollback.Enabled = true; }
    }

    async void DoPull() {
        if (lastCheck == null || !lastCheck.Success) return;
        btnCheck.Enabled = btnPull.Enabled = btnRollback.Enabled = false;
        cts = new CancellationTokenSource();
        statusLabel.Text = I18n.F("app.engine.pullingVersion", "version", lastCheck.LatestVersion);
        try {
            string ver = await Task.Run(() => EngineManager.PullUpdate(lastCheck, cts.Token, Append));
            RefreshHeader();
            statusLabel.Text = I18n.F("app.engine.updatedSuccess", "version", ver);
            if (onVersionChanged != null) onVersionChanged();
        } catch (Exception ex) {
            statusLabel.Text = ex.Message;
            Append(I18n.F("app.engine.failLog", "error", ex.Message));
        } finally { cts.Dispose(); cts = null; btnCheck.Enabled = btnRollback.Enabled = true; }
    }

    async void DoRollback() {
        btnCheck.Enabled = btnPull.Enabled = btnRollback.Enabled = false;
        cts = new CancellationTokenSource();
        try {
            await Task.Run(() => EngineManager.RollbackToBundled(cts.Token));
            RefreshHeader();
            statusLabel.Text = I18n.F("app.engine.restoredBundled", "version", EngineManager.BundledVersion);
            Append(I18n.F("app.engine.rolledBackLog", "version", EngineManager.BundledVersion));
            if (onVersionChanged != null) onVersionChanged();
        } catch (Exception ex) { statusLabel.Text = ex.Message; }
        finally { cts.Dispose(); cts = null; btnCheck.Enabled = btnRollback.Enabled = true; }
    }
}
