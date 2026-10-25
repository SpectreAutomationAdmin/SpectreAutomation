<#
.SYNOPSIS
    SIGNUP-1G Phase D step 1 -- Activate the Microsoft 365 transactional
    email adapter on the Spectre staging Fly app, by setting the five
    required secrets.  The client secret is entered interactively.

.DESCRIPTION
    Prerequisites (must be satisfied before running this script):
      1. signup-1g-ms365-repair.ps1 exited 0 (Exchange RBAC repaired
         + positive + negative verified).
      2. signup-1g-entra-permissions-audit.ps1 exited 0 (no
         application-permission Mail.Send on this app).
      3. signup-1g-graph-send-test.ps1 exited 0 (positive 202 +
         negative 403 against live Graph).

    This script is the ONLY step that puts a client secret into a
    Fly deployment.  It uses the same Read-Host -AsSecureString
    pattern as the Graph send-test, so the secret never enters
    command-line arguments, shell history, source files, logs, or
    chat.

    After the secrets land, Fly restarts the web app; the Microsoft 365
    adapter will be live within ~30 seconds.

    The script does NOT touch spectre-staging-worker (worker doesn't
    send signup email).

    The script does NOT touch production.

.PARAMETER TenantId
    REQUIRED.  Entra Directory (tenant) ID (GUID).

.PARAMETER AppClientId
    REQUIRED.  The Spectre Transactional Mail app's Application
    (client) ID (GUID).  Must match the value proven out by the
    repair + audit + send-test scripts.

.PARAMETER FromMailbox
    REQUIRED-with-default.  The authorized sender address.  Default:
    no-reply@spectreautomation.com.

.PARAMETER App
    REQUIRED-with-default.  Fly app name.  Default: spectre-staging.
    Explicitly refuses to run against the production app.

.PARAMETER FlyctlPath
    OPTIONAL.  Full path to flyctl.exe.  If omitted, uses the PATH
    lookup.

.PARAMETER DryRun
    OPTIONAL.  If set, prints the flyctl invocation that WOULD run
    (with the secret value replaced by <redacted>) and exits without
    modifying any Fly secret.

.NOTES
    EXIT CODES:
      0  - Fly secrets set successfully.
      2  - Preflight failure (flyctl not found, auth missing).
      3  - Refused to target a non-staging app.
      4  - flyctl secrets set failed.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$TenantId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$AppClientId,

    [Parameter(Mandatory = $false)]
    [string]$FromMailbox = 'no-reply@spectreautomation.com',

    [Parameter(Mandatory = $false)]
    [string]$App = 'spectre-staging',

    [Parameter(Mandatory = $false)]
    [string]$FlyctlPath = '',

    [Parameter(Mandatory = $false)]
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Say-Section([string]$t) {
    Write-Host ""
    Write-Host "========================================================================" -ForegroundColor Cyan
    Write-Host $t -ForegroundColor Cyan
    Write-Host "========================================================================" -ForegroundColor Cyan
}
function Say-OK([string]$m)   { Write-Host "  [OK]      $m" -ForegroundColor Green }
function Say-Warn([string]$m) { Write-Host "  [WARN]    $m" -ForegroundColor Yellow }
function Say-Fail([string]$m) { Write-Host "  [FAIL]    $m" -ForegroundColor Red }
function Say-Info([string]$m) { Write-Host "  [INFO]    $m" }

Say-Section "Phase 0 -- Preflight"

# Refuse non-staging target.  Production activation is NOT authorised by this script.
if ($App -ne 'spectre-staging') {
    Say-Fail "Refusing to run against -App '$App'.  This script is staging-only."
    Say-Info "Production activation requires founder authorisation and must be a separate deliberate step."
    exit 3
}
Say-OK "Target Fly app: $App  (staging-only)"

# Resolve flyctl.
$flyctl = $FlyctlPath
if ([string]::IsNullOrWhiteSpace($flyctl)) {
    $cmd = Get-Command flyctl -ErrorAction SilentlyContinue
    if ($cmd) { $flyctl = $cmd.Source }
}
if ([string]::IsNullOrWhiteSpace($flyctl) -or -not (Test-Path $flyctl)) {
    Say-Fail "flyctl not found.  Install from https://fly.io/docs/hands-on/install-flyctl/ or pass -FlyctlPath."
    exit 2
}
Say-OK "flyctl: $flyctl"

# Confirm flyctl auth status.
try {
    $authOut = & $flyctl auth whoami 2>&1
    if ($LASTEXITCODE -ne 0) {
        Say-Fail "flyctl auth whoami failed.  Run: $flyctl auth login"
        exit 2
    }
    Say-OK "flyctl auth: $($authOut | Select-Object -First 1)"
} catch {
    Say-Fail "flyctl auth whoami threw: $($_.Exception.Message)"
    exit 2
}

Say-Section "Phase 1 -- Secret entry (interactive, no echo)"
Write-Host "The Spectre Transactional Mail client secret is required to activate the" -ForegroundColor Yellow
Write-Host "Microsoft 365 transactional email adapter on Fly staging." -ForegroundColor Yellow
Write-Host "The secret is read via Read-Host -AsSecureString -- nothing is echoed." -ForegroundColor Yellow

$script:plainSecret = $null
$sec = $null
try {
    $sec = Read-Host -AsSecureString "Paste the Spectre Transactional Mail client secret"
    if (-not $sec -or $sec.Length -eq 0) {
        Say-Fail "No secret entered.  Aborting."
        exit 2
    }
    $script:plainSecret = [System.Net.NetworkCredential]::new('', $sec).Password
    if ([string]::IsNullOrWhiteSpace($script:plainSecret)) {
        Say-Fail "Empty secret.  Aborting."
        exit 2
    }
    Say-OK "Secret captured in session memory."

    Say-Section "Phase 2 -- flyctl secrets set"

    $kv = @(
        'EMAIL_DELIVERY_MODE=microsoft365',
        "MICROSOFT_TENANT_ID=$TenantId",
        "MICROSOFT_CLIENT_ID=$AppClientId",
        "MICROSOFT_CLIENT_SECRET=$($script:plainSecret)",
        "MICROSOFT_FROM_MAILBOX=$FromMailbox"
    )

    # Preview the invocation with the secret redacted.  No logging of
    # the real value anywhere.
    $previewKv = $kv.ForEach({
        if ($_.StartsWith('MICROSOFT_CLIENT_SECRET=')) { 'MICROSOFT_CLIENT_SECRET=<redacted>' } else { $_ }
    })
    Say-Info "Would invoke:"
    Say-Info "  flyctl secrets set <5 KEY=VALUE pairs> --app $App"
    foreach ($line in $previewKv) {
        Say-Info "    $line"
    }

    if ($DryRun) {
        Say-Warn "DryRun: not invoking flyctl.  No Fly state changed."
        exit 0
    }

    Say-Info "Running flyctl secrets set (output below; Fly will restart the web app on completion)..."
    # Call operator (&) with array splatting -- each element becomes a
    # separate argv entry; no shell parsing happens, so the secret
    # value is never visible to a shell parser.
    & $flyctl secrets set @kv --app $App 2>&1 | ForEach-Object {
        # Belt-and-braces: scrub the plaintext from flyctl output.
        $redacted = ("$_").Replace($script:plainSecret, '<redacted>')
        Write-Host $redacted
    }
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Say-Fail "flyctl secrets set exited with code $exitCode."
        exit 4
    }

    Say-OK "flyctl secrets set completed."
    Say-Info ""
    Say-Info "Fly will roll the spectre-staging web app automatically (~30 s)."
    Say-Info "Next steps (verification):"
    Say-Info "  1. Wait ~45 s for Fly to finish rolling the web machines."
    Say-Info "  2. curl https://staging.spectreautomation.com/api/admin/signup/debug/status | jq .email"
    Say-Info "     Expect effectiveAdapter = microsoft365."
    Say-Info "  3. Walk a signup through https://staging.spectreautomation.com/signup;"
    Say-Info "     confirm a 'Resume your Spectre registration' email arrives at your test address."
    Say-Info "  4. Run the SIGNUP-1F cross-browser Playwright regression."
    exit 0
}
finally {
    if ($null -ne $script:plainSecret) {
        $script:plainSecret = ("x" * $script:plainSecret.Length)
        Remove-Variable plainSecret -Scope Script -Force -ErrorAction SilentlyContinue
    }
    if (Get-Variable -Name sec -ErrorAction SilentlyContinue) {
        $sec = $null
        Remove-Variable sec -Force -ErrorAction SilentlyContinue
    }
    [System.GC]::Collect()
}
