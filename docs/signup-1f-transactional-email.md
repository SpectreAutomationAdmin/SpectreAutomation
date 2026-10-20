# SIGNUP-1F · Transactional Email — Operator Runbook (v2)

**Revision history.**  v2 (2026-10-20) updates the application-
permission scoping guidance to lead with **Microsoft RBAC for
Applications in Exchange Online**, Microsoft's current (GA since
2024) replacement for the older `New-ApplicationAccessPolicy`
pattern.  Application Access Policies still work but are on
Microsoft's retirement path; new deployments should prefer RBAC
for Applications.  Both options are documented below so the
operator can choose based on tenant capability.

**Scope.** This document is for an operator (Spectre engineer or
Microsoft 365 admin) who needs to turn on real transactional
email delivery for the SIGNUP-1 cross-device registration
recovery flow on `spectre-staging` and, later, production.

**Preferred provider.** Microsoft 365 Graph with a dedicated,
restricted sending identity.  SMTP and SES remain fully supported
alternatives in the platform adapter chain
([src/lib/integrations/email.ts](../src/lib/integrations/email.ts#L367))
and are documented at the bottom.

**Hard constraint — not negotiable.** The sending application
MUST be scoped so that `Mail.Send` is restricted to the single
designated Spectre transactional mailbox.  Tenant-wide
`Mail.Send` application permission without a scoping policy
would let the Spectre app send mail from any mailbox in the
tenant.  That is a founder-level violation of the SIGNUP-1F
directive and must not ship.

Two Microsoft-blessed ways to achieve this scoping; both are
acceptable; the first is preferred for new deployments.

---

## Scoping option A — RBAC for Applications in Exchange Online (preferred, 2026 default)

Microsoft RBAC for Applications is the modern, management-UI-
first way to grant an application permission to send mail
*only from specific mailboxes*.  It replaces the older
Application Access Policy mechanism and offers:

- A visible management surface in Exchange admin center.
- `Get-ManagementRoleAssignment -App` reporting that the
  operator can audit without PowerShell gymnastics.
- Finer-grained scoping (mail-enabled security group,
  distribution list, dynamic distribution group, or a
  management scope with recipient filters).
- No propagation-latency surprises (effective within a few
  minutes vs up to an hour for Application Access Policies).

### A.1 · Prerequisites

- The sending mailbox from Phase 1 of this runbook exists.
- The operator has Exchange Online Global Admin or Exchange
  Administrator role.
- Exchange Online PowerShell module v3.4+ is installed.

### A.2 · Create the mail-enabled security group

```powershell
Connect-ExchangeOnline

# Create a group whose membership defines the mailboxes the
# Spectre app can send from.  Membership is EXACTLY the one
# dedicated no-reply mailbox from Phase 1.
New-DistributionGroup `
  -Name "Spectre-Transactional-Senders" `
  -Alias "spectre-transactional-senders" `
  -Type "Security" `
  -PrimarySmtpAddress "spectre-transactional-senders@spectreautomation.com"

Add-DistributionGroupMember `
  -Identity "Spectre-Transactional-Senders" `
  -Member "no-reply@spectreautomation.com"
```

### A.3 · Register the Spectre app as a service principal in Exchange

```powershell
# The AppId is the client-id from Phase 2 of this doc.
New-ServicePrincipal `
  -AppId "<client-id>" `
  -ServiceId "<client-id>" `
  -DisplayName "Spectre Transactional Mail"
```

### A.4 · Scope Mail.Send via a management role assignment

```powershell
# Grant the service principal the "Application Mail.Send"
# role — but restricted to the security group as the
# recipient scope.  This replaces the Mail.Send Microsoft
# Graph application permission's tenant-wide default.
New-ManagementRoleAssignment `
  -App "<client-id>" `
  -Role "Application Mail.Send" `
  -RecipientRelativeWriteScope "MailboxGroup" `
  -RecipientOrganizationalUnitScope "Spectre-Transactional-Senders"
```

### A.5 · Verify (both directions)

```powershell
# Positive — must return the designated mailbox.
Test-ServicePrincipalAuthorization `
  -Identity "<client-id>" `
  -Resource "no-reply@spectreautomation.com"

# Negative — must return access denied for any OTHER mailbox.
Test-ServicePrincipalAuthorization `
  -Identity "<client-id>" `
  -Resource "<any-other-mailbox>@spectreautomation.com"
```

Expected:

- `no-reply@…` → authorised, `Mail.Send` role listed.
- any other mailbox → `No RBAC assignment found`.

### A.6 · Microsoft Graph application permission

The Entra app still needs the `Mail.Send` **application**
permission with admin consent (Phase 3a in option B below).
The RBAC role assignment is what scopes it; without the
Graph permission the Spectre app has no permission to assert.

---

## Scoping option B — Application Access Policy (legacy, use if RBAC isn't available in the tenant)

Application Access Policies are the older mechanism.  They
still work on all tenants but Microsoft has them on a
long-horizon retirement path (announcement date: 2024-H2;
no hard end-of-life date announced as of this writing).  Use
option A when possible; fall back to this option B only when:

- The tenant has not yet enrolled in RBAC for Applications
  (some older EXO plans).
- Operations prefers a single-step scoping path on the first
  tenant and will migrate to A later.

### B.1 · Add the application permission (same under both options)

In the Azure Portal → Entra ID → App registrations → the app
from Phase 2 → **API permissions**:

1. Click **Add a permission** → **Microsoft Graph** →
   **Application permissions**.
2. Search `Mail.Send`.  Tick it.  Add.
3. Click **Grant admin consent for &lt;tenant&gt;** (Global
   Admin or Privileged Role Admin).

### B.2 · Apply the Application Access Policy

```powershell
Connect-ExchangeOnline

# (If not already created in option A step A.2):
New-DistributionGroup `
  -Name "Spectre-Transactional-Senders" `
  -Alias "spectre-transactional-senders" `
  -Type "Security" `
  -PrimarySmtpAddress "spectre-transactional-senders@spectreautomation.com"

Add-DistributionGroupMember `
  -Identity "Spectre-Transactional-Senders" `
  -Member "no-reply@spectreautomation.com"

# Create the Application Access Policy restricting the Spectre
# app's Mail.Send to that group.
New-ApplicationAccessPolicy `
  -AppId "<client-id>" `
  -PolicyScopeGroupId "Spectre-Transactional-Senders" `
  -AccessRight RestrictAccess `
  -Description "Spectre transactional sender — Mail.Send limited to no-reply mailbox"

# Verify — Granted for the designated mailbox, Denied for any other.
Test-ApplicationAccessPolicy `
  -AppId "<client-id>" `
  -Identity "no-reply@spectreautomation.com"

Test-ApplicationAccessPolicy `
  -AppId "<client-id>" `
  -Identity "<any-other-mailbox>@spectreautomation.com"
```

Expected:

- `no-reply@…` → `AccessCheckResult: Granted`.
- any other mailbox → `AccessCheckResult: Denied`.

**Propagation.** Application Access Policy changes can take up
to one hour to apply.  Verify after propagation; do not
proceed to Phase 4 until the negative test confirms Denied.

---

## Phase 1 — Decide the sender mailbox

Create (or designate) a dedicated mailbox that will send
Spectre transactional email.

| Field | Suggested value | Notes |
|---|---|---|
| Display name | `Spectre Automation` | Visible to recipients |
| Primary SMTP address | `no-reply@spectreautomation.com` | Dedicated — no human reads it |
| Mailbox type | Shared mailbox (preferred) or standard | Shared mailbox doesn't need a licence; sends via Graph fine |
| Inbox rules | Auto-delete / forward replies to `support@spectreautomation.com` | Replies are not a supported channel |

**Why a dedicated mailbox:** limits blast radius if the Spectre
app credentials ever leak — the attacker can only impersonate
`no-reply@spectreautomation.com`, not every user in the tenant.

**Do not** piggy-back a `no-reply` alias on a human mailbox.
Both scoping mechanisms are per-mailbox, not per-alias.

---

## Phase 2 — Decide which Entra app to use

Two choices.  **A** is the Spectre preference (one tenant
identity, scope controlled by RBAC); **B** gives operational
isolation at the cost of inventory.

- **A — Reuse the existing OAuth app (`b7f855a6…`)** that
  already carries SIGNUP-1's identity-only delegated scopes.
  Add the `Mail.Send` **application** permission; scope it
  via option A or B above.  The two permission classes
  (delegated identity vs application Mail.Send) are
  independent at the token level — one does not expand the
  other.
- **B — Spawn a dedicated "Spectre Transactional Mail" app.**
  Separate client secret, zero delegated scopes, only
  `Mail.Send` application permission.  Easier secret rotation
  decoupled from OAuth sign-in.  Spectre's current preference
  is A.

Admin consent is required either way.

---

## Phase 3 — Issue a client secret

In the chosen Entra app → **Certificates & secrets** → **New
client secret**.

- Lifetime: 180 days or shorter (operations choice; Spectre
  convention is 90 days).
- Record the secret value **once**; Azure never displays it
  again.
- Note the expiry in the Spectre secret-rotation calendar.

---

## Phase 4 — Set Fly secrets on `spectre-staging`

Run from an operator workstation with `flyctl` authenticated
to the Spectre Fly org:

```bash
flyctl secrets set \
  EMAIL_DELIVERY_MODE=microsoft365 \
  MICROSOFT_TENANT_ID=<tenant-id-guid> \
  MICROSOFT_CLIENT_ID=<client-id-guid> \
  MICROSOFT_CLIENT_SECRET=<the-value-from-Phase-3> \
  MICROSOFT_FROM_MAILBOX=no-reply@spectreautomation.com \
  --app spectre-staging
```

Fly restarts the web app on secret change.  Repeat for
`spectre-staging-worker` only if the worker also sends mail —
SIGNUP-1 recovery emails are sent from the web process, so this
is **not** required for SIGNUP-1F closure.

**Do not** paste secret values into chat, into tickets, into
screenshots, or into any commit.  The secret appears in exactly
two places: the Entra portal (once) and `flyctl secrets`.  If a
secret has been pasted anywhere else, treat it as compromised
and rotate immediately.

---

## Phase 5 — Verify delivery

### 5a · The diagnostic endpoint

With `SPECTRE_ALLOW_STAGING_DEBUG=1` already set on the staging
app:

```bash
curl https://staging.spectreautomation.com/api/admin/signup/debug/status \
  | jq '.email'
```

Expected:

```json
{
  "mode": "microsoft365",
  "microsoft365Configured": true,
  "smtpConfigured": false,
  "sesConfigured": false,
  "fromAddress": "no-reply@spectreautomation.com",
  "effectiveAdapter": "microsoft365"
}
```

If `effectiveAdapter` is
`microsoft365_misconfigured_FALLBACK_FAILS`, one of the four
secrets is missing — re-check Phase 4.

### 5b · Smoke-test real delivery

Trigger a resume email by walking the real UI through the
Microsoft callback (SIGNUP-1 acceptance spec is the canonical
scenario), with the Microsoft identity's primary email directed
at a real inbox the operator controls.

Expected within 60 seconds:

- An email arrives at the Microsoft-verified address.
- Subject: `Resume your Spectre registration`.
- Body contains a single-use recovery link
  (`https://staging.spectreautomation.com/signup/r/<token>`).
- Body states "expires in 30 minutes".
- No raw token appears in Fly logs
  (`flyctl logs --app spectre-staging` for the window of the
  send) — only `providerMessageId` + masked address.

### 5c · Negative test — the scoping policy is doing its job

Temporarily point `MICROSOFT_FROM_MAILBOX` at a different (non-
scoped) mailbox in a one-off override, trigger a send, confirm
Microsoft Graph refuses with HTTP 403
(`ErrorAccessDenied: Access to OrganizationFromEmailAddresses
is denied`).  Reset to `no-reply@spectreautomation.com`
immediately after the test.

### 5d · Cross-browser recovery (30-minute window)

With real delivery live:

1. Start a fresh signup in browser A (incognito / clean profile).
2. Complete Screen 1 + Microsoft sign-in.
3. Confirm the resume email arrives in the real inbox.
4. Open the email in browser B (different vendor — Firefox if A
   was Chrome, Safari if A was Edge).
5. **Within 30 minutes**, click the recovery link.
6. Confirm:
   - Browser B lands on the status page for the SAME registration.
   - Browser B now has a fresh HTTPOnly resume cookie.
   - A second click of the same email link in browser C fails
     with the single-use error ("This recovery link has already
     been used").
   - If step 5 is deliberately deferred past 30 minutes, the
     click fails with the expired error AND
     `/signup/resume` renders the fresh-link request form.

If step 6 fails on single-use OR expiry, verify the deploy
includes the `SignupRecoveryLink` migration + the 30-min TTL
constant in [recovery-link.ts](../src/lib/signup/recovery-link.ts).

---

## Phase 6 — Promote to production (future)

Repeat Phases 1–5 against the production tenant and the
`spectre` Fly app.  Separate client secrets.  Separate scoping
assignments.  Production rollout is **not authorised by
SIGNUP-1F** — the founder must explicitly approve the production
flip.

---

## Alternative adapters (unchanged by SIGNUP-1F)

- **SMTP** — any provider.  Set `EMAIL_DELIVERY_MODE=smtp` +
  `SMTP_HOST` + `SMTP_PORT` + `SMTP_FROM` (+ `SMTP_USER` /
  `SMTP_PASS` / `SMTP_SECURE` as the provider requires).  No
  scoping concept.
- **AWS SES** — set `EMAIL_DELIVERY_MODE=ses` + `AWS_REGION` +
  `SES_FROM_ADDRESS` + `AWS_ACCESS_KEY_ID` +
  `AWS_SECRET_ACCESS_KEY`.  The `AWS_*` creds reuse the account
  that already backs KMS + S3; SES send permission must be
  granted to that IAM principal (`ses:SendEmail` +
  `ses:SendRawEmail`).  The verified identity must match
  `SES_FROM_ADDRESS`.

The microsoft365 path is preferred because it avoids a second
transactional-email vendor relationship.

---

## Outstanding operator steps summary (for the founder)

The code side is live on staging as of sha-c4dc138 and the
successor SHA from the SIGNUP-1F adjustment slice.  To activate
real email delivery:

1. **(ONE-TIME)** Phase 1 — create / designate the
   `no-reply@spectreautomation.com` mailbox.
2. **(ONE-TIME)** Phase 2 — choose Entra app (reuse `b7f855a6…`
   or spawn new).  Add the `Mail.Send` application permission
   with admin consent.
3. **(ONE-TIME)** Phase 3 — choose scoping option A (RBAC —
   preferred) or option B (Application Access Policy —
   legacy fallback).  Run the PowerShell for the chosen option.
   Verify positive + negative with the matching
   `Test-*` command.
4. **(ONE-TIME)** Phase 3 — issue a client secret.  Record it
   once; stage it in Spectre's secret-rotation calendar.
5. **(ONE-TIME)** Phase 4 — `flyctl secrets set` the five
   values on `spectre-staging`.
6. **(VERIFICATION)** Phase 5 — hit the diagnostic endpoint,
   send a smoke email, run the cross-browser 30-min window
   test.

None of these can be executed by Spectre code; all require the
operator to act in the Microsoft and Fly admin surfaces.  No
credential is requested here or elsewhere in the Spectre
pipeline.
