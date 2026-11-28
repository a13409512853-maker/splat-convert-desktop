param(
  [string]$CopyTo = ""
)
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$repoRoot = Split-Path (Split-Path $scriptDir)
$vulkanSdk = $env:VULKAN_SDK
if (!$vulkanSdk) { $vulkanSdk = [Environment]::GetEnvironmentVariable('VULKAN_SDK', 'Machine') }
if (!$vulkanSdk -or !(Test-Path -LiteralPath (Join-Path $vulkanSdk 'Bin\glslc.exe'))) {
  throw "Vulkan SDK not found. Set VULKAN_SDK or install KhronosGroup.VulkanSDK."
}
$env:VULKAN_SDK = $vulkanSdk
$glslc = Join-Path $vulkanSdk 'Bin\glslc.exe'

# Build strictly under ASCII relative path (avoids MSVC/Ninja/linker locale quirks on Chinese folder names)
$buildDir = Join-Path $repoRoot '.cache\native-vulkan-build'
$genDir = Join-Path $buildDir 'gen'
New-Item -ItemType Directory -Force $buildDir | Out-Null
New-Item -ItemType Directory -Force $genDir | Out-Null

# 1) Compile all 8 GLSL shaders -> SPIR-V & embed into generated_shaders.h
$shaderList = @(
  @{ src = 'splat_keygen.comp';  sym = 'SPV_SPLAT_KEYGEN' },
  @{ src = 'radix_hist.comp';    sym = 'SPV_RADIX_HIST' },
  @{ src = 'radix_scan.comp';    sym = 'SPV_RADIX_SCAN' },
  @{ src = 'radix_scatter.comp'; sym = 'SPV_RADIX_SCATTER' },
  @{ src = 'splat.vert';         sym = 'SPV_SPLAT_VERT' },
  @{ src = 'splat.frag';         sym = 'SPV_SPLAT_FRAG' },
  @{ src = 'sphere.vert';        sym = 'SPV_SPHERE_VERT' },
  @{ src = 'sphere.frag';        sym = 'SPV_SPHERE_FRAG' }
)

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('#pragma once')
[void]$sb.AppendLine('#include <cstdint>')

foreach ($sh in $shaderList) {
  $srcPath = Join-Path (Join-Path $scriptDir 'shaders') $sh.src
  $spvPath = Join-Path $genDir ($sh.src + '.spv')
  & $glslc --target-env=vulkan1.3 -O $srcPath -o $spvPath
  if ($LASTEXITCODE -ne 0) { throw "glslc failed for $($sh.src)" }
  $bytes = [System.IO.File]::ReadAllBytes($spvPath)
  $words = [int]($bytes.Length / 4)
  [void]$sb.AppendLine("static const uint32_t $($sh.sym)[$words] = {")
  for ($i = 0; $i -lt $words; $i += 8) {
    $lineWords = New-Object System.Collections.Generic.List[string]
    for ($j = 0; $j -lt 8 -and ($i + $j) -lt $words; $j++) {
      $val = [BitConverter]::ToUInt32($bytes, ($i + $j) * 4)
      $lineWords.Add(("0x{0:X8}u" -f $val))
    }
    [void]$sb.AppendLine("  " + ($lineWords -join ", ") + ",")
  }
  [void]$sb.AppendLine("};")
}

$genHeader = Join-Path $genDir 'generated_shaders.h'
[System.IO.File]::WriteAllText($genHeader, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Compiled 8 Vulkan 1.3 SPIR-V shaders -> $genHeader"

# 2) Locate MSVC vcvars64.bat
$vcvarsCandidates = @(
  'C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat',
  'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat',
  'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
)
$vcvars = $vcvarsCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!$vcvars) { throw "Could not find Visual Studio vcvars64.bat" }

# 3) Configure & build with CMake + Ninja inside a short ASCII subst drive (X: or relative path)
# Using Push-Location with relative paths keeps every compiler/linker path 100% ASCII!
Push-Location $repoRoot
try {
  $cmd = "`"$vcvars`" >nul && cmake -S windows/native-viewport -B .cache/native-vulkan-build -G Ninja -DCMAKE_BUILD_TYPE=Release -DSPLAT_NV_GEN_DIR=`"$($genDir.Replace('\','/'))`" && cmake --build .cache/native-vulkan-build"
  cmd /c $cmd
  if ($LASTEXITCODE -ne 0) { throw "CMake/Ninja build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$dllOut = Join-Path $buildDir 'splat_native_viewport.dll'
if (!(Test-Path -LiteralPath $dllOut)) { throw "Expected $dllOut not found!" }
$hash = (Get-FileHash -LiteralPath $dllOut -Algorithm SHA256).Hash
Write-Host "Built $dllOut ($((Get-Item $dllOut).Length) bytes, SHA256=$hash)"

if ($CopyTo) {
  New-Item -ItemType Directory -Force $CopyTo | Out-Null
  Copy-Item -LiteralPath $dllOut -Destination (Join-Path $CopyTo 'splat_native_viewport.dll') -Force
  Write-Host "Copied splat_native_viewport.dll -> $CopyTo"
}
