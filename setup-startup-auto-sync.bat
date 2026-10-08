@echo off
chcp 65001 > nul
title Cai Dat Tu Dong Khoi Dong Cung Windows
color 0B

echo =======================================================
echo    CAI DAT TU DONG KHOI DONG CUNG WINDOWS
echo =======================================================
echo.

set "SCRIPT_PATH=%~dp0start-auto-sync-voip-hidden.vbs"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\DMS_Auto_Sync_Voip24h.lnk"

echo [*] Dang tao loi tat (Shortcut) tai thu muc Startup...
echo     Nguon: %SCRIPT_PATH%
echo     Dich:  %SHORTCUT_PATH%
echo.

powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"%SCRIPT_PATH%\"'; $s.WorkingDirectory = '%~dp0'; $s.Description = 'DMS Auto Sync Voip24h to R2'; $s.Save()"

if %errorlevel% equ 0 (
    echo =======================================================
    echo [THANH CONG] Da cai dat thanh cong!
    echo Tu bay gio moi khi bat may hoac khoi dong lai Windows,
    echo tien trinh se TU DONG CHAY NGAM trong nen (khong hien cua so).
    echo =======================================================
) else (
    echo [LOI] Khong the tao Shortcut tu dong.
)

echo.
pause
