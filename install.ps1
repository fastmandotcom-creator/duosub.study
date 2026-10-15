# duosub.study — Windows installer for the DuoSub Bridge.
#
#   irm https://duosub.study/install.ps1 | iex
#
# Downloads the prebuilt bridge, registers a scheduled task that starts it at logon,
# starts it now, and waits until http://127.0.0.1:4499/health answers.
# No prompts, no account, no token.
param(
    [switch]$Uninstall,
    [switch]$Status,
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$Repo    = 'fastmandotcom-creator/duosub.study'
$Home_   = if ($env:DUOSUB_HOME) { $env:DUOSUB_HOME } else { Join-Path $env:LOCALAPPDATA 'duosub' }
$Exe     = Join-Path $Home_ 'duosub-bridge.exe'
$Task    = 'DuoSubBridge'
if ($Port -eq 0) { $Port = if ($env:DUOSUB_PORT) { [int]$env:DUOSUB_PORT } else { 4499 } }

function Say  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "!! $m" -ForegroundColor Yellow }

if ($Uninstall) {
    Say 'Stopping and removing the DuoSub Bridge...'
    Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
    Get-Process duosub-bridge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Say 'Uninstalled. The extension falls back to Web CC automatically.'
    exit 0
}

if ($Status) {
    try { (Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5) | ConvertTo-Json -Compress }
    catch { Warn "Bridge is not responding. Start it with: $Exe" }
    exit 0
}

$arch = if ([System.Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x64' }
$asset = "duosub-bridge-windows-$arch.zip"
$url = "https://github.com/$Repo/releases/latest/download/$asset"

New-Item -ItemType Directory -Force $Home_ | Out-Null
Say "Downloading $asset..."
$zip = Join-Path $env:TEMP $asset
try {
    Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
} catch {
    Warn "No release build for Windows yet ($url)."
    Warn "Build from source: git clone --recurse-submodules https://github.com/$Repo ; cd duosub.study\bridge ; cargo build --release"
    exit 1
}
Expand-Archive -Path $zip -DestinationPath $Home_ -Force
Remove-Item $zip -Force
if (-not (Test-Path $Exe)) { Warn "Release archive is malformed (no duosub-bridge.exe)."; exit 1 }
Say "Installed to $Exe"

# Start at logon (runs whether or not the user is signed in — loopback only, no UI).
$action  = New-ScheduledTaskAction -Execute $Exe -Argument "-port $Port"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Say 'Auto-start registered (starts at logon, restarts if it stops).'

Say 'Starting the bridge (first run downloads the speech model, ~250 MB)...'
Start-Process -FilePath $Exe -ArgumentList "-port $Port" -WindowStyle Hidden -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 150; $i++) {
    try {
        $h = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3
        Write-Host ($h | ConvertTo-Json -Compress)
        Say 'DONE. In the LiveCode extension: Settings -> Live Caption (ASR) -> Caption source -> "Wisp ASR (on-device)".'
        Say 'No token, no account, no cloud - audio never leaves this machine.'
        exit 0
    } catch { Start-Sleep -Seconds 2 }
}
Warn "The bridge did not answer within 5 minutes. Check the Task Scheduler history or run: $Exe"
