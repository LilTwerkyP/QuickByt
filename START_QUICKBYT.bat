@echo off
setlocal
cd /d "%~dp0"
title Quick Byt - Start Website

echo.
echo ========================================
echo          QUICK BYT - LOCAL START
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not in PATH.
  echo Install Node.js 22.16 or newer from https://nodejs.org/
  echo Then close and reopen VS Code and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo First-time setup: choose a private manager PIN.
  echo Use 6 to 64 characters. This PIN will be saved in this folder's .env file.
  set "QB_PIN="
  set /p "QB_PIN=Manager PIN: "
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:QB_PIN; if ($p.Length -lt 6 -or $p.Length -gt 64) { Write-Host 'PIN must be between 6 and 64 characters.'; exit 2 }; [System.IO.File]::WriteAllText((Join-Path (Get-Location) '.env'), 'QUICKBYT_MANAGER_PIN=' + $p + [Environment]::NewLine, [System.Text.Encoding]::ASCII)"
  if errorlevel 1 (
    echo Could not create .env. Run the script again and enter a PIN of 6-64 characters.
    echo.
    pause
    exit /b 1
  )
)

echo Starting Quick Byt. Keep this window open while you use the site.
echo If the server starts successfully, open http://localhost:5500
echo.
node server.js
echo.
echo Quick Byt has stopped. If an error appeared above, take a screenshot of it.
pause
