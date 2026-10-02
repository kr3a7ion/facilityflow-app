<#
  Stops FacilityFlow starting with Windows and closes the port again.
  Leaves data\ completely alone - the database, photos and backups all stay.

      powershell -ExecutionPolicy Bypass -File .\scripts\windows\uninstall-host.ps1
#>
[CmdletBinding()]
param([int]$Port = 4700, [string]$TaskName = 'FacilityFlow')

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

Get-NetFirewallRule -DisplayName "FacilityFlow ($Port)" -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue
Write-Host "  Closed TCP $Port." -ForegroundColor Green
Write-Host "`n  Your data folder was not touched.`n" -ForegroundColor DarkGray
