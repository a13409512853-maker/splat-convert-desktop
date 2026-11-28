param([Parameter(Mandatory=$true)][string]$Exe,[Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$a=[Reflection.Assembly]::LoadFile((Resolve-Path $Exe))
$flags=[Reflection.BindingFlags]'Instance,Public,NonPublic'
$a.GetType('EditorAssets').GetMethod('Bind',[Reflection.BindingFlags]'Static,NonPublic').Invoke($null,@())
$owner=[Windows.Forms.Form]::new()
try {
  foreach($round in 1..2){
    $w=$a.GetType('SceneEditorDialog').GetConstructors($flags)[0].Invoke(@($owner,(Resolve-Path $InputFile).Path,$null,$null))
    try {
      $w.Show()
      $watch=[Diagnostics.Stopwatch]::StartNew()
      $view=$w.Controls | Where-Object {$_.GetType().Name -eq 'WebView2'}
      $note=$w.Controls | Where-Object {$_.GetType().Name -eq 'Label'}
      $initial=$note.Text
      while($note.Visible -and $watch.Elapsed.TotalSeconds -lt 40){[Windows.Forms.Application]::DoEvents();if($note.Text -ne $initial){throw $note.Text};Start-Sleep -Milliseconds 25}
      if ($note.Visible){throw "Timeout: $($note.Text)"}
      $metric='';while ($metric -notmatch '/'){if($watch.Elapsed.TotalSeconds -gt 45){throw "No visible points: $metric"};$task=$view.CoreWebView2.ExecuteScriptAsync('document.querySelector("#metric").textContent');while(!$task.IsCompleted){[Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 10};$metric=$task.Result}
      Write-Output "PASS native viewport $round : $metric ($($watch.Elapsed.TotalSeconds) s)"
    } finally {$w.Close();$w.Dispose()}
  }
}finally{$owner.Dispose()}
