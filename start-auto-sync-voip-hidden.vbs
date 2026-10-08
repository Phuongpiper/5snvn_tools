' start-auto-sync-voip-hidden.vbs - Chạy ngầm tiến trình auto-sync-voip.js không hiện cửa sổ
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Chạy lệnh node auto-sync-voip.js trong chế độ ẩn hoàn toàn (0)
WshShell.CurrentDirectory = currentDir
WshShell.Run "cmd /c node auto-sync-voip.js", 0, False
