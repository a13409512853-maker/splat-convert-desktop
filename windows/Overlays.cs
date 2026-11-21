using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

sealed class BeginnerTipEntry {
    internal string Title, Tag, Summary, UpEffect, DownEffect, Recommend;
}

static class BeginnerTips {
    internal static string KeyForStepFlag(string flag) {
        if (flag == "--filter-nan") return "nan";
        if (flag == "--filter-floaters") return "floaters";
        if (flag == "--filter-cluster") return "cluster";
        if (flag == "--filter-harmonics") return "sh";
        if (flag == "--translate") return "translate";
        if (flag == "--rotate") return "rotate";
        if (flag == "--scale") return "scale";
        if (flag == "--filter-box") return "box";
        if (flag == "--filter-sphere") return "sphere";
        return null;
    }

    static readonly Dictionary<string, BeginnerTipEntry> Zh = new Dictionary<string, BeginnerTipEntry> {
        { "mode", new BeginnerTipEntry { Title = "处理模式：批量独立 vs 合并", Tag = "工作流", Summary = "决定拖入多个文件时，是逐个分别输出，还是拼成一个大场景。", UpEffect = "批量独立转换：一次拖入 10 个模型，自动按原名输出 10 个文件。", DownEffect = "合并为一个：将多个局部扫描叠加合并成单个场景文件。", Recommend = "日常批量转格式请保持默认的「批量独立转换」。" } },
        { "format", new BeginnerTipEntry { Title = "导出格式", Tag = "核心设置", Summary = "决定输出文件能在什么软件/网页中打开以及最终体积。", UpEffect = "SOG / HTML 压缩率最高（缩小 10–20 倍）；SPZ 适合轻量跨平台存储。", DownEffect = "标准 PLY 体积最大但兼容性最广，适合导入编辑器继续精修。", Recommend = "网页发布选 SOG，发给别人直接看选 HTML，留底编辑选 PLY。" } },
        { "preset", new BeginnerTipEntry { Title = "四档快捷预设", Tag = "一键配置", Summary = "自动协同设置保留点数、球谐阶数、迭代次数与打包强度。", UpEffect = "快速转换：最快速度直出预览；高质归档：保留 100% 点数与完整反光。", DownEffect = "极致瘦身：最小体积适合手机；网页均衡：画质/体积/速度最佳平衡。", Recommend = "多数网页发布选「网页均衡」，只想极速转格式选「快速转换」。" } },
        { "keep", new BeginnerTipEntry { Title = "保留点数比例（抽稀减面）", Tag = "瘦身核心", Summary = "智能合并冗余高斯点缩小场景规模，让手机与网页流畅加载。", UpEffect = "100% 完整保留所有点，画质最原汁原味但体积和显存占用大。", DownEffect = "调低（如 45%–75%）显著瘦身提速，配合自适应抽稀可保护主体边缘。", Recommend = "超过 200 万点的场景建议降到 50%–75% 并开启自适应抽稀。" } },
        { "adaptive", new BeginnerTipEntry { Title = "自适应抽稀（--decimate-adaptive）", Tag = "3.12 新增", Summary = "按局部视觉误差决定删点位置，避免均匀删点毁掉天空或细节。", UpEffect = "开启后对混合尺度场景（室外/天空+近景）画质明显更好。", DownEffect = "关闭（均匀抽稀）速度稍快且内存占用更低。", Recommend = "保留点数低于 100% 时建议开启。" } },
        { "iterations", new BeginnerTipEntry { Title = "球谐压缩迭代（SH Iterations）", Tag = "SOG 专属", Summary = "控制表面反光与视角变色细节的聚类压缩精细度。", UpEffect = "调高（15–25）反光过渡更细腻，但转换时间明显增加。", DownEffect = "调低（3–8）转换极快，适合快速预览。", Recommend = "快速预览用 3–6，均衡用 10，精品归档用 20–25。" } },
        { "effort", new BeginnerTipEntry { Title = "WebP 打包强度（Effort 0–9）", Tag = "SOG 专属", Summary = "SOG 使用无损 WebP 纹理存数据，此项决定压缩压榨程度。", UpEffect = "数值越高（最高 9）文件越小且画质完全无损，但 CPU 打包耗时更久。", DownEffect = "设为 0 打包飞快，文件仅略大一点。", Recommend = "快速转换选 0，均衡选默认，极致瘦身/归档选 8–9。" } },
        { "workers", new BeginnerTipEntry { Title = "编码线程数（Max Workers）", Tag = "性能", Summary = "同时调用多少个 CPU 线程做纹理压缩与编码。", UpEffect = "调大可缩短打包耗时，但 CPU 与内存峰值同步升高。", DownEffect = "调小（或 0 串行）更省内存、电脑不易卡顿。", Recommend = "默认 4 稳妥；32G 以上大内存可调至 6–8。" } },
        { "voxel", new BeginnerTipEntry { Title = "体素分辨率（Voxel Size）", Tag = "Voxel 专属", Summary = "导出游戏引擎碰撞体素时，每个小方块的边长（单位：米）。", UpEffect = "数值越大（0.1–0.2）网格越粗、体积小、速度快。", DownEffect = "数值越小（0.03–0.05）贴合家具墙面更精细，但更耗显存。", Recommend = "室内用 0.05，室外大场景用 0.1。" } },
        { "opacity", new BeginnerTipEntry { Title = "体素透明度阈值", Tag = "Voxel 专属", Summary = "决定多实心的点云才会被算作碰撞障碍物。", UpEffect = "调高可过滤空气薄雾，避免角色撞上空气墙。", DownEffect = "调低保留更多细小半透明结构。", Recommend = "默认 0.1 适用绝大多数场景。" } },
        { "device", new BeginnerTipEntry { Title = "计算设备与后端（含 Vulkan）", Tag = "Windows 关键", Summary = "SOG 压缩、去飞点与体素计算默认调用显卡（比 CPU 快 5–10 倍）。", UpEffect = "Vulkan：官方推荐绕过 Windows 默认 D3D12 驱动偶发崩溃问题。", DownEffect = "纯 CPU：不占显存的最稳兜底，但耗时慢 5–10 倍。", Recommend = "首选自动显卡；若显卡报错请切「Vulkan」。" } },
        { "floaters", new BeginnerTipEntry { Title = "去除空中飞点（--filter-floaters）", Tag = "3.12 新增", Summary = "利用 GPU 体素化自动清除漂浮在空中的零散噪点与雾团。", UpEffect = "勾选后画面更干净且顺带缩小体积。", DownEffect = "不勾选则保留全部原始点云，速度略快。", Recommend = "手机或无人机扫描场景强烈建议勾选。" } },
        { "cluster", new BeginnerTipEntry { Title = "保留连通主体（--filter-cluster）", Tag = "3.12 新增", Summary = "只保留与中心种子点连通的主场景，剥离远处孤立杂物。", UpEffect = "适合室内房间或单体雕塑去除背景干扰。", DownEffect = "不勾选则保留全部区域。", Recommend = "需要强力去背景孤岛时使用。" } },
        { "nan", new BeginnerTipEntry { Title = "移除无效点（NaN / Inf）", Tag = "数据清洗", Summary = "剔除坐标损坏、无穷大或旋转异常的坏点，防止渲染黑块或闪烁。", UpEffect = "几乎零画质损失且提升后续兼容性。", DownEffect = "取消勾选则跳过坏点检查。", Recommend = "建议始终保持勾选。" } },
        { "sh", new BeginnerTipEntry { Title = "球谐阶数上限（SH Bands）", Tag = "体积优化", Summary = "控制随视角变化的光泽反光数据，高阶 SH 常占文件一半以上体积。", UpEffect = "3 阶保留完整反光，但文件最大。", DownEffect = "降到 0 阶（仅基础色）或 1 阶，文件直接减半。", Recommend = "网页展示推荐 1 阶，极致瘦身推荐 0 阶。" } },
        { "translate", new BeginnerTipEntry { Title = "平移（Translate）", Tag = "空间变换", Summary = "沿 X / Y / Z 轴整体移动场景坐标位置。", UpEffect = "常用于把偏移原点很远的场景拉回坐标中心 (0,0,0)。", DownEffect = "设为 0,0,0 不移动。", Recommend = "多文件合并对齐位置时常用。" } },
        { "rotate", new BeginnerTipEntry { Title = "旋转校正（Rotate）", Tag = "空间变换", Summary = "按 X / Y / Z 轴旋转场景（单位：度）。", UpEffect = "用于把倒置或歪斜的手机扫描模型扶正。", DownEffect = "设为 0,0,0 不旋转。", Recommend = "手机扫描常见需绕 X 轴旋转 ±90° 或 180°。" } },
        { "scale", new BeginnerTipEntry { Title = "等比缩放（Scale）", Tag = "空间变换", Summary = "按统一倍率放大或缩小整个场景尺寸。", UpEffect = "大于 1 放大，小于 1 缩小（如 0.5 缩小一半）。", DownEffect = "设为 1 保持原始尺寸。", Recommend = "匹配游戏引擎单位尺度时使用。" } },
        { "box", new BeginnerTipEntry { Title = "包围盒筛选（Filter Box）", Tag = "区域裁剪", Summary = "只保留最小/最大 XYZ 立方体范围内的点云，裁掉外部杂乱背景。", UpEffect = "放大范围保留更多环境。", DownEffect = "缩小范围精准切出主体区域。", Recommend = "适合规则房间或矩形场地裁剪。" } },
        { "sphere", new BeginnerTipEntry { Title = "球形范围筛选（Filter Sphere）", Tag = "区域裁剪", Summary = "只保留以中心点为球心、指定半径内的点云。", UpEffect = "增大半径保留更远处景物。", DownEffect = "减小半径快速去掉远处天空和杂边。", Recommend = "适合航拍或 360° 环拍场景。" } },
        { "estOutput", new BeginnerTipEntry { Title = "预估输出体积", Tag = "实时估算", Summary = "根据输入文件头读取的真实点数、目标格式、保留比例与球谐阶数实时推算。", UpEffect = "帮助你不用实际跑完就能预判最终体积与瘦身幅度。", DownEffect = "实际体积受场景纹理复杂度影响，结果仅供参考区间。", Recommend = "拖动保留点数或切换预设即可即时观察体积变化。" } },
        { "engine", new BeginnerTipEntry { Title = "引擎独立更新（国内多镜像）", Tag = "解耦架构", Summary = "内置 v3.12.0 断网可用，联网可从国内镜像拉取新版 @playcanvas/splat-transform。", UpEffect = "支持阿里云 / 腾讯云 / 华为云 / 官方源自动切换与 SHA-512 校验。", DownEffect = "更新异常随时一键回滚到内置版本。", Recommend = "点击即可测速检查新版并查看上游原项目致谢。" } }
    };

    static readonly Dictionary<string, BeginnerTipEntry> En = new Dictionary<string, BeginnerTipEntry> {
        { "mode", new BeginnerTipEntry { Title = "Mode: Batch vs Merge", Tag = "Workflow", Summary = "Convert multiple files individually or merge them into one scene.", UpEffect = "Batch Convert: outputs one converted file per input automatically.", DownEffect = "Merge All: combines multiple scans into a single scene file.", Recommend = "Keep Batch Convert for everyday multi-file conversion." } },
        { "format", new BeginnerTipEntry { Title = "Export Format", Tag = "Core", Summary = "Determines file size and viewer/editor compatibility.", UpEffect = "SOG / HTML give 10–20x compression; SPZ is lightweight & portable.", DownEffect = "Standard PLY is largest but best for further 3D editing.", Recommend = "Choose SOG for web, HTML for instant sharing, PLY for editing." } },
        { "preset", new BeginnerTipEntry { Title = "Quick Presets", Tag = "1-Click", Summary = "Automatically tunes point ratio, SH bands, iterations, and WebP effort.", UpEffect = "Fast: quickest preview; High Quality: 100% points & full SH.", DownEffect = "Compact: smallest mobile size; Balanced: best overall trade-off.", Recommend = "Start with Balanced for web, or Fast for quick tests." } },
        { "keep", new BeginnerTipEntry { Title = "Keep Points % (Decimation)", Tag = "Size", Summary = "Merges redundant Gaussians so large scans run smoothly on web/mobile.", UpEffect = "100% keeps every point with original quality and largest size.", DownEffect = "45%–75% dramatically shrinks file size and VRAM use.", Recommend = "For scenes over 2M splats, try 50%–75% with adaptive decimation." } },
        { "adaptive", new BeginnerTipEntry { Title = "Adaptive Decimation", Tag = "3.12 New", Summary = "Allocates point removal by local visual error instead of uniformly.", UpEffect = "Preserves fine details and skies much better on mixed-scale scenes.", DownEffect = "Uniform mode is slightly faster with lower peak RAM.", Recommend = "Keep enabled whenever Keep Points < 100%." } },
        { "iterations", new BeginnerTipEntry { Title = "SH Compression Iterations", Tag = "SOG", Summary = "Controls clustering precision for view-dependent specular highlights.", UpEffect = "Higher (15–25) improves reflection fidelity but takes longer.", DownEffect = "Lower (3–8) encodes much faster for previews.", Recommend = "3–6 for fast preview, 10 balanced, 20–25 archival." } },
        { "effort", new BeginnerTipEntry { Title = "WebP Effort (0–9)", Tag = "SOG", Summary = "Lossless WebP compression effort for packed SOG textures.", UpEffect = "Higher (up to 9) yields smaller files with zero quality loss, slower CPU.", DownEffect = "0 packs very fast with slightly larger output.", Recommend = "0 for fast, Default for balanced, 8–9 for publishing." } },
        { "workers", new BeginnerTipEntry { Title = "Encoding Workers", Tag = "Speed", Summary = "Number of parallel CPU threads for texture packing.", UpEffect = "More workers finish faster but use more CPU and RAM.", DownEffect = "Fewer workers (or 0 serial) keep RAM usage lower.", Recommend = "4 is safe; 6–8 works great on 32GB+ systems." } },
        { "voxel", new BeginnerTipEntry { Title = "Voxel Size (meters)", Tag = "Voxel", Summary = "Edge length of each collision voxel cell.", UpEffect = "Larger (0.1–0.2m) is coarser, smaller, and faster.", DownEffect = "Smaller (0.03–0.05m) captures fine geometry with higher VRAM.", Recommend = "0.05m indoors, 0.1m for large outdoor scenes." } },
        { "opacity", new BeginnerTipEntry { Title = "Voxel Opacity Threshold", Tag = "Voxel", Summary = "Minimum opacity required for a splat to count as solid.", UpEffect = "Higher filters out wispy fog to avoid invisible walls.", DownEffect = "Lower retains thinner semi-transparent structures.", Recommend = "Default 0.1 works for most scenes." } },
        { "device", new BeginnerTipEntry { Title = "Compute Device & Vulkan", Tag = "Windows", Summary = "SOG compression, floater removal, and voxelization run 5–10x faster on GPU.", UpEffect = "Vulkan works around Windows D3D12 driver issues cleanly.", DownEffect = "CPU Only avoids VRAM limits but runs 5–10x slower.", Recommend = "Use Auto GPU first; switch to Vulkan if GPU errors occur." } },
        { "floaters", new BeginnerTipEntry { Title = "Remove Floaters (--filter-floaters)", Tag = "3.12 New", Summary = "Uses GPU voxelization to strip floating noise artifacts from scans.", UpEffect = "Produces cleaner visuals and smaller files.", DownEffect = "Unchecked keeps all raw splats.", Recommend = "Recommended for phone and drone captures." } },
        { "cluster", new BeginnerTipEntry { Title = "Keep Main Cluster", Tag = "3.12 New", Summary = "Keeps only the connected main cluster around the seed point.", UpEffect = "Removes isolated distant background islands.", DownEffect = "Unchecked keeps all disconnected regions.", Recommend = "Useful for isolated rooms or objects." } },
        { "nan", new BeginnerTipEntry { Title = "Remove Invalid Points (NaN/Inf)", Tag = "Clean", Summary = "Strips corrupted coordinates or zero-norm rotations.", UpEffect = "Prevents black artifacts and renderer crashes with zero quality loss.", DownEffect = "Unchecked skips validation.", Recommend = "Keep enabled by default." } },
        { "sh", new BeginnerTipEntry { Title = "Limit SH Bands", Tag = "Compact", Summary = "Caps spherical harmonic bands, which often take >50% of file size.", UpEffect = "Band 3 keeps full view-dependent reflections.", DownEffect = "Band 0 or 1 cuts file size in half with minimal visual change.", Recommend = "Use 1 for web, 0 for ultra-compact mobile." } },
        { "translate", new BeginnerTipEntry { Title = "Translate (X, Y, Z)", Tag = "Transform", Summary = "Shifts the entire scene along X, Y, and Z axes.", UpEffect = "Helpful for recentering off-origin scans to (0,0,0).", DownEffect = "0,0,0 applies no offset.", Recommend = "Useful when aligning multiple merged scans." } },
        { "rotate", new BeginnerTipEntry { Title = "Rotate (Degrees)", Tag = "Transform", Summary = "Rotates the scene around X, Y, and Z axes.", UpEffect = "Fixes upside-down or tilted phone captures.", DownEffect = "0,0,0 keeps original orientation.", Recommend = "Phone scans often need ±90° or 180° on X." } },
        { "scale", new BeginnerTipEntry { Title = "Uniform Scale", Tag = "Transform", Summary = "Resizes the entire scene by a uniform multiplier.", UpEffect = ">1 enlarges; <1 shrinks (e.g. 0.5 halves size).", DownEffect = "1 keeps original scale.", Recommend = "Use to match target game engine units." } },
        { "box", new BeginnerTipEntry { Title = "Bounding Box Filter", Tag = "Crop", Summary = "Keeps only splats inside the min/max XYZ box.", UpEffect = "Larger box retains more surroundings.", DownEffect = "Tighter box crops away messy backgrounds.", Recommend = "Great for rooms and rectangular areas." } },
        { "sphere", new BeginnerTipEntry { Title = "Sphere Filter", Tag = "Crop", Summary = "Keeps only splats within a radius around a center point.", UpEffect = "Larger radius retains distant scenery.", DownEffect = "Smaller radius trims far edges cleanly.", Recommend = "Great for 360° or drone orbits." } },
        { "estOutput", new BeginnerTipEntry { Title = "Estimated Output Size", Tag = "Live Preview", Summary = "Estimated from input splat count, target format, keep %, and SH bands.", UpEffect = "Preview size savings immediately as you adjust sliders.", DownEffect = "Actual size varies slightly with scene complexity.", Recommend = "Switch presets or drag sliders to compare sizes." } },
        { "engine", new BeginnerTipEntry { Title = "Decoupled Engine Updater", Tag = "Mirrors", Summary = "Bundles v3.12.0 offline and pulls updates via China & global mirrors.", UpEffect = "Auto-fallback across npmmirror, Tencent, Huawei, and npmjs with SHA-512 check.", DownEffect = "One-click rollback to bundled version anytime.", Recommend = "Click to test mirror latency or pull the latest engine." } }
    };

    internal static BeginnerTipEntry Get(string key) {
        if (String.IsNullOrEmpty(key)) return null;
        var dict = I18n.Language == "zh" ? Zh : En;
        BeginnerTipEntry e;
        return dict.TryGetValue(key, out e) ? e : null;
    }
}

sealed class BeginnerTipPopup : Form {
    BeginnerTipEntry current;
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08000000 | 0x00000008 | 0x00000080;
            return cp;
        }
    }

    internal BeginnerTipPopup() {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        DoubleBuffered = true;
        Size = new Size(344, 178);
    }

    internal void ShowFor(string key, Control anchor) {
        if (anchor == null || !anchor.IsHandleCreated) { Hide(); return; }
        var pt = anchor.PointToScreen(Point.Empty);
        ShowForRect(key, new Rectangle(pt.X, pt.Y, anchor.Width, anchor.Height));
    }

    internal void ShowForRect(string key, Rectangle anchorScreenRect) {
        var entry = BeginnerTips.Get(key);
        if (entry == null) { Hide(); return; }
        current = entry;
        Size = MeasureSize(entry);
        var area = Screen.FromRectangle(anchorScreenRect).WorkingArea;
        int x = Math.Max(area.Left + 8, Math.Min(area.Right - Width - 8, anchorScreenRect.Left));
        int y = (anchorScreenRect.Bottom + 6 + Height > area.Bottom - 8)
            ? Math.Max(area.Top + 8, anchorScreenRect.Top - Height - 6)
            : anchorScreenRect.Bottom + 6;
        Location = new Point(x, y);
        if (!Visible) Show();
        Invalidate();
    }

    string UpPrefix { get { return I18n.Language == "zh" ? "调大/开启：" : "Higher / On: "; } }
    string DownPrefix { get { return I18n.Language == "zh" ? "调小/关闭：" : "Lower / Off: "; } }
    string RecPrefix { get { return I18n.Language == "zh" ? "新手建议：" : "Tip: "; } }

    Size MeasureSize(BeginnerTipEntry e) {
        int w = 348, inner = w - 28;
        using (var g = CreateGraphics())
        using (var fBody = new Font("Microsoft YaHei UI", 8.5f)) {
            int h1 = TextRenderer.MeasureText(g, e.Summary, fBody, new Size(inner, 999), TextFormatFlags.WordBreak).Height;
            int h2 = TextRenderer.MeasureText(g, UpPrefix + e.UpEffect, fBody, new Size(inner - 14, 999), TextFormatFlags.WordBreak).Height;
            int h3 = TextRenderer.MeasureText(g, DownPrefix + e.DownEffect, fBody, new Size(inner - 14, 999), TextFormatFlags.WordBreak).Height;
            int h4 = TextRenderer.MeasureText(g, RecPrefix + e.Recommend, fBody, new Size(inner, 999), TextFormatFlags.WordBreak).Height;
            return new Size(w, 42 + h1 + 14 + h2 + h3 + 16 + h4 + 18);
        }
    }

    protected override void OnPaint(PaintEventArgs e) {
        if (current == null) return;
        var p = Theme.Current;
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = Theme.RoundedRect(rect, 10))
        using (var bg = new SolidBrush(p.CardBg))
        using (var border = new Pen(p.BorderStrong, 1f)) {
            g.FillPath(bg, path); g.DrawPath(border, path);
        }
        int pad = 14, inner = Width - pad * 2, y = 12;
        using (var fTitle = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold))
        using (var fTag = new Font("Microsoft YaHei UI", 7.5f, FontStyle.Bold))
        using (var fBody = new Font("Microsoft YaHei UI", 8.5f)) {
            TextRenderer.DrawText(g, current.Title, fTitle, new Rectangle(pad, y, inner - 76, 22), p.Ink, TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
            var tagSize = TextRenderer.MeasureText(g, current.Tag, fTag);
            var tagRect = new Rectangle(Width - pad - tagSize.Width - 10, y, tagSize.Width + 10, 19);
            using (var tp = Theme.RoundedRect(tagRect, 5))
            using (var tb = new SolidBrush(p.AccentSoft)) g.FillPath(tb, tp);
            TextRenderer.DrawText(g, current.Tag, fTag, tagRect, p.Accent, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            y += 26;

            int h1 = TextRenderer.MeasureText(g, current.Summary, fBody, new Size(inner, 999), TextFormatFlags.WordBreak).Height;
            TextRenderer.DrawText(g, current.Summary, fBody, new Rectangle(pad, y, inner, h1 + 4), p.Text2, TextFormatFlags.WordBreak);
            y += h1 + 8;

            string up = UpPrefix + current.UpEffect;
            string dn = DownPrefix + current.DownEffect;
            int h2 = TextRenderer.MeasureText(g, up, fBody, new Size(inner - 14, 999), TextFormatFlags.WordBreak).Height;
            int h3 = TextRenderer.MeasureText(g, dn, fBody, new Size(inner - 14, 999), TextFormatFlags.WordBreak).Height;
            var box = new Rectangle(pad, y, inner, h2 + h3 + 16);
            using (var bp = Theme.RoundedRect(box, 6))
            using (var bb = new SolidBrush(p.SubCardBg)) g.FillPath(bb, bp);
            TextRenderer.DrawText(g, up, fBody, new Rectangle(pad + 7, y + 6, inner - 14, h2 + 2), p.Text2, TextFormatFlags.WordBreak);
            TextRenderer.DrawText(g, dn, fBody, new Rectangle(pad + 7, y + 10 + h2, inner - 14, h3 + 2), p.Text2, TextFormatFlags.WordBreak);
            y = box.Bottom + 8;

            TextRenderer.DrawText(g, RecPrefix + current.Recommend, fBody, new Rectangle(pad, y, inner, Height - y - 8), p.Accent, TextFormatFlags.WordBreak);
        }
    }
}

sealed class TelemetryChartPopup : Form {
    string metricKey = "cpu";
    TelemetrySnapshot snapshot;
    ResourceSnapshot latestResources;

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08000000 | 0x00000008 | 0x00000080;
            return cp;
        }
    }

    internal TelemetryChartPopup() {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        DoubleBuffered = true;
        Size = new Size(466, 278);
    }

    internal void UpdateData(string metric, TelemetrySnapshot snap, ResourceSnapshot latest, Control anchor) {
        metricKey = metric; snapshot = snap; latestResources = latest;
        if (anchor != null && anchor.IsHandleCreated) {
            var pt = anchor.PointToScreen(Point.Empty);
            var area = Screen.FromControl(anchor).WorkingArea;
            int x = Math.Max(area.Left + 8, Math.Min(area.Right - Width - 8, pt.X + anchor.Width / 2 - Width / 2));
            int y = Math.Max(area.Top + 8, pt.Y - Height - 8);
            Location = new Point(x, y);
        }
        if (!Visible) Show();
        Invalidate();
    }

    internal void RefreshIfVisible(TelemetrySnapshot snap, ResourceSnapshot latest) {
        snapshot = snap; latestResources = latest;
        if (Visible) Invalidate();
    }

    double ReadPct(TelemetrySample s) {
        if (metricKey == "cpu") return s.CpuPct;
        if (metricKey == "ram") return s.RamPct;
        if (metricKey == "gpu") return s.GpuPct;
        return s.VramPct;
    }

    string FormatVal(TelemetrySample s) {
        if (metricKey == "cpu") return s.CpuPct.ToString("0") + "%";
        if (metricKey == "ram") return s.RamUsedGiB.ToString("0.0", CultureInfo.InvariantCulture) + " GiB (" + s.RamPct.ToString("0") + "%)";
        if (metricKey == "gpu") return s.GpuPct.ToString("0") + "%";
        return s.VramUsedGiB.ToString("0.0", CultureInfo.InvariantCulture) + " GiB (" + s.VramPct.ToString("0") + "%)";
    }

    protected override void OnPaint(PaintEventArgs e) {
        var p = Theme.Current;
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        var outer = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = Theme.RoundedRect(outer, 12))
        using (var bg = new SolidBrush(p.CardBg))
        using (var border = new Pen(p.BorderStrong, 1f)) {
            g.FillPath(bg, path); g.DrawPath(border, path);
        }

        bool isZh = I18n.Language == "zh";
        string title = metricKey == "cpu" ? (isZh ? "CPU 占用历史曲线" : "CPU Usage History")
            : metricKey == "ram" ? (isZh ? "系统内存占用历史曲线" : "RAM Usage History")
            : metricKey == "gpu" ? (isZh ? "GPU 计算引擎历史曲线" : "GPU Engine History")
            : (isZh ? "专用显存（VRAM）历史曲线" : "Dedicated VRAM History");
        string hwDetail = "";
        if (latestResources != null) {
            if (metricKey == "cpu") hwDetail = latestResources.CpuName;
            else if (metricKey == "ram") hwDetail = Budget.GB(latestResources.TotalMemory) + " · " + I18n.T("available") + " " + Budget.GB(latestResources.AvailableMemory);
            else {
                var gpu = latestResources.Gpus.OrderByDescending(x => x.Usage ?? -1).FirstOrDefault();
                if (gpu != null) hwDetail = gpu.Name;
            }
        }
        string modeHint = snapshot != null && snapshot.Mode == TelemetryMode.Recording ? (isZh ? "0.5s 采样 · X轴自适应拉伸" : "0.5s · X-axis auto-stretching")
            : snapshot != null && snapshot.Mode == TelemetryMode.FrozenRun ? (isZh ? "上次压缩完整曲线已锁定 · 下次压缩刷新" : "Last run frozen · resets on next run")
            : (isZh ? "0.5s 高频采样 · 最近 60 秒" : "0.5s sampling · last 60s");

        using (var fTitle = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold))
        using (var fSub = new Font("Microsoft YaHei UI", 7.8f))
        using (var fBold = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold)) {
            TextRenderer.DrawText(g, title, fTitle, new Rectangle(14, 10, 260, 20), p.Ink, TextFormatFlags.Left);
            TextRenderer.DrawText(g, (String.IsNullOrWhiteSpace(hwDetail) ? "" : hwDetail + " · ") + modeHint, fSub, new Rectangle(14, 30, Width - 28, 18), p.Muted, TextFormatFlags.Left | TextFormatFlags.EndEllipsis);

            using (var penIdle = new Pen(p.ChartIdle, 2.2f))
            using (var penAct = new Pen(p.ChartActive, 2.2f)) {
                g.DrawLine(penIdle, Width - 142, 20, Width - 128, 20);
                TextRenderer.DrawText(g, I18n.T("chartIdle"), fSub, new Rectangle(Width - 126, 12, 50, 16), p.Text2);
                g.DrawLine(penAct, Width - 74, 20, Width - 60, 20);
                TextRenderer.DrawText(g, I18n.T("chartActive"), fSub, new Rectangle(Width - 58, 12, 50, 16), p.Text2);
            }

            var chartBox = new Rectangle(14, 52, Width - 28, 146);
            using (var cp = Theme.RoundedRect(chartBox, 8))
            using (var cb = new SolidBrush(p.SubCardBg))
            using (var cpen = new Pen(p.Border, 1f)) {
                g.FillPath(cb, cp); g.DrawPath(cpen, cp);
            }

            int padL = chartBox.Left + 34, padR = chartBox.Right - 10, padT = chartBox.Top + 14, padB = chartBox.Bottom - 20;
            int cw = Math.Max(10, padR - padL), ch = Math.Max(10, padB - padT);

            using (var gridPen = new Pen(p.ChartGrid, 1f)) {
                foreach (int pct in new[] { 0, 50, 100 }) {
                    float gy = padT + ch * (1f - pct / 100f);
                    g.DrawLine(gridPen, padL, gy, padR, gy);
                    TextRenderer.DrawText(g, pct + "%", fSub, new Rectangle(chartBox.Left + 2, (int)gy - 7, 32, 14), p.Muted, TextFormatFlags.Right);
                }
            }

            var pts = snapshot != null && snapshot.Points != null ? snapshot.Points : new TelemetrySample[0];
            if (pts.Length >= 2) {
                int startIdx = snapshot.StartIndex;
                var coords = new PointF[pts.Length];
                for (int i = 0; i < pts.Length; i++) {
                    float x = padL + (i / (float)(pts.Length - 1)) * cw;
                    float y = padT + ch * (1f - (float)(ReadPct(pts[i]) / 100d));
                    coords[i] = new PointF(x, y);
                }

                using (var idlePen = new Pen(p.ChartIdle, 2.0f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                using (var actPen = new Pen(p.ChartActive, 2.3f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                using (var idleFill = new SolidBrush(Color.FromArgb(30, p.ChartIdle)))
                using (var actFill = new SolidBrush(Color.FromArgb(42, p.ChartActive))) {
                    for (int i = 1; i < coords.Length; i++) {
                        bool isAct = startIdx >= 0 && (i - 1) >= startIdx;
                        var poly = new[] { coords[i - 1], coords[i], new PointF(coords[i].X, padB), new PointF(coords[i - 1].X, padB) };
                        g.FillPolygon(isAct ? actFill : idleFill, poly);
                        g.DrawLine(isAct ? actPen : idlePen, coords[i - 1], coords[i]);
                    }
                }

                if (startIdx >= 0 && startIdx < coords.Length) {
                    float mx = coords[startIdx].X;
                    using (var dashPen = new Pen(p.ChartActive, 1.3f) { DashStyle = DashStyle.Dash })
                        g.DrawLine(dashPen, mx, padT, mx, padB);
                    int labelX = (int)Math.Min(padR - 58, mx + 4);
                    TextRenderer.DrawText(g, I18n.T("chartStartMark"), fSub, new Rectangle(labelX, padT - 2, 62, 16), p.ChartActive);
                }

                double totalSec = Math.Max(0.5, (pts[pts.Length - 1].Timestamp - pts[0].Timestamp).TotalSeconds);
                TextRenderer.DrawText(g, "0s", fSub, new Rectangle(padL, padB + 2, 40, 15), p.Muted, TextFormatFlags.Left);
                TextRenderer.DrawText(g, totalSec.ToString("0.0", CultureInfo.InvariantCulture) + "s", fSub, new Rectangle(padR - 54, padB + 2, 54, 15), p.Muted, TextFormatFlags.Right);

                var lastPt = coords[coords.Length - 1];
                bool lastAct = startIdx >= 0 && (coords.Length - 1) > startIdx;
                using (var dot = new SolidBrush(lastAct ? p.ChartActive : p.ChartIdle))
                    g.FillEllipse(dot, lastPt.X - 3.5f, lastPt.Y - 3.5f, 7f, 7f);
            }

            int cardY = 208, cardW = (Width - 28 - 16) / 3, cardH = 54;
            string curText = pts.Length > 0 ? FormatVal(pts[pts.Length - 1]) : "--";
            string peakText = "--", idleAvgText = "--";
            if (pts.Length > 0) {
                int sIdx = snapshot.StartIndex;
                var actList = sIdx >= 0 ? pts.Skip(sIdx + 1).ToArray() : new TelemetrySample[0];
                if (actList.Length > 0) {
                    var peakSample = actList.OrderByDescending(x => ReadPct(x)).First();
                    peakText = FormatVal(peakSample);
                }
                var idleList = sIdx >= 0 ? pts.Take(sIdx + 1).ToArray() : pts;
                if (idleList.Length > 0) {
                    double avg = idleList.Average(x => ReadPct(x));
                    idleAvgText = avg.ToString("0") + "%";
                }
            }
            DrawStatCard(g, new Rectangle(14, cardY, cardW, cardH), I18n.T("chartCurrent"), curText, p.Ink, fSub, fBold);
            DrawStatCard(g, new Rectangle(14 + cardW + 8, cardY, cardW, cardH), I18n.T("chartPeak"), peakText, p.ChartActive, fSub, fBold);
            DrawStatCard(g, new Rectangle(14 + (cardW + 8) * 2, cardY, cardW, cardH), I18n.T("chartIdleAvg"), idleAvgText, p.ChartIdle, fSub, fBold);
        }
    }

    void DrawStatCard(Graphics g, Rectangle rect, string label, string val, Color valColor, Font fSub, Font fBold) {
        var p = Theme.Current;
        using (var path = Theme.RoundedRect(rect, 7))
        using (var bg = new SolidBrush(p.SubCardBg))
        using (var pen = new Pen(p.Border, 1f)) {
            g.FillPath(bg, path); g.DrawPath(pen, path);
        }
        TextRenderer.DrawText(g, label, fSub, new Rectangle(rect.X + 4, rect.Y + 6, rect.Width - 8, 16), p.Muted, TextFormatFlags.HorizontalCenter);
        TextRenderer.DrawText(g, val, fBold, new Rectangle(rect.X + 4, rect.Y + 25, rect.Width - 8, 22), valColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.EndEllipsis);
    }
}

sealed class EngineUpdateDialog : Form {
    readonly Label currentLabel = new Label { AutoSize = true };
    readonly Label statusLabel = new Label { AutoSize = false, Height = 38 };
    readonly FluentDropdown mirrorBox = new FluentDropdown { Width = 360 };
    readonly TextBox logBox = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill };
    readonly FluentButton btnCheck = new FluentButton { Width = 120, Height = 34 };
    readonly FluentButton btnPull = new FluentButton { Width = 132, Height = 34, Primary = true, Enabled = false };
    readonly FluentButton btnRollback = new FluentButton { Width = 128, Height = 34 };
    readonly Action onVersionChanged;
    EngineCheckResult lastCheck;
    CancellationTokenSource cts;

    internal EngineUpdateDialog(Form owner, Action onChanged) {
        onVersionChanged = onChanged;
        var p = Theme.Current;
        Text = I18n.T("engineUpdate");
        Font = owner.Font; Icon = owner.Icon;
        BackColor = p.WindowBg; ForeColor = p.Ink;
        ClientSize = new Size(600, 476);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = MaximizeBox = false;
        Padding = new Padding(18);

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6 };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 82));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));

        var creditCard = new CardPanel { UseSubCard = true, Radius = 9, Dock = DockStyle.Fill, Padding = new Padding(14, 9, 14, 9), Margin = new Padding(0, 0, 0, 8) };
        var creditText = new Label { Dock = DockStyle.Top, Height = 36, ForeColor = p.Text2, BackColor = p.SubCardBg, Text = I18n.T("engineCredit") };
        var creditLink = new LinkLabel {
            Dock = DockStyle.Bottom, Height = 20, LinkColor = p.Accent, ActiveLinkColor = p.AccentHover, BackColor = p.SubCardBg, AutoEllipsis = true,
            Text = I18n.T("upstreamLink") + App.UpstreamRepository
        };
        creditLink.LinkClicked += (s, e) => {
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(App.UpstreamRepository) { UseShellExecute = true }); } catch { }
        };
        creditCard.Controls.Add(creditText);
        creditCard.Controls.Add(creditLink);
        root.Controls.Add(creditCard, 0, 0);

        RefreshHeader();
        root.Controls.Add(currentLabel, 0, 1);

        var mirrorRow = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        mirrorRow.Controls.Add(new Label { Text = I18n.T("engineMirrors") + ":", AutoSize = true, Margin = new Padding(0, 8, 8, 0), ForeColor = p.Text2 });
        mirrorBox.SetItems(EngineManager.Mirrors.Select(m => (object)m.Name), 0);
        mirrorRow.Controls.Add(mirrorBox);
        root.Controls.Add(mirrorRow, 0, 2);

        statusLabel.Dock = DockStyle.Fill; statusLabel.ForeColor = p.Accent;
        statusLabel.Text = I18n.Language == "zh"
            ? "引擎已解耦存放于 LocalAppData，支持国内多镜像直连拉取新版 @playcanvas/splat-transform。"
            : "Engine is decoupled in LocalAppData; pull updates with SHA-512 verification and one-click rollback.";
        root.Controls.Add(statusLabel, 0, 3);

        logBox.BackColor = p.LogBg; logBox.ForeColor = p.Text2; logBox.BorderStyle = BorderStyle.FixedSingle;
        logBox.Font = new Font("Consolas", 8.5f);
        root.Controls.Add(logBox, 0, 4);

        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 10, 0, 0) };
        btnPull.Text = I18n.T("enginePull"); btnPull.Margin = new Padding(8, 0, 0, 0);
        btnCheck.Text = I18n.T("engineLatest"); btnCheck.Margin = new Padding(8, 0, 0, 0);
        btnRollback.Text = I18n.T("engineRollback");
        actions.Controls.Add(btnPull); actions.Controls.Add(btnCheck); actions.Controls.Add(btnRollback);
        root.Controls.Add(actions, 0, 5);

        Controls.Add(root);

        btnCheck.Click += (s, e) => DoCheck();
        btnPull.Click += (s, e) => DoPull();
        btnRollback.Click += (s, e) => DoRollback();
        HandleCreated += (s, e) => Theme.ApplyWindowChrome(this);
        FormClosing += (s, e) => { if (cts != null) cts.Cancel(); };
    }

    void RefreshHeader() {
        currentLabel.Text = "Active: v" + EngineManager.ActiveVersion + (EngineManager.IsUsingBundled ? " (Bundled)" : " (Updated)") + "   ·   Bundled: v" + EngineManager.BundledVersion;
        if (I18n.Language == "zh")
            currentLabel.Text = "当前运行引擎：v" + EngineManager.ActiveVersion + (EngineManager.IsUsingBundled ? "（内置兜底版）" : "（在线更新版）") + "   ·   内置版本：v" + EngineManager.BundledVersion;
    }

    void Append(string msg) {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(new Action(() => Append(msg))); return; }
        logBox.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + msg + "\r\n");
    }

    async void DoCheck() {
        btnCheck.Enabled = btnPull.Enabled = btnRollback.Enabled = false;
        statusLabel.Text = I18n.Language == "zh" ? "正在测速并检查国内镜像最新版本..." : "Checking mirrors for latest version...";
        string prefId = EngineManager.Mirrors[Math.Max(0, mirrorBox.SelectedIndex)].Id;
        Append("Connecting mirrors (preferred: " + prefId + ")...");
        try {
            var res = await Task.Run(() => EngineManager.CheckBestMirror(prefId));
            lastCheck = res;
            if (!res.Success) {
                statusLabel.Text = res.Error;
                Append("Error: " + res.Error);
            } else {
                Append("Mirror: " + res.MirrorName + " (" + res.LatencyMs + " ms), latest: v" + res.LatestVersion);
                statusLabel.Text = "v" + res.LatestVersion + " (" + res.MirrorName + ", " + res.LatencyMs + " ms)";
                btnPull.Enabled = true;
            }
        } finally { btnCheck.Enabled = btnRollback.Enabled = true; }
    }

    async void DoPull() {
        if (lastCheck == null || !lastCheck.Success) return;
        btnCheck.Enabled = btnPull.Enabled = btnRollback.Enabled = false;
        cts = new CancellationTokenSource();
        statusLabel.Text = "Pulling & verifying v" + lastCheck.LatestVersion + "...";
        try {
            string ver = await Task.Run(() => EngineManager.PullUpdate(lastCheck, cts.Token, Append));
            RefreshHeader();
            statusLabel.Text = (I18n.Language == "zh" ? "更新成功！已切换至引擎 v" : "Updated to engine v") + ver;
            if (onVersionChanged != null) onVersionChanged();
        } catch (Exception ex) {
            statusLabel.Text = ex.Message;
            Append("Failed: " + ex.Message);
        } finally { cts.Dispose(); cts = null; btnCheck.Enabled = btnRollback.Enabled = true; }
    }

    async void DoRollback() {
        btnCheck.Enabled = btnPull.Enabled = btnRollback.Enabled = false;
        cts = new CancellationTokenSource();
        try {
            await Task.Run(() => EngineManager.RollbackToBundled(cts.Token));
            RefreshHeader();
            statusLabel.Text = (I18n.Language == "zh" ? "已恢复至内置引擎 v" : "Restored bundled engine v") + EngineManager.BundledVersion;
            Append("Rolled back to bundled v" + EngineManager.BundledVersion);
            if (onVersionChanged != null) onVersionChanged();
        } catch (Exception ex) { statusLabel.Text = ex.Message; }
        finally { cts.Dispose(); cts = null; btnCheck.Enabled = btnRollback.Enabled = true; }
    }
}
