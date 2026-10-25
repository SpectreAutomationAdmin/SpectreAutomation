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
    [Parameter(Mandatory = $false)]
    [string]$TenantId = '',

    [Parameter(Mandatory = $false)]
    [string]$AppClientId = '',

    [Parameter(Mandatory = $false)]
    [string]$FromMailbox = 'no-reply@spectreautomation.com',

    [Parameter(Mandatory = $false)]
    [string]$App = 'spectre-staging',

    [Parameter(Mandatory = $false)]
    [string]$FlyctlPath = '',

    [Parameter(Mandatory = $false)]
    [switch]$Stage,

    [Parameter(Mandatory = $false)]
    [switch]$DryRun,

    [Parameter(Mandatory = $false)]
    [switch]$Test
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
# Exercised in -Test mode.  Used inline on every captured output line.
function Protect-SecretInOutput {
    param(
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Secret
    )
    if ([string]::IsNullOrEmpty($Secret) -or [string]::IsNullOrEmpty($Text)) { return $Text }
    return $Text.Replace($Secret, '<redacted>')
}

# Pure function: build the stdin byte payload for `flyctl secrets import`
# using the SAME StreamWriter pattern the live run uses, so -Test
# proves the on-wire bytes contain no BOM and no accidental
# whitespace artefacts.  Writes to a MemoryStream and returns the
# bytes.
#
# The trick that keeps this BOM-free on Windows PowerShell 5.1:
#   - We create our OWN StreamWriter with UTF8Encoding(bomless=$true),
#     meaning the writer's Preamble is EMPTY, so Flush never emits
#     EF BB BF.
#   - We close the StreamWriter via Dispose, which calls Flush
#     (BOM-free) + closes the underlying stream.
#   - The subprocess's own Process.StandardInput StreamWriter is
#     NEVER touched -- including never .Close()d or .Flush()ed,
#     which on 5.1 WOULD write a UTF-8-with-BOM preamble to the
#     pipe depending on how the StreamWriter was constructed by
#     the framework.  The live run closes BaseStream directly
#     instead.
function Build-StdinBytes {
    param(
        [Parameter(Mandatory=$true)][string[]]$Lines
    )
    $ms = New-Object System.IO.MemoryStream
    try {
        $noBom = New-Object System.Text.UTF8Encoding $false
        $sw = New-Object System.IO.StreamWriter($ms, $noBom)
        $sw.NewLine = "`n"
        foreach ($line in $Lines) {
            $sw.WriteLine($line)
        }
        $sw.Flush()
        # Return the bytes BEFORE disposing the writer, so the writer
        # doesn't try to flush its (empty) preamble a second time.
        $out = $ms.ToArray()
        $sw.Dispose()
        return ,$out
    } finally {
        $ms.Dispose()
    }
}

# ============================================================================
# -Test mode -- pure-function assertions.  No connections, no secrets.
# ============================================================================
if ($Test) {
    $failures = 0
    function Assert-Equal($expected, $actual, $label) {
        if ($expected -ne $actual) {
            Say-Fail "  Assert '$label' -- expected [$expected], actual [$actual]"
            $script:failures++
        } else {
            Say-OK "  Assert '$label'"
        }
    }
    function Assert-True($condition, $label) {
        if (-not $condition) {
            Say-Fail "  Assert '$label' -- condition was false"
            $script:failures++
        } else {
            Say-OK "  Assert '$label'"
        }
    }

    Say-Section "-Test -- pure-function assertions"

    # Build the EXACT payload the live run would build, substituting
    # a dummy secret value so the test is reproducible and secret-free.
    $kvLines = @(
        'EMAIL_DELIVERY_MODE=microsoft365',
        'MICROSOFT_TENANT_ID=11111111-2222-3333-4444-555555555555',
        'MICROSOFT_CLIENT_ID=66666666-7777-8888-9999-aaaaaaaaaaaa',
        'MICROSOFT_CLIENT_SECRET=TEST-ONLY-NOT-A-REAL-SECRET',
        'MICROSOFT_FROM_MAILBOX=no-reply@spectreautomation.com'
    )
    $bytes = Build-StdinBytes -Lines $kvLines

    # Core invariant: first bytes are ASCII 'EMAIL' (45 4D 41 49 4C), NOT
    # the UTF-8 BOM EF BB BF.
    Assert-Equal 0x45 $bytes[0] 'first byte is 0x45 (ASCII E)'
    Assert-Equal 0x4D $bytes[1] 'second byte is 0x4D (ASCII M)'
    Assert-Equal 0x41 $bytes[2] 'third byte is 0x41 (ASCII A)'
    Assert-Equal 0x49 $bytes[3] 'fourth byte is 0x49 (ASCII I)'
    Assert-Equal 0x4C $bytes[4] 'fifth byte is 0x4C (ASCII L)'
    Assert-True ($bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) 'first three bytes are not the UTF-8 BOM EF BB BF'

    # No BOM sequence anywhere in the payload.
    $containsBom = $false
    for ($i = 0; $i -lt $bytes.Length - 2; $i++) {
        if ($bytes[$i] -eq 0xEF -and $bytes[$i+1] -eq 0xBB -and $bytes[$i+2] -eq 0xBF) {
            $containsBom = $true
            break
        }
    }
    Assert-True (-not $containsBom) 'payload contains no EF BB BF sequence anywhere'

    # Line separator is LF (0x0A), not CRLF.  flyctl's parser handles
    # both but LF is simpler and matches our encoding intent.
    $noBom = New-Object System.Text.UTF8Encoding $false
    $decoded = $noBom.GetString($bytes)
    $decodedLines = $decoded -split "`n"
    # Trailing newline makes the final split entry an empty string;
    # expect 5 content lines + 1 trailing empty.
    Assert-Equal 6 $decodedLines.Count 'exactly 5 content lines + trailing LF (6 split entries)'
    Assert-Equal 'EMAIL_DELIVERY_MODE=microsoft365' $decodedLines[0] 'line 1 content exact'
    Assert-Equal 'MICROSOFT_TENANT_ID=11111111-2222-3333-4444-555555555555' $decodedLines[1] 'line 2 content exact'
    Assert-Equal 'MICROSOFT_CLIENT_ID=66666666-7777-8888-9999-aaaaaaaaaaaa' $decodedLines[2] 'line 3 content exact'
    Assert-Equal 'MICROSOFT_CLIENT_SECRET=TEST-ONLY-NOT-A-REAL-SECRET' $decodedLines[3] 'line 4 content exact'
    Assert-Equal 'MICROSOFT_FROM_MAILBOX=no-reply@spectreautomation.com' $decodedLines[4] 'line 5 content exact'
    Assert-Equal '' $decodedLines[5] 'final split entry is empty (trailing LF)'

    # No surprise CR characters inside any content line.
    for ($i = 0; $i -lt 5; $i++) {
        Assert-True (-not $decodedLines[$i].Contains("`r")) "line $($i+1) contains no CR"
    }

    # Protect-SecretInOutput redaction.
    Assert-Equal 'before <redacted> after' (Protect-SecretInOutput -Text 'before SECRETVALUE after' -Secret 'SECRETVALUE') 'redaction replaces secret inline'
    Assert-Equal 'no secret here' (Protect-SecretInOutput -Text 'no secret here' -Secret 'SECRETVALUE') 'redaction leaves non-matching text untouched'
    Assert-Equal 'empty secret keeps text' (Protect-SecretInOutput -Text 'empty secret keeps text' -Secret '') 'empty secret returns text unchanged'

    # Scrub ONLY the dummy test values.
    $bytes = $null
    $kvLines = $null
    $decoded = $null
    $decodedLines = $null

    Say-Section "-Test summary"
    if ($script:failures -gt 0) {
        Say-Fail "$($script:failures) assertion(s) failed."
        exit 10
    }
    Say-OK "All assertions passed."
    exit 0
}

Say-Section "Phase 0 -- Preflight"

# Validate -TenantId and -AppClientId now (deferred past -Test).
$guidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
if ([string]::IsNullOrWhiteSpace($TenantId) -or $TenantId -notmatch $guidPattern) {
    Say-Fail "-TenantId is required for a live run and must be a GUID."
    exit 2
}
if ([string]::IsNullOrWhiteSpace($AppClientId) -or $AppClientId -notmatch $guidPattern) {
    Say-Fail "-AppClientId is required for a live run and must be a GUID."
    exit 2
}

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

# Snapshot which of the five SIGNUP-1G secrets currently exist on
# the app, BEFORE we attempt any mutation.  Fly's `secrets import`
# is atomic (either all five are set together or none are), but
# recording the before-state lets the operator confirm no partial
# update happened if the import fails.
$targetKeys = @('EMAIL_DELIVERY_MODE', 'MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_FROM_MAILBOX')
Say-Info "Pre-flight: enumerating current secret names on $App (names only, no values)..."
try {
    $preList = & $flyctl secrets list --app $App 2>&1
    if ($LASTEXITCODE -ne 0) {
        Say-Warn "flyctl secrets list exited $LASTEXITCODE (continuing; pre-flight is informational):"
        $preList | ForEach-Object { Say-Info "  $_" }
        $script:preSnapshot = @()
    } else {
        $script:preSnapshot = @()
        foreach ($key in $targetKeys) {
            $hit = $preList | Where-Object { "$_" -match "(^|\s)$([regex]::Escape($key))(\s|$)" }
            if ($hit) { $script:preSnapshot += $key }
        }
        if ($script:preSnapshot.Count -eq 0) {
            Say-OK "Pre-flight snapshot: NONE of the five SIGNUP-1G keys are currently set."
        } else {
            Say-Warn "Pre-flight snapshot: these keys already exist on $App (will be overwritten by import):"
            foreach ($k in $script:preSnapshot) { Say-Info "  - $k" }
        }
    }
} catch {
    Say-Warn "Pre-flight secrets list threw: $($_.Exception.Message).  Continuing."
    $script:preSnapshot = @()
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
    # Build-StdinBytes constructs the payload via a BOM-free
    # StreamWriter writing to a MemoryStream.  -Test asserts the
    # resulting bytes have no EF BB BF anywhere.
    $script:kvLinesArray = @(
        'EMAIL_DELIVERY_MODE=microsoft365',
        "MICROSOFT_TENANT_ID=$TenantId",
        "MICROSOFT_CLIENT_ID=$AppClientId",
        "MICROSOFT_CLIENT_SECRET=$($script:plainSecret)",
        "MICROSOFT_FROM_MAILBOX=$FromMailbox"
    )
    $script:stdinBytes = Build-StdinBytes -Lines $script:kvLinesArray

    # Sanity-check at run time: payload must not start with the BOM.
    # (The -Test mode proves this across more cases.)
    if ($script:stdinBytes.Length -ge 3 -and
        $script:stdinBytes[0] -eq 0xEF -and
        $script:stdinBytes[1] -eq 0xBB -and
        $script:stdinBytes[2] -eq 0xBF) {
        Say-Fail "stdin payload starts with a UTF-8 BOM (would corrupt the first key).  Aborting before any Fly write."
        exit 4
    }
    Say-OK ("stdin payload: {0} bytes; first bytes {1:X2} {2:X2} {3:X2} {4:X2} {5:X2} (ASCII '{6}')" -f `
        $script:stdinBytes.Length,
        $script:stdinBytes[0], $script:stdinBytes[1], $script:stdinBytes[2],
        $script:stdinBytes[3], $script:stdinBytes[4],
        [System.Text.Encoding]::ASCII.GetString($script:stdinBytes, 0, 5))

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

    # Pipe the payload to flyctl's stdin.
    #
    # CRITICAL: write ONLY to BaseStream, and close ONLY BaseStream.
    # Do NOT touch Process.StandardInput as a StreamWriter -- its
    # default .NET-framework-constructed writer uses UTF-8-WITH-BOM
    # on Windows PowerShell 5.1, and its Close()/Dispose() writes
    # a 3-byte BOM preamble to the pipe BEFORE we see it.  (That
    # is the exact Fly import failure the founder reported with
    # the previous revision of this script.)  Closing BaseStream
    # directly signals EOF to flyctl without invoking the
    # framework StreamWriter's flush path.
    $base = $proc.StandardInput.BaseStream
    $base.Write($script:stdinBytes, 0, $script:stdinBytes.Length)
    $base.Flush()
    $base.Close()
    # Scrub the byte buffer in-place.
    for ($i = 0; $i -lt $script:stdinBytes.Length; $i++) { $script:stdinBytes[$i] = 0 }

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
        # Snapshot AFTER to prove no partial update.
        Say-Section "Post-failure snapshot (partial-update check)"
        try {
            $postList = & $flyctl secrets list --app $App 2>&1
            if ($LASTEXITCODE -eq 0) {
                $postKeys = @()
                foreach ($key in $targetKeys) {
                    $hit = $postList | Where-Object { "$_" -match "(^|\s)$([regex]::Escape($key))(\s|$)" }
                    if ($hit) { $postKeys += $key }
                }
                $newlyAppeared = @($postKeys | Where-Object { $_ -notin $script:preSnapshot })
                if ($newlyAppeared.Count -eq 0) {
                    Say-OK "No new SIGNUP-1G secrets appeared on $App after the failed import.  No partial update."
                } else {
                    Say-Fail "PARTIAL UPDATE DETECTED -- these keys appeared on $App despite the import failure:"
                    foreach ($k in $newlyAppeared) { Say-Info "  - $k" }
                    Say-Info "Remove via: $flyctl secrets unset $($newlyAppeared -join ' ') --app $App"
                }
            } else {
                Say-Warn "Post-failure secrets list exited $LASTEXITCODE; verify manually: $flyctl secrets list --app $App"
            }
        } catch {
            Say-Warn "Post-failure snapshot threw: $($_.Exception.Message)"
            Say-Info "Verify manually: $flyctl secrets list --app $App"
        }
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
    if ($null -ne $script:kvLinesArray) {
        for ($i = 0; $i -lt $script:kvLinesArray.Length; $i++) { $script:kvLinesArray[$i] = $null }
        Remove-Variable kvLinesArray -Scope Script -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $script:stdinBytes) {
        for ($i = 0; $i -lt $script:stdinBytes.Length; $i++) { $script:stdinBytes[$i] = 0 }
        Remove-Variable stdinBytes -Scope Script -Force -ErrorAction SilentlyContinue
    }
    if (Get-Variable -Name sec -ErrorAction SilentlyContinue) {
        $sec = $null
        Remove-Variable sec -Force -ErrorAction SilentlyContinue
    }
    [System.GC]::Collect()
}
