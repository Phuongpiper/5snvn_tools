@echo off
title Cloudflare Tunnel - VoIP Sync
echo ============================================
echo  Cloudflare Tunnel cho VoIP Sync
echo  IP may ban: khong bi block boi Voip24h
echo ============================================
echo.

:: Kiem tra cloudflared
where cloudflared >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Chua co cloudflared. Dang cai dat...
    winget install Cloudflare.cloudflared -e --silent
    if %errorlevel% neq 0 (
        echo [LOI] Khong the cai cloudflared. Vui long cai thu cong:
        echo       https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
        pause
        exit /b 1
    )
    echo [OK] Da cai cloudflared!
    echo.
)

:: Kiem tra local server co dang chay khong
curl -s http://localhost:3000/api/voip24h-calls?action=ping >nul 2>&1
if %errorlevel% neq 0 (
    echo [*] Local server chua chay. Dang khoi dong...
    start "Local Server" cmd /c "node local-server.js"
    timeout /t 3 /nobreak >nul
)

echo [*] Dang tao Cloudflare Tunnel...
echo [*] URL se hien ra ben duoi (dang: https://xxxx.trycloudflare.com)
echo [*] Nhan Ctrl+C de dong tunnel
echo.
echo --- URL TUNNEL ---
cloudflared tunnel --url http://localhost:3000
