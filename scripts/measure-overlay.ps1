# Claude Context Guardian — real overlay resource measurement (P9.1-hardened).
#
# Launches the BUILT overlay against SYNTHETIC state only (never real
# Guardian state), measures private working set + CPU time deltas over an
# animated and a static window, and reports results.
#
# P9.1 freshness hardening (root cause of the earlier misleading benchmark):
# the overlay treats state as STALE after staleAfterMinutes (default 15) and
# falls back to a non-animating "awaiting" display — so a benchmark whose
# synthetic updated_at went stale was silently measuring the wrong thing.
# This benchmark therefore:
#   1. refreshes updated_at immediately before launch and DURING sampling
#      (production staleness semantics are untouched),
#   2. verifies the overlay actually selected a valid non-stale sample,
#   3. verifies the wave animation is actually running,
#   4. FAILS the measurement instead of reporting CPU numbers if the sample
#      window lost freshness or animation.
#
# Deterministic self-control: -StaleFixture runs the same flow against a
# stale fixture and must REFUSE to claim an animated result.
#
# CPU unit: % of ONE logical processor (TotalProcessorTime delta / wall time;
# calibrated against a known single-core workload reading ~99.6%).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\measure-overlay.ps1 [-Seconds 20] [-StaleFixture] [-KeepRunning]
param(
  [int]$Seconds = 20,
  [switch]$StaleFixture,
  [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repoRoot 'bin\guardian-overlay.exe'
if (-not (Test-Path $exe)) { Write-Host 'MEASURE FAIL: build the overlay first (scripts\build-overlay.ps1)' -ForegroundColor Red; exit 1 }

# Exactly one overlay instance may run (single-instance mutex); stop any.
Get-Process guardian-overlay -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

function New-UtcIso { param([int]$OffsetMinutes = 0)
  (Get-Date).ToUniversalTime().AddMinutes($OffsetMinutes).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

# Synthetic state: a fresh non-stale winner (30%) + one stale loser.
$stateDir = Join-Path ([System.IO.Path]::GetTempPath()) ('ccg-measure-state-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$winnerUpdated = if ($StaleFixture) { New-UtcIso -360 } else { New-UtcIso }
Set-Content -Path (Join-Path $stateDir 'EXAMPLE-synthetic-a.json') -Encoding ascii -Value (
  '{"session_id":"EXAMPLE-synthetic-a","last_pct":30,"updated_at":"' + $winnerUpdated + '"}')
Set-Content -Path (Join-Path $stateDir 'EXAMPLE-synthetic-b.json') -Encoding ascii -Value (
  '{"session_id":"EXAMPLE-synthetic-b","last_pct":85,"updated_at":"' + (New-UtcIso -360) + '"}')

$configDir = Join-Path ([System.IO.Path]::GetTempPath()) ('ccg-measure-appdata-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$stateDirForward = $stateDir -replace '\\', '/'
@{
  diameterPx = 150; opacity = 0.95; waveEnabled = $true; staticFill = $false
  staleAfterMinutes = 15; multiSessionIndicator = $true; fps = 20
  stateDir = $stateDirForward
} | ConvertTo-Json | Set-Content (Join-Path $configDir 'overlay.config.json')

function Refresh-Winner {
  Set-Content -Path (Join-Path $stateDir 'EXAMPLE-synthetic-a.json') -Encoding ascii -Value (
    '{"session_id":"EXAMPLE-synthetic-a","last_pct":30,"updated_at":"' + (New-UtcIso) + '"}')
}
function Get-Stats($p) {
  $p.Refresh()
  [pscustomobject]@{
    PrivateMB  = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
    CpuSeconds = $p.TotalProcessorTime.TotalSeconds
  }
}
# Wave-activity proof: sample pixel rows near the liquid surface (30% ->
# surface around y = 100..115 in a 150px circle) twice; movement proves the
# animation is composing. Returns true when movement detected.
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public static class MeasureW {
  public delegate bool EnumCb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public struct R { public int L, T, Rt, B; }
}
"@
function Test-WaveActive($p) {
  $script:rect = $null
  $cb = {
    param($h, $l)
    $pid2 = 0
    [MeasureW]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    if ($pid2 -eq $p.Id -and [MeasureW]::IsWindowVisible($h)) {
      $r2 = New-Object MeasureW+R
      [MeasureW]::GetWindowRect($h, [ref]$r2) | Out-Null
      if (($r2.Rt - $r2.L) -eq 150 -and ($r2.B - $r2.T) -eq 150) { $script:rect = $r2; return $false }
    }
    return $true
  }
  [MeasureW]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  if (-not $script:rect) { return $false }
  function SnapRow([int]$row) {
    $bmp = New-Object System.Drawing.Bitmap(150, 150)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($script:rect.L, $script:rect.T, 0, 0, $bmp.Size)
    $cols = @()
    for ($x = 30; $x -le 120; $x += 3) { $px = $bmp.GetPixel($x, $row); $cols += "$($px.R).$($px.G).$($px.B)" }
    $g.Dispose(); $bmp.Dispose()
    return ($cols -join '|')
  }
  $moved = 0
  for ($row = 100; $row -le 116; $row += 4) {
    $a = SnapRow $row
    Start-Sleep -Milliseconds 400
    $b = SnapRow $row
    if ($a -ne $b) { $moved++ }
  }
  return ($moved -gt 0)
}

Write-Host ("measure: launching overlay ({0}) stateDir={1}" -f ($(if ($StaleFixture) { 'STALE FIXTURE CONTROL' } else { 'fresh fixture' })), $stateDir)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.UseShellExecute = $false
$psi.EnvironmentVariables['CCG_CONFIG_DIR'] = $configDir
$proc = [System.Diagnostics.Process]::Start($psi)
Start-Sleep -Seconds 5

if ($proc.HasExited) { Write-Host 'MEASURE FAIL: overlay exited immediately (single-instance conflict?)' -ForegroundColor Red; exit 1 }

# Freshness refresh immediately before the sample window (fresh fixture only).
if (-not $StaleFixture) { Refresh-Winner }

$waveActive = Test-WaveActive $proc
if ($StaleFixture) {
  if ($waveActive) {
    Write-Host 'CONTROL FAIL: stale fixture produced wave activity — benchmark cannot detect staleness' -ForegroundColor Red
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    exit 1
  }
  Write-Host 'CONTROL PASS: stale fixture -> overlay is non-animating (awaiting), benchmark refuses animated claim' -ForegroundColor Green
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $stateDir, $configDir -ErrorAction SilentlyContinue
  exit 0
}

if (-not $waveActive) {
  Write-Host 'MEASURE FAIL: waves not active despite fresh state — refusing to report animated CPU' -ForegroundColor Red
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $stateDir, $configDir -ErrorAction SilentlyContinue
  exit 1
}

$s1 = Get-Stats $proc
$half = [math]::Max(5, [int]($Seconds / 2))
Start-Sleep -Seconds $half
# Mid-window freshness refresh: production staleness untouched; benchmark keeps
# its fixture fresh so the whole window measures the ANIMATING state.
Refresh-Winner
Start-Sleep -Seconds ($Seconds - $half)
$s2 = Get-Stats $proc

# Re-verify animation/freshness survived the window; if the fixture went stale
# mid-window the measurement would be invalid — fail rather than misreport.
$waveActive2 = Test-WaveActive $proc
$stillFresh = ((Get-Date).ToUniversalTime() - [datetime]::Parse((Get-Content (Join-Path $stateDir 'EXAMPLE-synthetic-a.json') | ConvertFrom-Json).updated_at, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)).TotalMinutes -lt 15
if (-not ($waveActive2 -and $stillFresh)) {
  Write-Host ("MEASURE FAIL: animation active={0} fixture-fresh={1} -- sample window invalid" -f $waveActive2, $stillFresh) -ForegroundColor Red
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $stateDir, $configDir -ErrorAction SilentlyContinue
  exit 1
}

$animCpu = [math]::Round(($s2.CpuSeconds - $s1.CpuSeconds) / $Seconds * 100, 2)
$ram = $s2.PrivateMB

# Static comparison: flip the same overlay to staticFill and measure.
$staticCfg = Get-Content (Join-Path $configDir 'overlay.config.json') -Raw
$staticCfg = $staticCfg -replace '"staticFill":\s*false', '"staticFill": true'
Set-Content (Join-Path $configDir 'overlay.config.json') -Encoding ascii -Value $staticCfg
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$proc2 = [System.Diagnostics.Process]::Start($psi)
Start-Sleep -Seconds 5
if (-not $proc2.HasExited) {
  $st1 = Get-Stats $proc2
  Start-Sleep -Seconds $Seconds
  $st2 = Get-Stats $proc2
  $staticCpu = [math]::Round(($st2.CpuSeconds - $st1.CpuSeconds) / $Seconds * 100, 2)
  $ramStatic = $st2.PrivateMB
  Stop-Process -Id $proc2.Id -Force -ErrorAction SilentlyContinue
} else { $staticCpu = -1; $ramStatic = -1 }

Write-Host ''
Write-Host '=== MEASURED (real executable, fresh non-stale synthetic state) ==='
Write-Host ("RAM (private working set): animated {0} MB / static {1} MB   [target <= 50 MB]" -f $ram, $ramStatic)
Write-Host ("CPU animated waves: {0}% of one logical processor over {1}s" -f $animCpu, $Seconds)
Write-Host ("CPU static fill:    {0}% of one logical processor over {1}s" -f $staticCpu, $Seconds)
Write-Host 'unit: % of ONE logical core (TotalProcessorTime/wall, calibrated ~99.6% = 1 core)'
if (-not $KeepRunning) {
  Remove-Item -Recurse -Force $stateDir, $configDir -ErrorAction SilentlyContinue
}
exit 0
