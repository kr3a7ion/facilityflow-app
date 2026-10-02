<#
  Turns this folder into the FacilityFlow host on a Windows PC.

  Registers a Scheduled Task that starts the server when the machine boots - before
  anyone logs in, and again automatically if it ever stops - and opens the port on the
  private network so phones and other PCs on the office wifi can reach it.

  Scheduled Tasks rather than a third-party service wrapper: it is already on every
  Windows machine, which matters when the host has no route to the internet.

  Run once, from an ADMINISTRATOR PowerShell, in the repo folder:
      powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-host.ps1
#>
[CmdletBinding()]
param(
  [int]$Port = 4700,
  [string]$TaskName = 'FacilityFlow'
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "`n  $msg`n" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Note($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }

Write-Host "`nFacilityFlow - host setup`n" -ForegroundColor Cyan

# --- must be admin: registering a boot task and a firewall rule both need it ---------
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Fail 'Run this from an Administrator PowerShell (right-click PowerShell, Run as administrator).'
}

# --- locate the repo and check it has actually been built ---------------------------
$root  = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$entry = Join-Path $root 'apps\server\dist\main.js'
if (-not (Test-Path $entry)) {
  Fail "No build found at $entry. Run 'npm install' then 'npm run build' first."
}
Ok "Found the build at $entry"

# --- node: bake in the absolute path, because SYSTEM has a different PATH ------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail 'Node is not on PATH. Install Node 22 or newer from nodejs.org, then reopen PowerShell.' }
$major = [int](& $node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if ($major -lt 22) { Fail "Node $major found; FacilityFlow needs 22 or newer." }
Ok "Using Node $major at $node"

# The scheduled task runs as SYSTEM, whose PATH does not include a per-user Node
# install, so the launcher gets the full path written into it rather than 'node'.
$template = Join-Path $PSScriptRoot 'facilityflow-run.cmd'
$launcher = Join-Path $root 'data\facilityflow-run.cmd'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data') | Out-Null
(Get-Content $template -Raw).Replace('__NODE_EXE__', $node).Replace('__ROOT__', $root) |
  Set-Content -Path $launcher -Encoding ASCII
Ok "Wrote the launcher to $launcher"

# --- the scheduled task --------------------------------------------------------------
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Note "Replaced the existing '$TaskName' task"
}

$action = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $root

# Two triggers. Boot covers the nightly power cut; the five-minute repeat is a watchdog -
# paired with MultipleInstances IgnoreNew it does nothing while the server is healthy and
# brings it straight back if the process has died. Restart-on-failure alone would not:
# the launcher exits cleanly even when node inside it has crashed.
$atBoot = New-ScheduledTaskTrigger -AtStartup
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
              -RepetitionInterval (New-TimeSpan -Minutes 5)
$trigger = @($atBoot, $watchdog)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet `
               -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
               -StartWhenAvailable -MultipleInstances IgnoreNew `
               -ExecutionTimeLimit ([TimeSpan]::Zero) `
               -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'FacilityFlow maintenance system - serves the department over the office LAN.' | Out-Null
Ok "Registered the '$TaskName' task to start at boot"

# --- firewall: without this the host is only reachable from itself -------------------
$ruleName = "FacilityFlow ($Port)"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort $Port -Profile Private, Domain | Out-Null
Ok "Opened TCP $Port on the private and domain networks"

# --- start it now so nobody has to reboot to test ------------------------------------
Start-ScheduledTask -TaskName $TaskName
Note 'Starting...'
Start-Sleep -Seconds 6

$reached = $false
try {
  $r = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 5
  $reached = $r.StatusCode -eq 200
} catch { $reached = $false }

Write-Host ''
if ($reached) {
  Ok 'The host is up and answering.'
  $ips = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress
  Write-Host ''
  Write-Host '  On this PC:      ' -NoNewline; Write-Host "http://localhost:$Port" -ForegroundColor Cyan
  foreach ($ip in $ips) {
    Write-Host '  On the wifi:     ' -NoNewline; Write-Host "http://${ip}:$Port" -ForegroundColor Cyan
  }
  Write-Host ''
  Note 'It restarts by itself on boot. To stop it:  Stop-ScheduledTask -TaskName FacilityFlow'
  Note "Logs are in $root\data\logs."
} else {
  Write-Host '  The task is registered but the server did not answer within 6 seconds.' -ForegroundColor Yellow
  Write-Host "  Check the newest file in $root\data\logs for the reason." -ForegroundColor Yellow
}
Write-Host ''
