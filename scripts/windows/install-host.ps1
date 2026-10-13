<#
  Turns this folder into the FacilityFlow host on a Windows PC.

  Registers a Scheduled Task that starts the server when the machine boots - before
  anyone logs in, and again automatically if it ever stops - and opens the port on the
  private network so phones and other PCs on the office wifi can reach it.

  Scheduled Tasks rather than a third-party service wrapper: it is already on every
  Windows machine, which matters when the host has no route to the internet.

  Run once, from an ADMINISTRATOR PowerShell, in the repo folder:
      powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-host.ps1

  The server runs as NETWORK SERVICE, a built-in account with no rights over the rest of
  the PC, given read access to this folder and write access to data\ only. It used to run
  as SYSTEM - the most powerful account on the machine - so anything that ever went wrong
  inside a web server answering the whole office network, and the internet through the
  tunnel, would have had the run of the PC. If NETWORK SERVICE cannot work on a particular
  machine, -Account SYSTEM puts it back the way it was.

  The port is the one the server will actually use: data\host.json, which Admin -> Host PC
  and option 7 of FacilityFlow.cmd write, unless -Port says otherwise.
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [string]$TaskName = 'FacilityFlow',
  [ValidateSet('NetworkService', 'SYSTEM')]
  [string]$Account = 'NetworkService'
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

# --- the ports the server will listen on -----------------------------------------------
$hostFile = Join-Path $root 'data\host.json'
$saved = $null
if (Test-Path $hostFile) {
  try { $saved = Get-Content $hostFile -Raw | ConvertFrom-Json } catch { $saved = $null }
}
if ($Port -eq 0) {
  $Port = if ($saved -and $saved.port) { [int]$saved.port } else { 4700 }
}
$httpsPort = if ($saved -and $saved.httpsPort) { [int]$saved.httpsPort } else { $Port + 1 }
Ok "Port $Port, and $httpsPort for HTTPS if it is switched on"

# --- node: bake in the absolute path, because the service account has a different PATH -
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail 'Node is not on PATH. Install Node 22 or newer from nodejs.org, then reopen PowerShell.' }
$major = [int](& $node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if ($major -lt 22) { Fail "Node $major found; FacilityFlow needs 22 or newer." }
Ok "Using Node $major at $node"

# The scheduled task runs as a service account, whose PATH does not include a per-user
# Node install, so the launcher gets the full path written into it rather than 'node'.
$template = Join-Path $PSScriptRoot 'facilityflow-run.cmd'
$launcher = Join-Path $root 'data\facilityflow-run.cmd'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data') | Out-Null
(Get-Content $template -Raw).Replace('__NODE_EXE__', $node).Replace('__ROOT__', $root) |
  Set-Content -Path $launcher -Encoding ASCII
Ok "Wrote the launcher to $launcher"

# --- what the service account may touch --------------------------------------------------
# Read and run this folder and Node; change data\ and nothing else. Granted here because a
# folder under somebody's user profile, or a per-user Node install, is not readable by any
# other account by default - and a server that cannot read its own code fails at boot with
# nobody watching.
if ($Account -eq 'NetworkService') {
  $sid = '*S-1-5-20'   # NETWORK SERVICE, by its well-known SID so a non-English Windows matches
  $grants = @(
    @{ Path = $root;                         Right = '(OI)(CI)RX' },
    @{ Path = (Split-Path $node);            Right = '(OI)(CI)RX' },
    @{ Path = (Join-Path $root 'data');      Right = '(OI)(CI)M'  }
  )
  foreach ($g in $grants) {
    & icacls $g.Path /grant "${sid}:$($g.Right)" /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Fail "Could not give NETWORK SERVICE access to $($g.Path). Re-run with -Account SYSTEM to run as before."
    }
  }
  Ok 'NETWORK SERVICE can read this folder and Node, and write only to data\'
}

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
$principal = if ($Account -eq 'SYSTEM') {
  New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
} else {
  # NETWORK SERVICE by its SID, the form Task Scheduler stores, so the name never has to match the
  # language Windows was installed in.
  New-ScheduledTaskPrincipal -UserId 'S-1-5-20' -LogonType ServiceAccount -RunLevel Limited
}
$settings  = New-ScheduledTaskSettingsSet `
               -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
               -StartWhenAvailable -MultipleInstances IgnoreNew `
               -ExecutionTimeLimit ([TimeSpan]::Zero) `
               -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'FacilityFlow maintenance system - serves the department over the office LAN.' | Out-Null
Ok "Registered the '$TaskName' task to start at boot, as $Account"

# --- firewall: without this the host is only reachable from itself -------------------
# Every earlier FacilityFlow rule goes first, whatever port it was for, so a changed port
# does not leave the old one open behind it.
Get-NetFirewallRule -DisplayName 'FacilityFlow (*', 'FacilityFlow HTTPS (*' -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "FacilityFlow ($Port)" -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort $Port -Profile Private, Domain | Out-Null
New-NetFirewallRule -DisplayName "FacilityFlow HTTPS ($httpsPort)" -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort $httpsPort -Profile Private, Domain | Out-Null
Ok "Opened TCP $Port, and $httpsPort for HTTPS, on the private and domain networks"

# A network Windows has classed as Public gets none of that, and the host looks switched
# off from every phone. Say so rather than open the port to every network the PC meets.
$public = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' }
foreach ($p in $public) {
  Write-Host "  '$($p.InterfaceAlias)' is set to a Public network, so the port is closed on it." -ForegroundColor Yellow
  Note "  If that is the office network:  Set-NetConnectionProfile -InterfaceAlias '$($p.InterfaceAlias)' -NetworkCategory Private"
}

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
  if ($Account -eq 'NetworkService') {
    Write-Host '  If there is no log at all, NETWORK SERVICE could not start it here. Re-run with' -ForegroundColor Yellow
    Write-Host '  -Account SYSTEM to run it as before, and tell whoever maintains this.' -ForegroundColor Yellow
  }
}
Write-Host ''
