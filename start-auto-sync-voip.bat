@echo off
chcp 65001 > nul
title DMS Auto-Sync Voip24h -> Cloudflare R2 (1 tieng / lan)
color 0A

echo =======================================================
echo    DMS HUB - DICH VU TU DONG DONG BO VOIP24H LEN R2
echo =======================================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [LOI] May tinh chua cai dat Node.js!
    echo Vui long cai Node.js tu: https://nodejs.org/
    pause
    exit /b 1
)

echo [*] Dang khoi dong tien trinh dong bo tu dong (moi 60 phut / 1 tieng 1 lan)...
echo [*] Khong tat cua so nay de dich vu tiep tuc chay trong nen.
echo.

node auto-sync-voip.js
pause
