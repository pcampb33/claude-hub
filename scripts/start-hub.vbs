' Starts the hub (npm run dev) from its repo folder with no console window.
' The Start Menu shortcut the app creates (electron/app-identity.ts) runs it:
'   wscript.exe //B //Nologo scripts\start-hub.vbs
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.Run "cmd /c npm run dev", 0, False
