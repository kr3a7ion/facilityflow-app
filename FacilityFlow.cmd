@echo off
setlocal EnableExtensions EnableDelayedExpansion
title FacilityFlow

rem  The launcher.
rem
rem  A facilities department should not need PowerShell to run its own system, and the
rem  Admin screen cannot help here: it is served BY the server, so it can never start a
rem  stopped one. This can, because it runs on the PC rather than in a browser.
rem
rem  Double-click it. Everything below is a numbered choice.

cd /d "%~dp0"

:menu
cls
echo.
echo   FACILITYFLOW
echo   Maintenance ^& FM
echo   ------------------------------------------------------------
echo.

rem --- what state is this install in? ------------------------------------------
set "BUILT=no"
if exist "apps\server\dist\main.js" set "BUILT=yes"

rem  Read the saved port with PowerShell rather than by cutting up the JSON with
rem  delimiters here: "{"port": 4877}" and a pretty-printed file split differently,
rem  and a menu that reports the wrong port is worse than one that reports none.
set "PORT=4700"
if exist "data\host.json" (
  for /f "delims=" %%p in ('powershell -NoProfile -Command "try{(Get-Content 'data\host.json' -Raw ^| ConvertFrom-Json).port}catch{}" 2^>nul') do (
    if not "%%p"=="" set "PORT=%%p"
  )
)

set "SERVICE=no"
schtasks /Query /TN FacilityFlow >nul 2>&1 && set "SERVICE=yes"

set "RUNNING=no"
netstat -ano 2>nul | findstr /r /c:":%PORT% .*LISTENING" >nul && set "RUNNING=yes"

if "%BUILT%"=="no" (
  echo   Status      NOT BUILT YET  -  start with option 1
) else if "%RUNNING%"=="yes" (
  echo   Status      RUNNING on port %PORT%
) else (
  echo   Status      stopped
)
if "%SERVICE%"=="yes" (
  echo   At boot     yes, installed as a service
) else (
  echo   At boot     no  -  it only runs while a window is open
)
echo.
echo   ------------------------------------------------------------
echo.
echo     1   Install and build          (first time, and after an update)
echo     2   Start it now               (keeps this window open)
echo     3   Install so it starts at boot   (needs administrator)
echo     4   Stop it
echo     5   Show the address to hand out
echo     6   Back up now
echo     7   Change the port
echo     8   Check everything is sound
echo     9   Open the data folder
echo     0   Quit
echo.
set "choice="
set /p "choice=  Choose a number: "
rem  Trim whatever came with it. Typed at a keyboard this is already clean, but a
rem  stray space or a carriage return - from a pasted line, or from stdin being
rem  redirected - would make every choice below fall through to the menu again,
rem  which looks exactly like a program that is ignoring you.
for /f "tokens=1 delims= " %%c in ("%choice%") do set "choice=%%c"

if "%choice%"=="1" goto build
if "%choice%"=="2" goto start
if "%choice%"=="3" goto service
if "%choice%"=="4" goto stop
if "%choice%"=="5" goto address
if "%choice%"=="6" goto backup
if "%choice%"=="7" goto port
if "%choice%"=="8" goto smoke
if "%choice%"=="9" goto folder
if "%choice%"=="0" exit /b 0
goto menu

rem ---------------------------------------------------------------- build ----
:build
cls
echo.
where node >nul 2>&1 || goto nonode
for /f "delims=" %%v in ('node -e "process.stdout.write(process.versions.node.split('.')[0])"') do set "NODEMAJOR=%%v"
if %NODEMAJOR% LSS 22 (
  echo   Node %NODEMAJOR% is installed, but FacilityFlow needs 22 or newer.
  echo   Install the LTS version from nodejs.org, then close and reopen this window.
  goto done
)
echo   Using Node %NODEMAJOR%.
echo.
echo   Installing dependencies. This takes a few minutes the first time
echo   and is the only step that needs the internet.
echo.
call npm install || goto failed
echo.
echo   Building.
echo.
call npm run build || goto failed
echo.
echo   Done. Choose 2 to start it, or 3 to have it start by itself at boot.
goto done

rem ---------------------------------------------------------------- start ----
:start
cls
if "%BUILT%"=="no" (
  echo.
  echo   Nothing is built yet. Choose 1 first.
  goto done
)
if "%SERVICE%"=="yes" (
  echo.
  echo   This host is installed as a service, so it is already starting itself.
  echo   Starting a second copy would fail on the port. Use option 4 to stop it first.
  goto done
)
echo.
echo   Starting. Leave this window open - closing it stops the server.
echo   Press Ctrl+C to stop.
echo.
call npm start
goto done

rem -------------------------------------------------------------- service ----
:service
cls
echo.
if "%BUILT%"=="no" (
  echo   Nothing is built yet. Choose 1 first.
  goto done
)
echo   This needs administrator rights, so Windows will ask.
echo   It registers the server to start at boot and opens the port on the
echo   private network.
echo.
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%~dp0scripts\windows\install-host.ps1\"'"
echo.
echo   If a window flashed past, run option 8 and then 5 to check it took.
goto done

rem ----------------------------------------------------------------- stop ----
:stop
cls
echo.
if "%SERVICE%"=="yes" (
  powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-Command','Stop-ScheduledTask -TaskName FacilityFlow'"
  echo   Asked the service to stop.
  echo.
  echo   Note it restarts itself within five minutes by design. To keep it down,
  echo   choose 3 and use the uninstall script, or disable the task in Task Scheduler.
) else (
  echo   It is not installed as a service, so it is only running if a window is open.
  echo   Close that window, or press Ctrl+C in it.
)
goto done

rem -------------------------------------------------------------- address ----
:address
cls
echo.
echo   Hand these out to the department:
echo.
echo     On this PC     http://localhost:%PORT%
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
  set "IP=%%a"
  set "IP=!IP: =!"
  echo     On the wifi    http://!IP!:%PORT%
)
echo.
echo   Ask IT to reserve the wifi address before printing it on anything.
echo   If this PC is on DHCP the address will move, and every bookmark and
echo   every QR sticker on the plant breaks at the same moment.
goto done

rem --------------------------------------------------------------- backup ----
:backup
cls
echo.
if "%BUILT%"=="no" (
  echo   Nothing is built yet. Choose 1 first.
  goto done
)
echo   Taking a snapshot and checking it opens cleanly.
echo.
call npm run backup
echo.
echo   Copy it off this PC. A backup on the same disk survives a mistake,
echo   not a dead machine.
goto done

rem ----------------------------------------------------------------- port ----
:port
cls
echo.
echo   The host is set to port %PORT%.
echo.
echo   Change this only if something else on this PC already uses it. Every
echo   bookmark, shortcut and printed QR code carries the port, so moving it
echo   means reprinting the stickers.
echo.
set "newport="
set /p "newport=  New port (1024-65535), or blank to cancel: "
for /f "tokens=1 delims= " %%n in ("%newport%") do set "newport=%%n"
if "%newport%"=="" goto menu
echo %newport%| findstr /r "^[0-9][0-9]*$" >nul || (
  echo   That is not a number.
  goto done
)
if %newport% LSS 1024 (
  echo   Ports below 1024 need rights the server does not have.
  goto done
)
if %newport% GTR 65535 (
  echo   The highest port is 65535.
  goto done
)
if not exist "data" mkdir "data"
rem  ConvertTo-Json rather than echoing braces: batch escaping around quotes and
rem  redirects is exactly where a file like this quietly writes something that is
rem  not JSON, and the server would then ignore it without saying why.
powershell -NoProfile -Command "@{port=%newport%} | ConvertTo-Json | Set-Content -Path 'data\host.json' -Encoding ASCII"
if errorlevel 1 (
  echo   Could not write data\host.json. The port is unchanged.
  goto done
)
echo.
echo   Saved. It takes effect the next time the host starts.
echo.
echo   Run option 3 again afterwards so the firewall is opened for %newport%,
echo   or the wifi will lose it.
goto done

rem ---------------------------------------------------------------- smoke ----
:smoke
cls
echo.
if "%BUILT%"=="no" (
  echo   Nothing is built yet. Choose 1 first.
  goto done
)
echo   Running the full check against throwaway databases. Nothing here
echo   touches your real data.
echo.
call npm run smoke
goto done

rem --------------------------------------------------------------- folder ----
:folder
if not exist "data" mkdir "data"
start "" "%~dp0data"
goto menu

rem --------------------------------------------------------------- errors ----
:nonode
echo   Node is not installed, or this window was opened before it was.
echo.
echo   Install the LTS version from nodejs.org, then close this window and
echo   double-click FacilityFlow.cmd again.
goto done

:failed
echo.
echo   That step failed. The reason is in the lines above - read the first
echo   error, not the last.
goto done

:done
echo.
pause
goto menu
