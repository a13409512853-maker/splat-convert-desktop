using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

sealed class Palette {
    internal Color WindowBg, TitleBarBg, CardBg, SubCardBg, InputBg, LogBg;
    internal Color Border, BorderStrong, Ink, Text2, Muted;
    internal Color Accent, AccentHover, AccentSoft, AccentText;
    internal Color ChartIdle, ChartActive, ChartGrid, Danger;
    internal bool IsDark;
}

static class Theme {
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    internal static readonly Palette Light = new Palette {
        IsDark = false,
        WindowBg = Color.FromArgb(243, 245, 248),
        TitleBarBg = Color.FromArgb(234, 239, 244),
        CardBg = Color.White,
        SubCardBg = Color.FromArgb(245, 248, 250),
        InputBg = Color.White,
        LogBg = Color.FromArgb(248, 250, 252),
        Border = Color.FromArgb(219, 226, 232),
        BorderStrong = Color.FromArgb(196, 206, 214),
        Ink = Color.FromArgb(20, 28, 36),
        Text2 = Color.FromArgb(71, 85, 105),
        Muted = Color.FromArgb(100, 116, 139),
        Accent = Color.FromArgb(0, 120, 100),
        AccentHover = Color.FromArgb(0, 98, 82),
        AccentSoft = Color.FromArgb(228, 245, 240),
        AccentText = Color.White,
        ChartIdle = Color.FromArgb(14, 165, 233),
        ChartActive = Color.FromArgb(249, 115, 22),
        ChartGrid = Color.FromArgb(226, 232, 240),
        Danger = Color.FromArgb(185, 48, 48)
    };

    internal static readonly Palette Dark = new Palette {
        IsDark = true,
        WindowBg = Color.FromArgb(24, 27, 32),
        TitleBarBg = Color.FromArgb(19, 22, 27),
        CardBg = Color.FromArgb(35, 40, 49),
        SubCardBg = Color.FromArgb(28, 32, 40),
        InputBg = Color.FromArgb(29, 34, 42),
        LogBg = Color.FromArgb(18, 21, 26),
        Border = Color.FromArgb(52, 59, 71),
        BorderStrong = Color.FromArgb(72, 82, 98),
        Ink = Color.FromArgb(241, 245, 249),
        Text2 = Color.FromArgb(203, 213, 225),
        Muted = Color.FromArgb(148, 163, 184),
        Accent = Color.FromArgb(20, 184, 166),
        AccentHover = Color.FromArgb(45, 212, 191),
        AccentSoft = Color.FromArgb(24, 62, 60),
        AccentText = Color.FromArgb(8, 32, 30),
        ChartIdle = Color.FromArgb(56, 189, 248),
        ChartActive = Color.FromArgb(251, 146, 60),
        ChartGrid = Color.FromArgb(52, 60, 74),
        Danger = Color.FromArgb(248, 113, 113)
    };

    internal static Palette Current = Light;

    static string StatePath {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SplatConvertDesktop", "theme.txt"); }
    }

    internal static void Restore() {
        try {
            if (File.Exists(StatePath)) {
                string val = File.ReadAllText(StatePath).Trim();
                Current = String.Equals(val, "dark", StringComparison.OrdinalIgnoreCase) ? Dark : Light;
            }
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    internal static void Toggle() {
        Current = Current.IsDark ? Light : Dark;
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(StatePath));
            File.WriteAllText(StatePath, Current.IsDark ? "dark" : "light");
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    internal static void ApplyWindowChrome(Form form) {
        if (form == null || !form.IsHandleCreated) return;
        try {
            int dark = Current.IsDark ? 1 : 0;
            DwmSetWindowAttribute(form.Handle, 20, ref dark, sizeof(int));
            int corner = 2; // DWMWCP_ROUND on Windows 11
            DwmSetWindowAttribute(form.Handle, 33, ref corner, sizeof(int));
        } catch { }
    }

    internal static GraphicsPath RoundedRect(Rectangle r, int radius) {
        var path = new GraphicsPath();
        int d = radius * 2;
        if (r.Width <= d || r.Height <= d) { path.AddRectangle(r); return path; }
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}

sealed class CardPanel : Panel {
    internal int Radius = 10;
    internal CardPanel() {
        DoubleBuffered = true;
        Padding = new Padding(12);
    }
    protected override void OnPaintBackground(PaintEventArgs e) {
        var p = Theme.Current;
        using (var bg = new SolidBrush(Parent != null ? Parent.BackColor : p.WindowBg))
            e.Graphics.FillRectangle(bg, ClientRectangle);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = Theme.RoundedRect(rect, Radius))
        using (var fill = new SolidBrush(p.CardBg))
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
        Height = 8;
    }
    protected override void OnPaint(PaintEventArgs e) {
        var p = Theme.Current;
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
            using (var fillBrush = new SolidBrush(p.Accent))
                e.Graphics.FillPath(fillBrush, fillPath);
        }
    }
}
