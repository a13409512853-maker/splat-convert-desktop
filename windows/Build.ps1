param([string]$Output)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
if (!$Output) { $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version; $Output = Join-Path $root "dist/Splat-Convert-Desktop-$version-win-x64.exe" }
$bundle = Join-Path $root '.cache/engine-win32-x64.zip'
$license = Join-Path $root '.cache/THIRD-PARTY-LICENSES.txt'
$null = New-Item -ItemType Directory -Force (Split-Path $Output)
$env:TEMP = Join-Path $root '.cache'
$env:TMP = $env:TEMP
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$sources = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' | Select-Object -ExpandProperty FullName
$icons = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'icons') -Filter '*.png' | ForEach-Object { "/resource:$($_.FullName),icon.$($_.Name)" }
$locale = Join-Path $root 'app/locales.json'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Web.Extensions.dll `
  "/resource:$bundle,engine.zip" "/resource:$license,licenses.txt" "/resource:$locale,locales.json" "/out:$Output" $icons $sources
if ($LASTEXITCODE) { throw "C# compilation failed: $LASTEXITCODE" }
