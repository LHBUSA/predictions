#Requires -RunAsAdministrator
# CLOCK ONLY. Starts Windows Time with its existing default configuration and resynchronizes once.
# It changes no scheduled task, no NTP peer list and no time policy. Run from an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File D:\Workers\wt\pred-employment\scripts\research\employment\collector\owner-clock-setup.ps1
$ErrorActionPreference = 'Stop'
'BEFORE:'; Get-Service w32time | Format-List Status, StartType | Out-String
w32tm /query /configuration | Select-String -Pattern 'NtpServer|^Type' | ForEach-Object { $_.Line.Trim() }
Set-Service w32time -StartupType Automatic
Start-Service w32time
Start-Sleep 3
w32tm /resync
'AFTER:'; Get-Service w32time | Format-List Status, StartType | Out-String
w32tm /query /status
w32tm /stripchart /computer:time.windows.com /samples:3 /dataonly
