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
    [STAThread]
    static int Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (args.Length == 2 && args[0] == "--self-test") return Smoke.Run(args[1]);
        using (var win = new MainWindow(args)) Application.Run(win);
        return 0;
    }
}

sealed class Knob : Panel {
    readonly TrackBar track;
    readonly Label value;
    public int Value { get { return track.Value; } }
    public Knob(string name, int min, int max, int initial, Func<int, string> format, string tip, ToolTip tips) {
        Height = 55;
        var label = new Label { Text = name, ForeColor = MainWindow.Ink, Dock = DockStyle.Left, Width = 136, TextAlign = ContentAlignment.MiddleLeft };
        value = new Label { Dock = DockStyle.Right, Width = 62, TextAlign = ContentAlignment.MiddleRight, ForeColor = MainWindow.Teal };
        track = new TrackBar { Minimum = min, Maximum = max, Value = initial, Dock = DockStyle.Fill, TickStyle = TickStyle.None, AutoSize = false, AccessibleName = name };
        var rail = new Panel { Dock = DockStyle.Fill, Padding = new Padding(0, 14, 0, 12) };
        rail.Controls.Add(track);
        Controls.Add(rail);
        Controls.Add(value);
        Controls.Add(label);
        track.ValueChanged += (s, e) => value.Text = format(track.Value);
        value.Text = format(initial);
        tips.SetToolTip(label, tip);
        tips.SetToolTip(value, tip);
    }
}

sealed class MainWindow : Form {
    internal static readonly Color Ink = Color.FromArgb(25, 37, 43), Teal = Color.FromArgb(0, 105, 94);
    static readonly Color Muted = Color.FromArgb(78, 96, 103), Paper = Color.FromArgb(247, 249, 248), Line = Color.FromArgb(217, 226, 224);
    readonly Converter converter = new Converter();
    readonly List<InputFile> inputs = new List<InputFile>();
    readonly List<Op> outputOps = new List<Op>();
    readonly ListView files = new ListView();
    readonly ListBox steps = new ListBox();
    readonly ComboBox scope = Combo(), formats = Combo(), device = Combo();
    readonly TextBox output = new TextBox(), logView = new TextBox();
    readonly Label status = LabelOf("就绪", true), tally = LabelOf("0 个文件", false);
    readonly ProgressBar progress = new ProgressBar();
    readonly ToolTip tips = new ToolTip();
    readonly ConcurrentQueue<string> events = new ConcurrentQueue<string>();
    readonly System.Windows.Forms.Timer ticker = new System.Windows.Forms.Timer { Interval = 250 };
    readonly Knob keep, iterations, effort, workers, voxel, opacity;
    readonly TableLayoutPanel workspace, settings;
    readonly Button start, cancel, reveal;
    CancellationTokenSource active;
    bool autoPath = true, updatingPath, closing;
    string completed;
    internal string PromptMarker;
    internal Action PromptOverride;

    public MainWindow(string[] paths) {
        Text = "SuperSplat Convert · 桌面版";
        Font = new Font("Microsoft YaHei UI", 9F);
        BackColor = Paper; ForeColor = Ink;
        AutoScaleMode = AutoScaleMode.Font;
        MinimumSize = new Size(890, 665);
        Size = new Size(1040, 760);
        StartPosition = FormStartPosition.CenterScreen;
        Icon = SystemIcons.Application;
        var header = new Panel { Dock = DockStyle.Top, Height = 60, BackColor = Color.FromArgb(21, 49, 46), Padding = new Padding(20, 0, 20, 0) };
        var title = new Label { Dock = DockStyle.Fill, Text = "SuperSplat Convert   /   本地转换", ForeColor = Color.White,
            Font = new Font(Font.FontFamily, 15, FontStyle.Bold), TextAlign = ContentAlignment.MiddleLeft };
        var build = new Label { Dock = DockStyle.Right, Width = 220, Text = "SPLAT TRANSFORM  3.10.3", ForeColor = Color.FromArgb(174, 220, 206), TextAlign = ContentAlignment.MiddleRight };
        header.Controls.Add(title); header.Controls.Add(build);

        var footer = Grid(3, 2); footer.Dock = DockStyle.Bottom; footer.Height = 90; footer.Padding = new Padding(18, 8, 18, 9);
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 103)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 141));
        footer.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); footer.RowStyles.Add(new RowStyle(SizeType.Absolute, 14));
        var footLeft = Bar(); footLeft.Controls.Add(status);
        reveal = ButtonOf("打开输出目录", "打开最近一次输出所在的文件夹", 115, () => OpenOutput()); reveal.Visible = false;
        footLeft.Controls.Add(reveal);
        cancel = ButtonOf("取消", "停止正在进行的转换", 95, () => Stop()); cancel.Enabled = false;
        start = ButtonOf("开始转换", "开始本地转换", 130, Begin); start.BackColor = Teal; start.ForeColor = Color.White; start.FlatAppearance.BorderColor = Teal;
        footer.Controls.Add(footLeft, 0, 0); footer.Controls.Add(cancel, 1, 0); footer.Controls.Add(start, 2, 0);
        progress.Dock = DockStyle.Fill; progress.Style = ProgressBarStyle.Continuous; progress.MarqueeAnimationSpeed = 30;
        footer.Controls.Add(progress, 0, 1); footer.SetColumnSpan(progress, 3);

        var center = Grid(1, 2); center.Dock = DockStyle.Fill; center.Padding = new Padding(18, 12, 18, 0);
        center.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); center.RowStyles.Add(new RowStyle(SizeType.Absolute, 116));
        workspace = Grid(2, 1); workspace.Dock = DockStyle.Fill;
        workspace.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 52)); workspace.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 48));
        workspace.Controls.Add(InputsPanel(), 0, 0);

        settings = Grid(1, 11); settings.Dock = DockStyle.Top; settings.AutoSize = true; settings.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        for (int i = 0; i < 11; i++) settings.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var settingsHost = new Panel { Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(13, 0, 3, 0) };
        settingsHost.Controls.Add(settings);
        Row(settings, Section("03", "输出设置"), 0, 40);
        formats.Items.AddRange(Converter.Formats); formats.SelectedIndex = 0;
        Row(settings, Pair("导出格式", formats), 1, 38);
        output.Dock = DockStyle.Fill;
        output.TextChanged += (s, e) => { if (!updatingPath) autoPath = false; RefreshStart(); };
        var outputField = Grid(2, 1); outputField.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); outputField.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 40));
        outputField.Controls.Add(output, 0, 0);
        outputField.Controls.Add(ButtonOf("…", "选择输出位置", 32, BrowseOutput), 1, 0);
        Row(settings, Pair("输出文件", outputField), 2, 40);
        keep = new Knob("保留点数", 1, 100, 100, v => v + "%", "低于 100% 时合并相似高斯点。", tips);
        iterations = new Knob("球谐压缩迭代", 1, 100, 10, v => v.ToString(), "增加迭代通常能改善高阶球谐的编码质量，但更慢。", tips);
        effort = new Knob("WebP 打包强度", -1, 9, -1, v => v == -1 ? "默认" : v.ToString(), "提高无损打包强度可能减小体积，不改变打包前的画质。", tips);
        workers = new Knob("编码线程", 0, 16, 4, v => v == 0 ? "串行" : v.ToString(), "线程越多，峰值内存通常越高。", tips);
        voxel = new Knob("体素边长", 1, 500, 50, v => F(v / 1000.0), "单位为场景坐标单位。数值越小越精细。", tips);
        opacity = new Knob("体素不透明度阈值", 0, 100, 10, v => F(v / 100.0), "高于阈值的体素视为实心。", tips);
        Row(settings, keep, 3, 50); Row(settings, iterations, 4, 50); Row(settings, effort, 5, 50); Row(settings, workers, 6, 50);
        Row(settings, voxel, 7, 50); Row(settings, opacity, 8, 50);
        device.Items.AddRange(new[] { "自动选用显卡", "CPU（处理器）", "Vulkan（兼容后端）" });
        device.SelectedIndex = 0;
        Row(settings, Pair("计算设备", device), 9, 37);
        Row(settings, ButtonOf("开源许可", "查看随程序分发的第三方许可", 92, ShowLicenses), 10, 34);
        formats.SelectedIndexChanged += (s, e) => FormatChanged();
        workspace.Controls.Add(settingsHost, 1, 0);

        var logPanel = Grid(1, 2); logPanel.Dock = DockStyle.Fill;
        logPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 28)); logPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        logPanel.Controls.Add(LabelOf("运行日志", true), 0, 0);
        logView.Dock = DockStyle.Fill; logView.Multiline = true; logView.ReadOnly = true; logView.ScrollBars = ScrollBars.Vertical;
        logView.BackColor = Color.White; logView.ForeColor = Muted; logView.BorderStyle = BorderStyle.FixedSingle;
        logPanel.Controls.Add(logView, 0, 1);
        center.Controls.Add(workspace, 0, 0); center.Controls.Add(logPanel, 0, 1);
        var repository = new LinkLabel { Dock = DockStyle.Bottom, Height = 30, Text = App.Repository,
            LinkColor = Teal, Padding = new Padding(22, 4, 12, 0), AutoEllipsis = true, AccessibleName = "本项目 GitHub 仓库" };
        repository.LinkClicked += (s, e) => OpenRepository();
        Controls.Add(center); Controls.Add(footer); Controls.Add(repository); Controls.Add(header);
        ticker.Tick += (s, e) => FlushLog(); ticker.Start();
        FormClosing += (s, e) => { if (active != null) { e.Cancel = true; closing = true; Stop(); } };
        FormClosed += (s, e) => { ticker.Dispose(); tips.Dispose(); converter.Dispose(); };
        FormatChanged();
        AddFiles(paths);
    }

    Control InputsPanel() {
        var pane = Grid(1, 6); pane.Dock = DockStyle.Fill; pane.Padding = new Padding(0, 0, 13, 0);
        pane.RowStyles.Add(new RowStyle(SizeType.Absolute, 40)); pane.RowStyles.Add(new RowStyle(SizeType.Absolute, 41));
        pane.RowStyles.Add(new RowStyle(SizeType.Percent, 53)); pane.RowStyles.Add(new RowStyle(SizeType.Absolute, 43));
        pane.RowStyles.Add(new RowStyle(SizeType.Absolute, 40)); pane.RowStyles.Add(new RowStyle(SizeType.Percent, 47));
        pane.Controls.Add(Section("01", "源文件"), 0, 0);
        var fileTools = Bar();
        fileTools.Controls.Add(ButtonOf("＋ 添加文件", "选择一个或多个高斯泼溅文件", 107, BrowseInputs));
        fileTools.Controls.Add(ButtonOf("−", "移除选中的源文件", 32, RemoveFiles));
        fileTools.Controls.Add(ButtonOf("↑", "上移文件", 32, () => MoveFile(-1)));
        fileTools.Controls.Add(ButtonOf("↓", "下移文件", 32, () => MoveFile(1)));
        fileTools.Controls.Add(tally); pane.Controls.Add(fileTools, 0, 1);
        files.Dock = DockStyle.Fill; files.View = View.Details; files.FullRowSelect = true; files.HideSelection = false;
        files.Columns.Add("文件名", 255); files.Columns.Add("大小", 95, HorizontalAlignment.Right);
        files.Resize += (s, e) => files.Columns[0].Width = Math.Max(140, files.ClientSize.Width - 100);
        files.AllowDrop = true;
        files.DragEnter += (s, e) => { if (e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy; };
        files.DragDrop += (s, e) => AddFiles((string[])e.Data.GetData(DataFormats.FileDrop));
        files.SelectedIndexChanged += (s, e) => { if (files.SelectedIndices.Count == 1) scope.SelectedIndex = files.SelectedIndices[0] + 1; };
        files.ShowItemToolTips = true;
        pane.Controls.Add(files, 0, 2);
        pane.Controls.Add(Section("02", "变换与筛选"), 0, 3);
        var opTools = Grid(2, 1); opTools.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); opTools.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 205));
        scope.Items.Add("合并后的结果"); scope.SelectedIndex = 0;
        scope.SelectedIndexChanged += (s, e) => RefreshOps(-1);
        opTools.Controls.Add(scope, 0, 0);
        var buttons = Bar();
        buttons.Controls.Add(ButtonOf("＋", "添加操作", 32, () => EditOp(false)));
        buttons.Controls.Add(ButtonOf("编辑", "编辑所选操作", 50, () => EditOp(true)));
        buttons.Controls.Add(ButtonOf("−", "移除所选操作", 32, () => { int i = steps.SelectedIndex; if (i >= 0) { CurrentOps().RemoveAt(i); RefreshOps(i); } }));
        buttons.Controls.Add(ButtonOf("↑", "将所选操作提前", 32, () => MoveOp(-1)));
        buttons.Controls.Add(ButtonOf("↓", "将所选操作延后", 32, () => MoveOp(1)));
        opTools.Controls.Add(buttons, 1, 0); pane.Controls.Add(opTools, 0, 4);
        steps.Dock = DockStyle.Fill; steps.IntegralHeight = false;
        steps.DoubleClick += (s, e) => EditOp(true);
        pane.Controls.Add(steps, 0, 5);
        return pane;
    }

    static TableLayoutPanel Grid(int cols, int rows) { return new TableLayoutPanel { ColumnCount = cols, RowCount = rows, Margin = Padding.Empty, Dock = DockStyle.Fill }; }
    static FlowLayoutPanel Bar() { return new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty }; }
    static Label LabelOf(string text, bool bold) {
        var l = new Label { Text = text, AutoSize = true, ForeColor = bold ? Ink : Muted, Margin = new Padding(4, 9, 4, 0) };
        if (bold) l.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold);
        return l;
    }
    static Label Section(string number, string name) {
        return new Label { Text = number + "   " + name, TextAlign = ContentAlignment.MiddleLeft, Dock = DockStyle.Fill, ForeColor = Teal,
            Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold), Margin = Padding.Empty };
    }
    static ComboBox Combo() {
        var box = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill, IntegralHeight = true, DrawMode = DrawMode.OwnerDrawFixed };
        box.FontChanged += (s, e) => box.ItemHeight = box.Font.Height + 5;
        box.DrawItem += (s, e) => {
            e.DrawBackground();
            if (e.Index >= 0 && e.Index < box.Items.Count) {
                var area = Rectangle.Inflate(e.Bounds, -4, 0);
                TextRenderer.DrawText(e.Graphics, box.GetItemText(box.Items[e.Index]), e.Font, area, e.ForeColor,
                    TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
            }
            e.DrawFocusRectangle();
        };
        return box;
    }
    static Control Pair(string name, Control input) {
        var p = Grid(2, 1); p.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 132)); p.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        p.Controls.Add(LabelOf(name, false), 0, 0); p.Controls.Add(input, 1, 0);
        return p;
    }
    static void Row(TableLayoutPanel panel, Control c, int row, int height) {
        c.Height = height; c.Margin = Padding.Empty; c.Dock = DockStyle.Top;
        panel.Controls.Add(c, 0, row);
    }
    Button ButtonOf(string text, string hint, int width, Action action) {
        var b = new Button { Text = text, Width = width, Height = 31, FlatStyle = FlatStyle.Flat, BackColor = Color.White, ForeColor = Ink,
            Margin = new Padding(0, 2, 4, 0), AccessibleName = hint };
        b.FlatAppearance.BorderColor = Line; b.Click += (s, e) => action(); tips.SetToolTip(b, hint);
        return b;
    }
    static string F(double v) { return v.ToString("0.###", CultureInfo.InvariantCulture); }
    static string SizeText(long n) { return n >= 1073741824 ? (n / 1073741824d).ToString("0.00") + " GB" : n >= 1048576 ? (n / 1048576d).ToString("0.0") + " MB" : Math.Max(1, n / 1024d).ToString("0") + " KB"; }

    void BrowseInputs() {
        using (var d = new OpenFileDialog { Multiselect = true, Filter = "高斯泼溅文件|*.ply;*.sog;*.ksplat;*.splat;*.spz", Title = "添加源文件" })
            if (d.ShowDialog(this) == DialogResult.OK) AddFiles(d.FileNames);
    }
    void AddFiles(IEnumerable<string> paths) {
        if (active != null) return;
        int rejected = 0;
        foreach (string p in paths ?? new string[0]) {
            string path = Path.GetFullPath(p);
            if (!Converter.Supported(path) || !File.Exists(path)) { rejected++; continue; }
            if (!inputs.Any(i => String.Equals(i.Path, path, StringComparison.OrdinalIgnoreCase))) inputs.Add(new InputFile(path));
        }
        RefreshFiles(-1);
        if (rejected > 0) status.Text = "已跳过 " + rejected + " 个无效或不支持的文件";
    }
    void RemoveFiles() { foreach (int i in files.SelectedIndices.Cast<int>().Reverse().ToArray()) inputs.RemoveAt(i); RefreshFiles(-1); }
    void MoveFile(int d) {
        if (files.SelectedIndices.Count != 1) return;
        int i = files.SelectedIndices[0], j = i + d;
        if (j < 0 || j >= inputs.Count) return;
        var file = inputs[i]; inputs.RemoveAt(i); inputs.Insert(j, file); RefreshFiles(j);
    }
    void RefreshFiles(int select) {
        files.BeginUpdate(); files.Items.Clear();
        scope.Items.Clear(); scope.Items.Add("合并后的结果");
        long bytes = 0;
        foreach (var input in inputs) {
            var info = new FileInfo(input.Path);
            long size = info.Exists ? info.Length : 0; bytes += size;
            var li = new ListViewItem(info.Name) { ToolTipText = info.FullName }; li.SubItems.Add(SizeText(size)); files.Items.Add(li);
            scope.Items.Add(info.Name);
        }
        scope.SelectedIndex = select + 1;
        if (select >= 0) files.Items[select].Selected = true;
        files.EndUpdate();
        tally.Text = inputs.Count + " 个文件" + (bytes > 0 ? " · " + SizeText(bytes) : "");
        SuggestPath(); RefreshStart();
    }
    List<Op> CurrentOps() { return scope.SelectedIndex <= 0 || scope.SelectedIndex > inputs.Count ? outputOps : inputs[scope.SelectedIndex - 1].Ops; }
    void RefreshOps(int select) {
        steps.Items.Clear(); foreach (var op in CurrentOps()) steps.Items.Add(op);
        if (select >= 0 && steps.Items.Count > 0) steps.SelectedIndex = Math.Min(select, steps.Items.Count - 1);
    }
    void MoveOp(int d) {
        int i = steps.SelectedIndex, j = i + d; var ops = CurrentOps();
        if (i < 0 || j < 0 || j >= ops.Count) return;
        var op = ops[i]; ops.RemoveAt(i); ops.Insert(j, op); RefreshOps(j);
    }
    void EditOp(bool edit) {
        var list = CurrentOps(); int i = steps.SelectedIndex;
        if (edit && i < 0) return;
        using (var dialog = new StepDialog(edit ? list[i] : null)) {
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            if (edit) list[i] = dialog.Result; else { i = list.Count; list.Add(dialog.Result); }
            RefreshOps(i);
        }
    }
    Format SelectedFormat { get { return (Format)formats.SelectedItem; } }
    void FormatChanged() {
        var f = SelectedFormat;
        iterations.Visible = effort.Visible = workers.Visible = f.Sog;
        voxel.Visible = opacity.Visible = f.Voxel;
        device.Parent.Visible = f.Sog || f.Voxel;
        device.Items.Clear(); device.Items.Add("自动选用显卡");
        if (!f.Voxel) device.Items.Add("CPU（处理器）");
        device.Items.Add("Vulkan（兼容后端）");
        device.SelectedIndex = 0;
        autoPath = true; SuggestPath();
    }
    void SuggestPath() {
        if (!autoPath) return;
        updatingPath = true;
        output.Text = inputs.Count == 0 ? "" : Path.Combine(Path.GetDirectoryName(inputs[0].Path),
            (inputs.Count > 1 ? "combined" : Converter.Stem(inputs[0].Path) + "-converted") + SelectedFormat.Suffix);
        updatingPath = false;
    }
    void BrowseOutput() {
        var f = SelectedFormat;
        using (var d = new SaveFileDialog { Filter = f.Name.Replace("|", " ") + "|*" + f.Suffix, AddExtension = false,
            FileName = Path.GetFileName(output.Text), OverwritePrompt = false, Title = "选择输出文件" }) {
            if (inputs.Count > 0) d.InitialDirectory = Path.GetDirectoryName(inputs[0].Path);
            if (d.ShowDialog(this) == DialogResult.OK) output.Text = Suffix(d.FileName, f.Suffix);
        }
    }
    static string Suffix(string path, string suffix) { return path.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) ? path : path + suffix; }
    void RefreshStart() { if (start != null) start.Enabled = active == null && inputs.Count > 0 && !String.IsNullOrWhiteSpace(output.Text); }

    async void Begin() {
        if (active != null || inputs.Count == 0) return;
        string target;
        try { target = Path.GetFullPath(Suffix(output.Text.Trim(), SelectedFormat.Suffix)); }
        catch (Exception ex) { MessageBox.Show(this, ex.Message, "输出路径无效"); return; }
        bool overwrite = File.Exists(target);
        if (overwrite && MessageBox.Show(this, "转换成功后覆盖已有文件？\n" + target, "确认覆盖", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        var f = SelectedFormat;
        var job = new Job { Output = target, Format = f, Overwrite = overwrite, Keep = keep.Value, Iterations = iterations.Value,
            Effort = effort.Value, Workers = workers.Value, VoxelSize = F(voxel.Value / 1000.0), Opacity = F(opacity.Value / 100.0),
            Device = !(f.Sog || f.Voxel) ? "cpu" : device.SelectedIndex == 0 ? "auto" : !f.Voxel && device.SelectedIndex == 1 ? "cpu" : "vulkan" };
        job.Inputs.AddRange(inputs); job.Ops.AddRange(outputOps);
        active = new CancellationTokenSource(); var token = active.Token;
        workspace.Enabled = false; cancel.Enabled = true; RefreshStart();
        logView.Clear(); reveal.Visible = false; progress.Value = 0; progress.Style = ProgressBarStyle.Marquee;
        var report = new Progress<string>(s => { if (active != null && !token.IsCancellationRequested) status.Text = s; });
        try {
            await Task.Run(() => converter.Convert(job, token, s => ((IProgress<string>)report).Report(s), s => events.Enqueue(s)));
            completed = job.Output; reveal.Visible = true;
            long inputBytes = job.Inputs.Sum(i => new FileInfo(i.Path).Length), outputBytes = new FileInfo(completed).Length;
            status.Text = "已完成 · " + SizeText(outputBytes) + (inputBytes > outputBytes ? " · 减少 " + ((1 - outputBytes / (double)inputBytes) * 100).ToString("0.0") + "%" : "");
            events.Enqueue("输出：" + completed);
            progress.Style = ProgressBarStyle.Continuous; progress.Value = 100;
            if (!closing && StarPrompt.TryClaim(PromptMarker)) {
                if (PromptOverride != null) PromptOverride();
                else ShowStarPrompt();
            }
        } catch (OperationCanceledException) { status.Text = "已取消"; }
        catch (Exception ex) { status.Text = "转换失败 · 详见日志"; events.Enqueue(ex.Message); }
        finally {
            FlushLog(); progress.Style = ProgressBarStyle.Continuous;
            active.Dispose(); active = null; workspace.Enabled = true; cancel.Enabled = false; RefreshStart();
            if (closing) Close();
        }
    }
    void Stop() { if (active != null) { status.Text = "正在取消…"; cancel.Enabled = false; active.Cancel(); } }
    void FlushLog() {
        var b = new System.Text.StringBuilder(); string line;
        while (events.TryDequeue(out line)) b.AppendLine(line);
        if (b.Length == 0) return;
        if (logView.TextLength > 180000) logView.Text = logView.Text.Substring(logView.TextLength - 120000);
        logView.AppendText(b.ToString());
    }
    void OpenOutput() {
        if (completed != null && File.Exists(completed)) Process.Start("explorer.exe", "/select,\"" + completed + "\"");
    }
    void OpenRepository() {
        try { Process.Start(new ProcessStartInfo(App.Repository) { UseShellExecute = true }); }
        catch (Exception ex) { MessageBox.Show(this, ex.Message, "无法打开浏览器"); }
    }
    void ShowStarPrompt() {
        using (var dialog = new Form { Text = "转换成功，感谢使用", StartPosition = FormStartPosition.CenterParent,
            ClientSize = new Size(440, 184), FormBorderStyle = FormBorderStyle.FixedDialog, MinimizeBox = false, MaximizeBox = false, Font = Font }) {
            var message = new Label { Dock = DockStyle.Fill, Padding = new Padding(20, 17, 20, 0),
                Text = "第一次转换已完成！\n\n如果这个工具帮到了你，欢迎到 GitHub 为项目点一个 Star（赞）。感谢支持。" };
            var row = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 50, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(12, 0, 12, 0) };
            var open = new Button { Text = "打开项目", Width = 110, Height = 32 };
            var dismiss = new Button { Text = "关闭", Width = 85, Height = 32, DialogResult = DialogResult.Cancel };
            open.Click += (s, e) => { dialog.Close(); OpenRepository(); };
            row.Controls.Add(open); row.Controls.Add(dismiss); dialog.CancelButton = dismiss;
            dialog.Controls.Add(message); dialog.Controls.Add(row); dialog.ShowDialog(this);
        }
    }
    void ShowLicenses() {
        using (var dialog = new Form { Text = "开源许可", StartPosition = FormStartPosition.CenterParent, Size = new Size(790, 555), Font = Font })
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("licenses.txt"))
        using (var reader = new StreamReader(stream)) {
            var text = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false,
                Text = reader.ReadToEnd().Replace("\r\n", "\n").Replace("\n", "\r\n") };
            dialog.Controls.Add(text); dialog.ShowDialog(this);
        }
    }
}

static class StarPrompt {
    internal static bool TryClaim(string marker = null) {
        marker = marker ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SplatConvertDesktop", "star-prompt-shown-v1");
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(marker));
            using (var stream = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                byte[] bytes = System.Text.Encoding.UTF8.GetBytes(DateTime.UtcNow.ToString("O"));
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            return true;
        } catch (IOException) { return false; } catch (UnauthorizedAccessException) { return false; }
    }
}

sealed class StepDialog : Form {
    readonly ComboBox type = new ComboBox { Dock = DockStyle.Top, DropDownStyle = ComboBoxStyle.DropDownList };
    readonly TableLayoutPanel values = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 6 };
    readonly List<Control> edits = new List<Control>();
    public Op Result;
    public StepDialog(Op op) {
        Text = op == null ? "添加操作" : "编辑操作";
        StartPosition = FormStartPosition.CenterParent; FormBorderStyle = FormBorderStyle.FixedDialog;
        MinimizeBox = MaximizeBox = false; ClientSize = new Size(375, 300); Padding = new Padding(14);
        Font = new Font("Microsoft YaHei UI", 9F);
        values.Padding = new Padding(0, 12, 0, 0);
        values.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 108)); values.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (int i = 0; i < 6; i++) values.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 34, FlowDirection = FlowDirection.RightToLeft };
        var ok = new Button { Text = "确定", Width = 85, Height = 28 }; var cancel = new Button { Text = "取消", Width = 85, Height = 28, DialogResult = DialogResult.Cancel };
        buttons.Controls.Add(ok); buttons.Controls.Add(cancel); AcceptButton = ok; CancelButton = cancel;
        Controls.Add(values); Controls.Add(buttons); Controls.Add(type);
        type.Items.AddRange(Step.All);
        type.SelectedIndexChanged += (s, e) => Fields(null);
        type.SelectedItem = op != null ? op.Step : Step.All[0];
        if (op != null) Fields(op.Value);
        ok.Click += (s, e) => Save();
    }
    void Fields(string previous) {
        while (values.Controls.Count > 0) values.Controls[0].Dispose();
        edits.Clear(); var step = (Step)type.SelectedItem;
        if (step.Fields == "") return;
        string[] fields = step.Fields.Split(','), data = (previous ?? step.Defaults).Split(',');
        for (int i = 0; i < fields.Length; i++) {
            values.Controls.Add(new Label { Text = fields[i], AutoSize = true, Margin = new Padding(0, 5, 0, 0) }, 0, i);
            Control c = step.Flag == "--filter-harmonics"
                ? (Control)new TrackBar { Minimum = 0, Maximum = 3, Value = Int32.Parse(data[i]), TickFrequency = 1, Dock = DockStyle.Fill, AutoSize = false }
                : new TextBox { Text = data[i], Dock = DockStyle.Fill };
            values.Controls.Add(c, 1, i); edits.Add(c);
            var track = c as TrackBar;
            if (track != null) {
                var label = (Label)values.GetControlFromPosition(0, i);
                track.ValueChanged += (s, e) => label.Text = "阶数：" + track.Value;
                label.Text = "阶数：" + track.Value;
            }
        }
    }
    void Save() {
        var step = (Step)type.SelectedItem; var numbers = new List<double>();
        foreach (Control c in edits) {
            if (c is TrackBar) { numbers.Add(((TrackBar)c).Value); continue; }
            double n;
            if (!Double.TryParse(c.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out n) || Double.IsNaN(n) || Double.IsInfinity(n)) { Invalid("请输入有效数字。", c); return; }
            numbers.Add(n);
        }
        if ((step.Flag == "--scale" || step.Flag == "--filter-sphere") && numbers.Last() <= 0) { Invalid("倍率或半径必须大于零。", edits.Last()); return; }
        if (step.Flag == "--filter-box" && Enumerable.Range(0, 3).Any(i => numbers[i] > numbers[i + 3])) { Invalid("包围盒的最小值不能大于最大值。", edits[0]); return; }
        Result = new Op { Step = step, Value = String.Join(",", numbers.Select(n => n.ToString("R", CultureInfo.InvariantCulture))) };
        DialogResult = DialogResult.OK;
    }
    void Invalid(string message, Control c) { MessageBox.Show(this, message, "参数无效"); c.Focus(); }
}
