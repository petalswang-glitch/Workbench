Option Explicit

Dim shell, fileSystem, projectRoot, powerShellScript, command

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

projectRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
powerShellScript = fileSystem.BuildPath(projectRoot, "scripts\start-workbench.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(powerShellScript)

' WindowStyle=0 keeps the PowerShell host hidden; the script still shows normal error dialogs if needed.
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
