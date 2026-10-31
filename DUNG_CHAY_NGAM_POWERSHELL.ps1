# DUNG_CHAY_NGAM_POWERSHELL.ps1 - Dừng các tiến trình Node chạy ngầm
$nodes = Get-Process -Name "node" -ErrorAction SilentlyContinue
if ($nodes) {
    Stop-Process -Name "node" -Force
    Write-Host "=====================================================" -ForegroundColor Green
    Write-Host " [OK] Đã dừng tất cả tiến trình Node chạy ngầm.      " -ForegroundColor Green
    Write-Host "=====================================================" -ForegroundColor Green
} else {
    Write-Host "Không có tiến trình Node nào đang chạy ngầm." -ForegroundColor Gray
}
