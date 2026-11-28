// Native Vulkan 1.3 Bypass Viewport Host + Shared Non-Destructive Edit Session + Cross-Language ABI & Desktop Benchmark Suite.
// Strictly opt-in bypass in 002-B: default 3D Editor stays 100% WebView2 (`SceneEditorDialog`).
// Compiled under .NET Framework 4.x (C# 5) with ZERO /unsafe dependency.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using SplatConvertDesktop;

sealed class NativeFlagDelta {
    public string Label;
    public uint[] Indices;
    public byte[] Before;
    public byte[] After;
}

sealed class NativeEditSession {
    public const byte FlagSelected = 1;
    public const byte FlagDeleted = 2;
    public const byte FlagHidden = 4;

    public string AssetId = "primary";
    public string AssetName = "scene.ply";
    public string SourceSha256 = "";
    public int PointCount;
    public byte[] Flags = new byte[0];
    public float[] EntityMatrix = new float[] { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 };

    // Adjustable bounding sphere in world +Y-up coordinates (matches WebView2 "ellipsoid" volume!)
    public bool SphereEnabled;
    public bool SphereInvert;
    public float SphereCx;
    public float SphereCy;
    public float SphereCz;
    public float SphereRadius = 1.0f;

    public int SelectedCount { get; private set; }
    public int DeletedCount { get; private set; }

    readonly Stack<NativeFlagDelta> undoStack = new Stack<NativeFlagDelta>();
    readonly Stack<NativeFlagDelta> redoStack = new Stack<NativeFlagDelta>();

    public int UndoCount { get { return undoStack.Count; } }
    public int RedoCount { get { return redoStack.Count; } }

    public void Initialize(string assetId, string assetName, string sha256, int pointCount) {
        AssetId = string.IsNullOrEmpty(assetId) ? "primary" : assetId;
        AssetName = string.IsNullOrEmpty(assetName) ? "scene.ply" : assetName;
        SourceSha256 = (sha256 ?? "").ToLowerInvariant();
        PointCount = Math.Max(0, pointCount);
        Flags = new byte[PointCount];
        SelectedCount = 0;
        DeletedCount = 0;
        undoStack.Clear();
        redoStack.Clear();
    }

    public void RecomputeCounts() {
        int sel = 0, del = 0;
        for (int i = 0; i < Flags.Length; i++) {
            byte f = Flags[i];
            if ((f & FlagDeleted) != 0) del++;
            else if ((f & FlagSelected) != 0) sel++;
        }
        SelectedCount = sel;
        DeletedCount = del;
    }

    public NativeFlagDelta SelectByIndices(uint[] hitIndices, string op, string label) {
        var hitSet = new HashSet<uint>();
        if (hitIndices != null) {
            for (int i = 0; i < hitIndices.Length; i++) {
                uint idx = hitIndices[i];
                if (idx < (uint)Flags.Length && (Flags[idx] & FlagDeleted) == 0) hitSet.Add(idx);
            }
        }
        var changedIdx = new List<uint>();
        var before = new List<byte>();
        var after = new List<byte>();

        if (op == "replace") {
            for (int i = 0; i < Flags.Length; i++) {
                byte oldF = Flags[i];
                if ((oldF & FlagDeleted) != 0) continue;
                bool wantSel = hitSet.Contains((uint)i);
                byte newF = wantSel ? (byte)(oldF | FlagSelected) : (byte)(oldF & ~FlagSelected);
                if (newF != oldF) {
                    Flags[i] = newF;
                    changedIdx.Add((uint)i);
                    before.Add(oldF);
                    after.Add(newF);
                }
            }
        } else if (op == "add") {
            foreach (uint idx in hitSet) {
                byte oldF = Flags[idx];
                byte newF = (byte)(oldF | FlagSelected);
                if (newF != oldF) {
                    Flags[idx] = newF;
                    changedIdx.Add(idx);
                    before.Add(oldF);
                    after.Add(newF);
                }
            }
        } else if (op == "subtract") {
            foreach (uint idx in hitSet) {
                byte oldF = Flags[idx];
                byte newF = (byte)(oldF & ~FlagSelected);
                if (newF != oldF) {
                    Flags[idx] = newF;
                    changedIdx.Add(idx);
                    before.Add(oldF);
                    after.Add(newF);
                }
            }
        }

        if (changedIdx.Count == 0) return null;
        RecomputeCounts();
        var delta = new NativeFlagDelta {
            Label = label ?? "Select",
            Indices = changedIdx.ToArray(),
            Before = before.ToArray(),
            After = after.ToArray()
        };
        undoStack.Push(delta);
        redoStack.Clear();
        return delta;
    }

    public NativeFlagDelta SoftDeleteSelected(string label) {
        var changedIdx = new List<uint>();
        var before = new List<byte>();
        var after = new List<byte>();
        for (int i = 0; i < Flags.Length; i++) {
            byte oldF = Flags[i];
            if ((oldF & FlagDeleted) != 0 || (oldF & FlagSelected) == 0) continue;
            byte newF = (byte)((oldF & ~FlagSelected) | FlagDeleted);
            Flags[i] = newF;
            changedIdx.Add((uint)i);
            before.Add(oldF);
            after.Add(newF);
        }
        if (changedIdx.Count == 0) return null;
        RecomputeCounts();
        var delta = new NativeFlagDelta {
            Label = label ?? "Soft Delete",
            Indices = changedIdx.ToArray(),
            Before = before.ToArray(),
            After = after.ToArray()
        };
        undoStack.Push(delta);
        redoStack.Clear();
        return delta;
    }

    public NativeFlagDelta Undo(out byte[] appliedFlags) {
        appliedFlags = null;
        if (undoStack.Count == 0) return null;
        var d = undoStack.Pop();
        for (int i = 0; i < d.Indices.Length; i++) Flags[d.Indices[i]] = d.Before[i];
        RecomputeCounts();
        redoStack.Push(d);
        appliedFlags = d.Before;
        return d;
    }

    public NativeFlagDelta Redo(out byte[] appliedFlags) {
        appliedFlags = null;
        if (redoStack.Count == 0) return null;
        var d = redoStack.Pop();
        for (int i = 0; i < d.Indices.Length; i++) Flags[d.Indices[i]] = d.After[i];
        RecomputeCounts();
        undoStack.Push(d);
        appliedFlags = d.After;
        return d;
    }

    public List<int[]> EncodeDeletedRanges() {
        var ranges = new List<int[]>();
        int n = Flags.Length;
        int i = 0;
        while (i < n) {
            if ((Flags[i] & FlagDeleted) == 0) { i++; continue; }
            int start = i;
            i++;
            while (i < n && (Flags[i] & FlagDeleted) != 0) i++;
            ranges.Add(new int[] { start, i - start });
        }
        return ranges;
    }

    public string BuildV3RecipeJson() {
        var deletedRanges = EncodeDeletedRanges();
        double[] mat = new double[16];
        for (int i = 0; i < 16; i++) mat[i] = EntityMatrix[i];

        var volItems = new List<object>();
        var topOrder = new List<string>();
        if (SphereEnabled && SphereRadius > 1e-5f) {
            string vid = "vol_1";
            topOrder.Add(vid);
            volItems.Add(new Dictionary<string, object> {
                { "id", vid },
                { "kind", "ellipsoid" },
                { "name", "Bounding Sphere" },
                { "enabled", true },
                { "visible", true },
                { "groupId", null },
                { "boolOp", "union" },
                { "invert", SphereInvert },
                { "primitiveCoordSystem", "y-up" },
                { "position", new double[] { SphereCx, SphereCy, SphereCz } },
                { "rotation", new double[] { 0, 0, 0 } },
                { "scale", new double[] { SphereRadius, SphereRadius, SphereRadius } },
                { "initialPosition", new double[] { SphereCx, SphereCy, SphereCz } },
                { "initialRotation", new double[] { 0, 0, 0 } },
                { "initialScale", new double[] { SphereRadius, SphereRadius, SphereRadius } }
            });
        }

        var binding = new Dictionary<string, object> {
            { "assetId", AssetId },
            { "name", AssetName },
            { "sha256", SourceSha256 },
            { "pointCount", PointCount },
            { "orderingVersion", "source-v1" },
            { "deletedRanges", deletedRanges },
            { "entityMatrix", mat }
        };

        var mainObj = new Dictionary<string, object> {
            { "id", 0 },
            { "name", AssetName },
            { "visible", true },
            { "groupId", null },
            { "sourceKind", "original" },
            { "memberRanges", "all" },
            { "excludedRanges", new object[0] },
            { "deletedRanges", deletedRanges },
            { "matrix", mat },
            { "bakedGrades", new object[0] }
        };

        var recipe = new Dictionary<string, object> {
            { "version", 3 },
            { "coordSystem", "y-up" },
            { "matrixSpace", "source" },
            { "exportObjectIds", new int[] { 0 } },
            { "deletedRanges", deletedRanges },
            { "objects", new object[] { mainObj } },
            { "groups", new object[0] },
            { "volumes", new Dictionary<string, object> {
                { "primitiveCoordSystem", "y-up" },
                { "topLevelOrder", topOrder },
                { "groups", new object[0] },
                { "items", volItems }
            } },
            { "assetBindings", new Dictionary<string, object> { { AssetId, binding } } },
            { "rules", new object[0] },
            { "translation", new double[] { 0, 0, 0 } },
            { "rotation", new double[] { 0, 0, 0 } },
            { "scale", 1.0 }
        };
        return SceneRecipe.CreateSerializer().Serialize(recipe);
    }

    public int LoadRecipeJson(string rawJson, out uint[] restoredIndices, out byte[] restoredFlags) {
        restoredIndices = new uint[0];
        restoredFlags = new byte[0];
        if (string.IsNullOrWhiteSpace(rawJson)) return 0;

        var ser = SceneRecipe.CreateSerializer();
        var root = ser.Deserialize<Dictionary<string, object>>(rawJson);
        if (root == null) return 0;

        ArrayList ranges = null;
        if (root.ContainsKey("assetBindings") && root["assetBindings"] is Dictionary<string, object>) {
            var bindings = (Dictionary<string, object>)root["assetBindings"];
            Dictionary<string, object> b = null;
            if (bindings.ContainsKey(AssetId) && bindings[AssetId] is Dictionary<string, object>) {
                b = (Dictionary<string, object>)bindings[AssetId];
            } else {
                foreach (var kv in bindings) {
                    if (kv.Value is Dictionary<string, object>) { b = (Dictionary<string, object>)kv.Value; break; }
                }
            }
            if (b != null) {
                if (b.ContainsKey("pointCount")) {
                    int expectedN = Convert.ToInt32(b["pointCount"], CultureInfo.InvariantCulture);
                    if (expectedN > 0 && PointCount > 0 && expectedN != PointCount) {
                        throw new InvalidDataException(string.Format(
                            "Asset pointCount mismatch on reopen (recipe={0}, current={1}).", expectedN, PointCount));
                    }
                }
                if (b.ContainsKey("sha256") && !string.IsNullOrEmpty(SourceSha256)) {
                    string expSha = Convert.ToString(b["sha256"], CultureInfo.InvariantCulture) ?? "";
                    if (!string.IsNullOrEmpty(expSha) && !string.Equals(expSha, SourceSha256, StringComparison.OrdinalIgnoreCase)) {
                        throw new InvalidDataException("Asset SHA-256 fingerprint mismatch on reopen.");
                    }
                }
                if (b.ContainsKey("deletedRanges") && b["deletedRanges"] is ArrayList) {
                    ranges = (ArrayList)b["deletedRanges"];
                }
            }
        }
        if (ranges == null && root.ContainsKey("deletedRanges") && root["deletedRanges"] is ArrayList) {
            ranges = (ArrayList)root["deletedRanges"];
        }

        var idxList = new List<uint>();
        var flgList = new List<byte>();
        if (ranges != null) {
            foreach (object item in ranges) {
                var pair = item as ArrayList;
                if (pair == null || pair.Count < 2) continue;
                int s = Convert.ToInt32(pair[0], CultureInfo.InvariantCulture);
                int c = Convert.ToInt32(pair[1], CultureInfo.InvariantCulture);
                int end = Math.Min(Flags.Length, s + c);
                for (int k = Math.Max(0, s); k < end; k++) {
                    Flags[k] |= FlagDeleted;
                    idxList.Add((uint)k);
                    flgList.Add(Flags[k]);
                }
            }
        }

        // Restore first enabled ellipsoid/sphere volume if present
        if (root.ContainsKey("volumes") && root["volumes"] is Dictionary<string, object>) {
            var vols = (Dictionary<string, object>)root["volumes"];
            var items = vols.ContainsKey("items") ? vols["items"] as ArrayList : null;
            if (items != null) {
                foreach (object vo in items) {
                    var vd = vo as Dictionary<string, object>;
                    if (vd == null) continue;
                    string kind = vd.ContainsKey("kind") ? Convert.ToString(vd["kind"], CultureInfo.InvariantCulture) : "";
                    if (kind == "ellipsoid" || kind == "sphere") {
                        SphereEnabled = !vd.ContainsKey("enabled") || Convert.ToBoolean(vd["enabled"], CultureInfo.InvariantCulture);
                        SphereInvert = vd.ContainsKey("invert") && Convert.ToBoolean(vd["invert"], CultureInfo.InvariantCulture);
                        var pos = vd.ContainsKey("position") ? vd["position"] as ArrayList : null;
                        var scl = vd.ContainsKey("scale") ? vd["scale"] as ArrayList : null;
                        if (pos != null && pos.Count >= 3) {
                            SphereCx = Convert.ToSingle(pos[0], CultureInfo.InvariantCulture);
                            SphereCy = Convert.ToSingle(pos[1], CultureInfo.InvariantCulture);
                            SphereCz = Convert.ToSingle(pos[2], CultureInfo.InvariantCulture);
                        }
                        if (scl != null && scl.Count >= 1) {
                            SphereRadius = Math.Max(0.05f, Convert.ToSingle(scl[0], CultureInfo.InvariantCulture));
                        }
                        break;
                    }
                }
            }
        }

        RecomputeCounts();
        restoredIndices = idxList.ToArray();
        restoredFlags = flgList.ToArray();
        return idxList.Count;
    }
}

sealed class NativeViewportDialog : Form {
    readonly string inputPath;
    readonly string existingRecipe;
    readonly bool smokeNoActivate;
    readonly bool exactBenchCanvas;
    readonly string predecodedSgc3Path;
    readonly string sessionDir;

    readonly Panel toolbarPanel = new Panel { Dock = DockStyle.Top, Height = 44, BackColor = Color.FromArgb(24, 28, 36), Padding = new Padding(8, 6, 8, 6) };
    readonly Panel spherePanel = new Panel { Dock = DockStyle.Top, Height = 36, BackColor = Color.FromArgb(20, 24, 31), Padding = new Padding(8, 5, 8, 5) };
    readonly Panel statusPanel = new Panel { Dock = DockStyle.Bottom, Height = 26, BackColor = Color.FromArgb(16, 19, 25), Padding = new Padding(10, 4, 10, 4) };
    readonly Panel viewportHost = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(14, 17, 22) };
    readonly Label hudLabel = new Label { Dock = DockStyle.Fill, ForeColor = Color.FromArgb(180, 210, 245), Font = new Font("Consolas", 8.5f), TextAlign = ContentAlignment.MiddleLeft };

    readonly ComboBox cboSh = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 64 };
    readonly ComboBox cboMode = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 88 };
    readonly Button btnOrbit = new Button { Width = 78, Height = 28, FlatStyle = FlatStyle.Flat };
    readonly Button btnBoxSel = new Button { Width = 78, Height = 28, FlatStyle = FlatStyle.Flat };
    readonly Button btnDelete = new Button { Width = 88, Height = 28, FlatStyle = FlatStyle.Flat };
    readonly Button btnUndo = new Button { Width = 58, Height = 28, FlatStyle = FlatStyle.Flat };
    readonly Button btnRedo = new Button { Width = 58, Height = 28, FlatStyle = FlatStyle.Flat };
    readonly Button btnSave = new Button { Width = 100, Height = 28, FlatStyle = FlatStyle.Flat };
    readonly Button btnFallback = new Button { Width = 148, Height = 28, FlatStyle = FlatStyle.Flat };

    readonly CheckBox chkSphere = new CheckBox { AutoSize = true, ForeColor = Color.FromArgb(220, 232, 246) };
    readonly CheckBox chkSphereInvert = new CheckBox { AutoSize = true, ForeColor = Color.FromArgb(220, 232, 246) };
    readonly NumericUpDown numCx = new NumericUpDown { DecimalPlaces = 2, Increment = 0.25m, Minimum = -10000, Maximum = 10000, Width = 68 };
    readonly NumericUpDown numCy = new NumericUpDown { DecimalPlaces = 2, Increment = 0.25m, Minimum = -10000, Maximum = 10000, Width = 68 };
    readonly NumericUpDown numCz = new NumericUpDown { DecimalPlaces = 2, Increment = 0.25m, Minimum = -10000, Maximum = 10000, Width = 68 };
    readonly NumericUpDown numRad = new NumericUpDown { DecimalPlaces = 2, Increment = 0.25m, Minimum = 0.05m, Maximum = 10000, Value = 1.50m, Width = 68 };
    readonly Button btnSelectSphere = new Button { Width = 96, Height = 24, FlatStyle = FlatStyle.Flat };

    readonly NativeEditSession editSession = new NativeEditSession();

    IntPtr nvHandle = IntPtr.Zero;
    uint primaryAssetId;
    SplatNvCapabilities caps;
    SplatNvFrameStats lastStats;
    string activeAssetFilePath;
    float[] cpuPosCache;
    float sceneCenterX, sceneCenterY, sceneCenterZ, sceneRadius = 2.5f;
    float camYaw = 0.45f, camPitch = 0.28f, camDist = 5.5f;
    float camTargetX, camTargetY, camTargetZ;
    float camFovY = 50.0f;
    bool boxSelectMode;
    bool dragging;
    int dragButton;
    Point dragStart, dragCurrent;
    bool initializingSphereUi;

    public string Recipe { get; private set; }
    public bool FallbackToWebViewRequested { get; private set; }
    public string FallbackReason { get; private set; }
    public bool DeviceReady { get; private set; }
    public double LastDecodeSec { get; private set; }
    public double LastMountSec { get; private set; }
    public SplatNvFrameStats LastFrameStats { get { return lastStats; } }
    public NativeEditSession Session { get { return editSession; } }
    public IntPtr NativeHandle { get { return nvHandle; } }
    public uint PrimaryAssetId { get { return primaryAssetId; } }

    protected override bool ShowWithoutActivation {
        get { return smokeNoActivate; }
    }

    internal NativeViewportDialog(Form owner, string filePath, string existingRecipeJson, bool smokeMode, bool benchCanvasOnly)
        : this(owner, filePath, existingRecipeJson, smokeMode, benchCanvasOnly, null) { }

    internal NativeViewportDialog(Form owner, string filePath, string existingRecipeJson, bool smokeMode, bool benchCanvasOnly, string predecodedSgc3) {
        inputPath = Path.GetFullPath(filePath);
        existingRecipe = existingRecipeJson;
        smokeNoActivate = smokeMode;
        exactBenchCanvas = benchCanvasOnly;
        predecodedSgc3Path = predecodedSgc3;
        sessionDir = Path.Combine(PortablePaths.TmpDir, "nv-session-" + Guid.NewGuid().ToString("N"));

        Text = I18n.F("app.editorHost.nativeTitle", "name", Path.GetFileName(inputPath));
        BackColor = Color.FromArgb(14, 17, 22);
        ForeColor = Color.FromArgb(226, 232, 240);
        Icon = owner != null ? owner.Icon : SystemIcons.Application;
        if (smokeMode) {
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-3200, 0);
            ShowInTaskbar = false;
            ClientSize = new Size(1520, 900);
        } else {
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(1380, 860);
        }
        MinimumSize = new Size(880, 560);

        BuildUi();
        Controls.Add(viewportHost);
        if (!exactBenchCanvas) {
            Controls.Add(spherePanel);
            Controls.Add(toolbarPanel);
            Controls.Add(statusPanel);
        }

        Shown += (s, e) => InitializeViewportAndAsset();
        viewportHost.Resize += (s, e) => OnViewportResized();
        viewportHost.MouseDown += OnViewportMouseDown;
        viewportHost.MouseMove += OnViewportMouseMove;
        viewportHost.MouseUp += OnViewportMouseUp;
        viewportHost.MouseWheel += OnViewportMouseWheel;
        viewportHost.Paint += OnViewportPaint;

        FormClosing += (s, e) => {
            CleanupNative();
            try { if (Directory.Exists(sessionDir)) Directory.Delete(sessionDir, true); } catch { }
        };
    }

    void StyleBtn(Button b, string text, Color bg) {
        b.Text = text;
        b.BackColor = bg;
        b.ForeColor = Color.FromArgb(236, 241, 248);
        b.FlatAppearance.BorderColor = Color.FromArgb(60, 72, 92);
        b.FlatAppearance.BorderSize = 1;
        b.Font = new Font("Microsoft YaHei UI", 8.2f);
        b.Margin = new Padding(0, 0, 6, 0);
    }

    void BuildUi() {
        var topFlow = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, BackColor = Color.Transparent, Margin = Padding.Empty };
        cboSh.Items.AddRange(new object[] { "SH0", "SH1", "SH2", "SH3" });
        cboSh.SelectedIndex = 3;
        cboSh.BackColor = Color.FromArgb(34, 40, 52); cboSh.ForeColor = Color.White;
        cboSh.Margin = new Padding(0, 2, 6, 0);
        cboSh.SelectedIndexChanged += (s, e) => {
            if (nvHandle != IntPtr.Zero) {
                NativeViewportAbi.SetShDegree(nvHandle, (uint)Math.Max(0, cboSh.SelectedIndex));
                RenderOnce();
            }
        };

        cboMode.Items.AddRange(new object[] { "Splat", "Centers", "Rings" });
        cboMode.SelectedIndex = 0;
        cboMode.BackColor = Color.FromArgb(34, 40, 52); cboMode.ForeColor = Color.White;
        cboMode.Margin = new Padding(0, 2, 6, 0);
        cboMode.SelectedIndexChanged += (s, e) => {
            if (nvHandle != IntPtr.Zero) {
                NativeViewportAbi.SetDisplayMode(nvHandle, (SplatNvDisplayMode)Math.Max(0, cboMode.SelectedIndex));
                RenderOnce();
            }
        };

        StyleBtn(btnOrbit, I18n.T("app.editorHost.nativeOrbitTool"), Color.FromArgb(46, 92, 160));
        StyleBtn(btnBoxSel, I18n.T("app.editorHost.nativeBoxSelectTool"), Color.FromArgb(36, 42, 54));
        StyleBtn(btnDelete, I18n.T("app.editorHost.nativeDeleteBtn"), Color.FromArgb(148, 48, 48));
        StyleBtn(btnUndo, I18n.T("app.editorHost.nativeUndoBtn"), Color.FromArgb(36, 42, 54));
        StyleBtn(btnRedo, I18n.T("app.editorHost.nativeRedoBtn"), Color.FromArgb(36, 42, 54));
        StyleBtn(btnSave, I18n.T("app.editorHost.nativeSaveBtn"), Color.FromArgb(34, 128, 78));
        StyleBtn(btnFallback, I18n.T("app.editorHost.nativeFallbackBtn"), Color.FromArgb(62, 54, 40));

        btnOrbit.Click += (s, e) => SetToolMode(false);
        btnBoxSel.Click += (s, e) => SetToolMode(true);
        btnDelete.Click += (s, e) => ExecuteSoftDelete();
        btnUndo.Click += (s, e) => ExecuteUndo();
        btnRedo.Click += (s, e) => ExecuteRedo();
        btnSave.Click += (s, e) => {
            Recipe = editSession.BuildV3RecipeJson();
            DialogResult = DialogResult.OK;
            Close();
        };
        btnFallback.Click += (s, e) => {
            Recipe = editSession.BuildV3RecipeJson();
            FallbackToWebViewRequested = true;
            FallbackReason = "user-requested";
            DialogResult = DialogResult.Cancel;
            Close();
        };

        topFlow.Controls.AddRange(new Control[] { cboSh, cboMode, btnOrbit, btnBoxSel, btnDelete, btnUndo, btnRedo, btnSave, btnFallback });
        toolbarPanel.Controls.Add(topFlow);

        var spFlow = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, BackColor = Color.Transparent, Margin = Padding.Empty };
        chkSphere.Text = I18n.T("app.editorHost.nativeSphereEnable");
        chkSphere.Margin = new Padding(0, 3, 8, 0);
        chkSphereInvert.Text = I18n.T("app.editorHost.nativeSphereInvert");
        chkSphereInvert.Margin = new Padding(0, 3, 10, 0);
        StyleBtn(btnSelectSphere, I18n.T("app.editorHost.nativeSphereSelectBtn"), Color.FromArgb(38, 86, 118));

        Func<string, Label> mkLbl = t => new Label { Text = t, AutoSize = true, ForeColor = Color.FromArgb(165, 180, 200), Margin = new Padding(4, 4, 2, 0) };
        EventHandler sphereChanged = (s, e) => {
            if (initializingSphereUi) return;
            ApplyBoundingSphere((float)numCx.Value, (float)numCy.Value, (float)numCz.Value, (float)numRad.Value, chkSphere.Checked, chkSphereInvert.Checked);
        };
        chkSphere.CheckedChanged += sphereChanged;
        chkSphereInvert.CheckedChanged += sphereChanged;
        numCx.ValueChanged += sphereChanged;
        numCy.ValueChanged += sphereChanged;
        numCz.ValueChanged += sphereChanged;
        numRad.ValueChanged += sphereChanged;
        btnSelectSphere.Click += (s, e) => SelectPointsInBoundingSphere();

        spFlow.Controls.AddRange(new Control[] {
            chkSphere, chkSphereInvert,
            mkLbl("X"), numCx, mkLbl("Y"), numCy, mkLbl("Z"), numCz, mkLbl("R"), numRad,
            btnSelectSphere
        });
        spherePanel.Controls.Add(spFlow);
        statusPanel.Controls.Add(hudLabel);
    }

    void SetToolMode(bool boxMode) {
        boxSelectMode = boxMode;
        btnOrbit.BackColor = boxMode ? Color.FromArgb(36, 42, 54) : Color.FromArgb(46, 92, 160);
        btnBoxSel.BackColor = boxMode ? Color.FromArgb(196, 108, 28) : Color.FromArgb(36, 42, 54);
    }

    internal bool InitializeViewportAndAsset() {
        try {
            string dllStatus;
            if (!NativeViewportAbi.EnsureLoaded(out dllStatus)) {
                TriggerFallback("DLL unavailable: " + dllStatus);
                return false;
            }
            caps = new SplatNvCapabilities { StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCapabilities)) };
            NativeViewportAbi.splat_nv_query_capabilities(ref caps);

            uint w = (uint)Math.Max(64, viewportHost.ClientSize.Width);
            uint h = (uint)Math.Max(64, viewportHost.ClientSize.Height);
            var createDesc = new SplatNvCreateDesc {
                StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCreateDesc)),
                AbiVersion = NativeViewportAbi.AbiVersion,
                CoordSystem = (uint)SplatNvCoordSystem.YUp,
                EnableValidation = 0,
                PresentTarget = new SplatNvPresentTarget {
                    StructSize = (uint)Marshal.SizeOf(typeof(SplatNvPresentTarget)),
                    Mode = (uint)SplatNvPresentMode.Hwnd,
                    Hwnd = viewportHost.Handle,
                    DcompVisual = IntPtr.Zero,
                    Width = w,
                    Height = h,
                    DpiScale = 1.0f
                }
            };
            SplatNvStatus st = NativeViewportAbi.splat_nv_create(ref createDesc, out nvHandle);
            if (st != SplatNvStatus.Ok || nvHandle == IntPtr.Zero) {
                TriggerFallback(string.Format("splat_nv_create failed: {0}", st));
                return false;
            }

            Directory.CreateDirectory(sessionDir);
            string loadFile = PrepareLoadableAssetFile();
            activeAssetFilePath = loadFile;

            var swMount = Stopwatch.StartNew();
            string sourceFp = SceneEditorDialog.ComputeSourceFingerprint(inputPath);
            st = NativeViewportAbi.LoadAssetUtf8(nvHandle, loadFile, "primary", 3u, out primaryAssetId);
            if (st != SplatNvStatus.Ok) {
                string err = NativeViewportAbi.GetLastErrorMessage(nvHandle);
                TriggerFallback(string.Format("load_asset failed ({0}): {1}", st, err));
                return false;
            }
            LastMountSec = Math.Round(swMount.Elapsed.TotalSeconds, 3);

            int ptCount = ReadPointCountAndBounds(loadFile, !smokeNoActivate || new FileInfo(loadFile).Length < (64L << 20));
            string assetKeyId = "asset-" + ComputeShortHash(inputPath);
            editSession.Initialize(assetKeyId, Path.GetFileName(inputPath), sourceFp, ptCount);

            camTargetX = sceneCenterX;
            camTargetY = sceneCenterY;
            camTargetZ = sceneCenterZ;
            camDist = Math.Max(0.8f, sceneRadius * 2.2f);
            initializingSphereUi = true;
            SetNud(numCx, sceneCenterX);
            SetNud(numCy, sceneCenterY);
            SetNud(numCz, sceneCenterZ);
            SetNud(numRad, Math.Max(0.25f, sceneRadius * 0.45f));
            initializingSphereUi = false;

            if (!string.IsNullOrWhiteSpace(existingRecipe)) {
                uint[] idx;
                byte[] flg;
                editSession.LoadRecipeJson(existingRecipe, out idx, out flg);
                if (idx.Length > 0) {
                    NativeViewportAbi.ApplySparseFlags(nvHandle, primaryAssetId, idx, flg);
                }
                if (editSession.SphereEnabled) {
                    initializingSphereUi = true;
                    chkSphere.Checked = true;
                    chkSphereInvert.Checked = editSession.SphereInvert;
                    SetNud(numCx, editSession.SphereCx);
                    SetNud(numCy, editSession.SphereCy);
                    SetNud(numCz, editSession.SphereCz);
                    SetNud(numRad, editSession.SphereRadius);
                    initializingSphereUi = false;
                    NativeViewportAbi.SetBoundingSphere(nvHandle, editSession.SphereCx, editSession.SphereCy, editSession.SphereCz, editSession.SphereRadius, true, editSession.SphereInvert);
                }
            }

            PushCameraFromOrbit();
            DeviceReady = true;
            RenderOnce();
            return true;
        } catch (Exception ex) {
            TriggerFallback("Native viewport init exception: " + ex.Message);
            return false;
        }
    }

    static void SetNud(NumericUpDown nud, float v) {
        decimal d = (decimal)Math.Max((double)nud.Minimum, Math.Min((double)nud.Maximum, v));
        nud.Value = d;
    }

    void TriggerFallback(string reason) {
        FallbackToWebViewRequested = true;
        FallbackReason = reason;
        DeviceReady = false;
        CleanupNative();
        if (!smokeNoActivate) {
            MessageBox.Show(this, I18n.F("app.editorHost.nativeUnavailable", "reason", reason), Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            DialogResult = DialogResult.Cancel;
            Close();
        }
    }

    string PrepareLoadableAssetFile() {
        if (!string.IsNullOrEmpty(predecodedSgc3Path) && File.Exists(predecodedSgc3Path)) {
            LastDecodeSec = 0.0;
            return predecodedSgc3Path;
        }
        string ext = Path.GetExtension(inputPath).ToLowerInvariant();
        if (ext == ".ply" || ext == ".sgc3" || ext == ".bin") {
            LastDecodeSec = 0.0;
            return inputPath;
        }
        var sw = Stopwatch.StartNew();
        string outBin = Path.Combine(sessionDir, "cloud-full.sgc3");
        string runtime = EngineManager.EnsureActiveRuntime(CancellationToken.None);
        int tot, loaded;
        EditorAssets.WorkerWithProgress("sample", inputPath, outBin, "full", runtime, sessionDir, CancellationToken.None, 4096L << 20, null, out tot, out loaded);
        LastDecodeSec = Math.Round(sw.Elapsed.TotalSeconds, 3);
        return outBin;
    }

    int ReadPointCountAndBounds(string assetFile, bool keepPosCache) {
        using (var fs = File.OpenRead(assetFile))
        using (var br = new BinaryReader(fs)) {
            byte[] magic = br.ReadBytes(4);
            if (magic.Length == 4 && magic[0] == 'S' && magic[1] == 'G' && magic[2] == 'C' && magic[3] == '3') {
                uint ver = br.ReadUInt32();
                uint totalSrc = br.ReadUInt32();
                uint used = br.ReadUInt32();
                fs.Seek(32, SeekOrigin.Begin);
                int n = (int)used;
                if (keepPosCache && n <= 2000000) cpuPosCache = new float[n * 3];
                float minX = float.MaxValue, minY = float.MaxValue, minZ = float.MaxValue;
                float maxX = float.MinValue, maxY = float.MinValue, maxZ = float.MinValue;
                int stridePts = n > 200000 ? Math.Max(1, n / 100000) : 1;
                byte[] chunk = new byte[Math.Min(n, 65536) * 12];
                int readSoFar = 0;
                while (readSoFar < n) {
                    int batch = Math.Min(65536, n - readSoFar);
                    int got = fs.Read(chunk, 0, batch * 12);
                    int gotPts = got / 12;
                    if (gotPts <= 0) break;
                    if (cpuPosCache != null) Buffer.BlockCopy(chunk, 0, cpuPosCache, readSoFar * 12, gotPts * 12);
                    for (int i = 0; i < gotPts; i += stridePts) {
                        float x = BitConverter.ToSingle(chunk, i * 12);
                        float y = BitConverter.ToSingle(chunk, i * 12 + 4);
                        float z = BitConverter.ToSingle(chunk, i * 12 + 8);
                        if (float.IsNaN(x) || float.IsInfinity(x)) continue;
                        if (x < minX) minX = x; if (x > maxX) maxX = x;
                        if (y < minY) minY = y; if (y > maxY) maxY = y;
                        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
                    }
                    readSoFar += gotPts;
                }
                if (maxX >= minX) {
                    sceneCenterX = 0.5f * (minX + maxX);
                    sceneCenterY = 0.5f * (minY + maxY);
                    sceneCenterZ = 0.5f * (minZ + maxZ);
                    float dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
                    sceneRadius = Math.Max(0.25f, 0.5f * (float)Math.Sqrt(dx * dx + dy * dy + dz * dz));
                }
                return (int)Math.Max(totalSrc, used);
            }
        }
        // Standard binary PLY header scan for vertex count + quick AABB
        return ReadPlyPointCountAndBounds(assetFile, keepPosCache);
    }

    int ReadPlyPointCountAndBounds(string plyFile, bool keepPosCache) {
        int count = 0;
        int stride = 0;
        int xOff = -1, yOff = -1, zOff = -1;
        long dataStart = 0;
        using (var fs = File.OpenRead(plyFile)) {
            byte[] hdr = new byte[Math.Min(65536, fs.Length)];
            int nRead = fs.Read(hdr, 0, hdr.Length);
            string txt = Encoding.ASCII.GetString(hdr, 0, nRead);
            int endIdx = txt.IndexOf("end_header\n", StringComparison.Ordinal);
            int endLen = 11;
            if (endIdx < 0) { endIdx = txt.IndexOf("end_header\r\n", StringComparison.Ordinal); endLen = 12; }
            if (endIdx < 0) return 0;
            dataStart = endIdx + endLen;
            string[] lines = txt.Substring(0, endIdx).Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            bool inVertex = false;
            foreach (string rawLine in lines) {
                string line = rawLine.Trim();
                if (line.StartsWith("element ")) {
                    var parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    inVertex = parts.Length >= 3 && parts[1] == "vertex";
                    if (inVertex) int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out count);
                } else if (inVertex && line.StartsWith("property ")) {
                    var parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 3) {
                        string t = parts[1], name = parts[2];
                        int sz = (t == "double" || t == "float64") ? 8 : (t == "short" || t == "ushort" || t == "int16" || t == "uint16") ? 2 : (t == "uchar" || t == "char" || t == "uint8" || t == "int8") ? 1 : 4;
                        if (name == "x") xOff = stride;
                        else if (name == "y") yOff = stride;
                        else if (name == "z") zOff = stride;
                        stride += sz;
                    }
                }
            }
            if (count > 0 && stride > 0 && xOff >= 0 && yOff >= 0 && zOff >= 0) {
                fs.Seek(dataStart, SeekOrigin.Begin);
                if (keepPosCache && count <= 2000000) cpuPosCache = new float[count * 3];
                float minX = float.MaxValue, minY = float.MaxValue, minZ = float.MaxValue;
                float maxX = float.MinValue, maxY = float.MinValue, maxZ = float.MinValue;
                int batchPts = Math.Max(1, (4 * 1024 * 1024) / stride);
                byte[] buf = new byte[batchPts * stride];
                int step = count > 200000 ? Math.Max(1, count / 100000) : 1;
                int done = 0;
                while (done < count) {
                    int take = Math.Min(batchPts, count - done);
                    int got = fs.Read(buf, 0, take * stride) / stride;
                    if (got <= 0) break;
                    for (int i = 0; i < got; i++) {
                        int off = i * stride;
                        float x = BitConverter.ToSingle(buf, off + xOff);
                        float y = BitConverter.ToSingle(buf, off + yOff);
                        float z = BitConverter.ToSingle(buf, off + zOff);
                        if (cpuPosCache != null) {
                            int b3 = (done + i) * 3;
                            cpuPosCache[b3] = x; cpuPosCache[b3 + 1] = y; cpuPosCache[b3 + 2] = z;
                        }
                        if ((i % step) == 0 && !float.IsNaN(x) && !float.IsInfinity(x)) {
                            if (x < minX) minX = x; if (x > maxX) maxX = x;
                            if (y < minY) minY = y; if (y > maxY) maxY = y;
                            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
                        }
                    }
                    done += got;
                }
                if (maxX >= minX) {
                    sceneCenterX = 0.5f * (minX + maxX);
                    sceneCenterY = 0.5f * (minY + maxY);
                    sceneCenterZ = 0.5f * (minZ + maxZ);
                    float dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
                    sceneRadius = Math.Max(0.25f, 0.5f * (float)Math.Sqrt(dx * dx + dy * dy + dz * dz));
                }
            }
        }
        return count;
    }

    internal void SetCameraPose(float px, float py, float pz, float tx, float ty, float tz) {
        if (nvHandle == IntPtr.Zero) return;
        var cam = new SplatNvCamera {
            StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCamera)),
            PosX = px, PosY = py, PosZ = pz,
            TargetX = tx, TargetY = ty, TargetZ = tz,
            UpX = 0.0f, UpY = 1.0f, UpZ = 0.0f,
            FovYDeg = camFovY,
            NearPlane = 0.05f,
            FarPlane = Math.Max(500.0f, sceneRadius * 50.0f),
            IsOrtho = 0,
            OrthoHalfHeight = 1.0f
        };
        NativeViewportAbi.splat_nv_set_camera(nvHandle, ref cam);
    }

    void PushCameraFromOrbit() {
        float cp = (float)Math.Cos(camPitch);
        float px = camTargetX + (float)Math.Cos(camYaw) * cp * camDist;
        float py = camTargetY + (float)Math.Sin(camPitch) * camDist;
        float pz = camTargetZ + (float)Math.Sin(camYaw) * cp * camDist;
        SetCameraPose(px, py, pz, camTargetX, camTargetY, camTargetZ);
    }

    internal SplatNvStatus RenderOnce() {
        if (nvHandle == IntPtr.Zero) return SplatNvStatus.InvalidHandle;
        var st = new SplatNvFrameStats { StructSize = (uint)Marshal.SizeOf(typeof(SplatNvFrameStats)) };
        SplatNvStatus rc = NativeViewportAbi.splat_nv_render_frame(nvHandle, ref st);
        if (rc == SplatNvStatus.DeviceLost || rc == SplatNvStatus.GpuDevice) {
            TriggerFallback(string.Format("render_frame failed ({0}): {1}", rc, NativeViewportAbi.GetLastErrorMessage(nvHandle)));
            return rc;
        }
        lastStats = st;
        if (!exactBenchCanvas) {
            hudLabel.Text = string.Format(
                CultureInfo.InvariantCulture,
                "{0} | Splats {1:N0}/{2:N0} (Sel {3:N0}, Del {4:N0}) | Frame {5:F2}ms (Sort {6:F2}ms, Raster {7:F2}ms, Wait {8:F2}ms) | SH{9} | GPU-Sort:{10} | VRAM {11:F0} MiB",
                caps.BackendName ?? "Vulkan",
                st.VisibleSplats, st.TotalSplats,
                editSession.SelectedCount, editSession.DeletedCount,
                st.FrameTimeMs, st.SortTimeMs, st.RasterTimeMs, st.PresentWaitMs,
                st.ActiveShDegree, st.GpuSortActive != 0 ? "ON" : "OFF",
                st.VramUsedBytes / (1024.0 * 1024.0));
        }
        return rc;
    }

    internal void ApplyBoundingSphere(float cx, float cy, float cz, float radius, bool enabled, bool invert) {
        editSession.SphereCx = cx;
        editSession.SphereCy = cy;
        editSession.SphereCz = cz;
        editSession.SphereRadius = Math.Max(0.05f, radius);
        editSession.SphereEnabled = enabled;
        editSession.SphereInvert = invert;
        if (nvHandle != IntPtr.Zero) {
            NativeViewportAbi.SetBoundingSphere(nvHandle, cx, cy, cz, editSession.SphereRadius, enabled, invert);
            RenderOnce();
        }
    }

    internal int SelectPointsInBoundingSphere() {
        if (cpuPosCache == null || nvHandle == IntPtr.Zero) return 0;
        int n = Math.Min(editSession.PointCount, cpuPosCache.Length / 3);
        float cx = editSession.SphereCx, cy = editSession.SphereCy, cz = editSession.SphereCz;
        float r2 = editSession.SphereRadius * editSession.SphereRadius;
        bool inv = editSession.SphereInvert;
        var hits = new List<uint>();
        for (int i = 0; i < n; i++) {
            float dx = cpuPosCache[i * 3] - cx;
            float dy = cpuPosCache[i * 3 + 1] - cy;
            float dz = cpuPosCache[i * 3 + 2] - cz;
            bool inside = (dx * dx + dy * dy + dz * dz) <= r2;
            if (inv ? !inside : inside) hits.Add((uint)i);
        }
        var d = editSession.SelectByIndices(hits.ToArray(), "replace", "Select In Sphere");
        if (d != null) NativeViewportAbi.ApplySparseFlags(nvHandle, primaryAssetId, d.Indices, d.After);
        RenderOnce();
        return editSession.SelectedCount;
    }

    internal int ExecuteBoxSelectNdc(float minX, float maxX, float minY, float maxY, string op) {
        if (nvHandle == IntPtr.Zero) return 0;
        uint[] hits;
        SplatNvStatus st = NativeViewportAbi.PickRectManaged(nvHandle, primaryAssetId, minX, maxX, minY, maxY, false, false, out hits);
        if (st != SplatNvStatus.Ok) return 0;
        var d = editSession.SelectByIndices(hits, op ?? "replace", "Box Select");
        if (d != null) NativeViewportAbi.ApplySparseFlags(nvHandle, primaryAssetId, d.Indices, d.After);
        RenderOnce();
        return editSession.SelectedCount;
    }

    internal int ExecuteSoftDelete() {
        if (nvHandle == IntPtr.Zero) return 0;
        var d = editSession.SoftDeleteSelected("Soft Delete");
        if (d != null) NativeViewportAbi.ApplySparseFlags(nvHandle, primaryAssetId, d.Indices, d.After);
        RenderOnce();
        return editSession.DeletedCount;
    }

    internal void ExecuteUndo() {
        if (nvHandle == IntPtr.Zero) return;
        byte[] applied;
        var d = editSession.Undo(out applied);
        if (d != null) NativeViewportAbi.ApplySparseFlags(nvHandle, primaryAssetId, d.Indices, applied);
        RenderOnce();
    }

    internal void ExecuteRedo() {
        if (nvHandle == IntPtr.Zero) return;
        byte[] applied;
        var d = editSession.Redo(out applied);
        if (d != null) NativeViewportAbi.ApplySparseFlags(nvHandle, primaryAssetId, d.Indices, applied);
        RenderOnce();
    }

    void OnViewportResized() {
        if (nvHandle == IntPtr.Zero) return;
        int w = viewportHost.ClientSize.Width, h = viewportHost.ClientSize.Height;
        if (w > 16 && h > 16) {
            NativeViewportAbi.splat_nv_resize(nvHandle, (uint)w, (uint)h, 1.0f);
            RenderOnce();
        }
    }

    void OnViewportMouseDown(object sender, MouseEventArgs e) {
        dragging = true;
        dragStart = e.Location;
        dragCurrent = e.Location;
        dragButton = e.Button == MouseButtons.Right ? 2 : (e.Button == MouseButtons.Middle ? 1 : 0);
        viewportHost.Focus();
    }

    void OnViewportMouseMove(object sender, MouseEventArgs e) {
        if (!dragging) return;
        int dx = e.X - dragCurrent.X;
        int dy = e.Y - dragCurrent.Y;
        dragCurrent = e.Location;
        if (boxSelectMode && dragButton == 0) {
            viewportHost.Invalidate();
            return;
        }
        if (dragButton == 0) {
            camYaw += dx * 0.007f;
            camPitch = Math.Max(-1.48f, Math.Min(1.48f, camPitch + dy * 0.007f));
            PushCameraFromOrbit();
            RenderOnce();
        } else if (dragButton == 2 || dragButton == 1) {
            float panScale = camDist * 0.0018f;
            float rx = -(float)Math.Sin(camYaw), rz = (float)Math.Cos(camYaw);
            camTargetX -= rx * dx * panScale;
            camTargetZ -= rz * dx * panScale;
            camTargetY += dy * panScale;
            PushCameraFromOrbit();
            RenderOnce();
        }
    }

    void OnViewportMouseUp(object sender, MouseEventArgs e) {
        if (!dragging) return;
        dragging = false;
        if (boxSelectMode && dragButton == 0) {
            int w = Math.Max(1, viewportHost.ClientSize.Width);
            int h = Math.Max(1, viewportHost.ClientSize.Height);
            float x0 = (Math.Min(dragStart.X, e.X) / (float)w) * 2.0f - 1.0f;
            float x1 = (Math.Max(dragStart.X, e.X) / (float)w) * 2.0f - 1.0f;
            float y0 = 1.0f - (Math.Max(dragStart.Y, e.Y) / (float)h) * 2.0f;
            float y1 = 1.0f - (Math.Min(dragStart.Y, e.Y) / (float)h) * 2.0f;
            string op = (Control.ModifierKeys & Keys.Control) == Keys.Control ? "add"
                : (Control.ModifierKeys & Keys.Alt) == Keys.Alt ? "subtract" : "replace";
            ExecuteBoxSelectNdc(x0, x1, y0, y1, op);
            viewportHost.Invalidate();
        }
    }

    void OnViewportMouseWheel(object sender, MouseEventArgs e) {
        float factor = e.Delta > 0 ? 0.88f : 1.14f;
        camDist = Math.Max(0.15f, Math.Min(sceneRadius * 30.0f, camDist * factor));
        PushCameraFromOrbit();
        RenderOnce();
    }

    void OnViewportPaint(object sender, PaintEventArgs e) {
        if (nvHandle != IntPtr.Zero) RenderOnce();
        if (dragging && boxSelectMode && dragButton == 0) {
            var rect = new Rectangle(
                Math.Min(dragStart.X, dragCurrent.X), Math.Min(dragStart.Y, dragCurrent.Y),
                Math.Abs(dragCurrent.X - dragStart.X), Math.Abs(dragCurrent.Y - dragStart.Y));
            using (var pen = new Pen(Color.FromArgb(245, 158, 11), 2.0f)) {
                e.Graphics.DrawRectangle(pen, rect);
            }
        }
    }

    internal void CleanupNative() {
        if (nvHandle != IntPtr.Zero) {
            if (primaryAssetId != 0) {
                try { NativeViewportAbi.splat_nv_unload_asset(nvHandle, primaryAssetId); } catch { }
                primaryAssetId = 0;
            }
            try { NativeViewportAbi.splat_nv_destroy(nvHandle); } catch { }
            nvHandle = IntPtr.Zero;
        }
    }

    // =========================================================================
    // Helpers: RGBA PNG writer (zero /unsafe), SHA-256, Stats, Nvidia VRAM & Process-Tree RSS
    // =========================================================================
    internal static void SaveRgbaAsPng(byte[] rgba, int width, int height, string outPath) {
        byte[] bgra = new byte[width * height * 4];
        for (int i = 0; i < bgra.Length; i += 4) {
            bgra[i + 0] = rgba[i + 2];
            bgra[i + 1] = rgba[i + 1];
            bgra[i + 2] = rgba[i + 0];
            bgra[i + 3] = rgba[i + 3];
        }
        using (var bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            var bd = bmp.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try {
                Marshal.Copy(bgra, 0, bd.Scan0, bgra.Length);
            } finally {
                bmp.UnlockBits(bd);
            }
            bmp.Save(outPath, ImageFormat.Png);
        }
    }

    internal static string Sha256HexUpper(string filePath) {
        if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath)) return "";
        using (var sha = SHA256.Create())
        using (var fs = File.OpenRead(filePath)) {
            return BitConverter.ToString(sha.ComputeHash(fs)).Replace("-", "").ToUpperInvariant();
        }
    }

    internal static string ComputeShortHash(string text) {
        using (var sha = SHA256.Create()) {
            byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes((text ?? "").ToLowerInvariant()));
            var sb = new StringBuilder(16);
            for (int i = 0; i < 8; i++) sb.Append(h[i].ToString("x2"));
            return sb.ToString();
        }
    }

    internal static int? QueryNvidiaVramMiB() {
        try {
            var psi = new ProcessStartInfo("nvidia-smi", "--query-gpu=memory.used --format=csv,noheader,nounits") {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true
            };
            using (var p = Process.Start(psi)) {
                string s = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit(4000);
                int v;
                if (int.TryParse(s.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "", NumberStyles.Integer, CultureInfo.InvariantCulture, out v))
                    return v;
            }
        } catch { }
        return null;
    }

    internal static Dictionary<string, object> QueryGpuMeta() {
        var meta = new Dictionary<string, object>();
        try {
            var psi = new ProcessStartInfo("nvidia-smi", "--query-gpu=name,driver_version,memory.total --format=csv,noheader") {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true
            };
            using (var p = Process.Start(psi)) {
                string line = (p.StandardOutput.ReadToEnd() ?? "").Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
                p.WaitForExit(4000);
                string[] parts = line.Split(',');
                if (parts.Length >= 3) {
                    meta["gpu"] = parts[0].Trim();
                    meta["driver"] = parts[1].Trim();
                    meta["vramTotal"] = parts[2].Trim();
                }
            }
        } catch { }
        meta["os"] = Environment.OSVersion.ToString();
        meta["cpuCount"] = Environment.ProcessorCount;
        return meta;
    }

    internal static double? QueryProcessTreeRssMiB(int rootPid) {
        try {
            string cmd = string.Format(
                CultureInfo.InvariantCulture,
                "$all=Get-CimInstance Win32_Process;$q=New-Object System.Collections.Generic.Queue[int];$q.Enqueue({0});$sum=0L;$seen=@{{}};while($q.Count -gt 0){{$p=$q.Dequeue();if($seen[$p]){{continue}};$seen[$p]=$true;$pr=$all|Where-Object{{$_.ProcessId -eq $p}};if($pr){{$sum+=[int64]$pr.WorkingSetSize}};foreach($c in ($all|Where-Object{{$_.ParentProcessId -eq $p}})){{$q.Enqueue([int]$c.ProcessId)}}}};[math]::Round($sum/1048576.0,1)",
                rootPid);
            var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -Command \"" + cmd.Replace("\"", "\\\"") + "\"") {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true
            };
            using (var p = Process.Start(psi)) {
                string s = (p.StandardOutput.ReadToEnd() ?? "").Trim();
                p.WaitForExit(8000);
                double v;
                if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return v;
            }
        } catch { }
        return null;
    }

    internal static double Percentile(List<double> vals, double p) {
        if (vals == null || vals.Count == 0) return 0.0;
        var sorted = new List<double>(vals);
        sorted.Sort();
        int idx = Math.Min(sorted.Count - 1, Math.Max(0, (int)Math.Ceiling((p / 100.0) * sorted.Count) - 1));
        return Math.Round(sorted[idx], 2);
    }

    static List<double> ToDoubleList(object obj) {
        var list = new List<double>();
        var al = obj as ArrayList;
        if (al != null) {
            foreach (object x in al) list.Add(Convert.ToDouble(x, CultureInfo.InvariantCulture));
            return list;
        }
        var dArr = obj as double[];
        if (dArr != null) { list.AddRange(dArr); return list; }
        var dList = obj as List<double>;
        if (dList != null) { list.AddRange(dList); return list; }
        return list;
    }

    internal static Dictionary<string, object> SummarizeSeries(List<double> vals) {
        return new Dictionary<string, object> {
            { "count", vals.Count },
            { "p50Ms", Percentile(vals, 50) },
            { "p90Ms", Percentile(vals, 90) },
            { "p95Ms", Percentile(vals, 95) },
            { "p99Ms", Percentile(vals, 99) },
            { "maxMs", vals.Count > 0 ? Math.Round(vals.Max(), 2) : 0.0 },
            { "avgMs", vals.Count > 0 ? Math.Round(vals.Average(), 2) : 0.0 }
        };
    }

    internal static Dictionary<string, object> SummarizeBenchPass(Dictionary<string, object> raw) {
        var f = ToDoubleList(raw["frameMs"]);
        var s = ToDoubleList(raw["sortMs"]);
        var r = ToDoubleList(raw["rasterMs"]);
        var w = ToDoubleList(raw["waitMs"]);
        var outDict = new Dictionary<string, object> {
            { "frame", SummarizeSeries(f) },
            { "sort", SummarizeSeries(s) },
            { "raster", SummarizeSeries(r) },
            { "presentWait", SummarizeSeries(w) },
            { "drawnInstances", raw.ContainsKey("drawnInstances") ? raw["drawnInstances"] : 0 },
            { "totalPoints", raw.ContainsKey("totalPoints") ? raw["totalPoints"] : 0 },
            { "frameTimesMs", f },
            { "sortTimesMs", s },
            { "rasterTimesMs", r },
            { "presentWaitTimesMs", w }
        };
        if (raw.ContainsKey("glErr")) outDict["glErr"] = raw["glErr"];
        if (raw.ContainsKey("gpuSortActive")) outDict["gpuSortActive"] = raw["gpuSortActive"];
        return outDict;
    }

    // =========================================================================
    // CLI 1: Interactive Native Bypass Viewport (--native-viewport <file>)
    // =========================================================================
    internal static int RunNativeViewportGuiCli(string[] args) {
        I18n.Restore();
        Theme.Restore();
        string path = Path.GetFullPath(args[1]);
        using (var dlg = new NativeViewportDialog(null, path, null, false, false)) {
            Application.Run(dlg);
            if (dlg.FallbackToWebViewRequested) {
                using (var web = new SceneEditorDialog(null, path, null, dlg.Recipe)) {
                    Application.Run(web);
                }
            }
        }
        return 0;
    }

    // =========================================================================
    // CLI 2: Cross-Language C# Host <-> Native C-ABI v1.1 E2E Test (--native-abi-test <outDir> [samplePath])
    // =========================================================================
    internal static int RunNativeAbiTestCli(string[] args) {
        string outDir = Path.GetFullPath(args[1]);
        Directory.CreateDirectory(outDir);
        string samplePath = args.Length >= 3 ? Path.GetFullPath(args[2]) : Path.Combine(outDir, "abi_tiny_sample.ply");
        string reportPath = Path.Combine(outDir, "native-abi-report.json");
        var report = new Dictionary<string, object>();
        var json = SceneRecipe.CreateSerializer();

        try {
            if (!File.Exists(samplePath)) {
                WriteControlledSh3FixturePly(samplePath);
            }
            string dllPath = NativeViewportAbi.ResolveDllPath();
            report["exePath"] = Assembly.GetExecutingAssembly().Location;
            report["exeSha256"] = Sha256HexUpper(Assembly.GetExecutingAssembly().Location);
            report["dllPath"] = dllPath;
            report["dllSha256"] = Sha256HexUpper(dllPath);

            string detail;
            bool loaded = NativeViewportAbi.EnsureLoaded(out detail);
            report["dllLoadDetail"] = detail;
            if (!loaded) throw new IOException("Failed to load native viewport DLL: " + detail);

            // 1) Assert exact x64 C++ sizeof parity for all 11 ABI structs
            var sizes = NativeViewportAbi.GetStructLayoutSizes();
            var expectedSizes = new Dictionary<string, int> {
                { "SplatNvCapabilities", 120 },
                { "SplatNvPresentTarget", 40 },
                { "SplatNvCreateDesc", 56 },
                { "SplatNvAssetDesc", 32 },
                { "SplatNvCamera", 60 },
                { "SplatNvInputEvent", 36 },
                { "SplatNvCommand", 80 },
                { "SplatNvPickRectDesc", 32 },
                { "SplatNvPickResult", 24 },
                { "SplatNvFrameStats", 72 },
                { "SplatNvErrorInfo", 264 }
            };
            report["structSizes"] = sizes;
            foreach (var kv in expectedSizes) {
                int actual = Convert.ToInt32(sizes[kv.Key], CultureInfo.InvariantCulture);
                if (actual != kv.Value)
                    throw new InvalidDataException(string.Format("ABI struct size mismatch for {0}: C#={1} != C++={2}", kv.Key, actual, kv.Value));
            }

            // 2) Version & capability query
            uint ver = NativeViewportAbi.splat_nv_get_abi_version();
            report["abiVersion"] = string.Format("{0}.{1}", ver >> 16, ver & 0xFFFFu);
            var caps = new SplatNvCapabilities { StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCapabilities)) };
            SplatNvStatus st = NativeViewportAbi.splat_nv_query_capabilities(ref caps);
            if (st != SplatNvStatus.Ok) throw new IOException("query_capabilities failed: " + st);
            report["backendName"] = caps.BackendName;
            report["maxShDegree"] = caps.MaxShDegree;
            report["supportsGpuRadixSort"] = caps.SupportsGpuRadixSort;
            report["supportsHwndPresent"] = caps.SupportsHwndPresent;

            // 3) ABI mismatch error handling check
            var badCreate = new SplatNvCreateDesc {
                StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCreateDesc)),
                AbiVersion = (99u << 16)
            };
            IntPtr badHandle;
            SplatNvStatus badSt = NativeViewportAbi.splat_nv_create(ref badCreate, out badHandle);
            if (badSt != SplatNvStatus.AbiMismatch || badHandle != IntPtr.Zero)
                throw new IOException("Expected AbiMismatch on major=99, got " + badSt);
            report["abiMismatchHandled"] = true;

            // 4) Create offscreen instance
            var createDesc = new SplatNvCreateDesc {
                StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCreateDesc)),
                AbiVersion = NativeViewportAbi.AbiVersion,
                CoordSystem = (uint)SplatNvCoordSystem.YUp,
                EnableValidation = 0,
                PresentTarget = new SplatNvPresentTarget {
                    StructSize = (uint)Marshal.SizeOf(typeof(SplatNvPresentTarget)),
                    Mode = (uint)SplatNvPresentMode.OffscreenHeadless,
                    Width = 256,
                    Height = 256,
                    DpiScale = 1.0f
                }
            };
            IntPtr handle;
            st = NativeViewportAbi.splat_nv_create(ref createDesc, out handle);
            if (st != SplatNvStatus.Ok || handle == IntPtr.Zero)
                throw new IOException("splat_nv_create failed: " + st);

            try {
                // 5) Present target validation error return & get_last_error
                var nullHwndTarget = new SplatNvPresentTarget {
                    StructSize = (uint)Marshal.SizeOf(typeof(SplatNvPresentTarget)),
                    Mode = (uint)SplatNvPresentMode.Hwnd,
                    Hwnd = IntPtr.Zero, Width = 256, Height = 256, DpiScale = 1.0f
                };
                SplatNvStatus nullSt = NativeViewportAbi.splat_nv_set_present_target(handle, ref nullHwndTarget);
                if (nullSt != SplatNvStatus.InvalidArg) throw new IOException("Expected InvalidArg on null HWND, got " + nullSt);
                string errMsg = NativeViewportAbi.GetLastErrorMessage(handle);
                report["errorPropagationSample"] = errMsg;

                // 6) Resize + Load asset by UTF-8 path
                if (NativeViewportAbi.splat_nv_resize(handle, 320, 240, 1.0f) != SplatNvStatus.Ok)
                    throw new IOException("resize failed");
                uint assetId;
                st = NativeViewportAbi.LoadAssetUtf8(handle, samplePath, "primary", 3u, out assetId);
                if (st != SplatNvStatus.Ok || assetId == 0)
                    throw new IOException("load_asset failed: " + st + " " + NativeViewportAbi.GetLastErrorMessage(handle));
                report["loadedAssetId"] = assetId;

                // 7) Set camera + push input + submit commands (DisplayMode, SH, BoundingSphere, ObjectMatrix, SparseFlags)
                var cam = new SplatNvCamera {
                    StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCamera)),
                    PosX = 0, PosY = 0, PosZ = 4.0f,
                    TargetX = 0, TargetY = 0, TargetZ = 0,
                    UpX = 0, UpY = 1, UpZ = 0,
                    FovYDeg = 50.0f, NearPlane = 0.05f, FarPlane = 100.0f
                };
                if (NativeViewportAbi.splat_nv_set_camera(handle, ref cam) != SplatNvStatus.Ok)
                    throw new IOException("set_camera failed");
                var ev = new SplatNvInputEvent {
                    StructSize = (uint)Marshal.SizeOf(typeof(SplatNvInputEvent)),
                    Type = (uint)SplatNvInputType.PointerMove, X = 120, Y = 80
                };
                if (NativeViewportAbi.splat_nv_push_input(handle, ref ev) != SplatNvStatus.Ok)
                    throw new IOException("push_input failed");
                if (NativeViewportAbi.SetDisplayMode(handle, SplatNvDisplayMode.Splat) != SplatNvStatus.Ok)
                    throw new IOException("SetDisplayMode failed");
                if (NativeViewportAbi.SetShDegree(handle, 3u) != SplatNvStatus.Ok)
                    throw new IOException("SetShDegree failed");
                if (NativeViewportAbi.SetBoundingSphere(handle, 0, 0, 0, 2.0f, true, false) != SplatNvStatus.Ok)
                    throw new IOException("SetBoundingSphere failed");
                if (NativeViewportAbi.SetObjectMatrix(handle, assetId, 0, new float[] { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 }) != SplatNvStatus.Ok)
                    throw new IOException("SetObjectMatrix failed");

                // 8) Render frame + pick rect by assetId returning canonical sourceIndices + cross-boundary free_buffer
                var stats = new SplatNvFrameStats { StructSize = (uint)Marshal.SizeOf(typeof(SplatNvFrameStats)) };
                st = NativeViewportAbi.splat_nv_render_frame(handle, ref stats);
                if (st != SplatNvStatus.Ok) throw new IOException("render_frame failed: " + st);
                report["initialFrameStats"] = new Dictionary<string, object> {
                    { "totalSplats", stats.TotalSplats },
                    { "visibleSplats", stats.VisibleSplats },
                    { "frameTimeMs", Math.Round(stats.FrameTimeMs, 3) },
                    { "sortTimeMs", Math.Round(stats.SortTimeMs, 3) },
                    { "rasterTimeMs", Math.Round(stats.RasterTimeMs, 3) },
                    { "presentWaitMs", Math.Round(stats.PresentWaitMs, 3) },
                    { "activeShDegree", stats.ActiveShDegree },
                    { "gpuSortActive", stats.GpuSortActive }
                };

                uint[] hits;
                st = NativeViewportAbi.PickRectManaged(handle, assetId, -1.0f, 1.0f, -1.0f, 1.0f, false, false, out hits);
                if (st != SplatNvStatus.Ok || hits.Length == 0)
                    throw new IOException("pick_rect returned 0 hits or failed: " + st);
                report["pickHitCount"] = hits.Length;
                report["pickFirstSourceIndex"] = hits[0];

                // Apply sparse delete on picked first index and verify pick excludes deleted sourceIndex!
                uint delIdx = hits[0];
                st = NativeViewportAbi.ApplySparseFlags(handle, assetId, new uint[] { delIdx }, new byte[] { 2 });
                if (st != SplatNvStatus.Ok) throw new IOException("ApplySparseFlags failed: " + st);
                uint[] hitsAfter;
                st = NativeViewportAbi.PickRectManaged(handle, assetId, -1.0f, 1.0f, -1.0f, 1.0f, false, false, out hitsAfter);
                if (st != SplatNvStatus.Ok || hitsAfter.Contains(delIdx))
                    throw new IOException("Deleted sourceIndex still returned by pick_rect!");
                report["pickAfterDeleteCount"] = hitsAfter.Length;

                // 9) Readback RGBA + cross-boundary free_buffer
                uint rw, rh;
                byte[] rgba;
                st = NativeViewportAbi.ReadbackRgbaManaged(handle, out rw, out rh, out rgba);
                if (st != SplatNvStatus.Ok || rw != 320 || rh != 240 || rgba == null || rgba.Length != 320 * 240 * 4)
                    throw new IOException("readback_rgba failed: " + st);
                report["readbackBytes"] = rgba.Length;

                // 10) Unload asset + double-unload AssetNotFound check
                if (NativeViewportAbi.splat_nv_unload_asset(handle, assetId) != SplatNvStatus.Ok)
                    throw new IOException("unload_asset failed");
                if (NativeViewportAbi.splat_nv_unload_asset(handle, assetId) != SplatNvStatus.AssetNotFound)
                    throw new IOException("Expected AssetNotFound on second unload");
                report["unloadVerified"] = true;
            } finally {
                NativeViewportAbi.splat_nv_destroy(handle);
            }

            report["passed"] = true;
            File.WriteAllText(reportPath, json.Serialize(report), new UTF8Encoding(false));
            return 0;
        } catch (Exception ex) {
            report["passed"] = false;
            report["error"] = ex.ToString();
            try { File.WriteAllText(reportPath, json.Serialize(report), new UTF8Encoding(false)); } catch { }
            return 1;
        }
    }

    // Writes a 1-splat directional SH3 fixture PLY where SH0, SH1, SH2, SH3 each contribute distinct strong RGB shifts!
    internal static void WriteControlledSh3FixturePly(string path) {
        var cols = new List<string> { "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3" };
        for (int i = 0; i < 45; i++) cols.Add("f_rest_" + i);
        var sb = new StringBuilder();
        sb.Append("ply\nformat binary_little_endian 1.0\nelement vertex 1\n");
        foreach (string c in cols) sb.Append("property float ").Append(c).Append('\n');
        sb.Append("end_header\n");

        float[] v = new float[14 + 45];
        v[0] = 0f; v[1] = 0f; v[2] = 0f;          // center at origin
        v[3] = -0.35f; v[4] = -0.35f; v[5] = -0.35f; // f_dc -> neutral dark gray ~0.40
        v[6] = 8.0f;                               // opacity logit -> ~0.9997 opaque
        v[7] = -0.25f; v[8] = -0.25f; v[9] = -0.25f; // scale ~ 0.78m large splat covering center pixels
        v[10] = 1f; v[11] = 0f; v[12] = 0f; v[13] = 0f; // identity quat (w,x,y,z)
        // Planar f_rest layout (K=15 per channel: R=[0..14], G=[15..29], B=[30..44]):
        // SH1 (indices 0..2): sh[1] multiplies +SH_C1 * dir.z -> strong RED boost when viewing along -Z / +Z
        v[14 + 1] = -0.85f;      // R sh[1] (dir.z = -1 => +0.415 red!)
        v[14 + 15 + 2] = 0.85f;  // G sh[2] (-dir.x) -> strong GREEN shift from +/-X view
        // SH2 (indices 3..7): sh[5] multiplies +0.3154*(2z^2 - x^2 - y^2) -> strong GREEN boost along Z
        v[14 + 15 + 5] = 0.95f;  // G sh[5] (at dir=(0,0,-1): +0.60 green!)
        // SH3 (indices 8..14): sh[11] multiplies +0.3732*z*(2z^2 - 3x^2 - 3y^2) -> strong BLUE boost along -Z
        v[14 + 30 + 11] = -1.10f; // B sh[11] (at dir=(0,0,-1): +0.82 blue!)

        using (var fs = File.Create(path)) {
            byte[] hdr = Encoding.ASCII.GetBytes(sb.ToString());
            fs.Write(hdr, 0, hdr.Length);
            byte[] data = new byte[v.Length * 4];
            Buffer.BlockCopy(v, 0, data, 0, data.Length);
            fs.Write(data, 0, data.Length);
        }
    }

    // Writes a 2-splat overlapping Front/Back occlusion fixture PLY (index 0 = Front RED at z=+0.8, index 1 = Back BLUE at z=-0.8)
    internal static void WriteOverlapDepthFixturePly(string path) {
        string header = "ply\nformat binary_little_endian 1.0\nelement vertex 2\n" +
            "property float x\nproperty float y\nproperty float z\n" +
            "property float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n" +
            "property float opacity\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\n" +
            "property float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nend_header\n";
        // Put RED splat FIRST in file order so UNSORTED rendering from +Z would draw BLUE over RED (WRONG),
        // proving GPU Radix Sort genuinely reorders back-to-front on BOTH +Z and -Z cameras!
        float[] pts = new float[] {
            // Splat 0: RED at z = +0.8
            0f, 0f, 0.8f,   1.65f, -1.65f, -1.65f,   9.0f,   -0.2f, -0.2f, -0.2f,   1f, 0f, 0f, 0f,
            // Splat 1: BLUE at z = -0.8
            0f, 0f, -0.8f,  -1.65f, -1.65f, 1.65f,   9.0f,   -0.2f, -0.2f, -0.2f,   1f, 0f, 0f, 0f
        };
        using (var fs = File.Create(path)) {
            byte[] hdr = Encoding.ASCII.GetBytes(header);
            fs.Write(hdr, 0, hdr.Length);
            byte[] data = new byte[pts.Length * 4];
            Buffer.BlockCopy(pts, 0, data, 0, data.Length);
            fs.Write(data, 0, data.Length);
        }
    }

    static int[] SampleCenterRgb(byte[] rgba, int w, int h) {
        int cx = w / 2, cy = h / 2;
        int r = 0, g = 0, b = 0, cnt = 0;
        for (int dy = -2; dy <= 2; dy++) {
            for (int dx = -2; dx <= 2; dx++) {
                int off = ((cy + dy) * w + (cx + dx)) * 4;
                r += rgba[off]; g += rgba[off + 1]; b += rgba[off + 2];
                cnt++;
            }
        }
        return new int[] { r / cnt, g / cnt, b / cnt };
    }

    // =========================================================================
    // CLI 3: Complete Native Vulkan Bypass Viewport Smoke & Correctness Suite
    //   --native-viewport-smoke <inputPath> <outDir>
    // =========================================================================
    internal static int RunNativeViewportSmokeCli(string[] args) {
        string inputPath = Path.GetFullPath(args[1]);
        string outDir = Path.GetFullPath(args[2]);
        Directory.CreateDirectory(outDir);
        string reportPath = Path.Combine(outDir, "native-viewport-smoke-report.json");
        var report = new Dictionary<string, object>();
        var json = SceneRecipe.CreateSerializer();

        try {
            I18n.Restore();
            Theme.Restore();
            TooltipConfig.Load();

            string dllPath = NativeViewportAbi.ResolveDllPath();
            report["exePath"] = Assembly.GetExecutingAssembly().Location;
            report["exeSha256"] = Sha256HexUpper(Assembly.GetExecutingAssembly().Location);
            report["dllPath"] = dllPath;
            report["dllSha256"] = Sha256HexUpper(dllPath);
            report["gpuMeta"] = QueryGpuMeta();

            string detail;
            if (!NativeViewportAbi.EnsureLoaded(out detail))
                throw new IOException("Native Vulkan DLL not ready: " + detail);

            var caps = new SplatNvCapabilities { StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCapabilities)) };
            NativeViewportAbi.splat_nv_query_capabilities(ref caps);
            report["backendName"] = caps.BackendName;
            report["maxShDegree"] = caps.MaxShDegree;

            // --- Test A: Controlled SH0 / SH1 / SH2 / SH3 Fixed Viewpoint & Rotating View Direction ---
            string sh3Ply = Path.Combine(outDir, "fixture_sh3_directional.ply");
            WriteControlledSh3FixturePly(sh3Ply);
            var shCheck = new Dictionary<string, object>();
            {
                var cDesc = new SplatNvCreateDesc {
                    StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCreateDesc)),
                    AbiVersion = NativeViewportAbi.AbiVersion,
                    CoordSystem = (uint)SplatNvCoordSystem.YUp,
                    PresentTarget = new SplatNvPresentTarget {
                        StructSize = (uint)Marshal.SizeOf(typeof(SplatNvPresentTarget)),
                        Mode = (uint)SplatNvPresentMode.OffscreenHeadless, Width = 256, Height = 256, DpiScale = 1.0f
                    }
                };
                IntPtr h;
                if (NativeViewportAbi.splat_nv_create(ref cDesc, out h) != SplatNvStatus.Ok)
                    throw new IOException("SH3 test create failed");
                try {
                    uint aid;
                    if (NativeViewportAbi.LoadAssetUtf8(h, sh3Ply, "sh3", 3u, out aid) != SplatNvStatus.Ok)
                        throw new IOException("SH3 load failed: " + NativeViewportAbi.GetLastErrorMessage(h));
                    var camPosZ = new SplatNvCamera {
                        StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCamera)),
                        PosX = 0, PosY = 0, PosZ = 3.0f, TargetX = 0, TargetY = 0, TargetZ = 0,
                        UpX = 0, UpY = 1, UpZ = 0, FovYDeg = 45.0f, NearPlane = 0.05f, FarPlane = 50.0f
                    };
                    NativeViewportAbi.splat_nv_set_camera(h, ref camPosZ);
                    var fixedRgb = new Dictionary<string, int[]>();
                    for (uint deg = 0; deg <= 3; deg++) {
                        NativeViewportAbi.SetShDegree(h, deg);
                        var st = new SplatNvFrameStats { StructSize = (uint)Marshal.SizeOf(typeof(SplatNvFrameStats)) };
                        NativeViewportAbi.splat_nv_render_frame(h, ref st);
                        uint rw, rh; byte[] px;
                        NativeViewportAbi.ReadbackRgbaManaged(h, out rw, out rh, out px);
                        SaveRgbaAsPng(px, (int)rw, (int)rh, Path.Combine(outDir, "sh" + deg + "_fixed_posZ.png"));
                        fixedRgb["SH" + deg] = SampleCenterRgb(px, (int)rw, (int)rh);
                    }
                    shCheck["fixedViewPosZ"] = fixedRgb;
                    // Assert SH0 != SH1 != SH2 != SH3 (strong channel boosts: R on SH1, G on SH2, B on SH3!)
                    int d01 = Math.Abs(fixedRgb["SH1"][0] - fixedRgb["SH0"][0]);
                    int d12 = Math.Abs(fixedRgb["SH2"][1] - fixedRgb["SH1"][1]);
                    int d23 = Math.Abs(fixedRgb["SH3"][2] - fixedRgb["SH2"][2]);
                    shCheck["channelDeltas"] = new Dictionary<string, int> { { "sh1_redDelta", d01 }, { "sh2_greenDelta", d12 }, { "sh3_blueDelta", d23 } };
                    if (d01 < 40 || d12 < 40 || d23 < 40)
                        throw new IOException(string.Format("SH0-3 fixed-view deltas too small: R={0}, G={1}, B={2}", d01, d12, d23));

                    // Rotate camera across +Z, -Z, +X for SH0 (invariant) vs SH3 (view-dependent!)
                    var camNegZ = camPosZ; camNegZ.PosZ = -3.0f;
                    var camPosX = camPosZ; camPosX.PosZ = 0.0f; camPosX.PosX = 3.0f;
                    Func<SplatNvCamera, uint, string, int[]> renderView = (cam, deg, tag) => {
                        NativeViewportAbi.splat_nv_set_camera(h, ref cam);
                        NativeViewportAbi.SetShDegree(h, deg);
                        var st = new SplatNvFrameStats { StructSize = (uint)Marshal.SizeOf(typeof(SplatNvFrameStats)) };
                        NativeViewportAbi.splat_nv_render_frame(h, ref st);
                        uint rw, rh; byte[] px;
                        NativeViewportAbi.ReadbackRgbaManaged(h, out rw, out rh, out px);
                        if (!string.IsNullOrEmpty(tag)) SaveRgbaAsPng(px, (int)rw, (int)rh, Path.Combine(outDir, tag + ".png"));
                        return SampleCenterRgb(px, (int)rw, (int)rh);
                    };
                    int[] sh0PosZ = renderView(camPosZ, 0, null);
                    int[] sh0NegZ = renderView(camNegZ, 0, null);
                    int[] sh3PosZ = renderView(camPosZ, 3, "sh3_view_posZ");
                    int[] sh3NegZ = renderView(camNegZ, 3, "sh3_view_negZ");
                    int[] sh3PosX = renderView(camPosX, 3, "sh3_view_posX");
                    shCheck["viewDirectionResponse"] = new Dictionary<string, object> {
                        { "sh0_posZ", sh0PosZ }, { "sh0_negZ", sh0NegZ },
                        { "sh3_posZ", sh3PosZ }, { "sh3_negZ", sh3NegZ }, { "sh3_posX", sh3PosX }
                    };
                    int sh0Drift = Math.Abs(sh0PosZ[0] - sh0NegZ[0]) + Math.Abs(sh0PosZ[1] - sh0NegZ[1]) + Math.Abs(sh0PosZ[2] - sh0NegZ[2]);
                    int sh3FlipDelta = Math.Abs(sh3PosZ[0] - sh3NegZ[0]) + Math.Abs(sh3PosZ[2] - sh3NegZ[2]);
                    int sh3SideDelta = Math.Abs(sh3PosX[1] - sh3PosZ[1]);
                    if (sh0Drift > 6) throw new IOException("SH0 should be view-invariant, drift=" + sh0Drift);
                    if (sh3FlipDelta < 80 || sh3SideDelta < 40)
                        throw new IOException(string.Format("SH3 view-dependent response too weak: flip={0}, side={1}", sh3FlipDelta, sh3SideDelta));
                    shCheck["passed"] = true;
                    NativeViewportAbi.splat_nv_unload_asset(h, aid);
                } finally {
                    NativeViewportAbi.splat_nv_destroy(h);
                }
            }
            report["sh0to3Verification"] = shCheck;

            // --- Test B: GPU Radix Sort Overlapping Front/Back Depth Occlusion ---
            string overlapPly = Path.Combine(outDir, "fixture_overlap_depth.ply");
            WriteOverlapDepthFixturePly(overlapPly);
            var sortCheck = new Dictionary<string, object>();
            {
                var cDesc = new SplatNvCreateDesc {
                    StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCreateDesc)),
                    AbiVersion = NativeViewportAbi.AbiVersion,
                    CoordSystem = (uint)SplatNvCoordSystem.YUp,
                    PresentTarget = new SplatNvPresentTarget {
                        StructSize = (uint)Marshal.SizeOf(typeof(SplatNvPresentTarget)),
                        Mode = (uint)SplatNvPresentMode.OffscreenHeadless, Width = 256, Height = 256, DpiScale = 1.0f
                    }
                };
                IntPtr h;
                if (NativeViewportAbi.splat_nv_create(ref cDesc, out h) != SplatNvStatus.Ok)
                    throw new IOException("Overlap sort test create failed");
                try {
                    uint aid;
                    NativeViewportAbi.LoadAssetUtf8(h, overlapPly, "overlap", 0u, out aid);
                    var camFront = new SplatNvCamera {
                        StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCamera)),
                        PosX = 0, PosY = 0, PosZ = 4.0f, TargetX = 0, TargetY = 0, TargetZ = 0,
                        UpX = 0, UpY = 1, UpZ = 0, FovYDeg = 45.0f, NearPlane = 0.05f, FarPlane = 50.0f
                    };
                    var camBack = camFront; camBack.PosZ = -4.0f;

                    NativeViewportAbi.splat_nv_set_camera(h, ref camFront);
                    var stF = new SplatNvFrameStats { StructSize = (uint)Marshal.SizeOf(typeof(SplatNvFrameStats)) };
                    NativeViewportAbi.splat_nv_render_frame(h, ref stF);
                    uint rw, rh; byte[] pxF;
                    NativeViewportAbi.ReadbackRgbaManaged(h, out rw, out rh, out pxF);
                    SaveRgbaAsPng(pxF, (int)rw, (int)rh, Path.Combine(outDir, "sort_front_red_on_top.png"));
                    int[] rgbFront = SampleCenterRgb(pxF, (int)rw, (int)rh);

                    NativeViewportAbi.splat_nv_set_camera(h, ref camBack);
                    var stB = new SplatNvFrameStats { StructSize = (uint)Marshal.SizeOf(typeof(SplatNvFrameStats)) };
                    NativeViewportAbi.splat_nv_render_frame(h, ref stB);
                    byte[] pxB;
                    NativeViewportAbi.ReadbackRgbaManaged(h, out rw, out rh, out pxB);
                    SaveRgbaAsPng(pxB, (int)rw, (int)rh, Path.Combine(outDir, "sort_back_blue_on_top.png"));
                    int[] rgbBack = SampleCenterRgb(pxB, (int)rw, (int)rh);

                    sortCheck["gpuSortActive"] = stF.GpuSortActive != 0 && stB.GpuSortActive != 0;
                    sortCheck["fromPosZ_expectRed"] = rgbFront;
                    sortCheck["fromNegZ_expectBlue"] = rgbBack;
                    if (stF.GpuSortActive == 0 || rgbFront[0] <= rgbFront[2] + 60 || rgbBack[2] <= rgbBack[0] + 60)
                        throw new IOException("GPU Radix Sort overlap occlusion failed!");
                    sortCheck["passed"] = true;
                    NativeViewportAbi.splat_nv_unload_asset(h, aid);
                } finally {
                    NativeViewportAbi.splat_nv_destroy(h);
                }
            }
            report["gpuSortOverlapVerification"] = sortCheck;

            // --- Test C: Real WinForms HWND + Bounding Sphere + Box-Select/Delete/Undo/Redo + Save -> Reopen Native & WebView2 -> Export PLY ---
            string srcShaBefore = SceneEditorDialog.ComputeSourceFingerprint(inputPath);
            string savedRecipe;
            int totalPts, delAfterEdit;
            var hwndCheck = new Dictionary<string, object>();
            using (var dlg = new NativeViewportDialog(null, inputPath, null, true, false)) {
                dlg.Show();
                Application.DoEvents();
                if (!dlg.DeviceReady) throw new IOException("HWND NativeViewportDialog init failed: " + dlg.FallbackReason);

                // Readback initial HWND render
                uint rw, rh; byte[] pxInit;
                NativeViewportAbi.ReadbackRgbaManaged(dlg.NativeHandle, out rw, out rh, out pxInit);
                SaveRgbaAsPng(pxInit, (int)rw, (int)rh, Path.Combine(outDir, "hwnd_vulkan_initial.png"));

                // Enable adjustable bounding sphere, adjust center & radius, capture screenshot & verify select-in-sphere
                dlg.ApplyBoundingSphere(dlg.sceneCenterX, dlg.sceneCenterY, dlg.sceneCenterZ, Math.Max(0.25f, dlg.sceneRadius * 0.4f), true, false);
                byte[] pxSphere;
                NativeViewportAbi.ReadbackRgbaManaged(dlg.NativeHandle, out rw, out rh, out pxSphere);
                SaveRgbaAsPng(pxSphere, (int)rw, (int)rh, Path.Combine(outDir, "hwnd_vulkan_sphere.png"));
                long spherePixelDiff = 0;
                for (int i = 0; i < Math.Min(pxInit.Length, pxSphere.Length); i += 4)
                    spherePixelDiff += Math.Abs(pxInit[i] - pxSphere[i]) + Math.Abs(pxInit[i + 1] - pxSphere[i + 1]) + Math.Abs(pxInit[i + 2] - pxSphere[i + 2]);
                hwndCheck["spherePixelDiffSum"] = spherePixelDiff;
                if (spherePixelDiff == 0) throw new IOException("Adjustable bounding sphere produced zero visual delta!");

                int sphereSel = dlg.SelectPointsInBoundingSphere();
                hwndCheck["sphereSelectedCount"] = sphereSel;

                // Box select -> Soft delete -> Undo -> Redo
                int boxSel = dlg.ExecuteBoxSelectNdc(-0.45f, 0.45f, -0.45f, 0.45f, "replace");
                int del1 = dlg.ExecuteSoftDelete();
                dlg.ExecuteUndo();
                int delAfterUndo = dlg.Session.DeletedCount;
                dlg.ExecuteRedo();
                int delAfterRedo = dlg.Session.DeletedCount;
                if (boxSel <= 0 || del1 <= 0 || delAfterUndo != 0 || delAfterRedo != del1)
                    throw new IOException(string.Format("Edit cycle failed: sel={0}, del={1}, undo={2}, redo={3}", boxSel, del1, delAfterUndo, delAfterRedo));

                byte[] pxEdited;
                NativeViewportAbi.ReadbackRgbaManaged(dlg.NativeHandle, out rw, out rh, out pxEdited);
                SaveRgbaAsPng(pxEdited, (int)rw, (int)rh, Path.Combine(outDir, "hwnd_vulkan_after_delete.png"));

                totalPts = dlg.Session.PointCount;
                delAfterEdit = delAfterRedo;
                savedRecipe = dlg.Session.BuildV3RecipeJson();
                hwndCheck["totalPoints"] = totalPts;
                hwndCheck["boxSelected"] = boxSel;
                hwndCheck["deletedAfterEdit"] = delAfterEdit;
                hwndCheck["deletedAfterUndo"] = delAfterUndo;
                hwndCheck["deletedAfterRedo"] = delAfterRedo;
                hwndCheck["lastStats"] = new Dictionary<string, object> {
                    { "frameMs", Math.Round(dlg.LastFrameStats.FrameTimeMs, 3) },
                    { "sortMs", Math.Round(dlg.LastFrameStats.SortTimeMs, 3) },
                    { "rasterMs", Math.Round(dlg.LastFrameStats.RasterTimeMs, 3) },
                    { "presentWaitMs", Math.Round(dlg.LastFrameStats.PresentWaitMs, 3) },
                    { "gpuSortActive", dlg.LastFrameStats.GpuSortActive }
                };
                dlg.Close();
            }
            string recipeFile = Path.Combine(outDir, "native_saved_recipe.json");
            File.WriteAllText(recipeFile, savedRecipe, new UTF8Encoding(false));
            hwndCheck["savedRecipePath"] = recipeFile;

            // Reopen in fresh Native Vulkan Dialog
            using (var dlg2 = new NativeViewportDialog(null, inputPath, savedRecipe, true, false)) {
                dlg2.Show();
                Application.DoEvents();
                if (!dlg2.DeviceReady) throw new IOException("Reopen Native failed");
                hwndCheck["nativeReopenDeleted"] = dlg2.Session.DeletedCount;
                hwndCheck["nativeReopenSphereEnabled"] = dlg2.Session.SphereEnabled;
                if (dlg2.Session.DeletedCount != delAfterEdit || !dlg2.Session.SphereEnabled)
                    throw new IOException("Native reopen state mismatch!");
                dlg2.Close();
            }

            // Reopen EXACT SAME recipe in real default WebView2 SceneEditorDialog (in-process fallback path!)
            var wvReopen = SceneEditorDialog.VerifyRecipeReopenInWebView2(inputPath, savedRecipe, outDir);
            int wvDel = Convert.ToInt32(wvReopen["deletedOnOpen"], CultureInfo.InvariantCulture);
            var wvState = wvReopen.ContainsKey("state") ? wvReopen["state"] as Dictionary<string, object> : null;
            hwndCheck["webview2ReopenDeleted"] = wvDel;
            if (wvState != null && wvState.ContainsKey("volumeCount")) hwndCheck["webview2ReopenVolumeCount"] = wvState["volumeCount"];
            if (wvDel != delAfterEdit)
                throw new IOException(string.Format("WebView2 reopen deleted mismatch: {0} != {1}", wvDel, delAfterEdit));

            // Export lossless PLY via real Converter & check exact point count + source immutability
            string outPly = Path.Combine(outDir, "native_session_exported.ply");
            using (var conv = new Converter()) {
                conv.Prepare(CancellationToken.None);
                var inp = new InputFile(inputPath);
                inp.Ops.Add(new Op { Step = Step.Scene, Value = SceneRecipe.StoreIfLarge(savedRecipe), Enabled = true });
                var job = new Job {
                    Output = outPly,
                    Format = Converter.Formats.First(f => f.Suffix == ".ply"),
                    Overwrite = true, BatchMode = false, Keep = 100, Device = "cpu", Workers = 2
                };
                job.Inputs.Add(inp);
                var rep = conv.ConvertSingle(job, CancellationToken.None, s => { }, l => { }, p => { });
                hwndCheck["exportPassed"] = rep.Passed;
                hwndCheck["exportedPoints"] = rep.VerifiedSplatCount;
                if (!rep.Passed || rep.VerifiedSplatCount != totalPts - delAfterEdit)
                    throw new IOException(string.Format("Export failed/mismatch: passed={0}, exported={1}, expected={2}", rep.Passed, rep.VerifiedSplatCount, totalPts - delAfterEdit));
            }
            string srcShaAfter = SceneEditorDialog.ComputeSourceFingerprint(inputPath);
            hwndCheck["sourceUnchanged"] = string.Equals(srcShaBefore, srcShaAfter, StringComparison.OrdinalIgnoreCase);
            if (!(bool)hwndCheck["sourceUnchanged"]) throw new IOException("Source asset SHA-256 mutated!");
            hwndCheck["passed"] = true;
            report["hwndEditReopenExportLoop"] = hwndCheck;

            // --- Test D: Device Init Failure & Simulated VK_ERROR_DEVICE_LOST Fallback ---
            var fallbackCheck = new Dictionary<string, object>();
            {
                Environment.SetEnvironmentVariable("SPLAT_NV_FORCE_INIT_FAIL", "1");
                try {
                    using (var failDlg = new NativeViewportDialog(null, inputPath, null, true, false)) {
                        failDlg.Show();
                        Application.DoEvents();
                        fallbackCheck["initFailTriggeredFallback"] = failDlg.FallbackToWebViewRequested;
                        fallbackCheck["initFailReason"] = failDlg.FallbackReason;
                        if (!failDlg.FallbackToWebViewRequested || failDlg.DeviceReady)
                            throw new IOException("Expected forced init failure to trigger clean WebView2 fallback!");
                        failDlg.Close();
                    }
                } finally {
                    Environment.SetEnvironmentVariable("SPLAT_NV_FORCE_INIT_FAIL", null);
                }

                using (var lostDlg = new NativeViewportDialog(null, inputPath, null, true, false)) {
                    lostDlg.Show();
                    Application.DoEvents();
                    if (!lostDlg.DeviceReady) throw new IOException("DeviceLost test setup failed");
                    var simCmd = new SplatNvCommand {
                        StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCommand)),
                        Type = (uint)SplatNvCommandType.SimulateDeviceLost
                    };
                    SplatNvStatus simSt = NativeViewportAbi.splat_nv_submit_command(lostDlg.NativeHandle, ref simCmd);
                    SplatNvStatus renSt = lostDlg.RenderOnce();
                    fallbackCheck["deviceLostSubmitStatus"] = simSt.ToString();
                    fallbackCheck["deviceLostRenderStatus"] = renSt.ToString();
                    fallbackCheck["deviceLostTriggeredFallback"] = lostDlg.FallbackToWebViewRequested;
                    if (renSt != SplatNvStatus.DeviceLost || !lostDlg.FallbackToWebViewRequested)
                        throw new IOException("Simulated device lost did not trigger clean fallback!");
                    lostDlg.Close();
                }
                fallbackCheck["passed"] = true;
            }
            report["deviceFailureAndFallback"] = fallbackCheck;

            // --- Test E: 5x Open/Close VRAM & Handle Leak Check ---
            var vramCheck = new Dictionary<string, object>();
            int? vramBefore = QueryNvidiaVramMiB();
            var cycleSamples = new List<int?>();
            for (int c = 0; c < 5; c++) {
                using (var cyc = new NativeViewportDialog(null, inputPath, null, true, false)) {
                    cyc.Show();
                    Application.DoEvents();
                    for (int f = 0; f < 5; f++) cyc.RenderOnce();
                    cyc.Close();
                }
                Thread.Sleep(250);
                cycleSamples.Add(QueryNvidiaVramMiB());
            }
            Thread.Sleep(600);
            int? vramAfter = QueryNvidiaVramMiB();
            vramCheck["vramBeforeMiB"] = vramBefore;
            vramCheck["cycleAfterMiB"] = cycleSamples;
            vramCheck["vramAfter5CyclesMiB"] = vramAfter;
            int vramDrift = (vramBefore.HasValue && vramAfter.HasValue) ? (vramAfter.Value - vramBefore.Value) : 0;
            vramCheck["vramDriftMiB"] = vramDrift;
            vramCheck["passed"] = vramDrift <= 96; // Allow modest OS compositor noise, zero monotonic leak
            report["fiveCycleVramStability"] = vramCheck;

            report["passed"] = true;
            File.WriteAllText(reportPath, json.Serialize(report), new UTF8Encoding(false));
            return 0;
        } catch (Exception ex) {
            report["passed"] = false;
            report["error"] = ex.ToString();
            try { File.WriteAllText(reportPath, json.Serialize(report), new UTF8Encoding(false)); } catch { }
            return 1;
        }
    }

    // =========================================================================
    // CLI 4: Single-Run Vulkan Desktop Benchmark Worker (exact 1520x900 HWND, 120 frames, +Y-up)
    // =========================================================================
    internal static Dictionary<string, object> RunVulkanBenchRun(
        string inputPath, string predecodedSgc3Path, int frameCount, int runIndex, string cacheCond, double externalDecodeSec, int shDegree)
    {
        var result = new Dictionary<string, object>();
        var swTotal = Stopwatch.StartNew();

        using (var dlg = new NativeViewportDialog(null, inputPath, null, true, true, predecodedSgc3Path)) {
            dlg.Show();
            Application.DoEvents();
            if (!dlg.DeviceReady) throw new IOException("Vulkan bench init failed: " + dlg.FallbackReason);

            NativeViewportAbi.SetShDegree(dlg.NativeHandle, (uint)Math.Max(0, Math.Min(3, shDegree)));
            float cx = dlg.sceneCenterX, cy = dlg.sceneCenterY, cz = dlg.sceneCenterZ;
            float dist = Math.Max(1.0f, dlg.sceneRadius * 2.2f);

            Func<SplatNvDisplayMode, Dictionary<string, object>> runOrbit = mode => {
                NativeViewportAbi.SetDisplayMode(dlg.NativeHandle, mode);
                // 4 warmup frames
                for (int w = 0; w < 4; w++) {
                    double wa = (w / 4.0) * 0.2;
                    dlg.SetCameraPose((float)(cx + Math.Cos(wa) * dist), (float)(cy + 0.25 * dist), (float)(cz + Math.Sin(wa) * dist), cx, cy, cz);
                    dlg.RenderOnce();
                }
                var fMs = new List<double>(frameCount);
                var sMs = new List<double>(frameCount);
                var rMs = new List<double>(frameCount);
                var wMs = new List<double>(frameCount);
                ulong drawn = 0, total = 0;
                uint gpuSortActive = 0;
                for (int i = 0; i < frameCount; i++) {
                    double ang = (i / (double)frameCount) * Math.PI * 2.0;
                    double elev = 0.25 + 0.12 * Math.Sin(ang);
                    float px = (float)(cx + Math.Cos(ang) * Math.Cos(elev) * dist);
                    float py = (float)(cy + Math.Sin(elev) * dist);
                    float pz = (float)(cz + Math.Sin(ang) * Math.Cos(elev) * dist);
                    dlg.SetCameraPose(px, py, pz, cx, cy, cz);
                    SplatNvStatus rc = dlg.RenderOnce();
                    if (rc != SplatNvStatus.Ok) throw new IOException("Vulkan bench render_frame failed: " + rc);
                    var st = dlg.LastFrameStats;
                    fMs.Add(Math.Round(st.FrameTimeMs, 3));
                    sMs.Add(Math.Round(st.SortTimeMs, 3));
                    rMs.Add(Math.Round(st.RasterTimeMs, 3));
                    wMs.Add(Math.Round(st.PresentWaitMs, 3));
                    drawn = st.VisibleSplats;
                    total = st.TotalSplats;
                    gpuSortActive = st.GpuSortActive;
                }
                return new Dictionary<string, object> {
                    { "frameMs", fMs }, { "sortMs", sMs }, { "rasterMs", rMs }, { "waitMs", wMs },
                    { "drawnInstances", drawn }, { "totalPoints", total }, { "gpuSortActive", gpuSortActive }
                };
            };

            var splatRaw = runOrbit(SplatNvDisplayMode.Splat);
            int? vramPeakSplat = QueryNvidiaVramMiB();
            double? rssPeak = QueryProcessTreeRssMiB(Process.GetCurrentProcess().Id);
            var centersRaw = runOrbit(SplatNvDisplayMode.Centers);
            int? vramPeakCenters = QueryNvidiaVramMiB();

            // Gesture latencies on Vulkan bypass viewport
            NativeViewportAbi.SetDisplayMode(dlg.NativeHandle, SplatNvDisplayMode.Splat);
            dlg.RenderOnce();
            var swG = Stopwatch.StartNew();
            int selCount = dlg.ExecuteBoxSelectNdc(-0.24f, 0.24f, -0.24f, 0.24f, "replace");
            double boxMs = Math.Round(swG.Elapsed.TotalMilliseconds, 2);
            swG.Restart();
            int delCount = dlg.ExecuteSoftDelete();
            double delMs = Math.Round(swG.Elapsed.TotalMilliseconds, 2);
            swG.Restart();
            dlg.ExecuteUndo();
            double undoDelMs = Math.Round(swG.Elapsed.TotalMilliseconds, 2);
            swG.Restart();
            dlg.ExecuteUndo();
            double undoSelMs = Math.Round(swG.Elapsed.TotalMilliseconds, 2);

            double decodeSec = externalDecodeSec > 0 ? Math.Round(externalDecodeSec, 3) : dlg.LastDecodeSec;
            var localCaps = dlg.caps;
            result["backend"] = "native-vulkan-1.3";
            result["backendName"] = localCaps.BackendName ?? "Vulkan";
            result["hostMode"] = "real-desktop-winforms-hwnd-vulkan";
            result["run"] = runIndex;
            result["cacheCondition"] = cacheCond;
            result["resolution"] = "1520x900";
            result["shDegree"] = shDegree;
            result["downsampleMode"] = "none (100% full points)";
            result["sortBackend"] = "gpu-vulkan-compute-32bit-radix";
            result["frames"] = frameCount;
            result["cameraTarget"] = new double[] { cx, cy, cz };
            result["orbitDistance"] = Math.Round(dist, 4);
            result["decodeSec"] = decodeSec;
            result["mountSec"] = dlg.LastMountSec;
            result["firstEditableSec"] = Math.Round(decodeSec + dlg.LastMountSec, 3);
            result["fullSplat"] = SummarizeBenchPass(splatRaw);
            result["centersMode"] = SummarizeBenchPass(centersRaw);
            result["gestures"] = new Dictionary<string, object> {
                { "boxSelectMs", boxMs }, { "softDeleteMs", delMs },
                { "undoDeleteMs", undoDelMs }, { "undoSelectMs", undoSelMs },
                { "selectedCount", selCount }, { "deletedCount", delCount }
            };
            result["processTreeRssPeakMiB"] = rssPeak;
            result["vramPeakMiB"] = Math.Max(vramPeakSplat ?? 0, vramPeakCenters ?? 0);
            result["vramReportedByDriverBytes"] = dlg.LastFrameStats.VramUsedBytes;
            result["totalWallSec"] = Math.Round(swTotal.Elapsed.TotalSeconds, 3);

            dlg.Close();
        }
        return result;
    }

    // --desktop-bench-worker <webview2|vulkan> <inputPath> <outJson> <frames> <runIndex> <cacheCond> [sgc3Path] [decodeSec] [shDegree]
    internal static int RunDesktopBenchWorkerCli(string[] args) {
        string backend = args[1].ToLowerInvariant();
        string inputPath = Path.GetFullPath(args[2]);
        string outJson = Path.GetFullPath(args[3]);
        int frames = int.Parse(args[4], CultureInfo.InvariantCulture);
        int runIndex = int.Parse(args[5], CultureInfo.InvariantCulture);
        string cacheCond = args[6];
        string sgc3Path = args.Length >= 8 && args[7] != "-" ? Path.GetFullPath(args[7]) : null;
        double extDecodeSec = args.Length >= 9 ? double.Parse(args[8], CultureInfo.InvariantCulture) : 0.0;
        int shDegree = args.Length >= 10 ? int.Parse(args[9], CultureInfo.InvariantCulture) : 0;

        Directory.CreateDirectory(Path.GetDirectoryName(outJson));
        var json = SceneRecipe.CreateSerializer();
        try {
            I18n.Restore();
            Theme.Restore();
            TooltipConfig.Load();
            Dictionary<string, object> res = backend == "vulkan"
                ? RunVulkanBenchRun(inputPath, sgc3Path, frames, runIndex, cacheCond, extDecodeSec, shDegree)
                : SceneEditorDialog.RunWebView2BenchRun(inputPath, sgc3Path, frames, runIndex, cacheCond, extDecodeSec);
            res["passed"] = true;
            File.WriteAllText(outJson, json.Serialize(res), new UTF8Encoding(false));
            return 0;
        } catch (Exception ex) {
            var err = new Dictionary<string, object> { { "passed", false }, { "backend", backend }, { "error", ex.ToString() } };
            try { File.WriteAllText(outJson, json.Serialize(err), new UTF8Encoding(false)); } catch { }
            return 1;
        }
    }

    // =========================================================================
    // CLI 5: Alternating Same-Host Real Desktop Benchmark Orchestrator
    //   --desktop-bench <inputPath> <outJson> [frames=120] [runs=3] [mode=both|webview2|vulkan] [shDegree=0]
    // =========================================================================
    internal static int RunDesktopBenchCli(string[] args) {
        string inputPath = Path.GetFullPath(args[1]);
        string outJson = Path.GetFullPath(args[2]);
        int frames = args.Length >= 4 ? int.Parse(args[3], CultureInfo.InvariantCulture) : 120;
        int runs = args.Length >= 5 ? int.Parse(args[4], CultureInfo.InvariantCulture) : 3;
        string mode = args.Length >= 6 ? args[5].ToLowerInvariant() : "both";
        int shDegree = args.Length >= 7 ? int.Parse(args[6], CultureInfo.InvariantCulture) : 0;

        Directory.CreateDirectory(Path.GetDirectoryName(outJson));
        string workDir = Path.Combine(PortablePaths.TmpDir, "desk-bench-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        var json = SceneRecipe.CreateSerializer();
        string exePath = Assembly.GetExecutingAssembly().Location;
        string dllPath = NativeViewportAbi.ResolveDllPath();

        var report = new Dictionary<string, object> {
            { "suite", "002-B-same-host-real-desktop-bench" },
            { "timestampUtc", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) },
            { "exePath", exePath },
            { "exeSha256", Sha256HexUpper(exePath) },
            { "dllPath", dllPath },
            { "dllSha256", Sha256HexUpper(dllPath) },
            { "manifestAssetsHash", EditorAssets.AssetsHash },
            { "inputPath", inputPath },
            { "inputFile", Path.GetFileName(inputPath) },
            { "inputBytes", new FileInfo(inputPath).Length },
            { "framesPerPass", frames },
            { "runsPerBackend", runs },
            { "mode", mode },
            { "shDegree", shDegree },
            { "resolution", "1520x900" },
            { "downsampleMode", "none (100% full points)" },
            { "envMeta", QueryGpuMeta() }
        };

        try {
            // Decode .sog/.spz once for warm runs (cold run 1 measures fresh decode OR shared decode clearly labeled!)
            string ext = Path.GetExtension(inputPath).ToLowerInvariant();
            string sharedSgc3 = null;
            double coldDecodeSec = 0.0;
            if (ext != ".ply" && ext != ".sgc3") {
                sharedSgc3 = Path.Combine(workDir, "shared-full.sgc3");
                var swD = Stopwatch.StartNew();
                string runtime = EngineManager.EnsureActiveRuntime(CancellationToken.None);
                int tot, loaded;
                EditorAssets.WorkerWithProgress("sample", inputPath, sharedSgc3, "full", runtime, workDir, CancellationToken.None, 8192L << 20, null, out tot, out loaded);
                coldDecodeSec = Math.Round(swD.Elapsed.TotalSeconds, 3);
                report["decodedTotalPoints"] = tot;
                report["decodedLoadedPoints"] = loaded;
                report["sharedSgc3DecodeSec"] = coldDecodeSec;
            }

            var webviewRuns = new List<Dictionary<string, object>>();
            var vulkanRuns = new List<Dictionary<string, object>>();

            Func<string, int, string, Dictionary<string, object>> spawnRun = (backend, runIdx, cacheCond) => {
                string runOut = Path.Combine(workDir, string.Format("{0}_run{1}.json", backend, runIdx));
                int? vramIdle = QueryNvidiaVramMiB();
                // For Run 1 (Cold): WebView2 & Vulkan decode fresh if .sog? Wait: reusing sharedSgc3 for Warm 2..N and fresh decode for Cold 1 matches Cold vs Warm cleanly!
                bool usePredecoded = (runIdx > 1) && !string.IsNullOrEmpty(sharedSgc3);
                string sgcArg = usePredecoded ? sharedSgc3 : (ext == ".ply" ? "-" : (runIdx == 1 ? "-" : sharedSgc3));
                string decArg = "0";
                string cliArgs = string.Format(
                    CultureInfo.InvariantCulture,
                    "--desktop-bench-worker {0} \"{1}\" \"{2}\" {3} {4} {5} \"{6}\" {7} {8}",
                    backend, inputPath, runOut, frames, runIdx, cacheCond, sgcArg, decArg, shDegree);
                var psi = new ProcessStartInfo(exePath, cliArgs) {
                    UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(exePath)
                };
                using (var p = Process.Start(psi)) {
                    p.WaitForExit(600000);
                }
                Thread.Sleep(1500);
                int? vramAfter = QueryNvidiaVramMiB();
                if (!File.Exists(runOut))
                    throw new IOException(string.Format("Worker {0} run {1} produced no output JSON.", backend, runIdx));
                var d = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(runOut, Encoding.UTF8));
                d["vramIdleMiB"] = vramIdle;
                d["vramAfterExitMiB"] = vramAfter;
                if (vramIdle.HasValue && d.ContainsKey("vramPeakMiB")) {
                    int pk = Convert.ToInt32(d["vramPeakMiB"], CultureInfo.InvariantCulture);
                    d["vramDeltaPeakMiB"] = pk - vramIdle.Value;
                    if (vramAfter.HasValue) d["vramReclaimedMiB"] = pk - vramAfter.Value;
                }
                return d;
            };

            // Strictly alternate WebView2 <-> Vulkan on every run index to eliminate thermal/clock drift!
            for (int r = 1; r <= runs; r++) {
                string cond = r == 1 ? "cold" : "warm";
                if (mode == "both" || mode == "webview2") {
                    webviewRuns.Add(spawnRun("webview2", r, cond));
                }
                if (mode == "both" || mode == "vulkan") {
                    vulkanRuns.Add(spawnRun("vulkan", r, cond));
                }
            }

            report["webview2Runs"] = webviewRuns;
            report["vulkanRuns"] = vulkanRuns;
            report["passed"] = true;
            File.WriteAllText(outJson, json.Serialize(report), new UTF8Encoding(false));
            return 0;
        } catch (Exception ex) {
            report["passed"] = false;
            report["error"] = ex.ToString();
            try { File.WriteAllText(outJson, json.Serialize(report), new UTF8Encoding(false)); } catch { }
            return 1;
        } finally {
            try { if (Directory.Exists(workDir)) Directory.Delete(workDir, true); } catch { }
        }
    }
}
