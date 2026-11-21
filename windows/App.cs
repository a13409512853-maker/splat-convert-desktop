using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

static class App {
    internal const string Repository = "https://github.com/a13409512853-maker/splat-convert-desktop";
    internal const string UpstreamRepository = "https://github.com/playcanvas/splat-transform";
    [STAThread] static int Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (args.Length == 2 && args[0] == "--ui-test") return Smoke.Layout(args[1]);
        if (args.Length == 2 && args[0] == "--health-test") {
            Directory.CreateDirectory(args[1]);
            using (var log = new StreamWriter(Path.Combine(args[1], "health-tests.log"))) {
                try { HealthTests.Run(args[1], log.WriteLine); return 0; }
                catch (Exception ex) { log.WriteLine(ex); return 1; }
            }
        }
        if (args.Length == 2 && args[0] == "--self-test") return Smoke.Run(args[1]);
        I18n.Restore();
        Theme.Restore();
        using (var win = new MainWindow(args)) Application.Run(win);
        return 0;
    }
}

static class Art {
    static readonly Dictionary<string, Image> Images = new Dictionary<string, Image>();
    internal static Image Icon(string name) {
        Image image;
        if (!Images.TryGetValue(name, out image)) {
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("icon." + name + ".png")) {
                if (stream == null) return null;
                using (var original = Image.FromStream(stream)) image = new Bitmap(original, 18, 18);
            }
            Images[name] = image;
        }
        return image;
    }
    internal static Image RawIcon(string name, int size) {
        string key = name + "@" + size;
        Image image;
        if (!Images.TryGetValue(key, out image)) {
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("icon." + name + ".png")) {
                if (stream == null) return null;
                using (var original = Image.FromStream(stream)) image = new Bitmap(original, size, size);
            }
            Images[key] = image;
        }
        return image;
    }
    internal static Image Themed(string baseName) {
        return Icon(Theme.Current.IsDark ? baseName + "-white" : baseName) ?? Icon(baseName);
    }
}

sealed class DisplayCombo : ComboBox {
    internal DisplayCombo() {
        DropDownStyle = ComboBoxStyle.DropDownList; DrawMode = DrawMode.OwnerDrawFixed;
        ItemHeight = Font.Height + 7;
    }
    protected override void OnFontChanged(EventArgs e) { base.OnFontChanged(e); ItemHeight = Font.Height + 7; }
    protected override void OnDrawItem(DrawItemEventArgs e) {
        var p = Theme.Current;
        bool selected = (e.State & DrawItemState.Selected) == DrawItemState.Selected;
        using (var bg = new SolidBrush(selected ? p.AccentSoft : p.InputBg))
            e.Graphics.FillRectangle(bg, e.Bounds);
        if (e.Index >= 0 && e.Index < Items.Count)
            TextRenderer.DrawText(e.Graphics, GetItemText(Items[e.Index]), Font, Rectangle.Inflate(e.Bounds, -6, 0),
                selected ? p.Accent : p.Ink, TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        base.OnDrawItem(e);
    }
    protected override void WndProc(ref Message message) {
        base.WndProc(ref message);
        if (message.Msg == 0x318 && message.WParam != IntPtr.Zero) {
            using (var graphics = Graphics.FromHdc(message.WParam)) {
                var p = Theme.Current;
                var rectangle = new Rectangle(3, 2, Math.Max(0, ClientSize.Width - SystemInformation.VerticalScrollBarWidth - 6), Math.Max(0, ClientSize.Height - 4));
                using (var brush = new SolidBrush(p.InputBg)) graphics.FillRectangle(brush, rectangle);
                TextRenderer.DrawText(graphics, Text, Font, rectangle, Enabled ? p.Ink : p.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
            }
        }
    }
}

sealed class Knob : UserControl {
    internal readonly FluentSlider Track;
    readonly Label label, value;
    readonly string key;
    readonly Func<int, string> format;
    internal int Value { get { return Track.Value; } set { Track.Value = Math.Max(Track.Minimum, Math.Min(Track.Maximum, value)); } }
    internal Knob(string key, int min, int max, int initial, Func<int, string> format) {
        this.key = key; this.format = format; Height = 46; Margin = Padding.Empty;
        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, Margin = Padding.Empty };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 72));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 28));
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 20));
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));
        label = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.BottomLeft, AutoEllipsis = true, UseMnemonic = false, Font = new Font("Microsoft YaHei UI", 8.6f) };
        value = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.BottomRight, AutoEllipsis = true, Font = new Font("Consolas", 8.8f, FontStyle.Bold) };
        Track = new FluentSlider { Minimum = min, Maximum = max, Value = initial, Dock = DockStyle.Fill, AccessibleName = key };
        Track.ValueChanged += (s, e) => value.Text = format(Track.Value);
        grid.Controls.Add(label, 0, 0); grid.Controls.Add(value, 1, 0);
        grid.Controls.Add(Track, 0, 1); grid.SetColumnSpan(Track, 2);
        Controls.Add(grid); Translate(); ApplyTheme();
    }
    internal void Translate() { label.Text = I18n.T(key); value.Text = format(Track.Value); }
    internal void ApplyTheme() {
        var p = Theme.Current;
        BackColor = p.SubCardBg;
        label.ForeColor = p.Ink;
        value.ForeColor = p.Accent;
        Track.Invalidate();
    }
    internal void BindTip(Action<Control, string> attach, string tipKey) {
        attach(this, tipKey); attach(label, tipKey); attach(value, tipKey); attach(Track, tipKey);
    }
}

sealed class MainWindow : Form {
    internal static Color Ink { get { return Theme.Current.Ink; } }
    internal static Color Teal { get { return Theme.Current.Accent; } }
    internal static Color Muted { get { return Theme.Current.Muted; } }
    internal static Color Line { get { return Theme.Current.Border; } }
    internal static Color Paper { get { return Theme.Current.WindowBg; } }

    readonly Converter converter = new Converter();
    readonly ResourceMonitor monitor = new ResourceMonitor();
    readonly TelemetryHistory telemetry = new TelemetryHistory();
    readonly BeginnerTipPopup tipPopup = new BeginnerTipPopup();
    readonly TelemetryChartPopup chartPopup = new TelemetryChartPopup();

    readonly List<InputFile> inputs = new List<InputFile>();
    readonly List<Op> outputOps = new List<Op>();
    readonly FluentFileList fileList = new FluentFileList();
    readonly FluentOpList opList = new FluentOpList();
    readonly ComboBox scope = Combo(), formats = Combo(), language = Combo();
    readonly FluentInputBox outputBox = new FluentInputBox();
    readonly TextBox logView = new TextBox();
    readonly Label status = new Label(), tally = new Label(), outputLabel = new Label();
    readonly Label progressPctLabel = new Label(), etaLabel = new Label(), elapsedLabel = new Label();
    readonly ModernProgressBar progressBar = new ModernProgressBar();
    readonly SegmentedControl modeSegment = new SegmentedControl();
    readonly SegmentedControl presetSegment = new SegmentedControl();
    readonly SegmentedControl deviceSegment = new SegmentedControl();
    readonly ToolTip tips = new ToolTip();
    readonly ConcurrentQueue<string> events = new ConcurrentQueue<string>();
    readonly System.Windows.Forms.Timer ticker = new System.Windows.Forms.Timer { Interval = 250 };
    readonly List<Action> translations = new List<Action>();
    readonly List<Action> themeUpdaters = new List<Action>();
    readonly FluentMetricTile[] metricTiles = new FluentMetricTile[4];
    readonly Knob keep, iterations, effort, workers, voxel, opacity;
    readonly CheckBox chkAdaptive = new CheckBox();
    readonly TableLayoutPanel workspace;
    readonly Panel headerPanel, footerPanel, resourceBar, logDrawer;
    readonly CardPanel sliderGroupCard;
    readonly FluentButton start, cancel, reveal, btnEngine, btnTheme, btnLogToggle;
    readonly LinkLabel repository = new LinkLabel();
    CancellationTokenSource active;
    bool autoPath = true, updatingPath, closing, sampling, changing, batchMode = false, logsExpanded = false;
    DateTime nextSample = DateTime.MinValue;
    ResourceSnapshot resources;
    string completed, statusKey = "ready", activeHoverMetric = null;

    internal string PromptMarker;
    internal Action PromptOverride;
    internal Action<Diagnostic, string> ErrorOverride;
    internal Func<string, bool> WarningOverride;
    internal Func<ResourceSnapshot> ResourceOverride;
    internal ResourceSnapshot LastResources { get { return resources; } }

    internal MainWindow(string[] paths) {
        Font = new Font("Microsoft YaHei UI", 9F);
        AutoScaleMode = AutoScaleMode.Dpi;
        MinimumSize = new Size(1160, 740);
        Size = new Size(1320, 820);
        StartPosition = FormStartPosition.CenterScreen;
        Text = "Splat Convert Desktop 2.0.0";
        try { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application; } catch { Icon = SystemIcons.Application; }

        // Seed default helpful beginner pipeline ops (user can toggle/edit/remove)
        outputOps.Add(new Op { Step = Step.All[3], Value = "", Enabled = true });   // NaN clean
        outputOps.Add(new Op { Step = Step.All[7], Value = "0.05,0.1,0.004", Enabled = false }); // Filter floaters
        outputOps.Add(new Op { Step = Step.All[4], Value = "1", Enabled = false }); // SH <= 1

        var root = Grid(1, 5);
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 56));   // Top Fluent Header
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));   // Proposal C 3-Column Pipeline
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // Collapsible Log Drawer
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 88));   // Progress + ETA + Action Footer
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));   // Bottom 0.5s Telemetry Tiles

        // ===== Header Bar (Matches Design Mockup Top Bar) =====
        headerPanel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(18, 0, 18, 0) };
        var logoBadge = new PictureBox {
            Image = Art.RawIcon("app-logo", 28), SizeMode = PictureBoxSizeMode.Zoom,
            Width = 28, Height = 28, Location = new Point(18, 14), BackColor = Color.Transparent
        };
        var brand = new Label {
            Text = "Splat Convert Desktop", Font = new Font(Font.FontFamily, 12.5f, FontStyle.Bold),
            Location = new Point(54, 15), AutoSize = true
        };
        var verBadge = new Label {
            Text = "v2.0", Font = new Font(Font.FontFamily, 8f, FontStyle.Bold),
            Location = new Point(252, 19), AutoSize = true, Padding = new Padding(5, 2, 5, 2)
        };
        btnEngine = new FluentButton {
            Width = 216, Height = 28, Pill = true, SoftAccent = true,
            Location = new Point(304, 14), Font = new Font(Font.FontFamily, 8.2f, FontStyle.Bold)
        };
        btnEngine.Click += (s, e) => OpenEngineUpdater();
        AttachTip(btnEngine, "engine");

        var rightHeader = new FlowLayoutPanel { Dock = DockStyle.Right, Width = 280, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 12, 0, 10), WrapContents = false };
        language.Items.AddRange(I18n.Names);
        language.SelectedIndex = Array.IndexOf(I18n.Codes, I18n.Language);
        language.AccessibleName = "language";
        language.Width = 118;
        btnTheme = new FluentButton { Width = 104, Height = 30, Margin = new Padding(0, 1, 10, 0) };
        btnTheme.Click += (s, e) => { Theme.Toggle(); ApplyThemeAll(); };
        rightHeader.Controls.Add(language);
        rightHeader.Controls.Add(btnTheme);

        headerPanel.Controls.Add(logoBadge);
        headerPanel.Controls.Add(brand);
        headerPanel.Controls.Add(verBadge);
        headerPanel.Controls.Add(btnEngine);
        headerPanel.Controls.Add(rightHeader);
        themeUpdaters.Add(() => {
            var p = Theme.Current;
            headerPanel.BackColor = p.TitleBarBg;
            logoBadge.BackColor = Color.Transparent;
            brand.ForeColor = p.Ink;
            verBadge.BackColor = p.SubCardBg; verBadge.ForeColor = p.Muted;
            btnEngine.Text = "● 引擎 v" + EngineManager.ActiveVersion + " · 国内镜像就绪";
            btnTheme.Text = I18n.T(p.IsDark ? "themeLight" : "themeDark");
        });
        root.Controls.Add(headerPanel, 0, 0);

        // ===== Proposal C: 3-Column Pipeline Flow (01 Inputs -> 02 Clean & Transform -> 03 Output & Compress) =====
        workspace = Grid(3, 1);
        workspace.Padding = new Padding(16, 12, 16, 10);
        workspace.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 32f));
        workspace.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33f));
        workspace.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 35f));

        // --- Column 1: 01 源文件 ---
        var col1Card = new CardPanel { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 7, 0) };
        var col1 = Grid(1, 3);
        col1.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        col1.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        col1.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        var col1Head = Grid(2, 1);
        col1Head.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 48));
        col1Head.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 52));
        var col1TitleWrap = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty, Padding = new Padding(0, 4, 0, 0) };
        col1TitleWrap.Controls.Add(StepTitle("01", "inputs"));
        tally.AutoSize = true; tally.Margin = new Padding(4, 5, 0, 0); tally.Font = new Font(Font.FontFamily, 8.2f);
        col1TitleWrap.Controls.Add(tally);
        col1Head.Controls.Add(col1TitleWrap, 0, 0);
        modeSegment.Dock = DockStyle.Fill; modeSegment.Margin = new Padding(0, 3, 0, 3);
        modeSegment.SelectedIndexChanged += (s, e) => SetBatchMode(modeSegment.SelectedIndex == 0);
        AttachTip(modeSegment, "mode");
        col1Head.Controls.Add(modeSegment, 1, 0);
        col1.Controls.Add(col1Head, 0, 0);

        var fileTools = Grid(4, 1);
        fileTools.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        fileTools.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 36));
        fileTools.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 36));
        fileTools.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 36));
        var btnAdd = ButtonOf("add", "add", "plus", 140, BrowseInputs); btnAdd.Dock = DockStyle.Fill; btnAdd.Margin = new Padding(0, 2, 6, 4);
        var btnUp = ButtonOf(null, "up", "up", 32, () => MoveFile(-1)); btnUp.Dock = DockStyle.Fill; btnUp.Margin = new Padding(0, 2, 4, 4);
        var btnDn = ButtonOf(null, "down", "down", 32, () => MoveFile(1)); btnDn.Dock = DockStyle.Fill; btnDn.Margin = new Padding(0, 2, 4, 4);
        var btnClr = ButtonOf(null, "remove", "minus", 32, RemoveFiles); btnClr.Dock = DockStyle.Fill; btnClr.Margin = new Padding(0, 2, 0, 4);
        fileTools.Controls.Add(btnAdd, 0, 0); fileTools.Controls.Add(btnUp, 1, 0); fileTools.Controls.Add(btnDn, 2, 0); fileTools.Controls.Add(btnClr, 3, 0);
        col1.Controls.Add(fileTools, 0, 1);

        fileList.Dock = DockStyle.Fill;
        fileList.DragEnter += (s, e) => { if (active == null && e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy; };
        fileList.DragDrop += (s, e) => AddFiles((string[])e.Data.GetData(DataFormats.FileDrop));
        fileList.AddRequested += BrowseInputs;
        fileList.DeleteRequested += idx => { if (idx >= 0 && idx < inputs.Count) { inputs.RemoveAt(idx); RefreshFiles(-1); } };
        fileList.SelectedIndexChanged += (s, e) => { if (!changing && fileList.SelectedIndex >= 0) scope.SelectedIndex = fileList.SelectedIndex + 1; };
        col1.Controls.Add(fileList, 0, 2);
        col1Card.Controls.Add(col1);
        workspace.Controls.Add(col1Card, 0, 0);

        // --- Column 2: 02 清洗与变换管线 ---
        var col2Card = new CardPanel { Dock = DockStyle.Fill, Margin = new Padding(7, 0, 7, 0) };
        var col2 = Grid(1, 3);
        col2.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        col2.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        col2.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        var col2Head = Grid(2, 1);
        col2Head.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 58));
        col2Head.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 42));
        col2Head.Controls.Add(StepTitle("02", "actions"), 0, 0);
        var btnAddOp = ButtonOf("addOp", "addOp", "plus", 112, () => EditOp(false));
        btnAddOp.Dock = DockStyle.Right; btnAddOp.Margin = new Padding(0, 2, 0, 2);
        col2Head.Controls.Add(btnAddOp, 1, 0);
        col2.Controls.Add(col2Head, 0, 0);

        var opBar = Grid(5, 1);
        opBar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        opBar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 34));
        opBar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 34));
        opBar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 34));
        opBar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 34));
        scope.Items.Add(""); scope.SelectedIndex = 0; scope.AccessibleName = "scope"; scope.Margin = new Padding(0, 4, 6, 4);
        scope.SelectedIndexChanged += (s, e) => { if (!changing) RefreshOps(-1); };
        var bEdit = ButtonOf(null, "edit", "edit", 30, () => EditOp(true)); bEdit.Dock = DockStyle.Fill; bEdit.Margin = new Padding(0, 2, 4, 4);
        var bRem = ButtonOf(null, "remove", "minus", 30, () => { int i = opList.SelectedIndex; if (i >= 0) { CurrentOps().RemoveAt(i); RefreshOps(i); } }); bRem.Dock = DockStyle.Fill; bRem.Margin = new Padding(0, 2, 4, 4);
        var bUp = ButtonOf(null, "up", "up", 30, () => MoveOp(-1)); bUp.Dock = DockStyle.Fill; bUp.Margin = new Padding(0, 2, 4, 4);
        var bDn = ButtonOf(null, "down", "down", 30, () => MoveOp(1)); bDn.Dock = DockStyle.Fill; bDn.Margin = new Padding(0, 2, 0, 4);
        opBar.Controls.Add(scope, 0, 0); opBar.Controls.Add(bEdit, 1, 0); opBar.Controls.Add(bRem, 2, 0); opBar.Controls.Add(bUp, 3, 0); opBar.Controls.Add(bDn, 4, 0);
        col2.Controls.Add(opBar, 0, 1);

        opList.Dock = DockStyle.Fill;
        opList.ToggleEnabledRequested += idx => {
            var ops = CurrentOps();
            if (idx >= 0 && idx < ops.Count) { ops[idx].Enabled = !ops[idx].Enabled; RefreshOps(idx); FormatVisibility(); }
        };
        opList.EditRequested += idx => { opList.SelectedIndex = idx; EditOp(true); };
        opList.HoverOpChanged += idx => {
            var ops = CurrentOps();
            if (idx < 0 || idx >= ops.Count) { tipPopup.Hide(); return; }
            string flag = ops[idx].Step.Flag;
            string key = flag == "--filter-nan" ? "nan" : flag == "--filter-floaters" ? "floaters" : flag == "--filter-harmonics" ? "sh" : null;
            if (key != null) tipPopup.ShowFor(key, opList); else tipPopup.Hide();
        };
        col2.Controls.Add(opList, 0, 2);
        col2Card.Controls.Add(col2);
        workspace.Controls.Add(col2Card, 1, 0);

        // --- Column 3: 03 输出与压缩设置 ---
        var col3Card = new CardPanel { Dock = DockStyle.Fill, Margin = new Padding(7, 0, 0, 0) };
        var settingsHost = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
        var settings = new TableLayoutPanel { ColumnCount = 1, RowCount = 7, Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = Padding.Empty };
        for (int i = 0; i < 7; i++) settings.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var col3Head = Grid(2, 1);
        col3Head.Height = 36;
        col3Head.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 42));
        col3Head.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 58));
        col3Head.Controls.Add(StepTitle("03", "settings"), 0, 0);
        presetSegment.Dock = DockStyle.Fill; presetSegment.Margin = new Padding(0, 3, 0, 3);
        presetSegment.SelectedIndexChanged += (s, e) => { if (!changing) ApplyPreset(presetSegment.SelectedIndex); };
        AttachTip(presetSegment, "preset");
        col3Head.Controls.Add(presetSegment, 1, 0);
        Row(settings, col3Head, 0, 36);

        // Format + Output Path side-by-side (matching Design Mockup!)
        var fmtOutRow = Grid(2, 1);
        fmtOutRow.Padding = new Padding(0, 6, 0, 8);
        fmtOutRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 48));
        fmtOutRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 52));

        var fmtBox = Grid(1, 2); fmtBox.Margin = new Padding(0, 0, 8, 0);
        fmtBox.RowStyles.Add(new RowStyle(SizeType.Absolute, 20)); fmtBox.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        var fmtLbl = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.BottomLeft, Font = new Font(Font.FontFamily, 8.4f) };
        Bind(fmtLbl, "format"); themeUpdaters.Add(() => fmtLbl.ForeColor = Theme.Current.Text2);
        formats.Items.AddRange(Converter.Formats); formats.SelectedIndex = 0; formats.AccessibleName = "format";
        AttachTip(fmtLbl, "format"); AttachTip(formats, "format");
        fmtBox.Controls.Add(fmtLbl, 0, 0); fmtBox.Controls.Add(formats, 0, 1);
        fmtOutRow.Controls.Add(fmtBox, 0, 0);

        var outBoxWrap = Grid(1, 2);
        outBoxWrap.RowStyles.Add(new RowStyle(SizeType.Absolute, 20)); outBoxWrap.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        outputLabel.Dock = DockStyle.Fill; outputLabel.TextAlign = ContentAlignment.BottomLeft; outputLabel.Font = new Font(Font.FontFamily, 8.4f); outputLabel.UseMnemonic = false;
        themeUpdaters.Add(() => outputLabel.ForeColor = Theme.Current.Text2);
        var outField = Grid(2, 1);
        outField.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); outField.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 36));
        outputBox.Dock = DockStyle.Fill; outputBox.Inner.AccessibleName = "output";
        outputBox.Inner.TextChanged += (s, e) => { if (!updatingPath) autoPath = false; RefreshStart(); };
        var btnBrowse = ButtonOf(null, "browse", "folder", 32, BrowseOutput); btnBrowse.Dock = DockStyle.Fill; btnBrowse.Margin = new Padding(4, 0, 0, 0);
        outField.Controls.Add(outputBox, 0, 0); outField.Controls.Add(btnBrowse, 1, 0);
        outBoxWrap.Controls.Add(outputLabel, 0, 0); outBoxWrap.Controls.Add(outField, 0, 1);
        fmtOutRow.Controls.Add(outBoxWrap, 1, 0);
        Row(settings, fmtOutRow, 1, 66);

        // Rounded Sub-Card for Sliders (matching Design Mockup!)
        sliderGroupCard = new CardPanel { UseSubCard = true, Radius = 9, Padding = new Padding(12, 10, 12, 10), Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink };
        var sliderGrid = new TableLayoutPanel { ColumnCount = 1, RowCount = 7, Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = Padding.Empty };
        for (int i = 0; i < 7; i++) sliderGrid.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        keep = new Knob("keep", 1, 100, 100, v => v + "%"); keep.BindTip(AttachTip, "keep");
        chkAdaptive.AutoSize = true; chkAdaptive.Checked = true; Bind(chkAdaptive, "adaptiveDecimate"); AttachTip(chkAdaptive, "adaptive");
        chkAdaptive.Margin = new Padding(0, 0, 0, 4);
        iterations = new Knob("iterations", 1, 100, 10, v => v.ToString()); iterations.BindTip(AttachTip, "iterations");
        effort = new Knob("effort", -1, 9, -1, v => v < 0 ? I18n.T("default") : v.ToString()); effort.BindTip(AttachTip, "effort");
        workers = new Knob("workers", 0, 16, 4, v => v == 0 ? I18n.T("serial") : v.ToString()); workers.BindTip(AttachTip, "workers");
        voxel = new Knob("voxel", 1, 500, 50, v => F(v / 1000d)); voxel.BindTip(AttachTip, "voxel");
        opacity = new Knob("opacity", 0, 100, 10, v => F(v / 100d)); opacity.BindTip(AttachTip, "opacity");

        Row(sliderGrid, keep, 0, 46);
        Row(sliderGrid, chkAdaptive, 1, 24);
        Row(sliderGrid, iterations, 2, 46);
        Row(sliderGrid, effort, 3, 46);
        Row(sliderGrid, workers, 4, 46);
        Row(sliderGrid, voxel, 5, 46);
        Row(sliderGrid, opacity, 6, 46);
        sliderGroupCard.Controls.Add(sliderGrid);
        settings.Controls.Add(sliderGroupCard, 0, 2);

        // Device Segmented Control (自动显卡 | 强制 Vulkan | 纯 CPU)
        var devRow = Grid(2, 1);
        devRow.Padding = new Padding(0, 10, 0, 6);
        devRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 40));
        devRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 60));
        var devLbl = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Font = new Font(Font.FontFamily, 8.6f) };
        Bind(devLbl, "device"); themeUpdaters.Add(() => devLbl.ForeColor = Theme.Current.Ink);
        deviceSegment.Dock = DockStyle.Fill; deviceSegment.AccessibleName = "device";
        AttachTip(devLbl, "device"); AttachTip(deviceSegment, "device");
        devRow.Controls.Add(devLbl, 0, 0); devRow.Controls.Add(deviceSegment, 1, 0);
        Row(settings, devRow, 3, 46);

        var licBtn = ButtonOf("licenses", "licenses", "file", 140, ShowLicenses);
        licBtn.Margin = new Padding(0, 6, 0, 0);
        Row(settings, licBtn, 4, 38);

        settingsHost.Controls.Add(settings);
        col3Card.Controls.Add(settingsHost);
        workspace.Controls.Add(col3Card, 2, 0);
        root.Controls.Add(workspace, 0, 1);

        // ===== Collapsible Log Drawer =====
        logDrawer = new Panel { Dock = DockStyle.Fill, Height = 124, Visible = false, Padding = new Padding(16, 0, 16, 8) };
        logView.Multiline = true; logView.ReadOnly = true; logView.Dock = DockStyle.Fill; logView.ScrollBars = ScrollBars.Vertical;
        logView.BorderStyle = BorderStyle.FixedSingle; logView.Font = new Font("Consolas", 8.6f); logView.AccessibleName = "log";
        logDrawer.Controls.Add(logView);
        root.Controls.Add(logDrawer, 0, 2);

        // ===== Progress + ETA + Action Footer =====
        footerPanel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(18, 6, 18, 6) };
        var footerGrid = Grid(1, 3);
        footerGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 22));
        footerGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 12));
        footerGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));

        var progInfo = Grid(4, 1);
        progInfo.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        progInfo.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 115));
        progInfo.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
        progInfo.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 52));
        status.Dock = DockStyle.Fill; status.TextAlign = ContentAlignment.MiddleLeft; status.AutoEllipsis = true;
        elapsedLabel.Dock = DockStyle.Fill; elapsedLabel.TextAlign = ContentAlignment.MiddleRight; elapsedLabel.Font = new Font("Consolas", 8.5f);
        etaLabel.Dock = DockStyle.Fill; etaLabel.TextAlign = ContentAlignment.MiddleRight; etaLabel.Font = new Font("Consolas", 8.5f, FontStyle.Bold);
        progressPctLabel.Dock = DockStyle.Fill; progressPctLabel.TextAlign = ContentAlignment.MiddleRight; progressPctLabel.Font = new Font("Consolas", 9.2f, FontStyle.Bold);
        progressPctLabel.Text = "0%";
        progInfo.Controls.Add(status, 0, 0); progInfo.Controls.Add(elapsedLabel, 1, 0); progInfo.Controls.Add(etaLabel, 2, 0); progInfo.Controls.Add(progressPctLabel, 3, 0);
        footerGrid.Controls.Add(progInfo, 0, 0);

        progressBar.Dock = DockStyle.Fill;
        footerGrid.Controls.Add(progressBar, 0, 1);

        var actRow = Grid(2, 1);
        actRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 55));
        actRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 45));

        var leftAct = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Padding = new Padding(0, 5, 0, 0) };
        btnLogToggle = ButtonOf("toggleLogs", "logs", "logs", 108, ToggleLogs);
        repository.Text = App.Repository; repository.AutoSize = true; repository.Margin = new Padding(10, 9, 0, 0); repository.AccessibleName = "repository";
        repository.LinkClicked += (s, e) => OpenRepository();
        leftAct.Controls.Add(btnLogToggle); leftAct.Controls.Add(repository);
        actRow.Controls.Add(leftAct, 0, 0);

        var rightAct = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Padding = new Padding(0, 4, 0, 0) };
        start = ButtonOf("start", "start", "play", 148, Begin); start.Primary = true; start.AccessibleName = "start";
        cancel = ButtonOf("cancel", "cancel", "stop", 104, Stop); cancel.Enabled = false;
        reveal = ButtonOf("openOutput", "openOutput", "folder", 142, OpenOutput); reveal.Visible = false;
        rightAct.Controls.Add(start); rightAct.Controls.Add(cancel); rightAct.Controls.Add(reveal);
        actRow.Controls.Add(rightAct, 1, 0);
        footerGrid.Controls.Add(actRow, 0, 2);
        footerPanel.Controls.Add(footerGrid);
        root.Controls.Add(footerPanel, 0, 3);

        // ===== Bottom 0.5s Hardware Telemetry Bar (Image 3 Crisp Lucide Icons + Mini Progress Bar + Hover Dual-Color Chart) =====
        var resGrid = Grid(4, 1);
        resourceBar = resGrid;
        resGrid.Padding = new Padding(14, 5, 14, 6);
        string[] iconNames = { "cpu", "memory", "gpu", "vram" };
        string[] metricKeys = { "cpu", "ram", "gpu", "vram" };
        for (int i = 0; i < 4; i++) {
            resGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
            var tile = new FluentMetricTile { Dock = DockStyle.Fill, IconBaseName = iconNames[i], Margin = new Padding(4, 0, 4, 0), AccessibleName = "metric-" + iconNames[i] };
            metricTiles[i] = tile;
            string mKey = metricKeys[i];
            tile.MouseEnter += (s, e) => { activeHoverMetric = mKey; chartPopup.UpdateData(mKey, telemetry.Snapshot(), resources, tile); };
            tile.MouseLeave += (s, e) => { activeHoverMetric = null; chartPopup.Hide(); };
            resGrid.Controls.Add(tile, i, 0);
        }
        root.Controls.Add(resGrid, 0, 4);
        Controls.Add(root);

        formats.SelectedIndexChanged += (s, e) => { if (!changing) FormatChanged(); };
        language.SelectedIndexChanged += (s, e) => {
            if (changing || language.SelectedIndex < 0) return;
            I18n.Language = I18n.Codes[language.SelectedIndex]; I18n.Save(); Translate();
        };

        ticker.Tick += (s, e) => {
            FlushLog();
            if (!sampling && DateTime.UtcNow >= nextSample) SampleResources();
        };
        ticker.Start();

        HandleCreated += (s, e) => Theme.ApplyWindowChrome(this);
        FormClosing += (s, e) => { if (active != null) { e.Cancel = true; closing = true; Stop(); } };
        FormClosed += (s, e) => {
            ticker.Dispose(); tips.Dispose(); tipPopup.Dispose(); chartPopup.Dispose(); converter.Dispose();
            Task.Run(() => monitor.Dispose());
        };

        Translate();
        ApplyThemeAll();
        AddFiles(paths);
    }

    Control StepTitle(string num, string key) {
        var wrap = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = Padding.Empty, Padding = new Padding(0, 2, 0, 0) };
        var badge = new Label { Text = num, AutoSize = true, Padding = new Padding(5, 2, 5, 2), Font = new Font("Consolas", 8.5f, FontStyle.Bold), Margin = new Padding(0, 2, 6, 0) };
        var lbl = new Label { AutoSize = true, Font = new Font(Font.FontFamily, 10f, FontStyle.Bold), Margin = new Padding(0, 3, 0, 0), UseMnemonic = false };
        Bind(lbl, key);
        themeUpdaters.Add(() => { badge.BackColor = Theme.Current.AccentSoft; badge.ForeColor = Theme.Current.Accent; lbl.ForeColor = Theme.Current.Ink; });
        wrap.Controls.Add(badge); wrap.Controls.Add(lbl);
        return wrap;
    }

    void AttachTip(Control ctrl, string key) {
        if (ctrl == null) return;
        ctrl.MouseEnter += (s, e) => tipPopup.ShowFor(key, ctrl);
        ctrl.MouseLeave += (s, e) => tipPopup.Hide();
    }

    void ApplyThemeAll() {
        var p = Theme.Current;
        Theme.ApplyWindowChrome(this);
        BackColor = p.WindowBg; ForeColor = p.Ink;
        workspace.BackColor = p.WindowBg;
        footerPanel.BackColor = p.TitleBarBg;
        resourceBar.BackColor = p.TitleBarBg;
        logDrawer.BackColor = p.WindowBg;
        logView.BackColor = p.LogBg; logView.ForeColor = p.Text2;
        outputBox.ApplyTheme();
        foreach (var cb in new[] { scope, formats, language }) { cb.BackColor = p.InputBg; cb.ForeColor = p.Ink; }
        chkAdaptive.ForeColor = p.Ink; chkAdaptive.BackColor = p.SubCardBg;
        tally.ForeColor = p.Muted;
        status.ForeColor = p.Ink; elapsedLabel.ForeColor = p.Muted; etaLabel.ForeColor = p.Accent; progressPctLabel.ForeColor = p.Ink;
        repository.LinkColor = p.Muted;
        foreach (var k in new[] { keep, iterations, effort, workers, voxel, opacity }) k.ApplyTheme();
        foreach (var u in themeUpdaters) u();
        Invalidate(true);
    }

    void SetBatchMode(bool isBatch) {
        batchMode = isBatch;
        outputLabel.Text = I18n.T(batchMode ? "outputFolder" : "output");
        autoPath = true;
        SuggestPath();
    }

    void ApplyPreset(int idx) {
        if (idx == 0) { keep.Value = 50; chkAdaptive.Checked = true; iterations.Value = 8; effort.Value = 7; }
        else if (idx == 1) { keep.Value = 75; chkAdaptive.Checked = true; iterations.Value = 10; effort.Value = -1; }
        else { keep.Value = 100; iterations.Value = 20; effort.Value = 6; }
    }

    void ToggleLogs() { logsExpanded = !logsExpanded; logDrawer.Visible = logsExpanded; }

    void OpenEngineUpdater() {
        using (var dlg = new EngineUpdateDialog(this, () => {
            btnEngine.Text = "● 引擎 v" + EngineManager.ActiveVersion + " · 国内镜像就绪";
        })) {
            dlg.ShowDialog(this);
        }
    }

    void Bind(Control control, string key) { var label = control as Label; if (label != null) label.UseMnemonic = false; translations.Add(() => control.Text = I18n.T(key)); control.Text = I18n.T(key); }
    static TableLayoutPanel Grid(int cols, int rows) {
        var grid = new TableLayoutPanel { ColumnCount = cols, RowCount = rows, Dock = DockStyle.Fill, Margin = Padding.Empty };
        if (rows == 1) grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        return grid;
    }
    static ComboBox Combo() { return new DisplayCombo { Dock = DockStyle.Fill, Margin = new Padding(0, 2, 0, 2) }; }
    FluentButton ButtonOf(string text, string hint, string icon, int width, Action action) {
        var button = new FluentButton { Width = width, Height = 32, IconName = icon, Margin = new Padding(0, 2, 6, 2) };
        button.Click += (s, e) => action();
        translations.Add(() => { button.Text = text == null ? "" : I18n.T(text); tips.SetToolTip(button, I18n.T(hint)); });
        return button;
    }
    static void Row(TableLayoutPanel grid, Control control, int row, int height) { control.Height = height; control.Dock = DockStyle.Top; control.Margin = Padding.Empty; grid.Controls.Add(control, 0, row); }

    internal void SetLanguage(string code) {
        int index = Array.IndexOf(I18n.Codes, code); if (index < 0) return;
        changing = true; language.SelectedIndex = index; I18n.Language = code; changing = false; Translate();
    }

    void Translate() {
        changing = true;
        foreach (var update in translations) update();
        outputLabel.Text = I18n.T(batchMode ? "outputFolder" : "output");
        btnTheme.Text = I18n.T(Theme.Current.IsDark ? "themeLight" : "themeDark");
        modeSegment.SetItems(I18n.T("batchMode"), I18n.T("mergeMode"));
        modeSegment.SelectedIndex = batchMode ? 0 : 1;
        presetSegment.SetItems(I18n.T("presetLite"), I18n.T("presetBalanced"), I18n.T("presetHq"));
        presetSegment.SelectedIndex = 2;
        int index = Math.Max(0, formats.SelectedIndex); formats.Items.Clear(); formats.Items.AddRange(Converter.Formats); formats.SelectedIndex = index;
        RefreshDevices();
        foreach (var knob in new[] { keep, iterations, effort, workers, voxel, opacity }) knob.Translate();
        changing = false;
        FormatVisibility(); RefreshFiles(-1); SetStatus(statusKey); PaintMetrics();
    }

    void RefreshDevices() {
        int sel = deviceSegment.SelectedIndex;
        if (SelectedFormat.Voxel) deviceSegment.SetItems(I18n.T("auto"), I18n.T("backend"));
        else deviceSegment.SetItems(I18n.T("auto"), I18n.T("backend"), I18n.T("cpuDevice"));
        deviceSegment.SelectedIndex = Math.Min(sel, SelectedFormat.Voxel ? 1 : 2);
    }

    void FormatChanged() { RefreshDevices(); FormatVisibility(); autoPath = true; SuggestPath(); }
    void FormatVisibility() {
        iterations.Visible = effort.Visible = workers.Visible = SelectedFormat.Sog;
        voxel.Visible = opacity.Visible = SelectedFormat.Voxel;
        bool needGpu = SelectedFormat.Sog || SelectedFormat.Voxel || outputOps.Any(o => o.Enabled && o.Step.RequiresGpu);
        deviceSegment.Parent.Visible = needGpu;
    }

    Format SelectedFormat { get { return (Format)formats.SelectedItem; } }
    static string F(double number) { return number.ToString("0.###", CultureInfo.InvariantCulture); }
    static string SizeText(long size) { return size >= 1073741824 ? Budget.GB(size) : (size / 1048576d).ToString("0.0", CultureInfo.InvariantCulture) + " MiB"; }
    static string FmtDuration(double sec) { int s = Math.Max(0, (int)Math.Round(sec)); return (s / 60).ToString("00") + ":" + (s % 60).ToString("00"); }

    void BrowseInputs() {
        using (var dialog = new OpenFileDialog { Multiselect = true, Filter = I18n.T("inputs") + "|*.ply;*.sog;*.ksplat;*.splat;*.spz;*.glb;*.lcc;*.lcc2", Title = I18n.T("add") })
            if (dialog.ShowDialog(this) == DialogResult.OK) AddFiles(dialog.FileNames);
    }
    void AddFiles(IEnumerable<string> paths) {
        if (active != null) return;
        foreach (string p in paths ?? new string[0]) {
            try { string full = Path.GetFullPath(p); if (Converter.Supported(full) && File.Exists(full) && !inputs.Any(i => String.Equals(i.Path, full, StringComparison.OrdinalIgnoreCase))) inputs.Add(new InputFile(full)); }
            catch (ArgumentException) { }
        }
        RefreshFiles(-1);
    }
    void RemoveFiles() { int i = fileList.SelectedIndex; if (i >= 0 && i < inputs.Count) { inputs.RemoveAt(i); RefreshFiles(Math.Min(i, inputs.Count - 1)); } }
    void MoveFile(int delta) { int i = fileList.SelectedIndex, j = i + delta; if (i < 0 || j < 0 || j >= inputs.Count) return; var item = inputs[i]; inputs.RemoveAt(i); inputs.Insert(j, item); RefreshFiles(j); }

    void RefreshFiles(int select) {
        changing = true; int previous = scope.SelectedIndex; scope.Items.Clear(); scope.Items.Add(I18n.T("merged")); long bytes = 0;
        foreach (var input in inputs) {
            var info = new FileInfo(input.Path); long size = info.Exists ? info.Length : 0; bytes += size;
            scope.Items.Add(info.Name);
        }
        fileList.SetFiles(inputs, select);
        scope.SelectedIndex = select >= 0 ? select + 1 : Math.Max(0, Math.Min(previous, scope.Items.Count - 1));
        changing = false;
        tally.Text = inputs.Count + " " + I18n.T("files") + (bytes > 0 ? " · " + SizeText(bytes) : "");
        RefreshOps(-1); SuggestPath(); RefreshStart();
    }

    List<Op> CurrentOps() { return scope.SelectedIndex <= 0 || scope.SelectedIndex > inputs.Count ? outputOps : inputs[scope.SelectedIndex - 1].Ops; }
    void RefreshOps(int select) { opList.SetOps(CurrentOps(), select); }
    void MoveOp(int delta) { var ops = CurrentOps(); int i = opList.SelectedIndex, j = i + delta; if (i < 0 || j < 0 || j >= ops.Count) return; var op = ops[i]; ops.RemoveAt(i); ops.Insert(j, op); RefreshOps(j); }
    void EditOp(bool edit) {
        var ops = CurrentOps(); int i = opList.SelectedIndex; if (edit && i < 0) return;
        using (var dialog = new StepDialog(edit ? ops[i] : null)) {
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            if (edit) ops[i] = dialog.Result; else { i = ops.Count; ops.Add(dialog.Result); }
            RefreshOps(i); FormatVisibility();
        }
    }

    void SuggestPath() {
        if (!autoPath) return;
        updatingPath = true;
        if (inputs.Count == 0) outputBox.Inner.Text = "";
        else if (batchMode) outputBox.Inner.Text = Path.Combine(Path.GetDirectoryName(inputs[0].Path), "converted");
        else outputBox.Inner.Text = Path.Combine(Path.GetDirectoryName(inputs[0].Path), (inputs.Count > 1 ? "combined" : Converter.Stem(inputs[0].Path) + "-converted") + SelectedFormat.Suffix);
        updatingPath = false;
    }

    void BrowseOutput() {
        if (batchMode) {
            using (var folderDlg = new FolderBrowserDialog { Description = I18n.T("outputFolder") }) {
                if (inputs.Count > 0) folderDlg.SelectedPath = Path.GetDirectoryName(inputs[0].Path);
                if (folderDlg.ShowDialog(this) == DialogResult.OK) outputBox.Inner.Text = folderDlg.SelectedPath;
            }
            return;
        }
        var f = SelectedFormat;
        using (var dialog = new SaveFileDialog { Filter = f.Name.Replace("|", " ") + "|*" + f.Suffix, AddExtension = false, FileName = Path.GetFileName(outputBox.Inner.Text), OverwritePrompt = false, Title = I18n.T("browse") }) {
            if (inputs.Count > 0) dialog.InitialDirectory = Path.GetDirectoryName(inputs[0].Path);
            if (dialog.ShowDialog(this) == DialogResult.OK) outputBox.Inner.Text = Suffix(dialog.FileName, f.Suffix);
        }
    }

    static string Suffix(string p, string suffix) { return p.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) ? p : p + suffix; }
    void RefreshStart() { if (start != null) start.Enabled = active == null && inputs.Count > 0 && !String.IsNullOrWhiteSpace(outputBox.Inner.Text); }
    void SetStatus(string key) { statusKey = key; status.Text = I18n.T(key); }

    async void SampleResources() {
        sampling = true;
        try {
            var sample = await Task.Run(() => monitor.Sample());
            if (!IsDisposed) {
                resources = sample;
                telemetry.Add(sample, active != null);
                PaintMetrics();
                if (activeHoverMetric != null) chartPopup.RefreshIfVisible(telemetry.Snapshot(), resources);
            }
        } catch { }
        finally {
            sampling = false;
            nextSample = DateTime.UtcNow.AddMilliseconds(WindowState == FormWindowState.Minimized ? 10000 : 500);
        }
    }

    void PaintMetrics() {
        string unknown = I18n.T("unknown"); var r = resources;
        bool busy = active != null;
        double cpu = r != null && r.Cpu.HasValue ? r.Cpu.Value : 0;
        metricTiles[0].LabelText = "CPU";
        metricTiles[0].ValueText = r != null && r.Cpu.HasValue ? cpu.ToString("0") + "%" : unknown;
        metricTiles[0].Percent = cpu; metricTiles[0].IsCompressing = busy; metricTiles[0].Invalidate();

        double ramPct = r != null && r.TotalMemory > 0 ? Math.Max(0, Math.Min(100, (r.TotalMemory - r.AvailableMemory) / r.TotalMemory * 100d)) : 0;
        metricTiles[1].LabelText = I18n.T("memory");
        metricTiles[1].ValueText = r != null && r.TotalMemory > 0 ? F((r.TotalMemory - r.AvailableMemory) / 1073741824d) + " / " + F(r.TotalMemory / 1073741824d) + " GiB" : unknown;
        metricTiles[1].Percent = ramPct; metricTiles[1].IsCompressing = busy;
        metricTiles[1].AlertDanger = r != null && r.TotalMemory > 0 && r.AvailableMemory / r.TotalMemory < 0.1;
        metricTiles[1].Invalidate();

        var gpu = r == null ? null : r.Gpus.OrderByDescending(g => g.Usage ?? -1).FirstOrDefault();
        double gpuPct = gpu != null && gpu.Usage.HasValue ? gpu.Usage.Value : 0;
        metricTiles[2].LabelText = "GPU";
        metricTiles[2].ValueText = (gpu != null && gpu.Usage.HasValue ? gpuPct.ToString("0") + "%" : unknown) + (r != null && r.Gpus.Count > 1 ? " · " + r.Gpus.Count : "");
        metricTiles[2].Percent = gpuPct; metricTiles[2].IsCompressing = busy; metricTiles[2].Invalidate();

        double vramPct = gpu != null && gpu.MemoryTotal > 0 && gpu.MemoryUsed.HasValue ? Math.Max(0, Math.Min(100, gpu.MemoryUsed.Value / gpu.MemoryTotal * 100d)) : 0;
        metricTiles[3].LabelText = I18n.T("vram");
        metricTiles[3].ValueText = gpu != null && gpu.MemoryTotal > 0 && gpu.MemoryUsed.HasValue ? F(gpu.MemoryUsed.Value / 1073741824d) + " / " + F(gpu.MemoryTotal / 1073741824d) + " GiB" : unknown;
        metricTiles[3].Percent = vramPct; metricTiles[3].IsCompressing = busy; metricTiles[3].Invalidate();
    }

    async void Begin() {
        if (active != null || inputs.Count == 0) return;
        var f = SelectedFormat;
        string target = outputBox.Inner.Text.Trim();
        bool overwrite = batchMode;
        if (!batchMode) {
            try { target = Path.GetFullPath(Suffix(target, f.Suffix)); }
            catch (Exception ex) { ShowFailure(ex, null, null); return; }
            overwrite = File.Exists(target);
            if (overwrite && !MessageDialog.Confirm(this, I18n.T("output"), I18n.T("overwrite") + "\n\n" + target, I18n.T("continue"), I18n.T("cancel"))) return;
        } else {
            try { target = Path.GetFullPath(target); }
            catch (Exception ex) { ShowFailure(ex, null, null); return; }
        }

        string selectedDevice = !(f.Sog || f.Voxel || outputOps.Any(o => o.Enabled && o.Step.RequiresGpu)) ? "cpu"
            : deviceSegment.SelectedIndex == 0 ? "auto"
            : deviceSegment.SelectedIndex == 1 ? "vulkan" : "cpu";

        var job = new Job {
            Output = batchMode ? null : target,
            OutputDirectory = batchMode ? target : null,
            Format = f, Overwrite = overwrite, BatchMode = batchMode,
            AdaptiveDecimate = chkAdaptive.Checked,
            Keep = keep.Value, Iterations = iterations.Value, Effort = effort.Value,
            Workers = workers.Value, VoxelSize = F(voxel.Value / 1000d), Opacity = F(opacity.Value / 100d),
            Device = selectedDevice
        };
        job.Inputs.AddRange(inputs);
        job.Ops.AddRange(outputOps);

        active = new CancellationTokenSource();
        var token = active.Token;
        workspace.Enabled = false; language.Enabled = false; btnEngine.Enabled = false;
        cancel.Enabled = true; RefreshStart(); logView.Clear(); reveal.Visible = false;
        progressBar.Percent = 0; progressPctLabel.Text = "0%";
        elapsedLabel.Text = I18n.T("elapsed") + " 00:00";
        etaLabel.Text = I18n.T("etaRemaining") + " --:--";
        SetStatus("preflight");
        MemoryEstimate estimate = null;

        try {
            estimate = await Task.Run(() => Budget.Estimate(job)); token.ThrowIfCancellationRequested();
            var preflightResources = ResourceOverride != null ? ResourceOverride() : await Task.Run(() => monitor.Sample()); token.ThrowIfCancellationRequested();
            resources = preflightResources; PaintMetrics();
            var risks = Budget.Assess(estimate, preflightResources, job.Device);
            if (risks.Count > 0) {
                string message = Budget.Describe(estimate, preflightResources) + "\n\n" + I18n.T("memoryAdvice") + (risks.Contains("vram") ? "\n" + I18n.T("gpuAdvice") : "");
                bool proceed = WarningOverride != null ? WarningOverride(message) : MessageDialog.Confirm(this, I18n.T("resourceWarning"), message, I18n.T("continue"), I18n.T("adjust"));
                if (!proceed) { SetStatus("ready"); return; }
            }

            telemetry.MarkCompressionStarted();

            var reportStatus = new Progress<string>(key => { if (active != null && !token.IsCancellationRequested) SetStatus(key); });
            var reportProg = new Progress<ProgressInfo>(p => {
                if (active == null || token.IsCancellationRequested) return;
                progressBar.Percent = p.Percent;
                progressPctLabel.Text = Math.Round(p.Percent).ToString("0") + "%";
                elapsedLabel.Text = I18n.T("elapsed") + " " + FmtDuration(p.ElapsedSeconds);
                etaLabel.Text = p.EtaSeconds.HasValue ? I18n.T("etaRemaining") + " " + FmtDuration(p.EtaSeconds.Value) : I18n.T("etaRemaining") + " --:--";
                string batchTag = p.FileTotal > 1 ? "[" + p.FileIndex + "/" + p.FileTotal + "] " : "";
                status.Text = batchTag + I18n.T(p.StageKey) + (String.IsNullOrWhiteSpace(p.Detail) ? "" : " · " + p.Detail);
            });

            await Task.Run(() => converter.Convert(job, token,
                key => ((IProgress<string>)reportStatus).Report(key),
                line => events.Enqueue(line),
                info => ((IProgress<ProgressInfo>)reportProg).Report(info)));

            completed = batchMode ? job.OutputDirectory : job.Output;
            reveal.Visible = true;
            SetStatus("done");
            string summary = "";
            if (!batchMode && File.Exists(completed)) {
                summary = "输出文件：" + Path.GetFileName(completed) + "（" + SizeText(new FileInfo(completed).Length) + "）";
                status.Text += " · " + SizeText(new FileInfo(completed).Length);
            } else if (batchMode) {
                summary = "已完成批量转换，共输出 " + job.Inputs.Count + " 个文件。";
                status.Text += " · " + job.Inputs.Count + " " + I18n.T("files");
            }
            events.Enqueue(I18n.T("output") + ": " + completed);
            progressBar.Percent = 100; progressPctLabel.Text = "100%"; etaLabel.Text = I18n.T("done");

            if (!closing && StarPrompt.TryClaim(PromptMarker)) {
                if (PromptOverride != null) PromptOverride();
                else if (MessageDialog.StarCelebration(this, summary)) OpenRepository();
            }
        }
        catch (OperationCanceledException) { SetStatus("canceled"); etaLabel.Text = I18n.T("canceled"); }
        catch (Exception ex) { SetStatus("failed"); events.Enqueue(ex.ToString()); FlushLog(); if (!closing) ShowFailure(ex, job, estimate); }
        finally {
            telemetry.MarkCompressionEnded();
            if (activeHoverMetric != null) chartPopup.RefreshIfVisible(telemetry.Snapshot(), resources);
            FlushLog();
            active.Dispose(); active = null;
            workspace.Enabled = true; language.Enabled = true; btnEngine.Enabled = true;
            cancel.Enabled = false; RefreshStart();
            if (closing) Close();
        }
    }

    void ShowFailure(Exception error, Job job, MemoryEstimate estimate) {
        var diagnostic = Diagnostics.Classify(error, job == null ? "auto" : job.Device);
        string details = diagnostic.Text;
        if (estimate != null) details += "\n\n" + Budget.Describe(estimate, resources);
        string raw = "Splat Convert Desktop 2.0.0\nOS: " + Environment.OSVersion + "\nEngine: " + EngineManager.ActiveVersion + "\n" +
            (job == null ? "" : "Format: " + job.Format.Suffix + "; Device: " + job.Device + "; Workers: " + job.Workers + "\n") + details + "\n\n" + error;
        if (ErrorOverride != null) { ErrorOverride(diagnostic, raw); return; }
        MessageDialog.Failure(this, I18n.T(diagnostic.TitleKey), details, raw, () => {
            if (!logsExpanded) ToggleLogs();
            logView.Focus(); logView.SelectionStart = logView.TextLength; logView.ScrollToCaret();
        });
    }

    void Stop() { if (active != null) { SetStatus("canceling"); cancel.Enabled = false; active.Cancel(); } }
    void FlushLog() {
        var text = new System.Text.StringBuilder(); string line;
        while (events.TryDequeue(out line)) text.AppendLine(line);
        if (text.Length == 0) return;
        if (logView.TextLength > 180000) logView.Text = logView.Text.Substring(logView.TextLength - 120000);
        logView.AppendText(text.ToString());
    }
    void OpenOutput() {
        if (completed == null) return;
        if (Directory.Exists(completed)) Process.Start("explorer.exe", "\"" + completed + "\"");
        else if (File.Exists(completed)) Process.Start("explorer.exe", "/select,\"" + completed + "\"");
    }
    void OpenRepository() { try { Process.Start(new ProcessStartInfo(App.Repository) { UseShellExecute = true }); } catch (Exception ex) { ShowFailure(ex, null, null); } }
    void ShowLicenses() {
        using (var dialog = new Form { Text = I18n.T("licenses"), StartPosition = FormStartPosition.CenterParent, Size = new Size(790, 555), Font = Font, BackColor = Theme.Current.WindowBg, ForeColor = Theme.Current.Ink })
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("licenses.txt"))
        using (var reader = new StreamReader(stream)) {
            dialog.HandleCreated += (s, e) => Theme.ApplyWindowChrome(dialog);
            dialog.Controls.Add(new TextBox {
                Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false,
                BackColor = Theme.Current.LogBg, ForeColor = Theme.Current.Text2,
                Text = reader.ReadToEnd().Replace("\r\n", "\n").Replace("\n", "\r\n")
            });
            dialog.ShowDialog(this);
        }
    }
}
