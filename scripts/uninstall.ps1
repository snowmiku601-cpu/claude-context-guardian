# Claude Context Guardian — uninstaller.
#
# Removes ONLY Guardian-owned files and hook entries. User data (sounds,
# state, logs, overlay config, overlay position) is preserved by default;
# -Purge removes it too.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 [-Purge] [-Sandbox <path>]
param(
  [switch]$Purge,
  [string]$Sandbox = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if ($Sandbox) {
  $installRoot = Join-Path $Sandbox 'guardian'
  $settingsPath = Join-Path $Sandbox 'settings.json'
  $startupDir = Join-Path $Sandbox 'startup'
} else {
  $installRoot = Join-Path $env:USERPROFILE '.claude\guardian'
  $settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
  $startupDir = [System.IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup')
}

# --------------------------------------------------------------- settings -----

if (Test-Path $settingsPath) {
  $backup = "$settingsPath.bak-guardian-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item $settingsPath $backup -Force
  Write-Host ("uninstall: backup written ({0})" -f (Split-Path -Leaf $backup))

  $mutator = Join-Path $installRoot 'settings-mutator.js'
  if (-not (Test-Path $mutator)) { $mutator = Join-Path $repoRoot 'src\guardian\settings-mutator.js' }
  $guardianJs = (($installRoot -replace '\\', '/') + '/guardian.js')
  & node $mutator uninstall --settings $settingsPath --command ("node " + $guardianJs)
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'UNINSTALL FAIL: settings mutation failed (backup restored); nothing was changed' -ForegroundColor Red
    exit 1
  }
}

# ---------------------------------------------------------------- shortcut ----

$shortcutPath = Join-Path $startupDir 'Claude Context Guardian Overlay.lnk'
if (Test-Path $shortcutPath) {
  Remove-Item $shortcutPath -Force
  Write-Host 'uninstall: autostart shortcut removed'
}

# ------------------------------------------------------------ program files ----

# Guardian program files (removed): guardian.js, notify.ps1,
# settings-mutator.js, config.json, overlay\guardian-overlay.exe.
# User data (kept unless -Purge): sounds/, state/, logs/.
if (Test-Path $installRoot) {
  Remove-Item (Join-Path $installRoot 'guardian.js') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $installRoot 'notify.ps1') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $installRoot 'settings-mutator.js') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $installRoot 'config.json') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $installRoot 'overlay') -Recurse -Force -ErrorAction SilentlyContinue

  if ($Purge) {
    Remove-Item (Join-Path $installRoot 'sounds') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $installRoot 'state') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $installRoot 'logs') -Recurse -Force -ErrorAction SilentlyContinue
    if ($env:APPDATA) {
      Remove-Item (Join-Path $env:APPDATA 'ClaudeContextGuardian') -Recurse -Force -ErrorAction SilentlyContinue
    }
    # remove the directory itself if empty
    Remove-Item $installRoot -Force -ErrorAction SilentlyContinue
    Write-Host 'uninstall: program files + user data removed (-Purge)'
  } else {
    Write-Host 'uninstall: program files removed; sounds/state/logs preserved'
  }
}

Write-Host 'uninstall: OK (settings backups are kept for rollback)'
exit 0
