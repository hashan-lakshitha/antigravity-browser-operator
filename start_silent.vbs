Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\r123t\Documents\www\browser-operator"
WshShell.Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\r123t\Documents\www\browser-operator\server\bridge.js""", 0, False
