# CHAY_NGAM_POWERSHELL.ps1 - Chạy tự động đồng bộ VoIP ẩn hoàn toàn không hiện cửa sổ
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# Khởi chạy node auto-sync-voip.js ở chế độ ẩn (Hidden)
Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "auto-sync-voip.js" -WorkingDirectory $ScriptDir

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host " [OK] Đã kích hoạt auto-sync-voip.js chạy ngầm ẩn!  " -ForegroundColor Green
Write-Host " Không có cửa sổ terminal nào hiển thị trên màn hình. " -ForegroundColor Gray
Write-Host " Tiến trình sẽ tự động lấy cuộc gọi từ tất cả đầu số " -ForegroundColor Gray
Write-Host " mỗi giờ một lần và đẩy lên Cloudflare R2.          " -ForegroundColor Gray
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "Để kiểm tra: Get-Process -Name node" -ForegroundColor Yellow
Write-Host "Để dừng:     Stop-Process -Name node -Force" -ForegroundColor Yellow
