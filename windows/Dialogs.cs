using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class MessageDialog {
    internal static bool StarCelebration(Form owner, string summaryText) {
        bool openRepo = false;
        var p = Theme.Current;
        using (var dialog = new Form {
            Text = "转换完成",
            Font = owner.Font,
            ClientSize = new Size(530, 355),
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterParent,
            BackColor = p.WindowBg, ForeColor = p.Ink,
            MinimizeBox = false, MaximizeBox = false
        }) {
            dialog.HandleCreated += (s, e) => Theme.ApplyWindowChrome(dialog);

            // Top celebratory banner
            var banner = new Panel { Dock = DockStyle.Top, Height = 82, BackColor = p.AccentSoft, Padding = new Padding(22, 16, 22, 12) };
            var iconPic = new PictureBox { Image = Art.Themed("star"), SizeMode = PictureBoxSizeMode.CenterImage, Dock = DockStyle.Left, Width = 38 };
            var titleBox = new Panel { Dock = DockStyle.Fill, Padding = new Padding(8, 2, 0, 0) };
            var lblTitle = new Label { Text = "首次转换大功告成！", Font = new Font(owner.Font.FontFamily, 12.5f, FontStyle.Bold), ForeColor = p.Accent, Dock = DockStyle.Top, Height = 26 };
            var lblSub = new Label { Text = String.IsNullOrWhiteSpace(summaryText) ? "你的 3D 高斯场景已成功处理并保存到本地。" : summaryText, ForeColor = p.Text2, Dock = DockStyle.Fill, AutoEllipsis = true };
            titleBox.Controls.Add(lblSub); titleBox.Controls.Add(lblTitle);
            banner.Controls.Add(titleBox); banner.Controls.Add(iconPic);

            // Body card
            var bodyHost = new Panel { Dock = DockStyle.Fill, Padding = new Padding(20, 14, 20, 10) };
            var bodyCard = new CardPanel { Dock = DockStyle.Fill, Padding = new Padding(16, 12, 16, 12) };
            var msg = new Label {
                Dock = DockStyle.Fill, ForeColor = p.Text2,
                Text = "Splat Convert Desktop 是免费开源、纯本地运行的桌面图形化工具；其核心 3D 高斯压缩、格式转换与清洗算法由 PlayCanvas 团队开源的底层引擎 @playcanvas/splat-transform 提供。\n\n衷心感谢 PlayCanvas 原作者及社区贡献者的杰出工作！如果本工具帮到了你，欢迎分别为本桌面端项目与上游引擎项目点亮 Star 支持开源发展（本提示仅出现一次）："
            };
            var upstreamLink = new LinkLabel {
                Text = "上游压缩引擎项目：https://github.com/playcanvas/splat-transform",
                Dock = DockStyle.Bottom, Height = 24, LinkColor = p.Accent, ActiveLinkColor = p.AccentHover, AutoEllipsis = true
            };
            upstreamLink.LinkClicked += (s, e) => {
                try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(App.UpstreamRepository) { UseShellExecute = true }); } catch { }
            };
            bodyCard.Controls.Add(msg);
            bodyCard.Controls.Add(upstreamLink);
            bodyHost.Controls.Add(bodyCard);

            // Bottom action bar
            var footer = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 58, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(20, 10, 20, 12), BackColor = p.TitleBarBg };
            var btnStar = new FluentButton { Text = "去 GitHub 点 Star 支持", IconName = "star", Primary = true, Width = 178, Height = 36, Margin = new Padding(8, 0, 0, 0) };
            var btnLater = new FluentButton { Text = "下次再说", Width = 104, Height = 36 };
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

    internal static bool Confirm(Form owner, string title, string message, string yes, string no) {
        bool result = false;
        var p = Theme.Current;
        using (var dialog = CreateStyledDialog(owner, title, "请在继续前确认以下提醒", message, p.WarnSoft, p.Warn, "alert")) {
            var footer = FooterPanel();
            var accept = new FluentButton { Text = yes, Primary = true, Width = 128, Height = 36, Margin = new Padding(8, 0, 0, 0) };
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
        using (var dialog = CreateStyledDialog(owner, title, "转换未能完成，以下是定位到的原因与建议排查方案：", text, p.DangerSoft, p.Danger, "alert")) {
            var footer = FooterPanel();
            var close = new FluentButton { Text = I18n.T("adjust"), Primary = true, Width = 116, Height = 36, Margin = new Padding(8, 0, 0, 0) };
            var view = new FluentButton { Text = I18n.T("viewLog"), IconName = "logs", Width = 124, Height = 36, Margin = new Padding(8, 0, 0, 0) };
            var copy = new FluentButton { Text = I18n.T("copy"), IconName = "copy", Width = 124, Height = 36 };
            close.Click += (s, e) => dialog.Close();
            view.Click += (s, e) => { dialog.Close(); log(); };
            copy.Click += (s, e) => {
                try { Clipboard.SetText(raw); copy.Text = "已复制 ✓"; } catch (ExternalException) { }
            };
            footer.Controls.Add(close); footer.Controls.Add(view); footer.Controls.Add(copy);
            dialog.Controls.Add(footer);
            dialog.CancelButton = close;
            dialog.ShowDialog(owner);
        }
    }

    static Form CreateStyledDialog(Form owner, string title, string subtitle, string message, Color bannerBg, Color bannerFg, string icon) {
        var p = Theme.Current;
        var dialog = new Form {
            Text = title, Font = owner.Font,
            ClientSize = new Size(620, 420), MinimumSize = new Size(560, 360),
            StartPosition = FormStartPosition.CenterParent,
            BackColor = p.WindowBg, ForeColor = p.Ink,
            MinimizeBox = false, MaximizeBox = false
        };
        dialog.HandleCreated += (s, e) => Theme.ApplyWindowChrome(dialog);

        var banner = new Panel { Dock = DockStyle.Top, Height = 72, BackColor = bannerBg, Padding = new Padding(20, 14, 20, 10) };
        var pic = new PictureBox { Image = Art.Themed(icon), SizeMode = PictureBoxSizeMode.CenterImage, Dock = DockStyle.Left, Width = 34 };
        var head = new Panel { Dock = DockStyle.Fill, Padding = new Padding(8, 0, 0, 0) };
        var l1 = new Label { Text = title, Font = new Font(owner.Font.FontFamily, 11.5f, FontStyle.Bold), ForeColor = bannerFg, Dock = DockStyle.Top, Height = 24, AutoEllipsis = true };
        var l2 = new Label { Text = subtitle, ForeColor = p.Text2, Dock = DockStyle.Fill, AutoEllipsis = true };
        head.Controls.Add(l2); head.Controls.Add(l1);
        banner.Controls.Add(head); banner.Controls.Add(pic);

        var bodyHost = new Panel { Dock = DockStyle.Fill, Padding = new Padding(18, 14, 18, 12) };
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
            Dock = DockStyle.Bottom, Height = 58, FlowDirection = FlowDirection.RightToLeft,
            Padding = new Padding(18, 10, 18, 12), WrapContents = false, BackColor = Theme.Current.TitleBarBg
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
    readonly DisplayCombo type = new DisplayCombo { Dock = DockStyle.Top };
    readonly Label hintLabel = new Label { Dock = DockStyle.Top, Height = 40, AutoEllipsis = true };
    readonly TableLayoutPanel values = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 6 };
    readonly List<Control> edits = new List<Control>();
    internal Op Result;

    internal StepDialog(Op op) {
        var p = Theme.Current;
        Text = I18n.T(op == null ? "addOp" : "edit");
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MinimizeBox = MaximizeBox = false;
        ClientSize = new Size(470, 390);
        Padding = new Padding(18);
        Font = new Font("Microsoft YaHei UI", 9F);
        BackColor = p.WindowBg; ForeColor = p.Ink;
        HandleCreated += (s, e) => Theme.ApplyWindowChrome(this);

        type.BackColor = p.InputBg; type.ForeColor = p.Ink;
        hintLabel.ForeColor = p.Muted;
        hintLabel.Padding = new Padding(0, 6, 0, 4);

        values.Padding = new Padding(0, 6, 0, 0);
        values.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 145));
        values.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (int i = 0; i < 6; i++) values.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 44, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 6, 0, 0) };
        var ok = new FluentButton { Text = I18n.T("ok"), Primary = true, Width = 104, Height = 34, Margin = new Padding(8, 0, 0, 0) };
        var cancel = new FluentButton { Text = I18n.T("cancel"), Width = 104, Height = 34, DialogResult = DialogResult.Cancel };
        buttons.Controls.Add(ok); buttons.Controls.Add(cancel);
        AcceptButton = ok; CancelButton = cancel;

        Controls.Add(values);
        Controls.Add(hintLabel);
        Controls.Add(type);
        Controls.Add(buttons);

        type.Items.AddRange(Step.All);
        type.SelectedIndexChanged += (s, e) => Fields(null);
        type.SelectedItem = op == null ? Step.All[0] : op.Step;
        if (op != null) Fields(op.Value);
        ok.Click += (s, e) => Save();
    }

    static string StepHint(string flag) {
        if (flag == "--filter-nan") return "自动清除坐标异常、NaN 或旋转为零的坏点，无需额外参数。";
        if (flag == "--filter-floaters") return "GPU 体素化检测并清除漂浮在空中的噪点飞点（默认 0.05, 0.1, 0.004）。";
        if (flag == "--filter-cluster") return "只保留与场景主体连通的高斯簇，过滤远处孤立杂物。";
        if (flag == "--filter-harmonics") return "限制球谐阶数：0 阶只保留基础色，1 阶兼顾体积与反光，3 阶最完整。";
        if (flag == "--rotate") return "按 X / Y / Z 轴旋转角度（度），手机扫描倒置通常需绕 X 轴旋转 ±90 或 180。";
        if (flag == "--scale") return "等比缩放场景尺寸（例如 0.5 缩小一半，2 放大一倍）。";
        if (flag == "--translate") return "沿 X / Y / Z 轴平移场景坐标位置。";
        if (flag == "--filter-box") return "只保留指定最小/最大 XYZ 立方体范围内的点云，裁掉多余背景。";
        return "只保留以中心 XYZ 为球心、指定半径以内的点云。";
    }

    void Fields(string previous) {
        var p = Theme.Current;
        while (values.Controls.Count > 0) values.Controls[0].Dispose();
        edits.Clear();
        var step = (Step)type.SelectedItem;
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
