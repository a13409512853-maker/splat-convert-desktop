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
    internal double? Usage, MemoryUsed;
    internal double MemoryTotal;
}
sealed class ResourceSnapshot {
    internal DateTime Sampled;
    internal double? Cpu;
    internal double TotalMemory, AvailableMemory, CommitAvailable = -1;
    internal readonly List<GpuSnapshot> Gpus = new List<GpuSnapshot>();
    internal string CpuName = "", Note = "";
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
    IntPtr query, usageCounter, memoryCounter;
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
            try { snapshot.CpuName = Convert.ToString(Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString", "")); } catch (System.Security.SecurityException) { }
            var usage=new Dictionary<string,double>(); var used=new Dictionary<string,double>();
            if (query!=IntPtr.Zero && PdhCollectQueryData(query)==0) {
                if (haveGpuSample) usage=ReadCounter(usageCounter);
                used=ReadCounter(memoryCounter); haveGpuSample=true;
            }
            foreach(var adapter in adapters) {
                var gpu=new GpuSnapshot { Name=adapter.Name,Luid=adapter.Luid,MemoryTotal=adapter.MemoryTotal };
                var engines=usage.Where(kv=>kv.Key.IndexOf(adapter.Luid,StringComparison.OrdinalIgnoreCase)>=0)
                    .GroupBy(kv=>Regex.Match(kv.Key,@"_eng_\d+",RegexOptions.IgnoreCase).Value).Select(g=>g.Sum(v=>v.Value)).ToArray();
                if(engines.Length>0) gpu.Usage=Math.Min(100,engines.Max());
                var counters=used.Where(kv=>kv.Key.IndexOf(adapter.Luid,StringComparison.OrdinalIgnoreCase)>=0).ToArray();
                if(counters.Length>0) gpu.MemoryUsed=counters.Sum(kv=>kv.Value);
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
        var rest=new[]{0,9,24,45}[Math.Max(0,Math.Min(3,bands))];
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
            reduction += meta[0]*(14d+new[]{0,9,24,45}[bands])*4*2.0;
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
                            if(line=="end_header") return count>0 && !compressed ? new[]{count,(long)(rest>=45?3:rest>=24?2:rest>=9?1:0)} : null;
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
                            return count>0 && bands>=0 && bands<=3 ? new[]{count,(long)bands} : null;
                        }
                    }
                }
            }
        } catch(IOException) { } catch(InvalidDataException) { } catch(UnauthorizedAccessException) { } catch(ArgumentException) { } catch(InvalidOperationException) { } catch(OverflowException) { }
        return null;
    }
    internal static string Describe(MemoryEstimate estimate,ResourceSnapshot resources) {
        if(estimate==null) return "";
        var lines=new List<string> { estimate.Count.ToString("N0")+" · SH "+estimate.Bands+(estimate.UpperBound?" · "+I18n.T("upperBound"):""),
            I18n.T("baseMemory")+": "+GB(estimate.BaseBytes),I18n.T("estimatedMemory")+": "+GB(estimate.LowBytes)+" – "+GB(estimate.HighBytes) };
        if(resources!=null) {
            lines.Add(I18n.T("memory")+" · "+I18n.T("available")+": "+GB(resources.AvailableMemory));
            if(resources.CommitAvailable>=0) lines.Add(I18n.T("commit")+": "+GB(resources.CommitAvailable));
            foreach(var gpu in resources.Gpus.Where(g=>g.MemoryTotal>0&&g.MemoryUsed.HasValue))
                lines.Add(gpu.Name+" · "+I18n.T("vram")+" · "+I18n.T("available")+": "+GB(Math.Max(0,gpu.MemoryTotal-gpu.MemoryUsed.Value)));
        }
        lines.Add("");lines.Add(I18n.T("estimateNote"));return String.Join("\n",lines);
    }
    internal static string GB(double bytes) { return (bytes/GiB).ToString("0.00",CultureInfo.InvariantCulture)+" GiB"; }
}

sealed class Diagnostic {
    internal string Code,TitleKey,DetailKey,AdviceKey;
    internal string Text { get { return I18n.T(TitleKey)+"\n\n"+(DetailKey==null?"":I18n.T(DetailKey)+"\n\n")+I18n.T(AdviceKey); } }
}
static class Diagnostics {
    internal static Diagnostic Classify(Exception error,string device) {
        string text=error.ToString().ToLowerInvariant();
        if(Regex.IsMatch(text,@"enospc|disk full|not enough space|磁盘空间|0x80070070")) return New("disk","diskTitle",null,"diskAdvice");
        if(Regex.IsMatch(text,@"gpu.*(out.of.memory|oom)|out.of.memory.*gpu|device.lost|no gpu adapter|webgpu|d3d12|vulkan|gpu device|maxstoragebufferbindingsize")) return New("gpu-memory","gpuTitle",null,"gpuAdvice");
        if(error is OutOfMemoryException || Regex.IsMatch(text,@"array buffer allocation failed|invalid array length|heap out of memory|allocation failed|bad_alloc|cannot allocate memory|enomem|0xc0000017|0xc000009a")) return New("memory","memoryTitle","memoryDetail","memoryAdvice");
        if(error is UnauthorizedAccessException || Regex.IsMatch(text,@"eacces|eperm|permission denied|access.*denied|being used by another|sharing violation|0x80070020")) return New("access","accessTitle",null,"accessAdvice");
        if(Regex.IsMatch(text,@"no gaussians|no points|zero gaussians|remove every gaussian|after filtering")) return New("empty","emptyTitle",null,"emptyAdvice");
        if(error is FileNotFoundException || error is DirectoryNotFoundException || error is InvalidDataException || Regex.IsMatch(text,@"enoent|invalid.*(ply|header|file)|missing.*(property|column)|unexpected end|unsupported.*format")) return New("input","inputTitle",null,"inputAdvice");
        return New("unknown","failed",null,"unknownAdvice");
    }
    static Diagnostic New(string code,string title,string detail,string advice) { return new Diagnostic {Code=code,TitleKey=title,DetailKey=detail,AdviceKey=advice}; }
}
