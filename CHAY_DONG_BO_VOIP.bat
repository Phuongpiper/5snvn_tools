@echo off
setlocal
chcp 65001 > nul
title DMS - Dong Bo Tu Dong VoIP24h Sang Cloudflare R2
color 0A

echo =======================================================
echo    DMS HUB - DICH VU TU DONG DONG BO VOIP24H LEN R2
echo =======================================================
echo.

set "NODE_CMD="

if exist "%~dp0node.exe" set "NODE_CMD=%~dp0node.exe"
if "%NODE_CMD%"=="" if exist "%~dp0node\node.exe" set "NODE_CMD=%~dp0node\node.exe"
if "%NODE_CMD%"=="" if exist "%~dp0node-portable\node.exe" set "NODE_CMD=%~dp0node-portable\node.exe"

if "%NODE_CMD%"=="" (
    where node >nul 2>&1
    if not errorlevel 1 set "NODE_CMD=node"
)

if "%NODE_CMD%"=="" (
    echo [THONG BAO] May tinh chua co Node.js.
    echo [*] Dang tu dong tai Node.js Portable ve may - Khong can mat khau Admin...
    echo     Vui long cho khoang 10 - 20 giay...
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('https://nodejs.org/dist/v20.18.0/win-x64/node.exe', '%~dp0node.exe')"
    if exist "%~dp0node.exe" (
        set "NODE_CMD=%~dp0node.exe"
        echo [THANH CONG] Da tai xong Node.js Portable!
        echo.
    ) else (
        echo [LOI] Khong the tai tu dong Node.js. Vui long kiem tra lai ket noi Internet.
        pause
        exit /b 1
    )
)

echo [*] Dang khoi dong tien trinh dong bo VoIP24h - Moi 60 phut 1 lan...
echo [*] KHONG TAT cua so nay de chuong trinh tiep tuc chay trong nen.
echo.

"%NODE_CMD%" "%~dp0auto-sync-voip.js"
pause
