using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

sealed class GpuSnapshot {
    internal string Name, Luid;
    internal double? Usage, MemoryUsed, SharedMemoryUsed, TemperatureC, PowerWatts;
    internal double MemoryTotal;
}
sealed class ResourceSnapshot {
    internal DateTime Sampled;
    internal double? Cpu;
    internal double TotalMemory, AvailableMemory, CommitAvailable = -1, AppRamBytes = -1;
    internal readonly List<GpuSnapshot> Gpus = new List<GpuSnapshot>();
    internal string CpuName = "", Note = "";
}

// Optional zero-crash dynamic NVML probe for NVIDIA GPU temperature & board power (silently null on non-NVIDIA hardware)
static class NvmlProbe {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadLibrary(string lpFileName);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    static extern IntPtr GetProcAddress(IntPtr hModule, string procName);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int NvmlInit();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int NvmlGetHandle(uint index, out IntPtr device);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int NvmlGetTemp(IntPtr device, uint sensorType, out uint temp);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int NvmlGetPower(IntPtr device, out uint powerMw);

    static bool probed;
    static bool available;
    static IntPtr dev0 = IntPtr.Zero;
    static NvmlGetTemp fnTemp;
    static NvmlGetPower fnPower;

    internal static void TrySample(out double? tempC, out double? powerW) {
        tempC = null; powerW = null;
        try {
            if (!probed) {
                probed = true;
                IntPtr mod = LoadLibrary("nvml.dll");
                if (mod == IntPtr.Zero) {
                    string sysNvml = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "NVIDIA Corporation", "NVSMI", "nvml.dll");
                    if (File.Exists(sysNvml)) mod = LoadLibrary(sysNvml);
                }
                if (mod != IntPtr.Zero) {
                    IntPtr pInit = GetProcAddress(mod, "nvmlInit_v2");
                    if (pInit == IntPtr.Zero) pInit = GetProcAddress(mod, "nvmlInit");
                    IntPtr pHandle = GetProcAddress(mod, "nvmlDeviceGetHandleByIndex_v2");
                    if (pHandle == IntPtr.Zero) pHandle = GetProcAddress(mod, "nvmlDeviceGetHandleByIndex");
                    IntPtr pTemp = GetProcAddress(mod, "nvmlDeviceGetTemperature");
                    IntPtr pPower = GetProcAddress(mod, "nvmlDeviceGetPowerUsage");
                    if (pInit != IntPtr.Zero && pHandle != IntPtr.Zero) {
                        var init = (NvmlInit)Marshal.GetDelegateForFunctionPointer(pInit, typeof(NvmlInit));
                        var getH = (NvmlGetHandle)Marshal.GetDelegateForFunctionPointer(pHandle, typeof(NvmlGetHandle));
                        if (init() == 0 && getH(0, out dev0) == 0 && dev0 != IntPtr.Zero) {
                            if (pTemp != IntPtr.Zero) fnTemp = (NvmlGetTemp)Marshal.GetDelegateForFunctionPointer(pTemp, typeof(NvmlGetTemp));
                            if (pPower != IntPtr.Zero) fnPower = (NvmlGetPower)Marshal.GetDelegateForFunctionPointer(pPower, typeof(NvmlGetPower));
                            available = fnTemp != null || fnPower != null;
                        }
                    }
                }
            }
            if (!available || dev0 == IntPtr.Zero) return;
            uint t, mw;
            if (fnTemp != null && fnTemp(dev0, 0, out t) == 0 && t > 0 && t < 130) tempC = t;
            if (fnPower != null && fnPower(dev0, out mw) == 0 && mw > 0 && mw < 2000000) powerW = Math.Round(mw / 1000d, 1);
        } catch {
            available = false;
        }
    }
}

sealed class ResourceMonitor : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct MemoryStatus {
        internal uint Length, Load;
        internal ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile, TotalVirtual, AvailableVirtual, Extended;
    }
    [StructLayout(LayoutKind.Sequential)] struct PerformanceInfo {
        internal uint Size;
        internal UIntPtr CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable, SystemCache, KernelTotal, KernelPaged, KernelNonpaged, PageSize;
        internal uint Handles, Processes, Threads;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct AdapterDesc {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] internal string Description;
        internal uint Vendor, Device, Subsys, Revision;
        internal UIntPtr DedicatedVideo, DedicatedSystem, SharedSystem;
        internal uint Low; internal int High; internal uint Flags;
    }
    [StructLayout(LayoutKind.Sequential)] struct CounterValue { internal uint Status; internal double Value; }
    [StructLayout(LayoutKind.Sequential)] struct CounterItem { internal IntPtr Name; internal CounterValue Value; }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAdapter(IntPtr factory, uint index, out IntPtr adapter);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetDesc(IntPtr adapter, out AdapterDesc description);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
    [DllImport("kernel32.dll")] static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
    [DllImport("psapi.dll", SetLastError=true)] static extern bool GetPerformanceInfo(ref PerformanceInfo info, uint size);
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid guid, out IntPtr factory);
    [DllImport("pdh.dll", CharSet=CharSet.Unicode)] static extern uint PdhOpenQuery(string source, IntPtr data, out IntPtr query);
    [DllImport("pdh.dll", CharSet=CharSet.Unicode)] static extern uint PdhAddEnglishCounter(IntPtr query, string path, IntPtr data, out IntPtr counter);
    [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll", CharSet=CharSet.Unicode)] static extern uint PdhGetFormattedCounterArray(IntPtr counter, uint format, ref uint bytes, ref uint count, IntPtr buffer);
    [DllImport("pdh.dll")] static extern uint PdhCloseQuery(IntPtr query);
    readonly object sync = new object();
    readonly List<GpuSnapshot> adapters = new List<GpuSnapshot>();
    IntPtr query, usageCounter, memoryCounter, sharedMemoryCounter;
    bool initialized, disposed, haveTimes, haveGpuSample;
    long previousIdle, previousTotal;
    static T Vtable<T>(IntPtr ptr, int slot) where T : class {
        return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(ptr), slot * IntPtr.Size), typeof(T)) as T;
    }
    void Initialize() {
        if (initialized) return; initialized = true;
        IntPtr factory = IntPtr.Zero;
        try {
            Guid id = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
            if (CreateDXGIFactory1(ref id, out factory) >= 0) {
                var enumerate = Vtable<EnumAdapter>(factory, 12);
                for (uint index=0; index<16; index++) {
                    IntPtr adapter;
                    if (enumerate(factory, index, out adapter) < 0) break;
                    try {
                        AdapterDesc description;
                        if (Vtable<GetDesc>(adapter, 10)(adapter, out description) >= 0 && (description.Flags & 2) == 0) {
                            adapters.Add(new GpuSnapshot { Name=description.Description.Trim(), MemoryTotal=description.DedicatedVideo.ToUInt64(),
                                Luid="luid_0x"+unchecked((uint)description.High).ToString("x8")+"_0x"+description.Low.ToString("x8") });
                        }
                    } finally { Marshal.Release(adapter); }
                }
            }
        } catch (COMException) { } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
        finally { if (factory != IntPtr.Zero) Marshal.Release(factory); }
        if (PdhOpenQuery(null, IntPtr.Zero, out query) == 0) {
            if (PdhAddEnglishCounter(query, @"\GPU Engine(*)\Utilization Percentage", IntPtr.Zero, out usageCounter) != 0) usageCounter = IntPtr.Zero;
            if (PdhAddEnglishCounter(query, @"\GPU Adapter Memory(*)\Dedicated Usage", IntPtr.Zero, out memoryCounter) != 0) memoryCounter = IntPtr.Zero;
            if (PdhAddEnglishCounter(query, @"\GPU Adapter Memory(*)\Shared Usage", IntPtr.Zero, out sharedMemoryCounter) != 0) sharedMemoryCounter = IntPtr.Zero;
        }
    }
    static Dictionary<string,double> ReadCounter(IntPtr counter) {
        var result = new Dictionary<string,double>(StringComparer.OrdinalIgnoreCase);
        if (counter == IntPtr.Zero) return result;
        uint bytes=0, count=0;
        PdhGetFormattedCounterArray(counter, 0x200, ref bytes, ref count, IntPtr.Zero);
        if (bytes==0 || bytes>16*1024*1024) return result;
        IntPtr buffer = Marshal.AllocHGlobal((int)bytes);
        try {
            if (PdhGetFormattedCounterArray(counter, 0x200, ref bytes, ref count, buffer) != 0) return result;
            int stride = Marshal.SizeOf(typeof(CounterItem));
            for (int i=0;i<count;i++) {
                var item=(CounterItem)Marshal.PtrToStructure(IntPtr.Add(buffer,i*stride),typeof(CounterItem));
                if (item.Value.Status<=1 && !Double.IsNaN(item.Value.Value) && !Double.IsInfinity(item.Value.Value))
                    result[Marshal.PtrToStringUni(item.Name)] = Math.Max(0,item.Value.Value);
            }
        } finally { Marshal.FreeHGlobal(buffer); }
        return result;
    }
    internal ResourceSnapshot Sample() {
        lock(sync) {
            var snapshot=new ResourceSnapshot { Sampled=DateTime.UtcNow };
            if (disposed) return snapshot;
            Initialize();
            long idle,kernel,user;
            if (GetSystemTimes(out idle,out kernel,out user)) {
                long total=kernel+user;
                if (haveTimes && total>previousTotal) snapshot.Cpu=Math.Max(0,Math.Min(100,100d*(1-(idle-previousIdle)/(double)(total-previousTotal))));
                previousIdle=idle; previousTotal=total; haveTimes=true;
            }
            var memory=new MemoryStatus { Length=(uint)Marshal.SizeOf(typeof(MemoryStatus)) };
            if (GlobalMemoryStatusEx(ref memory)) { snapshot.TotalMemory=memory.TotalPhysical; snapshot.AvailableMemory=memory.AvailablePhysical; }
            var perf=new PerformanceInfo { Size=(uint)Marshal.SizeOf(typeof(PerformanceInfo)) };
            if (GetPerformanceInfo(ref perf,perf.Size)) snapshot.CommitAvailable=(perf.CommitLimit.ToUInt64()-perf.CommitTotal.ToUInt64())*(double)perf.PageSize.ToUInt64();
            try {
                using (var curProc = Process.GetCurrentProcess()) {
                    snapshot.AppRamBytes = curProc.WorkingSet64;
                }
            } catch { }
            try { snapshot.CpuName = Convert.ToString(Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString", "")); } catch (System.Security.SecurityException) { }
            var usage=new Dictionary<string,double>(); var used=new Dictionary<string,double>(); var shared=new Dictionary<string,double>();
            if (query!=IntPtr.Zero && PdhCollectQueryData(query)==0) {
                if (haveGpuSample) usage=ReadCounter(usageCounter);
                used=ReadCounter(memoryCounter);
                shared=ReadCounter(sharedMemoryCounter);
                haveGpuSample=true;
            }
            double? nvTemp, nvPower;
            NvmlProbe.TrySample(out nvTemp, out nvPower);
            foreach(var adapter in adapters) {
                var gpu=new GpuSnapshot { Name=adapter.Name,Luid=adapter.Luid,MemoryTotal=adapter.MemoryTotal };
                var engines=usage.Where(kv=>kv.Key.IndexOf(adapter.Luid,StringComparison.OrdinalIgnoreCase)>=0)
                    .GroupBy(kv=>Regex.Match(kv.Key,@"_eng_\d+",RegexOptions.IgnoreCase).Value).Select(g=>g.Sum(v=>v.Value)).ToArray();
                if(engines.Length>0) gpu.Usage=Math.Min(100,engines.Max());
                var counters=used.Where(kv=>kv.Key.IndexOf(adapter.Luid,StringComparison.OrdinalIgnoreCase)>=0).ToArray();
                if(counters.Length>0) gpu.MemoryUsed=counters.Sum(kv=>kv.Value);
                var shCounters=shared.Where(kv=>kv.Key.IndexOf(adapter.Luid,StringComparison.OrdinalIgnoreCase)>=0).ToArray();
                if(shCounters.Length>0) gpu.SharedMemoryUsed=shCounters.Sum(kv=>kv.Value);
                if (adapter.Name != null && adapter.Name.IndexOf("NVIDIA", StringComparison.OrdinalIgnoreCase) >= 0) {
                    gpu.TemperatureC = nvTemp;
                    gpu.PowerWatts = nvPower;
                }
                snapshot.Gpus.Add(gpu);
            }
            var distinct=snapshot.Gpus.GroupBy(g=>g.Name+"|"+g.MemoryTotal).SelectMany(group=>{
                var measured=group.Where(g=>g.Usage.HasValue||g.MemoryUsed.HasValue).ToArray();
                return (measured.Length>0?measured:group.ToArray()).GroupBy(g=>g.Luid).Select(g=>g.First());
            }).ToArray();
            snapshot.Gpus.Clear();snapshot.Gpus.AddRange(distinct);
            return snapshot;
        }
    }
    public void Dispose() { lock(sync) { disposed=true; if(query!=IntPtr.Zero) PdhCloseQuery(query); query=IntPtr.Zero; } }
}

sealed class MemoryEstimate {
    internal long Count;
    internal int Bands;
    internal double BaseBytes, LowBytes, HighBytes, GpuBytes, ReductionBytes;
    internal bool UpperBound;
}
static class Budget {
    const double GiB=1073741824d;
    internal static MemoryEstimate FromCounts(long count,int bands,int workers,bool reduce) {
        var rest=new[]{0,9,24,45,72}[Math.Max(0,Math.Min(4,bands))];
        double basic=count*(14d+rest)*4;
        double shBytes=count*rest*4d;
        double resident=shBytes<=2*GiB?shBytes:2*Math.Min(128*1024*1024d,4000000d*rest*4);
        return new MemoryEstimate { Count=count,Bands=bands,BaseBytes=basic,
            LowBytes=basic*1.15+count*24d+256*1024*1024,
            HighBytes=basic*1.65+count*64d+(256+Math.Min(workers,8)*64d)*1024*1024,
            GpuBytes=bands>0 ? resident+count*12d+64*1024*1024 : 0 };
    }
    internal static MemoryEstimate Estimate(Job job) {
        if(!job.Format.Sog && job.Keep==100) return null;
        long total=0; int maxBands=0; double reduction=0; bool upper=false;
        foreach(var file in job.Inputs) {
            var meta=Metadata(file.Path); if(meta==null) return null;
            int bands=(int)meta[1];
            foreach(var op in file.Ops) { if(op.Step.Flag=="--filter-harmonics") bands=Math.Min(bands,Int32.Parse(op.Value,CultureInfo.InvariantCulture)); else if(op.Step.Flag.StartsWith("--filter")) upper=true; }
            total=checked(total+meta[0]); maxBands=Math.Max(maxBands,bands);
            reduction += meta[0]*(14d+new[]{0,9,24,45,72}[Math.Max(0,Math.Min(4,bands))])*4*2.0;
        }
        foreach(var op in job.Ops) { if(op.Step.Flag=="--filter-harmonics") maxBands=Math.Min(maxBands,Int32.Parse(op.Value,CultureInfo.InvariantCulture)); else if(op.Step.Flag.StartsWith("--filter")) upper=true; }
        long output=(long)Math.Max(1,Math.Round(total*job.Keep/100d));
        var estimate=FromCounts(output,maxBands,job.Workers,false); estimate.UpperBound=upper;
        if(job.Keep<100) { estimate.ReductionBytes=reduction; estimate.LowBytes=Math.Max(estimate.LowBytes,reduction+256*1024*1024); estimate.HighBytes=Math.Max(estimate.HighBytes,reduction*1.5+512*1024*1024); }
        return estimate;
    }
    internal static List<string> Assess(MemoryEstimate estimate,ResourceSnapshot resources,string device) {
        var risks=new List<string>();
        if(estimate==null || resources==null || resources.Sampled==default(DateTime) || (DateTime.UtcNow-resources.Sampled).TotalSeconds>15) return risks;
        if(resources.TotalMemory>0 && estimate.HighBytes>resources.AvailableMemory*0.88) risks.Add("ram");
        if(resources.CommitAvailable>=0 && estimate.LowBytes>resources.CommitAvailable*0.9) risks.Add("commit");
        // With auto selection, warn only if every known adapter has reliable, insufficient headroom.
        if(device!="cpu" && estimate.GpuBytes>0 && resources.Gpus.Count>0 && resources.Gpus.All(g=>g.MemoryTotal>0 && g.MemoryUsed.HasValue && estimate.GpuBytes>(g.MemoryTotal-g.MemoryUsed.Value)*0.9)) risks.Add("vram");
        return risks;
    }
    static long[] Metadata(string path) {
        try {
            using(var stream=File.OpenRead(path)) {
                string extension=Path.GetExtension(path).ToLowerInvariant();
                if(extension==".splat") return stream.Length%32==0 ? new[]{stream.Length/32,0L} : null;
                if(extension==".ply") {
                    byte[] header=new byte[Math.Min(1048576,(int)Math.Min(stream.Length,1048576))];
                    int read=stream.Read(header,0,header.Length);
                    string text=System.Text.Encoding.ASCII.GetString(header,0,read);
                    int end=text.IndexOf("end_header",StringComparison.Ordinal);if(end<0)return null;
                    using(var reader=new StringReader(text.Substring(0,end)+"end_header\n")) {
                        if(reader.ReadLine()!="ply") return null;
                        long count=0; int rest=0,bytes=4; bool vertex=false,compressed=false;
                        string line;
                        while((line=reader.ReadLine())!=null && (bytes+=line.Length+1)<1048576) {
                            string[] words=line.Split(new[]{' '},StringSplitOptions.RemoveEmptyEntries);
                            if(words.Length>=3 && words[0]=="element") { vertex=words[1]=="vertex"; if(vertex) Int64.TryParse(words[2],out count); }
                            if(vertex && words.Length>=3 && words[0]=="property" && words[2].StartsWith("f_rest_")) rest++;
                            if(words.Length>=3 && words[0]=="property" && words[2]=="packed_position") compressed=true;
                            if(line=="end_header") return count>0 && !compressed ? new[]{count,(long)(rest>=72?4:rest>=45?3:rest>=24?2:rest>=9?1:0)} : null;
                        }
                    }
                }
                if(extension==".sog") {
                    using(var zip=new ZipArchive(stream,ZipArchiveMode.Read)) {
                        var entry=zip.GetEntry("meta.json"); if(entry==null || entry.Length>1048576) return null;
                        using(var reader=new StreamReader(entry.Open())) {
                            var json=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(reader.ReadToEnd());
                            object value; if(!json.TryGetValue("count",out value)) return null;
                            long count=Convert.ToInt64(value,CultureInfo.InvariantCulture); int bands=0;
                            if(json.TryGetValue("shN",out value) && value is Dictionary<string,object>) {
                                var sh=(Dictionary<string,object>)value; if(sh.ContainsKey("bands")) bands=Convert.ToInt32(sh["bands"],CultureInfo.InvariantCulture); else return null;
                            }
                            return count>0 && bands>=0 && bands<=4 ? new[]{count,(long)bands} : null;
                        }
                    }
                }
            }
        } catch(IOException) { } catch(InvalidDataException) { } catch(UnauthorizedAccessException) { } catch(ArgumentException) { } catch(InvalidOperationException) { } catch(OverflowException) { }
        return null;
    }
    internal static string Describe(MemoryEstimate estimate,ResourceSnapshot resources) {
        if(estimate==null) return "";
        var lines=new List<string> { estimate.Count.ToString("N0")+" · SH "+estimate.Bands+(estimate.UpperBound?" · "+I18n.T("app.metrics.upperBound"):""),
            I18n.T("app.metrics.baseMemory")+": "+GB(estimate.BaseBytes),I18n.T("app.metrics.estimatedMemory")+": "+GB(estimate.LowBytes)+" – "+GB(estimate.HighBytes) };
        if(resources!=null) {
            lines.Add(I18n.T("app.metrics.memory")+" · "+I18n.T("app.metrics.available")+": "+GB(resources.AvailableMemory));
            if(resources.CommitAvailable>=0) lines.Add(I18n.T("app.metrics.commit")+": "+GB(resources.CommitAvailable));
            foreach(var gpu in resources.Gpus.Where(g=>g.MemoryTotal>0&&g.MemoryUsed.HasValue))
                lines.Add(gpu.Name+" · "+I18n.T("app.metrics.vram")+" · "+I18n.T("app.metrics.available")+": "+GB(Math.Max(0,gpu.MemoryTotal-gpu.MemoryUsed.Value)));
        }
        lines.Add("");lines.Add(I18n.T("app.metrics.estimateNote"));return String.Join("\n",lines);
    }
    internal static long[] EstimateOutputBytes(IList<InputFile> inputs, Format format, int keepPct, int? shLimit, int webpEffort) {
        if (inputs == null || inputs.Count == 0 || format == null) return null;
        long totalPts = 0; int maxBands = 0; bool any = false;
        foreach (var inp in inputs) {
            var m = Metadata(inp.Path);
            if (m != null) {
                any = true;
                totalPts += m[0];
                int b = (int)m[1];
                if (shLimit.HasValue) b = Math.Min(b, shLimit.Value);
                maxBands = Math.Max(maxBands, b);
            }
        }
        if (!any || totalPts <= 0) return null;
        double outPts = Math.Max(1d, totalPts * (keepPct / 100d));
        int shCoeffs = new[] { 0, 9, 24, 45, 72 }[Math.Max(0, Math.Min(4, maxBands))];
        double lowBpp, highBpp;
        if (format.Suffix == ".ply") {
            double bpp = (14 + shCoeffs) * 4d;
            lowBpp = bpp * 0.98; highBpp = bpp * 1.03;
        } else if (format.Suffix == ".compressed.ply") {
            double bpp = 16d + shCoeffs;
            lowBpp = bpp * 0.90; highBpp = bpp * 1.15;
        } else if (format.Suffix == ".spz") {
            double bpp = 16d + shCoeffs * 0.55;
            lowBpp = bpp * 0.45; highBpp = bpp * 0.80;
        } else if (format.Suffix == ".sog" || format.Suffix == ".html") {
            double effScale = webpEffort >= 6 ? 0.90 : (webpEffort == 0 ? 1.12 : 1.0);
            double baseBpp = 10.5 + (maxBands == 0 ? 0 : maxBands == 1 ? 3.5 : maxBands == 2 ? 6.5 : 10.0);
            lowBpp = baseBpp * 0.72 * effScale; highBpp = baseBpp * 1.18 * effScale;
        } else if (format.Suffix == ".csv") {
            double bpp = (14 + shCoeffs) * 10d;
            lowBpp = bpp * 0.85; highBpp = bpp * 1.25;
        } else {
            // Voxel zip
            lowBpp = 0.8; highBpp = 3.5;
        }
        long overhead = format.Suffix == ".html" ? 1800000L : 65536L;
        return new long[] { (long)(outPts * lowBpp) + overhead, (long)(outPts * highBpp) + overhead };
    }
    internal static string GB(double bytes) { return (bytes/GiB).ToString("0.00",CultureInfo.InvariantCulture)+" GB"; }
}

sealed class Diagnostic {
    internal string Code,TitleKey,DetailKey,AdviceKey;
    internal string Text { get { return I18n.T(TitleKey)+"\n\n"+(DetailKey==null?"":I18n.T(DetailKey)+"\n\n")+I18n.T(AdviceKey); } }
}
static class Diagnostics {
    internal static Diagnostic Classify(Exception error,string device) {
        string text=error.ToString().ToLowerInvariant();
        if(Regex.IsMatch(text,@"enospc|disk full|not enough space|磁盘空间|0x80070070")) return New("disk","app.errors.diskTitle",null,"app.errors.diskAdvice");
        if(Regex.IsMatch(text,@"gpu.*(out.of.memory|oom)|out.of.memory.*gpu|device.lost|no gpu adapter|webgpu|d3d12|vulkan|gpu device|maxstoragebufferbindingsize")) return New("gpu-memory","app.errors.gpuTitle",null,"app.dialogs.gpuAdvice");
        if(error is OutOfMemoryException || Regex.IsMatch(text,@"array buffer allocation failed|invalid array length|heap out of memory|allocation failed|bad_alloc|cannot allocate memory|enomem|0xc0000017|0xc000009a")) return New("memory","app.errors.memoryTitle","app.errors.memoryDetail","app.dialogs.memoryAdvice");
        if(error is UnauthorizedAccessException || Regex.IsMatch(text,@"eacces|eperm|permission denied|access.*denied|being used by another|sharing violation|0x80070020")) return New("access","app.errors.accessTitle",null,"app.errors.accessAdvice");
        if(Regex.IsMatch(text,@"no gaussians|no points|zero gaussians|remove every gaussian|after filtering")) return New("empty","app.errors.emptyTitle",null,"app.errors.emptyAdvice");
        if(error is FileNotFoundException || error is DirectoryNotFoundException || error is InvalidDataException || Regex.IsMatch(text,@"enoent|invalid.*(ply|header|file)|missing.*(property|column)|unexpected end|unsupported.*format")) return New("input","app.errors.inputTitle",null,"app.errors.inputAdvice");
        return New("unknown","app.status.failed",null,"app.errors.unknownAdvice");
    }
    static Diagnostic New(string code,string title,string detail,string advice) { return new Diagnostic {Code=code,TitleKey=title,DetailKey=detail,AdviceKey=advice}; }
}

enum TelemetryMode { IdleWindow, Recording, FrozenRun }

sealed class TelemetrySample {
    internal DateTime Timestamp;
    internal double CpuPct, RamPct, RamUsedGiB, RamTotalGiB, GpuPct, VramPct, VramUsedGiB, VramTotalGiB;
    internal bool IsCompressing;
}

sealed class TelemetrySnapshot {
    internal TelemetrySample[] Points;
    internal int StartIndex;   // Exact index where compression started (-1 if none)
    internal int EndIndex;     // Exact index where compression ended (-1 if still running or none)
    internal TelemetryMode Mode;
}

sealed class TelemetryHistory {
    const int IdleWindowCapacity = 120;      // 60s at 0.5s interval
    const int PreStartBaselineSamples = 12;  // Keep ~6s of idle baseline right before compression starts
    const int MaxSessionSamples = 3600;      // Downsample cleanly if run exceeds 30 minutes at 0.5s
    readonly List<TelemetrySample> liveIdleBuffer = new List<TelemetrySample>();
    readonly List<TelemetrySample> sessionBuffer = new List<TelemetrySample>();
    TelemetryMode mode = TelemetryMode.IdleWindow;
    int startIndex = -1;
    int endIndex = -1;

    internal void MarkCompressionStarted() {
        lock (liveIdleBuffer) {
            sessionBuffer.Clear();
            int skip = Math.Max(0, liveIdleBuffer.Count - PreStartBaselineSamples);
            for (int i = skip; i < liveIdleBuffer.Count; i++) {
                var p = liveIdleBuffer[i];
                sessionBuffer.Add(new TelemetrySample {
                    Timestamp = p.Timestamp, CpuPct = p.CpuPct, RamPct = p.RamPct,
                    RamUsedGiB = p.RamUsedGiB, RamTotalGiB = p.RamTotalGiB,
                    GpuPct = p.GpuPct, VramPct = p.VramPct,
                    VramUsedGiB = p.VramUsedGiB, VramTotalGiB = p.VramTotalGiB,
                    IsCompressing = false
                });
            }
            // Exact boundary point: the last idle baseline point is where the vertical dashed line sits,
            // so every segment strictly AFTER startIndex is colored active, and strictly BEFORE is idle!
            startIndex = sessionBuffer.Count > 0 ? sessionBuffer.Count - 1 : 0;
            endIndex = -1;
            mode = TelemetryMode.Recording;
        }
    }

    internal void MarkCompressionEnded() {
        lock (liveIdleBuffer) {
            if (mode == TelemetryMode.Recording) {
                endIndex = Math.Max(startIndex, sessionBuffer.Count - 1);
                mode = TelemetryMode.FrozenRun;
            }
        }
    }

    internal void Add(ResourceSnapshot r, bool isCompressing) {
        if (r == null) return;
        var gpu = r.Gpus.OrderByDescending(g => g.Usage ?? -1).FirstOrDefault();
        double ramUsed = r.TotalMemory > 0 ? Math.Max(0, r.TotalMemory - r.AvailableMemory) : 0;
        double ramPct = r.TotalMemory > 0 ? Math.Max(0, Math.Min(100, (ramUsed / r.TotalMemory) * 100d)) : 0;
        double vramUsed = gpu != null && gpu.MemoryUsed.HasValue ? gpu.MemoryUsed.Value : 0;
        double vramTotal = gpu != null ? gpu.MemoryTotal : 0;
        double vramPct = vramTotal > 0 ? Math.Max(0, Math.Min(100, (vramUsed / vramTotal) * 100d)) : 0;

        var sample = new TelemetrySample {
            Timestamp = r.Sampled,
            CpuPct = r.Cpu.HasValue ? Math.Max(0, Math.Min(100, r.Cpu.Value)) : 0,
            RamPct = ramPct,
            RamUsedGiB = ramUsed / 1073741824d,
            RamTotalGiB = r.TotalMemory / 1073741824d,
            GpuPct = gpu != null && gpu.Usage.HasValue ? Math.Max(0, Math.Min(100, gpu.Usage.Value)) : 0,
            VramPct = vramPct,
            VramUsedGiB = vramUsed / 1073741824d,
            VramTotalGiB = vramTotal / 1073741824d,
            IsCompressing = isCompressing
        };

        lock (liveIdleBuffer) {
            if (!isCompressing) {
                liveIdleBuffer.Add(sample);
                while (liveIdleBuffer.Count > IdleWindowCapacity) liveIdleBuffer.RemoveAt(0);
            }
            if (mode == TelemetryMode.Recording) {
                // Never evict left-side idle baseline or compression samples; X-axis stretches to fit entire run!
                sessionBuffer.Add(sample);
                if (sessionBuffer.Count > MaxSessionSamples) CompressSessionBuffer();
            }
        }
    }

    void CompressSessionBuffer() {
        // Pairwise peak-preserving downsample on the active tail only, keeping pre-start baseline intact
        if (sessionBuffer.Count <= startIndex + 4) return;
        var next = new List<TelemetrySample>(sessionBuffer.Count / 2 + PreStartBaselineSamples + 4);
        for (int i = 0; i <= startIndex && i < sessionBuffer.Count; i++) next.Add(sessionBuffer[i]);
        for (int i = startIndex + 1; i < sessionBuffer.Count; i += 2) {
            var a = sessionBuffer[i];
            if (i + 1 >= sessionBuffer.Count) { next.Add(a); break; }
            var b = sessionBuffer[i + 1];
            next.Add(new TelemetrySample {
                Timestamp = b.Timestamp,
                CpuPct = Math.Max(a.CpuPct, b.CpuPct),
                RamPct = Math.Max(a.RamPct, b.RamPct),
                RamUsedGiB = Math.Max(a.RamUsedGiB, b.RamUsedGiB),
                RamTotalGiB = b.RamTotalGiB,
                GpuPct = Math.Max(a.GpuPct, b.GpuPct),
                VramPct = Math.Max(a.VramPct, b.VramPct),
                VramUsedGiB = Math.Max(a.VramUsedGiB, b.VramUsedGiB),
                VramTotalGiB = b.VramTotalGiB,
                IsCompressing = a.IsCompressing || b.IsCompressing
            });
        }
        sessionBuffer.Clear();
        sessionBuffer.AddRange(next);
    }

    internal TelemetrySnapshot Snapshot() {
        lock (liveIdleBuffer) {
            if (mode == TelemetryMode.IdleWindow) {
                return new TelemetrySnapshot {
                    Points = liveIdleBuffer.ToArray(),
                    StartIndex = -1,
                    EndIndex = -1,
                    Mode = TelemetryMode.IdleWindow
                };
            }
            return new TelemetrySnapshot {
                Points = sessionBuffer.ToArray(),
                StartIndex = startIndex,
                EndIndex = endIndex,
                Mode = mode
            };
        }
    }
}
