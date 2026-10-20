# Transactional Email — Operator Setup Guide

**Audience.** The founder, or any Spectre operator with Microsoft 365
Global Admin / Exchange Admin rights and `flyctl` access to the
Spectre Fly org.  Non-technical: every step is a copy-paste command
with an expected output.

**Revision.** v3 (2026-10-20).  SIGNUP-1G.  Supersedes v1 + v2.  Key
changes from v2: dedicated Entra application (no longer reusing the
SIGNUP-1 OAuth app); corrected Exchange Online RBAC-for-Applications
scoping syntax verified against Microsoft's current public
documentation at
[learn.microsoft.com/exchange/permissions-exo/application-rbac](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac).

**Goal.** Give Spectre's transactional email code the ability to send
mail **only** from one dedicated mailbox:
`no-reply@spectreautomation.com`.  Nothing else in the tenant.

**Hard constraints.**

- Do NOT grant tenant-wide `Mail.Send` application permission in
  Microsoft Entra ID.  That bypasses the scoping.
- Do NOT reuse the existing SIGNUP-1 OAuth app (`b7f855a6…`) or the
  existing mailbox-integration app for transactional sending.  A
  separate dedicated Entra app is required (SIGNUP-1G directive).
- Do NOT paste any credential (client secret, API key, etc.) into
  chat, tickets, Slack, screenshots, or any commit.

---

## Overview — six phases

1. **Phase 1 (Microsoft 365 admin UI)** — designate the sender mailbox.
2. **Phase 2 (Microsoft Entra admin UI)** — register the dedicated app.
3. **Phase 3 (Microsoft Entra admin UI)** — generate a client secret.
4. **Phase 4 (Exchange Online PowerShell)** — scope `Mail.Send` to the one mailbox.
5. **Phase 5 (operator workstation + `flyctl`)** — set Fly secrets.
6. **Phase 6 (any browser)** — verify.

Phases 1–3 are click-through in the Microsoft admin portals.  Phase 4
is one PowerShell session.  Phase 5 is one `flyctl` command.  Phase 6
is one URL + one email round-trip.

Total expected elapsed time: **~30 minutes**, mostly waiting for admin
consent to propagate.

---

## Phase 1 — Designate the sender mailbox

Microsoft 365 admin center → Teams & groups → Shared mailboxes →
**Add a shared mailbox**:

| Field | Value |
|---|---|
| Display name | `Spectre Automation` |
| Email address | `no-reply@spectreautomation.com` |
| Domain | the verified Spectre domain |

**Why a shared mailbox:** it needs no licence, costs nothing, and is
the right fit for a send-only sender identity.

After the mailbox exists, click into it → **Member delegation** →
leave Members empty (nobody needs delegate read access to no-reply).

**Verify (expected):** `no-reply@spectreautomation.com` shows in the
shared-mailboxes list.  Give the mailbox 2–3 minutes to provision
before Phase 4.

---

## Phase 2 — Register the dedicated Entra app

Microsoft Entra admin center → App registrations → **New registration**:

| Field | Value |
|---|---|
| Name | `Spectre Transactional Mail` |
| Supported account types | *Accounts in this organizational directory only (Single tenant)* |
| Redirect URI | leave blank (this app has no interactive sign-in) |

Click **Register**.  Capture (into a password manager — not chat):

- **Application (client) ID** — a GUID shown on the overview page.
- **Directory (tenant) ID** — also on the overview page.

Then, on the **API permissions** screen for this app: do **nothing**.
Leave this app with zero Microsoft Graph permissions in Entra.  The
grant lives in Exchange Online RBAC in Phase 4; granting it here as
well would widen the sender scope beyond the one mailbox and defeat
the point.

**Capture one more thing — the Enterprise Application Object ID.**
Microsoft Entra admin center → Enterprise applications → All
applications → search for `Spectre Transactional Mail` → open it →
copy the **Object ID**.  This is a **different GUID** from the App
Registration's Object ID.  Phase 4's `New-ServicePrincipal` needs it.

---

## Phase 3 — Generate a client secret

On the App Registration (not the Enterprise Application) →
**Certificates & secrets** → **New client secret**:

- Description: `Spectre Transactional Mail — <YYYY-MM-DD>`
- Expiry: 90 days.

Click **Add**.  **Record the "Value" column immediately** — Microsoft
never shows it again.  Store in Spectre's password manager with the
expiry date.  Set a 60-day reminder to rotate.

---

## Phase 4 — Scope `Mail.Send` to the one mailbox

Open PowerShell on an operator workstation.  Install the Exchange
Online module v3.4 or later if not already:

```powershell
Install-Module -Name ExchangeOnlineManagement -MinimumVersion 3.4.0 -Scope CurrentUser
```

Connect:

```powershell
Connect-ExchangeOnline
```

A browser window opens for admin sign-in; sign in as Global Admin or
Exchange Admin.

### 4a · Register the service principal in Exchange

```powershell
New-ServicePrincipal `
  -AppId "<Application (client) ID from Phase 2>" `
  -ObjectId "<Enterprise Application Object ID from Phase 2>" `
  -DisplayName "Spectre Transactional Mail"
```

**Expected output:**

```
DisplayName                   ObjectId                               AppId
-----------                   ---------                              -----
Spectre Transactional Mail    <enterprise-app-object-id>             <app-client-id>
```

### 4b · Create a management scope that targets only the one mailbox

```powershell
New-ManagementScope `
  -Name "Spectre No-Reply Only" `
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'no-reply@spectreautomation.com'"
```

**Expected output:**

```
Name                    ScopeRestrictionType    Exclusive    RecipientFilter
----                    --------------------    ---------    ---------------
Spectre No-Reply Only   RecipientScope          False        PrimarySmtpAddress -eq 'no-reply@spectreautomation.com'
```

### 4c · Grant Application Mail.Send scoped to that mailbox

```powershell
New-ManagementRoleAssignment `
  -App "<Enterprise Application Object ID from Phase 2>" `
  -Role "Application Mail.Send" `
  -CustomResourceScope "Spectre No-Reply Only"
```

**Expected output:**

```
Name                        Role                     RoleAssigneeName    RoleAssigneeType      AssignmentMethod
----                        ----                     ----------------    ----------------      ----------------
Application Mail.Send-...   Application Mail.Send    <object-id>         ServicePrincipal      Direct
```

### 4d · Verify — positive test

```powershell
Test-ServicePrincipalAuthorization `
  -Identity "<Enterprise Application Object ID from Phase 2>" `
  -Resource "no-reply@spectreautomation.com" `
  | Format-Table RoleName, AllowedResourceScope, InScope
```

**Expected output:**

```
RoleName                 AllowedResourceScope       InScope
--------                 --------------------       ------
Application Mail.Send    Spectre No-Reply Only      True
```

### 4e · Verify — negative test (critical)

Pick ANY other real mailbox in the tenant — e.g. the founder's
own mailbox or a shared mailbox like `support@…`.

```powershell
Test-ServicePrincipalAuthorization `
  -Identity "<Enterprise Application Object ID from Phase 2>" `
  -Resource "<any-OTHER-mailbox>@spectreautomation.com" `
  | Format-Table RoleName, AllowedResourceScope, InScope
```

**Expected output:**

```
RoleName                 AllowedResourceScope       InScope
--------                 --------------------       ------
Application Mail.Send    Spectre No-Reply Only      False
```

`InScope = False` is the **required** result for the negative test.
Anything else means the scope is wrong — stop and re-check 4b/4c.

---

## Phase 5 — Set Fly staging secrets

On the operator workstation with `flyctl` authenticated to the
Spectre Fly org:

```bash
flyctl secrets set \
  EMAIL_DELIVERY_MODE=microsoft365 \
  MICROSOFT_TENANT_ID=<Directory (tenant) ID from Phase 2> \
  MICROSOFT_CLIENT_ID=<Application (client) ID from Phase 2> \
  MICROSOFT_CLIENT_SECRET=<the secret VALUE from Phase 3> \
  MICROSOFT_FROM_MAILBOX=no-reply@spectreautomation.com \
  --app spectre-staging
```

Fly automatically restarts the `spectre-staging` web app on secret
change.  Expected downtime: < 30 seconds.

The `spectre-staging-worker` app does **not** send signup email,
so these secrets do not need to be set on the worker.

---

## Phase 6 — Verify end-to-end

### 6a · Confirm Spectre is now in Microsoft 365 mode

Open:

```
https://staging.spectreautomation.com/api/admin/signup/debug/status
```

Expected `email` section:

```json
{
  "email": {
    "mode": "microsoft365",
    "microsoft365Configured": true,
    "smtpConfigured": false,
    "sesConfigured": false,
    "fromAddress": "no-reply@spectreautomation.com",
    "effectiveAdapter": "microsoft365"
  }
}
```

If `effectiveAdapter` says `microsoft365_misconfigured_FALLBACK_FAILS`,
one of the four secrets did not land — re-run Phase 5.

### 6b · Trigger a real send

Walk a signup through the real UI
([https://staging.spectreautomation.com/signup](https://staging.spectreautomation.com/signup))
with a Microsoft work account whose primary email the operator
controls.  After completing the Microsoft sign-in step:

- An email arrives at that address within ~60 seconds.
- From: `Spectre Automation <no-reply@spectreautomation.com>`
- Subject: `Resume your Spectre registration`
- Body contains the single-use link `/signup/r/<token>` and the
  copy "This link is single-use and expires in 30 minutes".

### 6c · Verify the cross-device recovery

- Open the email in a different browser (not the one used to sign up).
- Click the link within 30 minutes.
- Lands on the status page for the same registration.
- Click the same link again from a third browser — expected error:
  "This recovery link has already been used."

### 6d · Confirm no sensitive data in logs

```bash
flyctl logs --app spectre-staging | grep -i "signup.resume_email.sent\|signup.recovery_link"
```

Expected: only masked emails + `linkIdTail` + `providerMessageId`
appear.  No raw token.  No full URL.

### 6e · Confirm existing Microsoft mailbox integrations still work

Sign in to `staging.spectreautomation.com` as a club admin with an
existing Microsoft mailbox integration.  Open the Work Intake inbox
view — expected: the integration continues to list emails and allow
delete / restore mutations.  The new Transactional Mail app is a
separate Entra identity; it does not affect the delegated mailbox
app (`b7f855a6…`) in any way.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `effectiveAdapter: microsoft365_misconfigured_FALLBACK_FAILS` | A Fly secret is unset or empty | Re-run Phase 5; `flyctl secrets list --app spectre-staging` to confirm the five keys are present. |
| Negative test `InScope = True` | Mail.Send was additionally granted tenant-wide in Entra, OR the management scope filter doesn't match the mailbox's PrimarySmtpAddress | Revoke the Entra grant (if any); re-check the filter in Phase 4b. |
| Email takes > 2 min to arrive | First-send cold path at Microsoft — common | Give it 5 min; recheck 6a; try again. |
| `Mail.Send` test positive but real send fails with 403 | Admin-consent cache (30 min – 2 h propagation per Microsoft docs) | Wait 30 min; retry.  The `Test-ServicePrincipalAuthorization` cmdlet bypasses the cache, so a positive test moments after Phase 4 does not guarantee a live token sees the grant yet. |
| Negative test cannot find the control mailbox | Mailbox doesn't exist in this tenant | Pick a known-good mailbox (the founder's primary email is a safe control). |

---

## What NOT to do (common mistakes)

- **Do not add `Mail.Send` as an application permission on the new
  app's API permissions page.**  That gives it tenant-wide send.
  Leave Entra API permissions empty.
- **Do not reuse the SIGNUP-1 OAuth app (`b7f855a6…`).**  That app
  carries delegated identity scopes used by Spectre's signup flow
  and by the per-club mailbox integration.  Mixing a scoped
  application permission into it would complicate the next secret
  rotation.
- **Do not use `-RecipientOrganizationalUnitScope` or
  `-RecipientRelativeWriteScope`** on `New-ManagementRoleAssignment`
  when the role is scoped to an application.  Those are USER-RBAC
  parameters.  The two valid Application-RBAC scope parameters are
  `-CustomResourceScope <ManagementScope>` and
  `-RecipientAdministrativeUnitScope <AU-ObjectId>`.  This runbook
  uses `-CustomResourceScope`.
- **Do not skip the negative test.**  If the only verification is
  the positive test (which the apex can also pass under broader
  grants), the scope misconfiguration will not surface until the
  app is sending from the wrong mailbox in production.
- **Do not commit the client secret** anywhere in the Spectre
  repo.  The secret appears in two places only: the Entra portal
  (once, at creation) and `flyctl secrets` (encrypted at rest).

---

## Promotion to production (future, not now)

Repeat Phases 1–6 against the production tenant and the
`spectre` Fly app.  Separate shared mailbox name is optional
(`no-reply@spectreautomation.com` may be shared across staging
and production), but a separate Entra app registration + separate
client secret are required.  Production promotion is **not**
authorised by SIGNUP-1G — the founder must explicitly approve the
production flip.

---

## Alternative providers (unchanged by SIGNUP-1G)

Microsoft 365 Graph with the scoped Entra app is Spectre's
preferred transactional sender.  The platform adapter chain in
[src/lib/integrations/email.ts](../src/lib/integrations/email.ts#L367)
also supports SMTP (`EMAIL_DELIVERY_MODE=smtp`) and AWS SES
(`EMAIL_DELIVERY_MODE=ses`).  Either can be set via Fly secrets as
an alternative, but neither is required for SIGNUP-1G acceptance.

---

## Reference links

- [Microsoft Learn — RBAC for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
- [Microsoft Learn — Install the Exchange Online PowerShell module](https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2)
- [Spectre code — platform email adapter chain](../src/lib/integrations/email.ts)
- [Spectre code — recovery-link service (30-min TTL)](../src/lib/signup/recovery-link.ts)
- [Spectre code — resume-email body](../src/lib/signup/resume-email.ts)
