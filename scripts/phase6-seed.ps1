# Phase 6 live-validation seed. Registers real definitions and creates real
# workflow instances so the cockpit renders genuine data.
# Credential-free by design: key material is read from FATHOM_API_KEYS
# (label:role:key,...) at run time and never written into this file.
# Prereq: the control plane is running (see docs/PHASE_6_VALIDATION_REPORT.md §1).
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8080'

# role -> bearer token, parsed from the same env the server uses.
$tokens = @{}
foreach ($entry in ($env:FATHOM_API_KEYS -split ',')) {
  $p = $entry.Trim() -split ':'
  if ($p.Count -ge 3) { $tokens[$p[1]] = $p[2] }
}
if (-not $tokens['admin'] -or -not $tokens['operator']) {
  throw 'Set FATHOM_API_KEYS to include an admin and an operator entry (label:role:key,...).'
}
function H($role) { $t = $tokens[$role]; @{ Authorization = ('Bearer ' + $t) } }
function PostJson($path, $role, $obj, $extraHeaders) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  $h = H $role
  if ($extraHeaders) { foreach ($k in $extraHeaders.Keys) { $h[$k] = $extraHeaders[$k] } }
  Invoke-RestMethod -Uri ($base + $path) -Method Post -Headers $h -ContentType 'application/json' -Body $json
}

$deadline = (Get-Date).ToUniversalTime().AddHours(2).ToString('yyyy-MM-ddTHH:mm:ssZ')

Write-Host '== register echo-single (happy path) =='
PostJson '/v1/definitions' 'admin' @{ name='echo-single'; version=1; steps=@(@{ type='echo' }) } | ConvertTo-Json -Compress

Write-Host '== register echo-compensate (compensation path) =='
PostJson '/v1/definitions' 'admin' @{ name='echo-compensate'; version=1; steps=@(
  @{ type='echo'; compensable=$true; compensator_task='echo' },
  @{ type='finalize'; max_attempts=1 }
) } | ConvertTo-Json -Compress

Write-Host '== create echo-single instance =='
PostJson '/v1/workflows' 'operator' @{ def_name='echo-single'; business_key='demo-happy-1'; input=@{ note='happy path' }; deadline=$deadline } @{ 'Idempotency-Key' = [guid]::NewGuid().ToString() } | ConvertTo-Json -Compress

Write-Host '== create echo-compensate instance =='
PostJson '/v1/workflows' 'operator' @{ def_name='echo-compensate'; business_key='demo-comp-1'; input=@{ note='compensation path' }; deadline=$deadline } @{ 'Idempotency-Key' = [guid]::NewGuid().ToString() } | ConvertTo-Json -Compress

Write-Host '== list definitions (reader) =='
$rd = H 'reader'
Invoke-RestMethod -Uri ($base + '/v1/definitions') -Headers $rd | ConvertTo-Json -Depth 6 -Compress
