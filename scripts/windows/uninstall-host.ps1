<#
  Stops FacilityFlow starting with Windows and closes the port again.
  Leaves data\ completely alone - the database, photos and backups all stay.

      powershell -ExecutionPolicy Bypass -File .\scripts\windows\uninstall-host.ps1
#>
[CmdletBinding()]
param([string]$TaskName = 'FacilityFlow')

$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "`n  Run this from an Administrator PowerShell.`n" -ForegroundColor Red; exit 1 }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "  Removed the '$TaskName' task." -ForegroundColor Green
} else {
  Write-Host "  No '$TaskName' task was registered." -ForegroundColor DarkGray
}

# Every FacilityFlow rule, whichever port it was for: the port can have been changed since
# the install, and a rule left behind is a hole nobody remembers opening.
Get-NetFirewallRule -DisplayName 'FacilityFlow (*', 'FacilityFlow HTTPS (*' -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue
Write-Host "  Closed every FacilityFlow port." -ForegroundColor Green
Write-Host "`n  Your data folder was not touched.`n" -ForegroundColor DarkGray
