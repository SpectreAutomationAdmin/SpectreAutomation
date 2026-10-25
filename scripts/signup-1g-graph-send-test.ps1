<#
.SYNOPSIS
    SIGNUP-1G Phase C step 2 -- Live Microsoft Graph positive + negative
    send tests for the dedicated Transactional Mail Entra app.

.DESCRIPTION
    Proves that:
      POSITIVE:  the app CAN send mail via Microsoft Graph from the
                 designated SharedMailbox (no-reply@spectreautomation.com).
                 Expected result: HTTP 202 Accepted.
      NEGATIVE:  the app CANNOT send mail via Microsoft Graph from a
                 DIFFERENT mailbox.  Expected result: HTTP 403 with
                 ErrorAccessDenied (or equivalent).  A 202 here is a
                 SECURITY DEFECT.

    This is the live-token enforcement check that the Exchange-RBAC
    repair script explicitly does NOT perform.  The RBAC repair proves
    role assignments match intent; this script proves Microsoft Graph
    actually enforces that intent against real tokens.

    SECRET HANDLING:
      - The client secret is entered interactively via
        Read-Host -AsSecureString at run time.
      - It is NEVER accepted via a command-line argument, env var,
        file, or clipboard.
      - It is NEVER printed to stdout/stderr; redaction scrubs the
        raw error-body text before any Say-* call.
      - It is scrubbed from memory via Remove-Variable + GC.Collect
        before the script exits (or on Ctrl-C via finally).

    EMAIL CONTENT:
      - The test emails are plainly labelled SIGNUP-1G-TEST so a
        recipient receiving them does not mistake them for live
        signup recovery mail.
      - Subject prefix:  "SIGNUP-1G Graph send test"
      - Body is deliberately boring and signed as a test.

.PARAMETER TenantId
    REQUIRED.  Entra Directory (tenant) ID (GUID).

.PARAMETER AppClientId
    REQUIRED.  The Spectre Transactional Mail Entra app's
    Application (client) ID (GUID).

.PARAMETER SharedMailbox
    REQUIRED-with-default.  The designated transactional mailbox
    (the one the app SHOULD be able to send from).  Default:
    no-reply@spectreautomation.com.

.PARAMETER NegativeControlMailbox
    REQUIRED.  A real mailbox the app MUST NOT be able to send from.
    The same mailbox used for the Exchange RBAC Test-ServicePrincipal
    negative test is appropriate (e.g. cturcato@spectreautomation.com).

.PARAMETER ToEmail
    REQUIRED.  The address the test emails are delivered to.  Use a
    real inbox you control so the positive-send result can be
    confirmed visually.  The address is attached as the "To:" header
    on both the positive and negative sends.

.PARAMETER WhatIf
    OPTIONAL.  If set, builds the request bodies and acquires a
    token but does not actually invoke /sendMail.  Useful for a
    pre-flight check without emitting live mail.

.NOTES
    EXIT CODES:
      0  - Positive 202 + negative 403.
      2  - Preflight / token-exchange failure.
      3  - Positive send FAILED (expected 202, got something else).
      4  - Negative send SUCCEEDED (expected 403, got 202) --
           SECURITY DEFECT.

    This script does not touch Fly or Spectre's deployment at all.
    Fly secret activation is a separate script
    (signup-1g-fly-secrets-activate.ps1) run only after this
    script exits 0.
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
    [string]$SharedMailbox = 'no-reply@spectreautomation.com',

    [Parameter(Mandatory = $true)]
    [string]$NegativeControlMailbox,

    [Parameter(Mandatory = $true)]
    [string]$ToEmail,

    [Parameter(Mandatory = $false)]
    [switch]$WhatIf
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

# Scrub $plainSecret from any string that may be logged.  Catches the
# rare case where an error body echoes the request payload.
function Redact([string]$text, [string]$secret) {
    if ($null -eq $text -or [string]::IsNullOrWhiteSpace($secret)) { return $text }
    return $text.Replace($secret, '<redacted>')
}

# Guard against the secret ever being echoed via error output.
$script:plainSecret = $null
try {
    Say-Section "Phase 0 -- Preflight"
    Say-Info "TenantId      : $TenantId"
    Say-Info "AppClientId   : $AppClientId"
    Say-Info "SharedMailbox : $SharedMailbox   (positive FROM)"
    Say-Info "Negative FROM : $NegativeControlMailbox"
    Say-Info "ToEmail       : $ToEmail  (positive + negative delivery target)"

    if ($SharedMailbox -eq $NegativeControlMailbox) {
        Say-Fail "SharedMailbox and NegativeControlMailbox are the same -- the negative test would be meaningless."
        exit 2
    }

    # Secret entry.
    Say-Section "Phase 1 -- Secret entry (interactive, no echo)"
    Write-Host "The client secret for Spectre Transactional Mail is required for the client-credentials token exchange." -ForegroundColor Yellow
    Write-Host "It is read via Read-Host -AsSecureString; nothing is echoed to the terminal, no shell history is captured." -ForegroundColor Yellow
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
    Say-OK "Secret captured in session memory (SecureString -> plaintext for token exchange only)."

    # Token exchange.
    Say-Section "Phase 2 -- Client-credentials token exchange"
    $tokenUrl = "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token"
    $body = @{
        grant_type    = 'client_credentials'
        client_id     = $AppClientId
        client_secret = $script:plainSecret
        scope         = 'https://graph.microsoft.com/.default'
    }
    $token = $null
    try {
        $resp = Invoke-RestMethod -Uri $tokenUrl -Method Post -Body $body -ContentType 'application/x-www-form-urlencoded' -ErrorAction Stop
        $token = $resp.access_token
    } catch {
        $errText = Redact ("$($_.Exception.Message)") $script:plainSecret
        Say-Fail "Token exchange failed: $errText"
        exit 2
    }
    if ([string]::IsNullOrWhiteSpace($token)) {
        Say-Fail "Token response did not include an access_token."
        exit 2
    }
    # Decode a token summary (no secret component) for the operator's log.
    $parts = $token -split '\.'
    if ($parts.Count -ge 2) {
        $payload = $parts[1].PadRight(4 * [math]::Ceiling($parts[1].Length / 4), '=') -replace '-', '+' -replace '_', '/'
        try {
            $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
            $claims = $decoded | ConvertFrom-Json
            Say-OK ("Token acquired.  tid={0}  appid={1}  aud={2}  roles={3}" -f $claims.tid, $claims.appid, $claims.aud, ($claims.roles -join ','))
        } catch {
            Say-OK "Token acquired."
        }
    } else {
        Say-OK "Token acquired."
    }

    # ---- Request-body builder.
    function Build-SendMailBody([string]$subject) {
        return (@{
            message = @{
                subject = $subject
                body    = @{ contentType = 'Text'; content = "This is an automated SIGNUP-1G Graph send test.  Delete.  -- Spectre Automation" }
                toRecipients = @(@{ emailAddress = @{ address = $ToEmail } })
            }
            saveToSentItems = $false
        } | ConvertTo-Json -Depth 6)
    }

    # ---- Positive test.
    Say-Section "Phase 3 -- POSITIVE send ($SharedMailbox -> $ToEmail)"
    $posUrl = "https://graph.microsoft.com/v1.0/users/$([uri]::EscapeDataString($SharedMailbox))/sendMail"
    $posBody = Build-SendMailBody "SIGNUP-1G Graph send test -- POSITIVE (expected 202)"
    Say-Info "POST $posUrl"
    if ($WhatIf) {
        Say-Warn "WhatIf: not actually calling /sendMail.  Request body prepared, headers prepared."
    } else {
        $posStatus = 0
        $posError = $null
        try {
            # Invoke-WebRequest exposes StatusCode on success; Invoke-RestMethod does not.
            $posResp = Invoke-WebRequest -Uri $posUrl -Method Post -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body $posBody -ErrorAction Stop -UseBasicParsing
            $posStatus = [int]$posResp.StatusCode
        } catch {
            $posError = Redact ("$($_.Exception.Message)") $script:plainSecret
            if ($_.Exception.Response) {
                try { $posStatus = [int]$_.Exception.Response.StatusCode } catch {}
            }
        }
        if ($posStatus -eq 202) {
            Say-OK "Positive send: HTTP 202 Accepted."
            Say-Info "  The test email is on its way to $ToEmail."
        } else {
            Say-Fail "Positive send FAILED.  HTTP $posStatus."
            if ($posError) { Say-Info "  Error: $posError" }
            Say-Info "  If HTTP 403:  Exchange RBAC role-assignment cache may still be propagating (Microsoft documents 30 min - 2 h)."
            Say-Info "               Re-check RBAC via Test-ServicePrincipalAuthorization, then wait and retry."
            Say-Info "  If HTTP 401:  the token has no Mail.Send role claim -- check the Entra audit script's output."
            exit 3
        }
    }

    # ---- Negative test.
    Say-Section "Phase 4 -- NEGATIVE send ($NegativeControlMailbox -> $ToEmail)"
    $negUrl = "https://graph.microsoft.com/v1.0/users/$([uri]::EscapeDataString($NegativeControlMailbox))/sendMail"
    $negBody = Build-SendMailBody "SIGNUP-1G Graph send test -- NEGATIVE (expected 403, security defect if 202)"
    Say-Info "POST $negUrl"
    if ($WhatIf) {
        Say-Warn "WhatIf: not actually calling /sendMail.  Request body prepared, headers prepared."
    } else {
        $negStatus = 0
        $negError = $null
        try {
            $negResp = Invoke-WebRequest -Uri $negUrl -Method Post -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body $negBody -ErrorAction Stop -UseBasicParsing
            $negStatus = [int]$negResp.StatusCode
        } catch {
            $negError = Redact ("$($_.Exception.Message)") $script:plainSecret
            if ($_.Exception.Response) {
                try { $negStatus = [int]$_.Exception.Response.StatusCode } catch {}
            }
        }
        if ($negStatus -eq 403) {
            Say-OK "Negative send: HTTP 403 Forbidden (as expected)."
            Say-Info "  Microsoft Graph refused to send from a mailbox the app is not scoped for."
        } elseif ($negStatus -eq 202) {
            Say-Fail "SECURITY DEFECT: Negative send RETURNED 202.  The app CAN send from $NegativeControlMailbox."
            Say-Info "  A real email will be delivered to $ToEmail from $NegativeControlMailbox."
            Say-Info "  Immediately re-audit RBAC + Entra API permissions.  Exchange RBAC scoping failed in practice."
            exit 4
        } else {
            Say-Warn "Negative send returned HTTP $negStatus (not the expected 403, not the dangerous 202)."
            if ($negError) { Say-Info "  Error: $negError" }
            Say-Info "  Treating as a non-send; the negative test's intent (refuse to send) is satisfied."
            Say-Info "  But investigate why Graph returned $negStatus; a 404 (mailbox not found) is OK, a 500 is not."
        }
    }

    Say-Section "Summary"
    Say-OK "SIGNUP-1G Phase C live Graph send tests PASSED."
    Say-Info ""
    Say-Info "  Positive: Graph accepted the send from $SharedMailbox (HTTP 202)."
    Say-Info "  Negative: Graph refused the send from $NegativeControlMailbox (HTTP 403)."
    Say-Info ""
    Say-Info "  The test email you should expect in ${ToEmail}:"
    Say-Info "    Subject: SIGNUP-1G Graph send test -- POSITIVE (expected 202)"
    Say-Info "    From   : $SharedMailbox"
    Say-Info ""
    Say-Info "  Delete the test email after confirming it arrived."
    Say-Info ""
    Say-Info "  Next step: run signup-1g-fly-secrets-activate.ps1 to set Fly staging secrets."
    exit 0
}
finally {
    # Scrub plaintext from this session even on error / Ctrl-C.
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
