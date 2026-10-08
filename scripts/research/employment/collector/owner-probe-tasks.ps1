#Requires -RunAsAdministrator
# CONTROLLED, SHORT, SUPERVISED TEST ONLY. Registers two SEPARATE temporary probe tasks to find a least-privilege,
# network-capable identity that runs while nobody is signed in. It does NOT modify EmploymentCollector-Tick / -Wake /
# -Rehearsal or any other task, stores no password, and uses a probe-only deploy key (write access to the private
# LHBUSA/pbe-collector-probe repo only). Results go to E:\Workers\collector-probe and that repo, never to the evidence repo.
#   S4U probe:           runs as JUSTINPC\goodl with "do not store password" (Microsoft documents no network access
#                        for S4U; this test checks it directly).
#   LOCAL SERVICE probe: built-in least-privilege service account, no password, network access as the computer.
# Each run records identity, signed-in state, a public HTTPS fetch, SSH authentication and a confirmed push. PASS needs
# all four with no user signed in (probe.mjs).
# Window: every 5 minutes for -Minutes (default 30, max 60), no startup trigger. The tasks expire at the end of the
# window and Task Scheduler deletes them; -Remove deletes them at once plus the ProgramData key copy.
# Refuses to run if the window comes within 10 minutes of any scheduled EmploymentCollector-Rehearsal-* trigger,
# because the rehearsal needs the owner signed in.
#   powershell -ExecutionPolicy Bypass -File D:\Workers\wt\pred-employment\scripts\research\employment\collector\owner-probe-tasks.ps1 [-Minutes 30] [-Remove]
param([int]$Minutes = 30, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$path = '\PropBetEdge-Research\'
$names = 'EmploymentCollector-Probe-S4U', 'EmploymentCollector-Probe-LocalService'
$lsDir = 'C:\ProgramData\pbe-collector-probe'
if ($Remove) {
  foreach ($n in $names) { Unregister-ScheduledTask -TaskPath $path -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $lsDir -ErrorAction SilentlyContinue
  'Remaining tasks:'; Get-ScheduledTask -TaskPath $path | ForEach-Object { '  {0}: {1} {2}' -f $_.TaskName, $_.Principal.UserId, $_.Principal.LogonType }
  'ProgramData key copy present: ' + (Test-Path $lsDir)
  return
}
if ($Minutes -lt 15 -or $Minutes -gt 60) { throw 'Minutes must be 15-60.' }

$start = (Get-Date).AddMinutes(2)
$end = $start.AddMinutes($Minutes)
foreach ($t in Get-ScheduledTask -TaskPath $path | Where-Object TaskName -like 'EmploymentCollector-Rehearsal-*') {
  foreach ($tr in $t.Triggers) {
    $at = [datetime]$tr.StartBoundary
    if ($at -gt $start.AddMinutes(-10) -and $at -lt $end.AddMinutes(10)) { throw "Window $start - $end is within 10 min of $($t.TaskName) at $at. Run after the rehearsal or shorten -Minutes." }
  }
}

$node = 'C:\Program Files\nodejs\node.exe'
$probe = 'D:\Workers\employment-collector\scripts\research\employment\collector\probe.mjs'
$userKeyDir = 'C:\Users\goodl\.pbe-employment-collector'
foreach ($p in $node, $probe, "$userKeyDir\probe-deploy-key", "$userKeyDir\known_hosts", 'E:\Workers\collector-probe\clone-s4u\.git', 'E:\Workers\collector-probe\clone-localservice\.git') { if (-not (Test-Path $p)) { throw "missing $p" } }

# LOCAL SERVICE cannot read goodl's key folder. Give it its own copy of the PROBE key only: owner Administrators,
# full control SYSTEM + Administrators, read for LOCAL SERVICE (S-1-5-19), nothing for Users. Windows OpenSSH refuses
# a private key that any other non-admin principal can read. ACLs are set on the folder AND each file.
New-Item -ItemType Directory -Force $lsDir | Out-Null
icacls $lsDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
Copy-Item "$userKeyDir\probe-deploy-key" "$lsDir\probe-deploy-key" -Force
Copy-Item "$userKeyDir\known_hosts" "$lsDir\known_hosts" -Force
foreach ($f in "$lsDir\probe-deploy-key", "$lsDir\known_hosts") { icacls $f /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' '*S-1-5-19:R' | Out-Null }
icacls $lsDir /setowner Administrators /T | Out-Null
'Key copy ACL:'; icacls "$lsDir\probe-deploy-key"

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable:$false -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -DeleteExpiredTaskAfter (New-TimeSpan -Minutes 5)
$trigger = { $tr = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Minutes $Minutes); $tr.EndBoundary = $end.AddMinutes(1).ToString('s'); $tr }

$a1 = New-ScheduledTaskAction -Execute $node -Argument "`"$probe`" s4u E:\Workers\collector-probe\clone-s4u $userKeyDir\probe-deploy-key $userKeyDir\known_hosts"
$p1 = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\goodl" -LogonType S4U -RunLevel Limited
Register-ScheduledTask -TaskPath $path -TaskName $names[0] -Action $a1 -Trigger (& $trigger) -Settings $settings -Principal $p1 -Description 'TEMPORARY TEST ONLY: unattended identity probe (S4U). Expires automatically; remove with owner-probe-tasks.ps1 -Remove.' -Force | Out-Null

$a2 = New-ScheduledTaskAction -Execute $node -Argument "`"$probe`" localservice E:\Workers\collector-probe\clone-localservice $lsDir\probe-deploy-key $lsDir\known_hosts"
$p2 = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
Register-ScheduledTask -TaskPath $path -TaskName $names[1] -Action $a2 -Trigger (& $trigger) -Settings $settings -Principal $p2 -Description 'TEMPORARY TEST ONLY: unattended identity probe (LOCAL SERVICE). Expires automatically; remove with owner-probe-tasks.ps1 -Remove.' -Force | Out-Null

foreach ($n in $names) { $t = Get-ScheduledTask -TaskPath $path -TaskName $n; '{0}: {1} {2} first run {3}, window ends {4}' -f $n, $t.Principal.UserId, $t.Principal.LogonType, (Get-ScheduledTaskInfo -TaskPath $path -TaskName $n).NextRunTime, $end }
'Collector tasks untouched:'; Get-ScheduledTask -TaskPath $path | Where-Object TaskName -like 'EmploymentCollector-*' | Where-Object TaskName -notlike '*-Probe-*' | ForEach-Object { '  {0}: {1} {2} {3}' -f $_.TaskName, $_.Principal.UserId, $_.Principal.LogonType, $_.State }
"Next: stay signed in for the first run at $($start.ToString('HH:mm')) (a signed-in CONTROL), then SIGN OUT (Start > account > Sign out; locking is NOT enough) for at least 15 minutes, sign back in before $($end.ToString('HH:mm')), run this script with -Remove, and tell goodl-c0."
