using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class MessageDialog {
    internal static bool Confirm(Form owner, string title, string message, string yes, string no) {
        bool result = false;
        using (var dialog = Create(owner, title, message)) {
            var buttons = Buttons(); var cancel = Button(no, null, () => dialog.Close());
            var accept = Button(yes, null, () => { result = true; dialog.Close(); });
            buttons.Controls.Add(accept); buttons.Controls.Add(cancel); dialog.Controls.Add(buttons); dialog.CancelButton = cancel; dialog.ShowDialog(owner);
        }
        return result;
    }
    internal static void Failure(Form owner, string title, string text, string raw, Action log) {
        using (var dialog = Create(owner, title, text)) {
            var buttons = Buttons(); var close = Button(I18n.T("adjust"), null, () => dialog.Close());
            var copy = Button(I18n.T("copy"), "copy", () => { try { Clipboard.SetText(raw); } catch (ExternalException) { } });
            var view = Button(I18n.T("viewLog"), "logs", () => { dialog.Close(); log(); });
            buttons.Controls.Add(close); buttons.Controls.Add(view); buttons.Controls.Add(copy); dialog.Controls.Add(buttons); dialog.CancelButton = close; dialog.ShowDialog(owner);
        }
    }
    static Form Create(Form owner, string title, string message) {
        var dialog = new Form { Text = title, Font = owner.Font, ClientSize = new Size(660, 420), MinimumSize = new Size(630, 390),
            StartPosition = FormStartPosition.CenterParent, BackColor = Color.White, MinimizeBox = false, MaximizeBox = false };
        var label = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, BorderStyle = BorderStyle.None, BackColor = Color.White,
            ScrollBars = ScrollBars.Vertical, Text = message.Replace("\r\n", "\n").Replace("\n", "\r\n") };
        var host = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24) }; host.Controls.Add(label); dialog.Controls.Add(host); return dialog;
    }
    static FlowLayoutPanel Buttons() { return new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 62, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(12, 8, 12, 8), WrapContents = false, BackColor = MainWindow.Paper }; }
    static Button Button(string text, string icon, Action action) {
        var button = new Button { Text = text, AutoSize = true, MinimumSize = new Size(100, 36), Height = 36, FlatStyle = FlatStyle.Flat,
            BackColor = Color.White, Image = icon == null ? null : Art.Icon(icon), TextImageRelation = TextImageRelation.ImageBeforeText, Padding = new Padding(8, 0, 8, 0) };
        button.FlatAppearance.BorderColor = MainWindow.Line; button.Click += (s, e) => action(); return button;
    }
}

static class StarPrompt {
    internal static bool TryClaim(string marker = null) {
        marker = marker ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SplatConvertDesktop", "star-prompt-shown-v1");
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
    readonly ComboBox type = new ComboBox { Dock = DockStyle.Top, DropDownStyle = ComboBoxStyle.DropDownList };
    readonly TableLayoutPanel values = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 6 };
    readonly List<Control> edits = new List<Control>();
    internal Op Result;
    internal StepDialog(Op op) {
        Text = I18n.T(op == null ? "addOp" : "edit"); StartPosition = FormStartPosition.CenterParent; FormBorderStyle = FormBorderStyle.FixedDialog;
        MinimizeBox = MaximizeBox = false; ClientSize = new Size(450, 335); Padding = new Padding(18); Font = new Font("Microsoft YaHei UI", 9F);
        values.Padding = new Padding(0, 13, 0, 0); values.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130)); values.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (int i = 0; i < 6; i++) values.RowStyles.Add(new RowStyle(SizeType.Absolute, 33));
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 38, FlowDirection = FlowDirection.RightToLeft };
        var ok = new Button { Text = I18n.T("ok"), Width = 100, Height = 32 }; var cancel = new Button { Text = I18n.T("cancel"), Width = 110, Height = 32, DialogResult = DialogResult.Cancel };
        buttons.Controls.Add(ok); buttons.Controls.Add(cancel); AcceptButton = ok; CancelButton = cancel;
        Controls.Add(values); Controls.Add(buttons); Controls.Add(type); type.Items.AddRange(Step.All); type.SelectedIndexChanged += (s, e) => Fields(null);
        type.SelectedItem = op == null ? Step.All[0] : op.Step; if (op != null) Fields(op.Value); ok.Click += (s, e) => Save();
    }
    void Fields(string previous) {
        while (values.Controls.Count > 0) values.Controls[0].Dispose(); edits.Clear(); var step = (Step)type.SelectedItem;
        if (step.Fields == "") return;
        string[] fields = step.Fields.Split(','), data = (previous ?? step.Defaults).Split(',');
        for (int i = 0; i < fields.Length; i++) {
            var label = new Label { Text = fields[i], AutoSize = true, Margin = new Padding(0, 6, 0, 0) }; values.Controls.Add(label, 0, i);
            Control control = step.Flag == "--filter-harmonics" ? (Control)new TrackBar { Minimum = 0, Maximum = 3, Value = Int32.Parse(data[i]), TickFrequency = 1, Dock = DockStyle.Fill, AutoSize = false }
                : new TextBox { Text = data[i], Dock = DockStyle.Fill };
            values.Controls.Add(control, 1, i); edits.Add(control); var track = control as TrackBar;
            if (track != null) { track.ValueChanged += (s, e) => label.Text = I18n.T("band") + ": " + track.Value; label.Text = I18n.T("band") + ": " + track.Value; }
        }
    }
    void Save() {
        var step = (Step)type.SelectedItem; var numbers = new List<double>();
        foreach (Control control in edits) {
            if (control is TrackBar) { numbers.Add(((TrackBar)control).Value); continue; }
            double number;
            if (!Double.TryParse(control.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out number) || Double.IsNaN(number) || Double.IsInfinity(number)) { Invalid(control); return; }
            numbers.Add(number);
        }
        if ((step.Flag == "--scale" || step.Flag == "--filter-sphere") && numbers.Last() <= 0) { Invalid(edits.Last()); return; }
        if (step.Flag == "--filter-box" && Enumerable.Range(0, 3).Any(i => numbers[i] > numbers[i + 3])) { Invalid(edits[0]); return; }
        Result = new Op { Step = step, Value = String.Join(",", numbers.Select(n => n.ToString("R", CultureInfo.InvariantCulture))) }; DialogResult = DialogResult.OK;
    }
    void Invalid(Control control) { MessageBox.Show(this, I18n.T("numeric"), I18n.T("invalid")); control.Focus(); }
}
