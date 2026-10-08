#Requires -RunAsAdministrator
# CONTROLLED TEST ONLY. Registers two SEPARATE probe tasks to find a least-privilege, network-capable identity that
# runs while nobody is signed in. It does NOT modify EmploymentCollector-Tick / -Wake or any other task, stores no
# password, and uses a probe-only deploy key (write access to the private LHBUSA/pbe-collector-probe repo only).
#   S4U probe:           runs as JUSTINPC\goodl with "do not store password" (Microsoft documents no network access
#                        for S4U; this test checks it directly).
#   LOCAL SERVICE probe: built-in least-privilege service account, no password, network access as the computer.
# Each run records identity, signed-in state, a public HTTPS fetch, SSH authentication and a confirmed push.
# Runs every 5 minutes for 6 hours and at startup. Remove afterwards with -Remove.
#   powershell -ExecutionPolicy Bypass -File D:\Workers\employment-collector\scripts\research\employment\collector\owner-probe-tasks.ps1 [-Remove]
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$path = '\PropBetEdge-Research\'
$names = 'EmploymentCollector-Probe-S4U', 'EmploymentCollector-Probe-LocalService'
if ($Remove) { foreach ($n in $names) { Unregister-ScheduledTask -TaskPath $path -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue }; Remove-Item -Recurse -Force 'C:\ProgramData\pbe-collector-probe' -ErrorAction SilentlyContinue; 'probe tasks removed'; return }

$node = 'C:\Program Files\nodejs\node.exe'
$probe = 'D:\Workers\employment-collector\scripts\research\employment\collector\probe.mjs'
$userKeyDir = 'C:\Users\goodl\.pbe-employment-collector'

# LOCAL SERVICE cannot read goodl's key folder. Give it its own copy of the PROBE key only, owned by Administrators,
# readable by LOCAL SERVICE (Windows OpenSSH refuses keys readable by other non-admin principals).
$lsDir = 'C:\ProgramData\pbe-collector-probe'
New-Item -ItemType Directory -Force $lsDir | Out-Null
Copy-Item "$userKeyDir\probe-deploy-key" "$lsDir\probe-deploy-key" -Force
Copy-Item "$userKeyDir\known_hosts" "$lsDir\known_hosts" -Force
icacls $lsDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
icacls $lsDir /setowner Administrators /T | Out-Null

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$start = (Get-Date).AddMinutes(2)
$repeat = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Hours 6)
$boot = New-ScheduledTaskTrigger -AtStartup

$a1 = New-ScheduledTaskAction -Execute $node -Argument "`"$probe`" s4u E:\Workers\collector-probe\clone-s4u $userKeyDir\probe-deploy-key $userKeyDir\known_hosts"
$p1 = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\goodl" -LogonType S4U -RunLevel Limited
Register-ScheduledTask -TaskPath $path -TaskName $names[0] -Action $a1 -Trigger @($repeat, $boot) -Settings $settings -Principal $p1 -Description 'TEST ONLY: unattended identity probe (S4U). Remove with owner-probe-tasks.ps1 -Remove.' -Force | Out-Null

$a2 = New-ScheduledTaskAction -Execute $node -Argument "`"$probe`" localservice E:\Workers\collector-probe\clone-localservice $lsDir\probe-deploy-key $lsDir\known_hosts"
$p2 = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
Register-ScheduledTask -TaskPath $path -TaskName $names[1] -Action $a2 -Trigger @($repeat, $boot) -Settings $settings -Principal $p2 -Description 'TEST ONLY: unattended identity probe (LOCAL SERVICE). Remove with owner-probe-tasks.ps1 -Remove.' -Force | Out-Null

foreach ($n in $names) { $t = Get-ScheduledTask -TaskPath $path -TaskName $n; '{0}: {1} {2} first run {3}' -f $n, $t.Principal.UserId, $t.Principal.LogonType, (Get-ScheduledTaskInfo -TaskPath $path -TaskName $n).NextRunTime }
'Collector tasks untouched:'; Get-ScheduledTask -TaskPath $path | Where-Object TaskName -in 'EmploymentCollector-Tick', 'EmploymentCollector-Wake' | ForEach-Object { '{0}: {1}' -f $_.TaskName, $_.Principal.LogonType }
'Next: stay signed in for one run (about 2 min), then SIGN OUT for at least 15 minutes (optionally restart), then sign back in and tell goodl-c0.'
