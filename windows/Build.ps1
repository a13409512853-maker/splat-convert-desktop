param([string]$Output)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
if (!$Output) { $Output = Join-Path $root 'dist/Splat-Convert-Desktop-1.1.0-win-x64.exe' }
$bundle = Join-Path $root '.cache/engine-win32-x64.zip'
$license = Join-Path $root '.cache/THIRD-PARTY-LICENSES.txt'
$null = New-Item -ItemType Directory -Force (Split-Path $Output)
$env:TEMP = Join-Path $root '.cache'
$env:TMP = $env:TEMP
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$sources = @('App.cs', 'Converter.cs', 'Smoke.cs') | ForEach-Object { Join-Path $PSScriptRoot $_ }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
  "/resource:$bundle,engine.zip" "/resource:$license,licenses.txt" "/out:$Output" $sources
if ($LASTEXITCODE) { throw "C# compilation failed: $LASTEXITCODE" }
