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

sealed class Knob : UserControl {
    internal readonly FluentSlider Track;
    readonly Label label, value;
    readonly string key;
    readonly Func<int, string> format;
    internal int Value { get { return Track.Value; } set { Track.Value = Math.Max(Track.Minimum, Math.Min(Track.Maximum, value)); } }
    internal Knob(string key, int min, int max, int initial, Func<int, string> format) {
        this.key = key; this.format = format; Height = 44; Margin = Padding.Empty;
        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, Margin = Padding.Empty };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 72));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 28));
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 19));
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 25));
        label = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.BottomLeft, AutoEllipsis = true, UseMnemonic = false, Font = new Font("Microsoft YaHei UI", 8.5f) };
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
    readonly FluentDropdown scope = new FluentDropdown { Dock = DockStyle.Fill };
    readonly FluentDropdown formats = new FluentDropdown { Dock = DockStyle.Fill, AccessibleName = "format" };
    readonly FluentDropdown language = new FluentDropdown { Width = 122, Height = 30, AccessibleName = "language" };
    readonly FluentInputBox outputBox = new FluentInputBox();
    readonly TextBox logView = new TextBox();
    readonly Label status = new Label(), tally = new Label(), outputLabel = new Label(), estSizeLabel = new Label();
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
    readonly Panel headerPanel, footerPanel, resourceBar, logDrawer, estSizeBar;
    readonly CardPanel sliderGroupCard;
    readonly FluentButton start, cancel, reveal, btnEngine, btnTheme, btnLogToggle;
    readonly LinkLabel repository = new LinkLabel();
    CancellationTokenSource active;
    bool autoPath = true, updatingPath, closing, sampling, changing, batchMode = true, logsExpanded = false;
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
        MinimumSize = new Size(1180, 760);
        Size = new Size(1340, 840);
        StartPosition = FormStartPosition.CenterScreen;
        Text = "Splat Convert Desktop 2.0.0";
        try { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application; }
        catch { Icon = SystemIcons.Application; }

        // Default beginner-friendly pipeline steps (synced with Balanced preset)
        outputOps.Add(new Op { Step = Step.All[3], Value = "", Enabled = true });                  // NaN clean
        outputOps.Add(new Op { Step = Step.All[7], Value = "0.05,0.1,0.004", Enabled = false });   // Filter floaters
        outputOps.Add(new Op { Step = Step.All[4], Value = "1", Enabled = true });                 // SH <= 1

        var root = Grid(1, 5);
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));   // Top Fluent Header
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));   // Proposal C 3-Column Pipeline
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // Collapsible Log Drawer
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 106));  // Generous Progress + ETA + Action Footer (zero clipping!)
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 60));   // Generous Bottom 0.5s Telemetry Tiles

        // ===== Header Bar =====
        headerPanel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(18, 0, 18, 0) };
        var logoBadge = new PictureBox {
            Image = Art.RawIcon("app-logo", 30), SizeMode = PictureBoxSizeMode.Zoom,
            Width = 30, Height = 30, Location = new Point(18, 14), BackColor = Color.Transparent
        };
        var brand = new Label {
            Text = "Splat Convert Desktop", Font = new Font(Font.FontFamily, 12.5f, FontStyle.Bold),
            Location = new Point(56, 16), AutoSize = true
        };
        var verBadge = new Label {
            Text = "v2.0", Font = new Font(Font.FontFamily, 8f, FontStyle.Bold),
            Location = new Point(256, 20), AutoSize = true, Padding = new Padding(5, 2, 5, 2)
        };
        btnEngine = new FluentButton {
            Width = 210, Height = 30, Pill = true, SoftAccent = true,
            Location = new Point(308, 14), Font = new Font(Font.FontFamily, 8.2f, FontStyle.Bold)
        };
        btnEngine.Click += (s, e) => OpenEngineUpdater();
        AttachTip(btnEngine, "engine");

        var rightHeader = new FlowLayoutPanel { Dock = DockStyle.Right, Width = 280, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 13, 0, 10), WrapContents = false };
        language.SetItems(I18n.Names.Cast<object>(), Array.IndexOf(I18n.Codes, I18n.Language));
        language.Margin = new Padding(0, 1, 0, 0);
        btnTheme = new FluentButton { Width = 106, Height = 30, Margin = new Padding(0, 1, 10, 0) };
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
            btnEngine.Text = "● " + I18n.T("engineBadge").Replace("{0}", EngineManager.ActiveVersion);
            btnTheme.Text = I18n.T(p.IsDark ? "themeLight" : "themeDark");
        });
        root.Controls.Add(headerPanel, 0, 0);

        // ===== Proposal C: 3-Column Pipeline =====
        workspace = Grid(3, 1);
        workspace.Padding = new Padding(16, 12, 16, 10);
        workspace.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 32f));
        workspace.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 32f));
        workspace.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 36f));

        // --- Column 1: 01 源文件 ---
        var col1Card = new CardPanel { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 7, 0) };
        var col1 = Grid(1, 3);
        col1.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        col1.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        col1.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        var col1Head = Grid(2, 1);
        col1Head.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 46));
        col1Head.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 54));
        var col1TitleWrap = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty, Padding = new Padding(0, 4, 0, 0) };
        col1TitleWrap.Controls.Add(StepTitle("01", "inputs"));
        tally.AutoSize = true; tally.Margin = new Padding(4, 5, 0, 0); tally.Font = new Font(Font.FontFamily, 8f);
        col1TitleWrap.Controls.Add(tally);
        col1Head.Controls.Add(col1TitleWrap, 0, 0);
        modeSegment.Dock = DockStyle.Fill; modeSegment.Margin = new Padding(0, 3, 0, 3);
        modeSegment.SelectedIndexChanged += (s, e) => { if (!changing) SetBatchMode(modeSegment.SelectedIndex == 0); };
        AttachTip(modeSegment, "mode");
        col1Head.Controls.Add(modeSegment, 1, 0);
        col1.Controls.Add(col1Head, 0, 0);

        var fileTools = Grid(4, 1);
        fileTools.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        fileTools.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 38));
        fileTools.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 38));
        fileTools.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 38));
        var btnAdd = ButtonOf("add", "add", "plus", 140, BrowseInputs); btnAdd.Dock = DockStyle.Fill; btnAdd.Margin = new Padding(0, 3, 6, 5);
        var btnUp = ButtonOf(null, "up", "up", 34, () => MoveFile(-1)); btnUp.Dock = DockStyle.Fill; btnUp.Margin = new Padding(0, 3, 4, 5);
        var btnDn = ButtonOf(null, "down", "down", 34, () => MoveFile(1)); btnDn.Dock = DockStyle.Fill; btnDn.Margin = new Padding(0, 3, 4, 5);
        var btnClr = ButtonOf(null, "remove", "minus", 34, RemoveFiles); btnClr.Dock = DockStyle.Fill; btnClr.Margin = new Padding(0, 3, 0, 5);
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

        // --- Column 2: 02 变换与筛选 ---
        var col2Card = new CardPanel { Dock = DockStyle.Fill, Margin = new Padding(7, 0, 7, 0) };
        var col2 = Grid(1, 3);
        col2.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        col2.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
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
        opBar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 36));
        opBar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 36));
        opBar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 36));
        opBar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 36));
        scope.AccessibleName = "scope"; scope.Margin = new Padding(0, 3, 6, 5);
        scope.SelectedIndexChanged += (s, e) => { if (!changing) RefreshOps(-1); };
        var bEdit = ButtonOf(null, "edit", "edit", 32, () => EditOp(true)); bEdit.Dock = DockStyle.Fill; bEdit.Margin = new Padding(0, 3, 4, 5);
        var bRem = ButtonOf(null, "remove", "minus", 32, () => { int i = opList.SelectedIndex; if (i >= 0) { CurrentOps().RemoveAt(i); RefreshOps(i); UpdateOutputEstimate(); } }); bRem.Dock = DockStyle.Fill; bRem.Margin = new Padding(0, 3, 4, 5);
        var bUp = ButtonOf(null, "up", "up", 32, () => MoveOp(-1)); bUp.Dock = DockStyle.Fill; bUp.Margin = new Padding(0, 3, 4, 5);
        var bDn = ButtonOf(null, "down", "down", 32, () => MoveOp(1)); bDn.Dock = DockStyle.Fill; bDn.Margin = new Padding(0, 3, 0, 5);
        opBar.Controls.Add(scope, 0, 0); opBar.Controls.Add(bEdit, 1, 0); opBar.Controls.Add(bRem, 2, 0); opBar.Controls.Add(bUp, 3, 0); opBar.Controls.Add(bDn, 4, 0);
        col2.Controls.Add(opBar, 0, 1);

        opList.Dock = DockStyle.Fill;
        opList.ToggleEnabledRequested += idx => {
            var ops = CurrentOps();
            if (idx >= 0 && idx < ops.Count) { ops[idx].Enabled = !ops[idx].Enabled; RefreshOps(idx); FormatVisibility(); UpdateOutputEstimate(); }
        };
        opList.EditRequested += idx => { opList.SelectedIndex = idx; EditOp(true); };
        // Fixed Image 5: anchor tooltip right next to the EXACT hovered card rectangle!
        opList.HoverOpChanged += idx => {
            var ops = CurrentOps();
            if (idx < 0 || idx >= ops.Count) { tipPopup.Hide(); return; }
            string key = BeginnerTips.KeyForStepFlag(ops[idx].Step.Flag);
            if (key != null) tipPopup.ShowForRect(key, opList.GetRowScreenRect(idx));
            else tipPopup.Hide();
        };
        col2.Controls.Add(opList, 0, 2);
        col2Card.Controls.Add(col2);
        workspace.Controls.Add(col2Card, 1, 0);

        // --- Column 3: 03 输出设置 ---
        var col3Card = new CardPanel { Dock = DockStyle.Fill, Margin = new Padding(7, 0, 0, 0) };
        var settingsHost = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
        var settings = new TableLayoutPanel { ColumnCount = 1, RowCount = 7, Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = Padding.Empty };
        for (int i = 0; i < 7; i++) settings.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        Row(settings, StepTitle("03", "settings"), 0, 32);

        // 4-option Preset Segmented Control (快速转换 | 极致瘦身 | 网页均衡 | 高质归档)
        presetSegment.Dock = DockStyle.Fill; presetSegment.Margin = new Padding(0, 4, 0, 6);
        presetSegment.SelectedIndexChanged += (s, e) => { if (!changing) ApplyPreset(presetSegment.SelectedIndex); };
        AttachTip(presetSegment, "preset");
        Row(settings, presetSegment, 1, 38);

        // Format + Output Path side-by-side (using FluentDropdown!)
        var fmtOutRow = Grid(2, 1);
        fmtOutRow.Padding = new Padding(0, 2, 0, 8);
        fmtOutRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 48));
        fmtOutRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 52));

        var fmtBox = Grid(1, 2); fmtBox.Margin = new Padding(0, 0, 8, 0);
        fmtBox.RowStyles.Add(new RowStyle(SizeType.Absolute, 20)); fmtBox.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        var fmtLbl = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.BottomLeft, Font = new Font(Font.FontFamily, 8.4f) };
        Bind(fmtLbl, "format"); themeUpdaters.Add(() => fmtLbl.ForeColor = Theme.Current.Text2);
        formats.SetItems(Converter.Formats.Cast<object>(), 0);
        AttachTip(fmtLbl, "format"); AttachTip(formats, "format");
        fmtBox.Controls.Add(fmtLbl, 0, 0); fmtBox.Controls.Add(formats, 0, 1);
        fmtOutRow.Controls.Add(fmtBox, 0, 0);

        var outBoxWrap = Grid(1, 2);
        outBoxWrap.RowStyles.Add(new RowStyle(SizeType.Absolute, 20)); outBoxWrap.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        outputLabel.Dock = DockStyle.Fill; outputLabel.TextAlign = ContentAlignment.BottomLeft; outputLabel.Font = new Font(Font.FontFamily, 8.4f); outputLabel.UseMnemonic = false;
        themeUpdaters.Add(() => outputLabel.ForeColor = Theme.Current.Text2);
        var outField = Grid(2, 1);
        outField.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); outField.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 38));
        outputBox.Dock = DockStyle.Fill; outputBox.Inner.AccessibleName = "output";
        outputBox.Inner.TextChanged += (s, e) => { if (!updatingPath) autoPath = false; RefreshStart(); };
        var btnBrowse = ButtonOf(null, "browse", "folder", 34, BrowseOutput); btnBrowse.Dock = DockStyle.Fill; btnBrowse.Margin = new Padding(4, 0, 0, 0);
        outField.Controls.Add(outputBox, 0, 0); outField.Controls.Add(btnBrowse, 1, 0);
        outBoxWrap.Controls.Add(outputLabel, 0, 0); outBoxWrap.Controls.Add(outField, 0, 1);
        fmtOutRow.Controls.Add(outBoxWrap, 1, 0);
        Row(settings, fmtOutRow, 2, 62);

        // Rounded Sub-Card for Sliders + Live Output Size Estimate
        sliderGroupCard = new CardPanel { UseSubCard = true, Radius = 9, Padding = new Padding(12, 10, 12, 10), Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink };
        var sliderGrid = new TableLayoutPanel { ColumnCount = 1, RowCount = 8, Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = Padding.Empty };
        for (int i = 0; i < 8; i++) sliderGrid.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        keep = new Knob("keep", 1, 100, 75, v => v + "%"); keep.BindTip(AttachTip, "keep");
        keep.Track.ValueChanged += (s, e) => UpdateOutputEstimate();
        chkAdaptive.AutoSize = true; chkAdaptive.Checked = true; Bind(chkAdaptive, "adaptiveDecimate"); AttachTip(chkAdaptive, "adaptive");
        chkAdaptive.Margin = new Padding(0, 0, 0, 4);
        iterations = new Knob("iterations", 1, 100, 10, v => v.ToString()); iterations.BindTip(AttachTip, "iterations");
        effort = new Knob("effort", -1, 9, -1, v => v < 0 ? I18n.T("default") : v.ToString()); effort.BindTip(AttachTip, "effort");
        effort.Track.ValueChanged += (s, e) => UpdateOutputEstimate();
        workers = new Knob("workers", 0, 16, 4, v => v == 0 ? I18n.T("serial") : v.ToString()); workers.BindTip(AttachTip, "workers");
        voxel = new Knob("voxel", 1, 500, 50, v => F(v / 1000d)); voxel.BindTip(AttachTip, "voxel");
        opacity = new Knob("opacity", 0, 100, 10, v => F(v / 100d)); opacity.BindTip(AttachTip, "opacity");

        estSizeBar = new Panel { Dock = DockStyle.Fill, Height = 26, Padding = new Padding(8, 3, 8, 3), Margin = new Padding(0, 6, 0, 0) };
        estSizeLabel.Dock = DockStyle.Fill; estSizeLabel.TextAlign = ContentAlignment.MiddleLeft; estSizeLabel.Font = new Font("Microsoft YaHei UI", 8.2f, FontStyle.Bold); estSizeLabel.AutoEllipsis = true;
        estSizeBar.Controls.Add(estSizeLabel);
        AttachTip(estSizeBar, "estOutput"); AttachTip(estSizeLabel, "estOutput");

        Row(sliderGrid, keep, 0, 44);
        Row(sliderGrid, chkAdaptive, 1, 24);
        Row(sliderGrid, iterations, 2, 44);
        Row(sliderGrid, effort, 3, 44);
        Row(sliderGrid, workers, 4, 44);
        Row(sliderGrid, voxel, 5, 44);
        Row(sliderGrid, opacity, 6, 44);
        Row(sliderGrid, estSizeBar, 7, 30);
        sliderGroupCard.Controls.Add(sliderGrid);
        settings.Controls.Add(sliderGroupCard, 0, 3);

        // Device Segmented Control (Short crisp labels: 自动显卡 | Vulkan | 纯 CPU — zero ellipsis!)
        var devRow = Grid(2, 1);
        devRow.Padding = new Padding(0, 10, 0, 6);
        devRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 32));
        devRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 68));
        var devLbl = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Font = new Font(Font.FontFamily, 8.6f) };
        Bind(devLbl, "device"); themeUpdaters.Add(() => devLbl.ForeColor = Theme.Current.Ink);
        deviceSegment.Dock = DockStyle.Fill; deviceSegment.AccessibleName = "device";
        AttachTip(devLbl, "device"); AttachTip(deviceSegment, "device");
        devRow.Controls.Add(devLbl, 0, 0); devRow.Controls.Add(deviceSegment, 1, 0);
        Row(settings, devRow, 4, 46);

        var licBtn = ButtonOf("licenses", "licenses", "file", 148, () => MessageDialog.ShowLicenses(this));
        licBtn.Margin = new Padding(0, 6, 0, 0);
        Row(settings, licBtn, 5, 38);

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

        // ===== Progress + ETA + Action Footer (Fixed Image 6 spacing & breathing room!) =====
        footerPanel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(18, 10, 18, 10) };
        var footerGrid = Grid(1, 3);
        footerGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 22));
        footerGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 16));
        footerGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));

        var progInfo = Grid(4, 1);
        progInfo.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        progInfo.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 118));
        progInfo.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 144));
        progInfo.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 52));
        status.Dock = DockStyle.Fill; status.TextAlign = ContentAlignment.MiddleLeft; status.AutoEllipsis = true;
        elapsedLabel.Dock = DockStyle.Fill; elapsedLabel.TextAlign = ContentAlignment.MiddleRight; elapsedLabel.Font = new Font("Consolas", 8.5f);
        etaLabel.Dock = DockStyle.Fill; etaLabel.TextAlign = ContentAlignment.MiddleRight; etaLabel.Font = new Font("Consolas", 8.5f, FontStyle.Bold);
        progressPctLabel.Dock = DockStyle.Fill; progressPctLabel.TextAlign = ContentAlignment.MiddleRight; progressPctLabel.Font = new Font("Consolas", 9.2f, FontStyle.Bold);
        progressPctLabel.Text = "0%";
        progInfo.Controls.Add(status, 0, 0); progInfo.Controls.Add(elapsedLabel, 1, 0); progInfo.Controls.Add(etaLabel, 2, 0); progInfo.Controls.Add(progressPctLabel, 3, 0);
        footerGrid.Controls.Add(progInfo, 0, 0);

        var barWrap = new Panel { Dock = DockStyle.Fill, Padding = new Padding(0, 4, 0, 4) };
        progressBar.Dock = DockStyle.Fill;
        barWrap.Controls.Add(progressBar);
        footerGrid.Controls.Add(barWrap, 0, 1);

        var actRow = Grid(2, 1);
        actRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 52));
        actRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 48));

        var leftAct = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Padding = new Padding(0, 6, 0, 0) };
        btnLogToggle = ButtonOf("toggleLogs", "logs", "logs", 114, ToggleLogs); btnLogToggle.Height = 34;
        repository.Text = App.Repository; repository.AutoSize = true; repository.Margin = new Padding(12, 10, 0, 0); repository.AccessibleName = "repository";
        repository.LinkClicked += (s, e) => OpenRepository();
        leftAct.Controls.Add(btnLogToggle); leftAct.Controls.Add(repository);
        actRow.Controls.Add(leftAct, 0, 0);

        var rightAct = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Padding = new Padding(0, 5, 0, 0) };
        start = ButtonOf("start", "start", "play", 154, Begin); start.Primary = true; start.Height = 36; start.Margin = new Padding(10, 0, 0, 0); start.AccessibleName = "start";
        cancel = ButtonOf("cancel", "cancel", "stop", 110, Stop); cancel.Height = 36; cancel.Margin = new Padding(10, 0, 0, 0); cancel.Enabled = false;
        reveal = ButtonOf("openOutput", "openOutput", "folder", 148, OpenOutput); reveal.Height = 36; reveal.Visible = false;
        rightAct.Controls.Add(start); rightAct.Controls.Add(cancel); rightAct.Controls.Add(reveal);
        actRow.Controls.Add(rightAct, 1, 0);
        footerGrid.Controls.Add(actRow, 0, 2);
        footerPanel.Controls.Add(footerGrid);
        root.Controls.Add(footerPanel, 0, 3);

        // ===== Bottom 0.5s Hardware Telemetry Bar (Generous spacing, crisp Image 3 Lucide icons!) =====
        var resGrid = Grid(4, 1);
        resourceBar = resGrid;
        resGrid.Padding = new Padding(14, 6, 14, 8);
        string[] iconNames = { "cpu", "memory", "gpu", "vram" };
        string[] metricKeys = { "cpu", "ram", "gpu", "vram" };
        for (int i = 0; i < 4; i++) {
            resGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
            var tile = new FluentMetricTile { Dock = DockStyle.Fill, IconBaseName = iconNames[i], Margin = new Padding(5, 0, 5, 0), AccessibleName = "metric-" + iconNames[i] };
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
        chkAdaptive.ForeColor = p.Ink; chkAdaptive.BackColor = p.SubCardBg;
        estSizeBar.BackColor = p.AccentSoft; estSizeLabel.ForeColor = p.Accent;
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

    void SetShOp(bool enabled, string band) {
        var shOp = outputOps.FirstOrDefault(o => o.Step.Flag == "--filter-harmonics");
        if (shOp == null && enabled) {
            outputOps.Add(new Op { Step = Step.All[4], Value = band, Enabled = true });
        } else if (shOp != null) {
            shOp.Enabled = enabled;
            if (band != null) shOp.Value = band;
        }
        RefreshOps(-1);
    }

    // 4 Well-Calibrated Presets: 0=快速转换, 1=极致瘦身, 2=网页均衡, 3=高质归档
    void ApplyPreset(int idx) {
        if (idx == 0) {
            // 快速转换：最快速度出图，不抽稀、低迭代、WebP 0
            keep.Value = 100; chkAdaptive.Checked = false; iterations.Value = 3; effort.Value = 0; workers.Value = 6;
            SetShOp(false, null);
        } else if (idx == 1) {
            // 极致瘦身：45% 自适应抽稀 + SH 0 阶 + WebP 8
            keep.Value = 45; chkAdaptive.Checked = true; iterations.Value = 6; effort.Value = 8; workers.Value = 4;
            SetShOp(true, "0");
        } else if (idx == 2) {
            // 网页均衡（推荐）：75% 自适应抽稀 + SH 1 阶 + 默认迭代/WebP
            keep.Value = 75; chkAdaptive.Checked = true; iterations.Value = 10; effort.Value = -1; workers.Value = 4;
            SetShOp(true, "1");
        } else {
            // 高质归档：100% 完整保留 + 完整 SH + 25 次迭代 + WebP 9 无损压榨
            keep.Value = 100; chkAdaptive.Checked = true; iterations.Value = 25; effort.Value = 9; workers.Value = 4;
            SetShOp(false, null);
        }
        UpdateOutputEstimate();
    }

    void UpdateOutputEstimate() {
        var shOp = outputOps.FirstOrDefault(o => o.Enabled && o.Step.Flag == "--filter-harmonics");
        int? shLim = null;
        int parsed;
        if (shOp != null && Int32.TryParse(shOp.Value, out parsed)) shLim = parsed;
        long[] range = Budget.EstimateOutputBytes(inputs, SelectedFormat, keep.Value, shLim, effort.Value);
        if (range == null) {
            estSizeLabel.Text = I18n.T("estOutput") + "：" + I18n.T("estUnknown");
            return;
        }
        long inputBytes = 0;
        foreach (var inp in inputs) { try { inputBytes += new FileInfo(inp.Path).Length; } catch { } }
        string txt = I18n.T("estOutput") + "：≈ " + SizeText(range[0]) + " – " + SizeText(range[1]);
        if (inputBytes > 0) {
            double mid = (range[0] + range[1]) / 2d;
            int savePct = (int)Math.Round((1d - mid / inputBytes) * 100d);
            if (savePct > 5) txt += "  (-" + savePct + "%)";
        }
        estSizeLabel.Text = txt;
    }

    void ToggleLogs() { logsExpanded = !logsExpanded; logDrawer.Visible = logsExpanded; }

    void OpenEngineUpdater() {
        using (var dlg = new EngineUpdateDialog(this, () => {
            btnEngine.Text = "● " + I18n.T("engineBadge").Replace("{0}", EngineManager.ActiveVersion);
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
        btnEngine.Text = "● " + I18n.T("engineBadge").Replace("{0}", EngineManager.ActiveVersion);
        modeSegment.SetItems(I18n.T("batchMode"), I18n.T("mergeMode"));
        modeSegment.SelectedIndex = batchMode ? 0 : 1;
        presetSegment.SetItems(I18n.T("presetFast"), I18n.T("presetLite"), I18n.T("presetBalanced"), I18n.T("presetHq"));
        if (presetSegment.SelectedIndex < 0) presetSegment.SelectedIndex = 2;
        int fIdx = Math.Max(0, formats.SelectedIndex);
        formats.SetItems(Converter.Formats.Cast<object>(), fIdx);
        RefreshDevices();
        foreach (var knob in new[] { keep, iterations, effort, workers, voxel, opacity }) knob.Translate();
        changing = false;
        FormatVisibility(); RefreshFiles(-1); SetStatus(statusKey); PaintMetrics(); UpdateOutputEstimate();
    }

    void RefreshDevices() {
        int sel = Math.Max(0, deviceSegment.SelectedIndex);
        if (SelectedFormat.Voxel) deviceSegment.SetItems(I18n.T("devAuto"), I18n.T("devVulkan"));
        else deviceSegment.SetItems(I18n.T("devAuto"), I18n.T("devVulkan"), I18n.T("devCpu"));
        deviceSegment.SelectedIndex = Math.Min(sel, SelectedFormat.Voxel ? 1 : 2);
    }

    void FormatChanged() { RefreshDevices(); FormatVisibility(); autoPath = true; SuggestPath(); UpdateOutputEstimate(); }
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
        changing = true; int previous = scope.SelectedIndex;
        var scopeItems = new List<object> { I18n.T("merged") };
        long bytes = 0;
        foreach (var input in inputs) {
            var info = new FileInfo(input.Path); long size = info.Exists ? info.Length : 0; bytes += size;
            scopeItems.Add(info.Name);
        }
        fileList.SetFiles(inputs, select);
        scope.SetItems(scopeItems, select >= 0 ? select + 1 : Math.Max(0, Math.Min(previous, scopeItems.Count - 1)));
        changing = false;
        tally.Text = inputs.Count + " " + I18n.T("files") + (bytes > 0 ? " · " + SizeText(bytes) : "");
        RefreshOps(-1); SuggestPath(); RefreshStart(); UpdateOutputEstimate();
    }

    List<Op> CurrentOps() { return scope.SelectedIndex <= 0 || scope.SelectedIndex > inputs.Count ? outputOps : inputs[scope.SelectedIndex - 1].Ops; }
    void RefreshOps(int select) { opList.SetOps(CurrentOps(), select); }
    void MoveOp(int delta) { var ops = CurrentOps(); int i = opList.SelectedIndex, j = i + delta; if (i < 0 || j < 0 || j >= ops.Count) return; var op = ops[i]; ops.RemoveAt(i); ops.Insert(j, op); RefreshOps(j); }
    void EditOp(bool edit) {
        var ops = CurrentOps(); int i = opList.SelectedIndex; if (edit && i < 0) return;
        using (var dialog = new StepDialog(this, edit ? ops[i] : null)) {
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            if (edit) ops[i] = dialog.Result; else { i = ops.Count; ops.Add(dialog.Result); }
            RefreshOps(i); FormatVisibility(); UpdateOutputEstimate();
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
                bool proceed = WarningOverride != null ? WarningOverride(message) : MessageDialog.ResourceWarning(this, estimate, preflightResources, message, I18n.T("continue"), I18n.T("adjust"));
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
                summary = I18n.T("output") + ": " + Path.GetFileName(completed) + " (" + SizeText(new FileInfo(completed).Length) + ")";
                status.Text += " · " + SizeText(new FileInfo(completed).Length);
            } else if (batchMode) {
                summary = I18n.T("batchMode") + " · " + job.Inputs.Count + " " + I18n.T("files");
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
}
