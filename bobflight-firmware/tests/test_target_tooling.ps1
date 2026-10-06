# SPDX-License-Identifier: Apache-2.0
# Run under either Windows PowerShell 5.1 or PowerShell Core. No hardware access.
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$buildScript = Join-Path $repo 'build-target.ps1'
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($buildScript, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count) { throw ($errors | Out-String) }
& $buildScript -ListTargets
& $buildScript -Target tmotor_f7_v2 -ValidateOnly
foreach ($target in @('dummy', 'does_not_exist')) {
  $rejected = $false
  try { & $buildScript -Target $target -ValidateOnly }
  catch {
    if ($_.Exception.Message -notmatch 'Target selection rejected') { throw }
    $rejected = $true
  }
  if (!$rejected) { throw "Unsafe target accepted: $target" }
}
$global:LASTEXITCODE = 0
