@echo off
REM Diagnostic: shows the virtual-key code of every key you press.
REM Use this if Numpad + does nothing — it tells us whether Windows sees the
REM key at all, and which code to bind.
cd /d "%~dp0"

REM Files that come out of a zip are marked as "from the internet", which Windows
REM can refuse to run. Unblock them quietly first.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Filter *.ps1 | Unblock-File" >nul 2>&1

title ToA counter - test which keys Windows sees

echo.
echo   Press keys. Each one prints its code. Ctrl+C when done.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hotkeys.ps1" -Test

echo.
pause
