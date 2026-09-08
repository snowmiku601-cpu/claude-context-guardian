# Claude Context Guardian — privacy / leak scanner (REV 2.1).
#
# Rule-class based scanner (NOT naive keyword matching): detects real
# user-home/machine paths, real credential assignments, secret-shaped values,
# real session-state files, settings artifacts, binary/audio assets, machine
# identity, and out-of-policy UUIDs. Documented synthetic fixture values
# (EXAMPLE-* placeholders) are allowed via scripts/privacy-allowlist.txt.
#
# Output discipline: prints file + rule name ONLY. Never prints a matched
# value. Exit 1 on any hit, exit 0 clean, exit 2 usage error.
#
# Modes:
#   --workspace  scan the working tree recursively (no git required; pre-git)
#   --candidate  git-aware: working tree + untracked + intent-to-add,
#                honoring .gitignore (post git init, pre stage)
#   --staged     scan the index/staged content (ONLY meaningful after git add)
#   --history    scan ALL reachable commits/blobs (pre-push gate)
#   --remote     scan a fetched remote's reachable history (pre-public gate)
param(
  [Parameter(Position = 0)]
  [ValidateSet('workspace', 'candidate', 'staged', 'history', 'remote')]
  [string]$Mode = 'workspace'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

# ---------------------------------------------------------------- helpers ----

function Get-Allowlist {
  $path = Join-Path $PSScriptRoot 'privacy-allowlist.txt'
  $patterns = @()
  if (Test-Path $path) {
    foreach ($line in Get-Content $path) {
      $t = $line.Trim()
      if ($t -and -not $t.StartsWith('#')) { $patterns += $t }
    }
  }
  return $patterns
}

$Allowlist = Get-Allowlist

function Test-Allowlisted([string]$relativePath) {
  foreach ($p in $Allowlist) {
    if ($relativePath -like $p) { return $true }
    if ($relativePath -match $p) { return $true }
  }
  return $false
}

# Synthetic fixture values allowed EVERYWHERE (documented in the plan):
#   EXAMPLE- prefixed identifiers, all-zero/EXAMPLE UUID forms.
$SyntheticUuid = '^(EXAMPLE-|00000000-0000-4000-8000-|00000000-0000-0000-0000-)'

function Find-Violations {
  param([string]$Text, [string]$DisplayPath)

  $hits = @()

  # PS-R1: real user-home / machine path (C:\Users\<name> or C:/Users/<name>).
  # Placeholder forms are excluded. The scanner's own rule-definition lines
  # are skipped so the rule text itself never triggers a hit.
  $linewise = $Text -split "`n"
  foreach ($ln in $linewise) {
    if ($ln -match 'PS-R[0-9]|// scanner-rule-definition') { continue } # rule definition lines
    if ($ln -match '(?i)C:[/\\]Users[/\\](?!<you>|yourname\b|username\b|<user>|you\b)[a-z0-9._-]{2,}') {
      $hits += 'PS-R1:user-home-path'
    }
  }

  # PS-R2: real credential assignment (literal secret-shaped value assigned
  # to an auth-ish key). Placeholder values pass.
  $credMatches = [regex]::Matches($Text, '(?i)"?(authorization|api[_-]?key|secret|token|password)"?\s*[:=]\s*"?([A-Za-z0-9_\-\.]{8,})"?')
  foreach ($m in $credMatches) {
    $v = $m.Groups[2].Value
    $isPlaceholder = ($v -match '(?i)^(example|your|xxx|redacted|placeholder|change-me|<)') -or ($v -match $SyntheticUuid)
    # CLAUDE_CODE_MAX_CONTEXT_TOKENS etc are NOT credential keys; the regex
    # above cannot match them (key name must be an auth key). "token" alone
    # could match "tokens" doc keys — require the value NOT be a plain number.
    $isNumeric = $v -match '^\d+$'
    if (-not $isPlaceholder -and -not $isNumeric) { $hits += 'PS-R2:credential-assignment'; break }
  }

  # PS-R3: secret-shaped values (API key prefixes, bearer tokens, high-entropy hex)
  if ($Text -match 'sk-[A-Za-z0-9_-]{20,}') { $hits += 'PS-R3:secret-shaped-value' }
  if ($Text -match '(?i)bearer[ +][A-Za-z0-9_\.\-]{20,}') { $hits += 'PS-R3:secret-shaped-value' }
  if ($Text -match '(?i)(api[_-]?key|secret|password)\s*[:=]\s*["'']?[A-Za-z0-9+/]{32,}') { $hits += 'PS-R3:secret-shaped-value' }

  # PS-R4: real session-state content outside documented fixtures
  if ($Text -match '"last_usage_id"\s*:' -and $DisplayPath -notmatch 'tests[/\\]fixtures[/\\]') { $hits += 'PS-R4:session-state-content' }
  if ($Text -match '"fired70"\s*:\s*true' -and $DisplayPath -notmatch 'tests[/\\]fixtures[/\\]') { $hits += 'PS-R4:session-state-content' }

  # PS-R5: settings artifacts (real settings.json or backups)
  if ($DisplayPath -match '(?i)settings\.json$') { $hits += 'PS-R5:settings-artifact' }
  if ($DisplayPath -match '(?i)\.bak-guardian') { $hits += 'PS-R5:settings-artifact' }
  if ($Text -match 'ANTHROPIC_AUTH_TOKEN\s*=|ANTHROPIC_BASE_URL\s*=') { $hits += 'PS-R5:settings-artifact' }

  # PS-R6: binary/audio/executable assets in source
  if ($DisplayPath -match '\.(mp3|wav|ogg|flac|m4a|exe|dll|pdb|zip|7z)$') { $hits += 'PS-R6:binary-asset' }

  # PS-R7: machine identity. Skip the scanner's own rule-definition lines so
  # the rule text never triggers on itself.
  $linewiseR7 = $Text -split "`n"
  $suspicious = $false
  foreach ($ln in $linewiseR7) {
    if ($ln -match 'PS-R7|PS-R1|scanner-rule-definition|machine-identity') { continue } # rule definition lines
    if ($ln -match 'DESKTOP-[A-Z0-9]{6,}') { $suspicious = $true }
  }
  if ($suspicious) { $hits += 'PS-R7:machine-identity' }

  # PS-R8: UUID policy — real-looking v4 UUIDs outside synthetic/allowlist.
  # Known structural GUIDs (Windows AUMID, compatibility manifest IDs) are
  # documented public constants, not secrets; they are checked against the
  # documented public-constant list rather than the synthetic-UUID policy.
  $PublicGuids = @(
    '1AC14E77-02E7-4E5D-B744-2EB1AE5198B7', # Windows known-folder AUMID (notify.ps1 toast source)
    '8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a', # Win10 supportedOS GUID (app.manifest)
    '1f676c76-80e1-4239-95bb-83d0f6d0da78', # Win8.1 supportedOS GUID (app.manifest)
    '35138b9a-5d96-4fbd-8e2d-a2440225f93a'  # Win7 supportedOS GUID (app.manifest)
  )
  $uuidMatches = [regex]::Matches($Text, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
  foreach ($m in $uuidMatches) {
    $u = $m.Value
    if ($u -match $SyntheticUuid) { continue }
    $isPublicConstant = $false
    foreach ($g in $PublicGuids) { if ($u -ieq $g) { $isPublicConstant = $true } }
    if (-not $isPublicConstant) { $hits += 'PS-R8:non-synthetic-uuid'; break }
  }

  return $hits
}

function Write-Hit([string]$rule, [string]$displayPath) {
  Write-Host ("PRIVACY-HIT [{0}] {1}" -f $rule, $displayPath) -ForegroundColor Red
}

function Invoke-ScanText {
  param([string]$Text, [string]$DisplayPath, [ref]$violationCount)
  if (Test-Allowlisted $DisplayPath) { return }
  $hits = Find-Violations -Text $Text -DisplayPath $DisplayPath
  foreach ($h in $hits) {
    Write-Hit -rule $h -displayPath $DisplayPath
    $violationCount.Value++
  }
}

function Get-ScannableText([byte[]]$bytes) {
  # treat as text unless it contains NUL
  foreach ($b in $bytes) { if ($b -eq 0) { return $null } }
  return [System.Text.Encoding]::UTF8.GetString($bytes)
}

# ------------------------------------------------------------------ modes ----

$violations = 0

switch ($Mode) {

  'workspace' {
    Write-Host "privacy-scan: workspace mode (git-independent)"
    $allFiles = Get-ChildItem -Path $repoRoot -Recurse -File -Force |
      Where-Object {
        $_.FullName -notmatch '[/\\]\.git([/\\]|$)' -and
        $_.FullName -notmatch '[/\\]bin([/\\]|$)' -and    # build output: gitignored, never committed
        $_.FullName -notmatch '[/\\]obj([/\\]|$)'
      }
    foreach ($f in $allFiles) {
      $rel = [System.IO.Path]::GetFullPath($f.FullName).Substring($repoRoot.Length + 1).Replace('\', '/')
      if (Test-Allowlisted $rel) { continue }
      $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
      $text = Get-ScannableText $bytes
      if ($null -eq $text) { Write-Hit -rule 'PS-R6:binary-asset' -displayPath $rel; $violations++; continue }
      Invoke-ScanText -Text $text -DisplayPath $rel ([ref]$violations)
    }
  }

  'candidate' {
    Write-Host "privacy-scan: candidate mode (working tree + untracked, honoring .gitignore)"
    git -C $repoRoot status --porcelain --untracked-files=all | ForEach-Object {
      $entry = $_.Substring(3).Trim('"')
      if ($entry -match ' -> ') { $entry = ($entry -split ' -> ')[1] }
      $full = Join-Path $repoRoot $entry
      if (Test-Path $full -PathType Leaf) {
        $rel = $entry.Replace('\', '/')
        $bytes = [System.IO.File]::ReadAllBytes($full)
        $text = Get-ScannableText $bytes
        if ($null -eq $text) { Write-Hit -rule 'PS-R6:binary-asset' -displayPath $rel; $violations++; return }
        Invoke-ScanText -Text $text -DisplayPath $rel ([ref]$violations)
      }
    }
  }

  'staged' {
    Write-Host "privacy-scan: staged mode (index content)"
    if (-not (Test-Path (Join-Path $repoRoot '.git'))) { Write-Host 'STAGED SCAN INVALID: no git repo'; exit 2 }
    $files = git -C $repoRoot diff --cached --name-only --diff-filter=ACM
    foreach ($entry in $files) {
      $rel = $entry.Replace('\', '/')
      # scan the BLOB content from the index, not the working tree
      $blob = git -C $repoRoot cat-file -p (":0:$entry") 2>$null
      if ($null -eq $blob) { continue }
      $text = ($blob -join "`n")
      Invoke-ScanText -Text $text -DisplayPath $rel ([ref]$violations)
    }
  }

  'history' {
    Write-Host "privacy-scan: history mode (ALL reachable commits/blobs)"
    if (-not (Test-Path (Join-Path $repoRoot '.git'))) { Write-Host 'HISTORY SCAN INVALID: no git repo'; exit 2 }
    $objects = git -C $repoRoot rev-list --objects --all
    $blobs = @()
    foreach ($line in $objects) {
      $parts = $line -split ' ', 2
      if ($parts.Count -eq 2 -and $parts[1]) { $blobs += , $parts }
    }
    $count = 0
    foreach ($entry in $blobs) {
      $sha = $entry[0]; $path = $entry[1]
      $rel = $path.Replace('\', '/')
      if (Test-Allowlisted $rel) { continue }
      $bytes = git -C $repoRoot cat-file -p $sha 2>$null | Out-String
      if ($null -eq $bytes) { continue }
      $count++
      Invoke-ScanText -Text $bytes -DisplayPath $rel ([ref]$violations)
    }
    Write-Host ("history scan: {0} blobs examined" -f $count)
  }

  'remote' {
    Write-Host "privacy-scan: remote mode (fetched remote refs)"
    if (-not (Test-Path (Join-Path $repoRoot '.git'))) { Write-Host 'REMOTE SCAN INVALID: no git repo'; exit 2 }
    git -C $repoRoot fetch --all --quiet 2>$null
    $refs = git -C $repoRoot for-each-ref --format='%(refname)' refs/remotes
    if (-not $refs) { Write-Host 'REMOTE SCAN INVALID: no remote refs'; exit 2 }
    $count = 0
    foreach ($ref in $refs) {
      $objects = git -C $repoRoot rev-list --objects $ref
      foreach ($line in $objects) {
        $parts = $line -split ' ', 2
        if ($parts.Count -ne 2 -or -not $parts[1]) { continue }
        $rel = $parts[1].Replace('\', '/')
        if (Test-Allowlisted $rel) { continue }
        $content = git -C $repoRoot cat-file -p $parts[0] 2>$null | Out-String
        if ($null -eq $content) { continue }
        $count++
        Invoke-ScanText -Text $content -DisplayPath $rel ([ref]$violations)
      }
    }
    Write-Host ("remote scan: {0} blobs examined" -f $count)
  }
}

if ($violations -gt 0) {
  Write-Host ("PRIVACY SCAN FAIL: {0} violation(s). Matched values are never printed." -f $violations) -ForegroundColor Red
  exit 1
}
Write-Host 'PRIVACY SCAN PASS' -ForegroundColor Green
exit 0
