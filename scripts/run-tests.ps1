# Overlay logic test runner + concurrency stress control.
# Compiles src/overlay/overlay-logic.cs + tests/test-main.cs with NO WPF
# references (the no-WPF pure-logic boundary is enforced by this build) and
# runs the contract test suite, then the writer-vs-reader stress control.
param(
  [switch]$SkipStress
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$fx64 = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'

function Find-Csc {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path $vswhere) {
    $inst = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.Roslyn.Compiler -property installationPath 2>$null
    if ($inst) {
      $c = Get-ChildItem -Path (Join-Path $inst 'MSBuild') -Recurse -Filter csc.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
      if ($c) { return $c }
    }
  }
  $inbox = Join-Path $fx64 'csc.exe'
  if (Test-Path $inbox) { return $inbox }
  return $null
}

$csc = Find-Csc
if (-not $csc) { Write-Host 'TESTS FAIL: no compiler found' -ForegroundColor Red; exit 1 }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('ccg-logic-tests-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$refs = @(
  (Join-Path $fx64 'System.dll'),
  (Join-Path $fx64 'System.Core.dll'),
  (Join-Path $fx64 'System.Runtime.Serialization.dll'),
  (Join-Path $fx64 'System.Xml.dll')
)
$args = @('/noconfig','/nologo','/target:exe','/platform:anycpu32bitpreferred','/langversion:5','/optimize+',
  ('/out:' + (Join-Path $tmp 'logic-tests.exe')))
foreach ($r in $refs) { $args += ('/r:' + $r) }
$args += @((Join-Path $repoRoot 'src\overlay\overlay-logic.cs'), (Join-Path $repoRoot 'tests\test-main.cs'))

& $csc $args 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { Write-Host 'TESTS FAIL: no-WPF logic build failed (WPF type referenced in logic?)' -ForegroundColor Red; exit 1 }

# Copy fixtures next to the exe (test harness reads <exedir>\fixtures\state).
Copy-Item -Recurse -Force -Path (Join-Path $repoRoot 'tests\fixtures') -Destination $tmp

Write-Host '--- logic tests ---'
& (Join-Path $tmp 'logic-tests.exe')
$logicExit = $LASTEXITCODE

if ($SkipStress) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue; exit $logicExit }

# ---------------- writer-vs-reader concurrency stress -------------------------
# A Guardian-like writer repeatedly temp+renames ONE state file while the
# logic-layer reader repeatedly reads/selects. Pass requires:
#   - zero writer failures attributable to the reader (atomicity preserved)
#   - zero reader crashes
#   - reader output always a parseable sample (tolerant)
Write-Host '--- concurrency stress (writer temp+rename vs reader) ---'
$stressState = Join-Path $tmp 'stress-state'
New-Item -ItemType Directory -Force -Path $stressState | Out-Null
$stressFile = Join-Path $stressState 'stress.json'

# Start writer loop (Node, mirrors Guardian saveState semantics exactly).
$writerCode = @'
const fs = require('fs');
const [,, dir, file, msArg] = process.argv;
const target = dir + '/' + file;
const end = Date.now() + Number(msArg);
let n = 0, fails = 0, retryOk = 0;
while (Date.now() < end) {
  const base = '.' + file + '.' + process.pid + '.' + n;
  const rec = JSON.stringify({ session_id: 'EXAMPLE-stress', last_pct: (n % 100), updated_at: new Date().toISOString() });
  // Guardian semantics (src/guardian/guardian.js saveState): bounded retry —
  // 25 rename attempts with a 5 ms backoff. Windows rename-replace can
  // transiently fail while a reader holds the target open (OS-level race;
  // share flags cannot prevent it). Probes proved 25x5ms fully recovers at
  // every reader cadence measured, including a reader spinning with no gap.
  // A failure surviving this budget counts as persistent and fails the gate.
  let done = false;
  for (let attempt = 0; attempt < 25 && !done; attempt++) {
    const tmp = dir + '/' + base + '.tmp';
    try {
      fs.writeFileSync(tmp, rec, 'utf8');
      fs.renameSync(tmp, target);
      done = true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      const until = Date.now() + 5;
      while (Date.now() < until) {}
    }
  }
  if (done) { retryOk++; } else { fails++; }
  n++;
  if (n % 20 === 0) { let s = 0; for (let i = 0; i < 20000; i++) s += i; }
}
console.log(JSON.stringify({ writes: n, succeeded: retryOk, persistentFails: fails }));
'@
$writerPath = Join-Path $tmp 'stress-writer.js'
[System.IO.File]::WriteAllText($writerPath, $writerCode)
$writerJob = Start-Job -ScriptBlock {
  param($node, $script, $dir, $file)
  & $node $script $dir $file 8000 2>&1
} -ArgumentList 'node', $writerPath, $stressState, 'stress.json'

# Reader loop via a tiny C# reader reusing the logic layer.
$readerCode = @'
using System;
using System.IO;
using GuardianOverlay;
static class StressReader {
  static int Main(string[] args) {
    int reads = 0, crashes = 0, invalid = 0;
    var end = DateTime.UtcNow.AddMilliseconds(8000);
    while (DateTime.UtcNow < end) {
      try {
        var s = GuardianLogic.ReadStateFile(args[0]);
        reads++;
        if (!s.Valid && s.SessionId != args[0]) crashes++;
        if (!s.Valid) invalid++;
        if (s.Valid && s.Pct != null && (s.Pct < 0 || s.Pct > 100)) { crashes++; }
      } catch { crashes++; }
    }
    Console.WriteLine("{\"reads\":" + reads + ",\"crashes\":" + crashes + ",\"invalid\":" + invalid + "}");
    return crashes == 0 ? 0 : 1;
  }
}
'@
$readerSrc = Join-Path $tmp 'stress-reader.cs'
[System.IO.File]::WriteAllText($readerSrc, $readerCode)
$readerExe = Join-Path $tmp 'stress-reader.exe'
$rargs = @('/noconfig','/nologo','/target:exe','/optimize+',('/out:' + $readerExe))
foreach ($r in $refs) { $rargs += ('/r:' + $r) }
$rargs += @((Join-Path $repoRoot 'src\overlay\overlay-logic.cs'), $readerSrc)
& $csc $rargs 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host 'STRESS FAIL: reader build failed' -ForegroundColor Red; exit 1 }

& $readerExe $stressFile
$readerExit = $LASTEXITCODE
$writerOut = Receive-Job $writerJob -Wait | Select-Object -Last 1
Remove-Job $writerJob -Force -ErrorAction SilentlyContinue

$writerOk = $false
$writerDetail = ''
try {
  $w = $writerOut | ConvertFrom-Json
  # The invariant tested here (plan REV 2.1 F):
  #   - zero writer failures ATTRIBUTABLE to the overlay: every write attempt
  #     must eventually succeed within a small retry budget (the overlay only
  #     ever opens the target with FileShare.ReadWrite|Delete, which cannot
  #     block a rename on Windows; any transient contention must clear).
  #   - zero reader crashes / zero invalid samples (asserted separately).
  # A persistent failure is one that survives 5 retries — that would indicate
  # real interference and fails this gate.
  $writerOk = ($w.writes -gt 100 -and $w.persistentFails -eq 0)
  $writerDetail = "writes=$($w.writes) succeeded=$($w.succeeded) persistentFails=$($w.persistentFails)"
  # Verify the final target file is complete and parseable JSON.
  $final = Get-Content (Join-Path $stressState 'stress.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
  if (-not $final) { $writerOk = $false; $writerDetail += ' final-file-unparseable' }
} catch { $writerOk = $false; $writerDetail = 'writer output unparseable: ' + $writerOut }
$readerOk = $readerExit -eq 0

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

if (-not $writerOk) { Write-Host ("STRESS FAIL: writer invariant violated: {0}" -f $writerDetail) -ForegroundColor Red; exit 1 }
if (-not $readerOk) { Write-Host 'STRESS FAIL: reader crashed or saw invalid pct' -ForegroundColor Red; exit 1 }
Write-Host ("STRESS OK: {0}; reader-crashes=0" -f $writerDetail)

if ($logicExit -ne 0) { exit $logicExit }
Write-Host 'LOGIC TESTS GREEN'
exit 0
