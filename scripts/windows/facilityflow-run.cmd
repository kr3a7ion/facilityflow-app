@echo off
REM Launcher for the FacilityFlow host. Scheduled Tasks calls this rather than node
REM directly, so everything the server prints lands in a file somebody can read after a
REM crash at 3am.
REM
REM install-host.ps1 writes a copy of this file with __NODE_EXE__ and __ROOT__ replaced
REM by absolute paths. Both are baked in rather than derived: the copy does not live in
REM the same folder as this template, and the task runs as SYSTEM, whose PATH does not
REM include a per-user Node install.
REM
REM The date comes from PowerShell, not wmic - wmic is deprecated and absent from recent
REM Windows builds, and a launcher that fails on a new PC is worse than no launcher.

setlocal
set "ROOT=__ROOT__"
set "LOGDIR=%ROOT%\data\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "TODAY=%%I"
if "%TODAY%"=="" set "TODAY=host"
set "LOG=%LOGDIR%\host-%TODAY%.log"

>>"%LOG%" echo.
>>"%LOG%" echo ===== started %date% %time% =====

cd /d "%ROOT%"
"__NODE_EXE__" "%ROOT%\apps\server\dist\main.js" >>"%LOG%" 2>&1

>>"%LOG%" echo ===== exited with code %ERRORLEVEL% at %date% %time% =====
endlocal
