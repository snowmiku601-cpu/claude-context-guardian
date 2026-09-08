# Claude Context Guardian — overlay build script.
# Compiles the WPF overlay against the installed .NET Framework 4.x runtime
# assemblies. No NuGet, no dotnet CLI, no network.
#
# Compiler discovery order:
#   1. Roslyn csc via vswhere (modern C# host; we pin /langversion:5)
#   2. In-box C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe (C# 5)
#   3. In-box 32-bit Framework csc.exe
# Override with -Compiler inbox|roslyn to force-test a specific path.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\build-overlay.ps1 [-Compiler inbox|roslyn] [-Out bin\guardian-overlay.exe]
param(
  [ValidateSet('auto','inbox','roslyn')]
  [string]$Compiler = 'auto',
  [string]$Out = 'bin\guardian-overlay.exe'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$fx64 = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
$fx32 = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319'

function Find-Roslyn {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path $vswhere) {
    $inst = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.Roslyn.Compiler -property installationPath 2>$null
    if ($inst) {
      $csc = Join-Path $inst 'MSBuild\Current\Bin\Roslyn\csc.exe'
      if (Test-Path $csc) { return $csc }
      # older layouts
      $csc2 = Join-Path $inst 'MSBuild\Current\Bin\Roslyn\csc.exe'
      $csc3 = Get-ChildItem -Path (Join-Path $inst 'MSBuild') -Recurse -Filter csc.exe -ErrorAction SilentlyContinue |
              Select-Object -First 1 -ExpandProperty FullName
      if ($csc3) { return $csc3 }
    }
  }
  return $null
}

$refs = @(
  (Join-Path $fx64 'System.dll'),
  (Join-Path $fx64 'System.Core.dll'),
  (Join-Path $fx64 'System.Runtime.Serialization.dll'),
  (Join-Path $fx64 'System.Xml.dll'),
  (Join-Path $fx64 'System.Xaml.dll'),
  (Join-Path $fx64 'WPF\WindowsBase.dll'),
  (Join-Path $fx64 'WPF\PresentationCore.dll'),
  (Join-Path $fx64 'WPF\PresentationFramework.dll')
)
foreach ($r in $refs) {
  if (-not (Test-Path $r)) { Write-Error "missing framework assembly: $r"; exit 1 }
}

$sources = @(
  (Join-Path $repoRoot 'src\overlay\overlay-logic.cs'),
  (Join-Path $repoRoot 'src\overlay\overlay-ui.cs')
)
$manifest = Join-Path $repoRoot 'src\overlay\app.manifest'
foreach ($s in $sources) {
  if (-not (Test-Path $s)) { Write-Error "missing source: $s"; exit 1 }
}

$cscRoslyn = Find-Roslyn
$cscInbox  = Join-Path $fx64 'csc.exe'
if (-not (Test-Path $cscInbox)) { $cscInbox = Join-Path $fx32 'csc.exe' }

$chosen = $null
switch ($Compiler) {
  'inbox'  { $chosen = $cscInbox }
  'roslyn' { $chosen = $cscRoslyn }
  default  { $chosen = if ($cscRoslyn) { $cscRoslyn } else { $cscInbox } }
}
if (-not $chosen -or -not (Test-Path $chosen)) {
  Write-Host 'BUILD FAIL: no compatible C# compiler found (need .NET Framework 4.x in-box csc or VS Roslyn).' -ForegroundColor Red
  exit 1
}

$outPath = Join-Path $repoRoot $Out
$outDir = Split-Path -Parent $outPath
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$args = @(
  '/noconfig','/nologo',
  '/target:winexe','/platform:anycpu32bitpreferred','/langversion:5',
  '/optimize+',
  ('/out:' + $outPath),
  ('/win32manifest:' + $manifest)
)
foreach ($r in $refs) { $args += ('/r:' + $r) }
foreach ($s in $sources) { $args += $s }

$compilerLabel = if ($chosen -eq $cscRoslyn) { 'roslyn' } else { 'inbox' }
Write-Host ("compiler: {0} -> {1}" -f $compilerLabel, $chosen)

& $chosen @args
if ($LASTEXITCODE -ne 0) {
  Write-Host ("BUILD FAIL: csc exit {0}" -f $LASTEXITCODE) -ForegroundColor Red
  exit $LASTEXITCODE
}
if (-not (Test-Path $outPath)) { Write-Host 'BUILD FAIL: output missing' -ForegroundColor Red; exit 1 }
Write-Host ("BUILD OK: {0} ({1} bytes, compiler={2})" -f $outPath, (Get-Item $outPath).Length, $compilerLabel)
exit 0
