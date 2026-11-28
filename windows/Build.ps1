param([string]$Output,[string]$EngineFromExe)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if (!$Output) { $Output = Join-Path $root "dist/Splat-Convert-Desktop-$version-win-x64.exe" }
$bundle = Join-Path $root '.cache/engine-win32-x64.zip'
$repoLicense = Join-Path $root 'THIRD-PARTY-LICENSES.txt'
$cacheLicense = Join-Path $root '.cache/THIRD-PARTY-LICENSES.txt'
if ($EngineFromExe) {
    $null = New-Item -ItemType Directory -Force (Split-Path $bundle)
    $assembly = [Reflection.Assembly]::LoadFile((Resolve-Path -LiteralPath $EngineFromExe).Path)
    foreach ($r in @(@('engine.zip',$bundle), @('licenses.txt',$cacheLicense))) {
        $s=$assembly.GetManifestResourceStream($r[0]); if (!$s) {throw "Missing resource $($r[0])"}
        try { $f=[IO.File]::Create($r[1]); try {$s.CopyTo($f)} finally {$f.Dispose()} } finally {$s.Dispose()}
    }
}
$license = if (Test-Path -LiteralPath $repoLicense) { $repoLicense } else { $cacheLicense }
$null = New-Item -ItemType Directory -Force (Split-Path $Output)
$null = New-Item -ItemType Directory -Force (Join-Path $root '.cache')
$env:TEMP = Join-Path $root '.cache'
$env:TMP = $env:TEMP

# Pack 100% of our own native desktop editor UI + domain slice + offline dependencies.
# ZERO dependency on editor-resplat/dist or external ReSplat bundles!
$editor = Join-Path $PSScriptRoot 'editor'
if (!(Test-Path -LiteralPath (Join-Path $editor 'index.html'))) {
    throw "Missing native editor entry at $editor\index.html"
}

$editorFiles = Get-ChildItem -LiteralPath $editor -Recurse -File |
    Where-Object { $_.Name -notlike '.*' } |
    Sort-Object { $_.FullName.Substring($editor.Length + 1).Replace('\', '/') }

$sha = [System.Security.Cryptography.SHA256]::Create()
$manifestEntries = New-Object System.Collections.Generic.List[object]
$compositeBuilder = New-Object System.Text.StringBuilder
$assets = New-Object System.Collections.Generic.List[string]

foreach ($file in $editorFiles) {
    $rel = $file.FullName.Substring($editor.Length + 1).Replace('\', '/')
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $hashHex = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    $manifestEntries.Add([ordered]@{
        path   = $rel
        size   = $file.Length
        sha256 = $hashHex
    })
    [void]$compositeBuilder.Append($rel).Append(':').Append($hashHex).Append("`n")
    $assets.Add("/resource:$($file.FullName),editor.$rel")
}

# Auto-discover ALL unified locale packs in locales/*.json (embedded for BOTH C# host and WebView2 3D editor!)
$localesDir = Join-Path $root 'locales'
if (!(Test-Path -LiteralPath (Join-Path $localesDir 'zh-CN.json'))) {
    throw "Missing Source-of-Truth locale pack at $localesDir\zh-CN.json"
}
$localeFiles = Get-ChildItem -LiteralPath $localesDir -Filter '*.json' -File | Sort-Object Name
$localeResources = New-Object System.Collections.Generic.List[string]
foreach ($lf in $localeFiles) {
    $localeResources.Add("/resource:$($lf.FullName),locales.$($lf.Name)")
    $rel = "locales/$($lf.Name)"
    $bytes = [System.IO.File]::ReadAllBytes($lf.FullName)
    $hashHex = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    $manifestEntries.Add([ordered]@{
        path   = $rel
        size   = $lf.Length
        sha256 = $hashHex
    })
    [void]$compositeBuilder.Append($rel).Append(':').Append($hashHex).Append("`n")
    $assets.Add("/resource:$($lf.FullName),editor.$rel")
}

$compositeBytes = [System.Text.Encoding]::UTF8.GetBytes($compositeBuilder.ToString())
$assetsSha256 = ([BitConverter]::ToString($sha.ComputeHash($compositeBytes))).Replace('-', '').ToLowerInvariant()
$assetsHash = $assetsSha256.Substring(0, 16)
$sha.Dispose()

$manifestObj = [ordered]@{
    schemaVersion = 1
    editorKind    = 'native-owned'
    version       = $version
    entry         = 'index.html'
    assetsHash    = $assetsHash
    assetsSha256  = $assetsSha256
    fileCount     = $manifestEntries.Count
    files         = $manifestEntries
}
$manifestPath = Join-Path $root '.cache/editor.manifest.json'
$manifestJson = $manifestObj | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, (New-Object System.Text.UTF8Encoding($false)))
$assets.Add("/resource:$manifestPath,editor.manifest.json")

$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$sources = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' | Select-Object -ExpandProperty FullName
$icons = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'icons') -Filter '*.png' | ForEach-Object { "/resource:$($_.FullName),icon.$($_.Name)" }
$appIcon = Join-Path $PSScriptRoot 'icons/app.ico'

$sdk = Join-Path $PSScriptRoot 'webview'
$libs = Get-ChildItem $sdk -File | ForEach-Object { "/resource:$($_.FullName),webview.$($_.Name)" }

# Embed self-healing bundled AI model pack (SAM 2.1 Hiera Tiny FP16 + ORT WebGPU/WASM) if present in .cache/models/
$bundledModelsZip = Join-Path $root '.cache/models/bundled_models.zip'
$extraModelRes = @()
if (Test-Path -LiteralPath $bundledModelsZip) {
    $extraModelRes += "/resource:$bundledModelsZip,bundled_models.zip"
    Write-Host ("Embedding bundled_models.zip ({0} MB)" -f [math]::Round((Get-Item $bundledModelsZip).Length / 1MB, 2))
}

& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Web.Extensions.dll `
  "/reference:$sdk/Microsoft.Web.WebView2.Core.dll" "/reference:$sdk/Microsoft.Web.WebView2.WinForms.dll" $assets $localeResources $libs $extraModelRes "/resource:$bundle,engine.zip" "/resource:$license,licenses.txt" "/win32icon:$appIcon" "/out:$Output" $icons $sources
if ($LASTEXITCODE) { throw "C# compilation failed: $LASTEXITCODE" }
Write-Host "Built $Output (version=$version, editorKind=native-owned, entry=index.html, files=$($manifestEntries.Count), assetsHash=$assetsHash)"
