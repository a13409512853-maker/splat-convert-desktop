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
    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
    static extern int SetWindowTheme(IntPtr hwnd, string subAppName, string subIdList);

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

    internal static Palette Current = Dark;

    internal static void Restore() {
        var s = PortablePaths.LoadSettings();
        if (String.Equals(s.Theme, "light", StringComparison.OrdinalIgnoreCase)) Current = Light;
        else Current = Dark;
    }

    internal static void Toggle() {
        Current = Current.IsDark ? Light : Dark;
        PortablePaths.SaveSettings(s => { s.Theme = Current.IsDark ? "dark" : "light"; });
    }

    internal static void ApplyWindowChrome(Form form) {
        if (form == null || !form.IsHandleCreated) return;
        try {
            int dark = Current.IsDark ? 1 : 0;
            if (DwmSetWindowAttribute(form.Handle, 20, ref dark, sizeof(int)) != 0) {
                DwmSetWindowAttribute(form.Handle, 19, ref dark, sizeof(int));
            }
            int corner = 2; // DWMWCP_ROUND
            DwmSetWindowAttribute(form.Handle, 33, ref corner, sizeof(int));
        } catch { }
    }

    // Forces seamless dark native titlebar & outer border on the always-dark 3D Editor window (fixes white Win10/11 caption rim)
    internal static void ApplyEditorDarkChrome(Form form) {
        if (form == null || !form.IsHandleCreated) return;
        try {
            int dark = 1;
            if (DwmSetWindowAttribute(form.Handle, 20, ref dark, sizeof(int)) != 0) {
                DwmSetWindowAttribute(form.Handle, 19, ref dark, sizeof(int));
            }
            // Win11 COLORREF is 0x00BBGGRR: #111419 caption, #252A33 subtle dark border, #E2E8F0 text
            int captionColor = 0x00191411;
            int borderColor = 0x00332A25;
            int textColor = 0x00F0E8E2;
            DwmSetWindowAttribute(form.Handle, 35, ref captionColor, sizeof(int));
            DwmSetWindowAttribute(form.Handle, 34, ref borderColor, sizeof(int));
            DwmSetWindowAttribute(form.Handle, 36, ref textColor, sizeof(int));
            int corner = 2;
            DwmSetWindowAttribute(form.Handle, 33, ref corner, sizeof(int));
        } catch { }
    }

    internal static void ApplyDarkScrollbars(Control root) {
        if (root == null) return;
        string themeName = Current.IsDark ? "DarkMode_Explorer" : "Explorer";
        ApplyScrollThemeRecursive(root, themeName);
    }

    static void ApplyScrollThemeRecursive(Control ctrl, string themeName) {
        try {
            if (ctrl.IsHandleCreated) SetWindowTheme(ctrl.Handle, themeName, null);
        } catch { }
        foreach (Control child in ctrl.Controls) ApplyScrollThemeRecursive(child, themeName);
    }

    // Unified Apple Continuous-Curvature Design System Radii (See UI与模块化工程设计规范.md)
    internal const int RadiusCard = 14;
    internal const int RadiusPanel = 12;
    internal const int RadiusControl = 8;
    internal const int RadiusBadge = 6;

    internal static void ApplyRoundedWindowRegion(Form form, int radius) {
        if (form == null || form.Width <= 0 || form.Height <= 0) return;
        try {
            using (var path = RoundedRect(new Rectangle(0, 0, form.Width, form.Height), radius)) {
                var old = form.Region;
                form.Region = new Region(path);
                if (old != null) old.Dispose();
            }
        } catch { }
    }

    /// <summary>
    /// Builds an Apple-style continuous-curvature (G2-like superellipse / squircle) rounded rectangle path.
    /// Eliminates abrupt curvature jumps between straight edges and circular arcs across the entire desktop UI.
    /// </summary>
    internal static GraphicsPath RoundedRect(Rectangle r, int radius) {
        var path = new GraphicsPath();
        if (r.Width <= 0 || r.Height <= 0) return path;
        float w = r.Width;
        float h = r.Height;
        float maxR = Math.Min(w, h) * 0.5f;
        float rad = Math.Min(radius, maxR);
        if (rad <= 0.5f) { path.AddRectangle(r); return path; }

        // Full capsule / pill uses true semicircular ends; standard corners use Apple continuous squircle shoulders
        bool isPill = rad >= maxR - 0.5f;
        float x0 = r.X, y0 = r.Y, x1 = r.Right, y1 = r.Bottom;
        if (isPill) {
            float d = rad * 2f;
            path.AddArc(x0, y0, d, d, 180, 90);
            path.AddArc(x1 - d, y0, d, d, 270, 90);
            path.AddArc(x1 - d, y1 - d, d, d, 0, 90);
            path.AddArc(x0, y1 - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        // Apple HIG continuous-curvature squircle: smooth shoulder inset (1.22x) + symmetric 2-cubic corner curve
        float s = Math.Min(rad * 1.22f, maxR);
        float apex = rad * 0.275f; // smooth superellipse diagonal fullness (between circle 0.293 and sharper arc)
        float cEdge = s * 0.48f;
        float cMidA = apex * 0.26f;
        float cMidB = apex * 1.56f;

        // Top-Left corner: (x0, y0+s) -> (x0+apex, y0+apex) -> (x0+s, y0)
        path.StartFigure();
        path.AddBezier(x0, y0 + s, x0, y0 + cEdge, x0 + cMidA, y0 + cMidB, x0 + apex, y0 + apex);
        path.AddBezier(x0 + apex, y0 + apex, x0 + cMidB, y0 + cMidA, x0 + cEdge, y0, x0 + s, y0);

        // Top edge -> Top-Right corner
        path.AddLine(x0 + s, y0, x1 - s, y0);
        path.AddBezier(x1 - s, y0, x1 - cEdge, y0, x1 - cMidB, y0 + cMidA, x1 - apex, y0 + apex);
        path.AddBezier(x1 - apex, y0 + apex, x1 - cMidA, y0 + cMidB, x1, y0 + cEdge, x1, y0 + s);

        // Right edge -> Bottom-Right corner
        path.AddLine(x1, y0 + s, x1, y1 - s);
        path.AddBezier(x1, y1 - s, x1, y1 - cEdge, x1 - cMidA, y1 - cMidB, x1 - apex, y1 - apex);
        path.AddBezier(x1 - apex, y1 - apex, x1 - cMidB, y1 - cMidA, x1 - cEdge, y1, x1 - s, y1);

        // Bottom edge -> Bottom-Left corner
        path.AddLine(x1 - s, y1, x0 + s, y1);
        path.AddBezier(x0 + s, y1, x0 + cEdge, y1, x0 + cMidB, y1 - cMidA, x0 + apex, y1 - apex);
        path.AddBezier(x0 + apex, y1 - apex, x0 + cMidA, y1 - cMidB, x0, y1 - cEdge, x0, y1 - s);

        path.CloseFigure();
        return path;
    }
}
