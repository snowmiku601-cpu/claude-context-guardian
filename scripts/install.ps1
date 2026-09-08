# Claude Context Guardian — installer (P6 source; sandbox-tested only).
#
# Installs the Guardian core + liquid overlay into ~/.claude/guardian/ and
# merges the four Guardian hook entries into ~/.claude/settings.json via the
# zero-dependency Node settings-mutator (semantic preservation proven).
#
# SAFETY:
#   - Preflight validates prerequisites and FAILS BEFORE ANY MUTATION.
#   - Timestamped backup of settings.json is always taken before changes.
#   - The mutator self-validates semantic preservation; failure restores the
#     backup and aborts.
#   - Never prints settings content or secret values.
#   - Idempotent: a second install adds nothing.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Autostart] [-Sandbox <path>]
#
# -Sandbox is for testing only: it redirects the install root and the
# settings file to a temp directory (never touches the real user profile).
param(
  [switch]$Autostart,
  [string]$Sandbox = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$mutatorPreflight = Join-Path $repoRoot 'src\guardian\settings-mutator.js'
$fail = { param($msg) Write-Host ("INSTALL FAIL: " + $msg) -ForegroundColor Red; exit 1 }

# ------------------------------------------------------------------ paths ----

if ($Sandbox) {
  # Sandbox mode: everything is redirected; used by tests, never the user.
  $installRoot = Join-Path $Sandbox 'guardian'
  $settingsPath = Join-Path $Sandbox 'settings.json'
  $startupDir = Join-Path $Sandbox 'startup'
  New-Item -ItemType Directory -Force -Path $installRoot, $startupDir | Out-Null
  if (-not (Test-Path $settingsPath)) { New-Item -ItemType File -Path $settingsPath -Value '{}' | Out-Null }
} else {
  $installRoot = Join-Path $env:USERPROFILE '.claude\guardian'
  $settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
  $startupDir = [System.IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup')
}

# --------------------------------------------------------------- preflight ----

Write-Host 'install: preflight (fail-closed, no mutation yet)'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { & $fail 'Node.js (node) not found on PATH - required for hooks and the settings mutator' }

# .NET Framework 4.8 runtime check (overlay dependency)
$ndpKey = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue
if (-not $ndpKey -or $ndpKey.Release -lt 528040) {
  & $fail '.NET Framework 4.8 runtime not found - required by the overlay'
}

# Mutator must exist
$mutator = Join-Path $repoRoot 'src\guardian\settings-mutator.js'
if (-not (Test-Path $mutator)) { & $fail 'settings-mutator.js missing from source' }

# Settings file must exist and be readable (real mode)
if (-not $Sandbox) {
  if (-not (Test-Path $settingsPath)) { & $fail "settings.json not found at $settingsPath" }
}

Write-Host 'install: preflight OK'

# ------------------------------------------------------------- stage files ----

$guardianSrc = Join-Path $repoRoot 'src\guardian'
$overlayBin = Join-Path $repoRoot 'bin\guardian-overlay.exe'

if (-not (Test-Path $overlayBin)) {
  Write-Host 'install: overlay exe missing - building first (build-overlay.ps1)'
  & (Join-Path $PSScriptRoot 'build-overlay.ps1')
  if ($LASTEXITCODE -ne 0) { & $fail 'overlay build failed during install' }
}

New-Item -ItemType Directory -Force -Path $installRoot, (Join-Path $installRoot 'overlay'), (Join-Path $installRoot 'sounds'), (Join-Path $installRoot 'state'), (Join-Path $installRoot 'logs') | Out-Null

Copy-Item (Join-Path $guardianSrc 'guardian.js') $installRoot -Force
Copy-Item (Join-Path $guardianSrc 'notify.ps1') $installRoot -Force
Copy-Item (Join-Path $guardianSrc 'settings-mutator.js') $installRoot -Force
Copy-Item $overlayBin (Join-Path $installRoot 'overlay\guardian-overlay.exe') -Force

# Render config.json from the example IF one does not already exist
# (preserve user's existing config and their sounds).
$configTarget = Join-Path $installRoot 'config.json'
if (-not (Test-Path $configTarget)) {
  $example = Get-Content (Join-Path $repoRoot 'config.example.json') -Raw
  $gdir = ($installRoot -replace '\\', '/')
  $rendered = $example -replace '<guardian-dir>', $gdir
  # sounds keys default to BYO file names; copy nothing (user provides audio)
  [System.IO.File]::WriteAllText($configTarget, $rendered, (New-Object System.Text.UTF8Encoding $false))
  Write-Host 'install: config.json rendered from example'
} else {
  Write-Host 'install: existing config.json preserved'
}

# --------------------------------------------------------------- settings -----

# Preflight the settings file BEFORE any mutation: unreadable or unsupported
# JSON (malformed / duplicate keys / unsafe numbers) must abort here, with
# the file untouched and NO backup taken (backup of a broken file is noise).
& node $mutatorPreflight check --settings $settingsPath
if ($LASTEXITCODE -ne 0) {
  & $fail 'settings preflight rejected the input (file unchanged); nothing was staged'
}

# Timestamped backup (real mode; sandbox backups go to the sandbox)
$backup = "$settingsPath.bak-guardian-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item $settingsPath $backup -Force
Write-Host ("install: backup written ({0})" -f (Split-Path -Leaf $backup))

$guardianJs = (($installRoot -replace '\\', '/') + '/guardian.js')
& node $mutator install --settings $settingsPath --command ("node " + $guardianJs)
if ($LASTEXITCODE -ne 0) {
  & $fail 'settings mutation failed (mutator restored backup); nothing was changed'
}

# ---------------------------------------------------------------- autostart ---

if ($Autostart) {
  $shortcutTarget = Join-Path $installRoot 'overlay\guardian-overlay.exe'
  $shortcutPath = Join-Path $startupDir 'Claude Context Guardian Overlay.lnk'
  if (-not (Test-Path $shortcutPath)) {
    $wsh = New-Object -ComObject WScript.Shell
    $sc = $wsh.CreateShortcut($shortcutPath)
    $sc.TargetPath = $shortcutTarget
    $sc.WorkingDirectory = (Split-Path -Parent $shortcutTarget)
    $sc.Description = 'Claude Context Guardian liquid overlay'
    $sc.Save()
    Write-Host 'install: autostart shortcut created'
  } else {
    Write-Host 'install: autostart shortcut already present (idempotent)'
  }
}

Write-Host 'install: OK (run guardian.js --selftest and --notify 70|80|90|precompact to verify)'
exit 0
