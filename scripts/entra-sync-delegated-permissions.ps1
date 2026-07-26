#Requires -Version 5.1
<#
.SYNOPSIS
    Sync the delegated Microsoft Graph permissions on the Spectre
    "Spectre Automation — Delegated Mailbox" App Registration to match
    the checked-in source-of-truth docs/entra-required-delegated-
    permissions.md. Optionally grant tenant admin consent.

.DESCRIPTION
    Sprint 2 Checkpoint 14C-B (2026-07-23) — replaces the previous
    "click through the portal" onboarding step. Portal edits are
    forbidden going forward:

      * this script parses the required-permissions table from the
        source-of-truth doc,
      * validates it against APPROVED_DELEGATED_SCOPES in the code,
      * builds the exact requiredResourceAccess payload,
      * PATCHes the App Registration via Microsoft Graph
        (POST-to-application via `az rest`),
      * optionally grants tenant admin consent by asserting the
        oAuth2PermissionGrant on the Spectre service principal.

    Never writes secret values. Never echoes tokens to shell history.
    Uses the token acquired by `az login`; assumes the caller has
    the Application Administrator (or Global Administrator) role
    in the target tenant.

.PARAMETER TenantId
    The tenant id under which the App Registration lives (or the
    customer tenant for -GrantAdminConsent-only runs).

.PARAMETER ClientId
    The Application (client) ID of the Spectre App Registration.

.PARAMETER GrantAdminConsent
    When set, ALSO ensures the tenant has admin consent for every
    approved delegated scope. Idempotent — reruns produce no drift.

.PARAMETER WhatIf
    Read-only mode. Prints the diff between current and desired
    permission list without applying anything.

.EXAMPLE
    az login --tenant <SPECTRE_TENANT_ID>
    ./scripts/entra-sync-delegated-permissions.ps1 `
        -TenantId <SPECTRE_TENANT_ID> `
        -ClientId <SPECTRE_APP_CLIENT_ID> `
        -WhatIf

.EXAMPLE
    ./scripts/entra-sync-delegated-permissions.ps1 `
        -TenantId <SPECTRE_TENANT_ID> `
        -ClientId <SPECTRE_APP_CLIENT_ID> `
        -GrantAdminConsent
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param (
    [Parameter(Mandatory = $true)][string]$TenantId,
    [Parameter(Mandatory = $true)][string]$ClientId,
    [switch]$GrantAdminConsent
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# 1. Locate the repo + read the two authoritative surfaces
# ---------------------------------------------------------------------------

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot   = Resolve-Path (Join-Path $scriptDir "..") | Select-Object -ExpandProperty Path

$docPath    = Join-Path $repoRoot "docs\entra-required-delegated-permissions.md"
$codePath   = Join-Path $repoRoot "src\lib\integrations\microsoft-graph-delegated.ts"

if (-not (Test-Path $docPath))  { throw "Missing source-of-truth doc: $docPath" }
if (-not (Test-Path $codePath)) { throw "Missing scope code:         $codePath" }

# Microsoft Graph well-known resource id (identity of the target API
# in every Entra tenant). Do not change.
$graphResourceId = "00000003-0000-0000-c000-000000000000"

# ---------------------------------------------------------------------------
# 2. Parse the required scope table from the source-of-truth doc.
#    The table shape is:
#      | `openid` | `37f7f235-...` | Scope | B2 |
# ---------------------------------------------------------------------------

$docLines = Get-Content $docPath
$rowRegex = '^\|\s*`([A-Za-z._]+)`\s*\|\s*`([0-9a-fA-F-]{36})`\s*\|\s*Scope\s*\|'
$desiredScopes = @()
foreach ($line in $docLines) {
    if ($line -match $rowRegex) {
        $desiredScopes += [pscustomobject]@{
            Name = $matches[1]
            Id   = $matches[2].ToLower()
        }
    }
}
if ($desiredScopes.Count -eq 0) {
    throw "Could not parse any scope rows from $docPath. The table format has changed."
}

# ---------------------------------------------------------------------------
# 3. Parse APPROVED_DELEGATED_SCOPES from the code and enforce equality
# ---------------------------------------------------------------------------

$codeText = Get-Content $codePath -Raw
$scopeArrayMatch = [regex]::Match(
    $codeText,
    'export const APPROVED_DELEGATED_SCOPES = \[(?<body>[\s\S]*?)\] as const;'
)
if (-not $scopeArrayMatch.Success) {
    throw "Could not locate APPROVED_DELEGATED_SCOPES in $codePath."
}
$codeScopes = @()
foreach ($m in [regex]::Matches($scopeArrayMatch.Groups['body'].Value, '"([A-Za-z._]+)"')) {
    $codeScopes += $m.Groups[1].Value
}

$docSet  = $desiredScopes.Name  | Sort-Object
$codeSet = $codeScopes           | Sort-Object
$docJson  = ($docSet  -join ",")
$codeJson = ($codeSet -join ",")
if ($docJson -ne $codeJson) {
    Write-Error "MISMATCH between source-of-truth doc and code."
    Write-Error "  doc  : $docJson"
    Write-Error "  code : $codeJson"
    Write-Error "Fix one so they match, then rerun."
    exit 3
}
Write-Host "[ok] Source-of-truth doc and code agree on scopes: $($docSet -join ', ')"

# ---------------------------------------------------------------------------
# 4. Locate the App Registration by Application (client) ID
# ---------------------------------------------------------------------------

try {
    $azToken = az account get-access-token --resource-type ms-graph 2>$null | ConvertFrom-Json
    if (-not $azToken) { throw "az account get-access-token returned nothing." }
} catch {
    Write-Error "Azure CLI is not signed in. Run: az login --tenant $TenantId"
    exit 4
}
Write-Host "[ok] Azure CLI signed in; tenant token acquired."

$filter = "appId eq '$ClientId'"
$appLookup = az rest --method GET `
    --uri "https://graph.microsoft.com/v1.0/applications?`$filter=$filter&`$select=id,appId,displayName,requiredResourceAccess" `
    2>$null | ConvertFrom-Json
if (-not $appLookup.value -or $appLookup.value.Count -eq 0) {
    Write-Error "No App Registration found for client id $ClientId in tenant $TenantId."
    Write-Error "Confirm the ClientId is correct and az is signed in to the right tenant."
    exit 5
}
$app          = $appLookup.value[0]
$appObjectId  = $app.id
$appDisplay   = $app.displayName
Write-Host "[ok] App Registration: '$appDisplay' (objectId $appObjectId)"

# ---------------------------------------------------------------------------
# 5. Compute the current-vs-desired diff for the Microsoft Graph resource
# ---------------------------------------------------------------------------

$currentGraphAccess = @()
$otherResourceAccess = @()
foreach ($rra in @($app.requiredResourceAccess)) {
    if (-not $rra) { continue }
    if ($rra.resourceAppId -eq $graphResourceId) {
        foreach ($ra in $rra.resourceAccess) {
            if ($ra.type -eq "Scope") {
                $currentGraphAccess += ,@{ id = $ra.id.ToLower(); type = "Scope" }
            }
        }
    } else {
        $otherResourceAccess += $rra
    }
}
$currentIds = ($currentGraphAccess | ForEach-Object { $_.id } | Sort-Object) -join ","
$desiredIds = ($desiredScopes.Id | Sort-Object) -join ","

Write-Host ""
Write-Host "Desired delegated scope ids:"
foreach ($s in $desiredScopes) { Write-Host ("  " + $s.Name.PadRight(16) + $s.Id) }
Write-Host ""
Write-Host "Currently on the App Registration (Microsoft Graph only):"
if ($currentGraphAccess.Count -eq 0) {
    Write-Host "  (none)"
} else {
    foreach ($c in $currentGraphAccess) { Write-Host "  $($c.id)" }
}
Write-Host ""

if ($currentIds -eq $desiredIds) {
    Write-Host "[ok] App Registration already matches the source of truth. Nothing to change."
} elseif ($WhatIfPreference) {
    Write-Host "[whatif] Would PATCH https://graph.microsoft.com/v1.0/applications/$appObjectId"
    Write-Host "[whatif] Would set delegated permissions to:"
    foreach ($s in $desiredScopes) { Write-Host "  $($s.Name) ($($s.Id))" }
} else {
    # Build the merge — replace the Microsoft Graph resourceAccess
    # entry, preserve any other resource access entries.
    $graphResourceAccess = @{
        resourceAppId = $graphResourceId
        resourceAccess = @($desiredScopes | ForEach-Object {
            @{ id = $_.Id; type = "Scope" }
        })
    }
    $mergedRequiredResourceAccess = @($otherResourceAccess) + @($graphResourceAccess)
    $payload = @{
        requiredResourceAccess = $mergedRequiredResourceAccess
    } | ConvertTo-Json -Depth 6

    Write-Host "Applying PATCH to App Registration..."
    $payload | az rest --method PATCH `
        --uri "https://graph.microsoft.com/v1.0/applications/$appObjectId" `
        --headers "Content-Type=application/json" `
        --body "@-" | Out-Null
    Write-Host "[ok] App Registration updated."
}

# ---------------------------------------------------------------------------
# 6. Optionally grant admin consent for the target tenant
# ---------------------------------------------------------------------------

if (-not $GrantAdminConsent) {
    Write-Host ""
    Write-Host "Admin consent step SKIPPED. Rerun with -GrantAdminConsent to grant admin consent for tenant $TenantId."
    exit 0
}

Write-Host ""
Write-Host "Granting admin consent for tenant $TenantId..."

# The service principal is the app's tenant-local shadow. If the app
# has never been consented in this tenant, we need to create the SP.
$spLookup = az rest --method GET `
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '$ClientId'&`$select=id,appId" `
    2>$null | ConvertFrom-Json
if (-not $spLookup.value -or $spLookup.value.Count -eq 0) {
    Write-Host "Creating tenant-local service principal..."
    $spCreatePayload = @{ appId = $ClientId } | ConvertTo-Json
    $spCreatePayload | az rest --method POST `
        --uri "https://graph.microsoft.com/v1.0/servicePrincipals" `
        --headers "Content-Type=application/json" `
        --body "@-" | Out-Null
    Start-Sleep -Seconds 3
    $spLookup = az rest --method GET `
        --uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '$ClientId'&`$select=id,appId" `
        2>$null | ConvertFrom-Json
}
if (-not $spLookup.value -or $spLookup.value.Count -eq 0) {
    Write-Error "Service principal for $ClientId still missing after create."
    exit 6
}
$clientSpObjectId = $spLookup.value[0].id

# Microsoft Graph service principal (identity of the resource we're
# granting consent to) in this tenant.
$graphSp = az rest --method GET `
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '$graphResourceId'&`$select=id,appId" `
    2>$null | ConvertFrom-Json
if (-not $graphSp.value -or $graphSp.value.Count -eq 0) {
    Write-Error "Microsoft Graph service principal not present in tenant $TenantId. That should never happen."
    exit 7
}
$graphSpObjectId = $graphSp.value[0].id

# Grant AllPrincipals delegated consent via an oAuth2PermissionGrant.
# Idempotent: if a grant already exists for (clientId, resourceId,
# AllPrincipals), we PATCH it to widen `scope`; else we create a new
# one. `scope` is a SPACE-separated list of scope names.
$scopeString = ($desiredScopes.Name -join " ")
$existingGrantsUri = "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?`$filter=clientId eq '$clientSpObjectId' and consentType eq 'AllPrincipals' and resourceId eq '$graphSpObjectId'"
$existingGrants = az rest --method GET --uri $existingGrantsUri 2>$null | ConvertFrom-Json
if ($existingGrants.value -and $existingGrants.value.Count -gt 0) {
    $existing = $existingGrants.value[0]
    if ($existing.scope -eq $scopeString) {
        Write-Host "[ok] Existing tenant-wide consent grant already covers every approved scope. Nothing to do."
    } else {
        $patchPayload = @{ scope = $scopeString } | ConvertTo-Json
        $patchPayload | az rest --method PATCH `
            --uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants/$($existing.id)" `
            --headers "Content-Type=application/json" `
            --body "@-" | Out-Null
        Write-Host "[ok] Updated existing consent grant to include: $scopeString"
    }
} else {
    $newGrant = @{
        clientId    = $clientSpObjectId
        consentType = "AllPrincipals"
        resourceId  = $graphSpObjectId
        scope       = $scopeString
    } | ConvertTo-Json
    $newGrant | az rest --method POST `
        --uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants" `
        --headers "Content-Type=application/json" `
        --body "@-" | Out-Null
    Write-Host "[ok] Created tenant-wide consent grant for: $scopeString"
}

Write-Host ""
Write-Host "Done. Next: any user who consented under the OLD scope list must reconnect their mailbox before Spectre will use the newly-approved scopes for their account."
