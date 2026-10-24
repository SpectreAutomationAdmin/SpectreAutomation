# Transactional Email — Operator Setup Guide (v4)

**Audience.** The founder, or any Spectre operator with Microsoft 365
Global Admin / Exchange Admin rights and `flyctl` access to the
Spectre Fly org.

**Revision.** v4 (2026-10-24).  SIGNUP-1G.  Supersedes v3.  Key
changes from v3:

- **PowerShell commands converted from backtick-continuation to
  splatting** — the v3 line-continuations fail silently on copy-paste
  into Windows PowerShell when any invisible trailing whitespace
  follows a backtick, producing exactly the "blank
  RecipientRestrictionFilter" symptom the founder observed.
- **Service-principal lookup now by AppId**, not Enterprise App
  Object ID — removes the common "which ObjectId do I paste?" trap.
- **A single idempotent repair script**
  ([scripts/signup-1g-ms365-repair.ps1](../scripts/signup-1g-ms365-repair.ps1))
  replaces step-by-step PowerShell.  Runs preflight, diagnoses current
  state, repairs idempotently, and runs positive + negative
  verification before exiting.  Safe to rerun any number of times.
- **"Leave Entra API permissions empty" warning** promoted to the
  critical-step list — a Mail.Send permission granted in Entra
  ID bypasses the Exchange scope entirely.
- **PowerShell version guidance** — PowerShell 7+ strongly
  preferred; 5.1 technically works but fragile for RBAC commands.

**Goal.** Give Spectre's transactional email code the ability to send
mail **only** from one dedicated mailbox:
`no-reply@spectreautomation.com`.  Nothing else in the tenant.

**Hard constraints.**

- Do NOT grant tenant-wide `Mail.Send` application permission in
  Microsoft Entra ID.  Leave the new app's **API permissions page
  empty**.  The grant lives in Exchange Online RBAC only.
- Do NOT reuse the existing SIGNUP-1 OAuth app (`b7f855a6…`) or the
  existing mailbox-integration app for transactional sending.
- Do NOT paste any credential (client secret, API key, etc.) into
  chat, tickets, Slack, screenshots, or any commit.

---

## Overview — the six phases

The script does Phase 3 and most of Phase 4 for you.  The remaining
phases are click-through in Microsoft and Fly admin surfaces.

1. **Phase 1 (Microsoft 365 admin UI)** — designate the sender mailbox.
2. **Phase 2 (Microsoft Entra admin UI)** — register the dedicated app.
3. **Phase 3 (Microsoft Entra admin UI)** — generate a client secret.
4. **Phase 4 (PowerShell, one command)** — run the repair script.
5. **Phase 5 (operator workstation + `flyctl`)** — set Fly secrets.
6. **Phase 6 (any browser)** — verify.

Total expected elapsed time: **~20 minutes**, mostly waiting for
admin consent to propagate.

---

## Phase 1 — Designate the sender mailbox

Microsoft 365 admin center → Teams & groups → Shared mailboxes →
**Add a shared mailbox**:

| Field | Value |
|---|---|
| Display name | `Spectre Automation` |
| Email address | `no-reply@spectreautomation.com` |
| Domain | the verified Spectre domain |

**Why a shared mailbox:** needs no licence, costs nothing, is
the right fit for a send-only sender identity.

Give the mailbox 2–3 minutes to provision before Phase 4.

---

## Phase 2 — Register the dedicated Entra app

Microsoft Entra admin center → App registrations → **New registration**:

| Field | Value |
|---|---|
| Name | `Spectre Transactional Mail` |
| Supported account types | *Accounts in this organizational directory only (Single tenant)* |
| Redirect URI | leave blank |

Click **Register**.  From the Overview page, record two values:

- **Application (client) ID** — a GUID.  The Phase 4 script needs this.
- **Directory (tenant) ID** — also a GUID.  Phase 5 needs this.

Then, on the **API permissions** page for this app:

- **Do nothing.  Leave this list empty.**

If `Mail.Send` is already listed under "Configured permissions" with
admin consent granted, it must be **removed** before Phase 4 — a
tenant-wide Mail.Send grant in Entra silently overrides the
Exchange scope and lets this app send from any mailbox in your tenant.

---

## Phase 3 — Generate a client secret

On the App Registration → **Certificates & secrets** → **New client
secret**:

- Description: `Spectre Transactional Mail — <today's date>`
- Expiry: 90 days.

Click **Add**.  **Record the "Value" column immediately** — Microsoft
never shows it again.  Store it in Spectre's password manager with
the expiry date.  Set a 60-day reminder to rotate.

**Do not paste the secret anywhere else.**  Phase 5 reads it from
your password manager directly into `flyctl`.

---

## Phase 4 — Run the repair script

### 4.1 · One-time preparation

Install (or confirm) the Exchange Online PowerShell module.  Prefer
**PowerShell 7**; Windows PowerShell 5.1 works but is more fragile:

```powershell
Install-Module -Name ExchangeOnlineManagement -MinimumVersion 3.4.0 -Scope CurrentUser
```

### 4.2 · Create the service-principal pointer in Exchange

This is a one-time create.  The repair script will refuse to run
until this exists.

**Where to find the Enterprise App Object ID (needed only for this
one command):**

Microsoft Entra admin center → **Enterprise applications** → All
applications → `Spectre Transactional Mail` → **Object ID**.  This
is a different GUID from the App Registration's Object ID.

```powershell
Connect-ExchangeOnline

$spParams = @{
    AppId       = '<Application (client) ID from Phase 2>'
    ObjectId    = '<Enterprise App Object ID from the step above>'
    DisplayName = 'Spectre Transactional Mail'
}
New-ServicePrincipal @spParams
```

Expected: a table row showing DisplayName, ObjectId, AppId.

### 4.3 · Run the repair script

From the Spectre repo root:

```powershell
.\scripts\signup-1g-ms365-repair.ps1 -AppClientId '<Application (client) ID from Phase 2>'
```

The script:

- **Preflight.** Verifies module version, Exchange connection,
  shared mailbox, service principal.
- **Diagnoses.** Prints the current state of the management scope
  and existing role assignments.
- **Repairs idempotently.**
  - If the `Spectre No-Reply Only` scope does not exist, creates it.
  - If it exists but its `RecipientRestrictionFilter` is blank or
    wrong (the SIGNUP-1G defect), updates it in place with
    `Set-ManagementScope`.
  - If the `Application Mail.Send` role assignment on the service
    principal doesn't exist with the correct scope, creates it.
  - If both already exist and are correct, does nothing beyond
    verification.
- **Verifies.** Runs `Test-ServicePrincipalAuthorization` positively
  against `no-reply@spectreautomation.com` AND negatively against
  `admin@spectreautomation.com`.  Fails loudly if either test
  returns the wrong result.
- **Never deletes** existing resources.  Never touches Entra ID.

To preview changes without executing them:

```powershell
.\scripts\signup-1g-ms365-repair.ps1 -AppClientId '<AppClientId>' -DryRun
```

If the script exits with a non-zero code, read the printed
instructions in the Summary section.  Common exits:

| Exit | Meaning | Fix |
|---|---|---|
| 2 | Module missing or old; or Connect-ExchangeOnline failed | Install / update module; sign in as Exchange Admin |
| 3 | Shared mailbox not found | Complete Phase 1 and wait 2–3 min |
| 4 | Service principal not found | Complete step 4.2 |
| 5 | Scope filter still blank after Set-ManagementScope | Open a Microsoft support ticket (unusual) |
| 6 | New-ManagementRoleAssignment denied | Confirm you're signed in as Exchange Admin; update module |
| 7 | Positive test failed | Something is still wrong; re-run with -DryRun and inspect |
| 8 | Negative test failed — SECURITY DEFECT | Remove any unscoped `Application Mail.Send` role assignment on the SP, OR any `Mail.Send` application permission on the Entra app |

The script is safe to rerun as many times as you like.  It only
writes when actual state differs from desired state.

---

## Phase 5 — Set Fly staging secrets

On the operator workstation with `flyctl` authenticated to the
Spectre Fly org, run **exactly** this (replace the two `<…>` tokens
with their real values from Phase 2 + Phase 3):

```bash
flyctl secrets set \
  EMAIL_DELIVERY_MODE=microsoft365 \
  MICROSOFT_TENANT_ID='<Directory (tenant) ID from Phase 2>' \
  MICROSOFT_CLIENT_ID='<Application (client) ID from Phase 2>' \
  MICROSOFT_CLIENT_SECRET='<secret VALUE from Phase 3 — paste directly from your password manager>' \
  MICROSOFT_FROM_MAILBOX=no-reply@spectreautomation.com \
  --app spectre-staging
```

**Secret-handling rules:**

- Do not type the secret into a shared terminal history that logs
  commands (`.bash_history`, `~/.zsh_history`).  Prefix the `flyctl`
  command with a space on bash/zsh with `HISTCONTROL=ignorespace` set
  to omit it from history, OR run `history -d $(($HISTCMD-1))` after.
- Do not screenshot the terminal with the secret visible.
- Do not reuse the secret value for any other service.

Fly automatically restarts the `spectre-staging` web app on secret
change.  Expected downtime: < 30 seconds.

The `spectre-staging-worker` app does not send signup email, so
these secrets do not need to be set on the worker.

---

## Phase 6 — Verify end-to-end

### 6a · Confirm Spectre is now in Microsoft 365 mode

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
with a Microsoft work account whose primary email you control.
After completing the Microsoft sign-in step:

- An email arrives at that address within ~60 seconds.
- From: `Spectre Automation <no-reply@spectreautomation.com>`
- Subject: `Resume your Spectre registration`
- Body contains `/signup/r/<token>` link and the copy "This link is
  single-use and expires in 30 minutes".

### 6c · Verify the cross-device recovery (30-min window)

- Open the email in a different browser (not the one used to sign up).
- Click the link within 30 minutes.
- Lands on the status page for the same registration.
- Click the same link again from a third browser — expected error:
  "This recovery link has already been used."

### 6d · Confirm no sensitive data in logs

```bash
flyctl logs --app spectre-staging | grep -i "signup.resume_email.sent\|signup.recovery_link"
```

Expected: only masked emails + `linkIdTail` + `providerMessageId`.
No raw token.  No full URL.

### 6e · Confirm existing Microsoft mailbox integrations still work

Sign in to `staging.spectreautomation.com` as a club admin with an
existing Microsoft mailbox integration.  Open Work Intake → Inbox.
Expected: the integration continues to list messages and allow
delete / restore mutations.  The new Transactional Mail app is a
separate Entra identity and does not affect the delegated mailbox
app (`b7f855a6…`) in any way.

### 6f · Run the Playwright regression

```bash
cd c:/dev/SpectreAutomation
npx playwright test \
  tests/e2e/signup-1-acceptance.staging.spec.ts \
  tests/e2e/signup-1-conditional-acceptance.staging.spec.ts \
  tests/e2e/signup-1c-ms-button-regression.staging.spec.ts \
  tests/e2e/signup-1e-role-persistence.staging.spec.ts \
  tests/e2e/signup-1f-cross-browser-recovery.staging.spec.ts \
  --reporter=line
```

Expected: `10 passed`.

---

## Why v3 of this runbook failed in practice

Four defects were observed by the founder running v3:

1. **The `Spectre No-Reply Only` scope existed but its
   `RecipientRestrictionFilter` was blank.**  Root cause: v3 used
   backtick line-continuation across multiple lines
   (`New-ManagementScope \`` + newline + `-RecipientRestrictionFilter`).
   On Windows PowerShell, if any invisible trailing whitespace
   follows the backtick during copy-paste, the shell treats the
   backtick as literal and runs each line as a separate command.
   The first line `New-ManagementScope -Name "..."` succeeds and
   creates the scope with no filter.  The second line errors but
   is easy to miss amid other output.  **Fix in v4:** every command
   now uses splatting (`@params`), which is immune to copy-paste
   whitespace quirks.
2. **Role-assignment attempts hit authorization errors.**  Root
   cause: the operator's effective permissions were correct
   (`DelegatingOrgWide` for `Application Mail.Send`), but the
   `-App` parameter was likely populated with the App Registration
   Object ID (visible on the App registrations page) rather than
   the Enterprise Application Object ID.  Microsoft returns an
   authorization-shaped error in that case instead of a cleaner
   "not found".  **Fix in v4:** the repair script resolves the
   service principal from the AppId alone — no ObjectId needed
   at script run time — and the one place that still needs the
   Enterprise App Object ID (step 4.2) explicitly links to the
   correct Entra portal location.
3. **Windows PowerShell 5.1 fragility.**  Default Windows system
   PowerShell is 5.1, which has an older PowerShellGet, no TLS 1.2
   enabled by default, and copy-paste quirks around multi-line
   commands.  **Fix in v4:** the script sets TLS 1.2 at the top of
   its process; recommends PowerShell 7 but doesn't require it.
4. **No idempotent repair path.**  v3 told the operator to
   `New-ManagementScope`, which fails or creates a duplicate on
   rerun.  **Fix in v4:** the script detects existing resources
   and uses `Set-ManagementScope` to repair the filter in place,
   never recreating.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `effectiveAdapter: microsoft365_misconfigured_FALLBACK_FAILS` | A Fly secret is unset or empty | Re-run Phase 5; `flyctl secrets list --app spectre-staging` to confirm the five keys are present. |
| Script Phase 2 says "Service principal not found" | Step 4.2 was skipped, OR the AppId doesn't match any Entra Enterprise App in your tenant | Run step 4.2; double-check the AppId against the App Registration overview. |
| Script Phase 3 says "scope filter is BLANK" | Known SIGNUP-1G defect — v3 runbook caused this | Let the script fix it (it will set the filter via `Set-ManagementScope`). |
| Script Phase 5 negative test fails | Either an unscoped `Application Mail.Send` role assignment exists on the SP, OR a tenant-wide `Mail.Send` application permission is granted on the Entra app | See script output for the specific unscoped assignment name; remove with `Remove-ManagementRoleAssignment -Identity '<name>'`.  Also verify Entra API permissions is empty. |
| Email takes > 2 min to arrive | First-send cold path at Microsoft | Give it 5 min; recheck 6a; try again. |
| `Mail.Send` script positive but real send fails with 403 | Admin-consent cache (30 min – 2 h propagation per Microsoft docs) | Wait 30 min; retry.  `Test-ServicePrincipalAuthorization` bypasses the cache; a token issued moments after Phase 4 may not yet carry the new scope. |

---

## What NOT to do (common mistakes)

- **Do not add `Mail.Send` as an application permission on the new
  app's API permissions page.**  Tenant-wide send; defeats scoping.
- **Do not reuse the SIGNUP-1 OAuth app (`b7f855a6…`).**  Delegated
  identity scopes serve the signup flow + per-club mailbox integration.
- **Do not skip the negative test.**  The repair script runs it
  automatically; don't suppress its exit code.
- **Do not commit the client secret anywhere in the Spectre repo.**
  Secret appears in exactly two places: Entra portal (once) and
  `flyctl secrets` (encrypted at rest).

---

## Promotion to production (future, not now)

Repeat Phases 1–6 against the production tenant and the `spectre`
Fly app.  Separate client secret.  Separate role assignment.
Production promotion is **not** authorised by SIGNUP-1G — the
founder must explicitly approve.

---

## Alternative providers (unchanged)

The platform adapter chain in
[src/lib/integrations/email.ts](../src/lib/integrations/email.ts#L367)
also supports SMTP (`EMAIL_DELIVERY_MODE=smtp`) and AWS SES
(`EMAIL_DELIVERY_MODE=ses`).  Either can be set via Fly secrets as
an alternative, but neither is required for SIGNUP-1G acceptance.

---

## Reference links

- [Microsoft Learn — RBAC for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
- [Microsoft Learn — Install the Exchange Online PowerShell module](https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2)
- [Repair script source](../scripts/signup-1g-ms365-repair.ps1)
- [Spectre code — platform email adapter chain](../src/lib/integrations/email.ts)
- [Spectre code — recovery-link service (30-min TTL)](../src/lib/signup/recovery-link.ts)
- [Spectre code — resume-email body](../src/lib/signup/resume-email.ts)
