#Requires -RunAsAdministrator
# Employment Tier A collector: the two ADMIN-ONLY steps. The owner runs this once from an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File D:\Workers\employment-collector\scripts\research\employment\collector\owner-admin-setup.ps1
# It changes nothing else: no production system, no CPI SHADOW, no other scheduled task.
$ErrorActionPreference = 'Stop'

# 1. Windows Time: automatic start, explicit NTP peers, immediate resync.
Set-Service w32time -StartupType Automatic
Start-Service w32time
w32tm /config /manualpeerlist:"time.cloudflare.com,0x8 time.windows.com,0x8 time.google.com,0x8" /syncfromflags:manual /reliable:no /update | Out-Null
Restart-Service w32time
Start-Sleep 2
w32tm /resync /force
w32tm /query /status

# 2. Unattended operation: run both collector tasks as S4U ("whether the user is logged on or not", no stored password).
#    S4U has no Windows Credential Manager access; evidence pushes already use the repo-scoped SSH deploy key under
#    C:\Users\goodl\.pbe-employment-collector (user-only ACL), so nothing else is needed.
$path = '\PropBetEdge-Research\'
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\goodl" -LogonType S4U -RunLevel Limited
foreach ($name in 'EmploymentCollector-Tick', 'EmploymentCollector-Wake') {
  Set-ScheduledTask -TaskPath $path -TaskName $name -Principal $principal | Out-Null
}
# The tick task also starts at boot (a logon trigger cannot fire while nobody is logged on).
$t = Get-ScheduledTask -TaskPath $path -TaskName 'EmploymentCollector-Tick'
$triggers = @($t.Triggers | Where-Object { $_.CimClass.CimClassName -ne 'MSFT_TaskBootTrigger' }) + (New-ScheduledTaskTrigger -AtStartup)
Set-ScheduledTask -TaskPath $path -TaskName 'EmploymentCollector-Tick' -Trigger $triggers | Out-Null

Get-ScheduledTask -TaskPath $path | Where-Object TaskName -like 'EmploymentCollector-*' | ForEach-Object {
  "{0}: logon={1} state={2} triggers={3}" -f $_.TaskName, $_.Principal.LogonType, $_.State, (($_.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace 'MSFT_Task', '' }) -join ',')
}
'Done. Next: sign out for at least 15 minutes (or restart), sign back in, then ask goodl-c0 to check ticks.log for continuity.'
