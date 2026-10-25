<#
.SYNOPSIS
    SIGNUP-1G Phase C step 1 -- Read-only audit of the dedicated
    Spectre Transactional Mail Entra app's API permissions.

.DESCRIPTION
    Verifies that the Entra app whose Application (client) ID is
    passed in -AppClientId has:

      (a) Zero application permissions granted on Microsoft Graph
          that confer tenant-wide Mail.Send (or any superset).  A
          Mail.Send application permission granted in Entra would
          silently bypass the Exchange Online RBAC scope and let
          the app send from any mailbox in the tenant.
      (b) Zero delegated OAuth2 grants on Microsoft Graph that
          confer Mail.Send-equivalent scopes.  Delegated grants
          don't apply to client-credentials sends (the dedicated
          Transactional Mail app doesn't use them), but a Mail.Send
          delegated grant on this app would still signal that
          something else drifted and warrants investigation.

    Read-only.  Writes nothing.  Takes no secret.

.PARAMETER AppClientId
    REQUIRED.  Entra app's Application (client) ID (GUID).

.PARAMETER AllowDelegatedMailSend
    OPTIONAL.  If set, delegated Mail.Send-equivalent grants do
    NOT cause the audit to fail.  Application-permission grants
    still fail the audit even with this flag set.  Defaults off.

.NOTES
    PREREQUISITES:
      - PowerShell 7+ recommended.
      - Microsoft.Graph.Applications module.
      - Connect-MgGraph with at least Application.Read.All scope.

    EXIT CODES:
      0  - Audit passed.  No application-permission Mail.Send grants.
      2  - Preflight failure (module missing, auth failed, SP not found).
      3  - Application-permission Mail.Send grant found (BLOCKER).
      4  - Delegated Mail.Send grant found AND -AllowDelegatedMailSend
           is not set.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$AppClientId,

    [Parameter(Mandatory = $false)]
    [switch]$AllowDelegatedMailSend
)

$ErrorActionPreference = 'Stop'

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

# The dangerous permissions this audit refuses to see on the app.
# Any application-permission grant of these values is a blocker.
# (Mail.ReadWrite + Mail.Send are the common bundles that confer
# tenant-wide send; Full Access roles confer more.)
$BlockingAppPermissions = @(
    'Mail.Send',
    'Mail.ReadWrite',          # confers Mail.Send on some tenants via the Mail Full Access role
    'SMTP.SendAsApp',
    'Mail.Send.Shared',
    'Mail.ReadWrite.Shared'
)

Say-Section "Phase 0 -- Preflight"

if (-not (Get-Module -ListAvailable Microsoft.Graph.Applications)) {
    Say-Fail "Microsoft.Graph.Applications module is not installed."
    Say-Info "Install with:  Install-Module Microsoft.Graph.Applications -Scope CurrentUser"
    exit 2
}
Import-Module Microsoft.Graph.Applications -ErrorAction Stop
Import-Module Microsoft.Graph.Authentication -ErrorAction Stop

$ctx = $null
try {
    $ctx = Get-MgContext
} catch { $ctx = $null }

if (-not $ctx) {
    Say-Info "No active Microsoft Graph session.  Running Connect-MgGraph -Scopes Application.Read.All ..."
    try {
        Connect-MgGraph -Scopes 'Application.Read.All' -ErrorAction Stop | Out-Null
    } catch {
        Say-Fail "Connect-MgGraph failed: $($_.Exception.Message)"
        exit 2
    }
    $ctx = Get-MgContext
}
Say-OK "Connected to Microsoft Graph (account: $($ctx.Account))"

Say-Section "Phase 1 -- Resolve Service Principal by AppId"

$sp = $null
try {
    $sp = Get-MgServicePrincipal -Filter "appId eq '$AppClientId'" -ErrorAction Stop
    if ($sp -is [array]) { $sp = $sp[0] }
} catch {
    Say-Fail "Could not find a service principal for AppId '$AppClientId': $($_.Exception.Message)"
    exit 2
}
if (-not $sp) {
    Say-Fail "No service principal exists in this tenant for AppId '$AppClientId'."
    Say-Info "This usually means the Entra app registration is in a different tenant."
    exit 2
}
Say-OK "Service principal:"
Say-Info "  DisplayName : $($sp.DisplayName)"
Say-Info "  AppId       : $($sp.AppId)"
Say-Info "  Id          : $($sp.Id)"

Say-Section "Phase 2 -- Application-permission grants on Microsoft Graph"

# Microsoft Graph's well-known service principal AppId.
$graphAppId = '00000003-0000-0000-c000-000000000000'
$graphSp = $null
try {
    $graphSp = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'" -ErrorAction Stop
    if ($graphSp -is [array]) { $graphSp = $graphSp[0] }
} catch {}
if (-not $graphSp) {
    Say-Fail "Could not resolve the Microsoft Graph service principal (fail-closed)."
    exit 2
}

# App-role assignments to this SP for the Microsoft Graph resource.
$appRoleAssignments = @()
try {
    $appRoleAssignments = @(
        Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -ErrorAction Stop |
            Where-Object { $_.ResourceId -eq $graphSp.Id }
    )
} catch {
    Say-Fail "Get-MgServicePrincipalAppRoleAssignment failed (fail-closed): $($_.Exception.Message)"
    exit 2
}

Say-Info "Found $($appRoleAssignments.Count) application-permission grant(s) on Microsoft Graph for this SP."

$roleIndex = @{}
foreach ($role in $graphSp.AppRoles) {
    $roleIndex[$role.Id] = $role.Value
}

$blockedFindings = @()
if ($appRoleAssignments.Count -eq 0) {
    Say-OK "No application-permission grants on Microsoft Graph.  (Pass.)"
} else {
    foreach ($a in $appRoleAssignments) {
        $permissionValue = $roleIndex[$a.AppRoleId]
        if (-not $permissionValue) { $permissionValue = "unknown (AppRoleId=$($a.AppRoleId))" }
        if ($BlockingAppPermissions -contains $permissionValue) {
            Say-Fail "  BLOCKER: $permissionValue  (grant id: $($a.Id))"
            $blockedFindings += [pscustomobject]@{ Permission = $permissionValue; Id = $a.Id }
        } else {
            Say-Warn "  Granted (non-blocking for this audit): $permissionValue"
        }
    }
}

Say-Section "Phase 3 -- Delegated OAuth2 grants on Microsoft Graph"

$oauth2Grants = @()
try {
    $oauth2Grants = @(
        Get-MgOauth2PermissionGrant -Filter "clientId eq '$($sp.Id)'" -ErrorAction Stop |
            Where-Object { $_.ResourceId -eq $graphSp.Id }
    )
} catch {
    Say-Warn "Get-MgOauth2PermissionGrant query failed; attempting a fallback: $($_.Exception.Message)"
    try {
        $oauth2Grants = @(
            Get-MgOauth2PermissionGrant -All -ErrorAction Stop |
                Where-Object { $_.ClientId -eq $sp.Id -and $_.ResourceId -eq $graphSp.Id }
        )
    } catch {
        Say-Fail "Fallback Get-MgOauth2PermissionGrant also failed (fail-closed): $($_.Exception.Message)"
        exit 2
    }
}

Say-Info "Found $($oauth2Grants.Count) delegated OAuth2 grant(s) on Microsoft Graph for this SP."

$delegatedMailSendFindings = @()
foreach ($g in $oauth2Grants) {
    $scopes = @(($g.Scope -split '\s+') | Where-Object { $_ })
    foreach ($s in $scopes) {
        if ($BlockingAppPermissions -contains $s) {
            Say-Fail "  Delegated $s  (consent: $($g.ConsentType), grant id: $($g.Id))"
            $delegatedMailSendFindings += [pscustomobject]@{ Scope = $s; GrantId = $g.Id }
        } else {
            Say-Info "  Delegated non-mail-send scope: $s"
        }
    }
}
if ($oauth2Grants.Count -eq 0) {
    Say-OK "No delegated OAuth2 grants.  (Expected for the Transactional Mail app.)"
}

Say-Section "Phase 4 -- Verdict"

$exitCode = 0

if ($blockedFindings.Count -gt 0) {
    Say-Fail "BLOCKER: $($blockedFindings.Count) application-permission grant(s) that bypass Exchange RBAC:"
    foreach ($f in $blockedFindings) {
        Say-Info "  - $($f.Permission)  (remove via: Remove-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $($sp.Id) -AppRoleAssignmentId $($f.Id))"
    }
    $exitCode = 3
}

if ($delegatedMailSendFindings.Count -gt 0) {
    if ($AllowDelegatedMailSend) {
        Say-Warn "$($delegatedMailSendFindings.Count) delegated Mail.Send-equivalent grant(s) exist; -AllowDelegatedMailSend was passed so this is not a blocker."
    } else {
        Say-Fail "Delegated Mail.Send-equivalent grant(s) exist on this app:"
        foreach ($f in $delegatedMailSendFindings) {
            Say-Info "  - delegated $($f.Scope)  (grant id: $($f.GrantId))"
        }
        Say-Info "Delegated grants are not used by the Transactional Mail client-credentials flow, but presence of a Mail.Send delegated grant on THIS app signals drift and warrants investigation."
        Say-Info "Pass -AllowDelegatedMailSend to override after review."
        if ($exitCode -eq 0) { $exitCode = 4 }
    }
}

if ($exitCode -eq 0) {
    Say-OK "Entra API permissions audit PASSED."
    Say-Info ""
    Say-Info "The dedicated Transactional Mail app has NO application-permission Mail.Send"
    Say-Info "grant on Microsoft Graph.  Exchange Online RBAC remains the sole gate."
    Say-Info "Proceed with the live Graph send tests next."
}

exit $exitCode
