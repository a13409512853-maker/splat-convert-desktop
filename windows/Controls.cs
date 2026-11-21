using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Windows.Forms;

sealed class CardPanel : Panel {
    internal int Radius = 11;
    internal bool UseSubCard = false;
    internal CardPanel() {
        DoubleBuffered = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        Padding = new Padding(14);
    }
    protected override void OnPaintBackground(PaintEventArgs e) {
        var p = Theme.Current;
        using (var bg = new SolidBrush(Parent != null ? Parent.BackColor : p.WindowBg))
            e.Graphics.FillRectangle(bg, ClientRectangle);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = Theme.RoundedRect(rect, Radius))
        using (var fill = new SolidBrush(UseSubCard ? p.SubCardBg : p.CardBg))
        using (var pen = new Pen(p.Border, 1f)) {
            e.Graphics.FillPath(fill, path);
            e.Graphics.DrawPath(pen, path);
        }
    }
}

sealed class ModernProgressBar : Control {
    double percent;
    internal double Percent {
        get { return percent; }
        set { percent = Math.Max(0, Math.Min(100, value)); Invalidate(); }
    }
    internal ModernProgressBar() {
        DoubleBuffered = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        Height = 8;
    }
    protected override void OnPaint(PaintEventArgs e) {
        var p = Theme.Current;
        using (var bg = new SolidBrush(Parent != null ? Parent.BackColor : p.TitleBarBg))
            e.Graphics.FillRectangle(bg, ClientRectangle);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var track = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
        int r = Math.Max(2, Height / 2);
        using (var trackPath = Theme.RoundedRect(track, r))
        using (var trackBrush = new SolidBrush(p.BorderStrong))
            e.Graphics.FillPath(trackBrush, trackPath);
        if (percent > 0.2) {
            int fillW = Math.Max(Height, (int)Math.Round((Width - 1) * (percent / 100d)));
            var fillRect = new Rectangle(0, 0, Math.Min(Width - 1, fillW), Math.Max(1, Height - 1));
            using (var fillPath = Theme.RoundedRect(fillRect, r))
            using (var fillBrush = new LinearGradientBrush(fillRect, p.Accent, p.AccentHover, 0f))
                e.Graphics.FillPath(fillBrush, fillPath);
        }
    }
}

sealed class FluentButton : Button {
    internal bool Primary;
    internal bool Pill;
    internal bool SoftAccent;
    internal string IconName;
    internal int Radius = 7;
    bool hovered, pressed;

    internal FluentButton() {
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        Cursor = Cursors.Hand;
        DoubleBuffered = true;
        UseMnemonic = false;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }

    protected override void OnMouseEnter(EventArgs e) { hovered = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hovered = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { pressed = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }

    protected override void OnPaint(PaintEventArgs e) {
        var p = Theme.Current;
        var g = e.Graphics;
        using (var parentBg = new SolidBrush(Parent != null ? Parent.BackColor : p.CardBg))
            g.FillRectangle(parentBg, ClientRectangle);
        g.SmoothingMode = SmoothingMode.AntiAlias;

        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        int rad = Pill ? Height / 2 : Radius;
        Color fill, border, fg;

        if (!Enabled) {
            fill = p.SubCardBg; border = p.Border; fg = p.Muted;
        } else if (Primary) {
            fill = pressed ? p.AccentHover : (hovered ? p.AccentHover : p.Accent);
            border = fill; fg = p.AccentText;
        } else if (SoftAccent) {
            fill = hovered ? Color.FromArgb(p.IsDark ? 30 : 212, p.IsDark ? 76 : 238, p.IsDark ? 74 : 233) : p.AccentSoft;
            border = p.AccentBorder; fg = p.Accent;
        } else {
            fill = pressed ? p.SubCardBg : (hovered ? p.SubCardBg : p.CardBg);
            border = hovered ? p.AccentBorder : p.BorderStrong;
            fg = p.Ink;
        }

        using (var path = Theme.RoundedRect(rect, rad))
        using (var brush = new SolidBrush(fill))
        using (var pen = new Pen(border, 1f)) {
            g.FillPath(brush, path);
            g.DrawPath(pen, path);
        }

        Image img = null;
        if (!String.IsNullOrEmpty(IconName)) {
            if (Primary) img = Art.Icon(p.IsDark ? IconName : IconName + "-white") ?? Art.Icon(IconName);
            else img = Art.Themed(IconName);
        }

        string txt = Text ?? "";
        var txtSize = String.IsNullOrEmpty(txt) ? Size.Empty : TextRenderer.MeasureText(g, txt, Font, Size, TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
        int gap = (img != null && !String.IsNullOrEmpty(txt)) ? 6 : 0;
        int totalW = (img != null ? img.Width : 0) + gap + txtSize.Width;
        int startX = Math.Max(6, (Width - totalW) / 2);

        if (img != null) {
            g.DrawImage(img, startX, (Height - img.Height) / 2, img.Width, img.Height);
            startX += img.Width + gap;
        }
        if (!String.IsNullOrEmpty(txt)) {
            var tr = new Rectangle(startX, 0, Math.Max(10, Width - startX - 4), Height);
            TextRenderer.DrawText(g, txt, Font, tr, fg, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        }
    }
}

sealed class SegmentedControl : Control {
    readonly List<string> items = new List<string>();
    int selectedIndex;
    int hoverIndex = -1;
    internal event EventHandler SelectedIndexChanged;

    internal int SelectedIndex {
        get { return selectedIndex; }
        set {
            int clamped = Math.Max(0, Math.Min(Math.Max(0, items.Count - 1), value));
            if (selectedIndex == clamped) return;
            selectedIndex = clamped;
            Invalidate();
            if (SelectedIndexChanged != null) SelectedIndexChanged(this, EventArgs.Empty);
        }
    }

    internal SegmentedControl() {
        DoubleBuffered = true;
        Cursor = Cursors.Hand;
        Height = 30;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }

    internal void SetItems(params string[] labels) {
        items.Clear();
        if (labels != null) items.AddRange(labels);
        if (selectedIndex >= items.Count) selectedIndex = 0;
        Invalidate();
    }

    int HitIndex(int x) {
        if (items.Count == 0 || Width <= 0) return -1;
        int idx = (int)Math.Floor((x / (double)Width) * items.Count);
        return Math.Max(0, Math.Min(items.Count - 1, idx));
    }

    protected override void OnMouseMove(MouseEventArgs e) {
        int idx = HitIndex(e.X);
        if (idx != hoverIndex) { hoverIndex = idx; Invalidate(); }
        base.OnMouseMove(e);
    }
    protected override void OnMouseLeave(EventArgs e) { hoverIndex = -1; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) {
        if (e.Button == MouseButtons.Left && Enabled) {
            int idx = HitIndex(e.X);
            if (idx >= 0) SelectedIndex = idx;
        }
        base.OnMouseDown(e);
    }

    protected override void OnPaint(PaintEventArgs e) {
        var p = Theme.Current;
        var g = e.Graphics;
        using (var bg = new SolidBrush(Parent != null ? Parent.BackColor : p.CardBg))
            g.FillRectangle(bg, ClientRectangle);
        g.SmoothingMode = SmoothingMode.AntiAlias;

        var outer = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = Theme.RoundedRect(outer, 7))
        using (var fill = new SolidBrush(p.SubCardBg))
        using (var pen = new Pen(p.Border, 1f)) {
            g.FillPath(fill, path);
            g.DrawPath(pen, path);
        }

        if (items.Count == 0) return;
        float segW = (Width - 4f) / items.Count;
        using (var boldFont = new Font(Font, FontStyle.Bold)) {
            for (int i = 0; i < items.Count; i++) {
                var r = new Rectangle((int)Math.Round(2 + i * segW), 2, Math.Max(10, (int)Math.Round(segW)), Height - 5);
                if (i == selectedIndex) {
                    using (var sp = Theme.RoundedRect(r, 5))
                    using (var sb = new SolidBrush(p.CardBg))
                    using (var spen = new Pen(p.AccentBorder, 1f)) {
                        g.FillPath(sb, sp);
                        g.DrawPath(spen, sp);
                    }
                    TextRenderer.DrawText(g, items[i], boldFont, r, p.Accent, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
                } else {
                    TextRenderer.DrawText(g, items[i], Font, r, i == hoverIndex ? p.Ink : p.Text2, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
                }
            }
        }
    }
}

sealed class FluentSlider : Control {
    int min = 0, max = 100, val = 100;
    bool dragging, hovered;
    internal event EventHandler ValueChanged;

    internal int Minimum { get { return min; } set { min = value; if (val < min) val = min; Invalidate(); } }
    internal int Maximum { get { return max; } set { max = value; if (val > max) val = max; Invalidate(); } }
    internal int Value {
        get { return val; }
        set {
            int clamped = Math.Max(min, Math.Min(max, value));
            if (val == clamped) return;
            val = clamped;
            Invalidate();
            if (ValueChanged != null) ValueChanged(this, EventArgs.Empty);
        }
    }

    internal FluentSlider() {
        DoubleBuffered = true;
        Cursor = Cursors.Hand;
        Height = 24;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }

    void UpdateFromX(int x) {
        int pad = 9;
        int w = Math.Max(1, Width - pad * 2);
        double frac = Math.Max(0d, Math.Min(1d, (x - pad) / (double)w));
        Value = (int)Math.Round(min + frac * (max - min));
    }

    protected override void OnMouseDown(MouseEventArgs e) {
        if (e.Button == MouseButtons.Left && Enabled) { dragging = true; Capture = true; UpdateFromX(e.X); }
        base.OnMouseDown(e);
    }
    protected override void OnMouseMove(MouseEventArgs e) {
        if (dragging) UpdateFromX(e.X);
        else if (!hovered) { hovered = true; Invalidate(); }
        base.OnMouseMove(e);
    }
    protected override void OnMouseUp(MouseEventArgs e) { dragging = false; Capture = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnMouseLeave(EventArgs e) { hovered = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseWheel(MouseEventArgs e) {
        if (Enabled) Value += e.Delta > 0 ? 1 : -1;
        base.OnMouseWheel(e);
    }

    protected override void OnPaint(PaintEventArgs e) {
        var p = Theme.Current;
        var g = e.Graphics;
        using (var bg = new SolidBrush(Parent != null ? Parent.BackColor : p.SubCardBg))
            g.FillRectangle(bg, ClientRectangle);
        g.SmoothingMode = SmoothingMode.AntiAlias;

        int pad = 9;
        int trackH = 5;
        int trackY = (Height - trackH) / 2;
        int trackW = Math.Max(10, Width - pad * 2);
        double frac = max > min ? (val - min) / (double)(max - min) : 0d;
        int thumbX = pad + (int)Math.Round(frac * trackW);

        var trackRect = new Rectangle(pad, trackY, trackW, trackH);
        using (var tp = Theme.RoundedRect(trackRect, 2))
        using (var tb = new SolidBrush(p.BorderStrong))
            g.FillPath(tb, tp);

        int activeW = Math.Max(0, thumbX - pad);
        if (activeW > 1) {
            var activeRect = new Rectangle(pad, trackY, activeW, trackH);
            using (var ap = Theme.RoundedRect(activeRect, 2))
            using (var ab = new SolidBrush(Enabled ? p.Accent : p.Muted))
                g.FillPath(ab, ap);
        }

        int d = (dragging || hovered) ? 16 : 14;
        var thumb = new Rectangle(thumbX - d / 2, (Height - d) / 2, d, d);
        using (var shadow = new SolidBrush(Color.FromArgb(40, 0, 0, 0)))
            g.FillEllipse(shadow, thumb.X, thumb.Y + 1, thumb.Width, thumb.Height);
        using (var outer = new SolidBrush(p.CardBg))
            g.FillEllipse(outer, thumb);
        using (var inner = new SolidBrush(Enabled ? p.Accent : p.Muted))
            g.FillEllipse(inner, thumb.X + 2, thumb.Y + 2, thumb.Width - 4, thumb.Height - 4);
    }
}

sealed class FluentInputBox : Panel {
    internal readonly TextBox Inner = new TextBox();
    bool focused;
    internal FluentInputBox() {
        DoubleBuffered = true;
        Height = 32;
        Padding = new Padding(9, 6, 9, 5);
        Inner.BorderStyle = BorderStyle.None;
        Inner.Dock = DockStyle.Fill;
        Inner.GotFocus += (s, e) => { focused = true; Invalidate(); };
        Inner.LostFocus += (s, e) => { focused = false; Invalidate(); };
        Controls.Add(Inner);
    }
    internal void ApplyTheme() {
        var p = Theme.Current;
        BackColor = p.InputBg;
        Inner.BackColor = p.InputBg;
        Inner.ForeColor = p.Ink;
        Invalidate();
    }
    protected override void OnPaint(PaintEventArgs e) {
        var p = Theme.Current;
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = Theme.RoundedRect(rect, 6))
        using (var bg = new SolidBrush(p.InputBg))
        using (var pen = new Pen(focused ? p.Accent : p.BorderStrong, focused ? 1.4f : 1f)) {
            e.Graphics.FillPath(bg, path);
            e.Graphics.DrawPath(pen, path);
        }
    }
}

sealed class FluentMetricTile : Control {
    internal string IconBaseName;
    internal string LabelText = "";
    internal string ValueText = "";
    internal double Percent;
    internal bool IsCompressing;
    internal bool AlertDanger;
    bool hovered;

    internal FluentMetricTile() {
        DoubleBuffered = true;
        Cursor = Cursors.Hand;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }
    protected override void OnMouseEnter(EventArgs e) { hovered = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hovered = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnPaint(PaintEventArgs e) {
        var p = Theme.Current;
        var g = e.Graphics;
        using (var bg = new SolidBrush(Parent != null ? Parent.BackColor : p.TitleBarBg))
            g.FillRectangle(bg, ClientRectangle);
        g.SmoothingMode = SmoothingMode.AntiAlias;

        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = Theme.RoundedRect(rect, 8))
        using (var fill = new SolidBrush(p.CardBg))
        using (var pen = new Pen(hovered ? p.AccentBorder : p.Border, 1f)) {
            g.FillPath(fill, path);
            g.DrawPath(pen, path);
        }

        Image icon = Art.Themed(IconBaseName);
        int leftX = 10;
        if (icon != null) {
            g.DrawImage(icon, leftX, (Height - icon.Height) / 2 - 2, icon.Width, icon.Height);
            leftX += icon.Width + 8;
        }

        int textTop = 5;
        using (var valFont = new Font("Consolas", 8.8f, FontStyle.Bold)) {
            var valRect = new Rectangle(leftX + 38, textTop, Math.Max(20, Width - leftX - 48), 18);
            var lblRect = new Rectangle(leftX, textTop, 56, 18);
            TextRenderer.DrawText(g, LabelText, Font, lblRect, p.Ink, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
            TextRenderer.DrawText(g, ValueText, valFont, valRect, AlertDanger ? p.Danger : p.Ink, TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        }

        // Sleek 3px mini usage bar at bottom
        int barY = Height - 8;
        int barW = Math.Max(10, Width - leftX - 10);
        var track = new Rectangle(leftX, barY, barW, 3);
        using (var tb = new SolidBrush(p.BorderStrong))
            g.FillRectangle(tb, track);
        double pct = Math.Max(0, Math.Min(100, Percent));
        int fillW = (int)Math.Round(barW * (pct / 100d));
        if (fillW > 0) {
            Color c = AlertDanger ? p.Danger : (IsCompressing ? p.ChartActive : p.ChartIdle);
            using (var fb = new SolidBrush(c))
                g.FillRectangle(fb, leftX, barY, fillW, 3);
        }
    }
}

sealed class FluentFileList : Control {
    readonly List<InputFile> items = new List<InputFile>();
    int selectedIndex = -1;
    int hoverIndex = -1;
    bool hoverDelete;
    int scrollOffset;
    const int RowHeight = 52;
    const int RowGap = 6;

    internal event EventHandler SelectedIndexChanged;
    internal event Action<int> DeleteRequested;
    internal event Action AddRequested;

    internal int SelectedIndex {
        get { return selectedIndex; }
        set { selectedIndex = value; Invalidate(); }
    }

    internal FluentFileList() {
        DoubleBuffered = true;
        AllowDrop = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }

    internal void SetFiles(IList<InputFile> list, int select) {
        items.Clear();
        items.AddRange(list);
        selectedIndex = select >= 0 && select < items.Count ? select : (items.Count > 0 && selectedIndex >= 0 && selectedIndex < items.Count ? selectedIndex : -1);
        ClampScroll();
        Invalidate();
    }

    void ClampScroll() {
        int contentH = items.Count * (RowHeight + RowGap);
        int maxScroll = Math.Max(0, contentH - Height + 8);
        scrollOffset = Math.Max(0, Math.Min(maxScroll, scrollOffset));
    }

    protected override void OnMouseWheel(MouseEventArgs e) {
        scrollOffset -= e.Delta / 3;
        ClampScroll();
        Invalidate();
        base.OnMouseWheel(e);
    }

    Rectangle RowRect(int i) { return new Rectangle(0, i * (RowHeight + RowGap) - scrollOffset, Width - 2, RowHeight); }
    internal Rectangle GetRowScreenRect(int i) { var r = RowRect(i); var pt = PointToScreen(new Point(r.X, r.Y)); return new Rectangle(pt.X, pt.Y, r.Width, r.Height); }
    Rectangle DelRect(Rectangle row) { return new Rectangle(row.Right - 30, row.Y + (row.Height - 24) / 2, 24, 24); }

    protected override void OnMouseMove(MouseEventArgs e) {
        int hit = -1; bool del = false;
        for (int i = 0; i < items.Count; i++) {
            var r = RowRect(i);
            if (r.Contains(e.Location)) { hit = i; del = DelRect(r).Contains(e.Location); break; }
        }
        if (hit != hoverIndex || del != hoverDelete) {
            hoverIndex = hit; hoverDelete = del;
            Cursor = (items.Count == 0 || hit >= 0) ? Cursors.Hand : Cursors.Default;
            Invalidate();
        }
        base.OnMouseMove(e);
    }

    protected override void OnMouseLeave(EventArgs e) { hoverIndex = -1; hoverDelete = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnMouseDown(MouseEventArgs e) {
        if (e.Button != MouseButtons.Left || !Enabled) return;
        if (items.Count == 0) { if (AddRequested != null) AddRequested(); return; }
        for (int i = 0; i < items.Count; i++) {
            var r = RowRect(i);
            if (r.Contains(e.Location)) {
                if (DelRect(r).Contains(e.Location)) {
                    if (DeleteRequested != null) DeleteRequested(i);
                    return;
                }
                selectedIndex = i;
                Invalidate();
                if (SelectedIndexChanged != null) SelectedIndexChanged(this, EventArgs.Empty);
                return;
            }
        }
        base.OnMouseDown(e);
    }

    static string FormatSize(string path) {
        try {
            long sz = new FileInfo(path).Length;
            return sz >= 1073741824 ? Budget.GB(sz) : (sz / 1048576d).ToString("0.0", CultureInfo.InvariantCulture) + " MiB";
        } catch { return ""; }
    }

    protected override void OnPaint(PaintEventArgs e) {
        var p = Theme.Current;
        var g = e.Graphics;
        using (var bg = new SolidBrush(p.CardBg)) g.FillRectangle(bg, ClientRectangle);
        g.SmoothingMode = SmoothingMode.AntiAlias;

        if (items.Count == 0) {
            var box = new Rectangle(1, 1, Width - 3, Height - 3);
            using (var path = Theme.RoundedRect(box, 10))
            using (var fill = new SolidBrush(p.SubCardBg))
            using (var dash = new Pen(p.BorderStrong, 1.2f) { DashStyle = DashStyle.Dash }) {
                g.FillPath(fill, path);
                g.DrawPath(dash, path);
            }
            TextRenderer.DrawText(g, I18n.T("emptyFiles"), Font, box, p.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.WordBreak);
            return;
        }

        using (var fName = new Font(Font, FontStyle.Bold))
        using (var fMeta = new Font(Font.FontFamily, 8f)) {
            for (int i = 0; i < items.Count; i++) {
                var r = RowRect(i);
                if (r.Bottom < 0 || r.Top > Height) continue;
                bool sel = i == selectedIndex;
                bool hov = i == hoverIndex;
                using (var path = Theme.RoundedRect(r, 8))
                using (var fill = new SolidBrush(sel ? p.AccentSoft : p.SubCardBg))
                using (var pen = new Pen(sel ? p.Accent : (hov ? p.AccentBorder : p.Border), 1f)) {
                    g.FillPath(fill, path);
                    g.DrawPath(pen, path);
                }
                TextRenderer.DrawText(g, (i + 1).ToString(), fMeta, new Rectangle(r.X + 8, r.Y, 20, r.Height), p.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                string fn = Path.GetFileName(items[i].Path);
                string meta = FormatSize(items[i].Path) + " · " + Path.GetExtension(items[i].Path).TrimStart('.').ToUpperInvariant();
                TextRenderer.DrawText(g, fn, fName, new Rectangle(r.X + 30, r.Y + 7, r.Width - 64, 19), p.Ink, TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
                TextRenderer.DrawText(g, meta, fMeta, new Rectangle(r.X + 30, r.Y + 27, r.Width - 64, 17), p.Muted, TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);

                var dr = DelRect(r);
                if (hov && hoverDelete) {
                    using (var dp = Theme.RoundedRect(dr, 5))
                    using (var db = new SolidBrush(p.DangerSoft)) g.FillPath(db, dp);
                }
                TextRenderer.DrawText(g, "✕", fMeta, dr, (hov && hoverDelete) ? p.Danger : p.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }
        }
    }
}

sealed class FluentOpList : Control {
    readonly List<Op> items = new List<Op>();
    int selectedIndex = -1;
    int hoverIndex = -1;
    int scrollOffset;
    const int RowHeight = 54;
    const int RowGap = 6;

    internal event EventHandler SelectedIndexChanged;
    internal event Action<int> ToggleEnabledRequested;
    internal event Action<int> EditRequested;
    internal event Action<int> HoverOpChanged;

    internal int SelectedIndex {
        get { return selectedIndex; }
        set { selectedIndex = value; Invalidate(); }
    }

    internal FluentOpList() {
        DoubleBuffered = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }

    internal void SetOps(IList<Op> ops, int select) {
        items.Clear();
        items.AddRange(ops);
        selectedIndex = select >= 0 && select < items.Count ? select : (items.Count > 0 && selectedIndex >= 0 && selectedIndex < items.Count ? selectedIndex : -1);
        ClampScroll();
        Invalidate();
    }

    void ClampScroll() {
        int contentH = items.Count * (RowHeight + RowGap);
        int maxScroll = Math.Max(0, contentH - Height + 8);
        scrollOffset = Math.Max(0, Math.Min(maxScroll, scrollOffset));
    }

    Rectangle RowRect(int i) { return new Rectangle(0, i * (RowHeight + RowGap) - scrollOffset, Width - 2, RowHeight); }
    Rectangle CheckRect(Rectangle r) { return new Rectangle(r.X + 10, r.Y + (r.Height - 16) / 2, 16, 16); }

    protected override void OnMouseWheel(MouseEventArgs e) { scrollOffset -= e.Delta / 3; ClampScroll(); Invalidate(); base.OnMouseWheel(e); }

    protected override void OnMouseMove(MouseEventArgs e) {
        int hit = -1;
        for (int i = 0; i < items.Count; i++) { if (RowRect(i).Contains(e.Location)) { hit = i; break; } }
        if (hit != hoverIndex) {
            hoverIndex = hit;
            Cursor = hit >= 0 ? Cursors.Hand : Cursors.Default;
            Invalidate();
            if (HoverOpChanged != null) HoverOpChanged(hit);
        }
        base.OnMouseMove(e);
    }

    protected override void OnMouseLeave(EventArgs e) {
        hoverIndex = -1;
        Invalidate();
        if (HoverOpChanged != null) HoverOpChanged(-1);
        base.OnMouseLeave(e);
    }

    protected override void OnMouseDown(MouseEventArgs e) {
        if (e.Button != MouseButtons.Left || !Enabled) return;
        for (int i = 0; i < items.Count; i++) {
            var r = RowRect(i);
            if (r.Contains(e.Location)) {
                var cr = Rectangle.Inflate(CheckRect(r), 4, 4);
                if (cr.Contains(e.Location)) {
                    if (ToggleEnabledRequested != null) ToggleEnabledRequested(i);
                    return;
                }
                selectedIndex = i;
                Invalidate();
                if (SelectedIndexChanged != null) SelectedIndexChanged(this, EventArgs.Empty);
                return;
            }
        }
        base.OnMouseDown(e);
    }

    protected override void OnMouseDoubleClick(MouseEventArgs e) {
        if (selectedIndex >= 0 && EditRequested != null) EditRequested(selectedIndex);
        base.OnMouseDoubleClick(e);
    }

    static string BadgeFor(string flag) {
        if (flag == "--filter-nan") return "清理";
        if (flag == "--filter-floaters" || flag == "--filter-cluster") return "3.12 新增";
        if (flag == "--filter-harmonics") return "瘦身";
        if (flag == "--filter-box" || flag == "--filter-sphere") return "裁剪";
        return "变换";
    }

    protected override void OnPaint(PaintEventArgs e) {
        var p = Theme.Current;
        var g = e.Graphics;
        using (var bg = new SolidBrush(p.CardBg)) g.FillRectangle(bg, ClientRectangle);
        g.SmoothingMode = SmoothingMode.AntiAlias;

        if (items.Count == 0) {
            var box = new Rectangle(1, 1, Width - 3, Height - 3);
            using (var path = Theme.RoundedRect(box, 10))
            using (var fill = new SolidBrush(p.SubCardBg))
            using (var pen = new Pen(p.Border, 1f)) {
                g.FillPath(fill, path); g.DrawPath(pen, path);
            }
            TextRenderer.DrawText(g, I18n.T("emptyOps"), Font, box, p.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.WordBreak);
            return;
        }

        using (var fTitle = new Font(Font, FontStyle.Bold))
        using (var fTag = new Font(Font.FontFamily, 7.2f, FontStyle.Bold))
        using (var fSub = new Font("Consolas", 8f)) {
            for (int i = 0; i < items.Count; i++) {
                var r = RowRect(i);
                if (r.Bottom < 0 || r.Top > Height) continue;
                var op = items[i];
                bool sel = i == selectedIndex;
                bool hov = i == hoverIndex;
                using (var path = Theme.RoundedRect(r, 8))
                using (var fill = new SolidBrush(sel ? p.AccentSoft : p.SubCardBg))
                using (var pen = new Pen(sel ? p.Accent : (hov ? p.AccentBorder : p.Border), 1f)) {
                    g.FillPath(fill, path); g.DrawPath(pen, path);
                }

                // Custom rounded checkbox
                var cr = CheckRect(r);
                using (var cp = Theme.RoundedRect(cr, 4))
                using (var cb = new SolidBrush(op.Enabled ? p.Accent : p.CardBg))
                using (var cpen = new Pen(op.Enabled ? p.Accent : p.BorderStrong, 1.2f)) {
                    g.FillPath(cb, cp); g.DrawPath(cpen, cp);
                }
                if (op.Enabled) {
                    using (var ck = new Pen(p.AccentText, 1.8f) { StartCap = LineCap.Round, EndCap = LineCap.Round }) {
                        g.DrawLines(ck, new[] { new Point(cr.X + 3, cr.Y + 8), new Point(cr.X + 6, cr.Y + 11), new Point(cr.X + 12, cr.Y + 4) });
                    }
                }

                string badge = BadgeFor(op.Step.Flag);
                var badgeSz = TextRenderer.MeasureText(g, badge, fTag);
                var badgeRect = new Rectangle(r.Right - badgeSz.Width - 14, r.Y + 8, badgeSz.Width + 8, 17);
                using (var bp = Theme.RoundedRect(badgeRect, 4))
                using (var bb = new SolidBrush(p.AccentSoft)) g.FillPath(bb, bp);
                TextRenderer.DrawText(g, badge, fTag, badgeRect, p.Accent, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);

                var titleRect = new Rectangle(r.X + 34, r.Y + 7, Math.Max(40, badgeRect.Left - r.X - 38), 19);
                TextRenderer.DrawText(g, op.Step.Name, fTitle, titleRect, op.Enabled ? p.Ink : p.Muted, TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);

                string sub = String.IsNullOrEmpty(op.Value) ? "自动默认参数" : op.Value;
                TextRenderer.DrawText(g, sub, fSub, new Rectangle(r.X + 34, r.Y + 28, r.Width - 44, 17), p.Muted, TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
            }
        }
    }
}

sealed class FluentDropdown : Control {
    readonly List<object> items = new List<object>();
    int selectedIndex = -1;
    bool hovered, open;
    internal event EventHandler SelectedIndexChanged;
    internal IList<object> Items { get { return items; } }
    internal int SelectedIndex {
        get { return selectedIndex; }
        set {
            int clamped = items.Count == 0 ? -1 : Math.Max(0, Math.Min(items.Count - 1, value));
            if (selectedIndex == clamped) return;
            selectedIndex = clamped;
            Invalidate();
            if (SelectedIndexChanged != null) SelectedIndexChanged(this, EventArgs.Empty);
        }
    }
    internal object SelectedItem {
        get { return selectedIndex >= 0 && selectedIndex < items.Count ? items[selectedIndex] : null; }
        set { int idx = items.IndexOf(value); if (idx >= 0) SelectedIndex = idx; }
    }
    public override string Text {
        get { return SelectedItem == null ? "" : SelectedItem.ToString(); }
        set { }
    }
    internal FluentDropdown() {
        DoubleBuffered = true;
        Cursor = Cursors.Hand;
        Height = 32;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }
    internal void SetItems(IEnumerable<object> list, int select) {
        items.Clear();
        if (list != null) items.AddRange(list);
        selectedIndex = items.Count == 0 ? -1 : Math.Max(0, Math.Min(items.Count - 1, select));
        Invalidate();
    }
    protected override void OnMouseEnter(EventArgs e) { hovered = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hovered = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) {
        if (e.Button == MouseButtons.Left && Enabled && items.Count > 0) ShowPopup();
        base.OnMouseDown(e);
    }
    void ShowPopup() {
        var menu = new ContextMenuStrip { ShowImageMargin = false, Font = Font, Renderer = new FluentMenuRenderer() };
        for (int i = 0; i < items.Count; i++) {
            int idx = i;
            var mi = new ToolStripMenuItem((i == selectedIndex ? "✓  " : "    ") + items[i].ToString());
            mi.Click += (s, e) => SelectedIndex = idx;
            menu.Items.Add(mi);
        }
        menu.Closed += (s, e) => { open = false; Invalidate(); };
        open = true; Invalidate();
        menu.MinimumSize = new Size(Width, 10);
        menu.Show(this, new Point(0, Height + 2));
    }
    protected override void OnPaint(PaintEventArgs e) {
        var p = Theme.Current;
        var g = e.Graphics;
        using (var bg = new SolidBrush(Parent != null ? Parent.BackColor : p.CardBg)) g.FillRectangle(bg, ClientRectangle);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = Theme.RoundedRect(rect, 7))
        using (var fill = new SolidBrush(Enabled ? p.InputBg : p.SubCardBg))
        using (var pen = new Pen(open ? p.Accent : (hovered ? p.AccentBorder : p.BorderStrong), open ? 1.3f : 1f)) {
            g.FillPath(fill, path); g.DrawPath(pen, path);
        }
        var tr = new Rectangle(10, 0, Math.Max(10, Width - 30), Height);
        TextRenderer.DrawText(g, Text, Font, tr, Enabled ? p.Ink : p.Muted, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        // Crisp vector chevron
        int cx = Width - 16, cy = Height / 2 - 2;
        using (var pen = new Pen(p.Muted, 1.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
            g.DrawLines(pen, new[] { new Point(cx - 4, cy), new Point(cx, cy + 4), new Point(cx + 4, cy) });
    }
}

sealed class FluentMenuRenderer : ToolStripProfessionalRenderer {
    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) {
        using (var b = new SolidBrush(Theme.Current.CardBg)) e.Graphics.FillRectangle(b, e.AffectedBounds);
    }
    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) {
        using (var pen = new Pen(Theme.Current.BorderStrong, 1f)) e.Graphics.DrawRectangle(pen, 0, 0, e.AffectedBounds.Width - 1, e.AffectedBounds.Height - 1);
    }
    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e) {
        var p = Theme.Current;
        var r = new Rectangle(3, 1, e.Item.Width - 6, e.Item.Height - 2);
        using (var b = new SolidBrush(e.Item.Selected ? p.AccentSoft : p.CardBg)) e.Graphics.FillRectangle(b, r);
    }
    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
        e.TextColor = e.Item.Selected ? Theme.Current.Accent : Theme.Current.Ink;
        base.OnRenderItemText(e);
    }
}
