#Requires -Version 5.1
<#
.SYNOPSIS
    Factory setup script for Windows hosts.

.DESCRIPTION
    Run this from the HOST PROJECT ROOT after adding factory as a submodule:

        git submodule add https://github.com/custodyzero/factory.git .factory
        .\.factory\setup.ps1

    Layout after setup:
        .factory\     - tooling (git submodule, hidden)
        factory\      - artifacts (features, packets, completions)

    What this script does:
        1. Installs factory dependencies (inside .factory/)
        2. Copies template files to host project root (no-clobber)
        3. Creates artifact directories under factory/
        4. Seeds host-project memory + cache directories
        5. Configures git hooks
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir
$FactoryDir = Split-Path -Leaf $ScriptDir
$ArtifactDir = 'factory'

Write-Host ''
Write-Host 'Factory Setup'
Write-Host '============='
Write-Host "  Project root:  $ProjectRoot"
Write-Host "  Tooling dir:   $FactoryDir/   (submodule)"
Write-Host "  Artifact dir:  $ArtifactDir/  (features, packets, completions)"
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

    # -- 3. Create artifact directories ----------------------------------------

    Write-Host ''
    Write-Host 'Creating artifact directories...'
    foreach ($subdir in @('intents', 'features', 'packets', 'completions')) {
        $path = "$ArtifactDir/$subdir"
        if (-not (Test-Path $path)) { New-Item -ItemType Directory -Path $path | Out-Null }
        Write-Host "  MKDIR $path/"
    }

    # -- 4. Seed host-project memory + cache directories -----------------------

    Write-Host ''
    Write-Host 'Creating memory and cache directories...'
    foreach ($subdir in @(
        'memory',
        'memory/architectural-facts',
        'memory/recurring-failures',
        'memory/project-conventions',
        'memory/code-patterns',
        'memory/suggestions',
        'cache'
    )) {
        $path = "$ArtifactDir/$subdir"
        if (-not (Test-Path $path)) { New-Item -ItemType Directory -Path $path | Out-Null }
        Write-Host "  MKDIR $path/"
    }
    Copy-Template "$FactoryDir/templates/memory.md" "$ArtifactDir/memory/MEMORY.md"

    if (Test-Path '.gitignore') {
        $ignoreLine = "$ArtifactDir/cache/"
        $gitignore = Get-Content '.gitignore'
        if ($gitignore -notcontains $ignoreLine) {
            Add-Content '.gitignore' "`n$ignoreLine"
            Write-Host "  APPEND .gitignore -> $ignoreLine"
        }
        else {
            Write-Host "  SKIP  .gitignore ($ignoreLine already present)"
        }
    }
}
finally {
    Pop-Location
}

# -- 5. Configure git hooks ---------------------------------------------------

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
Write-Host "  3. Create a spec under specs/<spec-id>.md and run:"
Write-Host "     npx tsx $FactoryDir/tools/run.ts <spec-id>"
Write-Host "     (hand-authored intents under $ArtifactDir/intents/ remain supported for back-compat)"
Write-Host ''
