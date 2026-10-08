@echo off
chcp 65001 > nul
title Dung Tien Trinh Auto-Sync Voip24h
color 0C

echo =======================================================
echo    DUNG TIEN TRINH AUTO-SYNC VOIP24H
echo =======================================================
echo.

powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*auto-sync-voip.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output ('Da dung tien trinh PID: ' + $_.ProcessId) }"

echo.
echo Da dung tat ca tien trinh auto-sync-voip.js dang chay ngam.
echo.
pause
