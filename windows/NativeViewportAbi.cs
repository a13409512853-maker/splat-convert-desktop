// Complete Versioned C-ABI v1.1 P/Invoke contract mirror for windows/native-viewport/include/splat_native_viewport_abi.h.
// Compiled into SplatConvertDesktop (.NET Framework 4.x / C# 5) with ZERO /unsafe dependency.
// Strictly opt-in: default runtime remains 100% WebView2 unless native bypass viewport is explicitly invoked.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace SplatConvertDesktop
{
    internal enum SplatNvStatus : int
    {
        Ok = 0,
        InvalidArg = -1,
        AbiMismatch = -2,
        InvalidHandle = -3,
        Unsupported = -4,
        Io = -5,
        GpuDevice = -6,
        OutOfMemory = -7,
        AssetNotFound = -8,
        DeviceLost = -9,
        Internal = -99
    }

    internal enum SplatNvPresentMode : uint
    {
        None = 0,
        Hwnd = 1,
        DirectComposition = 2,
        OffscreenHeadless = 3
    }

    internal enum SplatNvCoordSystem : uint
    {
        YUp = 1,
        ZUp = 2
    }

    internal enum SplatNvDisplayMode : uint
    {
        Splat = 0,
        Centers = 1,
        Rings = 2
    }

    internal enum SplatNvCommandType : uint
    {
        SetDisplayMode = 1,
        ApplySparseFlags = 2,
        SetObjectMatrix = 3,
        RequestSort = 4,
        SetShDegree = 5,
        SetBoundingSphere = 6,
        SimulateDeviceLost = 7
    }

    internal enum SplatNvInputType : uint
    {
        PointerMove = 1,
        PointerDown = 2,
        PointerUp = 3,
        Wheel = 4,
        KeyDown = 5,
        KeyUp = 6
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    internal struct SplatNvCapabilities
    {
        public uint StructSize;
        public uint AbiVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string BackendName;
        public uint MaxShDegree;
        public uint SupportsGpuRadixSort;
        public uint SupportsGpuPicking;
        public uint SupportsHwndPresent;
        public uint SupportsDcompPresent;
        public uint SupportsOffscreenPresent;
        public uint SupportsSparseFlagDelta;
        public ulong MaxSplatsHint;
        public ulong VramBudgetBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SplatNvPresentTarget
    {
        public uint StructSize;
        public uint Mode;
        public IntPtr Hwnd;
        public IntPtr DcompVisual;
        public uint Width;
        public uint Height;
        public float DpiScale;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SplatNvCreateDesc
    {
        public uint StructSize;
        public uint AbiVersion;
        public uint CoordSystem;
        public uint EnableValidation;
        public SplatNvPresentTarget PresentTarget;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SplatNvAssetDesc
    {
        public uint StructSize;
        public IntPtr Utf8Path;   // UTF-8 null-terminated unmanaged pointer
        public IntPtr AssetKey;   // UTF-8 null-terminated unmanaged pointer
        public uint MaxShDegree;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SplatNvCamera
    {
        public uint StructSize;
        public float PosX, PosY, PosZ;
        public float TargetX, TargetY, TargetZ;
        public float UpX, UpY, UpZ;
        public float FovYDeg;
        public float NearPlane;
        public float FarPlane;
        public uint IsOrtho;
        public float OrthoHalfHeight;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SplatNvInputEvent
    {
        public uint StructSize;
        public uint Type;
        public float X;
        public float Y;
        public float DeltaX;
        public float DeltaY;
        public uint Button;
        public uint Modifiers;
        public uint KeyCode;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SplatNvSparseFlagDelta
    {
        public uint AssetId;
        public uint Count;
        public IntPtr SourceIndices;
        public IntPtr Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SplatNvBoundingSphereCmd
    {
        public float CenterX, CenterY, CenterZ;
        public float Radius;
        public uint Enabled;
        public uint Invert;
    }

    // Exact 64-bit union layout matching C `SplatNvCommand`:
    //   offset 0: uint struct_size
    //   offset 4: uint type
    //   offset 8..80: 72-byte union payload (largest member = SplatNvObjectMatrixCmd: 8 + 16*4 = 72 bytes)
    [StructLayout(LayoutKind.Explicit, Size = 80)]
    internal struct SplatNvCommand
    {
        [FieldOffset(0)] public uint StructSize;
        [FieldOffset(4)] public uint Type;

        // SPLAT_NV_CMD_SET_DISPLAY_MODE / REQUEST_SORT / SET_SH_DEGREE
        [FieldOffset(8)] public uint ScalarU32;

        // SPLAT_NV_CMD_APPLY_SPARSE_FLAGS
        [FieldOffset(8)] public SplatNvSparseFlagDelta SparseFlags;

        // SPLAT_NV_CMD_SET_BOUNDING_SPHERE
        [FieldOffset(8)] public SplatNvBoundingSphereCmd BoundingSphere;

        // SPLAT_NV_CMD_SET_OBJECT_MATRIX (asset_id @8, object_id @12, matrix16[16] @16..80)
        [FieldOffset(8)] public uint MatAssetId;
        [FieldOffset(12)] public uint MatObjectId;
        [FieldOffset(16)] public float M0;
        [FieldOffset(20)] public float M1;
        [FieldOffset(24)] public float M2;
        [FieldOffset(28)] public float M3;
        [FieldOffset(32)] public float M4;
        [FieldOffset(36)] public float M5;
        [FieldOffset(40)] public float M6;
        [FieldOffset(44)] public float M7;
        [FieldOffset(48)] public float M8;
        [FieldOffset(52)] public float M9;
        [FieldOffset(56)] public float M10;
        [FieldOffset(60)] public float M11;
        [FieldOffset(64)] public float M12;
        [FieldOffset(68)] public float M13;
        [FieldOffset(72)] public float M14;
        [FieldOffset(76)] public float M15;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SplatNvPickRectDesc
    {
        public uint StructSize;
        public uint AssetId;
        public float MinNdcX;
        public float MaxNdcX;
        public float MinNdcY;
        public float MaxNdcY;
        public uint OnlyVisible;
        public uint WholeGaussian;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SplatNvPickResult
    {
        public uint StructSize;
        public uint AssetId;
        public uint HitCount;
        public IntPtr SourceIndices;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SplatNvFrameStats
    {
        public uint StructSize;
        public double FrameTimeMs;
        public double SortTimeMs;
        public double RasterTimeMs;
        public ulong TotalSplats;
        public ulong VisibleSplats;
        public ulong VramUsedBytes;
        public double PresentWaitMs;
        public uint ActiveShDegree;
        public uint GpuSortActive;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    internal struct SplatNvErrorInfo
    {
        public uint StructSize;
        public int StatusCode;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string Message;
    }

    internal static class NativeViewportAbi
    {
        public const uint AbiMajor = 1;
        public const uint AbiMinor = 1;
        public const uint AbiVersion = (AbiMajor << 16) | (AbiMinor & 0xFFFFu);
        public const string DllName = "splat_native_viewport.dll";

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr LoadLibraryW(string lpLibFileName);

        static readonly object LoadSync = new object();
        static string loadedDllPath;

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern uint splat_nv_get_abi_version();

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern SplatNvStatus splat_nv_query_capabilities(ref SplatNvCapabilities outCaps);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern SplatNvStatus splat_nv_create(ref SplatNvCreateDesc desc, out IntPtr outHandle);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern void splat_nv_destroy(IntPtr handle);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern SplatNvStatus splat_nv_set_present_target(IntPtr handle, ref SplatNvPresentTarget target);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern SplatNvStatus splat_nv_resize(IntPtr handle, uint width, uint height, float dpiScale);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern SplatNvStatus splat_nv_load_asset(IntPtr handle, ref SplatNvAssetDesc desc, out uint outAssetId);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern SplatNvStatus splat_nv_unload_asset(IntPtr handle, uint assetId);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern SplatNvStatus splat_nv_set_camera(IntPtr handle, ref SplatNvCamera cam);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern SplatNvStatus splat_nv_push_input(IntPtr handle, ref SplatNvInputEvent ev);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern SplatNvStatus splat_nv_submit_command(IntPtr handle, ref SplatNvCommand cmd);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern SplatNvStatus splat_nv_pick_rect(IntPtr handle, ref SplatNvPickRectDesc desc, ref SplatNvPickResult outResult);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern void splat_nv_free_buffer(IntPtr handle, IntPtr ptr);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern SplatNvStatus splat_nv_render_frame(IntPtr handle, ref SplatNvFrameStats outStats);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern SplatNvStatus splat_nv_readback_rgba(IntPtr handle, out uint outWidth, out uint outHeight, out IntPtr outRgbaPixels);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        public static extern SplatNvStatus splat_nv_get_last_error(IntPtr handle, ref SplatNvErrorInfo outError);

        public static IntPtr AllocUtf8(string s)
        {
            if (s == null) return IntPtr.Zero;
            byte[] bytes = Encoding.UTF8.GetBytes(s);
            IntPtr ptr = Marshal.AllocHGlobal(bytes.Length + 1);
            Marshal.Copy(bytes, 0, ptr, bytes.Length);
            Marshal.WriteByte(ptr, bytes.Length, 0);
            return ptr;
        }

        public static SplatNvStatus LoadAssetUtf8(IntPtr handle, string utf8Path, string assetKey, uint maxShDegree, out uint outAssetId)
        {
            IntPtr pPath = AllocUtf8(utf8Path);
            IntPtr pKey = AllocUtf8(assetKey ?? "primary");
            try
            {
                var desc = new SplatNvAssetDesc
                {
                    StructSize = (uint)Marshal.SizeOf(typeof(SplatNvAssetDesc)),
                    Utf8Path = pPath,
                    AssetKey = pKey,
                    MaxShDegree = maxShDegree,
                    Reserved = 0
                };
                return splat_nv_load_asset(handle, ref desc, out outAssetId);
            }
            finally
            {
                if (pPath != IntPtr.Zero) Marshal.FreeHGlobal(pPath);
                if (pKey != IntPtr.Zero) Marshal.FreeHGlobal(pKey);
            }
        }

        public static SplatNvStatus ApplySparseFlags(IntPtr handle, uint assetId, uint[] sourceIndices, byte[] flags)
        {
            if (sourceIndices == null || flags == null || sourceIndices.Length != flags.Length)
                return SplatNvStatus.InvalidArg;
            int n = sourceIndices.Length;
            IntPtr pIdx = IntPtr.Zero;
            IntPtr pFlg = IntPtr.Zero;
            try
            {
                if (n > 0)
                {
                    pIdx = Marshal.AllocHGlobal(n * 4);
                    int[] tmp = new int[n];
                    Buffer.BlockCopy(sourceIndices, 0, tmp, 0, n * 4);
                    Marshal.Copy(tmp, 0, pIdx, n);
                    pFlg = Marshal.AllocHGlobal(n);
                    Marshal.Copy(flags, 0, pFlg, n);
                }
                var cmd = new SplatNvCommand
                {
                    StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCommand)),
                    Type = (uint)SplatNvCommandType.ApplySparseFlags,
                    SparseFlags = new SplatNvSparseFlagDelta
                    {
                        AssetId = assetId,
                        Count = (uint)n,
                        SourceIndices = pIdx,
                        Flags = pFlg
                    }
                };
                return splat_nv_submit_command(handle, ref cmd);
            }
            finally
            {
                if (pIdx != IntPtr.Zero) Marshal.FreeHGlobal(pIdx);
                if (pFlg != IntPtr.Zero) Marshal.FreeHGlobal(pFlg);
            }
        }

        public static SplatNvStatus SetObjectMatrix(IntPtr handle, uint assetId, uint objectId, float[] m)
        {
            if (m == null || m.Length != 16) return SplatNvStatus.InvalidArg;
            var cmd = new SplatNvCommand
            {
                StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCommand)),
                Type = (uint)SplatNvCommandType.SetObjectMatrix,
                MatAssetId = assetId,
                MatObjectId = objectId,
                M0 = m[0], M1 = m[1], M2 = m[2], M3 = m[3],
                M4 = m[4], M5 = m[5], M6 = m[6], M7 = m[7],
                M8 = m[8], M9 = m[9], M10 = m[10], M11 = m[11],
                M12 = m[12], M13 = m[13], M14 = m[14], M15 = m[15]
            };
            return splat_nv_submit_command(handle, ref cmd);
        }

        public static SplatNvStatus SetBoundingSphere(IntPtr handle, float cx, float cy, float cz, float radius, bool enabled, bool invert)
        {
            var cmd = new SplatNvCommand
            {
                StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCommand)),
                Type = (uint)SplatNvCommandType.SetBoundingSphere,
                BoundingSphere = new SplatNvBoundingSphereCmd
                {
                    CenterX = cx, CenterY = cy, CenterZ = cz,
                    Radius = radius,
                    Enabled = enabled ? 1u : 0u,
                    Invert = invert ? 1u : 0u
                }
            };
            return splat_nv_submit_command(handle, ref cmd);
        }

        public static SplatNvStatus SetShDegree(IntPtr handle, uint degree)
        {
            var cmd = new SplatNvCommand
            {
                StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCommand)),
                Type = (uint)SplatNvCommandType.SetShDegree,
                ScalarU32 = degree
            };
            return splat_nv_submit_command(handle, ref cmd);
        }

        public static SplatNvStatus SetDisplayMode(IntPtr handle, SplatNvDisplayMode mode)
        {
            var cmd = new SplatNvCommand
            {
                StructSize = (uint)Marshal.SizeOf(typeof(SplatNvCommand)),
                Type = (uint)SplatNvCommandType.SetDisplayMode,
                ScalarU32 = (uint)mode
            };
            return splat_nv_submit_command(handle, ref cmd);
        }

        public static SplatNvStatus PickRectManaged(
            IntPtr handle, uint assetId, float minX, float maxX, float minY, float maxY,
            bool onlyVisible, bool wholeGaussian, out uint[] outIndices)
        {
            outIndices = new uint[0];
            var desc = new SplatNvPickRectDesc
            {
                StructSize = (uint)Marshal.SizeOf(typeof(SplatNvPickRectDesc)),
                AssetId = assetId,
                MinNdcX = minX,
                MaxNdcX = maxX,
                MinNdcY = minY,
                MaxNdcY = maxY,
                OnlyVisible = onlyVisible ? 1u : 0u,
                WholeGaussian = wholeGaussian ? 1u : 0u
            };
            var res = new SplatNvPickResult
            {
                StructSize = (uint)Marshal.SizeOf(typeof(SplatNvPickResult))
            };
            SplatNvStatus st = splat_nv_pick_rect(handle, ref desc, ref res);
            if (st != SplatNvStatus.Ok) return st;
            try
            {
                if (res.HitCount > 0 && res.SourceIndices != IntPtr.Zero)
                {
                    int n = (int)res.HitCount;
                    int[] raw = new int[n];
                    Marshal.Copy(res.SourceIndices, raw, 0, n);
                    outIndices = new uint[n];
                    Buffer.BlockCopy(raw, 0, outIndices, 0, n * 4);
                }
            }
            finally
            {
                if (res.SourceIndices != IntPtr.Zero)
                {
                    splat_nv_free_buffer(handle, res.SourceIndices);
                }
            }
            return SplatNvStatus.Ok;
        }

        public static SplatNvStatus ReadbackRgbaManaged(IntPtr handle, out uint width, out uint height, out byte[] rgba)
        {
            width = 0; height = 0; rgba = null;
            IntPtr ptr = IntPtr.Zero;
            SplatNvStatus st = splat_nv_readback_rgba(handle, out width, out height, out ptr);
            if (st != SplatNvStatus.Ok) return st;
            try
            {
                if (ptr != IntPtr.Zero && width > 0 && height > 0)
                {
                    int byteLen = checked((int)(width * height * 4));
                    rgba = new byte[byteLen];
                    Marshal.Copy(ptr, rgba, 0, byteLen);
                }
            }
            finally
            {
                if (ptr != IntPtr.Zero) splat_nv_free_buffer(handle, ptr);
            }
            return SplatNvStatus.Ok;
        }

        public static string GetLastErrorMessage(IntPtr handle)
        {
            var err = new SplatNvErrorInfo { StructSize = (uint)Marshal.SizeOf(typeof(SplatNvErrorInfo)) };
            if (splat_nv_get_last_error(handle, ref err) == SplatNvStatus.Ok)
                return string.Format("[{0}] {1}", err.StatusCode, err.Message ?? "");
            return "(unable to query last error)";
        }

        public static string ResolveDllPath()
        {
            string envOverride = Environment.GetEnvironmentVariable("SPLAT_NATIVE_VIEWPORT_DLL");
            if (!string.IsNullOrWhiteSpace(envOverride) && File.Exists(envOverride))
                return Path.GetFullPath(envOverride);
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string beside = Path.Combine(baseDir, DllName);
            if (File.Exists(beside)) return beside;
            string dataRuntime = Path.Combine(PortablePaths.RuntimeDir, DllName);
            if (File.Exists(dataRuntime)) return dataRuntime;
            return beside;
        }

        public static bool EnsureLoaded(out string statusDetail)
        {
            lock (LoadSync)
            {
                try
                {
                    string dllPath = ResolveDllPath();
                    if (!File.Exists(dllPath))
                    {
                        statusDetail = "not-present: " + dllPath;
                        return false;
                    }
                    if (loadedDllPath == null)
                    {
                        IntPtr mod = LoadLibraryW(dllPath);
                        if (mod == IntPtr.Zero)
                        {
                            int winErr = Marshal.GetLastWin32Error();
                            statusDetail = string.Format("LoadLibraryW failed (err={0}) for {1}", winErr, dllPath);
                            return false;
                        }
                        loadedDllPath = dllPath;
                    }
                    uint v = splat_nv_get_abi_version();
                    if ((v >> 16) != AbiMajor)
                    {
                        statusDetail = string.Format("abi-mismatch (dll=0x{0:X8}, host=0x{1:X8})", v, AbiVersion);
                        return false;
                    }
                    statusDetail = string.Format("ready (abi={0}.{1}, path={2})", v >> 16, v & 0xFFFFu, loadedDllPath);
                    return true;
                }
                catch (Exception ex)
                {
                    statusDetail = "probe-failed: " + ex.Message;
                    return false;
                }
            }
        }

        public static bool IsNativeViewportDllAvailable(out string statusDetail)
        {
            return EnsureLoaded(out statusDetail);
        }

        public static Dictionary<string, object> GetStructLayoutSizes()
        {
            return new Dictionary<string, object>
            {
                { "SplatNvCapabilities", Marshal.SizeOf(typeof(SplatNvCapabilities)) },
                { "SplatNvPresentTarget", Marshal.SizeOf(typeof(SplatNvPresentTarget)) },
                { "SplatNvCreateDesc", Marshal.SizeOf(typeof(SplatNvCreateDesc)) },
                { "SplatNvAssetDesc", Marshal.SizeOf(typeof(SplatNvAssetDesc)) },
                { "SplatNvCamera", Marshal.SizeOf(typeof(SplatNvCamera)) },
                { "SplatNvInputEvent", Marshal.SizeOf(typeof(SplatNvInputEvent)) },
                { "SplatNvCommand", Marshal.SizeOf(typeof(SplatNvCommand)) },
                { "SplatNvPickRectDesc", Marshal.SizeOf(typeof(SplatNvPickRectDesc)) },
                { "SplatNvPickResult", Marshal.SizeOf(typeof(SplatNvPickResult)) },
                { "SplatNvFrameStats", Marshal.SizeOf(typeof(SplatNvFrameStats)) },
                { "SplatNvErrorInfo", Marshal.SizeOf(typeof(SplatNvErrorInfo)) }
            };
        }
    }
}
