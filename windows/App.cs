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
                using (var original = Image.FromStream(stream)) image = new Bitmap(original, 20, 20);
            }
            Images[name] = image;
        }
        return image;
    }
}

sealed class DisplayCombo : ComboBox {
    internal DisplayCombo() {
        DropDownStyle=ComboBoxStyle.DropDownList; DrawMode=DrawMode.OwnerDrawFixed;
        ItemHeight=Font.Height+6;
    }
    protected override void OnFontChanged(EventArgs e) {base.OnFontChanged(e);ItemHeight=Font.Height+6;}
    protected override void OnDrawItem(DrawItemEventArgs e) {
        e.DrawBackground();
        if(e.Index>=0 && e.Index<Items.Count)TextRenderer.DrawText(e.Graphics,GetItemText(Items[e.Index]),Font,Rectangle.Inflate(e.Bounds,-5,0),e.ForeColor,TextFormatFlags.VerticalCenter|TextFormatFlags.SingleLine|TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix);
        e.DrawFocusRectangle();base.OnDrawItem(e);
    }
    protected override void WndProc(ref Message message) {
        base.WndProc(ref message);
        // Native combo boxes omit the edit-area text when rendered with WM_PRINTCLIENT.
        if(message.Msg==0x318 && message.WParam!=IntPtr.Zero) {
            using(var graphics=Graphics.FromHdc(message.WParam)) {
                var rectangle=new Rectangle(3,2,Math.Max(0,ClientSize.Width-SystemInformation.VerticalScrollBarWidth-6),Math.Max(0,ClientSize.Height-4));
                using(var brush=new SolidBrush(SystemColors.Window))graphics.FillRectangle(brush,rectangle);
                TextRenderer.DrawText(graphics,Text,Font,rectangle,Enabled?ForeColor:SystemColors.GrayText,TextFormatFlags.VerticalCenter|TextFormatFlags.SingleLine|TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix);
            }
        }
    }
}

sealed class Knob : UserControl {
    internal readonly TrackBar Track;
    readonly Label label, value;
    readonly string key;
    readonly Func<int, string> format;
    internal int Value { get { return Track.Value; } }
    internal Knob(string key, int min, int max, int initial, Func<int, string> format) {
        this.key = key; this.format = format; Height = 53; Margin = Padding.Empty;
        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1, Margin = Padding.Empty };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 166));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 78));
        label = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true };
        value = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight, ForeColor = MainWindow.Teal, AutoEllipsis = true };
        Track = new TrackBar { Minimum = min, Maximum = max, Value = initial, TickStyle = TickStyle.None, Dock = DockStyle.Fill,
            AutoSize = false, Margin = new Padding(0, 11, 0, 7), AccessibleName = key };
        Track.ValueChanged += (s, e) => value.Text = format(Track.Value);
        grid.Controls.Add(label, 0, 0); grid.Controls.Add(Track, 1, 0); grid.Controls.Add(value, 2, 0);
        Controls.Add(grid); Translate();
    }
    internal void Translate() { label.Text = I18n.T(key); value.Text = format(Track.Value); }
}

sealed class MainWindow : Form {
    internal static readonly Color Ink = Color.FromArgb(30, 40, 39), Teal = Color.FromArgb(0, 116, 95),
        Muted = Color.FromArgb(98, 111, 106), Line = Color.FromArgb(218, 225, 221), Paper = Color.FromArgb(245, 247, 246);
    readonly Converter converter = new Converter();
    readonly ResourceMonitor monitor = new ResourceMonitor();
    readonly List<InputFile> inputs = new List<InputFile>();
    readonly List<Op> outputOps = new List<Op>();
    readonly ListView files = new ListView();
    readonly ListBox steps = new ListBox();
    readonly ComboBox scope = Combo(), formats = Combo(), device = Combo(), language = Combo();
    readonly TextBox output = new TextBox(), logView = new TextBox();
    readonly Label status = new Label(), tally = new Label();
    readonly ProgressBar progress = new ProgressBar();
    readonly ToolTip tips = new ToolTip();
    readonly ConcurrentQueue<string> events = new ConcurrentQueue<string>();
    readonly System.Windows.Forms.Timer ticker = new System.Windows.Forms.Timer { Interval = 250 };
    readonly List<Action> translations = new List<Action>();
    readonly Label[] metrics = new Label[4];
    readonly Knob keep, iterations, effort, workers, voxel, opacity;
    readonly TableLayoutPanel workspace;
    readonly Button start, cancel, reveal;
    CancellationTokenSource active;
    bool autoPath = true, updatingPath, closing, sampling, changing;
    DateTime nextSample = DateTime.MinValue;
    ResourceSnapshot resources;
    string completed, statusKey = "ready";
    internal string PromptMarker;
    internal Action PromptOverride;
    internal Action<Diagnostic, string> ErrorOverride;
    internal Func<string, bool> WarningOverride;
    internal Func<ResourceSnapshot> ResourceOverride;
    internal ResourceSnapshot LastResources { get { return resources; } }

    internal MainWindow(string[] paths) {
        Font = new Font("Microsoft YaHei UI", 9F); BackColor = Paper; ForeColor = Ink; AutoScaleMode = AutoScaleMode.Dpi;
        MinimumSize = new Size(1030, 800); Size = new Size(1180, 870); StartPosition = FormStartPosition.CenterScreen;
        Text = "Splat Convert Desktop 1.2.0"; Icon = SystemIcons.Application;
        var root = Grid(1, 6);
        foreach (int height in new[] { 76, -1, 137, 58, 35, 41 })
            root.RowStyles.Add(height < 0 ? new RowStyle(SizeType.Percent, 100) : new RowStyle(SizeType.Absolute, height));
        var header = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(28, 43, 39), Padding = new Padding(23, 0, 23, 0) };
        var brand = new Label { Text = "Splat Convert", Font = new Font(Font.FontFamily, 19, FontStyle.Bold), ForeColor = Color.White,
            Dock = DockStyle.Left, Width = 215, TextAlign = ContentAlignment.MiddleLeft };
        var subtitle = new Label { ForeColor = Color.FromArgb(174, 199, 182), Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft };
        Bind(subtitle, "local");
        language.Items.AddRange(I18n.Names); language.SelectedIndex = Array.IndexOf(I18n.Codes, I18n.Language); language.AccessibleName = "language";
        var langHost = new Panel { Dock = DockStyle.Right, Width = 193, Padding = new Padding(30, 22, 0, 22) };
        langHost.Controls.Add(language);
        langHost.Controls.Add(new PictureBox { Image = Art.Icon("language-white"), SizeMode = PictureBoxSizeMode.CenterImage, Dock = DockStyle.Left, Width = 25 });
        header.Controls.Add(subtitle); header.Controls.Add(brand); header.Controls.Add(langHost); root.Controls.Add(header, 0, 0);
        workspace = Grid(2, 1); workspace.Padding = new Padding(23, 16, 23, 6);
        workspace.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); workspace.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        workspace.Controls.Add(InputsPanel(), 0, 0);
        var settingsHost = new Panel { Dock = DockStyle.Fill, Padding = new Padding(23, 0, 0, 0), AutoScroll = true };
        var settings = new TableLayoutPanel { ColumnCount = 1, RowCount = 11, Dock = DockStyle.Top, AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = Padding.Empty };
        for (int i = 0; i < 11; i++) settings.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        Row(settings, Section("03", "settings", "settings"), 0, 38);
        formats.Items.AddRange(Converter.Formats); formats.SelectedIndex = 0; formats.AccessibleName = "format";
        Row(settings, Pair("format", formats), 1, 40);
        output.Dock = DockStyle.Fill; output.AccessibleName = "output";
        output.TextChanged += (s, e) => { if (!updatingPath) autoPath = false; RefreshStart(); };
        var outputField = Grid(2, 1); outputField.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        outputField.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 39)); outputField.Controls.Add(output, 0, 0);
        outputField.Controls.Add(ButtonOf(null, "browse", "folder", 34, BrowseOutput), 1, 0);
        Row(settings, Pair("output", outputField), 2, 40);
        keep = new Knob("keep", 1, 100, 100, v => v + "%"); iterations = new Knob("iterations", 1, 100, 10, v => v.ToString());
        effort = new Knob("effort", -1, 9, -1, v => v < 0 ? I18n.T("default") : v.ToString());
        workers = new Knob("workers", 0, 16, 4, v => v == 0 ? I18n.T("serial") : v.ToString());
        voxel = new Knob("voxel", 1, 500, 50, v => F(v / 1000d)); opacity = new Knob("opacity", 0, 100, 10, v => F(v / 100d));
        Row(settings, keep, 3, 53); Row(settings, iterations, 4, 53); Row(settings, effort, 5, 53); Row(settings, workers, 6, 53);
        Row(settings, voxel, 7, 53); Row(settings, opacity, 8, 53);
        device.AccessibleName = "device"; Row(settings, Pair("device", device), 9, 40);
        Row(settings, ButtonOf("licenses", "licenses", "file", 210, ShowLicenses), 10, 34);
        settingsHost.Controls.Add(settings); workspace.Controls.Add(settingsHost, 1, 0); root.Controls.Add(workspace, 0, 1);
        var logs = Grid(1, 2); logs.Padding = new Padding(23, 0, 23, 5);
        logs.RowStyles.Add(new RowStyle(SizeType.Absolute, 26)); logs.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var logHeading = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft };
        Bind(logHeading, "logs"); logs.Controls.Add(IconText(logHeading,"logs"), 0, 0);
        logView.Multiline = true; logView.ReadOnly = true; logView.Dock = DockStyle.Fill; logView.ScrollBars = ScrollBars.Vertical;
        logView.BorderStyle = BorderStyle.FixedSingle; logView.BackColor = Color.White; logView.ForeColor = Muted;
        logView.Font = new Font("Consolas", 9); logView.AccessibleName = "log"; logs.Controls.Add(logView, 0, 1); root.Controls.Add(logs, 0, 2);
        var footer = Grid(4, 1); footer.Padding = new Padding(23, 4, 23, 4);
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 185));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 145)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 175));
        status.Dock = DockStyle.Fill; status.TextAlign = ContentAlignment.MiddleLeft; status.AutoEllipsis = true; footer.Controls.Add(status, 0, 0);
        reveal = ButtonOf("openOutput", "openOutput", "folder", 177, OpenOutput); reveal.Visible = false;
        cancel = ButtonOf("cancel", "cancel", "stop", 137, Stop); cancel.Enabled = false;
        start = ButtonOf("start", "start", "play-white", 167, Begin); start.BackColor = Teal; start.ForeColor = Color.White;
        start.FlatAppearance.BorderColor = Teal; start.AccessibleName = "start";
        footer.Controls.Add(reveal, 1, 0); footer.Controls.Add(cancel, 2, 0); footer.Controls.Add(start, 3, 0); root.Controls.Add(footer, 0, 3);
        var repoHost = Grid(1, 2); repoHost.Padding = new Padding(23, 0, 23, 0);
        repoHost.RowStyles.Add(new RowStyle(SizeType.Absolute, 4)); repoHost.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        progress.Dock = DockStyle.Fill; progress.MarqueeAnimationSpeed = 30; repoHost.Controls.Add(progress, 0, 0);
        var repository = new LinkLabel { Text = App.Repository, Dock = DockStyle.Fill, LinkColor = Muted, TextAlign = ContentAlignment.MiddleLeft,
            AutoEllipsis = true, AccessibleName = "repository" };
        repository.LinkClicked += (s, e) => OpenRepository(); repoHost.Controls.Add(IconText(repository,"github"), 0, 1); root.Controls.Add(repoHost, 0, 4);
        var resourceBar = Grid(4, 1); resourceBar.BackColor = Color.FromArgb(232, 237, 233); resourceBar.Padding = new Padding(18, 2, 18, 2);
        string[] iconNames = { "cpu", "memory", "gpu", "vram" };
        for (int i = 0; i < 4; i++) {
            resourceBar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
            metrics[i] = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true, AccessibleName = "metric-" + iconNames[i] };
            resourceBar.Controls.Add(IconText(metrics[i],iconNames[i]), i, 0);
        }
        root.Controls.Add(resourceBar, 0, 5); Controls.Add(root);
        formats.SelectedIndexChanged += (s, e) => { if (!changing) FormatChanged(); };
        language.SelectedIndexChanged += (s, e) => {
            if (changing || language.SelectedIndex < 0) return;
            I18n.Language = I18n.Codes[language.SelectedIndex]; I18n.Save(); Translate();
        };
        ticker.Tick += (s, e) => { FlushLog(); if (!sampling && DateTime.UtcNow >= nextSample) SampleResources(); }; ticker.Start();
        FormClosing += (s, e) => { if (active != null) { e.Cancel = true; closing = true; Stop(); } };
        FormClosed += (s, e) => { ticker.Dispose(); tips.Dispose(); converter.Dispose(); Task.Run(() => monitor.Dispose()); };
        Translate(); AddFiles(paths);
    }

    void Bind(Control control, string key) { var label=control as Label;if(label!=null)label.UseMnemonic=false;translations.Add(() => control.Text = I18n.T(key)); control.Text = I18n.T(key); }
    static TableLayoutPanel Grid(int cols, int rows) {
        var grid=new TableLayoutPanel { ColumnCount = cols, RowCount = rows, Dock = DockStyle.Fill, Margin = Padding.Empty };
        if(rows==1)grid.RowStyles.Add(new RowStyle(SizeType.Percent,100));
        return grid;
    }
    static ComboBox Combo() { return new DisplayCombo { Dock = DockStyle.Fill, Margin = new Padding(0, 4, 0, 4) }; }
    static Control IconText(Control text,string icon) {
        var row=Grid(2,1);row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,28));row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
        row.Controls.Add(new PictureBox {Image=Art.Icon(icon),Dock=DockStyle.Fill,SizeMode=PictureBoxSizeMode.CenterImage},0,0);row.Controls.Add(text,1,0);return row;
    }
    Button ButtonOf(string text, string hint, string icon, int width, Action action) {
        var button = new Button { Width = width, Height = 34, FlatStyle = FlatStyle.Flat, BackColor = Color.White, ForeColor = Ink,
            Margin = new Padding(0, 2, 6, 2), Image = Art.Icon(icon), TextImageRelation = TextImageRelation.ImageBeforeText,
            Padding = new Padding(3, 0, 3, 0), AutoEllipsis = true, UseMnemonic = false };
        button.FlatAppearance.BorderColor = Line; button.FlatAppearance.MouseOverBackColor = Color.FromArgb(225, 238, 231);
        button.Click += (s, e) => action();
        translations.Add(() => { button.Text = text == null ? "" : I18n.T(text); tips.SetToolTip(button, I18n.T(hint)); });
        return button;
    }
    Control Section(string number, string key, string icon) {
        var label = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Font = new Font(Font.FontFamily, 10, FontStyle.Bold),UseMnemonic=false };
        translations.Add(() => label.Text = number + "  " + I18n.T(key)); return IconText(label,icon);
    }
    Control Pair(string key, Control field) {
        var grid = Grid(2, 1); grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 166)); grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        var label = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true }; Bind(label, key);
        grid.Controls.Add(label, 0, 0); field.Dock = DockStyle.Fill; grid.Controls.Add(field, 1, 0); return grid;
    }
    static void Row(TableLayoutPanel grid, Control control, int row, int height) { control.Height = height; control.Dock = DockStyle.Top; control.Margin = Padding.Empty; grid.Controls.Add(control, 0, row); }
    Control InputsPanel() {
        var pane = Grid(1, 6); pane.Padding = new Padding(0, 0, 23, 0);
        foreach (int height in new[] { 38, 42, -1, 44, 42, -1 }) pane.RowStyles.Add(height < 0 ? new RowStyle(SizeType.Percent, 50) : new RowStyle(SizeType.Absolute, height));
        var heading = Grid(2, 1); heading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 55)); heading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 45));
        heading.Controls.Add(Section("01", "inputs", "file"), 0, 0); tally.Dock = DockStyle.Fill; tally.TextAlign = ContentAlignment.MiddleRight;
        tally.ForeColor = Muted; tally.AutoEllipsis = true; heading.Controls.Add(tally, 1, 0); pane.Controls.Add(heading, 0, 0);
        var tools = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty };
        tools.Controls.Add(ButtonOf("add", "add", "plus", 200, BrowseInputs)); tools.Controls.Add(ButtonOf(null, "remove", "minus", 34, RemoveFiles));
        tools.Controls.Add(ButtonOf(null, "up", "up", 34, () => MoveFile(-1))); tools.Controls.Add(ButtonOf(null, "down", "down", 34, () => MoveFile(1))); pane.Controls.Add(tools, 0, 1);
        files.Dock = DockStyle.Fill; files.View = View.Details; files.FullRowSelect = true; files.HideSelection = false;
        files.BorderStyle = BorderStyle.FixedSingle; files.Columns.Add("", 230); files.Columns.Add("", 95, HorizontalAlignment.Right); files.ShowItemToolTips = true;
        files.Resize += (s, e) => files.Columns[0].Width = Math.Max(140, files.ClientSize.Width - 100);
        files.AllowDrop = true; files.DragEnter += (s, e) => { if (active == null && e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy; };
        files.DragDrop += (s, e) => AddFiles((string[])e.Data.GetData(DataFormats.FileDrop));
        files.SelectedIndexChanged += (s, e) => { if (!changing && files.SelectedIndices.Count == 1) scope.SelectedIndex = files.SelectedIndices[0] + 1; }; pane.Controls.Add(files, 0, 2);
        pane.Controls.Add(Section("02", "actions", "layers"), 0, 3);
        var opTools = Grid(2, 1); opTools.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); opTools.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 200));
        scope.Items.Add(""); scope.SelectedIndex = 0; scope.AccessibleName = "scope"; scope.SelectedIndexChanged += (s, e) => { if (!changing) RefreshOps(-1); }; opTools.Controls.Add(scope, 0, 0);
        var opButtons = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty };
        opButtons.Controls.Add(ButtonOf(null, "addOp", "plus", 34, () => EditOp(false))); opButtons.Controls.Add(ButtonOf(null, "edit", "edit", 34, () => EditOp(true)));
        opButtons.Controls.Add(ButtonOf(null, "remove", "minus", 34, () => { int i = steps.SelectedIndex; if (i >= 0) { CurrentOps().RemoveAt(i); RefreshOps(i); } }));
        opButtons.Controls.Add(ButtonOf(null, "up", "up", 34, () => MoveOp(-1))); opButtons.Controls.Add(ButtonOf(null, "down", "down", 34, () => MoveOp(1)));
        opTools.Controls.Add(opButtons, 1, 0); pane.Controls.Add(opTools, 0, 4);
        steps.Dock = DockStyle.Fill; steps.IntegralHeight = false; steps.ItemHeight = 26; steps.BorderStyle = BorderStyle.FixedSingle;
        steps.DoubleClick += (s, e) => EditOp(true); pane.Controls.Add(steps, 0, 5); return pane;
    }

    internal void SetLanguage(string code) {
        int index = Array.IndexOf(I18n.Codes, code); if (index < 0) return;
        changing = true; language.SelectedIndex = index; I18n.Language = code; changing = false; Translate();
    }
    void Translate() {
        changing = true; foreach (var update in translations) update(); files.Columns[0].Text = I18n.T("fileName"); files.Columns[1].Text = I18n.T("size");
        int index = Math.Max(0, formats.SelectedIndex); formats.Items.Clear(); formats.Items.AddRange(Converter.Formats); formats.SelectedIndex = index;
        RefreshDevices(); foreach (var knob in new[] { keep, iterations, effort, workers, voxel, opacity }) knob.Translate();
        changing = false; FormatVisibility(); RefreshFiles(-1); SetStatus(statusKey); PaintMetrics();
    }
    void RefreshDevices() {
        int selected = Math.Max(0, device.SelectedIndex); device.Items.Clear(); device.Items.Add(I18n.T("auto"));
        if (!SelectedFormat.Voxel) device.Items.Add(I18n.T("cpuDevice")); device.Items.Add(I18n.T("backend")); device.SelectedIndex = Math.Min(selected, device.Items.Count - 1);
    }
    void FormatChanged() { RefreshDevices(); FormatVisibility(); autoPath = true; SuggestPath(); }
    void FormatVisibility() { iterations.Visible = effort.Visible = workers.Visible = SelectedFormat.Sog; voxel.Visible = opacity.Visible = SelectedFormat.Voxel; device.Parent.Visible = SelectedFormat.Sog || SelectedFormat.Voxel; }
    Format SelectedFormat { get { return (Format)formats.SelectedItem; } }
    static string F(double number) { return number.ToString("0.###", CultureInfo.InvariantCulture); }
    static string SizeText(long size) { return size >= 1073741824 ? Budget.GB(size) : (size / 1048576d).ToString("0.0", CultureInfo.InvariantCulture) + " MiB"; }
    void BrowseInputs() { using (var dialog = new OpenFileDialog { Multiselect = true, Filter = I18n.T("inputs") + "|*.ply;*.sog;*.ksplat;*.splat;*.spz", Title = I18n.T("add") }) if (dialog.ShowDialog(this) == DialogResult.OK) AddFiles(dialog.FileNames); }
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
        foreach (var input in inputs) { var info = new FileInfo(input.Path); long size = info.Exists ? info.Length : 0; bytes += size; var item = new ListViewItem(info.Name) { ToolTipText = info.FullName }; item.SubItems.Add(SizeText(size)); files.Items.Add(item); scope.Items.Add(info.Name); }
        scope.SelectedIndex = select >= 0 ? select + 1 : Math.Max(0, Math.Min(previous, scope.Items.Count - 1)); if (select >= 0) files.Items[select].Selected = true;
        files.EndUpdate(); changing = false; tally.Text = inputs.Count + " " + I18n.T("files") + (bytes > 0 ? " · " + SizeText(bytes) : ""); RefreshOps(-1); SuggestPath(); RefreshStart();
    }
    List<Op> CurrentOps() { return scope.SelectedIndex <= 0 || scope.SelectedIndex > inputs.Count ? outputOps : inputs[scope.SelectedIndex - 1].Ops; }
    void RefreshOps(int select) { steps.Items.Clear(); foreach (var op in CurrentOps()) steps.Items.Add(op); if (select >= 0 && steps.Items.Count > 0) steps.SelectedIndex = Math.Min(select, steps.Items.Count - 1); }
    void MoveOp(int delta) { var ops = CurrentOps(); int i = steps.SelectedIndex, j = i + delta; if (i < 0 || j < 0 || j >= ops.Count) return; var op = ops[i]; ops.RemoveAt(i); ops.Insert(j, op); RefreshOps(j); }
    void EditOp(bool edit) { var ops = CurrentOps(); int i = steps.SelectedIndex; if (edit && i < 0) return; using (var dialog = new StepDialog(edit ? ops[i] : null)) { if (dialog.ShowDialog(this) != DialogResult.OK) return; if (edit) ops[i] = dialog.Result; else { i = ops.Count; ops.Add(dialog.Result); } RefreshOps(i); } }
    void SuggestPath() { if (!autoPath) return; updatingPath = true; output.Text = inputs.Count == 0 ? "" : Path.Combine(Path.GetDirectoryName(inputs[0].Path), (inputs.Count > 1 ? "combined" : Converter.Stem(inputs[0].Path) + "-converted") + SelectedFormat.Suffix); updatingPath = false; }
    void BrowseOutput() { var f = SelectedFormat; using (var dialog = new SaveFileDialog { Filter = f.Name.Replace("|", " ") + "|*" + f.Suffix, AddExtension = false, FileName = Path.GetFileName(output.Text), OverwritePrompt = false, Title = I18n.T("browse") }) { if (inputs.Count > 0) dialog.InitialDirectory = Path.GetDirectoryName(inputs[0].Path); if (dialog.ShowDialog(this) == DialogResult.OK) output.Text = Suffix(dialog.FileName, f.Suffix); } }
    static string Suffix(string p, string suffix) { return p.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) ? p : p + suffix; }
    void RefreshStart() { if (start != null) start.Enabled = active == null && inputs.Count > 0 && !String.IsNullOrWhiteSpace(output.Text); }
    void SetStatus(string key) { statusKey = key; status.Text = I18n.T(key); }

    async void SampleResources() {
        sampling = true;
        try { var sample = await Task.Run(() => monitor.Sample()); if (!IsDisposed) { resources = sample; PaintMetrics(); } }
        catch (Exception ex) { if (!IsDisposed) tips.SetToolTip(metrics[0], I18n.T("unknown") + " · " + ex.GetType().Name); }
        finally { sampling = false; nextSample = DateTime.UtcNow.AddSeconds(WindowState == FormWindowState.Minimized ? 10 : 2); }
    }
    void PaintMetrics() {
        string unknown = I18n.T("unknown"); var r = resources;
        metrics[0].Text = "CPU  " + (r != null && r.Cpu.HasValue ? r.Cpu.Value.ToString("0") + "%" : unknown);
        metrics[1].Text = I18n.T("memory") + "  " + (r != null && r.TotalMemory > 0 ? F((r.TotalMemory - r.AvailableMemory) / 1073741824d) + " / " + F(r.TotalMemory / 1073741824d) + " GiB" : unknown);
        var gpu = r == null ? null : r.Gpus.OrderByDescending(g => g.Usage ?? -1).FirstOrDefault();
        metrics[2].Text = "GPU  " + (gpu != null && gpu.Usage.HasValue ? gpu.Usage.Value.ToString("0") + "%" : unknown) + (r != null && r.Gpus.Count > 1 ? " · " + r.Gpus.Count : "");
        metrics[3].Text = I18n.T("vram") + "  " + (gpu != null && gpu.MemoryTotal > 0 && gpu.MemoryUsed.HasValue ? F(gpu.MemoryUsed.Value / 1073741824d) + " / " + F(gpu.MemoryTotal / 1073741824d) + " GiB" : unknown);
        metrics[1].ForeColor = r != null && r.TotalMemory > 0 && r.AvailableMemory / r.TotalMemory < 0.1 ? Color.FromArgb(164, 64, 41) : Ink;
        if (r == null) return;
        string time = I18n.T("sample") + ": " + r.Sampled.ToLocalTime().ToString("HH:mm:ss"); tips.SetToolTip(metrics[0], r.CpuName + "\n" + time);
        tips.SetToolTip(metrics[1], I18n.T("available") + ": " + Budget.GB(r.AvailableMemory) + "\n" + I18n.T("commit") + ": " + (r.CommitAvailable >= 0 ? Budget.GB(r.CommitAvailable) : unknown) + "\n" + time);
        string gpuTip = String.Join("\n", r.Gpus.Select(g => g.Name + " · " + (g.Usage.HasValue ? g.Usage.Value.ToString("0") + "%" : unknown) + " · " + (g.MemoryUsed.HasValue && g.MemoryTotal > 0 ? Budget.GB(g.MemoryUsed.Value) + " / " + Budget.GB(g.MemoryTotal) : unknown))) + "\n" + I18n.T("gpuUnknown") + "\n" + time;
        tips.SetToolTip(metrics[2], gpuTip); tips.SetToolTip(metrics[3], gpuTip);
    }

    async void Begin() {
        if (active != null || inputs.Count == 0) return;
        string target;
        try { target = Path.GetFullPath(Suffix(output.Text.Trim(), SelectedFormat.Suffix)); }
        catch (Exception ex) { ShowFailure(ex, null, null); return; }
        bool overwrite = File.Exists(target);
        if (overwrite && MessageBox.Show(this, I18n.T("overwrite") + "\n" + target, I18n.T("output"), MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        var f = SelectedFormat;
        var job = new Job { Output = target, Format = f, Overwrite = overwrite, Keep = keep.Value, Iterations = iterations.Value, Effort = effort.Value,
            Workers = workers.Value, VoxelSize = F(voxel.Value / 1000d), Opacity = F(opacity.Value / 100d),
            Device = !(f.Sog || f.Voxel) ? "cpu" : device.SelectedIndex == 0 ? "auto" : !f.Voxel && device.SelectedIndex == 1 ? "cpu" : "vulkan" };
        job.Inputs.AddRange(inputs); job.Ops.AddRange(outputOps); active = new CancellationTokenSource(); var token = active.Token;
        workspace.Enabled = false; language.Enabled = false; cancel.Enabled = true; RefreshStart(); logView.Clear(); reveal.Visible = false;
        progress.Style = ProgressBarStyle.Marquee; SetStatus("preflight"); MemoryEstimate estimate = null;
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
            var report = new Progress<string>(key => { if (active != null && !token.IsCancellationRequested) SetStatus(key); });
            await Task.Run(() => converter.Convert(job, token, key => ((IProgress<string>)report).Report(key), line => events.Enqueue(line)));
            completed = job.Output; reveal.Visible = true; SetStatus("done"); status.Text += " · " + SizeText(new FileInfo(completed).Length);
            events.Enqueue(I18n.T("output") + ": " + completed); progress.Style = ProgressBarStyle.Continuous; progress.Value = 100;
            if (!closing && StarPrompt.TryClaim(PromptMarker)) {
                if (PromptOverride != null) PromptOverride();
                else if (MessageDialog.Confirm(this, I18n.T("starTitle"), I18n.T("starMessage"), I18n.T("openProject"), I18n.T("close"))) OpenRepository();
            }
        }
        catch (OperationCanceledException) { SetStatus("canceled"); }
        catch (Exception ex) { SetStatus("failed"); events.Enqueue(ex.ToString()); FlushLog(); if (!closing) ShowFailure(ex, job, estimate); }
        finally { FlushLog(); progress.Style = ProgressBarStyle.Continuous; active.Dispose(); active = null; workspace.Enabled = true; language.Enabled = true; cancel.Enabled = false; RefreshStart(); if (closing) Close(); }
    }
    void ShowFailure(Exception error, Job job, MemoryEstimate estimate) {
        var diagnostic = Diagnostics.Classify(error, job == null ? "auto" : job.Device); string details = diagnostic.Text;
        if (estimate != null) details += "\n\n" + Budget.Describe(estimate, resources);
        string raw = "Splat Convert Desktop 1.2.0\nOS: " + Environment.OSVersion + "\nEngine: 3.10.3\n" +
            (job == null ? "" : "Format: " + job.Format.Suffix + "; Device: " + job.Device + "; Workers: " + job.Workers + "\n") + details + "\n\n" + error;
        if (ErrorOverride != null) { ErrorOverride(diagnostic, raw); return; }
        MessageDialog.Failure(this, I18n.T(diagnostic.TitleKey), details, raw, () => { logView.Focus(); logView.SelectionStart = logView.TextLength; logView.ScrollToCaret(); });
    }
    void Stop() { if (active != null) { SetStatus("canceling"); cancel.Enabled = false; active.Cancel(); } }
    void FlushLog() { var text = new System.Text.StringBuilder(); string line; while (events.TryDequeue(out line)) text.AppendLine(line); if (text.Length == 0) return; if (logView.TextLength > 180000) logView.Text = logView.Text.Substring(logView.TextLength - 120000); logView.AppendText(text.ToString()); }
    void OpenOutput() { if (completed != null && File.Exists(completed)) Process.Start("explorer.exe", "/select,\"" + completed + "\""); }
    void OpenRepository() { try { Process.Start(new ProcessStartInfo(App.Repository) { UseShellExecute = true }); } catch (Exception ex) { ShowFailure(ex, null, null); } }
    void ShowLicenses() {
        using (var dialog = new Form { Text = I18n.T("licenses"), StartPosition = FormStartPosition.CenterParent, Size = new Size(790, 555), Font = Font })
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("licenses.txt"))
        using (var reader = new StreamReader(stream)) {
            dialog.Controls.Add(new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false,
                Text = reader.ReadToEnd().Replace("\r\n", "\n").Replace("\n", "\r\n") }); dialog.ShowDialog(this);
        }
    }
}
