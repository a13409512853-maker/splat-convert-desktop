using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class MessageDialog {
    internal static bool StarCelebration(Form owner, string summaryText) {
        bool openRepo = false;
        var p = Theme.Current;
        using (var dialog = new Form {
            Text = I18n.T("done"), Font = owner.Font, Icon = owner.Icon,
            ClientSize = new Size(540, 360),
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterParent,
            BackColor = p.WindowBg, ForeColor = p.Ink,
            MinimizeBox = false, MaximizeBox = false
        }) {
            dialog.HandleCreated += (s, e) => Theme.ApplyWindowChrome(dialog);

            var banner = new Panel { Dock = DockStyle.Top, Height = 82, BackColor = p.AccentSoft, Padding = new Padding(22, 16, 22, 12) };
            var iconPic = new PictureBox { Image = Art.Themed("star"), SizeMode = PictureBoxSizeMode.CenterImage, Dock = DockStyle.Left, Width = 36, BackColor = Color.Transparent };
            var titleBox = new Panel { Dock = DockStyle.Fill, Padding = new Padding(10, 2, 0, 0), BackColor = Color.Transparent };
            var lblTitle = new Label { Text = I18n.T("starCongrats"), Font = new Font(owner.Font.FontFamily, 12.5f, FontStyle.Bold), ForeColor = p.Accent, BackColor = Color.Transparent, Dock = DockStyle.Top, Height = 26 };
            var lblSub = new Label { Text = String.IsNullOrWhiteSpace(summaryText) ? I18n.T("starSubDefault") : summaryText, ForeColor = p.Text2, BackColor = Color.Transparent, Dock = DockStyle.Fill, AutoEllipsis = true };
            titleBox.Controls.Add(lblSub); titleBox.Controls.Add(lblTitle);
            banner.Controls.Add(titleBox); banner.Controls.Add(iconPic);

            var bodyHost = new Panel { Dock = DockStyle.Fill, Padding = new Padding(20, 14, 20, 12), BackColor = p.WindowBg };
            var bodyCard = new CardPanel { Dock = DockStyle.Fill, Padding = new Padding(18, 14, 18, 14) };
            var msg = new Label { Dock = DockStyle.Fill, ForeColor = p.Text2, BackColor = p.CardBg, Text = I18n.T("starBody") };
            var linkBox = new Panel { Dock = DockStyle.Bottom, Height = 30, BackColor = p.SubCardBg, Padding = new Padding(10, 5, 10, 4) };
            var upstreamLink = new LinkLabel {
                Text = I18n.T("upstreamLink") + App.UpstreamRepository,
                Dock = DockStyle.Fill, LinkColor = p.Accent, ActiveLinkColor = p.AccentHover, BackColor = p.SubCardBg, AutoEllipsis = true
            };
            upstreamLink.LinkClicked += (s, e) => {
                try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(App.UpstreamRepository) { UseShellExecute = true }); } catch { }
            };
            linkBox.Controls.Add(upstreamLink);
            bodyCard.Controls.Add(msg);
            bodyCard.Controls.Add(linkBox);
            bodyHost.Controls.Add(bodyCard);

            var footer = FooterPanel();
            var btnStar = new FluentButton { Text = I18n.T("starBtn"), IconName = "star", Primary = true, Width = 186, Height = 36, Margin = new Padding(10, 0, 0, 0) };
            var btnLater = new FluentButton { Text = I18n.T("starLater"), Width = 108, Height = 36 };
            btnStar.Click += (s, e) => { openRepo = true; dialog.Close(); };
            btnLater.Click += (s, e) => dialog.Close();
            footer.Controls.Add(btnStar); footer.Controls.Add(btnLater);

            dialog.Controls.Add(bodyHost);
            dialog.Controls.Add(banner);
            dialog.Controls.Add(footer);
            dialog.CancelButton = btnLater;
            dialog.ShowDialog(owner);
        }
        return openRepo;
    }

    internal static bool ResourceWarning(Form owner, MemoryEstimate est, ResourceSnapshot res, string message, string yes, string no) {
        bool result = false;
        var p = Theme.Current;
        using (var dialog = new Form {
            Text = I18n.T("resourceWarning"), Font = owner.Font, Icon = owner.Icon,
            ClientSize = new Size(600, 410), FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterParent,
            BackColor = p.WindowBg, ForeColor = p.Ink,
            MinimizeBox = false, MaximizeBox = false
        }) {
            dialog.HandleCreated += (s, e) => Theme.ApplyWindowChrome(dialog);

            var banner = new Panel { Dock = DockStyle.Top, Height = 74, BackColor = p.WarnSoft, Padding = new Padding(20, 14, 20, 10) };
            var pic = new PictureBox { Image = Art.Themed("alert"), SizeMode = PictureBoxSizeMode.CenterImage, Dock = DockStyle.Left, Width = 34, BackColor = Color.Transparent };
            var head = new Panel { Dock = DockStyle.Fill, Padding = new Padding(10, 0, 0, 0), BackColor = Color.Transparent };
            head.Controls.Add(new Label { Text = I18n.T("warnSubtitle"), ForeColor = p.Text2, BackColor = Color.Transparent, Dock = DockStyle.Fill, AutoEllipsis = true });
            head.Controls.Add(new Label { Text = I18n.T("resourceWarning"), Font = new Font(owner.Font.FontFamily, 11.5f, FontStyle.Bold), ForeColor = p.Warn, BackColor = Color.Transparent, Dock = DockStyle.Top, Height = 24 });
            banner.Controls.Add(head); banner.Controls.Add(pic);

            var body = new Panel { Dock = DockStyle.Fill, Padding = new Padding(18, 12, 18, 10), BackColor = p.WindowBg };
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            // 3 KPI Highlight Cards
            var kpiRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1, Margin = new Padding(0, 0, 0, 10) };
            for (int i = 0; i < 3; i++) kpiRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.3f));
            string needTxt = est != null ? Budget.GB(est.LowBytes) + " – " + Budget.GB(est.HighBytes) : "--";
            string availTxt = res != null && res.TotalMemory > 0 ? Budget.GB(res.AvailableMemory) : "--";
            var topGpu = res == null ? null : res.Gpus.Where(g => g.MemoryTotal > 0 && g.MemoryUsed.HasValue).OrderByDescending(g => g.MemoryTotal - g.MemoryUsed.Value).FirstOrDefault();
            string vramTxt = topGpu != null ? Budget.GB(Math.Max(0, topGpu.MemoryTotal - topGpu.MemoryUsed.Value)) : "--";
            kpiRow.Controls.Add(KpiCard(I18n.T("warnNeed"), needTxt, p.Danger), 0, 0);
            kpiRow.Controls.Add(KpiCard(I18n.T("warnAvail"), availTxt, p.Accent), 1, 0);
            kpiRow.Controls.Add(KpiCard(I18n.T("warnVram"), vramTxt, p.Ink), 2, 0);
            layout.Controls.Add(kpiRow, 0, 0);

            var card = new CardPanel { Dock = DockStyle.Fill, Padding = new Padding(14, 12, 14, 12) };
            var txt = new TextBox {
                Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, BorderStyle = BorderStyle.None,
                BackColor = p.CardBg, ForeColor = p.Text2, ScrollBars = ScrollBars.Vertical,
                Text = (message ?? "").Replace("\r\n", "\n").Replace("\n", "\r\n")
            };
            card.Controls.Add(txt);
            layout.Controls.Add(card, 0, 1);
            body.Controls.Add(layout);

            var footer = FooterPanel();
            var accept = new FluentButton { Text = yes, Primary = true, Width = 128, Height = 36, Margin = new Padding(10, 0, 0, 0) };
            var cancel = new FluentButton { Text = no, Width = 120, Height = 36 };
            accept.Click += (s, e) => { result = true; dialog.Close(); };
            cancel.Click += (s, e) => dialog.Close();
            footer.Controls.Add(accept); footer.Controls.Add(cancel);

            dialog.Controls.Add(body);
            dialog.Controls.Add(banner);
            dialog.Controls.Add(footer);
            dialog.CancelButton = cancel;
            dialog.ShowDialog(owner);
        }
        return result;
    }

    static Control KpiCard(string label, string val, Color valColor) {
        var p = Theme.Current;
        var card = new CardPanel { Dock = DockStyle.Fill, Margin = new Padding(3, 0, 3, 0), Padding = new Padding(10, 8, 10, 8), Radius = 9 };
        var l1 = new Label { Text = label, Dock = DockStyle.Top, Height = 18, ForeColor = p.Muted, BackColor = p.CardBg, Font = new Font("Microsoft YaHei UI", 8f), TextAlign = ContentAlignment.MiddleCenter };
        var l2 = new Label { Text = val, Dock = DockStyle.Fill, ForeColor = valColor, BackColor = p.CardBg, Font = new Font("Consolas", 9.5f, FontStyle.Bold), TextAlign = ContentAlignment.MiddleCenter, AutoEllipsis = true };
        card.Controls.Add(l2); card.Controls.Add(l1);
        return card;
    }

    internal static bool Confirm(Form owner, string title, string message, string yes, string no) {
        bool result = false;
        var p = Theme.Current;
        using (var dialog = CreateStyledDialog(owner, title, I18n.T("warnSubtitle"), message, p.WarnSoft, p.Warn, "alert")) {
            var footer = FooterPanel();
            var accept = new FluentButton { Text = yes, Primary = true, Width = 128, Height = 36, Margin = new Padding(10, 0, 0, 0) };
            var cancel = new FluentButton { Text = no, Width = 120, Height = 36 };
            accept.Click += (s, e) => { result = true; dialog.Close(); };
            cancel.Click += (s, e) => dialog.Close();
            footer.Controls.Add(accept); footer.Controls.Add(cancel);
            dialog.Controls.Add(footer);
            dialog.CancelButton = cancel;
            dialog.ShowDialog(owner);
        }
        return result;
    }

    internal static void Failure(Form owner, string title, string text, string raw, Action log) {
        var p = Theme.Current;
        using (var dialog = CreateStyledDialog(owner, title, I18n.T("failSubtitle"), text, p.DangerSoft, p.Danger, "alert")) {
            var footer = FooterPanel();
            var close = new FluentButton { Text = I18n.T("adjust"), Primary = true, Width = 116, Height = 36, Margin = new Padding(10, 0, 0, 0) };
            var view = new FluentButton { Text = I18n.T("viewLog"), IconName = "logs", Width = 124, Height = 36, Margin = new Padding(10, 0, 0, 0) };
            var copy = new FluentButton { Text = I18n.T("copy"), IconName = "copy", Width = 124, Height = 36 };
            close.Click += (s, e) => dialog.Close();
            view.Click += (s, e) => { dialog.Close(); log(); };
            copy.Click += (s, e) => {
                try { Clipboard.SetText(raw); copy.Text = I18n.T("copied"); } catch (ExternalException) { }
            };
            footer.Controls.Add(close); footer.Controls.Add(view); footer.Controls.Add(copy);
            dialog.Controls.Add(footer);
            dialog.CancelButton = close;
            dialog.ShowDialog(owner);
        }
    }

    internal static void ShowLicenses(Form owner) {
        var p = Theme.Current;
        bool rawOpen = false;
        using (var dialog = new Form {
            Text = I18n.T("licenses"), Font = owner.Font, Icon = owner.Icon,
            ClientSize = new Size(640, 480), MinimumSize = new Size(580, 420),
            StartPosition = FormStartPosition.CenterParent,
            BackColor = p.WindowBg, ForeColor = p.Ink,
            MinimizeBox = false
        }) {
            dialog.HandleCreated += (s, e) => Theme.ApplyWindowChrome(dialog);

            var banner = new Panel { Dock = DockStyle.Top, Height = 68, BackColor = p.AccentSoft, Padding = new Padding(20, 12, 20, 10) };
            var pic = new PictureBox { Image = Art.RawIcon("app-logo", 32) ?? Art.Themed("file"), SizeMode = PictureBoxSizeMode.Zoom, Dock = DockStyle.Left, Width = 34, BackColor = Color.Transparent };
            var head = new Panel { Dock = DockStyle.Fill, Padding = new Padding(10, 0, 0, 0), BackColor = Color.Transparent };
            head.Controls.Add(new Label { Text = I18n.T("licSubtitle"), ForeColor = p.Text2, BackColor = Color.Transparent, Dock = DockStyle.Fill, AutoEllipsis = true });
            head.Controls.Add(new Label { Text = I18n.T("licenses"), Font = new Font(owner.Font.FontFamily, 11.5f, FontStyle.Bold), ForeColor = p.Accent, BackColor = Color.Transparent, Dock = DockStyle.Top, Height = 24 });
            banner.Controls.Add(head); banner.Controls.Add(pic);

            var body = new Panel { Dock = DockStyle.Fill, Padding = new Padding(18, 12, 18, 10), BackColor = p.WindowBg, AutoScroll = true };
            var stack = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 1, RowCount = 5 };
            for (int i = 0; i < 5; i++) stack.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            // Section 1: Core Projects (Highlighted!)
            stack.Controls.Add(new Label { Text = I18n.T("licCoreTitle"), Font = new Font(owner.Font.FontFamily, 9.5f, FontStyle.Bold), ForeColor = p.Ink, AutoSize = true, Margin = new Padding(2, 0, 0, 6) }, 0, 0);

            var coreCard = new CardPanel { Dock = DockStyle.Top, Height = 128, Padding = new Padding(14, 10, 14, 10), Margin = new Padding(0, 0, 0, 12) };
            var coreGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, BackColor = p.CardBg };
            coreGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            coreGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));
            coreGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));
            coreGrid.Controls.Add(new Label { Text = I18n.T("engineCredit"), Dock = DockStyle.Fill, ForeColor = p.Text2, BackColor = p.CardBg }, 0, 0);
            var lEngine = new LinkLabel { Text = "★ PlayCanvas Splat Transform (MIT)  ·  " + App.UpstreamRepository, Dock = DockStyle.Fill, LinkColor = p.Accent, BackColor = p.CardBg, AutoEllipsis = true };
            lEngine.LinkClicked += (s, e) => { try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(App.UpstreamRepository) { UseShellExecute = true }); } catch { } };
            var lApp = new LinkLabel { Text = "★ Splat Convert Desktop (MIT)  ·  " + App.Repository, Dock = DockStyle.Fill, LinkColor = p.Text2, BackColor = p.CardBg, AutoEllipsis = true };
            lApp.LinkClicked += (s, e) => { try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(App.Repository) { UseShellExecute = true }); } catch { } };
            coreGrid.Controls.Add(lEngine, 0, 1);
            coreGrid.Controls.Add(lApp, 0, 2);
            coreCard.Controls.Add(coreGrid);
            stack.Controls.Add(coreCard, 0, 1);

            // Section 2: Compact Bundled Components Summary
            stack.Controls.Add(new Label { Text = I18n.T("licDepsTitle"), Font = new Font(owner.Font.FontFamily, 9.5f, FontStyle.Bold), ForeColor = p.Ink, AutoSize = true, Margin = new Padding(2, 0, 0, 6) }, 0, 2);
            var depsCard = new CardPanel { UseSubCard = true, Dock = DockStyle.Top, Height = 104, Padding = new Padding(14, 10, 14, 10), Margin = new Padding(0, 0, 0, 10) };
            depsCard.Controls.Add(new Label {
                Dock = DockStyle.Fill, ForeColor = p.Text2, BackColor = p.SubCardBg,
                Text = "• PlayCanvas Engine & Splat Transform 3.12.0   [MIT]\n• Node.js 22.23.2 Runtime   [MIT]\n• WebGPU / Google Dawn & DXC   [BSD-3-Clause / Apache-2.0]\n• @adobe/spz & libwebp Codec   [MIT / BSD-3-Clause]    ·    Lucide Icons   [ISC]"
            });
            stack.Controls.Add(depsCard, 0, 3);

            // Section 3: Collapsible Raw License Text (de-emphasized by default!)
            var rawBox = new TextBox {
                Dock = DockStyle.Top, Height = 200, Multiline = true, ReadOnly = true, Visible = false,
                ScrollBars = ScrollBars.Both, WordWrap = false, Font = new Font("Consolas", 8.2f),
                BackColor = p.LogBg, ForeColor = p.Muted, BorderStyle = BorderStyle.FixedSingle
            };
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("licenses.txt"))
            using (var reader = new StreamReader(stream))
                rawBox.Text = reader.ReadToEnd().Replace("\r\n", "\n").Replace("\n", "\r\n");
            stack.Controls.Add(rawBox, 0, 4);

            body.Controls.Add(stack);

            var footer = FooterPanel();
            var btnClose = new FluentButton { Text = I18n.T("close"), Primary = true, Width = 104, Height = 36, Margin = new Padding(10, 0, 0, 0) };
            var btnRaw = new FluentButton { Text = I18n.T("licShowRaw"), Width = 186, Height = 36 };
            btnClose.Click += (s, e) => dialog.Close();
            btnRaw.Click += (s, e) => {
                rawOpen = !rawOpen;
                rawBox.Visible = rawOpen;
                btnRaw.Text = I18n.T(rawOpen ? "licHideRaw" : "licShowRaw");
                dialog.ClientSize = new Size(dialog.ClientSize.Width, rawOpen ? 640 : 480);
            };
            footer.Controls.Add(btnClose); footer.Controls.Add(btnRaw);

            dialog.Controls.Add(body);
            dialog.Controls.Add(banner);
            dialog.Controls.Add(footer);
            dialog.CancelButton = btnClose;
            dialog.ShowDialog(owner);
        }
    }

    static Form CreateStyledDialog(Form owner, string title, string subtitle, string message, Color bannerBg, Color bannerFg, string icon) {
        var p = Theme.Current;
        var dialog = new Form {
            Text = title, Font = owner.Font, Icon = owner.Icon,
            ClientSize = new Size(600, 400), MinimumSize = new Size(540, 340),
            StartPosition = FormStartPosition.CenterParent,
            BackColor = p.WindowBg, ForeColor = p.Ink,
            MinimizeBox = false, MaximizeBox = false
        };
        dialog.HandleCreated += (s, e) => Theme.ApplyWindowChrome(dialog);

        var banner = new Panel { Dock = DockStyle.Top, Height = 72, BackColor = bannerBg, Padding = new Padding(20, 14, 20, 10) };
        var pic = new PictureBox { Image = Art.Themed(icon), SizeMode = PictureBoxSizeMode.CenterImage, Dock = DockStyle.Left, Width = 34, BackColor = Color.Transparent };
        var head = new Panel { Dock = DockStyle.Fill, Padding = new Padding(10, 0, 0, 0), BackColor = Color.Transparent };
        head.Controls.Add(new Label { Text = subtitle, ForeColor = p.Text2, BackColor = Color.Transparent, Dock = DockStyle.Fill, AutoEllipsis = true });
        head.Controls.Add(new Label { Text = title, Font = new Font(owner.Font.FontFamily, 11.5f, FontStyle.Bold), ForeColor = bannerFg, BackColor = Color.Transparent, Dock = DockStyle.Top, Height = 24, AutoEllipsis = true });
        banner.Controls.Add(head); banner.Controls.Add(pic);

        var bodyHost = new Panel { Dock = DockStyle.Fill, Padding = new Padding(18, 14, 18, 12), BackColor = p.WindowBg };
        var card = new CardPanel { Dock = DockStyle.Fill, Padding = new Padding(14) };
        var txt = new TextBox {
            Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, BorderStyle = BorderStyle.None,
            BackColor = p.CardBg, ForeColor = p.Ink, ScrollBars = ScrollBars.Vertical,
            Text = (message ?? "").Replace("\r\n", "\n").Replace("\n", "\r\n")
        };
        card.Controls.Add(txt);
        bodyHost.Controls.Add(card);

        dialog.Controls.Add(bodyHost);
        dialog.Controls.Add(banner);
        return dialog;
    }

    static FlowLayoutPanel FooterPanel() {
        return new FlowLayoutPanel {
            Dock = DockStyle.Bottom, Height = 60, FlowDirection = FlowDirection.RightToLeft,
            Padding = new Padding(18, 11, 18, 11), WrapContents = false, BackColor = Theme.Current.TitleBarBg
        };
    }
}

static class StarPrompt {
    internal static bool TryClaim(string marker = null) {
        marker = marker ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SplatConvertDesktop", "star-prompt-shown-v2");
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(marker));
            using (var stream = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                byte[] bytes = System.Text.Encoding.UTF8.GetBytes(DateTime.UtcNow.ToString("O")); stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
            }
            return true;
        } catch (IOException) { return false; } catch (UnauthorizedAccessException) { return false; }
    }
}

sealed class StepDialog : Form {
    readonly FluentDropdown type = new FluentDropdown { Dock = DockStyle.Top };
    readonly Label hintLabel = new Label { Dock = DockStyle.Top, Height = 42, AutoEllipsis = true };
    readonly TableLayoutPanel values = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 6 };
    readonly List<Control> edits = new List<Control>();
    internal Op Result;

    internal StepDialog(Form owner, Op op) {
        var p = Theme.Current;
        Text = I18n.T(op == null ? "addOp" : "edit");
        Icon = owner != null ? owner.Icon : SystemIcons.Application;
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MinimizeBox = MaximizeBox = false;
        ClientSize = new Size(470, 395);
        Padding = new Padding(18);
        Font = new Font("Microsoft YaHei UI", 9F);
        BackColor = p.WindowBg; ForeColor = p.Ink;
        HandleCreated += (s, e) => Theme.ApplyWindowChrome(this);

        hintLabel.ForeColor = p.Muted;
        hintLabel.Padding = new Padding(0, 8, 0, 4);

        values.Padding = new Padding(0, 6, 0, 0);
        values.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 145));
        values.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (int i = 0; i < 6; i++) values.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 46, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 8, 0, 0) };
        var ok = new FluentButton { Text = I18n.T("ok"), Primary = true, Width = 104, Height = 34, Margin = new Padding(8, 0, 0, 0) };
        var cancel = new FluentButton { Text = I18n.T("cancel"), Width = 104, Height = 34, DialogResult = DialogResult.Cancel };
        buttons.Controls.Add(ok); buttons.Controls.Add(cancel);
        AcceptButton = ok; CancelButton = cancel;

        Controls.Add(values);
        Controls.Add(hintLabel);
        Controls.Add(type);
        Controls.Add(buttons);

        type.SetItems(Step.All.Cast<object>(), op == null ? 0 : Array.IndexOf(Step.All, op.Step));
        type.SelectedIndexChanged += (s, e) => Fields(null);
        Fields(op == null ? null : op.Value);
        ok.Click += (s, e) => Save();
    }

    static string StepHint(string flag) {
        var entry = BeginnerTips.Get(BeginnerTips.KeyForStepFlag(flag));
        return entry != null ? entry.Summary : "";
    }

    void Fields(string previous) {
        var p = Theme.Current;
        while (values.Controls.Count > 0) values.Controls[0].Dispose();
        edits.Clear();
        var step = (Step)type.SelectedItem;
        if (step == null) return;
        hintLabel.Text = StepHint(step.Flag);
        if (step.Fields == "") return;
        string[] fields = step.Fields.Split(','), data = (String.IsNullOrEmpty(previous) ? step.Defaults : previous).Split(',');
        for (int i = 0; i < fields.Length; i++) {
            var label = new Label { Text = fields[i], AutoSize = true, Margin = new Padding(0, 8, 0, 0), ForeColor = p.Ink };
            values.Controls.Add(label, 0, i);
            string val = i < data.Length ? data[i] : "";
            if (step.Flag == "--filter-harmonics") {
                var slider = new FluentSlider { Minimum = 0, Maximum = 3, Value = Int32.Parse(val), Dock = DockStyle.Fill };
                slider.ValueChanged += (s, e) => label.Text = I18n.T("band") + ": " + slider.Value;
                label.Text = I18n.T("band") + ": " + slider.Value;
                values.Controls.Add(slider, 1, i);
                edits.Add(slider);
            } else {
                var box = new FluentInputBox { Dock = DockStyle.Fill };
                box.Inner.Text = val;
                box.ApplyTheme();
                values.Controls.Add(box, 1, i);
                edits.Add(box.Inner);
            }
        }
    }

    void Save() {
        var step = (Step)type.SelectedItem; var numbers = new List<double>();
        foreach (Control control in edits) {
            if (control is FluentSlider) { numbers.Add(((FluentSlider)control).Value); continue; }
            double number;
            if (!Double.TryParse(control.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out number) || Double.IsNaN(number) || Double.IsInfinity(number)) { Invalid(control); return; }
            numbers.Add(number);
        }
        if ((step.Flag == "--scale" || step.Flag == "--filter-sphere") && numbers.Last() <= 0) { Invalid(edits.Last()); return; }
        if ((step.Flag == "--filter-floaters" || step.Flag == "--filter-cluster") && numbers.Any(n => n <= 0)) { Invalid(edits[0]); return; }
        if (step.Flag == "--filter-box" && Enumerable.Range(0, 3).Any(i => numbers[i] > numbers[i + 3])) { Invalid(edits[0]); return; }
        Result = new Op { Step = step, Value = String.Join(",", numbers.Select(n => n.ToString("R", CultureInfo.InvariantCulture))), Enabled = true };
        DialogResult = DialogResult.OK;
    }

    void Invalid(Control control) { MessageBox.Show(this, I18n.T("numeric"), I18n.T("invalid")); control.Focus(); }
}
