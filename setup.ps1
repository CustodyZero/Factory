#Requires -Version 5.1
<#
.SYNOPSIS
    Factory setup script for Windows hosts.

.DESCRIPTION
    Run this from the HOST PROJECT ROOT after cloning factory as a subdirectory:

        git clone https://github.com/custodyzero/factory.git factory
        .\factory\setup.ps1

    What this script does:
        1. Installs factory dependencies (inside factory/)
        2. Copies template files to host project root (no-clobber)
        3. Configures git hooks to use factory/hooks/
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir
$FactoryDir = Split-Path -Leaf $ScriptDir

Write-Host ''
Write-Host 'Factory Setup'
Write-Host '============='
Write-Host "  Project root: $ProjectRoot"
Write-Host "  Factory dir:  $FactoryDir/"
Write-Host ''

# -- 1. Install factory dependencies ------------------------------------------

Write-Host 'Installing factory dependencies...'
Push-Location $ScriptDir
try {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        pnpm install --frozen-lockfile 2>$null
        if ($LASTEXITCODE -ne 0) { pnpm install }
    }
    elseif (Get-Command npm -ErrorAction SilentlyContinue) {
        npm ci 2>$null
        if ($LASTEXITCODE -ne 0) { npm install }
    }
    else {
        Write-Error 'Neither pnpm nor npm found. Node.js is required for factory tooling.'
    }
}
finally {
    Pop-Location
}

# -- 2. Copy template files (no-clobber) --------------------------------------

function Copy-Template {
    param([string]$Source, [string]$Destination)
    if (Test-Path $Destination) {
        Write-Host "  SKIP  $Destination (already exists)"
    }
    else {
        Copy-Item $Source $Destination
        Write-Host "  COPY  $Destination"
    }
}

Write-Host ''
Write-Host 'Copying template files...'

Push-Location $ProjectRoot
try {
    Copy-Template "$FactoryDir/templates/factory.config.json" 'factory.config.json'
    Copy-Template "$FactoryDir/templates/CLAUDE.md" 'CLAUDE.md'
    Copy-Template "$FactoryDir/templates/AGENTS.md" 'AGENTS.md'
}
finally {
    Pop-Location
}

# -- 3. Configure git hooks ---------------------------------------------------

Write-Host ''
Write-Host 'Configuring git hooks...'
Push-Location $ProjectRoot
try {
    git config core.hooksPath "$FactoryDir/hooks"
    Write-Host "  Set core.hooksPath = $FactoryDir/hooks"
}
finally {
    Pop-Location
}

# -- Done ---------------------------------------------------------------------

Write-Host ''
Write-Host 'Factory setup complete.'
Write-Host ''
Write-Host 'Next steps:'
Write-Host "  1. Edit factory.config.json - set project_name and verification commands"
Write-Host '  2. Edit CLAUDE.md - customize for your project'
Write-Host "  3. Run: npx tsx $FactoryDir/tools/status.ts"
Write-Host ''
