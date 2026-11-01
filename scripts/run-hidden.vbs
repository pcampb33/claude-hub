' Windowless launcher for the batch Task Scheduler jobs (inbox drain, vault
' linker, floor verify). An interactive task that starts node.exe or powershell.exe gets a real console window, and
' -WindowStyle Hidden cannot hide it after the fact -- on 2026-10-11 the noon
' inbox drain took focus from a fullscreen game. wscript has no console and
' Run(..., 0, True) creates the child hidden and waits for it.
' Usage: wscript.exe //B //Nologo run-hidden.vbs <exe> [args...]
' Each argument is re-quoted. The child's exit code is passed through so the
' task's LastTaskResult (which the Global view reads) still means something.
Dim cmd, i
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & """" & WScript.Arguments(i) & """ "
Next
WScript.Quit CreateObject("WScript.Shell").Run(cmd, 0, True)
