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
    internal static Image Themed(string baseName) {
        return Icon(Theme.Current.IsDark ? baseName + "-white" : baseName) ?? Icon(baseName);
    }
}

sealed class DisplayCombo : ComboBox {
    internal DisplayCombo() {
        DropDownStyle = ComboBoxStyle.DropDownList; DrawMode = DrawMode.OwnerDrawFixed;
        ItemHeight = Font.Height + 6;
    }
    protected override void OnFontChanged(EventArgs e) { base.OnFontChanged(e); ItemHeight = Font.Height + 6; }
    protected override void OnDrawItem(DrawItemEventArgs e) {
        var p = Theme.Current;
        bool selected = (e.State & DrawItemState.Selected) == DrawItemState.Selected;
        using (var bg = new SolidBrush(selected ? p.AccentSoft : p.InputBg))
            e.Graphics.FillRectangle(bg, e.Bounds);
        if (e.Index >= 0 && e.Index < Items.Count)
            TextRenderer.DrawText(e.Graphics, GetItemText(Items[e.Index]), Font, Rectangle.Inflate(e.Bounds, -5, 0),
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
    internal readonly TrackBar Track;
    readonly Label label, value;
    readonly string key;
    readonly Func<int, string> format;
    internal int Value { get { return Track.Value; } set { Track.Value = Math.Max(Track.Minimum, Math.Min(Track.Maximum, value)); } }
    internal Knob(string key, int min, int max, int initial, Func<int, string> format) {
        this.key = key; this.format = format; Height = 50; Margin = Padding.Empty;
        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, Margin = Padding.Empty };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 72));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 28));
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 20));
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        label = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.BottomLeft, AutoEllipsis = true, UseMnemonic = false };
        value = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.BottomRight, AutoEllipsis = true, Font = new Font("Consolas", 8.8f, FontStyle.Bold) };
        Track = new TrackBar { Minimum = min, Maximum = max, Value = initial, TickStyle = TickStyle.None, Dock = DockStyle.Fill, AutoSize = false, Margin = new Padding(0, 2, 0, 0), AccessibleName = key };
        Track.ValueChanged += (s, e) => value.Text = format(Track.Value);
        grid.Controls.Add(label, 0, 0); grid.Controls.Add(value, 1, 0);
        grid.Controls.Add(Track, 0, 1); grid.SetColumnSpan(Track, 2);
        Controls.Add(grid); Translate(); ApplyTheme();
    }
    internal void Translate() { label.Text = I18n.T(key); value.Text = format(Track.Value); }
    internal void ApplyTheme() {
        var p = Theme.Current;
        BackColor = p.CardBg;
        label.ForeColor = p.Ink;
        value.ForeColor = p.Accent;
        Track.BackColor = p.CardBg;
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
    readonly ListView files = new ListView();
    readonly ListBox steps = new ListBox();
    readonly ComboBox scope = Combo(), formats = Combo(), device = Combo(), language = Combo();
    readonly TextBox output = new TextBox(), logView = new TextBox();
    readonly Label status = new Label(), tally = new Label(), outputLabel = new Label();
    readonly Label progressPctLabel = new Label(), etaLabel = new Label(), elapsedLabel = new Label();
    readonly ModernProgressBar progressBar = new ModernProgressBar();
    readonly ToolTip tips = new ToolTip();
    readonly ConcurrentQueue<string> events = new ConcurrentQueue<string>();
    readonly System.Windows.Forms.Timer ticker = new System.Windows.Forms.Timer { Interval = 250 };
    readonly List<Action> translations = new List<Action>();
    readonly List<Action> themeUpdaters = new List<Action>();
    readonly Label[] metrics = new Label[4];
    readonly PictureBox[] metricIcons = new PictureBox[4];
    readonly Panel[] metricTiles = new Panel[4];
    readonly Knob keep, iterations, effort, workers, voxel, opacity;
    readonly CheckBox chkAdaptive = new CheckBox(), chkQuickNan = new CheckBox(), chkQuickFloaters = new CheckBox(), chkQuickSh1 = new CheckBox();
    readonly TableLayoutPanel workspace;
    readonly Panel headerPanel, footerPanel, resourceBar, logDrawer;
    readonly Button start, cancel, reveal, btnEngine, btnTheme, btnBatch, btnMerge, btnLogToggle;
    readonly Button btnPresetLite, btnPresetBalanced, btnPresetHq;
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
        MinimumSize = new Size(1120, 760);
        Size = new Size(1280, 840);
        StartPosition = FormStartPosition.CenterScreen;
        Text = "Splat Convert Desktop 2.0.0";
        Icon = SystemIcons.Application;

        var root = Grid(1, 5);
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));   // Top header bar
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));   // 3-Column Pipeline (Proposal C)
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // Collapsible log drawer
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 86));   // Progress + ETA + Action footer
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));   // Bottom 0.5s Telemetry bar

        // ===== Header Bar =====
        headerPanel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(18, 0, 18, 0) };
        var brand = new Label { Text = "Splat Convert", Font = new Font(Font.FontFamily, 15.5f, FontStyle.Bold), Dock = DockStyle.Left, Width = 170, TextAlign = ContentAlignment.MiddleLeft };
        var verBadge = new Label { Text = "v2.0", Dock = DockStyle.Left, Width = 44, TextAlign = ContentAlignment.MiddleLeft, Font = new Font(Font.FontFamily, 8.5f, FontStyle.Bold) };
        btnEngine = new Button { Width = 220, Height = 30, FlatStyle = FlatStyle.Flat, Dock = DockStyle.Left, Margin = new Padding(8, 14, 0, 14), Cursor = Cursors.Hand };
        var engineHost = new Panel { Dock = DockStyle.Left, Width = 235, Padding = new Padding(6, 13, 0, 13) };
        btnEngine.Dock = DockStyle.Fill;
        btnEngine.Click += (s, e) => OpenEngineUpdater();
        AttachTip(btnEngine, "engine");
        engineHost.Controls.Add(btnEngine);

        var rightHeader = new FlowLayoutPanel { Dock = DockStyle.Right, Width = 330, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 12, 0, 10), WrapContents = false };
        language.Items.AddRange(I18n.Names);
        language.SelectedIndex = Array.IndexOf(I18n.Codes, I18n.Language);
        language.AccessibleName = "language";
        language.Width = 128;
        btnTheme = new Button { Width = 112, Height = 30, FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand, Margin = new Padding(0, 2, 10, 0) };
        btnTheme.Click += (s, e) => { Theme.Toggle(); ApplyThemeAll(); };
        rightHeader.Controls.Add(language);
        rightHeader.Controls.Add(btnTheme);

        headerPanel.Controls.Add(engineHost);
        headerPanel.Controls.Add(verBadge);
        headerPanel.Controls.Add(brand);
        headerPanel.Controls.Add(rightHeader);
        themeUpdaters.Add(() => {
            headerPanel.BackColor = Theme.Current.TitleBarBg;
            brand.ForeColor = Theme.Current.Ink;
            verBadge.ForeColor = Theme.Current.Muted;
            btnEngine.BackColor = Theme.Current.AccentSoft;
            btnEngine.ForeColor = Theme.Current.Accent;
            btnEngine.FlatAppearance.BorderColor = Theme.Current.Accent;
            btnEngine.Text = "引擎 v" + EngineManager.ActiveVersion + " · 国内镜像更新";
            btnTheme.BackColor = Theme.Current.CardBg;
            btnTheme.ForeColor = Theme.Current.Ink;
            btnTheme.FlatAppearance.BorderColor = Theme.Current.BorderStrong;
            btnTheme.Text = I18n.T(Theme.Current.IsDark ? "themeLight" : "themeDark");
        });
        root.Controls.Add(headerPanel, 0, 0);

        // ===== Proposal C: 3-Column Pipeline Flow (01 Inputs -> 02 Clean & Transform -> 03 Output & Compress) =====
        workspace = Grid(3, 1);
        workspace.Padding = new Padding(14, 12, 14, 8);
        workspace.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.3f));
        workspace.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.4f));
        workspace.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.3f));

        // Column 1: 01 Source Files
        var col1Card = new CardPanel { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 6, 0) };
        var col1 = Grid(1, 4);
        col1.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        col1.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        col1.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        col1.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        var col1Head = Grid(2, 1);
        col1Head.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 55));
        col1Head.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 45));
        col1Head.Controls.Add(Section("01", "inputs", "file"), 0, 0);
        tally.Dock = DockStyle.Fill; tally.TextAlign = ContentAlignment.MiddleRight; tally.AutoEllipsis = true;
        col1Head.Controls.Add(tally, 1, 0);
        col1.Controls.Add(col1Head, 0, 0);

        var modeRow = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty, Padding = new Padding(0, 2, 0, 2) };
        btnMerge = ModeButton("mergeMode", () => SetBatchMode(false));
        btnBatch = ModeButton("batchMode", () => SetBatchMode(true));
        AttachTip(btnMerge, "mode"); AttachTip(btnBatch, "mode");
        modeRow.Controls.Add(btnMerge); modeRow.Controls.Add(btnBatch);
        col1.Controls.Add(modeRow, 0, 1);

        var fileTools = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty };
        fileTools.Controls.Add(ButtonOf("add", "add", "plus", 140, BrowseInputs));
        fileTools.Controls.Add(ButtonOf(null, "remove", "minus", 34, RemoveFiles));
        fileTools.Controls.Add(ButtonOf(null, "up", "up", 34, () => MoveFile(-1)));
        fileTools.Controls.Add(ButtonOf(null, "down", "down", 34, () => MoveFile(1)));
        col1.Controls.Add(fileTools, 0, 2);

        files.Dock = DockStyle.Fill; files.View = View.Details; files.FullRowSelect = true; files.HideSelection = false;
        files.BorderStyle = BorderStyle.FixedSingle;
        files.Columns.Add("", 200); files.Columns.Add("", 82, HorizontalAlignment.Right); files.ShowItemToolTips = true;
        files.Resize += (s, e) => files.Columns[0].Width = Math.Max(110, files.ClientSize.Width - 88);
        files.AllowDrop = true;
        files.DragEnter += (s, e) => { if (active == null && e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy; };
        files.DragDrop += (s, e) => AddFiles((string[])e.Data.GetData(DataFormats.FileDrop));
        files.SelectedIndexChanged += (s, e) => { if (!changing && files.SelectedIndices.Count == 1) scope.SelectedIndex = files.SelectedIndices[0] + 1; };
        col1.Controls.Add(files, 0, 3);
        col1Card.Controls.Add(col1);
        workspace.Controls.Add(col1Card, 0, 0);

        // Column 2: 02 Clean & Transform Pipeline
        var col2Card = new CardPanel { Dock = DockStyle.Fill, Margin = new Padding(6, 0, 6, 0) };
        var col2 = Grid(1, 5);
        col2.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        col2.RowStyles.Add(new RowStyle(SizeType.Absolute, 86));  // Quick beginner cleaning switches
        col2.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));  // Scope combo
        col2.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));  // Op buttons
        col2.RowStyles.Add(new RowStyle(SizeType.Percent, 100));  // Custom ops list

        col2.Controls.Add(Section("02", "actions", "layers"), 0, 0);

        var quickPanel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(4, 2, 4, 2) };
        chkQuickNan.AutoSize = true; chkQuickNan.Checked = true; Bind(chkQuickNan, "quickNan"); AttachTip(chkQuickNan, "nan");
        chkQuickFloaters.AutoSize = true; chkQuickFloaters.Checked = false; Bind(chkQuickFloaters, "quickFloaters"); AttachTip(chkQuickFloaters, "floaters");
        chkQuickSh1.AutoSize = true; chkQuickSh1.Checked = false; Bind(chkQuickSh1, "quickSh"); AttachTip(chkQuickSh1, "sh");
        quickPanel.Controls.Add(chkQuickNan);
        quickPanel.Controls.Add(chkQuickFloaters);
        quickPanel.Controls.Add(chkQuickSh1);
        col2.Controls.Add(quickPanel, 0, 1);

        scope.Items.Add(""); scope.SelectedIndex = 0; scope.AccessibleName = "scope";
        scope.SelectedIndexChanged += (s, e) => { if (!changing) RefreshOps(-1); };
        col2.Controls.Add(scope, 0, 2);

        var opButtons = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty };
        opButtons.Controls.Add(ButtonOf("addOp", "addOp", "plus", 112, () => EditOp(false)));
        opButtons.Controls.Add(ButtonOf(null, "edit", "edit", 34, () => EditOp(true)));
        opButtons.Controls.Add(ButtonOf(null, "remove", "minus", 34, () => { int i = steps.SelectedIndex; if (i >= 0) { CurrentOps().RemoveAt(i); RefreshOps(i); } }));
        opButtons.Controls.Add(ButtonOf(null, "up", "up", 34, () => MoveOp(-1)));
        opButtons.Controls.Add(ButtonOf(null, "down", "down", 34, () => MoveOp(1)));
        col2.Controls.Add(opButtons, 0, 3);

        steps.Dock = DockStyle.Fill; steps.IntegralHeight = false; steps.ItemHeight = 26; steps.BorderStyle = BorderStyle.FixedSingle;
        steps.DoubleClick += (s, e) => EditOp(true);
        col2.Controls.Add(steps, 0, 4);
        col2Card.Controls.Add(col2);
        workspace.Controls.Add(col2Card, 1, 0);

        // Column 3: 03 Output & Compression Settings
        var col3Card = new CardPanel { Dock = DockStyle.Fill, Margin = new Padding(6, 0, 0, 0) };
        var settingsHost = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
        var settings = new TableLayoutPanel { ColumnCount = 1, RowCount = 13, Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = Padding.Empty };
        for (int i = 0; i < 13; i++) settings.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        Row(settings, Section("03", "settings", "settings"), 0, 32);

        var presetRow = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty, Padding = new Padding(0, 2, 0, 4) };
        btnPresetLite = PresetBtn("presetLite", () => ApplyPreset("lite"));
        btnPresetBalanced = PresetBtn("presetBalanced", () => ApplyPreset("balanced"));
        btnPresetHq = PresetBtn("presetHq", () => ApplyPreset("hq"));
        AttachTip(btnPresetLite, "preset"); AttachTip(btnPresetBalanced, "preset"); AttachTip(btnPresetHq, "preset");
        presetRow.Controls.Add(btnPresetLite); presetRow.Controls.Add(btnPresetBalanced); presetRow.Controls.Add(btnPresetHq);
        Row(settings, presetRow, 1, 34);

        formats.Items.AddRange(Converter.Formats); formats.SelectedIndex = 0; formats.AccessibleName = "format";
        var formatPair = Pair("format", formats); AttachTip(formatPair, "format"); AttachTip(formats, "format");
        Row(settings, formatPair, 2, 36);

        output.Dock = DockStyle.Fill; output.AccessibleName = "output";
        output.TextChanged += (s, e) => { if (!updatingPath) autoPath = false; RefreshStart(); };
        var outputField = Grid(2, 1);
        outputField.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        outputField.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 38));
        outputField.Controls.Add(output, 0, 0);
        outputField.Controls.Add(ButtonOf(null, "browse", "folder", 34, BrowseOutput), 1, 0);
        var outPair = Grid(2, 1);
        outPair.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 96));
        outPair.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        outputLabel.Dock = DockStyle.Fill; outputLabel.TextAlign = ContentAlignment.MiddleLeft; outputLabel.UseMnemonic = false;
        outPair.Controls.Add(outputLabel, 0, 0); outPair.Controls.Add(outputField, 1, 0);
        Row(settings, outPair, 3, 36);

        keep = new Knob("keep", 1, 100, 100, v => v + "%"); keep.BindTip(AttachTip, "keep");
        chkAdaptive.AutoSize = true; chkAdaptive.Checked = true; Bind(chkAdaptive, "adaptiveDecimate"); AttachTip(chkAdaptive, "adaptive");
        iterations = new Knob("iterations", 1, 100, 10, v => v.ToString()); iterations.BindTip(AttachTip, "iterations");
        effort = new Knob("effort", -1, 9, -1, v => v < 0 ? I18n.T("default") : v.ToString()); effort.BindTip(AttachTip, "effort");
        workers = new Knob("workers", 0, 16, 4, v => v == 0 ? I18n.T("serial") : v.ToString()); workers.BindTip(AttachTip, "workers");
        voxel = new Knob("voxel", 1, 500, 50, v => F(v / 1000d)); voxel.BindTip(AttachTip, "voxel");
        opacity = new Knob("opacity", 0, 100, 10, v => F(v / 100d)); opacity.BindTip(AttachTip, "opacity");

        Row(settings, keep, 4, 50);
        Row(settings, chkAdaptive, 5, 24);
        Row(settings, iterations, 6, 50);
        Row(settings, effort, 7, 50);
        Row(settings, workers, 8, 50);
        Row(settings, voxel, 9, 50);
        Row(settings, opacity, 10, 50);

        device.AccessibleName = "device";
        var devPair = Pair("device", device); AttachTip(devPair, "device"); AttachTip(device, "device");
        Row(settings, devPair, 11, 36);
        Row(settings, ButtonOf("licenses", "licenses", "file", 160, ShowLicenses), 12, 34);

        settingsHost.Controls.Add(settings);
        col3Card.Controls.Add(settingsHost);
        workspace.Controls.Add(col3Card, 2, 0);
        root.Controls.Add(workspace, 0, 1);

        // ===== Collapsible Log Drawer =====
        logDrawer = new Panel { Dock = DockStyle.Fill, Height = 128, Visible = false, Padding = new Padding(14, 0, 14, 6) };
        logView.Multiline = true; logView.ReadOnly = true; logView.Dock = DockStyle.Fill; logView.ScrollBars = ScrollBars.Vertical;
        logView.BorderStyle = BorderStyle.FixedSingle; logView.Font = new Font("Consolas", 8.8f); logView.AccessibleName = "log";
        logDrawer.Controls.Add(logView);
        root.Controls.Add(logDrawer, 0, 2);

        // ===== Progress + ETA + Action Footer =====
        footerPanel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(16, 6, 16, 6) };
        var footerGrid = Grid(1, 3);
        footerGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 22));
        footerGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 12));
        footerGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));

        var progInfo = Grid(4, 1);
        progInfo.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        progInfo.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 115));
        progInfo.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
        progInfo.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 55));
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

        var leftAct = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Padding = new Padding(0, 4, 0, 0) };
        btnLogToggle = ButtonOf("toggleLogs", "logs", "logs", 112, ToggleLogs);
        repository.Text = App.Repository; repository.AutoSize = true; repository.Margin = new Padding(10, 9, 0, 0); repository.AccessibleName = "repository";
        repository.LinkClicked += (s, e) => OpenRepository();
        leftAct.Controls.Add(btnLogToggle); leftAct.Controls.Add(repository);
        actRow.Controls.Add(leftAct, 0, 0);

        var rightAct = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Padding = new Padding(0, 3, 0, 0) };
        start = ButtonOf("start", "start", "play-white", 150, Begin); start.AccessibleName = "start";
        cancel = ButtonOf("cancel", "cancel", "stop", 110, Stop); cancel.Enabled = false;
        reveal = ButtonOf("openOutput", "openOutput", "folder", 145, OpenOutput); reveal.Visible = false;
        rightAct.Controls.Add(start); rightAct.Controls.Add(cancel); rightAct.Controls.Add(reveal);
        actRow.Controls.Add(rightAct, 1, 0);
        footerGrid.Controls.Add(actRow, 0, 2);
        footerPanel.Controls.Add(footerGrid);
        root.Controls.Add(footerPanel, 0, 3);

        // ===== Bottom 0.5s Hardware Telemetry Bar (Lucide Icons + Hover Dual-Color History Chart) =====
        var resGrid = Grid(4, 1);
        resourceBar = resGrid;
        resGrid.Padding = new Padding(14, 4, 14, 4);
        string[] iconNames = { "cpu", "memory", "gpu", "vram" };
        string[] metricKeys = { "cpu", "ram", "gpu", "vram" };
        for (int i = 0; i < 4; i++) {
            resGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
            var tile = new Panel { Dock = DockStyle.Fill, Margin = new Padding(4, 0, 4, 0), Padding = new Padding(6, 0, 6, 0), Cursor = Cursors.Hand };
            var pic = new PictureBox { Dock = DockStyle.Left, Width = 24, SizeMode = PictureBoxSizeMode.CenterImage };
            var lbl = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true, AccessibleName = "metric-" + iconNames[i] };
            tile.Controls.Add(lbl); tile.Controls.Add(pic);
            metrics[i] = lbl; metricIcons[i] = pic; metricTiles[i] = tile;
            string mKey = metricKeys[i];
            Action enter = () => {
                activeHoverMetric = mKey;
                chartPopup.UpdateData(mKey, telemetry.Snapshot(), resources, tile);
            };
            Action leave = () => {
                if (!tile.ClientRectangle.Contains(tile.PointToClient(Cursor.Position))) {
                    activeHoverMetric = null;
                    chartPopup.Hide();
                }
            };
            tile.MouseEnter += (s, e) => enter(); lbl.MouseEnter += (s, e) => enter(); pic.MouseEnter += (s, e) => enter();
            tile.MouseLeave += (s, e) => leave(); lbl.MouseLeave += (s, e) => leave(); pic.MouseLeave += (s, e) => leave();
            resGrid.Controls.Add(tile, i, 0);
        }
        root.Controls.Add(resGrid, 0, 4);
        Controls.Add(root);

        formats.SelectedIndexChanged += (s, e) => { if (!changing) FormatChanged(); };
        language.SelectedIndexChanged += (s, e) => {
            if (changing || language.SelectedIndex < 0) return;
            I18n.Language = I18n.Codes[language.SelectedIndex]; I18n.Save(); Translate();
        };

        // 0.5s high-frequency telemetry sampling + log flush
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
        files.BackColor = p.InputBg; files.ForeColor = p.Ink;
        steps.BackColor = p.InputBg; steps.ForeColor = p.Ink;
        output.BackColor = p.InputBg; output.ForeColor = p.Ink;
        foreach (var cb in new[] { scope, formats, device, language }) { cb.BackColor = p.InputBg; cb.ForeColor = p.Ink; }
        foreach (var chk in new[] { chkAdaptive, chkQuickNan, chkQuickFloaters, chkQuickSh1 }) { chk.ForeColor = p.Ink; chk.BackColor = p.CardBg; }
        tally.ForeColor = p.Muted; outputLabel.ForeColor = p.Ink;
        status.ForeColor = p.Ink; elapsedLabel.ForeColor = p.Muted; etaLabel.ForeColor = p.Accent; progressPctLabel.ForeColor = p.Ink;
        repository.LinkColor = p.Muted;
        foreach (var k in new[] { keep, iterations, effort, workers, voxel, opacity }) k.ApplyTheme();
        string[] iconNames = { "cpu", "memory", "gpu", "vram" };
        for (int i = 0; i < 4; i++) {
            metricTiles[i].BackColor = p.CardBg;
            metrics[i].ForeColor = p.Ink;
            metricIcons[i].Image = Art.Themed(iconNames[i]);
        }
        start.BackColor = p.Accent; start.ForeColor = p.AccentText; start.FlatAppearance.BorderColor = p.Accent;
        start.Image = Art.Icon(p.IsDark ? "play" : "play-white");
        UpdateModeButtons();
        foreach (var u in themeUpdaters) u();
        Invalidate(true);
    }

    Button ModeButton(string key, Action click) {
        var b = new Button { Width = 128, Height = 28, FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand, Margin = new Padding(0, 0, 6, 0) };
        Bind(b, key); b.Click += (s, e) => click();
        return b;
    }

    Button PresetBtn(string key, Action click) {
        var b = new Button { Width = 86, Height = 26, FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand, Margin = new Padding(0, 0, 6, 0) };
        Bind(b, key); b.Click += (s, e) => click();
        themeUpdaters.Add(() => { b.BackColor = Theme.Current.SubCardBg; b.ForeColor = Theme.Current.Ink; b.FlatAppearance.BorderColor = Theme.Current.BorderStrong; });
        return b;
    }

    void UpdateModeButtons() {
        var p = Theme.Current;
        btnMerge.BackColor = !batchMode ? p.AccentSoft : p.SubCardBg;
        btnMerge.ForeColor = !batchMode ? p.Accent : p.Text2;
        btnMerge.FlatAppearance.BorderColor = !batchMode ? p.Accent : p.Border;
        btnBatch.BackColor = batchMode ? p.AccentSoft : p.SubCardBg;
        btnBatch.ForeColor = batchMode ? p.Accent : p.Text2;
        btnBatch.FlatAppearance.BorderColor = batchMode ? p.Accent : p.Border;
    }

    void SetBatchMode(bool isBatch) {
        batchMode = isBatch;
        UpdateModeButtons();
        outputLabel.Text = I18n.T(batchMode ? "outputFolder" : "output");
        autoPath = true;
        SuggestPath();
    }

    void ApplyPreset(string preset) {
        if (preset == "lite") { keep.Value = 50; chkAdaptive.Checked = true; iterations.Value = 8; effort.Value = 7; chkQuickSh1.Checked = true; }
        else if (preset == "balanced") { keep.Value = 75; chkAdaptive.Checked = true; iterations.Value = 10; effort.Value = -1; chkQuickSh1.Checked = false; }
        else { keep.Value = 100; iterations.Value = 20; effort.Value = 6; chkQuickSh1.Checked = false; }
    }

    void ToggleLogs() {
        logsExpanded = !logsExpanded;
        logDrawer.Visible = logsExpanded;
    }

    void OpenEngineUpdater() {
        using (var dlg = new EngineUpdateDialog(this, () => {
            btnEngine.Text = "引擎 v" + EngineManager.ActiveVersion + " · 国内镜像更新";
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
    static ComboBox Combo() { return new DisplayCombo { Dock = DockStyle.Fill, Margin = new Padding(0, 3, 0, 3) }; }
    Control IconText(Control text, string icon) {
        var row = Grid(2, 1); row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 24)); row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        var pic = new PictureBox { Dock = DockStyle.Fill, SizeMode = PictureBoxSizeMode.CenterImage };
        themeUpdaters.Add(() => pic.Image = Art.Themed(icon));
        row.Controls.Add(pic, 0, 0); row.Controls.Add(text, 1, 0); return row;
    }
    Button ButtonOf(string text, string hint, string icon, int width, Action action) {
        var button = new Button {
            Width = width, Height = 32, FlatStyle = FlatStyle.Flat, Margin = new Padding(0, 2, 5, 2),
            TextImageRelation = TextImageRelation.ImageBeforeText, Padding = new Padding(3, 0, 3, 0),
            AutoEllipsis = true, UseMnemonic = false, Cursor = Cursors.Hand
        };
        button.Click += (s, e) => action();
        translations.Add(() => { button.Text = text == null ? "" : I18n.T(text); tips.SetToolTip(button, I18n.T(hint)); });
        themeUpdaters.Add(() => {
            if (button == start) return;
            var p = Theme.Current;
            button.BackColor = p.CardBg; button.ForeColor = p.Ink;
            button.FlatAppearance.BorderColor = p.BorderStrong;
            button.FlatAppearance.MouseOverBackColor = p.AccentSoft;
            if (icon != null) button.Image = Art.Themed(icon.Replace("-white", ""));
        });
        return button;
    }
    Control Section(string number, string key, string icon) {
        var label = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Font = new Font(Font.FontFamily, 9.8f, FontStyle.Bold), UseMnemonic = false };
        translations.Add(() => label.Text = number + "  " + I18n.T(key));
        themeUpdaters.Add(() => label.ForeColor = Theme.Current.Ink);
        return IconText(label, icon);
    }
    Control Pair(string key, Control field) {
        var grid = Grid(2, 1); grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 96)); grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        var label = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true }; Bind(label, key);
        themeUpdaters.Add(() => label.ForeColor = Theme.Current.Ink);
        grid.Controls.Add(label, 0, 0); field.Dock = DockStyle.Fill; grid.Controls.Add(field, 1, 0); return grid;
    }
    static void Row(TableLayoutPanel grid, Control control, int row, int height) { control.Height = height; control.Dock = DockStyle.Top; control.Margin = Padding.Empty; grid.Controls.Add(control, 0, row); }

    internal void SetLanguage(string code) {
        int index = Array.IndexOf(I18n.Codes, code); if (index < 0) return;
        changing = true; language.SelectedIndex = index; I18n.Language = code; changing = false; Translate();
    }
    void Translate() {
        changing = true;
        foreach (var update in translations) update();
        files.Columns[0].Text = I18n.T("fileName"); files.Columns[1].Text = I18n.T("size");
        outputLabel.Text = I18n.T(batchMode ? "outputFolder" : "output");
        btnTheme.Text = I18n.T(Theme.Current.IsDark ? "themeLight" : "themeDark");
        int index = Math.Max(0, formats.SelectedIndex); formats.Items.Clear(); formats.Items.AddRange(Converter.Formats); formats.SelectedIndex = index;
        RefreshDevices();
        foreach (var knob in new[] { keep, iterations, effort, workers, voxel, opacity }) knob.Translate();
        changing = false;
        FormatVisibility(); RefreshFiles(-1); SetStatus(statusKey); PaintMetrics();
    }
    void RefreshDevices() {
        int selected = Math.Max(0, device.SelectedIndex); device.Items.Clear();
        device.Items.Add(I18n.T("auto"));
        if (!SelectedFormat.Voxel) device.Items.Add(I18n.T("cpuDevice"));
        device.Items.Add(I18n.T("backend"));
        device.SelectedIndex = Math.Min(selected, device.Items.Count - 1);
    }
    void FormatChanged() { RefreshDevices(); FormatVisibility(); autoPath = true; SuggestPath(); }
    void FormatVisibility() {
        iterations.Visible = effort.Visible = workers.Visible = SelectedFormat.Sog;
        voxel.Visible = opacity.Visible = SelectedFormat.Voxel;
        device.Parent.Visible = SelectedFormat.Sog || SelectedFormat.Voxel || chkQuickFloaters.Checked;
    }
    Format SelectedFormat { get { return (Format)formats.SelectedItem; } }
    static string F(double number) { return number.ToString("0.###", CultureInfo.InvariantCulture); }
    static string SizeText(long size) { return size >= 1073741824 ? Budget.GB(size) : (size / 1048576d).ToString("0.0", CultureInfo.InvariantCulture) + " MiB"; }
    static string FmtDuration(double sec) {
        int s = Math.Max(0, (int)Math.Round(sec));
        return (s / 60).ToString("00") + ":" + (s % 60).ToString("00");
    }

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
    void RemoveFiles() { foreach (int i in files.SelectedIndices.Cast<int>().Reverse().ToArray()) inputs.RemoveAt(i); RefreshFiles(-1); }
    void MoveFile(int delta) { if (files.SelectedIndices.Count != 1) return; int i = files.SelectedIndices[0], j = i + delta; if (j < 0 || j >= inputs.Count) return; var item = inputs[i]; inputs.RemoveAt(i); inputs.Insert(j, item); RefreshFiles(j); }
    void RefreshFiles(int select) {
        changing = true; int previous = scope.SelectedIndex; files.BeginUpdate(); files.Items.Clear(); scope.Items.Clear(); scope.Items.Add(I18n.T("merged")); long bytes = 0;
        foreach (var input in inputs) {
            var info = new FileInfo(input.Path); long size = info.Exists ? info.Length : 0; bytes += size;
            var item = new ListViewItem(info.Name) { ToolTipText = info.FullName };
            item.SubItems.Add(SizeText(size)); files.Items.Add(item); scope.Items.Add(info.Name);
        }
        scope.SelectedIndex = select >= 0 ? select + 1 : Math.Max(0, Math.Min(previous, scope.Items.Count - 1));
        if (select >= 0) files.Items[select].Selected = true;
        files.EndUpdate(); changing = false;
        tally.Text = inputs.Count + " " + I18n.T("files") + (bytes > 0 ? " · " + SizeText(bytes) : "");
        RefreshOps(-1); SuggestPath(); RefreshStart();
    }
    List<Op> CurrentOps() { return scope.SelectedIndex <= 0 || scope.SelectedIndex > inputs.Count ? outputOps : inputs[scope.SelectedIndex - 1].Ops; }
    void RefreshOps(int select) { steps.Items.Clear(); foreach (var op in CurrentOps()) steps.Items.Add(op); if (select >= 0 && steps.Items.Count > 0) steps.SelectedIndex = Math.Min(select, steps.Items.Count - 1); }
    void MoveOp(int delta) { var ops = CurrentOps(); int i = steps.SelectedIndex, j = i + delta; if (i < 0 || j < 0 || j >= ops.Count) return; var op = ops[i]; ops.RemoveAt(i); ops.Insert(j, op); RefreshOps(j); }
    void EditOp(bool edit) { var ops = CurrentOps(); int i = steps.SelectedIndex; if (edit && i < 0) return; using (var dialog = new StepDialog(edit ? ops[i] : null)) { if (dialog.ShowDialog(this) != DialogResult.OK) return; if (edit) ops[i] = dialog.Result; else { i = ops.Count; ops.Add(dialog.Result); } RefreshOps(i); } }
    void SuggestPath() {
        if (!autoPath) return;
        updatingPath = true;
        if (inputs.Count == 0) output.Text = "";
        else if (batchMode) output.Text = Path.Combine(Path.GetDirectoryName(inputs[0].Path), "converted");
        else output.Text = Path.Combine(Path.GetDirectoryName(inputs[0].Path), (inputs.Count > 1 ? "combined" : Converter.Stem(inputs[0].Path) + "-converted") + SelectedFormat.Suffix);
        updatingPath = false;
    }
    void BrowseOutput() {
        if (batchMode) {
            using (var folderDlg = new FolderBrowserDialog { Description = I18n.T("outputFolder") }) {
                if (inputs.Count > 0) folderDlg.SelectedPath = Path.GetDirectoryName(inputs[0].Path);
                if (folderDlg.ShowDialog(this) == DialogResult.OK) output.Text = folderDlg.SelectedPath;
            }
            return;
        }
        var f = SelectedFormat;
        using (var dialog = new SaveFileDialog { Filter = f.Name.Replace("|", " ") + "|*" + f.Suffix, AddExtension = false, FileName = Path.GetFileName(output.Text), OverwritePrompt = false, Title = I18n.T("browse") }) {
            if (inputs.Count > 0) dialog.InitialDirectory = Path.GetDirectoryName(inputs[0].Path);
            if (dialog.ShowDialog(this) == DialogResult.OK) output.Text = Suffix(dialog.FileName, f.Suffix);
        }
    }
    static string Suffix(string p, string suffix) { return p.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) ? p : p + suffix; }
    void RefreshStart() { if (start != null) start.Enabled = active == null && inputs.Count > 0 && !String.IsNullOrWhiteSpace(output.Text); }
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
            // 0.5s high-frequency refresh when active; 10s when minimized
            nextSample = DateTime.UtcNow.AddMilliseconds(WindowState == FormWindowState.Minimized ? 10000 : 500);
        }
    }

    void PaintMetrics() {
        string unknown = I18n.T("unknown"); var r = resources;
        metrics[0].Text = "CPU  " + (r != null && r.Cpu.HasValue ? r.Cpu.Value.ToString("0") + "%" : unknown);
        metrics[1].Text = I18n.T("memory") + "  " + (r != null && r.TotalMemory > 0 ? F((r.TotalMemory - r.AvailableMemory) / 1073741824d) + " / " + F(r.TotalMemory / 1073741824d) + " GiB" : unknown);
        var gpu = r == null ? null : r.Gpus.OrderByDescending(g => g.Usage ?? -1).FirstOrDefault();
        metrics[2].Text = "GPU  " + (gpu != null && gpu.Usage.HasValue ? gpu.Usage.Value.ToString("0") + "%" : unknown) + (r != null && r.Gpus.Count > 1 ? " · " + r.Gpus.Count : "");
        metrics[3].Text = I18n.T("vram") + "  " + (gpu != null && gpu.MemoryTotal > 0 && gpu.MemoryUsed.HasValue ? F(gpu.MemoryUsed.Value / 1073741824d) + " / " + F(gpu.MemoryTotal / 1073741824d) + " GiB" : unknown);
        metrics[1].ForeColor = r != null && r.TotalMemory > 0 && r.AvailableMemory / r.TotalMemory < 0.1 ? Theme.Current.Danger : Theme.Current.Ink;
    }

    async void Begin() {
        if (active != null || inputs.Count == 0) return;
        var f = SelectedFormat;
        string target = output.Text.Trim();
        bool overwrite = batchMode;
        if (!batchMode) {
            try { target = Path.GetFullPath(Suffix(target, f.Suffix)); }
            catch (Exception ex) { ShowFailure(ex, null, null); return; }
            overwrite = File.Exists(target);
            if (overwrite && MessageBox.Show(this, I18n.T("overwrite") + "\n" + target, I18n.T("output"), MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        } else {
            try { target = Path.GetFullPath(target); }
            catch (Exception ex) { ShowFailure(ex, null, null); return; }
        }

        string selectedDevice = !(f.Sog || f.Voxel || chkQuickFloaters.Checked) ? "cpu"
            : device.SelectedIndex == 0 ? "auto"
            : !f.Voxel && device.SelectedIndex == 1 ? "cpu" : "vulkan";

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
        if (chkQuickNan.Checked && !outputOps.Any(o => o.Step.Flag == "--filter-nan"))
            job.Ops.Add(new Op { Step = Step.All[3], Value = "" });
        if (chkQuickFloaters.Checked && !outputOps.Any(o => o.Step.Flag == "--filter-floaters"))
            job.Ops.Add(new Op { Step = Step.All[7], Value = "" });
        if (chkQuickSh1.Checked && !outputOps.Any(o => o.Step.Flag == "--filter-harmonics"))
            job.Ops.Add(new Op { Step = Step.All[4], Value = "1" });
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

            // Mark exact compression start point so telemetry chart refreshes previous run, retains ~6s idle baseline, and stretches X-axis!
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
            if (!batchMode && File.Exists(completed)) status.Text += " · " + SizeText(new FileInfo(completed).Length);
            else if (batchMode) status.Text += " · " + job.Inputs.Count + " " + I18n.T("files");
            events.Enqueue(I18n.T("output") + ": " + completed);
            progressBar.Percent = 100; progressPctLabel.Text = "100%"; etaLabel.Text = I18n.T("done");

            if (!closing && StarPrompt.TryClaim(PromptMarker)) {
                if (PromptOverride != null) PromptOverride();
                else if (MessageDialog.Confirm(this, I18n.T("starTitle"), I18n.T("starMessage"), I18n.T("openProject"), I18n.T("close"))) OpenRepository();
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
