#Requires -Version 7.0
<#
.SYNOPSIS
    One entry point for the iteration loops in docs/preview.md.

.DESCRIPTION
    Wraps the local dev stack, the tunnelled preview, the VPS preview host, baseline
    regeneration, and the pre-push gate. Every mode here is a wrapper over something that
    also works by hand -- nothing is only reachable through this script, deliberately, so
    a broken assumption in it can never be the only way to do the thing.

    Modes are mutually exclusive (PowerShell parameter sets enforce it):

      -Dev [-SignIn]     local stack + vite dev, everything on localhost
      -Tunnel            vite dev against the DEPLOYED api, exposed on a real hostname
      -Deploy            build locally and ship to the VPS preview host
      -Baselines         regenerate the chromium-linux visual baselines in a container
      -Check             the full pre-push gate, including the server project
      -Down              stop the local dev stack
      -Status            what is running right now (the default)

.EXAMPLE
    .\scripts\dev.ps1 -Dev -SignIn
    Local everything, with a fake sign-in button that needs no OIDC configuration.

.EXAMPLE
    .\scripts\dev.ps1 -Tunnel -TunnelName adventures-preview
    HMR on a real hostname, talking to the deployed API and your real session.

.EXAMPLE
    .\scripts\dev.ps1 -Deploy
    ~25s to a hosted URL that outlives this terminal. Open tabs reload themselves.
#>
[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
    # Local stack + vite dev. Nothing leaves the machine.
    [Parameter(ParameterSetName = 'Dev', Mandatory)]
    [switch]$Dev,

    # Registers identity/dev.ts so the site's own "Sign in" button works locally with no
    # OIDC issuer to configure. Refused by the server outright under NODE_ENV=production.
    [Parameter(ParameterSetName = 'Dev')]
    [switch]$SignIn,

    # vite dev against the deployed API, exposed through cloudflared.
    [Parameter(ParameterSetName = 'Tunnel', Mandatory)]
    [switch]$Tunnel,

    # A cloudflared *named* tunnel, already created and DNS-routed. Without it this falls
    # back to a quick tunnel on a random trycloudflare.com name -- see the warning in
    # Start-Tunnel about what that costs you.
    [Parameter(ParameterSetName = 'Tunnel')]
    [string]$TunnelName,

    [Parameter(ParameterSetName = 'Deploy', Mandatory)]
    [switch]$Deploy,

    [Parameter(ParameterSetName = 'Baselines', Mandatory)]
    [switch]$Baselines,

    [Parameter(ParameterSetName = 'Check', Mandatory)]
    [switch]$Check,

    [Parameter(ParameterSetName = 'Down', Mandatory)]
    [switch]$Down,

    [Parameter(ParameterSetName = 'Status')]
    [switch]$Status
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DevCompose = Join-Path $RepoRoot 'server/docker-compose.yml'
$DeployedApi = 'https://adventures-api.subzerodev.com'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Note([string]$Message) { Write-Host "    $Message" -ForegroundColor DarkGray }
function Write-Warn([string]$Message) { Write-Host "!!  $Message" -ForegroundColor Yellow }

# Native commands do not throw on a non-zero exit, and every mode here chains several of
# them -- without this a failed `npm ci` would fall through to the step that depends on it.
function Invoke-Native {
    param([Parameter(Mandatory)][string]$Command, [string[]]$Arguments = @())
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command $($Arguments -join ' ') exited with $LASTEXITCODE"
    }
}

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Assert-Docker {
    if (-not (Test-Command 'docker')) { throw 'docker is not on PATH.' }
    & docker info *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Docker is not running. Start Docker Desktop first.' }
}

# `.env.preview` is git-ignored and read by scripts/deploy-preview.mjs; this parses it only
# to *report* configuration and to pick a tunnel hostname, never to duplicate the deploy
# script's own defaults.
function Read-EnvFile([string]$Path) {
    $values = @{}
    if (-not (Test-Path $Path)) { return $values }
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $split = $trimmed.IndexOf('=')
        if ($split -lt 1) { continue }
        $values[$trimmed.Substring(0, $split).Trim()] = $trimmed.Substring($split + 1).Trim()
    }
    return $values
}

function Get-DbPort {
    if ($env:ADVENTURES_DB_PORT) { return $env:ADVENTURES_DB_PORT }
    return '5432'
}

function Start-DevStack([bool]$WithDevIdentity) {
    Assert-Docker
    $previous = $env:DEV_IDENTITY
    try {
        # server/docker-compose.yml interpolates ${DEV_IDENTITY:-}, so this is read from the
        # process environment at `up` time -- setting it after the fact does nothing.
        $env:DEV_IDENTITY = if ($WithDevIdentity) { '1' } else { '' }
        Write-Step "Starting the local dev stack$(if ($WithDevIdentity) { ' (fake sign-in enabled)' })"
        Invoke-Native 'docker' @('compose', '-f', $DevCompose, 'up', '-d', '--build')
    }
    finally {
        $env:DEV_IDENTITY = $previous
    }
}

function Invoke-Dev {
    Start-DevStack -WithDevIdentity:$SignIn.IsPresent
    if ($SignIn) {
        Write-Note 'Sign-in: click the site''s own "Sign in" button. It resolves to a fixed local player.'
    }
    else {
        Write-Note 'No sign-in configured. Re-run with -SignIn for a fake local one.'
    }
    Write-Step 'Starting vite (local API). Ctrl-C stops vite; the stack keeps running.'
    Push-Location $RepoRoot
    try {
        # No VITE_API_URL: src/play/composition.ts falls back to same-origin, which the vite
        # proxy-free setup serves from public/campaigns -- the local stack is reached by the
        # frontend's own configured default, not by an override this script invents.
        Invoke-Native 'npm' @('run', 'dev')
    }
    finally { Pop-Location }
}

function Start-Tunnel {
    if (-not (Test-Command 'cloudflared')) {
        throw 'cloudflared is not on PATH. Install it, or run the two commands in docs/preview.md by hand.'
    }

    $preview = Read-EnvFile (Join-Path $RepoRoot '.env.preview')
    $name = $TunnelName
    if (-not $name -and $preview.ContainsKey('PREVIEW_TUNNEL_NAME')) {
        $name = $preview['PREVIEW_TUNNEL_NAME']
    }

    if (-not $name) {
        Write-Warn 'No -TunnelName and no PREVIEW_TUNNEL_NAME in .env.preview.'
        Write-Warn 'Falling back to a QUICK tunnel on a random trycloudflare.com hostname.'
        Write-Warn 'That hostname is not under subzerodev.com, so two things will not work:'
        Write-Warn '  - the API will reject it unless you add it to PREVIEW_ORIGINS, and'
        Write-Warn '  - your session cookie will not be sent (cross-site), so you stay anonymous.'
        Write-Warn 'For a signed-in preview, create a named tunnel routed to a *.subzerodev.com host:'
        Write-Warn '  cloudflared tunnel create adventures-preview'
        Write-Warn '  cloudflared tunnel route dns adventures-preview dev.adventures.subzerodev.com'
    }

    Push-Location $RepoRoot
    $vite = $null
    $previousApi = $env:VITE_API_URL
    try {
        # The whole point of this mode: the browser talks to the deployed API, so what you
        # are looking at is the real back end with your real session, not a local replica.
        $env:VITE_API_URL = $DeployedApi
        Write-Step "Starting vite against $DeployedApi"
        # -NoNewWindow shares this console, so vite's errors and cloudflared's banner
        # interleave in one place instead of vanishing into a detached window.
        $vite = Start-Process -FilePath 'npm' -ArgumentList @('run', 'dev') `
            -NoNewWindow -PassThru -WorkingDirectory $RepoRoot

        Write-Step 'Starting cloudflared (Ctrl-C stops both)'
        if ($name) {
            Invoke-Native 'cloudflared' @('tunnel', 'run', '--url', 'http://localhost:5173', $name)
        }
        else {
            Invoke-Native 'cloudflared' @('tunnel', '--url', 'http://localhost:5173')
        }
    }
    finally {
        $env:VITE_API_URL = $previousApi
        if ($vite -and -not $vite.HasExited) {
            Write-Step 'Stopping vite'
            # The npm shim spawns vite as a child, so killing the shim alone orphans it.
            Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue
            Get-CimInstance Win32_Process -Filter "ParentProcessId = $($vite.Id)" -ErrorAction SilentlyContinue |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        }
    }
}

function Invoke-DeployPreview {
    Push-Location $RepoRoot
    try {
        if (-not (Test-Path (Join-Path $RepoRoot '.env.preview'))) {
            Write-Warn '.env.preview not found -- deploy-preview.mjs will tell you what it needs.'
        }
        Invoke-Native 'npm' @('run', 'deploy:preview')
    }
    finally { Pop-Location }
}

function Invoke-Baselines {
    Assert-Docker
    Push-Location $RepoRoot
    try {
        Write-Step 'Regenerating chromium-linux visual baselines in a container'
        Write-Note 'First run downloads a Chromium; later runs reuse a cached volume.'
        Invoke-Native 'npm' @('run', 'baselines:update')
    }
    finally { Pop-Location }
}

function Invoke-Check {
    Push-Location $RepoRoot
    $previousDb = $env:DATABASE_URL
    try {
        Write-Step 'Root gate: format, lint, typecheck, unit + browser tests, build'
        Invoke-Native 'npm' @('run', 'check')

        # `npm run check` deliberately does not reach into server/ (it is a separate npm
        # project, run as its own CI job) -- but "did I break anything" has to cover it, or
        # this mode would give a false all-clear before a push.
        Write-Step 'Server project: typecheck, migrations, tests'
        Assert-Docker
        Invoke-Native 'docker' @('compose', '-f', $DevCompose, 'up', '-d', 'db')
        $env:DATABASE_URL = "postgres://adventures:adventures@localhost:$(Get-DbPort)/adventures"
        Invoke-Native 'npm' @('run', 'typecheck', '--prefix', 'server')
        Invoke-Native 'npm' @('run', 'migrate', '--prefix', 'server', 'up')
        Invoke-Native 'npm' @('test', '--prefix', 'server')

        Write-Host ''
        Write-Host 'All gates passed.' -ForegroundColor Green
        Write-Note 'Visual baselines are only asserted on Linux -- run -Baselines if you changed rendered output.'
    }
    finally {
        $env:DATABASE_URL = $previousDb
        Pop-Location
    }
}

function Stop-DevStack {
    Assert-Docker
    Write-Step 'Stopping the local dev stack'
    Invoke-Native 'docker' @('compose', '-f', $DevCompose, 'down')
}

function Show-Status {
    Write-Step 'Local dev stack'
    if (Test-Command 'docker') {
        # `compose ps` exits 0 with no rows when nothing is up, so the exit code alone
        # cannot distinguish "stopped" from "listed something" -- test the output instead.
        $running = & docker compose -f $DevCompose ps --format '    {{.Service}}  {{.Status}}' 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Note 'could not query Docker (is it running?)' }
        elseif (-not $running) { Write-Note 'not running -- start it with -Dev' }
        else { $running | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray } }
    }
    else { Write-Note 'docker not on PATH' }

    Write-Step 'Local API sign-in provider'
    try {
        $me = Invoke-RestMethod -Uri 'http://localhost:8787/api/me' -TimeoutSec 3
        $provider = if ($me.signInProvider) { $me.signInProvider } else { 'none (start with -Dev -SignIn for a fake one)' }
        Write-Note "signInProvider: $provider"
    }
    catch { Write-Note 'local API not reachable on :8787' }

    Write-Step 'Preview host configuration'
    $previewEnv = Join-Path $RepoRoot '.env.preview'
    if (Test-Path $previewEnv) {
        $values = Read-EnvFile $previewEnv
        foreach ($key in ($values.Keys | Sort-Object)) {
            Write-Note "$key = $($values[$key])"
        }
    }
    else {
        Write-Note '.env.preview not found -- -Deploy needs PREVIEW_SSH_HOST and PREVIEW_API_URL.'
    }

    Write-Step 'Tooling'
    foreach ($tool in @('docker', 'cloudflared', 'ssh', 'tar')) {
        $found = if (Test-Command $tool) { 'yes' } else { 'NO' }
        Write-Note "$tool : $found"
    }

    Write-Host ''
    Write-Note 'Modes: -Dev [-SignIn] | -Tunnel [-TunnelName x] | -Deploy | -Baselines | -Check | -Down'
    Write-Note 'Full detail: docs/preview.md'
}

switch ($PSCmdlet.ParameterSetName) {
    'Dev' { Invoke-Dev }
    'Tunnel' { Start-Tunnel }
    'Deploy' { Invoke-DeployPreview }
    'Baselines' { Invoke-Baselines }
    'Check' { Invoke-Check }
    'Down' { Stop-DevStack }
    default { Show-Status }
}
