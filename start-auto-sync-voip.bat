@echo off
chcp 65001 > nul
title DMS Auto-Sync Voip24h -> Cloudflare R2 (1 tieng / lan)
color 0A

echo =======================================================
echo    DMS HUB - DICH VU TU DONG DONG BO VOIP24H LEN R2
echo =======================================================
echo.

set "NODE_CMD=node"
if exist "%~dp0node\node.exe" (
    set "NODE_CMD=%~dp0node\node.exe"
) else if exist "%~dp0node-portable\node.exe" (
    set "NODE_CMD=%~dp0node-portable\node.exe"
)

where %NODE_CMD% >nul 2>&1
if %errorlevel% neq 0 (
    echo [THONG BAO] May tinh chua co Node.js.
    echo Vi ban khong co mat khau Admin, hay click dup vao file:
    echo        'setup-portable-node.bat'
    echo de tu dong tai Node.js ban Portable (khong can quyen Admin).
    echo.
    pause
    exit /b 1
)

echo [*] Dang khoi dong tien trinh dong bo tu dong (moi 60 phut / 1 tieng 1 lan)...
echo [*] Khong tat cua so nay de dich vu tiep tuc chay trong nen.
echo.

"%NODE_CMD%" auto-sync-voip.js
pause
