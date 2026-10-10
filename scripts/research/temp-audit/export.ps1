# Issue #64 read-only export of the temperature cohort (tkmln). Each query in sql\ must be a single SELECT/WITH; it runs
# inside BEGIN TRANSACTION READ ONLY over the Supabase Management API and its rows are written to <OutDir>\<name>.json.
#   pwsh scripts/research/temp-audit/export.ps1 -OutDir E:\Temp\t64
param([Parameter(Mandatory)][string]$OutDir)
$ErrorActionPreference = 'Stop'
. D:\Workers\nba-propbetedge\scripts\db\nba_db_common.ps1
New-Item -ItemType Directory -Force $OutDir | Out-Null
$tok = Get-NbaSupabaseToken
foreach ($f in Get-ChildItem (Join-Path $PSScriptRoot 'sql') -Filter *.sql) {
  $sql = (Get-Content -Raw -LiteralPath $f.FullName).Trim().TrimEnd(';')
  if ($sql -notmatch '^(?is)\s*(select|with)\b') { throw "$($f.Name): only SELECT/WITH allowed" }
  if ($sql -match '(?i)\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|call|do)\b\s') { throw "$($f.Name): write keyword present" }
  $r = Invoke-NbaQuery 'tkmlnhmylqnttmnsnief' "begin transaction read only; select coalesce(json_agg(t), '[]'::json) as rows from ($sql) t;" $tok
  if (-not $r.ok) { throw "$($f.Name): query failed" }
  $rows = $r.rows[0].rows
  $out = Join-Path $OutDir ($f.BaseName + '.json')
  if ($rows -is [string]) { Set-Content -LiteralPath $out -Value $rows -Encoding utf8 } else { $rows | ConvertTo-Json -Depth 30 -Compress | Set-Content -LiteralPath $out -Encoding utf8 }
  Write-Output "$($f.Name) -> $out"
}
