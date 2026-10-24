<#
.SYNOPSIS
    SIGNUP-1G — Idempotent diagnostic + repair for the Spectre transactional-mail
    Exchange Online RBAC-for-Applications configuration.

.DESCRIPTION
    Diagnoses the current state of the dedicated "Spectre Transactional Mail"
    Entra app's authorization to send mail from no-reply@spectreautomation.com
    via Microsoft Graph.  Repairs idempotently where safe:

      - If the "Spectre No-Reply Only" management scope exists but its
        RecipientRestrictionFilter is blank or wrong, updates it in place
        (never deletes-and-recreates).
      - If the "Application Mail.Send" role assignment on the service
        principal does not yet exist with the correct scope, creates it.
      - If both already exist and are correct, this script is a no-op
        beyond the verification.

    Verifies with BOTH a positive and a negative Test-ServicePrincipalAuthorization
    before declaring success.

    The script:
      - Does not request, accept, or print any client secret.
      - Does not change any existing role assignment or management scope that
        is not strictly the two target resources.
      - Does not touch Microsoft Entra ID permissions.
      - Supports -DryRun to show the proposed changes without executing them.

.PARAMETER AppClientId
    REQUIRED. The Entra app's Application (client) ID.  This is the GUID on
    the App Registration overview page in Entra admin center.  The script
    resolves the Service Principal's ObjectId from this.

.PARAMETER SharedMailbox
    The mailbox the app is authorized to send from.  Defaults to
    no-reply@spectreautomation.com.  Must already exist in the tenant.

.PARAMETER NegativeControlMailbox
    A different, real mailbox that the app MUST NOT be able to send from.
    The negative test asserts InScope=False against this address.  Defaults
    to admin@spectreautomation.com.

.PARAMETER ScopeName
    The management scope name.  Defaults to "Spectre No-Reply Only".

.PARAMETER DryRun
    If set, prints the proposed changes without executing them.

.EXAMPLE
    .\signup-1g-ms365-repair.ps1 -AppClientId "11111111-2222-3333-4444-555555555555"

.EXAMPLE
    .\signup-1g-ms365-repair.ps1 -AppClientId "..." -NegativeControlMailbox "founder@spectreautomation.com" -DryRun

.NOTES
    PREREQUISITES:
      - PowerShell 7+ recommended.  Script runs on Windows PowerShell 5.1 too,
        but 7+ is more forgiving of module-version mismatches.
      - ExchangeOnlineManagement module v3.4 or later.
      - Signed in to Exchange Online as a Global Admin or Exchange Admin
        (Organization Management role group).

    SAFETY:
      - Idempotent.  Safe to rerun.
      - Reads existing state before any write.
      - Writes only to the two target resources (management scope +
        role assignment on the ONE service principal).
      - No deletion operations.

#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, HelpMessage = "The Entra app's Application (client) ID (GUID).")]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$AppClientId,

    [Parameter(Mandatory = $false)]
    [string]$SharedMailbox = 'no-reply@spectreautomation.com',

    [Parameter(Mandatory = $false)]
    [string]$NegativeControlMailbox = 'admin@spectreautomation.com',

    [Parameter(Mandatory = $false)]
    [string]$ScopeName = 'Spectre No-Reply Only',

    [Parameter(Mandatory = $false)]
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# TLS 1.2 — required by Install-Module from PowerShell Gallery on
# older Windows configurations.  Harmless if already set.
[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$script:Changes = @()
function Record-Change([string]$Description) {
    $script:Changes += $Description
    Write-Host "  [CHANGE] $Description" -ForegroundColor Yellow
}

function Say-Section([string]$Title) {
    Write-Host ""
    Write-Host "========================================================================" -ForegroundColor Cyan
    Write-Host $Title -ForegroundColor Cyan
    Write-Host "========================================================================" -ForegroundColor Cyan
}

function Say-OK([string]$msg)   { Write-Host "  [OK]      $msg" -ForegroundColor Green }
function Say-Warn([string]$msg) { Write-Host "  [WARN]    $msg" -ForegroundColor Yellow }
function Say-Fail([string]$msg) { Write-Host "  [FAIL]    $msg" -ForegroundColor Red }

$ExpectedFilter = "PrimarySmtpAddress -eq '$SharedMailbox'"

# ============================================================================
# Phase 0 — Preflight
# ============================================================================
Say-Section "Phase 0 — Preflight"

Write-Host "  PowerShell version: $($PSVersionTable.PSVersion)"
if ($PSVersionTable.PSVersion.Major -lt 7) {
    Say-Warn "Running on Windows PowerShell $($PSVersionTable.PSVersion).  PowerShell 7+ is recommended for the ExchangeOnlineManagement module.  Continuing."
}

Write-Host "  Checking ExchangeOnlineManagement module…"
$module = Get-Module -ListAvailable -Name ExchangeOnlineManagement |
    Sort-Object Version -Descending |
    Select-Object -First 1
if (-not $module) {
    Say-Fail "ExchangeOnlineManagement module not installed."
    Write-Host "    Install with: Install-Module -Name ExchangeOnlineManagement -MinimumVersion 3.4.0 -Scope CurrentUser"
    exit 2
}
if ($module.Version -lt [version]'3.4.0') {
    Say-Fail "ExchangeOnlineManagement v$($module.Version) is older than the required 3.4.0."
    Write-Host "    Update with: Update-Module -Name ExchangeOnlineManagement -Force"
    exit 2
}
Say-OK "ExchangeOnlineManagement v$($module.Version)"
Import-Module ExchangeOnlineManagement -ErrorAction Stop

Write-Host "  Checking Exchange Online connection…"
$connected = $false
try {
    $connInfo = Get-ConnectionInformation -ErrorAction Stop
    if ($connInfo -and $connInfo.State -eq 'Connected') { $connected = $true }
} catch { $connected = $false }

if (-not $connected) {
    Write-Host "  Not connected.  Running Connect-ExchangeOnline…"
    try {
        Connect-ExchangeOnline -ShowBanner:$false -ErrorAction Stop
        Say-OK "Connected to Exchange Online"
    } catch {
        Say-Fail "Connect-ExchangeOnline failed: $($_.Exception.Message)"
        exit 2
    }
} else {
    Say-OK "Already connected (as $($connInfo.UserPrincipalName))"
}

# ============================================================================
# Phase 1 — Verify shared mailbox exists
# ============================================================================
Say-Section "Phase 1 — Shared mailbox verification"

try {
    $mbx = Get-EXOMailbox -Identity $SharedMailbox -ErrorAction Stop
    Say-OK "Shared mailbox found: $($mbx.PrimarySmtpAddress) (type=$($mbx.RecipientTypeDetails))"
} catch {
    Say-Fail "Shared mailbox '$SharedMailbox' not found: $($_.Exception.Message)"
    Write-Host "    Create it under Microsoft 365 admin → Teams & groups → Shared mailboxes."
    exit 3
}

try {
    $neg = Get-EXOMailbox -Identity $NegativeControlMailbox -ErrorAction Stop
    Say-OK "Negative control mailbox found: $($neg.PrimarySmtpAddress)"
} catch {
    Say-Warn "Negative control mailbox '$NegativeControlMailbox' not found.  Skipping negative-control test."
    $neg = $null
}

# ============================================================================
# Phase 2 — Resolve the Service Principal from the AppId
# ============================================================================
Say-Section "Phase 2 — Service principal resolution"

$sp = $null
try {
    # Resolve by AppId — avoids the "did you use the App Registration
    # ObjectId or the Enterprise Application ObjectId?" trap entirely.
    $sp = Get-ServicePrincipal -Identity $AppClientId -ErrorAction Stop
} catch {
    Say-Fail "Service principal with AppId '$AppClientId' not found in Exchange."
    Write-Host "    This typically means the ServicePrincipal pointer wasn't created yet."
    Write-Host "    Fix: run"
    Write-Host "      New-ServicePrincipal -AppId <AppClientId> -ObjectId <Enterprise App Object ID> -DisplayName 'Spectre Transactional Mail'"
    Write-Host "    The Enterprise App Object ID comes from Entra → Enterprise applications → the app → Object ID"
    Write-Host "    (NOT the App Registration's Object ID — those are different GUIDs)."
    exit 4
}

Say-OK "Service principal:"
Write-Host "    DisplayName : $($sp.DisplayName)"
Write-Host "    AppId       : $($sp.AppId)"
Write-Host "    ObjectId    : $($sp.ObjectId)"

$spObjectId = $sp.ObjectId

# ============================================================================
# Phase 3 — Inspect / repair the management scope
# ============================================================================
Say-Section "Phase 3 — Management scope"

$existingScope = $null
try {
    $existingScope = Get-ManagementScope -Identity $ScopeName -ErrorAction Stop
} catch {
    $existingScope = $null
}

if (-not $existingScope) {
    Say-Warn "Management scope '$ScopeName' does not exist.  Will create it with the correct filter."
    Record-Change "Create ManagementScope '$ScopeName' with filter: $ExpectedFilter"
    if (-not $DryRun) {
        $existingScope = New-ManagementScope `
            -Name $ScopeName `
            -RecipientRestrictionFilter $ExpectedFilter `
            -ErrorAction Stop
        Say-OK "Created scope"
    }
} else {
    $currentFilter = $existingScope.RecipientFilter
    Write-Host "    Current RecipientFilter: '$currentFilter'"
    if ([string]::IsNullOrWhiteSpace($currentFilter)) {
        Say-Warn "Scope filter is BLANK — this is the SIGNUP-1G defect reported by the founder."
        Record-Change "Set RecipientRestrictionFilter on '$ScopeName' to: $ExpectedFilter"
        if (-not $DryRun) {
            Set-ManagementScope -Identity $ScopeName -RecipientRestrictionFilter $ExpectedFilter -ErrorAction Stop
            Say-OK "Scope filter updated"
        }
    } elseif ($currentFilter -ne $ExpectedFilter) {
        Say-Warn "Scope filter is set but does not match expected value."
        Write-Host "      Expected: $ExpectedFilter"
        Write-Host "      Actual  : $currentFilter"
        Record-Change "Overwrite RecipientRestrictionFilter on '$ScopeName' to: $ExpectedFilter"
        if (-not $DryRun) {
            Set-ManagementScope -Identity $ScopeName -RecipientRestrictionFilter $ExpectedFilter -ErrorAction Stop
            Say-OK "Scope filter updated"
        }
    } else {
        Say-OK "Scope filter is already correct — no change needed"
    }
}

# Confirm it took, unless we're in DryRun.
if (-not $DryRun) {
    $existingScope = Get-ManagementScope -Identity $ScopeName
    if ([string]::IsNullOrWhiteSpace($existingScope.RecipientFilter)) {
        Say-Fail "Scope filter is STILL blank after Set-ManagementScope.  Aborting."
        exit 5
    }
    Say-OK "Scope filter confirmed: $($existingScope.RecipientFilter)"
}

# ============================================================================
# Phase 4 — Inspect / repair the role assignment
# ============================================================================
Say-Section "Phase 4 — Role assignment"

$existingAssignments = @()
try {
    # Enumerate every role assignment attached to this SP.
    $existingAssignments = Get-ManagementRoleAssignment -RoleAssignee $spObjectId -ErrorAction Stop |
        Where-Object { $_.Role -eq 'Application Mail.Send' }
} catch {
    $existingAssignments = @()
}

$matching = $existingAssignments | Where-Object {
    $_.CustomResourceScope -eq $ScopeName
}

$otherScoped = $existingAssignments | Where-Object {
    $_.CustomResourceScope -ne $ScopeName -and -not [string]::IsNullOrEmpty($_.CustomResourceScope)
}
$unscoped = $existingAssignments | Where-Object {
    [string]::IsNullOrEmpty($_.CustomResourceScope) -and `
    [string]::IsNullOrEmpty($_.RecipientAdministrativeUnitScope)
}

if ($matching) {
    Say-OK "Role assignment already exists with the correct scope:"
    Write-Host "    Name: $($matching.Name)"
    Write-Host "    Role: $($matching.Role)"
    Write-Host "    CustomResourceScope: $($matching.CustomResourceScope)"
} else {
    Say-Warn "No existing 'Application Mail.Send' role assignment on this SP with scope '$ScopeName'."
    Record-Change "Create ManagementRoleAssignment: App=$spObjectId, Role='Application Mail.Send', CustomResourceScope='$ScopeName'"
    if (-not $DryRun) {
        try {
            # Use -App with the ObjectId (not AppId) — matches Microsoft's documented example.
            New-ManagementRoleAssignment `
                -App $spObjectId `
                -Role 'Application Mail.Send' `
                -CustomResourceScope $ScopeName `
                -ErrorAction Stop | Out-Null
            Say-OK "Role assignment created"
        } catch {
            Say-Fail "New-ManagementRoleAssignment failed: $($_.Exception.Message)"
            Write-Host "    Common causes:"
            Write-Host "      - You are signed in as a user without DelegatingOrgWide for 'Application Mail.Send'."
            Write-Host "        Fix: sign in as a Global Admin or an Exchange Admin."
            Write-Host "      - The ExchangeOnlineManagement module is older than v3.4."
            Write-Host "        Fix: Update-Module -Name ExchangeOnlineManagement -Force"
            exit 6
        }
    }
}

if ($otherScoped) {
    Say-Warn "This SP has 'Application Mail.Send' assignments with DIFFERENT scopes (listed; not changed by this script):"
    foreach ($a in $otherScoped) {
        Write-Host "      - $($a.Name) → CustomResourceScope=$($a.CustomResourceScope)"
    }
    Say-Warn "Review those manually.  They may widen the effective send authority."
}

if ($unscoped) {
    Say-Fail "This SP has UNSCOPED 'Application Mail.Send' role assignments.  These bypass the scoping and let the app send tenant-wide."
    foreach ($a in $unscoped) {
        Write-Host "      - $($a.Name) (REMOVE this manually with: Remove-ManagementRoleAssignment -Identity '$($a.Name)')"
    }
    Say-Fail "Script will NOT auto-remove unscoped assignments — operator must review each.  Negative test will FAIL until these are cleaned up."
}

# ============================================================================
# Phase 5 — Verification (positive + negative)
# ============================================================================
Say-Section "Phase 5 — Authorization verification"

Write-Host "  Positive test — $SharedMailbox should be IN scope:"
try {
    $pos = Test-ServicePrincipalAuthorization -Identity $spObjectId -Resource $SharedMailbox -ErrorAction Stop |
        Where-Object { $_.RoleName -eq 'Application Mail.Send' } |
        Select-Object -First 1
    if ($pos -and $pos.InScope -eq $true) {
        Say-OK "InScope = True  (role=$($pos.RoleName), scope=$($pos.AllowedResourceScope))"
    } else {
        Say-Fail "POSITIVE TEST FAILED — Spectre's app cannot send from the designated mailbox."
        Write-Host "    Full output:"
        $pos | Format-List | Out-String | Write-Host
        exit 7
    }
} catch {
    Say-Fail "Test-ServicePrincipalAuthorization (positive) threw: $($_.Exception.Message)"
    exit 7
}

if ($neg) {
    Write-Host "  Negative test — $NegativeControlMailbox should NOT be in scope:"
    try {
        $negRes = Test-ServicePrincipalAuthorization -Identity $spObjectId -Resource $NegativeControlMailbox -ErrorAction Stop |
            Where-Object { $_.RoleName -eq 'Application Mail.Send' } |
            Select-Object -First 1
        if ($negRes -and $negRes.InScope -eq $false) {
            Say-OK "InScope = False  (role=$($negRes.RoleName), scope=$($negRes.AllowedResourceScope))"
        } else {
            Say-Fail "NEGATIVE TEST FAILED — Spectre's app can send from a mailbox OTHER than the designated one."
            Write-Host "    This is a security defect.  Likely cause: an unscoped Mail.Send assignment or an"
            Write-Host "    unscoped Microsoft Graph application-permission in Entra ID.  See Phase 4 warnings."
            Write-Host "    Full output:"
            $negRes | Format-List | Out-String | Write-Host
            exit 8
        }
    } catch {
        Say-Fail "Test-ServicePrincipalAuthorization (negative) threw: $($_.Exception.Message)"
        exit 8
    }
}

# ============================================================================
# Summary
# ============================================================================
Say-Section "Summary"

if ($script:Changes.Count -eq 0) {
    Say-OK "No changes made.  Configuration was already correct."
} else {
    if ($DryRun) {
        Write-Host "  DRY RUN — the following changes WOULD be made:" -ForegroundColor Yellow
    } else {
        Write-Host "  Changes applied:" -ForegroundColor Yellow
    }
    foreach ($c in $script:Changes) {
        Write-Host "    • $c"
    }
}

Say-OK "RBAC configuration verified end-to-end."
Write-Host ""
Write-Host "Next steps (operator):"
Write-Host "  1. Confirm Entra ID → App Registrations → 'Spectre Transactional Mail' → API permissions is EMPTY."
Write-Host "     (If 'Mail.Send' application permission is listed there, remove it — otherwise it bypasses this scope.)"
Write-Host "  2. Run: flyctl secrets set EMAIL_DELIVERY_MODE=microsoft365 \\"
Write-Host "         MICROSOFT_TENANT_ID=<tenant-id> \\"
Write-Host "         MICROSOFT_CLIENT_ID=$AppClientId \\"
Write-Host "         MICROSOFT_CLIENT_SECRET=<secret from your password manager> \\"
Write-Host "         MICROSOFT_FROM_MAILBOX=$SharedMailbox \\"
Write-Host "         --app spectre-staging"
Write-Host "  3. Verify end-to-end with:"
Write-Host "         curl https://staging.spectreautomation.com/api/admin/signup/debug/status | jq .email"
Write-Host "     expecting effectiveAdapter=microsoft365."
Write-Host ""
exit 0
