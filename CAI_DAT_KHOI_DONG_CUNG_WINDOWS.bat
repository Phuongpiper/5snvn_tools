@echo off
setlocal
chcp 65001 > nul
title Cai Dat Tu Dong Khoi Dong Cung Windows - Khong Can Admin
color 0B

echo =======================================================
echo    CAI DAT TU DONG KHOI DONG CUNG WINDOWS
echo =======================================================
echo.

set "SCRIPT_PATH=%~dp0start-auto-sync-voip-hidden.vbs"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\DMS_Auto_Sync_Voip24h.lnk"

echo [*] Dang tao Shortcut trong thu muc Khoi Dong Windows...
echo     Nguon: %SCRIPT_PATH%
echo     Dich:  %SHORTCUT_PATH%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"%SCRIPT_PATH%\"'; $s.WorkingDirectory = '%~dp0'; $s.Description = 'DMS Auto Sync Voip24h to R2'; $s.Save()"

if exist "%SHORTCUT_PATH%" (
    echo =======================================================
    echo [THANH CONG] DA CAI DAT KHOI DONG CUNG WINDOWS!
    echo.
    echo Tu nay, moi khi bat may hoac khoi dong lai Windows:
    echo  - Dich vu dong bo VoIP24h se TU DONG CHAY NGAM trong nen.
    echo  - Khong hien cua so den, hoan toan em diu khong lam phien.
    echo  - Cu moi 60 phut se tu dong dong bo len Cloudflare R2.
    echo =======================================================
) else (
    echo [LOI] Khong the tao Shortcut tu dong.
)

echo.
pause
