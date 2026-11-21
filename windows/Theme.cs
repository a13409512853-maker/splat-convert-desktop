using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

sealed class Palette {
    internal Color WindowBg, TitleBarBg, CardBg, SubCardBg, InputBg, LogBg;
    internal Color Border, BorderStrong, Ink, Text2, Muted;
    internal Color Accent, AccentHover, AccentSoft, AccentBorder, AccentText;
    internal Color Warn, WarnSoft, Danger, DangerSoft;
    internal Color ChartIdle, ChartActive, ChartGrid;
    internal bool IsDark;
}

static class Theme {
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    internal static readonly Palette Light = new Palette {
        IsDark = false,
        WindowBg = Color.FromArgb(243, 245, 248),
        TitleBarBg = Color.FromArgb(238, 242, 246),
        CardBg = Color.White,
        SubCardBg = Color.FromArgb(241, 245, 249),
        InputBg = Color.White,
        LogBg = Color.FromArgb(248, 250, 252),
        Border = Color.FromArgb(226, 232, 240),
        BorderStrong = Color.FromArgb(203, 213, 225),
        Ink = Color.FromArgb(17, 24, 39),
        Text2 = Color.FromArgb(75, 85, 99),
        Muted = Color.FromArgb(107, 114, 128),
        Accent = Color.FromArgb(0, 120, 100),
        AccentHover = Color.FromArgb(0, 97, 81),
        AccentSoft = Color.FromArgb(230, 244, 241),
        AccentBorder = Color.FromArgb(167, 218, 208),
        AccentText = Color.White,
        Warn = Color.FromArgb(217, 119, 6),
        WarnSoft = Color.FromArgb(254, 243, 199),
        Danger = Color.FromArgb(220, 38, 38),
        DangerSoft = Color.FromArgb(254, 226, 226),
        ChartIdle = Color.FromArgb(14, 165, 233),
        ChartActive = Color.FromArgb(249, 115, 22),
        ChartGrid = Color.FromArgb(226, 232, 240)
    };

    internal static readonly Palette Dark = new Palette {
        IsDark = true,
        WindowBg = Color.FromArgb(24, 27, 32),
        TitleBarBg = Color.FromArgb(20, 23, 28),
        CardBg = Color.FromArgb(36, 41, 51),
        SubCardBg = Color.FromArgb(28, 32, 40),
        InputBg = Color.FromArgb(30, 35, 44),
        LogBg = Color.FromArgb(19, 22, 27),
        Border = Color.FromArgb(51, 58, 71),
        BorderStrong = Color.FromArgb(71, 82, 99),
        Ink = Color.FromArgb(243, 244, 246),
        Text2 = Color.FromArgb(203, 213, 225),
        Muted = Color.FromArgb(148, 163, 184),
        Accent = Color.FromArgb(20, 184, 166),
        AccentHover = Color.FromArgb(45, 212, 191),
        AccentSoft = Color.FromArgb(20, 58, 57),
        AccentBorder = Color.FromArgb(45, 130, 122),
        AccentText = Color.FromArgb(4, 47, 46),
        Warn = Color.FromArgb(245, 158, 11),
        WarnSoft = Color.FromArgb(66, 46, 18),
        Danger = Color.FromArgb(248, 113, 113),
        DangerSoft = Color.FromArgb(69, 26, 26),
        ChartIdle = Color.FromArgb(56, 189, 248),
        ChartActive = Color.FromArgb(251, 146, 60),
        ChartGrid = Color.FromArgb(52, 60, 74)
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
            int corner = 2; // DWMWCP_ROUND
            DwmSetWindowAttribute(form.Handle, 33, ref corner, sizeof(int));
        } catch { }
    }

    internal static GraphicsPath RoundedRect(Rectangle r, int radius) {
        var path = new GraphicsPath();
        if (r.Width <= 0 || r.Height <= 0) return path;
        int rad = Math.Min(radius, Math.Min(r.Width, r.Height) / 2);
        if (rad <= 0) { path.AddRectangle(r); return path; }
        int d = rad * 2;
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}
