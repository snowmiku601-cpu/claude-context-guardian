# Claude Context Guardian notifier (Phase 1)
# Usage: notify.ps1 -Title <text> -Message <text> [-SoundPath <mp3>] [-EventLog <path>]
# Inbox-only: WinRT toast + MCI mciSendString for MP3. Hidden, noninteractive, exits promptly.

param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$Message,
  [string]$SoundPath = '',
  [string]$EventLog = ''
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-Event([string]$line) {
  if ($EventLog -and ($line -match '^(RESULT|SOUND|TOAST)')) {
    try { Add-Content -Path $EventLog -Value $line -Encoding utf8 -ErrorAction SilentlyContinue } catch {}
  }
}

# ---- Toast (WinRT) -----------------------------------------------------------
$toastOk = $false
try {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  $xml = @"
<toast scenario="reminder">
  <visual>
    <binding template="ToastGeneric">
      <text>$([System.Net.WebUtility]::HtmlEncode($Title))</text>
      <text>$([System.Net.WebUtility]::HtmlEncode($Message))</text>
    </binding>
  </visual>
  <audio silent="true"/>
</toast>
"@

  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  # appId: PowerShell's own registered AUMID shows a sane source name on stock Win10
  $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
  $toastOk = $true
} catch {}

Write-Event "TOAST $toastOk"

# ---- Sound (MCI, MP3-capable) ------------------------------------------------
$soundResult = 'skipped'
if ($SoundPath -and (Test-Path $SoundPath)) {
  $alias = 'ccg_' + ([guid]::NewGuid().ToString('N').Substring(0, 12))
  $full = (Resolve-Path $SoundPath).Path
  $mciOpen = "open `"$full`" type mpegvideo alias $alias"
  $mciPlay = "play $alias wait"
  $mciClose = "close $alias"

  Add-Type -Namespace Win32 -Name Mci -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("winmm.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern int mciSendString(string command, System.Text.StringBuilder buffer, int bufferSize, System.IntPtr hwndCallback);
"@ -ErrorAction SilentlyContinue

  try {
    $sb = New-Object System.Text.StringBuilder 256
    $openOk = [Win32.Mci]::mciSendString($mciOpen, $sb, 256, [System.IntPtr]::Zero) -eq 0
    if ($openOk) {
      $soundResult = 'played'
      $null = [Win32.Mci]::mciSendString($mciPlay, $sb, 256, [System.IntPtr]::Zero)
      $null = [Win32.Mci]::mciSendString($mciClose, $sb, 256, [System.IntPtr]::Zero)
    } else {
      $soundResult = 'mci_open_failed'
    }
  } catch {
    $soundResult = 'mci_error'
  }
} elseif ($SoundPath) {
  $soundResult = 'file_missing'
}

Write-Event "SOUND $soundResult"
Write-Event "RESULT ok"
exit 0
