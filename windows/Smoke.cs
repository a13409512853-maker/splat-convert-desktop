using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Smoke {
    internal static int Layout(string folder) {
        Directory.CreateDirectory(folder); I18n.Language="zh";
        using(var ui=new MainWindow(new string[0])) {
            var timer=new System.Windows.Forms.Timer {Interval=4000};
            timer.Tick+=(s,e)=>{
                timer.Stop();ui.SetLanguage("zh");ui.PerformLayout();ui.Refresh();Application.DoEvents();
                File.WriteAllLines(Path.Combine(folder,"bounds.txt"),Descendants(ui).Select(c=>c.GetType().Name+" "+c.AccessibleName+" text="+c.Text+" bounds="+c.Bounds+" visible="+c.Visible+" screen="+ui.PointToClient(c.PointToScreen(Point.Empty))));
                Capture(ui,Path.Combine(folder,"window.png"));
                ui.Size=ui.MinimumSize;
                foreach(string code in I18n.Codes){ui.SetLanguage(code);ui.PerformLayout();ui.Refresh();Application.DoEvents();Capture(ui,Path.Combine(folder,"minimum-"+code+".png"));}
                ui.Close();
            };
            timer.Start();Application.Run(ui);timer.Dispose();
        }
        return 0;
    }
    static void Capture(Form window,string path) {
        window.Refresh();Application.DoEvents();
        using(var bitmap=new Bitmap(window.Width,window.Height)) {
            window.DrawToBitmap(bitmap,new Rectangle(Point.Empty,window.Size));
            bitmap.Save(path,ImageFormat.Png);
        }
    }
    public static int Run(string folder) {
        Directory.CreateDirectory(folder);
        using (var log = new StreamWriter(Path.Combine(folder, "self-test.log"), false, Encoding.UTF8) { AutoFlush = true }) {
            int failures = 0;
            try { HealthTests.Run(folder, log.WriteLine); } catch(Exception ex) { failures++; log.WriteLine(ex); }
            using (var monitor = new ResourceMonitor()) {
                var first = monitor.Sample(); Thread.Sleep(600); var measured = monitor.Sample();
                if (measured.TotalMemory <= 0 || measured.AvailableMemory <= 0 || !measured.Cpu.HasValue) { failures++; log.WriteLine("FAIL live CPU / RAM sampling"); }
                else log.WriteLine("PASS live metrics: CPU=" + measured.Cpu + "; RAM=" + measured.AvailableMemory + "/" + measured.TotalMemory + "; commit=" + measured.CommitAvailable + "; GPUs=" + String.Join(";",measured.Gpus.Select(g=>g.Name+" usage="+g.Usage+" vram="+g.MemoryUsed+"/"+g.MemoryTotal)));
            }
            string ply = Path.Combine(folder, "测试 样本.ply");
            Fixture(ply, 2048, true);
            using (var ui = new MainWindow(new[] { ply })) {
                try {
                    ui.PromptMarker = Path.Combine(folder, "ui-star-marker");
                    int promptCount = 0;
                    ui.PromptOverride = () => promptCount++;
                    ui.ErrorOverride = (diagnostic, details) => log.WriteLine("GUI ERROR " + diagnostic.Code + ": " + details);
                    ui.WarningOverride = text => { log.WriteLine("GUI WARNING " + text); return true; };
                    ui.Show(); Application.DoEvents(); ui.Refresh();
                    var warmup=Stopwatch.StartNew();while(warmup.ElapsedMilliseconds<9000 && (ui.LastResources==null||!ui.LastResources.Cpu.HasValue)){Application.DoEvents();Thread.Sleep(20);}
                    var formats = Descendants(ui).OfType<ComboBox>().Single(b => b.AccessibleName == "format");
                    if (!formats.Text.StartsWith("SOG")) throw new InvalidOperationException("Default format mismatch");
                    formats.SelectedIndex = Converter.Formats.Length - 1;
                    if (!formats.Text.StartsWith("体素") || !Descendants(ui).OfType<TrackBar>().Any(t => t.Visible && t.AccessibleName == "voxel"))
                        throw new InvalidOperationException("Voxel controls are not visible");
                    formats.SelectedIndex = 0;
                    foreach(string language in I18n.Codes) {
                        ui.SetLanguage(language); Application.DoEvents();
                        if(Descendants(ui).OfType<Button>().Single(b=>b.AccessibleName=="start").Text!=I18n.T("start")) throw new IOException("Language switch failed: "+language);
                        Capture(ui,Path.Combine(folder,"interface-"+language+".png"));
                    }
                    ui.SetLanguage("zh");
                    Button button = Descendants(ui).OfType<Button>().Single(b => b.AccessibleName == "start");
                    if (!button.Visible || !button.Enabled || button.Width < 60) throw new InvalidOperationException("Start button is not actionable");
                    string output = Path.Combine(folder, "界面 测试.sog");
                    Descendants(ui).OfType<TextBox>().Single(t => t.AccessibleName == "output").Text = output;
                    button.PerformClick();
                    var timer = Stopwatch.StartNew();
                    while (!button.Enabled && timer.ElapsedMilliseconds < 30000) { Application.DoEvents(); Thread.Sleep(20); }
                    if (!File.Exists(output) || new FileInfo(output).Length == 0) throw new IOException(Descendants(ui).OfType<TextBox>().Single(t => t.AccessibleName == "log").Text);
                    if (promptCount != 1 || StarPrompt.TryClaim(ui.PromptMarker)) throw new IOException("One-time star prompt failed");
                    if (!Descendants(ui).OfType<LinkLabel>().Any(x => x.Text == App.Repository)) throw new IOException("Repository link missing");
                    int warnings=0;
                    ui.ResourceOverride=()=>new ResourceSnapshot {Sampled=DateTime.UtcNow,TotalMemory=16e9,AvailableMemory=1,CommitAvailable=1};
                    ui.WarningOverride=text=>{warnings++;return false;};
                    Descendants(ui).OfType<TextBox>().Single(t=>t.AccessibleName=="output").Text=Path.Combine(folder,"must-not-exist.sog");
                    button.PerformClick();timer.Restart();while(!button.Enabled&&timer.ElapsedMilliseconds<10000){Application.DoEvents();Thread.Sleep(20);}
                    if(warnings!=1||File.Exists(Path.Combine(folder,"must-not-exist.sog")))throw new IOException("Preflight did not return to settings safely");
                    log.WriteLine("PASS preflight insufficient-resource dialog and return without converting");
                    ui.Close();
                    log.WriteLine("PASS window layout, repository link, default GUI conversion and one-time star prompt");
                } catch (Exception ex) { failures++; log.WriteLine("FAIL window test: " + ex); }
            }
            string invalid=Path.Combine(folder,"invalid-source.ply");File.WriteAllText(invalid,"not a PLY file\n");
            using(var ui=new MainWindow(new[]{invalid})) {
                int errors=0;ui.ErrorOverride=(d,raw)=>{errors++;if(!raw.Contains("Engine: 3.10.3"))throw new IOException("Diagnostic lacks version");};
                ui.PromptMarker=Path.Combine(folder,"must-not-prompt");ui.WarningOverride=text=>true;ui.Show();Application.DoEvents();
                Descendants(ui).OfType<TextBox>().Single(t=>t.AccessibleName=="output").Text=Path.Combine(folder,"invalid-output.sog");
                var button=Descendants(ui).OfType<Button>().Single(b=>b.AccessibleName=="start");button.PerformClick();var timer=Stopwatch.StartNew();
                while(!button.Enabled&&timer.ElapsedMilliseconds<20000){Application.DoEvents();Thread.Sleep(20);}
                if(errors!=1||File.Exists(ui.PromptMarker)||File.Exists(Path.Combine(folder,"invalid-output.sog"))){failures++;log.WriteLine("FAIL real engine failure notification");}
                else log.WriteLine("PASS real engine failure produces exactly one diagnostic and no success prompt");
                ui.Close();
            }
            using (var c = new Converter()) {
                foreach (var format in Converter.Formats) {
                    try {
                        var job = new Job { Format = format, Output = Path.Combine(folder, "输出 样本" + format.Suffix),
                            Overwrite = true, Device = format.Voxel ? "auto" : "cpu", Keep = format.Suffix == ".sog" ? 70 : 100, Iterations = 2,
                            Effort = format.Suffix == ".sog" ? 3 : -1, VoxelSize = "0.1" };
                        job.Inputs.Add(new InputFile(ply));
                        job.Inputs[0].Ops.Add(new Op { Step = Step.All[0], Value = "-0.1,0,0" });
                        if (format.Suffix == ".csv") {
                            job.Inputs.Add(new InputFile(ply));
                            job.Ops.Add(new Op { Step = Step.All[2], Value = "2" });
                        }
                        c.Convert(job, CancellationToken.None, log.WriteLine, log.WriteLine);
                        if (format.Voxel || format.Suffix == ".sog") {
                            using (var zip = ZipFile.OpenRead(job.Output)) {
                                string[] names = zip.Entries.Select(x => x.Name).ToArray();
                                if (format.Voxel && !(names.Any(x => x.EndsWith(".voxel.json")) && names.Any(x => x.EndsWith(".voxel.bin")))) throw new IOException("Missing voxel archive entries");
                                if (format.Suffix == ".sog" && (!names.Contains("meta.json") || !names.Any(x => x.EndsWith(".webp")))) throw new IOException("Missing SOG archive entries");
                            }
                        }
                        if (format.Suffix == ".csv" && File.ReadLines(job.Output).Count() != 4097) throw new IOException("Merge count mismatch");
                        log.WriteLine("PASS " + format.Suffix + " " + new FileInfo(job.Output).Length + " bytes");
                    } catch (Exception ex) { failures++; log.WriteLine("FAIL " + format.Suffix + ": " + ex); }
                }
                string large = Path.Combine(folder, "大文件 模拟.ply");
                try {
                    Fixture(large, 2000000, true);
                    var job = new Job { Format = Converter.Formats[0], Output = Path.Combine(folder, "大文件 模拟.sog"),
                        Overwrite = true, Device = "cpu", Workers = 2 };
                    job.Inputs.Add(new InputFile(large));
                    job.Ops.Add(new Op { Step = Step.All[4], Value = "0" });
                    c.Convert(job, CancellationToken.None, log.WriteLine, log.WriteLine);
                    log.WriteLine("PASS large conversion " + new FileInfo(large).Length + " -> " + new FileInfo(job.Output).Length);
                    var original = new FileInfo(job.Output).Length;
                    using (var cancel = new CancellationTokenSource()) {
                        try {
                            c.Convert(job, cancel.Token, log.WriteLine, s => { log.WriteLine(s); cancel.Cancel(); });
                            throw new IOException("Expected cancellation");
                        } catch (OperationCanceledException) { }
                    }
                    if (new FileInfo(job.Output).Length != original || Directory.GetDirectories(folder, ".splat-convert-*").Any()) throw new IOException("Cancellation affected output or left staging directory");
                    log.WriteLine("PASS cancellation and output preservation");
                } catch (Exception ex) { failures++; log.WriteLine("FAIL large file / cancellation: " + ex); }
            }
            log.WriteLine("Failures: " + failures);
            return failures == 0 ? 0 : 1;
        }
    }
    static System.Collections.Generic.IEnumerable<Control> Descendants(Control parent) {
        foreach (Control child in parent.Controls) {
            yield return child;
            foreach (Control sub in Descendants(child)) yield return sub;
        }
    }
    static void Fixture(string path, int count, bool harmonics) {
        var names = new[] { "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3" };
        if (harmonics) names = names.Concat(Enumerable.Range(0, 45).Select(i => "f_rest_" + i)).ToArray();
        string header = "ply\nformat binary_little_endian 1.0\nelement vertex " + count + "\n" +
            String.Join("\n", names.Select(n => "property float " + n)) + "\nend_header\n";
        using (var writer = new BinaryWriter(new BufferedStream(File.Create(path), 1024 * 1024))) {
            writer.Write(Encoding.ASCII.GetBytes(header));
            for (int i = 0; i < count; i++) {
                writer.Write((i % 127) * 0.025f); writer.Write(((i / 127) % 127) * 0.026f); writer.Write((i / 16129) * 0.027f + (i % 23) * 0.0005f);
                writer.Write((i % 7) / 20f); writer.Write((i % 11) / 20f); writer.Write((i % 17) / 20f); writer.Write(2f);
                writer.Write(-3.2f); writer.Write(-3.3f); writer.Write(-3.4f);
                writer.Write(1f); writer.Write(0f); writer.Write(0f); writer.Write(0f);
                if (harmonics) for (int j = 0; j < 45; j++) writer.Write((i % (j + 5) - 2) * 0.003f);
            }
        }
    }
}
