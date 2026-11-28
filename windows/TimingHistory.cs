using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

// Session-local observations only. Do not extrapolate archive size into decode time across codecs.
static class TimingHistory {
    sealed class Observation { public string Key; public long Bytes; public double Seconds; }
    static readonly List<Observation> records = new List<Observation>();
    static string Key(Job j) {
        return String.Join("|", new object[]{EngineManager.ActiveVersion, j.Format.Suffix, j.Device,j.Workers,j.Keep,j.Iterations,j.Effort,j.TargetMaxBytes,j.AdaptiveDecimate,j.SogVersion,j.ShColorError,j.VoxelSize,j.Opacity,j.SpzVersion,j.VoxelFloorFill,j.VoxelExternalFill,j.VoxelCarve,j.CollisionMesh,j.MinKeepPct,j.MaxAttempts,j.HtmlUnbundled,
            String.Join(";",j.Inputs.Select(i=>(i.Path.EndsWith(".compressed.ply",StringComparison.OrdinalIgnoreCase)?".compressed.ply":Path.GetExtension(i.Path))+":"+String.Join(",",i.Ops.Where(o=>o.Enabled).Select(o=>o.Step.Flag+o.Value)))),String.Join(",",j.Ops.Where(o=>o.Enabled).Select(o=>o.Step.Flag+o.Value))});
    }
    internal static void Record(Job j,double sec) {
        try { var o=new Observation {Key=Key(j),Bytes=j.Inputs.Sum(i=>new FileInfo(i.Path).Length),Seconds=sec};lock(records){records.Add(o); if(records.Count>96)records.RemoveAt(0);} }catch(IOException){}
    }
    internal static double? Estimate(Job j) {
        long bytes=j.Inputs.Sum(i=>new FileInfo(i.Path).Length); string key=Key(j);
        lock(records){var a=records.Where(o=>o.Key==key && o.Bytes>0 && bytes>=.7*o.Bytes && bytes<=1.4*o.Bytes).Select(o=>o.Seconds*bytes/o.Bytes).OrderBy(s=>s).ToArray();return a.Length==0 ? (double?)null : a[a.Length/2];}
    }
}
