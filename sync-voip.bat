@echo off
chcp 65001 > nul
title DMS - Đồng Bộ Cuộc Gọi VoIP24h Sang Cloudflare R2 (1 Lần)
color 0B

echo =======================================================
echo    DMS HUB - ĐỒNG BỘ CUỘC GỌI VOIP24H LÊN R2 (1 LẦN)
echo =======================================================
echo.

set "NODE_CMD="
if exist "%~dp0node.exe" (
    set "NODE_CMD=%~dp0node.exe"
) else if exist "%~dp0node\node.exe" (
    set "NODE_CMD=%~dp0node\node.exe"
) else if exist "%~dp0node-portable\node.exe" (
    set "NODE_CMD=%~dp0node-portable\node.exe"
)
if "%NODE_CMD%"=="" (
    where node >nul 2>&1
    if %errorlevel% equ 0 set "NODE_CMD=node"
)
if "%NODE_CMD%"=="" (
    call "%~dp0CHAY_DONG_BO_VOIP.bat"
    exit /b 0
)

"%NODE_CMD%" sync-voip.js
echo.
pause
