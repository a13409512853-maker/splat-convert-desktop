using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

// ============================================================================
// 1. Inspection, SOG Layer Breakdown & Format Compatibility Dialog (Spec §3.1, §3.10)
// ============================================================================
sealed class InspectDialog : Form {
    readonly string filePath;
    readonly Label headerMeta = new Label { Dock = DockStyle.Fill, AutoEllipsis = true };
    readonly Panel breakdownHost = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
    readonly Panel compatHost = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
    readonly TextBox deepBox = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, Visible = false };
    readonly FluentButton btnDeep = new FluentButton { Width = 192, Height = 34 };
    readonly BeginnerTipPopup dlgTip = new BeginnerTipPopup();
    CancellationTokenSource cts;

    internal InspectDialog(Form owner, string path) {
        filePath = path;
        var p = Theme.Current;
        Text = I18n.F("app.inspector.title", "name", Path.GetFileName(path));
        Font = owner.Font; Icon = owner.Icon;
        ClientSize = new Size(740, 560); MinimumSize = new Size(640, 480);
        StartPosition = FormStartPosition.CenterParent;
        BackColor = p.WindowBg; ForeColor = p.Ink;
        HandleCreated += (s, e) => { Theme.ApplyWindowChrome(this); Theme.ApplyDarkScrollbars(this); };

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(16) };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 68));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 46));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 54));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));

        var headCard = new CardPanel { Dock = DockStyle.Fill, Padding = new Padding(14, 10, 14, 10), Margin = new Padding(0, 0, 0, 10) };
        headerMeta.ForeColor = p.Ink; headerMeta.BackColor = p.CardBg;
        headerMeta.Text = I18n.T("app.inspector.readingMeta");
        headCard.Controls.Add(headerMeta);
        root.Controls.Add(headCard, 0, 0);

        var bCard = new CardPanel { Dock = DockStyle.Fill, Padding = new Padding(14, 10, 14, 10), Margin = new Padding(0, 0, 0, 10) };
        breakdownHost.BackColor = p.CardBg;
        bCard.Controls.Add(breakdownHost);
        root.Controls.Add(bCard, 0, 1);

        var cCard = new CardPanel { Dock = DockStyle.Fill, Padding = new Padding(14, 10, 14, 10), Margin = new Padding(0, 0, 0, 8) };
        compatHost.BackColor = p.CardBg;
        deepBox.BackColor = p.LogBg; deepBox.ForeColor = p.Text2; deepBox.Font = new Font("Consolas", 8.4f);
        cCard.Controls.Add(compatHost);
        cCard.Controls.Add(deepBox);
        root.Controls.Add(cCard, 0, 2);

        var footer = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 8, 0, 0) };
        var btnClose = new FluentButton { Text = I18n.T("common.close"), Primary = true, Width = 108, Height = 34, Margin = new Padding(8, 0, 0, 0) };
        btnDeep.Text = I18n.T("app.inspector.deepBtn");
        btnClose.Click += (s, e) => Close();
        btnDeep.Click += (s, e) => RunDeep();
        BeginnerTipPopup.Bind(dlgTip, btnDeep, "inspectDeep", "dialog");
        footer.Controls.Add(btnClose); footer.Controls.Add(btnDeep);
        root.Controls.Add(footer, 0, 3);
        Controls.Add(root);

        Shown += (s, e) => LoadLight();
        FormClosing += (s, e) => { if (cts != null) cts.Cancel(); dlgTip.CancelAndHide(); };
        FormClosed += (s, e) => dlgTip.Dispose();
    }

    async void LoadLight() {
        var res = await Task.Run(() => SplatInspector.InspectLight(filePath));
        if (IsDisposed) return;
        var p = Theme.Current;
        if (!res.Readable) {
            headerMeta.ForeColor = p.Danger;
            headerMeta.Text = I18n.F("app.inspector.readFailed", "error", res.Error);
            return;
        }
        string tags = (res.Antialiased ? " · Antialiased" : "") + (res.Is2DGS ? " · 2DGS" : "") + (res.HasBlindData ? " · Blind Data" : "") + (!res.IsGaussian ? I18n.T("app.inspector.nonGaussianTag") : "");
        string fpShort = res.Fingerprint.Length > 16 ? res.Fingerprint.Substring(0, 16) : res.Fingerprint;
        headerMeta.Text = I18n.F("app.inspector.headerSummary",
            "name", Path.GetFileName(res.Path),
            "format", res.Format.ToUpperInvariant(),
            "version", res.FormatVersion,
            "count", res.SplatCount.ToString("N0"),
            "bands", res.ShBands,
            "size", Budget.GB(res.FileBytes),
            "tags", tags,
            "algo", res.FingerprintAlgo,
            "fp", fpShort);

        breakdownHost.Controls.Clear();
        var bStack = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 3, BackColor = p.CardBg };
        bStack.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
        bStack.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        bStack.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190));
        bStack.Controls.Add(new Label { Text = I18n.T("app.inspector.storageBreakdown"), Font = new Font(Font, FontStyle.Bold), ForeColor = p.Ink, BackColor = p.CardBg, AutoSize = true, Margin = new Padding(0, 0, 0, 6) }, 0, 0);
        bStack.SetColumnSpan(bStack.Controls[0], 3);

        if (res.SogBreakdown.Count > 0) {
            int row = 1;
            foreach (var layer in res.SogBreakdown) {
                double pct = res.FileBytes > 0 ? (layer.CompressedBytes * 100d / res.FileBytes) : 0;
                bStack.Controls.Add(new Label { Text = layer.Category.ToUpperInvariant(), ForeColor = p.Ink, BackColor = p.CardBg, AutoSize = true, Margin = new Padding(0, 3, 6, 3) }, 0, row);
                var bar = new ModernProgressBar { Percent = pct, Dock = DockStyle.Fill, Height = 8, Margin = new Padding(0, 7, 8, 5) };
                bStack.Controls.Add(bar, 1, row);
                bStack.Controls.Add(new Label {
                    Text = FormatBytes(layer.CompressedBytes) + " (" + pct.ToString("0.0") + "%)",
                    ForeColor = p.Text2, BackColor = p.CardBg, AutoSize = true, TextAlign = ContentAlignment.MiddleRight, Font = new Font("Consolas", 8.2f)
                }, 2, row);
                row++;
            }
        } else {
            string bpp = res.SplatCount > 0 ? (res.FileBytes / (double)res.SplatCount).ToString("0.0", CultureInfo.InvariantCulture) : "0";
            string nonSogText = I18n.F("app.inspector.nonSogSummary", "size", FormatBytes(res.FileBytes), "bpp", bpp)
                + (res.ExtraColumns.Count > 0 ? "\n" + I18n.F("app.inspector.extraColumns", "cols", String.Join(", ", res.ExtraColumns)) : "");
            bStack.Controls.Add(new Label {
                Text = nonSogText,
                ForeColor = p.Text2, BackColor = p.CardBg, AutoSize = true
            }, 0, 1);
            bStack.SetColumnSpan(bStack.Controls[bStack.Controls.Count - 1], 3);
        }
        breakdownHost.Controls.Add(bStack);

        compatHost.Controls.Clear();
        var cStack = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 3, BackColor = p.CardBg };
        cStack.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        cStack.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        cStack.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        var ct = new Label { Text = I18n.T("app.inspector.compatTitle"), Font = new Font(Font, FontStyle.Bold), ForeColor = p.Ink, BackColor = p.CardBg, AutoSize = true, Margin = new Padding(0, 0, 0, 6) };
        cStack.Controls.Add(ct, 0, 0); cStack.SetColumnSpan(ct, 3);
        int crow = 1;
        foreach (var item in res.Compatibility) {
            Color sc = item.Status == "preserved" ? p.Accent : item.Status == "dropped" ? p.Danger : p.Warn;
            cStack.Controls.Add(new Label { Text = item.TargetFormat, Font = new Font("Consolas", 8.4f, FontStyle.Bold), ForeColor = p.Ink, BackColor = p.CardBg, AutoSize = true, Margin = new Padding(0, 3, 4, 3) }, 0, crow);
            cStack.Controls.Add(new Label { Text = "[" + item.Status + "]", Font = new Font("Consolas", 8f, FontStyle.Bold), ForeColor = sc, BackColor = p.CardBg, AutoSize = true, Margin = new Padding(0, 3, 4, 3) }, 1, crow);
            cStack.Controls.Add(new Label { Text = item.Attribute + " — " + item.Reason, ForeColor = p.Text2, BackColor = p.CardBg, AutoSize = true, Margin = new Padding(0, 3, 0, 3) }, 2, crow);
            crow++;
        }
        compatHost.Controls.Add(cStack);
    }

    async void RunDeep() {
        btnDeep.Enabled = false;
        btnDeep.Text = I18n.T("app.inspector.deepRunning");
        cts = new CancellationTokenSource();
        try {
            string raw = await Task.Run(() => { using (var c = new Converter()) return c.RunInfoStats(filePath, cts.Token); });
            if (!IsDisposed) {
                compatHost.Visible = false;
                deepBox.Visible = true;
                deepBox.Text = String.IsNullOrWhiteSpace(raw) ? I18n.T("app.inspector.deepEmpty") : raw.Replace("\n", "\r\n");
            }
        } catch (Exception ex) {
            if (!IsDisposed) MessageBox.Show(this, ex.Message, Text);
        } finally {
            if (!IsDisposed) { btnDeep.Enabled = true; btnDeep.Text = I18n.T("app.inspector.deepBtn"); }
        }
    }

    static string FormatBytes(long b) {
        if (b >= 1073741824) return (b / 1073741824d).ToString("0.00", CultureInfo.InvariantCulture) + " GB";
        if (b >= 1048576) return (b / 1048576d).ToString("0.00", CultureInfo.InvariantCulture) + " MB";
        return (b / 1024d).ToString("0.0", CultureInfo.InvariantCulture) + " KB";
    }
}

// ============================================================================
// 2. Searchable Full 3.12.0 Advanced Options, Global Delayed Tooltips & Veteran Switches
// ============================================================================
sealed class AdvancedOptionsState {
    public int SogVersion = 3;
    public double? ShColorError;
    public int SpzVersion = 4;
    public bool PlyLogitOpacity;
    public bool HtmlUnbundled;
    public bool VoxelExternalFill;
    public bool VoxelFloorFill;
    public bool VoxelCarve;
    public string SeedPos = "0,0,0";
    public string CollisionMesh = "";
    public long TargetMaxBytes;
    public int MinKeepPct = 20;
    public int MaxAttempts = 3;

    internal void LoadFromSettings() {
        var s = PortablePaths.LoadSettings();
        SogVersion = s.AdvSogVersion == 2 ? 2 : 3;
        ShColorError = s.AdvShColorError > 0 ? (double?)s.AdvShColorError : null;
        SpzVersion = s.AdvSpzVersion == 3 ? 3 : 4;
        PlyLogitOpacity = s.AdvPlyLogitOpacity;
        HtmlUnbundled = s.AdvHtmlUnbundled;
        VoxelExternalFill = s.AdvVoxelExternalFill;
        VoxelFloorFill = s.AdvVoxelFloorFill;
        VoxelCarve = s.AdvVoxelCarve;
        SeedPos = String.IsNullOrWhiteSpace(s.AdvSeedPos) ? "0,0,0" : s.AdvSeedPos;
        CollisionMesh = s.AdvCollisionMesh ?? "";
        TargetMaxBytes = Math.Max(0, s.AdvTargetMaxBytes);
        MinKeepPct = Math.Max(5, Math.Min(95, s.AdvMinKeepPct > 0 ? s.AdvMinKeepPct : 20));
    }

    internal void SaveToSettings() {
        PortablePaths.SaveSettings(s => {
            s.AdvSogVersion = SogVersion;
            s.AdvShColorError = ShColorError.HasValue ? ShColorError.Value : -1;
            s.AdvSpzVersion = SpzVersion;
            s.AdvPlyLogitOpacity = PlyLogitOpacity;
            s.AdvHtmlUnbundled = HtmlUnbundled;
            s.AdvVoxelExternalFill = VoxelExternalFill;
            s.AdvVoxelFloorFill = VoxelFloorFill;
            s.AdvVoxelCarve = VoxelCarve;
            s.AdvSeedPos = SeedPos;
            s.AdvCollisionMesh = CollisionMesh;
            s.AdvTargetMaxBytes = TargetMaxBytes;
            s.AdvMinKeepPct = MinKeepPct;
        });
    }
}

sealed class AdvancedOptionsDialog : Form {
    readonly AdvancedOptionsState state;
    readonly string formatSuffix;
    readonly BeginnerTipPopup dlgTip = new BeginnerTipPopup();
    readonly FluentInputBox searchBox = new FluentInputBox { Dock = DockStyle.Top };
    readonly ListBox capList = new ListBox { Dock = DockStyle.Fill, BorderStyle = BorderStyle.FixedSingle };
    readonly FluentInputBox txtTargetMb = new FluentInputBox { Width = 96 };
    readonly FluentInputBox txtMinKeep = new FluentInputBox { Width = 64 };
    readonly FluentInputBox txtShErr = new FluentInputBox { Width = 74 };
    readonly FluentInputBox txtSeedPos = new FluentInputBox { Width = 115 };
    readonly FluentInputBox txtTipDelay = new FluentInputBox { Width = 68 };
    readonly FluentInputBox txtMaxHistory = new FluentInputBox { Width = 64 };
    readonly FluentDropdown ddSogVer = new FluentDropdown { Width = 92 };
    readonly FluentDropdown ddSpzVer = new FluentDropdown { Width = 92 };
    readonly FluentDropdown ddColMesh = new FluentDropdown { Width = 104 };
    readonly CheckBox chkPlyLogit = new CheckBox { AutoSize = true };
    readonly CheckBox chkHtmlUnb = new CheckBox { AutoSize = true };
    readonly CheckBox chkExtFill = new CheckBox { AutoSize = true };
    readonly CheckBox chkFloorFill = new CheckBox { AutoSize = true };
    readonly CheckBox chkCarve = new CheckBox { AutoSize = true };

    // Veteran per-region tooltip switches (8 independent UI regions)
    readonly CheckBox chkTipInput = new CheckBox { AutoSize = true };
    readonly CheckBox chkTipPipe = new CheckBox { AutoSize = true };
    readonly CheckBox chkTipOut = new CheckBox { AutoSize = true };
    readonly CheckBox chkTipDialog = new CheckBox { AutoSize = true };
    readonly CheckBox chkTipEdTool = new CheckBox { AutoSize = true };
    readonly CheckBox chkTipEdScene = new CheckBox { AutoSize = true };
    readonly CheckBox chkTipEdColor = new CheckBox { AutoSize = true };
    readonly CheckBox chkTipEdModal = new CheckBox { AutoSize = true };

    internal AdvancedOptionsDialog(Form owner, AdvancedOptionsState current, string suffix) {
        state = current; formatSuffix = suffix;
        var p = Theme.Current;
        Text = I18n.T("app.advanced.title");
        Font = owner.Font; Icon = owner.Icon;
        ClientSize = new Size(880, 676); MinimumSize = new Size(780, 580);
        StartPosition = FormStartPosition.CenterParent;
        BackColor = p.WindowBg; ForeColor = p.Ink;
        HandleCreated += (s, e) => { Theme.ApplyWindowChrome(this); Theme.ApplyDarkScrollbars(this); };

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Padding = new Padding(16) };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 326));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));

        // Top Card: Encoding Advanced Controls + Veteran Per-Region Tooltip Switches + History Limit
        var topCard = new CardPanel { Dock = DockStyle.Fill, Padding = new Padding(14, 10, 14, 10), Margin = new Padding(0, 0, 0, 10) };
        var g = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 7, BackColor = p.CardBg };
        g.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        g.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        g.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        g.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        g.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        g.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        g.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));

        // Row 0: Target Size Hard Cap (GB/MB units)
        var r0 = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, BackColor = p.CardBg };
        r0.Controls.Add(Lbl(I18n.T("app.advanced.targetCapLabel"), p.Accent, true));
        txtTargetMb.Inner.Text = state.TargetMaxBytes > 0 ? (state.TargetMaxBytes / 1048576d).ToString("0.##", CultureInfo.InvariantCulture) : "0";
        txtTargetMb.ApplyTheme(); r0.Controls.Add(txtTargetMb);
        r0.Controls.Add(Lbl(I18n.T("app.advanced.minKeepLabel"), p.Text2, false));
        txtMinKeep.Inner.Text = state.MinKeepPct.ToString(CultureInfo.InvariantCulture);
        txtMinKeep.ApplyTheme(); r0.Controls.Add(txtMinKeep);
        r0.Controls.Add(Lbl(I18n.T("app.advanced.targetCapNote"), p.Muted, false));
        BeginnerTipPopup.Bind(dlgTip, txtTargetMb, "advTargetCap", "dialog");
        BeginnerTipPopup.Bind(dlgTip, txtMinKeep, "advMinKeep", "dialog");
        g.Controls.Add(r0, 0, 0);

        // Row 1: SOG / SPZ / SH Error
        var r1 = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, BackColor = p.CardBg };
        r1.Controls.Add(Lbl(I18n.T("app.advanced.sogVersionLabel"), p.Text2, false));
        ddSogVer.Width = 112;
        ddSogVer.SetItems(new object[] { I18n.T("app.advanced.sogV3Rec"), I18n.T("app.advanced.sogV2Legacy") }, state.SogVersion == 2 ? 1 : 0); r1.Controls.Add(ddSogVer);
        r1.Controls.Add(Lbl(I18n.T("app.advanced.shErrorLabel"), p.Text2, false));
        txtShErr.Inner.Text = state.ShColorError.HasValue ? state.ShColorError.Value.ToString("0.##", CultureInfo.InvariantCulture) : "";
        txtShErr.ApplyTheme(); r1.Controls.Add(txtShErr);
        r1.Controls.Add(Lbl(I18n.T("app.advanced.spzVersionLabel"), p.Text2, false));
        ddSpzVer.Width = 104;
        ddSpzVer.SetItems(new object[] { I18n.T("app.advanced.spzV4Default"), "v3" }, state.SpzVersion == 3 ? 1 : 0); r1.Controls.Add(ddSpzVer);
        BeginnerTipPopup.Bind(dlgTip, ddSogVer, "advSogVer", "dialog");
        BeginnerTipPopup.Bind(dlgTip, txtShErr, "advShErr", "dialog");
        BeginnerTipPopup.Bind(dlgTip, ddSpzVer, "advSpzVer", "dialog");
        g.Controls.Add(r1, 0, 1);

        // Row 2: PLY / HTML flags
        var r2 = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, BackColor = p.CardBg };
        chkPlyLogit.Text = I18n.T("app.advanced.plyLogitCheck"); chkPlyLogit.Checked = state.PlyLogitOpacity; chkPlyLogit.ForeColor = p.Ink; chkPlyLogit.BackColor = p.CardBg; chkPlyLogit.Margin = new Padding(0, 7, 16, 0);
        chkHtmlUnb.Text = I18n.T("app.advanced.htmlUnbundledCheck"); chkHtmlUnb.Checked = state.HtmlUnbundled; chkHtmlUnb.ForeColor = p.Ink; chkHtmlUnb.BackColor = p.CardBg; chkHtmlUnb.Margin = new Padding(0, 7, 0, 0);
        BeginnerTipPopup.Bind(dlgTip, chkPlyLogit, "advPlyLogit", "dialog");
        BeginnerTipPopup.Bind(dlgTip, chkHtmlUnb, "advHtmlUnbundled", "dialog");
        r2.Controls.Add(chkPlyLogit); r2.Controls.Add(chkHtmlUnb);
        g.Controls.Add(r2, 0, 2);

        // Row 3: Voxel & Collision Mesh
        var r3 = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, BackColor = p.CardBg };
        chkExtFill.Text = I18n.T("app.advanced.extFillCheck"); chkExtFill.Checked = state.VoxelExternalFill; chkExtFill.ForeColor = p.Ink; chkExtFill.BackColor = p.CardBg; chkExtFill.Margin = new Padding(0, 7, 8, 0);
        chkFloorFill.Text = I18n.T("app.advanced.floorFillCheck"); chkFloorFill.Checked = state.VoxelFloorFill; chkFloorFill.ForeColor = p.Ink; chkFloorFill.BackColor = p.CardBg; chkFloorFill.Margin = new Padding(0, 7, 8, 0);
        chkCarve.Text = I18n.T("app.advanced.carveCheck"); chkCarve.Checked = state.VoxelCarve; chkCarve.ForeColor = p.Ink; chkCarve.BackColor = p.CardBg; chkCarve.Margin = new Padding(0, 7, 10, 0);
        r3.Controls.Add(chkExtFill); r3.Controls.Add(chkFloorFill); r3.Controls.Add(chkCarve);
        r3.Controls.Add(Lbl(I18n.T("app.advanced.seedPosLabel"), p.Text2, false));
        txtSeedPos.Inner.Text = state.SeedPos; txtSeedPos.ApplyTheme(); r3.Controls.Add(txtSeedPos);
        r3.Controls.Add(Lbl(I18n.T("app.advanced.collisionMeshLabel"), p.Text2, false));
        ddColMesh.SetItems(new object[] { I18n.T("common.off"), "smooth", "faces" }, state.CollisionMesh == "smooth" ? 1 : state.CollisionMesh == "faces" ? 2 : 0);
        r3.Controls.Add(ddColMesh);
        BeginnerTipPopup.Bind(dlgTip, chkExtFill, "advVoxelFlags", "dialog");
        BeginnerTipPopup.Bind(dlgTip, chkFloorFill, "advVoxelFlags", "dialog");
        BeginnerTipPopup.Bind(dlgTip, chkCarve, "advVoxelFlags", "dialog");
        g.Controls.Add(r3, 0, 3);

        // Row 4: Global Delayed Tooltip Constant + 3D Editor Max History Steps
        var r4 = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, BackColor = p.CardBg };
        r4.Controls.Add(Lbl(I18n.T("app.advanced.tipDelayLabel"), p.Accent, true));
        txtTipDelay.Inner.Text = TooltipConfig.HoverDelayMs.ToString(CultureInfo.InvariantCulture);
        txtTipDelay.ApplyTheme(); r4.Controls.Add(txtTipDelay);
        r4.Controls.Add(Lbl(I18n.T("app.advanced.maxHistoryLabel"), p.Accent, true));
        txtMaxHistory.Inner.Text = TooltipConfig.EditorMaxHistorySteps.ToString(CultureInfo.InvariantCulture);
        txtMaxHistory.ApplyTheme(); r4.Controls.Add(txtMaxHistory);
        r4.Controls.Add(Lbl(I18n.T("app.advanced.autoSaveNote"), p.Muted, false));
        BeginnerTipPopup.Bind(dlgTip, txtTipDelay, "advTipDelay", "dialog");
        BeginnerTipPopup.Bind(dlgTip, txtMaxHistory, "advHistoryLimit", "dialog");
        g.Controls.Add(r4, 0, 4);

        // Row 5: Veteran Per-Region Tooltip Switches — Main App & External Dialogs
        var r5 = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, BackColor = p.CardBg };
        r5.Controls.Add(Lbl(I18n.T("app.advanced.tipRegionMainLabel"), p.Text2, true));
        InitTipChk(chkTipInput, I18n.T("app.advanced.tipRegionInput"), TooltipConfig.ShowInputTips, p);
        InitTipChk(chkTipPipe, I18n.T("app.advanced.tipRegionPipeline"), TooltipConfig.ShowPipelineTips, p);
        InitTipChk(chkTipOut, I18n.T("app.advanced.tipRegionOutput"), TooltipConfig.ShowOutputTips, p);
        InitTipChk(chkTipDialog, I18n.T("app.advanced.tipRegionDialog"), TooltipConfig.ShowExternalDialogTips, p);
        r5.Controls.AddRange(new Control[] { chkTipInput, chkTipPipe, chkTipOut, chkTipDialog });
        g.Controls.Add(r5, 0, 5);

        // Row 6: Veteran Per-Region Tooltip Switches — 3D Editor Regions
        var r6 = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, BackColor = p.CardBg };
        r6.Controls.Add(Lbl(I18n.T("app.advanced.tipRegionEditorLabel"), p.Text2, true));
        InitTipChk(chkTipEdTool, I18n.T("app.advanced.tipRegionEdTool"), TooltipConfig.ShowEditorToolbarTips, p);
        InitTipChk(chkTipEdScene, I18n.T("app.advanced.tipRegionEdScene"), TooltipConfig.ShowEditorSceneTips, p);
        InitTipChk(chkTipEdColor, I18n.T("app.advanced.tipRegionEdColor"), TooltipConfig.ShowEditorColorTips, p);
        InitTipChk(chkTipEdModal, I18n.T("app.advanced.tipRegionEdModal"), TooltipConfig.ShowEditorModalTips, p);
        r6.Controls.AddRange(new Control[] { chkTipEdTool, chkTipEdScene, chkTipEdColor, chkTipEdModal });
        g.Controls.Add(r6, 0, 6);

        topCard.Controls.Add(g);
        root.Controls.Add(topCard, 0, 0);

        // Middle Card: Searchable Full 3.12.0 Capability Registry
        var capCard = new CardPanel { Dock = DockStyle.Fill, Padding = new Padding(14, 10, 14, 10), Margin = new Padding(0, 0, 0, 8) };
        var capGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, BackColor = p.CardBg };
        capGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        capGrid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        searchBox.ApplyTheme();
        searchBox.Inner.TextChanged += (s, e) => RefreshCaps();
        capGrid.Controls.Add(searchBox, 0, 0);
        capList.BackColor = p.LogBg; capList.ForeColor = p.Ink; capList.Font = new Font("Consolas", 8.5f); capList.ItemHeight = 22;
        capGrid.Controls.Add(capList, 0, 1);
        capCard.Controls.Add(capGrid);
        root.Controls.Add(capCard, 0, 1);

        var footer = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 8, 0, 0) };
        var btnOk = new FluentButton { Text = I18n.T("common.ok"), Primary = true, Width = 112, Height = 34, Margin = new Padding(8, 0, 0, 0) };
        var btnCancel = new FluentButton { Text = I18n.T("common.cancel"), Width = 108, Height = 34, DialogResult = DialogResult.Cancel };
        btnOk.Click += (s, e) => SaveAndClose();
        footer.Controls.Add(btnOk); footer.Controls.Add(btnCancel);
        root.Controls.Add(footer, 0, 2);
        Controls.Add(root);
        FormClosing += (s, e) => dlgTip.CancelAndHide();
        FormClosed += (s, e) => dlgTip.Dispose();
        RefreshCaps();
    }

    void InitTipChk(CheckBox chk, string text, bool val, Palette p) {
        chk.Text = text;
        chk.Checked = val;
        chk.ForeColor = p.Ink;
        chk.BackColor = p.CardBg;
        chk.Margin = new Padding(4, 6, 10, 0);
        BeginnerTipPopup.Bind(dlgTip, chk, "advVeteranTips", "dialog");
    }

    Label Lbl(string text, Color fg, bool bold) {
        return new Label { Text = text, ForeColor = fg, BackColor = Theme.Current.CardBg, AutoSize = true, Font = bold ? new Font(Font, FontStyle.Bold) : Font, Margin = new Padding(4, 8, 4, 0) };
    }

    void RefreshCaps() {
        capList.BeginUpdate();
        capList.Items.Clear();
        foreach (var item in CapabilityManifest.Search(searchBox.Inner.Text, formatSuffix)) {
            bool app = CapabilityManifest.IsApplicable(item, formatSuffix);
            string tag = "[" + item.Status + (app ? "" : I18n.T("app.advanced.capNotApplicable")) + "]";
            string lbl = item.Label;
            string reason = String.IsNullOrEmpty(item.Reason) ? "" : " — " + item.Reason;
            capList.Items.Add(item.Flag.PadRight(24) + " " + tag.PadRight(24) + " " + lbl + reason);
        }
        capList.EndUpdate();
    }

    void SaveAndClose() {
        double mb;
        if (Double.TryParse(txtTargetMb.Inner.Text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out mb) && mb > 0)
            state.TargetMaxBytes = (long)Math.Round(mb * 1048576d);
        else state.TargetMaxBytes = 0;

        int mk;
        if (Int32.TryParse(txtMinKeep.Inner.Text.Trim(), out mk)) state.MinKeepPct = Math.Max(5, Math.Min(95, mk));
        double shErr;
        if (Double.TryParse(txtShErr.Inner.Text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out shErr) && shErr > 0) state.ShColorError = shErr;
        else state.ShColorError = null;

        state.SogVersion = ddSogVer.SelectedIndex == 1 ? 2 : 3;
        state.SpzVersion = ddSpzVer.SelectedIndex == 1 ? 3 : 4;
        state.PlyLogitOpacity = chkPlyLogit.Checked;
        state.HtmlUnbundled = chkHtmlUnb.Checked;
        state.VoxelExternalFill = chkExtFill.Checked;
        state.VoxelFloorFill = chkFloorFill.Checked;
        state.VoxelCarve = chkCarve.Checked;
        state.SeedPos = txtSeedPos.Inner.Text.Trim();
        state.CollisionMesh = ddColMesh.SelectedIndex == 1 ? "smooth" : ddColMesh.SelectedIndex == 2 ? "faces" : "";
        state.SaveToSettings();

        int delayMs;
        if (Int32.TryParse(txtTipDelay.Inner.Text.Trim(), out delayMs))
            TooltipConfig.HoverDelayMs = Math.Max(150, Math.Min(5000, delayMs));
        int maxHist;
        if (Int32.TryParse(txtMaxHistory.Inner.Text.Trim(), out maxHist))
            TooltipConfig.EditorMaxHistorySteps = Math.Max(10, Math.Min(300, maxHist));

        TooltipConfig.ShowInputTips = chkTipInput.Checked;
        TooltipConfig.ShowPipelineTips = chkTipPipe.Checked;
        TooltipConfig.ShowOutputTips = chkTipOut.Checked;
        TooltipConfig.ShowExternalDialogTips = chkTipDialog.Checked;
        TooltipConfig.ShowEditorToolbarTips = chkTipEdTool.Checked;
        TooltipConfig.ShowEditorSceneTips = chkTipEdScene.Checked;
        TooltipConfig.ShowEditorColorTips = chkTipEdColor.Checked;
        TooltipConfig.ShowEditorModalTips = chkTipEdModal.Checked;
        TooltipConfig.Save();

        DialogResult = DialogResult.OK;
        Close();
    }
}

// Scene editing is implemented in EditorHost.cs and editor/.

// ============================================================================
// 4. Resumable Jobs History & Queue Manager Dialog (Spec §3.4, §3.5)
// ============================================================================
sealed class JobsQueueDialog : Form {
    readonly ListBox jobList = new ListBox { Dock = DockStyle.Fill, BorderStyle = BorderStyle.FixedSingle };
    readonly List<JobDocument> jobs = new List<JobDocument>();
    readonly BeginnerTipPopup dlgTip = new BeginnerTipPopup();
    internal JobDocument SelectedToResume;

    internal JobsQueueDialog(Form owner) {
        var p = Theme.Current;
        Text = I18n.T("app.jobs.title");
        Font = owner.Font; Icon = owner.Icon;
        ClientSize = new Size(660, 420);
        StartPosition = FormStartPosition.CenterParent;
        BackColor = p.WindowBg; ForeColor = p.Ink;
        HandleCreated += (s, e) => { Theme.ApplyWindowChrome(this); Theme.ApplyDarkScrollbars(this); };

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Padding = new Padding(16) };
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));

        var card = new CardPanel { Dock = DockStyle.Fill, Padding = new Padding(12) };
        jobList.BackColor = p.LogBg; jobList.ForeColor = p.Ink; jobList.Font = new Font("Consolas", 8.6f); jobList.ItemHeight = 24;
        card.Controls.Add(jobList);
        root.Controls.Add(card, 0, 0);

        var footer = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 8, 0, 0) };
        var btnResume = new FluentButton { Text = I18n.T("app.jobs.resumeBtn"), Primary = true, Width = 188, Height = 34, Margin = new Padding(8, 0, 0, 0) };
        var btnClose = new FluentButton { Text = I18n.T("common.close"), Width = 104, Height = 34 };
        BeginnerTipPopup.Bind(dlgTip, btnResume, "jobsResume", "dialog");
        btnResume.Click += (s, e) => {
            if (jobList.SelectedIndex >= 0 && jobList.SelectedIndex < jobs.Count) {
                SelectedToResume = jobs[jobList.SelectedIndex];
                DialogResult = DialogResult.OK;
                Close();
            }
        };
        btnClose.Click += (s, e) => Close();
        footer.Controls.Add(btnResume); footer.Controls.Add(btnClose);
        root.Controls.Add(footer, 0, 1);
        Controls.Add(root);
        FormClosing += (s, e) => dlgTip.CancelAndHide();
        FormClosed += (s, e) => dlgTip.Dispose();

        jobs.AddRange(TaskPlanner.ListSavedJobs());
        if (jobs.Count == 0) jobList.Items.Add(I18n.T("app.jobs.emptyList"));
        else {
            foreach (var j in jobs) {
                int ok = j.Tasks.Count(t => t.Status == "succeeded" || t.Status == "skipped");
                int fail = j.Tasks.Count(t => t.Status == "failed" || t.Status == "interrupted");
                string line = I18n.F("app.jobs.itemSummary", "id", j.JobId, "mode", j.Mode, "ok", ok, "total", j.Tasks.Count)
                    + (fail > 0 ? I18n.F("app.jobs.itemFailedSuffix", "fail", fail) : "");
                jobList.Items.Add(line);
            }
            jobList.SelectedIndex = 0;
        }
    }
}
