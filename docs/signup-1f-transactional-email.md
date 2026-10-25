# Transactional Email — Operator Setup Guide (v5)

**Audience.** The founder, or any Spectre operator with Microsoft 365
Global Admin / Exchange Admin rights and `flyctl` access to the
Spectre Fly org.

**Revision.** v9 (2026-10-24).  SIGNUP-1G Phase D.1 BOM fix.
Supersedes v8.  Key change from v8:

- **Stdin encoding fixed for Windows PowerShell 5.1.**  v8's
  `BaseStream.Write($bytes); StandardInput.Close()` sequence
  silently wrote a UTF-8 BOM (`EF BB BF`) to the pipe because
  the Process.StandardInput StreamWriter the framework
  constructs on PS 5.1 uses UTF-8-with-BOM; its `Close()`
  flushed the preamble onto the already-written pipe, and
  flyctl's atomic line parser rejected the import with
  `"﻿EMAIL_DELIVERY_MODE" is not a valid secret name`.
  v9 builds the payload via a per-run StreamWriter
  (`UTF8Encoding $false` -> no preamble) wrapping a
  MemoryStream, extracts the resulting bytes, writes them to
  `Process.StandardInput.BaseStream` directly, and closes
  `BaseStream` -- never `.StandardInput`.  The Process's own
  StreamWriter is left untouched so its preamble is never
  flushed.
- **New `-Test` self-check** builds the payload via the exact
  same code path and asserts:
  - first 5 bytes are `45 4D 41 49 4C` (ASCII `EMAIL`),
  - the sequence `EF BB BF` appears nowhere in the payload,
  - the five content lines decode exactly as intended,
  - no `CR` characters inside any content line,
  - redaction behaves correctly, including with an empty
    secret parameter.
  Verified locally: 23/23 assertions pass on Windows
  PowerShell 5.1.
- **Pre-flight + post-failure snapshots** of the five target
  Fly secret names on `spectre-staging` so a partial update is
  self-evident.  flyctl's `secrets import` is atomic, but
  recording the before-state and the after-state (on failure)
  makes the no-partial-update claim auditable rather than
  axiomatic.

Earlier v8 change (preserved):

- **Fly activation now uses `flyctl secrets import` with stdin.**
  v7 used `flyctl secrets set KEY=VALUE ...` with PowerShell array
  splatting.  Array splatting bypasses the shell parser, but the
  Windows kernel still exposes the subprocess's full command line
  via `Win32_Process.CommandLine` to any process on the same user
  session.  v8's `secrets import` approach puts only
  `secrets import --app spectre-staging` on the subprocess
  command line; the KEY=VALUE lines (including the secret value)
  are streamed over stdin via a UTF-8-no-BOM write to the
  subprocess's StandardInput.BaseStream.  The script self-verifies
  the clean command line at run time (reads its own subprocess's
  `Win32_Process.CommandLine` and aborts with exit 4 if the plain
  secret is found).

Earlier v7 additions (preserved):

- **Three new operator scripts for Phase C + Phase D step 1**,
  so the founder's involvement is reduced to three
  interactive prompts (Entra sign-in; client-secret entry;
  Fly auth confirmation):
  - `scripts/signup-1g-entra-permissions-audit.ps1` -- read-only
    Microsoft Graph query that proves the dedicated app has NO
    application-permission Mail.Send grant.  No secrets.
  - `scripts/signup-1g-graph-send-test.ps1` -- live
    client-credentials token exchange + positive + negative
    `/sendMail` calls.  Secret via `Read-Host -AsSecureString`;
    scrubbed from memory before exit.
  - `scripts/signup-1g-fly-secrets-activate.ps1` -- Fly staging
    secret set via array splatting; same secret-entry pattern;
    refuses any non-staging `-App` target.
- Runbook adds a dedicated Phase C (security verification) and
  Phase D (staging activation + Playwright regression) section
  below Phase 6.
- Acceptance evidence template is `docs/signup-1g-acceptance.md`,
  filled during Phase D and attached to the final report.

Earlier v6 change (preserved):

- **Negative-control mailbox is now discovered, not assumed.**
  v5 defaulted `-NegativeControlMailbox` to `admin@spectreautomation.com`.
  In many Microsoft 365 tenants the Global Admin is an unlicensed
  service account with NO mailbox — Get-EXOMailbox returns 404.
  v6 default is now empty; Phase 1b runs a read-only
  Get-EXOMailbox discovery, excludes the SharedMailbox and
  system / discovery / group mailboxes, and either auto-selects
  the single candidate, interactively prompts to pick one from
  multiple candidates, or exits 3 with a clear message if none
  are eligible.  The script never creates or modifies a mailbox.
  The negative test remains mandatory.
- Operator can still supply `-NegativeControlMailbox '<addr>'`
  explicitly to skip discovery and go non-interactive.

Earlier v5 changes (preserved):

- **Repair script hardened** per the ten-point review.  Negative
  control is mandatory; broader-role grants block acceptance;
  every role assignment is evaluated (no "first match wins");
  scope repair now runs a Get-Recipient preview to prove the filter
  matches exactly one mailbox; mailbox identity + SharedMailbox
  type are both asserted; all Exchange queries fail-closed on
  error; `-DryRun` performs zero writes and clearly flags when
  re-verification will be required after a live apply; a `-Test`
  mode runs 24 pure-function assertions against mocked inputs
  without any tenant connection.
- **Script explicitly does NOT claim end-to-end security
  verification.**  Exchange Online RBAC is one of three gates;
  the operator must independently confirm (a) Entra API permissions
  is empty on the new app, (b) a real Microsoft Graph send from
  the designated mailbox succeeds, (c) a real Graph send attempt
  from a different mailbox is refused.
- **Fly `flyctl` commands rewritten for Windows PowerShell.**  The
  v4 bash-style `\` continuations do not work in Windows PowerShell;
  v5 uses array-splatting with `Read-Host -AsSecureString` so the
  secret value never enters the shell history, a file, or a log.
- **Root-cause framing is hypothesis vs evidence.**  The blank
  `RecipientRestrictionFilter` state is confirmed evidence; the
  backtick-continuation attribution is a plausible hypothesis
  consistent with it, not proof.  The repair path works regardless
  of which hypothesis caused the state.
- **Script and runbook are ASCII-only** so Windows PowerShell 5.1
  reading the file as Windows-1252 (its default when no BOM is
  present) does not produce mojibake that then causes parse errors.

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

Before running against a live tenant, run the pure-function
self-check (no credentials, no connection, no writes):

```powershell
.\scripts\signup-1g-ms365-repair.ps1 -Test
```

Expected: `All assertions passed.` (44 assertions across role-
classification, authorization-verdict, email normalization,
negative-control filter, scope-filter equality, and SP-identity
validation).

Then run against the tenant.  Start with `-DryRun` to preview.
There are two shapes of this command — pick whichever matches
your tenant:

**Shape A — the script discovers an eligible negative-control
mailbox for you (recommended first attempt):**

```powershell
.\scripts\signup-1g-ms365-repair.ps1 -AppClientId '<Application (client) ID from Phase 2>' -DryRun
```

Phase 1b will run a read-only `Get-EXOMailbox` discovery query,
exclude the SharedMailbox + system / discovery / group
mailboxes, and either auto-select the single eligible candidate
or print a numbered list for you to choose from.  The negative
test is **always** run; the script never skips it.

**Shape B — you supply the negative control explicitly (useful
on reruns, or in a non-interactive session):**

```powershell
.\scripts\signup-1g-ms365-repair.ps1 `
    -AppClientId '<Application (client) ID from Phase 2>' `
    -NegativeControlMailbox '<a-real-UserMailbox-or-SharedMailbox-other-than-no-reply@>' `
    -DryRun
```

The dry run performs ZERO writes.  It reports proposed changes
as `[DRY-RUN WOULD CHANGE]`.  Verification runs against the
CURRENT state only — the summary notes if a follow-up live run
is required to re-verify after writes.

If the proposed changes look right, apply them for real
(drop `-DryRun`):

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
instructions in the Summary section.  Full exit-code table:

| Exit | Meaning | Fix |
|---|---|---|
| 0 | Exchange RBAC verified (NOT the full end-to-end acceptance — see "What the repair script does NOT verify" below) | Proceed to Phase 5 |
| 2 | Preflight failure — missing / stale module, or Connect-ExchangeOnline failed | Install / update module; sign in as Exchange Admin |
| 3 | Mailbox validation failure — SharedMailbox missing or wrong type, OR negative control mailbox missing | Complete Phase 1 and wait 2-3 min; supply a different `-NegativeControlMailbox` |
| 4 | Service principal not resolvable from AppId | Complete step 4.2 |
| 5 | Scope repair failed, OR scope recipient-preview did not match exactly one target mailbox | Check Phase 3 output; if preview returned 0 or 2+ recipients, the filter is wrong |
| 6 | New-ManagementRoleAssignment denied, OR Get-ManagementRoleAssignment query errored (fail-closed) | Confirm you're signed in as Exchange Admin; update module |
| 7 | Positive test failed — intended scoped grant not in effect | Re-run; if Phase 4 wrote the assignment this run, wait a minute for the cmdlet-side cache |
| 8 | Negative test failed — SP CAN send from the control mailbox (SECURITY DEFECT) | See Phase 4 output: remove any unscoped / differently-scoped `Application Mail.Send` role assignment on the SP, OR any `Mail.Send` application permission on the Entra app |
| 9 | Broader-grant block — unscoped / differently-scoped / broader-role Mail.Send grants exist on the SP | Review each listed assignment and `Remove-ManagementRoleAssignment -Identity '<name>'`; rerun |
| 10 | `-Test` self-check assertion failure | Something in the script's pure-function logic diverged; do not run against a live tenant |

The script is safe to rerun as many times as you like.  It only
writes when actual state differs from desired state.

---

## Phase 5 — Set Fly staging secrets (Windows PowerShell)

On the operator workstation with `flyctl` authenticated to the
Spectre Fly org, run **exactly** this in a PowerShell window.
The secret is read from a `Read-Host -AsSecureString` prompt and
never touches shell history, a file, or a log line.

```powershell
# Fill the two non-secret values in-place; keep them in quotes.
$tenantId = '<Directory (tenant) ID from Phase 2>'
$clientId = '<Application (client) ID from Phase 2>'

# Prompt for the client secret.  The characters you type are hidden
# and never echoed anywhere.  Paste the value from your password
# manager at the prompt, then press Enter.
$sec   = Read-Host -AsSecureString 'Paste the Spectre Transactional Mail client secret'
$plain = [System.Net.NetworkCredential]::new('', $sec).Password

# Array-splatting passes each KEY=VALUE pair to flyctl as a separate
# argument.  Windows PowerShell handles this cleanly without the
# bash backslash-continuation that previous versions of this doc used.
$kv = @(
    'EMAIL_DELIVERY_MODE=microsoft365',
    "MICROSOFT_TENANT_ID=$tenantId",
    "MICROSOFT_CLIENT_ID=$clientId",
    "MICROSOFT_CLIENT_SECRET=$plain",
    'MICROSOFT_FROM_MAILBOX=no-reply@spectreautomation.com'
)
& flyctl secrets set @kv --app spectre-staging

# Clear the plaintext from memory and the two variables that held it.
Remove-Variable sec, plain -Force -ErrorAction SilentlyContinue
[System.GC]::Collect()
```

**Secret-handling rules:**

- Do not type the secret value anywhere outside the `Read-Host`
  prompt above.  In particular, do not type it on the command
  line, into chat, into a ticket, or into a file.
- Do not screenshot the terminal with the secret or any state
  derived from it visible.
- Do not reuse the secret value for any other service.
- `Remove-Variable` + `GC.Collect` scrubs the plaintext from
  the current PowerShell session.  Close the window when done.

**For bash / zsh operators** (not the primary path, provided only
if PowerShell is unavailable): read the secret into an env var
without recording it in history, then invoke `flyctl`:

```bash
# Prefix the next line with a space when HISTCONTROL=ignorespace is set.
 read -s -p "Paste the client secret: " MS_SECRET; echo
flyctl secrets set \
  EMAIL_DELIVERY_MODE=microsoft365 \
  MICROSOFT_TENANT_ID='<tenant id>' \
  MICROSOFT_CLIENT_ID='<client id>' \
  "MICROSOFT_CLIENT_SECRET=$MS_SECRET" \
  MICROSOFT_FROM_MAILBOX=no-reply@spectreautomation.com \
  --app spectre-staging
unset MS_SECRET
```

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

## Why v3 of this runbook failed — observed evidence vs hypotheses

**Observed evidence (confirmed by the founder's run):**

- The `Spectre No-Reply Only` management scope exists but
  `RecipientRestrictionFilter` is blank.
- Attempts to create the scoped `Application Mail.Send` role
  assignment produced authorization-shaped errors even though
  effective permissions on the admin account include
  `DelegatingOrgWide` for both `Application Mail.Send` and
  `Role Management` through Organization Management.

**Hypotheses consistent with that evidence (not individually
proven; the fixes work regardless of which actually caused each
failure):**

1. *Blank filter.*  v3 used backtick line-continuation
   (`New-ManagementScope \`` + newline + `-RecipientRestrictionFilter`).
   Windows PowerShell treats a backtick as literal when any
   invisible trailing whitespace follows it; the first line runs
   on its own, creating the scope WITHOUT a filter, and the
   second line errors to a usually-ignored stream.  Alternative
   hypothesis: the operator ran a different variant of the
   command that omitted the filter parameter.  v5 does not rely
   on either hypothesis — it simply repairs the observed state
   via `Set-ManagementScope`.
2. *Role-assignment "authorization error".*  Microsoft returns an
   authorization-shaped error when `-App <ObjectId>` resolves to
   no live service principal, which can happen if the operator
   pasted the App Registration's Object ID instead of the
   Enterprise Application's Object ID (two different GUIDs).  v5
   resolves the SP from the AppId alone at script runtime.
3. *Fragile Windows PowerShell 5.1 defaults.*  No TLS 1.2 on some
   installations; older PowerShellGet; sensitive copy-paste.  v5
   sets TLS 1.2 in-process and ships ASCII-only text (so a 5.1
   session reading the file as Windows-1252 does not produce
   mojibake that then causes parse errors).

**What v5 fixes regardless of which hypothesis held:**

- Splatting (`@params`) everywhere — immune to copy-paste
  whitespace quirks.
- Script resolves SP from AppId; the Enterprise App Object ID is
  only ever needed one time, at `New-ServicePrincipal`.
- Idempotent repair: `Set-ManagementScope` on an existing scope
  with blank/wrong filter; no deletes; safe to rerun.
- A Get-Recipient preview after any repair asserts that the
  scope's filter matches EXACTLY ONE mailbox and that mailbox is
  the SharedMailbox the operator supplied.

---

## What the repair script does NOT verify

Exchange Online RBAC is one of three gates that together bound
the dedicated app's send authority.  The script only verifies the
first.  The operator must independently verify the other two
before declaring SIGNUP-1G accepted.

1. **Entra ID API permissions on the app = empty.**  If the Entra
   App Registration has a tenant-wide `Mail.Send` application
   permission with admin consent, that grant exists in addition
   to any Exchange RBAC and silently defeats the scoping.  Check
   on each run of this guide via:

   Microsoft Entra admin center -> App registrations -> **Spectre
   Transactional Mail** -> **API permissions**.  The "Configured
   permissions" table must be empty.

2. **Real Microsoft Graph positive send.**  After Phase 5 lands
   the Fly secrets, step 6b in this guide walks a signup through
   the real UI.  An email must arrive at the Microsoft-verified
   recipient's inbox within 60 s.  If the token exchange succeeds
   but the Graph send returns 403, Exchange RBAC propagation is
   still pending (Microsoft documents 30 min to 2 h cache
   maintenance after a role change) — wait and retry.

3. **Real Microsoft Graph negative send.**  Temporarily override
   `MICROSOFT_FROM_MAILBOX` to a different real mailbox in the
   tenant and attempt a send.  Microsoft Graph must return 403
   `ErrorAccessDenied: Access to OrganizationFromEmailAddresses
   is denied`.  Immediately revert `MICROSOFT_FROM_MAILBOX` to
   `no-reply@spectreautomation.com` after the test.  This is the
   only gate that proves live-token enforcement; it cannot be
   bypassed by the RBAC-only verification the repair script
   performs.

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

## Phase C -- Security verification (after Exchange RBAC passes)

Prerequisites: `scripts/signup-1g-ms365-repair.ps1` has exited 0
against your live tenant (RBAC repaired + positive + negative tests
passed).

### C.1 -- Entra API permissions audit (read-only, no secrets)

Confirms the dedicated app has no application-permission Mail.Send
grant on Microsoft Graph.  Any such grant would bypass the Exchange
RBAC scope.  One-time prereq (per workstation):

```powershell
Install-Module Microsoft.Graph.Applications -Scope CurrentUser
```

Then:

```powershell
cd c:\dev\SpectreAutomation
Connect-MgGraph -Scopes 'Application.Read.All'
.\scripts\signup-1g-entra-permissions-audit.ps1 -AppClientId '<Spectre Transactional Mail client id>'
```

Expected final line: `[OK]      Entra API permissions audit PASSED.`
Exit 0.  No application-permission Mail.Send grant found.

If exit 3 (BLOCKER): remove the listed grants.  The script prints the
exact `Remove-MgServicePrincipalAppRoleAssignment` command for each.

### C.2 -- Live Microsoft Graph send tests (positive + negative)

Confirms the live Graph API enforces the scope against real tokens.
Positive: 202 Accepted from `no-reply@`.  Negative: 403 Forbidden from
`cturcato@`.  Secret is entered via `Read-Host -AsSecureString`; it
never enters command-line arguments, shell history, source files,
logs, or chat.

```powershell
.\scripts\signup-1g-graph-send-test.ps1 `
    -TenantId '<Directory (tenant) ID>' `
    -AppClientId '<Spectre Transactional Mail client id>' `
    -NegativeControlMailbox 'cturcato@spectreautomation.com' `
    -ToEmail '<a real inbox you control>'
```

Expected final section:

```
Phase 3 -- POSITIVE send (no-reply@spectreautomation.com -> <ToEmail>)
  [OK]      Positive send: HTTP 202 Accepted.
Phase 4 -- NEGATIVE send (cturcato@spectreautomation.com -> <ToEmail>)
  [OK]      Negative send: HTTP 403 Forbidden (as expected).
```

Exit 0.  **The positive-test email actually sends.**  Confirm it
arrives at `<ToEmail>` within ~60 seconds; delete after.

Exit 4 (SECURITY DEFECT) means the negative send returned 202 --
re-audit immediately; do not proceed to Phase D.

### C.3 -- Record evidence

Fill the "Phase C" section of `docs/signup-1g-acceptance.md` with:
- Entra audit script exit code + the "application-permission grants"
  count line from its output.
- Graph send-test script exit code + the positive HTTP status +
  negative HTTP status.
- A note of the `<ToEmail>` used + confirmation the test email was
  received + deleted.

---

## Phase D -- Staging activation + full regression

Prerequisites: Phase C exited 0 on both scripts and evidence is
recorded.

### D.1 -- Set Fly staging secrets

The script invokes `flyctl secrets import --app spectre-staging`
and streams `KEY=VALUE` lines over the subprocess's STDIN.  The
secret value never appears in the command-line arguments visible
to any observer (`Get-CimInstance Win32_Process -Filter
"ProcessId=<flyctl-pid>"` -> `CommandLine`).  The script
self-verifies this at run time by reading its own subprocess's
command line via WMI and aborting with exit 4 if the secret is
found in it.

The script refuses to run against any non-staging target.

```powershell
.\scripts\signup-1g-fly-secrets-activate.ps1 `
    -TenantId '<Directory (tenant) ID>' `
    -AppClientId '<Spectre Transactional Mail client id>'
```

Secret-exposure surface audit (verified by this script's run):

| Surface | Exposed? | Why |
|---|---|---|
| flyctl command-line argv | No | `secrets import --app spectre-staging` only; verified at run time via Win32_Process. |
| PowerShell command history | No | Script's own invocation does not include the secret; Read-Host input is not recorded by PSReadLine. |
| Source files | No | Nothing written. |
| flyctl stdout/stderr | No | Captured line-by-line and redacted; any accidental echo is scrubbed before print. |
| PowerShell session memory | Yes, briefly | `$plainSecret` and `$kvLines` cleared + overwritten in a `finally` block; GC.Collect called. |
| Fly API transit | HTTPS to Fly's control plane, encrypted at rest at Fly. |
| Deployed app process env | Yes, intentionally | The adapter reads `MICROSOFT_CLIENT_SECRET` from env; it never logs it. |

Fly rolls the `spectre-staging` web app automatically in ~30-45 s.

### D.2 -- Confirm effectiveAdapter

```bash
curl -s https://staging.spectreautomation.com/api/admin/signup/debug/status | jq .email
```

Expected: `"effectiveAdapter": "microsoft365"` and
`"fromAddress": "no-reply@spectreautomation.com"`.

### D.3 -- Signup regression (Playwright)

Run from the Spectre repo:

```powershell
npx playwright test `
    tests/e2e/signup-1-acceptance.staging.spec.ts `
    tests/e2e/signup-1-conditional-acceptance.staging.spec.ts `
    tests/e2e/signup-1c-ms-button-regression.staging.spec.ts `
    tests/e2e/signup-1e-role-persistence.staging.spec.ts `
    tests/e2e/signup-1f-cross-browser-recovery.staging.spec.ts `
    --reporter=line
```

Expected: `10 passed` (five specs x chromium + staging-authenticated).

### D.4 -- Real signup walk + email verification

Walk https://staging.spectreautomation.com/signup in a browser with
a Microsoft work account whose primary address you receive mail on.
Confirm:
- Email arrives from `Spectre Automation <no-reply@spectreautomation.com>`.
- Body contains `/signup/r/<token>` link and "expires in 30 minutes".
- Open the email in a different browser; click within 30 minutes;
  lands on the status page.
- Click the same link in a third browser; expect "already been used".

### D.5 -- Log scan

```bash
flyctl logs --app spectre-staging --since 10m | grep -Ei "signup\.resume_email|signup\.recovery_link"
flyctl logs --app spectre-staging --since 10m | grep -E "signup/r/[A-Za-z0-9_-]{20,}|resumeToken|recoveryToken"
```

Expected: first command shows masked emails + `linkIdTail` +
`providerMessageId` only.  Second command returns zero matches.

### D.6 -- Mailbox-integration regression

Sign in to staging as a club admin with an existing Microsoft
mailbox integration.  Confirm Work Intake inbox still lists recent
emails and that delete/restore mutations still work.

### D.7 -- Record evidence

Fill the "Phase D" section of `docs/signup-1g-acceptance.md` with
Playwright `n passed` line, email arrival confirmation, log-scan
result, and mailbox-integration spot-check verdict.  Submit the
completed document as the acceptance deliverable.

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
