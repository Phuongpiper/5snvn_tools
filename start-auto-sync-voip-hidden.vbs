' start-auto-sync-voip-hidden.vbs - Chạy ngầm tiến trình auto-sync-voip.js không hiện cửa sổ
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)

WshShell.CurrentDirectory = currentDir

nodeCmd = "node"
If fso.FileExists(currentDir & "\node.exe") Then
    nodeCmd = """" & currentDir & "\node.exe"""
ElseIf fso.FileExists(currentDir & "\node\node.exe") Then
    nodeCmd = """" & currentDir & "\node\node.exe"""
ElseIf fso.FileExists(currentDir & "\node-portable\node.exe") Then
    nodeCmd = """" & currentDir & "\node-portable\node.exe"""
End If

WshShell.Run "cmd /c " & nodeCmd & " auto-sync-voip.js", 0, False
