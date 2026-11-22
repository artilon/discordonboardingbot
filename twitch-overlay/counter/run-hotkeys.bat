@echo off
REM Double-click THIS file, not hotkeys.ps1.
REM It runs PowerShell with the execution policy bypassed (-NoProfile so a
REM broken profile can't get in the way) and then PAUSES, so if anything goes
REM wrong the error stays on screen instead of the window vanishing.
cd /d "%~dp0"

REM Files that come out of a zip are marked as "from the internet", which Windows
REM can refuse to run. Unblock them quietly first.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Filter *.ps1 | Unblock-File" >nul 2>&1

title ToA dry counter - hotkeys

echo.
echo   Starting the ToA dry counter hotkeys...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hotkeys.ps1"

echo.
echo   --------------------------------------------------------------
echo   The hotkey listener has stopped.
echo   If there is an error above, copy it and send it over.
echo   Most common cause: counter-server.js is not running in another window.
echo   --------------------------------------------------------------
echo.
pause
