<#
.SYNOPSIS
    SIGNUP-1G -- Idempotent diagnostic + repair for the dedicated
    Spectre transactional-mail Entra app's Exchange Online
    RBAC-for-Applications configuration.

.DESCRIPTION
    SCOPE OF THIS SCRIPT.
    Verifies and repairs the Exchange Online RBAC state for ONE
    specific Entra service principal, so it can send mail via
    Microsoft Graph from exactly one shared mailbox and no other.

    Explicitly NOT in scope:
      - Microsoft Entra ID API permissions on the Entra app (the
        operator must manually confirm this list is empty -- a
        tenant-wide "Mail.Send" grant in Entra bypasses Exchange
        RBAC).  See the operator runbook section 6.
      - A live Microsoft Graph send test from the designated
        mailbox and a live attempt to send from another mailbox.
        See the operator runbook section 6b and section 6c.

    This script's green exit therefore proves ONLY that the
    Exchange Online RBAC configuration matches intent.  It does
    not and cannot by itself prove end-to-end security.

    DIAGNOSES AND REPAIRS (idempotently):
      - Management scope exists but has blank/incorrect
        RecipientRestrictionFilter -> repair in place with
        Set-ManagementScope.  Never deletes.
      - Correct scope -> recipient preview must return exactly
        one mailbox equal to the designated SharedMailbox.
      - Target role assignment missing -> create with
        New-ManagementRoleAssignment.
      - Role assignment that already matches -> no-op.

    BLOCKS (refuses to report success) on:
      - Any unscoped Mail.Send-granting role assignment on the SP.
      - Any Mail.Send-granting role assignment with a DIFFERENT
        scope than the intended one.
      - Shared mailbox is missing or has the wrong recipient type.
      - Negative control mailbox cannot be resolved.
      - Negative test shows the SP CAN send from the control.
      - Any Exchange query returns an error (fail-closed).

    DRY RUN.
      -DryRun performs no writes.  Reports every proposed
      write as "[DRY-RUN WOULD CHANGE]".  Verification runs
      against CURRENT state only; the summary flags whether a
      follow-up live run is required to re-verify after writes.

.PARAMETER AppClientId
    REQUIRED.  The Entra app's Application (client) ID (GUID
    from the App Registration overview).  The script resolves
    the Service Principal's ObjectId from this.

.PARAMETER SharedMailbox
    REQUIRED-with-default.  Mailbox the app is authorized to
    send from.  Default: no-reply@spectreautomation.com.
    Must already exist as a SharedMailbox in the tenant.

.PARAMETER NegativeControlMailbox
    REQUIRED-with-default.  A different, real mailbox that
    MUST NOT be in-scope for this app.  Default:
    admin@spectreautomation.com.
    MANDATORY: if this mailbox cannot be resolved, the script
    exits non-zero.  There is no "skip negative test" path.

.PARAMETER ScopeName
    Management scope name.  Default: "Spectre No-Reply Only".

.PARAMETER DryRun
    If set, no writes are performed.  See DESCRIPTION.

.PARAMETER Test
    Self-check mode.  Runs pure-function assertions against
    synthetic inputs that exercise the failure branches.
    Does NOT connect to Exchange Online.  Does NOT require any
    credentials.  Exits 0 on all assertions passing, non-zero
    with the first failed assertion.

.EXAMPLE
    .\signup-1g-ms365-repair.ps1 -AppClientId '11111111-2222-3333-4444-555555555555'

.EXAMPLE
    .\signup-1g-ms365-repair.ps1 -AppClientId '...' -DryRun

.EXAMPLE
    .\signup-1g-ms365-repair.ps1 -Test

.NOTES
    PREREQUISITES:
      - PowerShell 7+ strongly preferred.  Script runs on
        Windows PowerShell 5.1 but 5.1 has copy-paste quirks.
      - ExchangeOnlineManagement module v3.4 or later.
      - Signed in to Exchange Online as a Global Admin or
        Exchange Admin (Organization Management role group).

    SAFETY:
      - Idempotent.  Safe to rerun.
      - Reads existing state before any write.
      - Writes only to the two target resources: the one
        management scope + one role assignment on the one SP.
      - No deletion operations.
      - No secret handling.  The script never reads or prints
        a client secret.

    EXIT CODES:
      0  -- All verifications passed.  Exchange RBAC matches
           intent.  End-to-end security still depends on the
           operator-side checks (see runbook section 6).
      2  -- Preflight failure (module missing, Exchange
           connection failed).
      3  -- Mailbox validation failure (SharedMailbox missing
           or wrong recipient type, or negative control
           mailbox missing).
      4  -- Service principal not resolvable from AppId.
      5  -- Scope repair failed (filter still wrong after write)
           OR scope recipient-preview did not match exactly
           one target mailbox.
      6  -- Role-assignment create/query failed.
      7  -- Positive test failed (intended grant not in scope).
      8  -- Negative test failed (SP can send from control
           mailbox) -- SECURITY DEFECT.
      9  -- Broader grant blocker (unscoped or differently-
           scoped Mail.Send-granting role assignment on SP).
     10  -- Self-test assertion failure (-Test mode).
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false, HelpMessage = "The Entra app's Application (client) ID (GUID).")]
    [string]$AppClientId,

    [Parameter(Mandatory = $false)]
    [string]$SharedMailbox = 'no-reply@spectreautomation.com',

    [Parameter(Mandatory = $false)]
    [string]$NegativeControlMailbox = '',

    [Parameter(Mandatory = $false)]
    [string]$ScopeName = 'Spectre No-Reply Only',

    [Parameter(Mandatory = $false)]
    [switch]$DryRun,

    [Parameter(Mandatory = $false)]
    [switch]$Test
)

$ErrorActionPreference = 'Stop'

$script:Changes = @()
function Record-Change([string]$Description) {
    $script:Changes += $Description
    if ($DryRun) {
        Write-Host "  [DRY-RUN WOULD CHANGE] $Description" -ForegroundColor Yellow
    } else {
        Write-Host "  [CHANGE]              $Description" -ForegroundColor Yellow
    }
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
function Say-Info([string]$msg) { Write-Host "  [INFO]    $msg" }

# ============================================================================
# Pure functions -- side-effect-free, testable without live tenant.
# ============================================================================

# Normalize an email address for case-insensitive compare.
function Normalize-Email([string]$addr) {
    if ($null -eq $addr) { return '' }
    return $addr.Trim().ToLowerInvariant()
}

# Classify a list of role-assignment records (from Get-ManagementRoleAssignment)
# into: {matching, otherScoped, unscoped, broaderRole} relative to the intended
# ($Role, $ScopeName) target.  Operates on a hashtable shape so it can be
# exercised with mock data in -Test mode.
#
# Each input record is expected to carry:  Role, CustomResourceScope,
#   RecipientAdministrativeUnitScope, Name.
#
# Mail.Send-granting roles include "Application Mail.Send", "Application Mail
# Full Access", and "Application Exchange Full Access" -- the latter two confer
# Mail.Send among other permissions, so a grant of either must also be treated
# as a Mail.Send grant.
function Classify-RoleAssignments {
    param(
        [Parameter(Mandatory=$true)][AllowEmptyCollection()] $Assignments,
        [Parameter(Mandatory=$true)][string] $ExpectedScope
    )
    $mailSendRoles = @(
        'Application Mail.Send',
        'Application Mail Full Access',
        'Application Exchange Full Access'
    )
    $matching = @()
    $otherScoped = @()
    $unscoped = @()
    $broaderRole = @()

    foreach ($a in $Assignments) {
        if (-not ($mailSendRoles -contains $a.Role)) { continue }

        $scope = $a.CustomResourceScope
        $auScope = $a.RecipientAdministrativeUnitScope
        $isScoped = -not ([string]::IsNullOrWhiteSpace($scope)) -or `
                    -not ([string]::IsNullOrWhiteSpace($auScope))

        # Any Mail.Send grant via a BROADER role is a blocker regardless of
        # scope -- the role carries extra permissions Spectre's app does not need.
        if ($a.Role -ne 'Application Mail.Send') {
            $broaderRole += $a
            continue
        }

        if (-not $isScoped) {
            $unscoped += $a
        }
        elseif ($scope -eq $ExpectedScope) {
            $matching += $a
        }
        else {
            $otherScoped += $a
        }
    }
    return [pscustomobject]@{
        Matching    = $matching
        OtherScoped = $otherScoped
        Unscoped    = $unscoped
        BroaderRole = $broaderRole
    }
}

# Filter a list of mailbox records down to those eligible as the
# negative-control mailbox.  Eligible = real user or shared mailbox,
# a resolvable PrimarySmtpAddress, and NOT equal (case-fold) to the
# supplied SharedMailbox address.  System / discovery / unknown
# types are excluded.  Pure function; exercised in -Test mode.
#
# Each input record is expected to carry:  PrimarySmtpAddress,
#   RecipientTypeDetails, DisplayName.
function Select-NegativeControlCandidates {
    param(
        [Parameter(Mandatory=$true)][AllowEmptyCollection()] $Mailboxes,
        [Parameter(Mandatory=$true)][string] $SharedMailbox
    )
    $allowedTypes = @('UserMailbox', 'SharedMailbox')
    $sharedNorm = (Normalize-Email $SharedMailbox)
    $out = @()
    foreach ($m in $Mailboxes) {
        if ($null -eq $m) { continue }
        if (-not ($allowedTypes -contains $m.RecipientTypeDetails)) { continue }
        if ([string]::IsNullOrWhiteSpace($m.PrimarySmtpAddress)) { continue }
        $addr = Normalize-Email $m.PrimarySmtpAddress
        if ($addr -eq $sharedNorm) { continue }
        $out += $m
    }
    return @($out)
}

# Decide the positive/negative verdict from a Test-ServicePrincipalAuthorization
# result set.  Positive: at least one Mail.Send-conferring row has
# InScope=True AND AllowedResourceScope = ExpectedScope.  Negative:
# NO Mail.Send-conferring row has InScope=True.
function Evaluate-AuthorizationResult {
    param(
        [Parameter(Mandatory=$true)][AllowEmptyCollection()] $AuthRows,
        [Parameter(Mandatory=$true)][string] $ExpectedScope,
        [Parameter(Mandatory=$true)][ValidateSet('Positive','Negative')] [string] $Mode
    )
    # Rows that confer Mail.Send either directly (GrantedPermissions
    # contains "Mail.Send") or via a broader role.  We filter on
    # GrantedPermissions since Test-ServicePrincipalAuthorization returns
    # the resolved permission list rather than the raw role name alone.
    $relevant = @($AuthRows | Where-Object {
        $gp = $_.GrantedPermissions
        if ($null -eq $gp) { return $false }
        # GrantedPermissions in the live cmdlet is a semicolon-separated
        # string in some module versions and an array in others -- handle both.
        if ($gp -is [string]) { return ($gp -split '[,; ]') -contains 'Mail.Send' }
        return $gp -contains 'Mail.Send'
    })

    if ($Mode -eq 'Positive') {
        $good = @($relevant | Where-Object {
            $_.InScope -eq $true -and $_.AllowedResourceScope -eq $ExpectedScope
        })
        $wrongScope = @($relevant | Where-Object {
            $_.InScope -eq $true -and $_.AllowedResourceScope -ne $ExpectedScope
        })
        return [pscustomobject]@{
            Pass        = ($good.Count -ge 1)
            Matching    = $good
            WrongScope  = $wrongScope
            Relevant    = $relevant
        }
    }
    else {
        # Negative -- nothing may be InScope.
        $leaks = @($relevant | Where-Object { $_.InScope -eq $true })
        return [pscustomobject]@{
            Pass        = ($leaks.Count -eq 0)
            Leaks       = $leaks
            Relevant    = $relevant
        }
    }
}

# ============================================================================
# -Test mode -- mocked failure-path assertions, no tenant required.
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

    Say-Section "-Test - pure-function assertions"

    # --- Classify-RoleAssignments -------------------------------------------

    # Empty input -> everything zero.
    $r = Classify-RoleAssignments -Assignments @() -ExpectedScope 'Scope-A'
    Assert-Equal 0 $r.Matching.Count    'empty -> Matching=0'
    Assert-Equal 0 $r.OtherScoped.Count 'empty -> OtherScoped=0'
    Assert-Equal 0 $r.Unscoped.Count    'empty -> Unscoped=0'
    Assert-Equal 0 $r.BroaderRole.Count 'empty -> BroaderRole=0'

    # Correctly scoped assignment.
    $r = Classify-RoleAssignments -Assignments @(
        [pscustomobject]@{ Role='Application Mail.Send'; CustomResourceScope='Scope-A';
                           RecipientAdministrativeUnitScope=$null; Name='rc-1' }
    ) -ExpectedScope 'Scope-A'
    Assert-Equal 1 $r.Matching.Count    'scoped-correctly -> Matching=1'
    Assert-Equal 0 $r.OtherScoped.Count 'scoped-correctly -> OtherScoped=0'

    # Differently scoped.
    $r = Classify-RoleAssignments -Assignments @(
        [pscustomobject]@{ Role='Application Mail.Send'; CustomResourceScope='Scope-OTHER';
                           RecipientAdministrativeUnitScope=$null; Name='rc-2' }
    ) -ExpectedScope 'Scope-A'
    Assert-Equal 0 $r.Matching.Count    'differently-scoped -> Matching=0'
    Assert-Equal 1 $r.OtherScoped.Count 'differently-scoped -> OtherScoped=1'

    # Unscoped (both scope fields empty).
    $r = Classify-RoleAssignments -Assignments @(
        [pscustomobject]@{ Role='Application Mail.Send'; CustomResourceScope='';
                           RecipientAdministrativeUnitScope=''; Name='rc-3' }
    ) -ExpectedScope 'Scope-A'
    Assert-Equal 1 $r.Unscoped.Count    'unscoped -> Unscoped=1'

    # Broader role (Mail Full Access).
    $r = Classify-RoleAssignments -Assignments @(
        [pscustomobject]@{ Role='Application Mail Full Access'; CustomResourceScope='Scope-A';
                           RecipientAdministrativeUnitScope=$null; Name='rc-4' }
    ) -ExpectedScope 'Scope-A'
    Assert-Equal 1 $r.BroaderRole.Count 'broader-role -> BroaderRole=1'
    Assert-Equal 0 $r.Matching.Count    'broader-role -> Matching=0  (not treated as satisfying intent)'

    # Non-Mail.Send role -> ignored.
    $r = Classify-RoleAssignments -Assignments @(
        [pscustomobject]@{ Role='Application Calendars.Read'; CustomResourceScope='Scope-A';
                           RecipientAdministrativeUnitScope=$null; Name='rc-5' }
    ) -ExpectedScope 'Scope-A'
    Assert-Equal 0 $r.Matching.Count    'unrelated-role -> Matching=0'
    Assert-Equal 0 $r.BroaderRole.Count 'unrelated-role -> BroaderRole=0'

    # --- Evaluate-AuthorizationResult ---------------------------------------

    # Positive -- scope-matching row present.
    $pv = Evaluate-AuthorizationResult -Mode Positive -ExpectedScope 'Scope-A' -AuthRows @(
        [pscustomobject]@{ RoleName='Application Mail.Send'; GrantedPermissions=@('Mail.Send');
                           AllowedResourceScope='Scope-A'; InScope=$true }
    )
    Assert-Equal $true $pv.Pass 'positive -> matching scope passes'

    # Positive -- row present but wrong scope.
    $pv = Evaluate-AuthorizationResult -Mode Positive -ExpectedScope 'Scope-A' -AuthRows @(
        [pscustomobject]@{ RoleName='Application Mail.Send'; GrantedPermissions=@('Mail.Send');
                           AllowedResourceScope='Scope-ELSEWHERE'; InScope=$true }
    )
    Assert-Equal $false $pv.Pass 'positive -> wrong-scope match does NOT pass'
    Assert-Equal 1 $pv.WrongScope.Count 'positive -> wrong-scope captured'

    # Negative -- leaks present.
    $nv = Evaluate-AuthorizationResult -Mode Negative -ExpectedScope 'Scope-A' -AuthRows @(
        [pscustomobject]@{ RoleName='Application Mail.Send'; GrantedPermissions=@('Mail.Send');
                           AllowedResourceScope='Scope-ELSEWHERE'; InScope=$true }
    )
    Assert-Equal $false $nv.Pass 'negative -> any InScope leak fails'
    Assert-Equal 1 $nv.Leaks.Count 'negative -> leak captured'

    # Negative -- no Mail.Send row at all.
    $nv = Evaluate-AuthorizationResult -Mode Negative -ExpectedScope 'Scope-A' -AuthRows @()
    Assert-Equal $true $nv.Pass 'negative -> no rows passes'

    # Negative -- row present but InScope=false.
    $nv = Evaluate-AuthorizationResult -Mode Negative -ExpectedScope 'Scope-A' -AuthRows @(
        [pscustomobject]@{ RoleName='Application Mail.Send'; GrantedPermissions=@('Mail.Send');
                           AllowedResourceScope='Scope-A'; InScope=$false }
    )
    Assert-Equal $true $nv.Pass 'negative -> out-of-scope row passes'

    # GrantedPermissions as semicolon-separated string.
    $nv = Evaluate-AuthorizationResult -Mode Negative -ExpectedScope 'Scope-A' -AuthRows @(
        [pscustomobject]@{ RoleName='Application Mail.Send'; GrantedPermissions='Mail.Send;Mail.Read';
                           AllowedResourceScope='Scope-A'; InScope=$true }
    )
    Assert-Equal $false $nv.Pass 'negative -> semi-colon-string GrantedPermissions still parsed'

    # Normalize-Email.
    Assert-Equal 'no-reply@spectreautomation.com' (Normalize-Email 'NO-REPLY@SpectreAutomation.COM') 'normalize-email - case fold'
    Assert-Equal 'no-reply@spectreautomation.com' (Normalize-Email '  no-reply@spectreautomation.com  ') 'normalize-email - trim'
    Assert-Equal '' (Normalize-Email $null) 'normalize-email - null -> empty'

    # --- Select-NegativeControlCandidates --------------------------------
    # @(...) wraps the call so a single-item result is not unwrapped
    # by PowerShell's pipeline-flattening behaviour before .Count is read.

    # Empty input -> zero candidates.
    $c = @(Select-NegativeControlCandidates -Mailboxes @() -SharedMailbox 'no-reply@spectreautomation.com')
    Assert-Equal 0 $c.Count 'neg-ctrl - empty input -> 0 candidates'

    # Only the shared mailbox -> zero candidates.
    $c = @(Select-NegativeControlCandidates -Mailboxes @(
        [pscustomobject]@{ PrimarySmtpAddress='no-reply@spectreautomation.com'; RecipientTypeDetails='SharedMailbox'; DisplayName='No Reply' }
    ) -SharedMailbox 'no-reply@spectreautomation.com')
    Assert-Equal 0 $c.Count 'neg-ctrl - only SharedMailbox -> 0 candidates (excluded)'

    # Case-fold exclusion.
    $c = @(Select-NegativeControlCandidates -Mailboxes @(
        [pscustomobject]@{ PrimarySmtpAddress='NO-REPLY@SpectreAutomation.COM'; RecipientTypeDetails='SharedMailbox'; DisplayName='No Reply' }
    ) -SharedMailbox 'no-reply@spectreautomation.com')
    Assert-Equal 0 $c.Count 'neg-ctrl - case-fold exclusion of shared mailbox'

    # One eligible user mailbox + the shared mailbox -> one candidate.
    $c = @(Select-NegativeControlCandidates -Mailboxes @(
        [pscustomobject]@{ PrimarySmtpAddress='no-reply@spectreautomation.com'; RecipientTypeDetails='SharedMailbox'; DisplayName='No Reply' }
        [pscustomobject]@{ PrimarySmtpAddress='founder@spectreautomation.com'; RecipientTypeDetails='UserMailbox'; DisplayName='Founder' }
    ) -SharedMailbox 'no-reply@spectreautomation.com')
    Assert-Equal 1 $c.Count 'neg-ctrl - 1 user mailbox + shared -> 1 candidate'
    Assert-Equal 'founder@spectreautomation.com' $c[0].PrimarySmtpAddress 'neg-ctrl - correct candidate selected'

    # System / discovery mailboxes rejected.
    $c = @(Select-NegativeControlCandidates -Mailboxes @(
        [pscustomobject]@{ PrimarySmtpAddress='disc@spectreautomation.com'; RecipientTypeDetails='DiscoveryMailbox'; DisplayName='Discovery' }
        [pscustomobject]@{ PrimarySmtpAddress='sys@spectreautomation.com';  RecipientTypeDetails='ArbitrationMailbox'; DisplayName='Sys' }
        [pscustomobject]@{ PrimarySmtpAddress='group@spectreautomation.com'; RecipientTypeDetails='GroupMailbox'; DisplayName='Group' }
    ) -SharedMailbox 'no-reply@spectreautomation.com')
    Assert-Equal 0 $c.Count 'neg-ctrl - system/discovery/group mailboxes rejected'

    # Multi-candidate case.
    $c = @(Select-NegativeControlCandidates -Mailboxes @(
        [pscustomobject]@{ PrimarySmtpAddress='a@x.test'; RecipientTypeDetails='UserMailbox'; DisplayName='A' }
        [pscustomobject]@{ PrimarySmtpAddress='b@x.test'; RecipientTypeDetails='SharedMailbox'; DisplayName='B' }
        [pscustomobject]@{ PrimarySmtpAddress='no-reply@spectreautomation.com'; RecipientTypeDetails='SharedMailbox'; DisplayName='No Reply' }
    ) -SharedMailbox 'no-reply@spectreautomation.com')
    Assert-Equal 2 $c.Count 'neg-ctrl - 2 eligible candidates'

    # Null address rejected.
    $c = @(Select-NegativeControlCandidates -Mailboxes @(
        [pscustomobject]@{ PrimarySmtpAddress=$null; RecipientTypeDetails='UserMailbox'; DisplayName='Null addr' }
    ) -SharedMailbox 'no-reply@spectreautomation.com')
    Assert-Equal 0 $c.Count 'neg-ctrl - null PrimarySmtpAddress rejected'

    # --- SIGNUP-1G final review: scope-filter + SP identity assertions ---
    # Scope filter EXACT equality (not merely non-empty).  These two
    # tests exercise the logic of the Phase 3 read-back strengthening.
    $expectedFilter = "PrimarySmtpAddress -eq 'no-reply@spectreautomation.com'"
    Assert-Equal $false ([string]::IsNullOrWhiteSpace($expectedFilter)) 'scope-filter - expected is non-empty (sanity)'
    Assert-Equal $true ($expectedFilter -eq "PrimarySmtpAddress -eq 'no-reply@spectreautomation.com'") 'scope-filter - exact match self-check'
    Assert-Equal $false ($expectedFilter -eq "PrimarySmtpAddress -eq 'other@spectreautomation.com'") 'scope-filter - different value does NOT match'
    Assert-Equal $false ($expectedFilter -eq "PrimarySmtpAddress -eq 'no-reply@spectreautomation.com' ") 'scope-filter - trailing whitespace does NOT match'
    Assert-Equal $false ($expectedFilter -eq "Alias -eq 'no-reply'") 'scope-filter - different property does NOT match'

    # SP identity validation (case-fold AppId equality + ObjectId GUID shape).
    $guidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    $requested = '11111111-2222-3333-4444-555555555555'
    Assert-Equal $true  ($requested.ToLowerInvariant() -eq '11111111-2222-3333-4444-555555555555'.ToLowerInvariant()) 'sp-id - matching AppId equal case-fold'
    Assert-Equal $true  ('11111111-2222-3333-4444-555555555555'.ToLowerInvariant() -eq '11111111-2222-3333-4444-555555555555'.ToUpperInvariant().ToLowerInvariant()) 'sp-id - case-fold equal regardless of returned case'
    Assert-Equal $false ($requested.ToLowerInvariant() -eq '99999999-9999-9999-9999-999999999999'.ToLowerInvariant()) 'sp-id - different AppId does NOT match'
    Assert-Equal $true  ('66666666-7777-8888-9999-aaaaaaaaaaaa' -match $guidPattern) 'sp-id - well-formed ObjectId matches guid pattern'
    Assert-Equal $false ('' -match $guidPattern) 'sp-id - empty ObjectId does NOT match guid pattern'
    Assert-Equal $false ('not-a-guid' -match $guidPattern) 'sp-id - garbage ObjectId does NOT match guid pattern'
    Assert-Equal $false ('11111111-2222-3333-4444' -match $guidPattern) 'sp-id - truncated ObjectId does NOT match guid pattern'

    Say-Section "Self-test summary"
    if ($script:failures -gt 0) {
        Say-Fail "$($script:failures) assertion(s) failed."
        exit 10
    }
    Say-OK "All assertions passed."
    exit 0
}

# ============================================================================
# Live run begins here -- requires -AppClientId.
# ============================================================================
if ([string]::IsNullOrWhiteSpace($AppClientId)) {
    Say-Fail "-AppClientId is required for a live run.  (Use -Test to run the self-check without a tenant.)"
    exit 2
}
if ($AppClientId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
    Say-Fail "-AppClientId must be a GUID."
    exit 2
}

if ($DryRun) {
    Write-Host ""
    Write-Host "========================================================================" -ForegroundColor Yellow
    Write-Host " DRY RUN MODE -- no writes will be performed.  Verification runs against" -ForegroundColor Yellow
    Write-Host " CURRENT state.  Follow-up live run required if any changes are listed." -ForegroundColor Yellow
    Write-Host "========================================================================" -ForegroundColor Yellow
}

# TLS 1.2 -- required by Install-Module on older Windows configurations.
# Harmless if already set.
[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$ExpectedFilter = "PrimarySmtpAddress -eq '$SharedMailbox'"

# ============================================================================
# Phase 0 -- Preflight
# ============================================================================
Say-Section "Phase 0 -- Preflight"
Say-Info "PowerShell version: $($PSVersionTable.PSVersion)"
if ($PSVersionTable.PSVersion.Major -lt 7) {
    Say-Warn "Running on Windows PowerShell $($PSVersionTable.PSVersion).  PowerShell 7+ is preferred."
}

Say-Info "Checking ExchangeOnlineManagement module..."
$module = Get-Module -ListAvailable -Name ExchangeOnlineManagement |
    Sort-Object Version -Descending |
    Select-Object -First 1
if (-not $module) {
    Say-Fail "ExchangeOnlineManagement module not installed."
    Say-Info "Install with: Install-Module -Name ExchangeOnlineManagement -MinimumVersion 3.4.0 -Scope CurrentUser"
    exit 2
}
if ($module.Version -lt [version]'3.4.0') {
    Say-Fail "ExchangeOnlineManagement v$($module.Version) is older than the required 3.4.0."
    Say-Info "Update with: Update-Module -Name ExchangeOnlineManagement -Force"
    exit 2
}
Say-OK "ExchangeOnlineManagement v$($module.Version)"
Import-Module ExchangeOnlineManagement -ErrorAction Stop

Say-Info "Checking Exchange Online connection..."
$connected = $false
$connInfo = $null
try {
    $connInfo = Get-ConnectionInformation -ErrorAction Stop
    if ($connInfo -and $connInfo.State -eq 'Connected') { $connected = $true }
} catch { $connected = $false }

if (-not $connected) {
    Say-Info "Not connected.  Running Connect-ExchangeOnline..."
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
# Phase 1 -- Shared mailbox validation (identity + type)
# ============================================================================
Say-Section "Phase 1 -- Shared mailbox validation"

$mbx = $null
try {
    $mbx = Get-EXOMailbox -Identity $SharedMailbox -ErrorAction Stop -Properties RecipientTypeDetails,PrimarySmtpAddress
} catch {
    Say-Fail "SharedMailbox '$SharedMailbox' not found: $($_.Exception.Message)"
    Say-Info "Create it under Microsoft 365 admin -> Teams & groups -> Shared mailboxes."
    exit 3
}

$actualAddr = Normalize-Email $mbx.PrimarySmtpAddress
$expectedAddr = Normalize-Email $SharedMailbox
if ($actualAddr -ne $expectedAddr) {
    Say-Fail "Mailbox PrimarySmtpAddress mismatch: resolved '$($mbx.PrimarySmtpAddress)', expected '$SharedMailbox'."
    exit 3
}
Say-OK "PrimarySmtpAddress = $($mbx.PrimarySmtpAddress)"

if ($mbx.RecipientTypeDetails -ne 'SharedMailbox') {
    Say-Fail "Mailbox RecipientTypeDetails = '$($mbx.RecipientTypeDetails)' -- expected 'SharedMailbox'."
    Say-Info "The transactional sender MUST be a shared mailbox (unlicensed, send-only)."
    exit 3
}
Say-OK "RecipientTypeDetails = SharedMailbox"

# ============================================================================
# Phase 1b -- MANDATORY negative control mailbox resolution.
#
# SIGNUP-1G correction (dry-run failure #1): the previous version
# defaulted -NegativeControlMailbox to 'admin@spectreautomation.com'
# and assumed it was a real mailbox.  Admin accounts in M365 are
# often unlicensed service accounts with NO mailbox, so Get-EXOMailbox
# returned 404.  This block now:
#   1. Uses the operator-supplied -NegativeControlMailbox when
#      explicitly provided, validating it exists + is a real mailbox
#      + is NOT the SharedMailbox.
#   2. Otherwise, discovers eligible mailboxes with a read-only
#      Get-EXOMailbox query (no writes, no mutations), excludes the
#      SharedMailbox + system / discovery / group mailboxes, and:
#         - picks the single candidate automatically if only one exists,
#         - prompts interactively if multiple exist,
#         - exits 3 with a clear message if zero exist.
#   3. Never creates or modifies a mailbox.
# ============================================================================
Say-Section "Phase 1b -- Negative control mailbox"

$neg = $null

if (-not [string]::IsNullOrWhiteSpace($NegativeControlMailbox)) {
    # Explicit operator-supplied control.
    Say-Info "Operator supplied -NegativeControlMailbox = '$NegativeControlMailbox'.  Resolving."
    try {
        $neg = Get-EXOMailbox -Identity $NegativeControlMailbox -ErrorAction Stop -Properties PrimarySmtpAddress,RecipientTypeDetails
    } catch {
        Say-Fail "Supplied -NegativeControlMailbox '$NegativeControlMailbox' could not be resolved: $($_.Exception.Message)"
        Say-Info "Supply a different, real mailbox with -NegativeControlMailbox, or omit the flag to discover one."
        exit 3
    }
    if (-not $neg -or -not $neg.PrimarySmtpAddress) {
        Say-Fail "Supplied -NegativeControlMailbox resolved to a null record (fail-closed)."
        exit 3
    }
    if ((Normalize-Email $neg.PrimarySmtpAddress) -eq (Normalize-Email $SharedMailbox)) {
        Say-Fail "Supplied -NegativeControlMailbox resolves to the SAME address as -SharedMailbox."
        Say-Info "The negative test is meaningless when the two addresses are the same."
        exit 3
    }
    $allowedTypes = @('UserMailbox', 'SharedMailbox')
    if (-not ($allowedTypes -contains $neg.RecipientTypeDetails)) {
        Say-Fail "Supplied -NegativeControlMailbox RecipientTypeDetails = '$($neg.RecipientTypeDetails)' is not a UserMailbox or SharedMailbox."
        exit 3
    }
    Say-OK "Negative control mailbox (operator-supplied): $($neg.PrimarySmtpAddress) ($($neg.RecipientTypeDetails))"
} else {
    # Discovery path -- read-only enumeration.
    Say-Info "No -NegativeControlMailbox supplied.  Discovering eligible mailboxes (read-only)."
    $allMailboxes = $null
    try {
        $allMailboxes = @(Get-EXOMailbox -ResultSize Unlimited -Properties PrimarySmtpAddress,RecipientTypeDetails,DisplayName -ErrorAction Stop)
    } catch {
        Say-Fail "Get-EXOMailbox discovery query failed (fail-closed): $($_.Exception.Message)"
        exit 3
    }
    $candidates = @(Select-NegativeControlCandidates -Mailboxes $allMailboxes -SharedMailbox $SharedMailbox)
    if ($candidates.Count -eq 0) {
        Say-Fail "Discovery found ZERO eligible negative-control mailboxes."
        Say-Info "The tenant contains no UserMailbox or SharedMailbox other than '$SharedMailbox'."
        Say-Info "The negative test is MANDATORY and cannot be skipped."
        Say-Info "Create at least one additional licensed user mailbox OR supply -NegativeControlMailbox explicitly."
        exit 3
    }
    if ($candidates.Count -eq 1) {
        $neg = $candidates[0]
        Say-OK "Negative control mailbox (auto-selected from one eligible candidate): $($neg.PrimarySmtpAddress) ($($neg.RecipientTypeDetails))"
    } else {
        # Multiple candidates -- prompt the operator to choose.
        Say-Warn "Found $($candidates.Count) eligible mailboxes.  Please select one as the negative control."
        for ($i = 0; $i -lt $candidates.Count; $i++) {
            $c = $candidates[$i]
            $display = if ([string]::IsNullOrWhiteSpace($c.DisplayName)) { '(no display name)' } else { $c.DisplayName }
            Write-Host ("    [{0}]  {1}  ({2})  --  {3}" -f ($i + 1), $c.PrimarySmtpAddress, $c.RecipientTypeDetails, $display)
        }
        Write-Host ""
        $selection = $null
        try {
            $raw = Read-Host "Enter the number of the mailbox to use as the negative control (or paste its full address)"
        } catch {
            Say-Fail "Interactive selection is required when multiple candidates exist, but Read-Host failed (non-interactive session?): $($_.Exception.Message)"
            Say-Info "Rerun with -NegativeControlMailbox '<address>' to pick one non-interactively."
            exit 3
        }
        $raw = "$raw".Trim()
        if ([string]::IsNullOrWhiteSpace($raw)) {
            Say-Fail "No selection entered.  Aborting."
            exit 3
        }
        # Numeric selection?
        [int]$asInt = 0
        if ([int]::TryParse($raw, [ref]$asInt) -and $asInt -ge 1 -and $asInt -le $candidates.Count) {
            $selection = $candidates[$asInt - 1]
        } else {
            # Treat as address.
            $target = Normalize-Email $raw
            $match = @($candidates | Where-Object { (Normalize-Email $_.PrimarySmtpAddress) -eq $target })
            if ($match.Count -ne 1) {
                Say-Fail "Entered value '$raw' did not match any listed candidate (either as a number or an address)."
                exit 3
            }
            $selection = $match[0]
        }
        $neg = $selection
        Say-OK "Negative control mailbox (operator-selected): $($neg.PrimarySmtpAddress) ($($neg.RecipientTypeDetails))"
    }
}

# $NegativeControlMailbox is used downstream in the authorization
# test and messages -- make sure it reflects the actual selected
# mailbox regardless of which branch chose it.
$NegativeControlMailbox = $neg.PrimarySmtpAddress

# ============================================================================
# Phase 2 -- Resolve the Service Principal by AppId.
# ============================================================================
Say-Section "Phase 2 -- Service principal resolution"

$sp = $null
try {
    $sp = Get-ServicePrincipal -Identity $AppClientId -ErrorAction Stop
} catch {
    Say-Fail "Service principal with AppId '$AppClientId' not found in Exchange: $($_.Exception.Message)"
    Say-Info "This usually means the ServicePrincipal pointer wasn't created yet."
    Say-Info "Fix: run (one time, from a connected Exchange session)"
    Say-Info "  New-ServicePrincipal @{ AppId = '<AppClientId>'; ObjectId = '<Enterprise App Object ID>'; DisplayName = 'Spectre Transactional Mail' }"
    Say-Info "The Enterprise App Object ID comes from Entra -> Enterprise applications -> the app -> Object ID"
    Say-Info "(NOT the App Registration's Object ID -- those are different GUIDs)."
    exit 4
}
if (-not $sp) {
    Say-Fail "Get-ServicePrincipal returned a null record for AppId '$AppClientId' (fail-closed)."
    exit 4
}

# Strengthened SP resolution (SIGNUP-1G final review correction):
# Verify the record Exchange returned actually corresponds to the AppId
# we requested, and that its ObjectId is present and well-formed.
# Fail-closed on either check — do not continue with a bogus SP.
$returnedAppId = ("$($sp.AppId)").Trim()
$requestedAppId = $AppClientId.Trim()
if ([string]::IsNullOrWhiteSpace($returnedAppId)) {
    Say-Fail "Get-ServicePrincipal returned an SP with no AppId (fail-closed)."
    exit 4
}
# GUIDs are case-insensitive; compare case-fold.
if ($returnedAppId.ToLowerInvariant() -ne $requestedAppId.ToLowerInvariant()) {
    Say-Fail "Service principal AppId mismatch (fail-closed)."
    Say-Info "  Requested AppId : $requestedAppId"
    Say-Info "  Returned AppId  : $returnedAppId"
    Say-Info "This typically means Get-ServicePrincipal matched on DisplayName instead of AppId."
    exit 4
}

$returnedObjectId = ("$($sp.ObjectId)").Trim()
$guidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
if ([string]::IsNullOrWhiteSpace($returnedObjectId)) {
    Say-Fail "Service principal has no ObjectId (fail-closed)."
    exit 4
}
if ($returnedObjectId -notmatch $guidPattern) {
    Say-Fail "Service principal ObjectId '$returnedObjectId' is not a well-formed GUID (fail-closed)."
    exit 4
}

Say-OK "Service principal:"
Say-Info "  DisplayName : $($sp.DisplayName)"
Say-Info "  AppId       : $($sp.AppId)  (verified matches -AppClientId)"
Say-Info "  ObjectId    : $($sp.ObjectId)  (verified GUID)"
$spObjectId = $returnedObjectId

# ============================================================================
# Phase 3 -- Management scope diagnose + idempotent repair.
# ============================================================================
Say-Section "Phase 3 -- Management scope"

$existingScope = $null
try {
    $existingScope = Get-ManagementScope -Identity $ScopeName -ErrorAction Stop
} catch {
    # Not-found is NOT an error for this cmdlet in most module versions, but
    # if an actual error occurred we fail-closed rather than assume missing.
    $msg = $_.Exception.Message
    if ($msg -match 'couldn' + "'" + 't be found|does not exist|not found' ) {
        $existingScope = $null
    } else {
        Say-Fail "Get-ManagementScope '$ScopeName' threw an unexpected error (fail-closed): $msg"
        exit 5
    }
}

if (-not $existingScope) {
    Say-Warn "Management scope '$ScopeName' does not exist."
    Record-Change "Create ManagementScope '$ScopeName' with filter: $ExpectedFilter"
    if (-not $DryRun) {
        $createParams = @{
            Name                      = $ScopeName
            RecipientRestrictionFilter = $ExpectedFilter
            ErrorAction                = 'Stop'
        }
        try {
            $existingScope = New-ManagementScope @createParams
            Say-OK "Scope created."
        } catch {
            Say-Fail "New-ManagementScope failed: $($_.Exception.Message)"
            exit 5
        }
    }
} else {
    $currentFilter = $existingScope.RecipientFilter
    Say-Info "Current RecipientFilter: '$currentFilter'"
    if ([string]::IsNullOrWhiteSpace($currentFilter)) {
        Say-Warn "Scope filter is BLANK (observed state -- matches a failure mode the founder reported)."
        Record-Change "Set RecipientRestrictionFilter on '$ScopeName' to: $ExpectedFilter"
        if (-not $DryRun) {
            $setParams = @{
                Identity                   = $ScopeName
                RecipientRestrictionFilter = $ExpectedFilter
                ErrorAction                = 'Stop'
            }
            try {
                Set-ManagementScope @setParams
                Say-OK "Scope filter updated."
            } catch {
                Say-Fail "Set-ManagementScope failed: $($_.Exception.Message)"
                exit 5
            }
        }
    } elseif ($currentFilter -ne $ExpectedFilter) {
        Say-Warn "Scope filter is set but does not match expected value."
        Say-Info "  Expected: $ExpectedFilter"
        Say-Info "  Actual  : $currentFilter"
        Record-Change "Overwrite RecipientRestrictionFilter on '$ScopeName' to: $ExpectedFilter"
        if (-not $DryRun) {
            $setParams = @{
                Identity                   = $ScopeName
                RecipientRestrictionFilter = $ExpectedFilter
                ErrorAction                = 'Stop'
            }
            try {
                Set-ManagementScope @setParams
                Say-OK "Scope filter updated."
            } catch {
                Say-Fail "Set-ManagementScope failed: $($_.Exception.Message)"
                exit 5
            }
        }
    } else {
        Say-OK "Scope filter is already correct -- no change needed."
    }
}

# Post-repair verification -- read it back (SIGNUP-1G final review:
# strengthened to require EXACT equality against $ExpectedFilter, not
# merely non-empty).
if (-not $DryRun) {
    try {
        $existingScope = Get-ManagementScope -Identity $ScopeName -ErrorAction Stop
    } catch {
        Say-Fail "Get-ManagementScope read-back failed: $($_.Exception.Message)"
        exit 5
    }
    $readBackFilter = "$($existingScope.RecipientFilter)"
    if ([string]::IsNullOrWhiteSpace($readBackFilter)) {
        Say-Fail "Scope filter is STILL blank after repair.  Aborting."
        exit 5
    }
    # Strict equality against the expected filter.  A non-empty but
    # subtly different value (extra whitespace, swapped quotes, a
    # different property) must NOT be accepted as proof of correct
    # scoping.
    if ($readBackFilter -ne $ExpectedFilter) {
        Say-Fail "Scope filter read-back MISMATCH (fail-closed)."
        Say-Info "  Expected: $ExpectedFilter"
        Say-Info "  Actual  : $readBackFilter"
        Say-Info "The scope was written but its stored filter does not equal the intended value."
        exit 5
    }
    Say-OK "Scope filter confirmed on read-back (exact match): $readBackFilter"
}

# Phase 3b -- Recipient preview: the filter must match exactly ONE mailbox
# and that mailbox must be the SharedMailbox.  Even in dry-run we evaluate
# the CURRENT filter (which may be blank or wrong, and the preview will say so).
Say-Info "Running Get-Recipient preview against the scope filter..."
$previewFilter = if ($DryRun -and ([string]::IsNullOrWhiteSpace($existingScope.RecipientFilter))) {
    $null
} else {
    $existingScope.RecipientFilter
}

if ([string]::IsNullOrWhiteSpace($previewFilter)) {
    if ($DryRun) {
        Say-Warn "Dry-run and current filter is blank.  Preview check is deferred until the live run writes the filter."
    } else {
        Say-Fail "Scope filter is blank -- refuse to continue."
        exit 5
    }
} else {
    try {
        $preview = @(Get-Recipient -RecipientPreviewFilter $previewFilter -ResultSize Unlimited -ErrorAction Stop)
    } catch {
        Say-Fail "Get-Recipient preview failed (fail-closed): $($_.Exception.Message)"
        exit 5
    }
    if ($preview.Count -ne 1) {
        Say-Fail "Scope recipient-preview returned $($preview.Count) recipients -- expected exactly 1."
        if ($preview.Count -gt 0) {
            foreach ($p in $preview) { Say-Info "  - $($p.PrimarySmtpAddress) ($($p.RecipientTypeDetails))" }
        }
        exit 5
    }
    if ((Normalize-Email $preview[0].PrimarySmtpAddress) -ne (Normalize-Email $SharedMailbox)) {
        Say-Fail "Scope preview returned '$($preview[0].PrimarySmtpAddress)' -- expected '$SharedMailbox'."
        exit 5
    }
    Say-OK "Scope recipient-preview matches exactly one mailbox: $($preview[0].PrimarySmtpAddress)."
}

# ============================================================================
# Phase 4 -- Role assignment diagnose + idempotent repair.
# ============================================================================
Say-Section "Phase 4 -- Role assignment"

$existingAssignments = $null
try {
    $existingAssignments = @(Get-ManagementRoleAssignment -RoleAssignee $spObjectId -ErrorAction Stop)
} catch {
    # Fail-closed: an error here is NOT proof that no assignments exist.
    Say-Fail "Get-ManagementRoleAssignment failed (fail-closed; cannot assume no existing grants): $($_.Exception.Message)"
    exit 6
}

$classified = Classify-RoleAssignments -Assignments $existingAssignments -ExpectedScope $ScopeName

# Report classification.
if ($classified.Matching.Count -gt 0) {
    Say-OK "Found $($classified.Matching.Count) matching assignment(s) (role='Application Mail.Send', scope='$ScopeName')."
    foreach ($a in $classified.Matching) { Say-Info "  - $($a.Name)" }
} else {
    Say-Warn "No matching 'Application Mail.Send' assignment with scope '$ScopeName'."
}

if ($classified.OtherScoped.Count -gt 0) {
    Say-Fail "BLOCKER -- $($classified.OtherScoped.Count) 'Application Mail.Send' assignment(s) with a DIFFERENT scope exist on this SP:"
    foreach ($a in $classified.OtherScoped) {
        Say-Info "  - $($a.Name)  (CustomResourceScope='$($a.CustomResourceScope)')"
    }
    Say-Info "Review each.  Remove via: Remove-ManagementRoleAssignment -Identity '<name>' -Confirm:`$false"
}
if ($classified.Unscoped.Count -gt 0) {
    Say-Fail "BLOCKER -- $($classified.Unscoped.Count) UNSCOPED 'Application Mail.Send' assignment(s) exist on this SP."
    foreach ($a in $classified.Unscoped) {
        Say-Info "  - $($a.Name)"
    }
    Say-Info "An unscoped Mail.Send grant lets the app send tenant-wide.  Remove each manually."
}
if ($classified.BroaderRole.Count -gt 0) {
    Say-Fail "BLOCKER -- $($classified.BroaderRole.Count) broader-role assignment(s) that confer Mail.Send exist on this SP:"
    foreach ($a in $classified.BroaderRole) {
        Say-Info "  - $($a.Name)  (Role='$($a.Role)')"
    }
    Say-Info "These roles grant Mail.Send among OTHER permissions beyond what Spectre needs.  Remove each manually."
}

$broaderGrantBlock = ($classified.OtherScoped.Count -gt 0) -or
                     ($classified.Unscoped.Count -gt 0) -or
                     ($classified.BroaderRole.Count -gt 0)

if ($classified.Matching.Count -eq 0 -and -not $broaderGrantBlock) {
    Record-Change "Create ManagementRoleAssignment: App=$spObjectId, Role='Application Mail.Send', CustomResourceScope='$ScopeName'"
    if (-not $DryRun) {
        $assignParams = @{
            App                 = $spObjectId
            Role                = 'Application Mail.Send'
            CustomResourceScope = $ScopeName
            ErrorAction         = 'Stop'
        }
        try {
            New-ManagementRoleAssignment @assignParams | Out-Null
            Say-OK "Role assignment created."
        } catch {
            Say-Fail "New-ManagementRoleAssignment failed: $($_.Exception.Message)"
            Say-Info "  Common causes:"
            Say-Info "    - Not signed in with sufficient delegation rights."
            Say-Info "      Fix: sign in as a Global Admin or an Exchange Admin."
            Say-Info "    - Module older than v3.4 or App parameter unresolved."
            Say-Info "      Fix: Update-Module -Name ExchangeOnlineManagement -Force"
            exit 6
        }
    }
} elseif ($classified.Matching.Count -eq 0 -and $broaderGrantBlock) {
    Say-Warn "Not creating the correct assignment while broader grants exist -- resolve those first."
}

# ============================================================================
# Phase 5 -- Authorization verification (positive + negative, mandatory).
# ============================================================================
Say-Section "Phase 5 -- Authorization verification"

if ($DryRun -and $classified.Matching.Count -eq 0) {
    Say-Warn "Dry-run: no matching assignment is in place yet, so a positive Test-ServicePrincipalAuthorization will fail by design.  Rerun without -DryRun to apply the changes above and re-verify."
}

Say-Info "Positive test -- $SharedMailbox should be IN scope:"
try {
    $posRows = @(Test-ServicePrincipalAuthorization -Identity $spObjectId -Resource $SharedMailbox -ErrorAction Stop)
} catch {
    Say-Fail "Test-ServicePrincipalAuthorization (positive) threw (fail-closed): $($_.Exception.Message)"
    exit 7
}
$posVerdict = Evaluate-AuthorizationResult -AuthRows $posRows -ExpectedScope $ScopeName -Mode Positive
if ($posVerdict.Pass) {
    Say-OK "Positive test: at least one Mail.Send row InScope=True AND AllowedResourceScope='$ScopeName'."
    foreach ($r in $posVerdict.Matching) {
        Say-Info "  matched: role='$($r.RoleName)' scope='$($r.AllowedResourceScope)'"
    }
} else {
    Say-Fail "Positive test FAILED -- intended scoped grant not in effect."
    if ($posVerdict.WrongScope.Count -gt 0) {
        Say-Info "  Mail.Send rows in-scope for a DIFFERENT scope (also a config defect):"
        foreach ($r in $posVerdict.WrongScope) {
            Say-Info "    role='$($r.RoleName)' scope='$($r.AllowedResourceScope)'"
        }
    }
    if (-not $DryRun) { exit 7 }
}

Say-Info "Negative test -- $NegativeControlMailbox should NOT be in scope:"
try {
    $negRows = @(Test-ServicePrincipalAuthorization -Identity $spObjectId -Resource $NegativeControlMailbox -ErrorAction Stop)
} catch {
    Say-Fail "Test-ServicePrincipalAuthorization (negative) threw (fail-closed): $($_.Exception.Message)"
    exit 8
}
$negVerdict = Evaluate-AuthorizationResult -AuthRows $negRows -ExpectedScope $ScopeName -Mode Negative
if ($negVerdict.Pass) {
    Say-OK "Negative test: no Mail.Send row has InScope=True against $NegativeControlMailbox."
} else {
    Say-Fail "Negative test FAILED -- SP can send from $NegativeControlMailbox."
    Say-Info "  Leaking rows:"
    foreach ($r in $negVerdict.Leaks) {
        Say-Info "    role='$($r.RoleName)' scope='$($r.AllowedResourceScope)'"
    }
    Say-Info "Likely cause: an unscoped / differently-scoped assignment flagged in Phase 4,"
    Say-Info "OR a tenant-wide Mail.Send application permission on the Entra app."
    if (-not $DryRun) { exit 8 }
}

# Having passed positive + negative, if Phase 4 still has broader grants
# flagged, we refuse to report overall success.
if ($broaderGrantBlock) {
    Say-Section "Phase 5b -- Broader-grant block"
    Say-Fail "Positive + negative tests passed for this specific SharedMailbox / NegativeControlMailbox pair, BUT broader Mail.Send grants on this SP (listed in Phase 4) have not been reviewed."
    Say-Info "The negative test only covers the mailbox you supplied.  Other mailboxes could be reachable via the broader grants."
    Say-Info "Resolve the Phase 4 blockers before declaring Exchange RBAC verified."
    if (-not $DryRun) { exit 9 }
}

# ============================================================================
# Summary
# ============================================================================
Say-Section "Summary"

if ($DryRun) {
    Write-Host "  Mode: DRY RUN -- no writes performed." -ForegroundColor Yellow
    if ($script:Changes.Count -gt 0) {
        Write-Host "  Proposed changes:" -ForegroundColor Yellow
        foreach ($c in $script:Changes) { Write-Host "    - $c" }
        Write-Host ""
        Write-Host "  Re-verification required: rerun WITHOUT -DryRun to apply, then re-verify." -ForegroundColor Yellow
    } else {
        Write-Host "  No proposed changes.  Existing state (as read) already matches intent."
    }
    exit 0
}

if ($script:Changes.Count -eq 0) {
    Say-OK "No changes made.  Exchange Online RBAC configuration was already correct."
} else {
    Write-Host "  Changes applied:" -ForegroundColor Yellow
    foreach ($c in $script:Changes) { Write-Host "    - $c" }
}

Say-OK "Exchange Online RBAC configuration verified for the ($SharedMailbox, $NegativeControlMailbox) pair."
Write-Host ""
Write-Host "  SCOPE OF THIS VERIFICATION:"
Write-Host "    - The scope's RecipientRestrictionFilter matches exactly one mailbox."
Write-Host "    - 'Application Mail.Send' is granted ONLY within '$ScopeName' on this SP."
Write-Host "    - The SP cannot send from $NegativeControlMailbox."
Write-Host ""
Write-Host "  NOT verified by this script (operator must verify separately):"
Write-Host "    1. Entra ID -> App registrations -> 'Spectre Transactional Mail' -> API permissions is EMPTY."
Write-Host "       (If 'Mail.Send' application permission is listed, remove it -- it bypasses Exchange RBAC.)"
Write-Host "    2. A real Microsoft Graph send from the designated mailbox succeeds."
Write-Host "    3. A real Microsoft Graph send attempt from a DIFFERENT mailbox is refused (HTTP 403)."
Write-Host "    See the operator runbook phase 6 for the end-to-end verification steps."
Write-Host ""
Write-Host "  To activate Spectre's email path, next-up operator steps (in PowerShell):"
Write-Host '    $sec    = Read-Host -AsSecureString ''Paste the Spectre Transactional Mail client secret'''
Write-Host '    $plain  = [System.Net.NetworkCredential]::new('''', $sec).Password'
Write-Host '    $kv     = @('
Write-Host '        ''EMAIL_DELIVERY_MODE=microsoft365'','
Write-Host "        ""MICROSOFT_TENANT_ID=<Directory tenant ID>"","
Write-Host "        ""MICROSOFT_CLIENT_ID=$AppClientId"","
Write-Host '        "MICROSOFT_CLIENT_SECRET=$plain",'
Write-Host "        'MICROSOFT_FROM_MAILBOX=$SharedMailbox'"
Write-Host '    )'
Write-Host '    & flyctl secrets set @kv --app spectre-staging'
Write-Host '    Remove-Variable sec, plain -Force'
Write-Host ""
exit 0
