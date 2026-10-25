<#
.SYNOPSIS
    SIGNUP-1G Phase D step 1 -- Activate the Microsoft 365 transactional
    email adapter on the Spectre staging Fly app via `flyctl secrets
    import` reading KEY=VALUE pairs from stdin.  The client secret is
    entered interactively and never appears in any flyctl invocation's
    command-line arguments.

.DESCRIPTION
    Prerequisites (must be satisfied before running this script):
      1. signup-1g-ms365-repair.ps1 exited 0 (Exchange RBAC repaired
         + positive + negative verified).
      2. signup-1g-entra-permissions-audit.ps1 exited 0 (no
         application-permission Mail.Send on this app).
      3. signup-1g-graph-send-test.ps1 exited 0 (positive 202 +
         negative 403 against live Graph).

    SECRET-HANDLING DESIGN (strengthened post-review).

    The common `flyctl secrets set KEY=VALUE` form puts the secret
    on the subprocess's command line, which is readable to any
    other process on the same Windows user session via
    `Get-CimInstance Win32_Process` (property `CommandLine`), or on
    Linux via `/proc/<pid>/cmdline`.  Array splatting prevents the
    PowerShell SHELL from parsing the secret, but the Windows
    process API still exposes it.

    This script instead uses `flyctl secrets import --app
    spectre-staging`.  flyctl reads NAME=VALUE lines from stdin
    (https://docs.fly.io/flyctl/secrets-import).  The subprocess's
    command line therefore contains only non-secret flags
    (`secrets import --app spectre-staging [--stage]`); the
    secret is written to flyctl's stdin via
    `System.Diagnostics.Process.StandardInput.WriteLine` and never
    appears in argv.

    Secret-exposure surface audit:

      1. Process command line (CLI argv).
         - flyctl's command line (verified at run time by this script
           via Win32_Process.CommandLine): contains only
           `secrets import --app <app>`.  No secret.
      2. PowerShell command history (PSReadLine).
         - The script's invocation ends at `.ps1 -TenantId <guid>
           -AppClientId <guid>` -- no secret in the command line
           either.  Secret is captured by Read-Host after the
           script starts; PSReadLine does not record Read-Host
           input.
      3. Shell history (bash/zsh when running under WSL).
         - Not applicable: this script is PowerShell.
      4. Source files.
         - No file is written.  The $kvLines variable holding the
           KEY=VALUE text is scrubbed before exit.
      5. Logs (flyctl stdout/stderr).
         - Captured line-by-line and run through a redactor that
           replaces any occurrence of the plaintext secret with
           `<redacted>` before printing.
      6. PowerShell session memory.
         - $plainSecret and $kvLines are scrubbed in the finally
           block; GC.Collect is called.  Memory contents until
           then are the irreducible exposure of using a
           client-credentials secret at all.
      7. Fly API transit.
         - HTTPS to Fly's control plane; encrypted at rest at Fly.
      8. Fly runtime environment.
         - The deployed app can read MICROSOFT_CLIENT_SECRET from
           process env, as intended.  The Spectre adapter uses it
           only to acquire a Graph token and never logs it.

    This script does NOT touch spectre-staging-worker.
    This script does NOT touch production (-App != spectre-staging
    is refused with exit 3).

.PARAMETER TenantId
    REQUIRED.  Entra Directory (tenant) ID (GUID).

.PARAMETER AppClientId
    REQUIRED.  The Spectre Transactional Mail Entra app's
    Application (client) ID (GUID).

.PARAMETER FromMailbox
    REQUIRED-with-default.  Default: no-reply@spectreautomation.com.

.PARAMETER App
    REQUIRED-with-default.  Fly app.  Default: spectre-staging.
    Non-staging target is refused.

.PARAMETER FlyctlPath
    OPTIONAL.  Full path to flyctl.exe.  If omitted, uses PATH.

.PARAMETER Stage
    OPTIONAL.  Pass --stage to flyctl, which sets the secrets but
    skips the automatic deploy.  Useful if you want to verify
    secret-set succeeded and defer the restart.  Default: not set
    (flyctl rolls the app).

.PARAMETER DryRun
    OPTIONAL.  Builds the flyctl invocation + the KEY=VALUE text
    (with secret replaced by <redacted>) but does not run flyctl.
    No Fly state changes.

.NOTES
    EXIT CODES:
      0  - Fly secrets imported successfully.
      2  - Preflight failure (flyctl missing, auth missing).
      3  - Refused to target a non-staging app.
      4  - flyctl secrets import failed OR self-verification of the
           subprocess command line found the secret in argv.
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
    [switch]$Stage,

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

# Pure function: redact any occurrence of a known secret in a string.
# Exercised in -Test mode of signup-1g-ms365-repair.ps1-style tests;
# here it is used inline on every captured output line.
function Protect-SecretInOutput {
    param(
        [Parameter(Mandatory=$true)][string]$Text,
        [Parameter(Mandatory=$true)][string]$Secret
    )
    if ([string]::IsNullOrWhiteSpace($Secret) -or [string]::IsNullOrEmpty($Text)) { return $Text }
    return $Text.Replace($Secret, '<redacted>')
}

Say-Section "Phase 0 -- Preflight"

if ($App -ne 'spectre-staging') {
    Say-Fail "Refusing to run against -App '$App'.  This script is staging-only."
    Say-Info "Production activation is a separate deliberate step requiring founder authorisation."
    exit 3
}
Say-OK "Target Fly app: $App  (staging-only)"

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
Write-Host "The Spectre Transactional Mail client secret is required to activate" -ForegroundColor Yellow
Write-Host "the Microsoft 365 transactional email adapter on Fly staging." -ForegroundColor Yellow
Write-Host "Enter via Read-Host -AsSecureString; nothing is echoed to the terminal." -ForegroundColor Yellow

$script:plainSecret = $null
$script:kvLines     = $null
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

    Say-Section "Phase 2 -- Build the stdin KEY=VALUE payload"
    $script:kvLines = @(
        'EMAIL_DELIVERY_MODE=microsoft365',
        "MICROSOFT_TENANT_ID=$TenantId",
        "MICROSOFT_CLIENT_ID=$AppClientId",
        "MICROSOFT_CLIENT_SECRET=$($script:plainSecret)",
        "MICROSOFT_FROM_MAILBOX=$FromMailbox"
    ) -join "`n"

    # Print the payload with the secret redacted, so the operator
    # can see what will be imported.
    $previewLines = @(
        'EMAIL_DELIVERY_MODE=microsoft365',
        "MICROSOFT_TENANT_ID=$TenantId",
        "MICROSOFT_CLIENT_ID=$AppClientId",
        "MICROSOFT_CLIENT_SECRET=<redacted>",
        "MICROSOFT_FROM_MAILBOX=$FromMailbox"
    )
    Say-Info "stdin payload (with secret redacted):"
    foreach ($line in $previewLines) { Say-Info "  $line" }

    $flyctlArgs = @('secrets', 'import', '--app', $App)
    if ($Stage) { $flyctlArgs += '--stage' }
    Say-Info ""
    Say-Info "Subprocess command line that WILL be launched:"
    Say-Info "  $flyctl $($flyctlArgs -join ' ')"
    Say-OK "Secret value does NOT appear in the above command line."

    if ($DryRun) {
        Say-Warn "DryRun: not launching flyctl.  No Fly state changed."
        exit 0
    }

    Say-Section "Phase 3 -- flyctl secrets import (stdin)"

    # Launch flyctl via System.Diagnostics.Process so we can:
    #   - redirect stdin and write the KEY=VALUE lines there,
    #   - capture + redact stdout/stderr line-by-line,
    #   - verify (immediately after start) that the subprocess
    #     command line does NOT contain the plaintext secret.
    # Build Arguments as a single string (works on Windows PowerShell 5.1
    # AND PowerShell 7; .NET Framework 4.x's ProcessStartInfo does not
    # expose ArgumentList).  All flyctl args here are known-safe tokens
    # with no shell-sensitive characters, so simple space-joining is
    # fine.  Validation of $App above restricts it to the hard-coded
    # 'spectre-staging' string.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $flyctl
    $psi.Arguments              = ($flyctlArgs -join ' ')
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardInput  = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true

    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    [void]$proc.Start()

    # Self-verification: read the subprocess command line via WMI
    # and assert the plaintext secret is not visible.  Any OS-level
    # observer (another process on the same session) would see
    # exactly this string.
    $subprocCommandLine = $null
    try {
        $subprocCommandLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction Stop).CommandLine
    } catch {
        Say-Warn "Could not read the subprocess command line via Win32_Process ($($_.Exception.Message)).  Self-verification skipped."
    }
    if ($null -ne $subprocCommandLine) {
        $cmdlineRedacted = Protect-SecretInOutput -Text $subprocCommandLine -Secret $script:plainSecret
        Say-Info "Observed subprocess command line (redacted):"
        Say-Info "  $cmdlineRedacted"
        if ($subprocCommandLine.Contains($script:plainSecret)) {
            Say-Fail "SECURITY DEFECT: subprocess command line DOES contain the plaintext secret."
            Say-Info "Killing subprocess and aborting (no secrets were committed to Fly)."
            try { $proc.Kill() } catch {}
            exit 4
        }
        Say-OK "Subprocess command line does NOT contain the plaintext secret (self-verified)."
    }

    # Pipe the payload to flyctl's stdin and close.  Write via the
    # BaseStream directly with UTF-8-no-BOM encoding so flyctl's
    # line parser doesn't see a BOM at the start of the first key
    # name (which it would otherwise treat as part of the key).
    $noBomUtf8 = New-Object System.Text.UTF8Encoding $false
    $bytes = $noBomUtf8.GetBytes($script:kvLines + "`n")
    $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $proc.StandardInput.BaseStream.Flush()
    $proc.StandardInput.Close()
    # Scrub the byte buffer we just wrote.
    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = 0 }

    # Capture + redact outputs.
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    $flyExit = $proc.ExitCode

    # Redact every output line against the known plaintext secret.
    foreach ($line in ($stdout -split "`r?`n")) {
        if ([string]::IsNullOrEmpty($line)) { continue }
        Write-Host (Protect-SecretInOutput -Text $line -Secret $script:plainSecret)
    }
    foreach ($line in ($stderr -split "`r?`n")) {
        if ([string]::IsNullOrEmpty($line)) { continue }
        Write-Host (Protect-SecretInOutput -Text $line -Secret $script:plainSecret) -ForegroundColor Yellow
    }

    if ($flyExit -ne 0) {
        Say-Fail "flyctl secrets import exited with code $flyExit."
        exit 4
    }

    Say-OK "flyctl secrets import completed."
    Say-Info ""
    if ($Stage) {
        Say-Info "Secrets staged (--stage).  Deploy them with: $flyctl deploy --app $App  OR trigger a release."
    } else {
        Say-Info "Fly is rolling the spectre-staging web app (~30-45 s)."
        Say-Info "Next steps (verification -- Spectre side will handle):"
        Say-Info "  1. curl https://staging.spectreautomation.com/api/admin/signup/debug/status | jq .email"
        Say-Info "  2. Real signup walk + email delivery."
        Say-Info "  3. Playwright regression."
        Say-Info "  4. Fill docs/signup-1g-acceptance.md Phase D section."
    }
    exit 0
}
finally {
    # Scrub plaintext from this session even on error / Ctrl-C.
    if ($null -ne $script:plainSecret) {
        $script:plainSecret = ("x" * $script:plainSecret.Length)
        Remove-Variable plainSecret -Scope Script -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $script:kvLines) {
        $script:kvLines = ("x" * $script:kvLines.Length)
        Remove-Variable kvLines -Scope Script -Force -ErrorAction SilentlyContinue
    }
    if (Get-Variable -Name sec -ErrorAction SilentlyContinue) {
        $sec = $null
        Remove-Variable sec -Force -ErrorAction SilentlyContinue
    }
    [System.GC]::Collect()
}
