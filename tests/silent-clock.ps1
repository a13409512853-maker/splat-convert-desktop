param([Parameter(Mandatory=$true)][string]$Exe)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$assembly = [Reflection.Assembly]::LoadFile((Resolve-Path $Exe))
$t = $assembly.GetType('MainWindow',$true)
$flags = [Reflection.BindingFlags]'Instance,NonPublic,Public'
$w = $t.GetConstructors($flags)[0].Invoke([object[]](,([string[]]@())))
try {
    $t.GetField('active',$flags).SetValue($w,[Threading.CancellationTokenSource]::new())
    $clock = $t.GetField('jobClock',$flags)
    if ($clock) { $clock.GetValue($w).Restart() }
    $label = $t.GetField('elapsedLabel',$flags).GetValue($w)
    $label.Text = 'Elapsed 00:00'
    Start-Sleep -Milliseconds 1300
    $timer = $t.GetField('ticker',$flags).GetValue($w)
    $timer.GetType().GetMethod('OnTick',$flags).Invoke($timer,@([EventArgs]::Empty))
    if ($label.Text -notmatch '00:01') { throw "Silent interval did not advance clock: $($label.Text)" }
    Write-Output "PASS silent interval: $($label.Text)"
} finally { $w.Dispose() }
