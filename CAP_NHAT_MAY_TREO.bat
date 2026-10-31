@echo off
setlocal
chcp 65001 > nul
title DMS - Cap Nhat Code May Treo
color 0B

echo =======================================================
echo    DMS HUB - CẬP NHẬT PHIÊN BẢN MỚI CHO MÁY TREO
echo =======================================================
echo.

where git >nul 2>&1
if not errorlevel 1 (
    echo [*] Dang cap nhat code tu GitHub qua Git...
    git pull origin main
    echo.
    echo [THANH CONG] Da cap nhat phien ban moi nhat thanh cong!
) else (
    echo [!] May chua cai Git. Vui long tai ban ZIP moi nhat tu GitHub va giai nen ghi de vao thu muc nay.
)

echo.
echo [*] Vui long khoi dong lai tien trinh dong bo:
echo     1. Click dup: DUNG_DONG_BO_VOIP.bat (de dung tien trinh cu)
echo     2. Click dup: CHAY_DONG_BO_VOIP.bat (de chay phien ban moi lay tat ca dau so)
echo.
pause

