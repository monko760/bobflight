# Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
# Starts the local builder UI. Never compiles or flashes firmware automatically.
[CmdletBinding()]
param([string]$ToolRoot = (Join-Path $PSScriptRoot 'tools'))
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $ToolRoot) {
    $env:BOBFLIGHT_TOOL_ROOT = (Resolve-Path -LiteralPath $ToolRoot).Path
}
Set-Location (Join-Path $PSScriptRoot 'bobflight-configurator')
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
& npm.cmd --prefix protocol run build
if ($LASTEXITCODE -ne 0) { throw 'Protocol build failed.' }
& npm.cmd run targets:generate
if ($LASTEXITCODE -ne 0) { throw 'Target generation failed.' }
Set-Location (Join-Path $PSScriptRoot 'bobflight-configurator\ui')
Write-Host 'Open http://127.0.0.1:5173. Select a board, then Build HEX. Nothing flashes automatically.'
& node.exe '..\node_modules\vite\bin\vite.js' --host 127.0.0.1 --port 5173 --strictPort
if ($LASTEXITCODE -ne 0) { throw 'Configurator server exited with an error.' }
