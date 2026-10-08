@echo off
chcp 65001 > nul
title Tai Node.js Portable (Khong can mat khau Admin)
color 0B

echo =======================================================
echo   TAI NODE.JS PORTABLE (KHONG CAN MAT KHAU ADMIN)
echo =======================================================
echo.
echo [*] Dang tai Node.js Portable chinh chu tu nodejs.org...
echo     (Vui long cho 10 - 30 giay tuy toc do mang)
echo.

powershell -Command "$ProgressPreference = 'SilentlyContinue'; $zipPath = Join-Path $env:TEMP 'node_portable.zip'; $dest = Join-Path '%~dp0' 'node'; Write-Host '[1/3] Dang tai file zip node.js v20...'; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip' -OutFile $zipPath; Write-Host '[2/3] Dang giai nen...'; if (Test-Path (Join-Path $env:TEMP 'node_temp')) { Remove-Item (Join-Path $env:TEMP 'node_temp') -Recurse -Force }; Expand-Archive -Path $zipPath -DestinationPath (Join-Path $env:TEMP 'node_temp') -Force; if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }; Move-Item (Join-Path $env:TEMP 'node_temp\node-v20.18.0-win-x64') $dest; Remove-Item $zipPath -Force; Remove-Item (Join-Path $env:TEMP 'node_temp') -Recurse -Force; Write-Host '[3/3] Hoan tat!';"

if exist "%~dp0node\node.exe" (
    echo.
    echo =======================================================
    echo [THANH CONG] Da thiet lap xong Node.js Portable!
    echo Vi tri: %~dp0node\node.exe
    echo KHONG CAN quyen Admin, KHONG CAN mat khau!
    echo =======================================================
) else (
    echo.
    echo [CHU Y] Khong the tai tu dong qua mang.
    echo Ban co the tai thu cong file zip tu:
    echo https://nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip
    echo Giai nen va doi ten thu muc thanh 'node' roi dat vao day la xong.
)

echo.
pause
