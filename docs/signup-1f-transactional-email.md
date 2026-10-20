# SIGNUP-1F · Transactional Email — Operator Runbook

**Scope.** This document is for an operator (Spectre engineer or
Microsoft 365 admin) who needs to turn on real transactional email
delivery for the SIGNUP-1 cross-device registration recovery flow
on `spectre-staging` and, later, production.

**Preferred provider.** Microsoft 365 Graph with a dedicated,
restricted sending identity.  SMTP and SES remain fully supported
alternatives in the platform adapter chain
([src/lib/integrations/email.ts](../src/lib/integrations/email.ts#L367))
and are documented at the bottom.

**Hard constraint — not negotiable.** The sending application MUST
be scoped by an Exchange Online **Application Access Policy** so
that the `Mail.Send` permission is restricted to the single
designated Spectre transactional mailbox.  Tenant-wide
`Mail.Send` application permission without an access policy would
let the Spectre app send mail from any mailbox in the tenant.
That is a founder-level violation of the SIGNUP-1F directive and
must not ship.

---

## Phase 1 — Decide the sender mailbox

Create (or designate) a dedicated mailbox that will send
Spectre transactional email.  Suggested identity:

| Field | Suggested value | Notes |
|---|---|---|
| Display name | `Spectre Automation` | What recipients see as the sender name |
| Primary SMTP address | `no-reply@spectreautomation.com` | Dedicated — no human reads it |
| Mailbox type | Shared mailbox (preferred) or standard | Shared mailbox doesn't need a licence; sends via Graph fine |
| Inbox rules | Auto-delete / forward replies to `support@spectreautomation.com` | Replies are an unused channel |

**Why a dedicated mailbox:** limits blast radius if the Spectre
app credentials ever leak — the attacker can only impersonate
`no-reply@spectreautomation.com`, not every user in the tenant.

**Do not use** a shared alias on a human mailbox (e.g.
`no-reply` on `founder@…`).  The access policy is per-mailbox,
not per-alias.

---

## Phase 2 — Decide which Entra app to use

Two choices.  Pick **A** on first setup; use **B** only if
operations prefers full isolation between the signup flow and the
transactional-email identity.

### Choice A — Reuse the existing OAuth app (`b7f855a6…`)

This app already carries delegated identity scopes
(`openid profile email offline_access`) for the SIGNUP-1 Microsoft
sign-in button and the mailbox-integration delegated flow.
Adding an **application** permission (`Mail.Send`) to it is
independent — the delegated scopes stay delegated; the application
permission is used only by the client-credentials flow in
[microsoft-graph.ts](../src/lib/integrations/microsoft-graph.ts).

Admin consent is still required for the application permission.

### Choice B — A separate "Spectre Transactional Mail" app

Create a second Entra app registration dedicated to transactional
email.  Zero delegated scopes.  Only the `Mail.Send` application
permission.  Separate client secret.

Trade-off: easier to rotate the mail-sending secret without
touching OAuth sign-in; more inventory to manage.

Spectre's current preference is **A** — the signup OAuth app and
the mail-sender app can safely be the same identity provided the
Application Access Policy scopes `Mail.Send` to the designated
mailbox.

---

## Phase 3 — Grant and scope `Mail.Send`

### 3a · Add the application permission

In the Azure Portal → Entra ID → App registrations → the app from
Phase 2 → **API permissions**:

1. Click **Add a permission** → **Microsoft Graph** → **Application permissions**.
2. Search `Mail.Send`.  Tick it.  Add.
3. Click **Grant admin consent for &lt;tenant&gt;** (Global Admin or
   Privileged Role Admin).

### 3b · Apply the Application Access Policy

**This is the non-negotiable step.**  Without it, `Mail.Send`
is tenant-wide.

Open PowerShell with the Exchange Online module (`Connect-ExchangeOnline`).
Then run:

```powershell
# 1. Create a mail-enabled security group whose membership defines
#    which mailboxes the Spectre app can send from.  Membership is
#    exactly the one dedicated mailbox from Phase 1.
New-DistributionGroup `
  -Name "Spectre-Transactional-Senders" `
  -Alias "spectre-transactional-senders" `
  -Type "Security" `
  -PrimarySmtpAddress "spectre-transactional-senders@spectreautomation.com"

Add-DistributionGroupMember `
  -Identity "Spectre-Transactional-Senders" `
  -Member "no-reply@spectreautomation.com"

# 2. Create the Application Access Policy restricting the Spectre
#    app's Mail.Send to that group.  The AppId is the client-id from
#    Phase 2 (the b7f855a6-… one if you chose Choice A).
New-ApplicationAccessPolicy `
  -AppId "<client-id>" `
  -PolicyScopeGroupId "Spectre-Transactional-Senders" `
  -AccessRight RestrictAccess `
  -Description "Spectre transactional sender — Mail.Send limited to no-reply mailbox"

# 3. Verify the policy applied.  "Granted" must appear for the
#    designated mailbox, "Denied" for a random control mailbox.
Test-ApplicationAccessPolicy `
  -AppId "<client-id>" `
  -Identity "no-reply@spectreautomation.com"

Test-ApplicationAccessPolicy `
  -AppId "<client-id>" `
  -Identity "<any-other-mailbox>@spectreautomation.com"
```

**Expected output:**

- `no-reply@…` → `AccessCheckResult: Granted`
- any other mailbox → `AccessCheckResult: Denied`

Policy propagation can take up to one hour.  If `Granted` appears
for mailboxes outside the group, the policy has not taken effect
yet — do not proceed to Phase 4.

### 3c · Issue a client secret

In the same Entra app → **Certificates & secrets** → **New client
secret**.

- Lifetime: 180 days or shorter (choose by operations policy; the
  Spectre playbook assumes 90 days).
- Record the secret value **once** — Azure never shows it again.
- Note the expiry date in the Spectre secrets rotation calendar
  (see `docs/reference/secret-rotation.md` if present).

---

## Phase 4 — Set Fly secrets on `spectre-staging`

Running on an operator workstation with `flyctl` authenticated
to the Spectre Fly org:

```bash
flyctl secrets set \
  EMAIL_DELIVERY_MODE=microsoft365 \
  MICROSOFT_TENANT_ID=<tenant-id-guid> \
  MICROSOFT_CLIENT_ID=<client-id-guid> \
  MICROSOFT_CLIENT_SECRET=<the-value-from-3c> \
  MICROSOFT_FROM_MAILBOX=no-reply@spectreautomation.com \
  --app spectre-staging
```

Fly restarts the web app on secret change.  Repeat for
`spectre-staging-worker` only if the worker also sends mail —
SIGNUP-1 recovery emails are sent from the web process, so this
step is **not** required for SIGNUP-1F closure.

**Do not** paste secret values into chat, into tickets, into
screenshots, or into any commit.  The secret appears in exactly
two places: the Entra portal (once) and `flyctl secrets`.  If a
secret has been pasted anywhere else, treat it as compromised and
rotate immediately.

---

## Phase 5 — Verify

### 5a · The diagnostic endpoint

With `SPECTRE_ALLOW_STAGING_DEBUG=1` already set on the staging app:

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

If `effectiveAdapter` is `microsoft365_misconfigured_FALLBACK_FAILS`,
one of the four secrets is missing — re-check Phase 4.

### 5b · Smoke-test real delivery

Trigger a resume email by walking the real UI through the Microsoft
callback (SIGNUP-1 acceptance spec is the canonical scenario), with
the Microsoft identity's primary email directed at a real inbox the
operator controls.

Expected within 60 seconds:

- An email arrives at the Microsoft-verified address.
- Subject: `Resume your Spectre registration`
- Body contains a single-use recovery link
  (`https://staging.spectreautomation.com/signup/r/<token>`).
- No raw token appears in Fly logs (`flyctl logs --app spectre-staging`
  for the window of the send) — only `providerMessageId` + masked
  address.

### 5c · Negative test — the access policy is doing its job

The adapter is wired to `MICROSOFT_FROM_MAILBOX`, so changing
only `MICROSOFT_FROM_MAILBOX` to a different (non-group) mailbox
in a temporary override must fail with HTTP 403 from Microsoft
Graph (`ErrorAccessDenied: Access to OrganizationFromEmailAddresses
is denied`).  This proves the Application Access Policy is the
real gate, not just the adapter's choice.

Do **not** perform this test on staging without an immediate
reset — leave the live config pointing at
`no-reply@spectreautomation.com` as soon as the negative test
confirms policy enforcement.

### 5d · Cross-browser recovery

With real delivery live:

1. Start a fresh signup in browser A (incognito / clean profile).
2. Complete Screen 1 + Microsoft sign-in.
3. Confirm the resume email arrives in the real inbox.
4. Open the email in browser B (different vendor — Firefox if A
   was Chrome, Safari if A was Edge).
5. Click the recovery link.
6. Confirm:
   - Browser B lands on the status page for the SAME registration.
   - Browser B now has a fresh resume cookie (its own session).
   - Browser A still works (its cookie is independent).
   - A second click of the same email link in browser C fails with
     the single-use error ("This recovery link has already been
     used").

If step 6 fails on single-use, verify the deploy includes the
`SignupRecoveryLink` migration and `src/lib/signup/recovery-link.ts`.

---

## Phase 6 — Promote to production (future)

Repeat Phases 1–5 against the production tenant and
`spectre` Fly app.  Separate mailbox
(`no-reply@spectreautomation.com` can be shared across staging
and prod with the understanding that both will send real-looking
mail — alternatively use `no-reply-staging@…` and `no-reply@…`
for isolation).  Separate client secrets.  Separate access
policies.

Production rollout is **not authorised by SIGNUP-1F** — the
founder must explicitly approve the production flip.

---

## Alternative adapters (unchanged by SIGNUP-1F)

- **SMTP** — any provider.  Set `EMAIL_DELIVERY_MODE=smtp` +
  `SMTP_HOST` + `SMTP_PORT` + `SMTP_FROM` (+ `SMTP_USER` / `SMTP_PASS`
  / `SMTP_SECURE` as the provider requires).  No access policy
  concept.
- **AWS SES** — set `EMAIL_DELIVERY_MODE=ses` + `AWS_REGION` +
  `SES_FROM_ADDRESS` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`.
  The `AWS_*` creds reuse the account that already backs KMS + S3;
  SES send permission must be granted to that IAM principal
  (`ses:SendEmail` + `ses:SendRawEmail`).  The verified identity
  must match `SES_FROM_ADDRESS`.

The microsoft365 path is preferred because it avoids introducing
a second transactional-email vendor relationship.
