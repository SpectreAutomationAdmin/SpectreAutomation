# SIGNUP-1G -- Transactional Mail Client Secret Rotation Runbook

**Audience.** The founder, or an operator with Microsoft 365 Global
Admin / Application Administrator rights and `flyctl` access to the
Spectre Fly org.  Executed on a predictable schedule (quarterly at
latest) so the Transactional Mail Entra app never silently expires.

**Scope.** The client secret attached to the `Spectre Transactional
Mail` Entra app registration that was stood up during SIGNUP-1G.
That is the only credential governed by this document.  The
delegated OAuth app that serves signup Microsoft sign-in and per-club
mailbox integrations (client-id prefix `b7f855a6`) has its own
lifecycle governed separately.

**This document never contains, reveals, retrieves, prints, or
stores the plaintext secret.**  All references to the secret are
to its *expiry metadata*, its *location*, or its *rotation
procedure*.

---

## 1 Where the credential lives

Microsoft Entra admin center -> App registrations -> **Spectre
Transactional Mail** -> **Certificates & secrets** -> **Client
secrets** tab.

Each row shows:
- Description.
- Expires (date).
- Value (shown exactly once at creation; never recoverable
  afterwards).
- Secret ID.

The plaintext secret is *stored only* in two places:
1. The founder's password manager (recorded once at creation).
2. The Fly staging app's secret store, under the key
   `MICROSOFT_CLIENT_SECRET`, encrypted at rest at Fly.

Nowhere else.  Not in this repo.  Not in any environment file.
Not in any support ticket.  Not in this document.

---

## 2 How to verify expiry WITHOUT revealing the secret

### 2a Dashboard check (click-through)

Microsoft Entra admin center -> App registrations -> **Spectre
Transactional Mail** -> **Certificates & secrets** -> **Client
secrets** tab.  Read the **Expires** column.

### 2b Scripted check (Microsoft Graph PowerShell)

Reports expiry dates for every secret on the app without reading
the secret value (Entra's API never returns secret values after
creation):

```powershell
Install-Module Microsoft.Graph.Applications -Scope CurrentUser  # one-time
Connect-MgGraph -Scopes 'Application.Read.All'

$app = Get-MgApplication -Filter "appId eq '<Spectre Transactional Mail Application (client) ID>'"
$app.PasswordCredentials | ForEach-Object {
    [pscustomobject]@{
        DisplayName = $_.DisplayName
        KeyId       = $_.KeyId
        StartsAt    = $_.StartDateTime
        ExpiresAt   = $_.EndDateTime
        DaysLeft    = [math]::Round(($_.EndDateTime - (Get-Date)).TotalDays, 1)
    }
} | Sort-Object ExpiresAt
```

Expected output (shape):

```
DisplayName                          KeyId       StartsAt       ExpiresAt      DaysLeft
Spectre Transactional Mail - YYYY..  <guid>      <datetime>     <datetime>      <float>
```

The query reads only Entra metadata.  It does not touch the Fly
staging secret, the deployed Spectre code, or any mailbox.

---

## 3 Advance-warning intervals

Secrets issued with a 90-day lifetime (Spectre convention).  Treat
the following thresholds as action triggers:

| DaysLeft on the active secret | Action |
|---|---|
| > 30 | None. |
| 30 | Add a calendar reminder to begin the rotation.  Do not rotate yet. |
| 14 | **Begin the overlap rotation (Section 4).** |
| 7 | Rotation should already be complete.  If not, escalate immediately -- the window to overlap safely is closing. |
| 3 | Last safe window.  Do not deploy anything else; focus on rotation. |
| < 1 | Emergency rotation per Section 7. |

The `DaysLeft` script in Section 2b is the operational source of
truth.  Dashboard displays round to days-since-today and may be
off by one; the script's floating-point value is authoritative.

---

## 4 Rotation procedure -- overlapping client secrets

Microsoft Entra allows multiple active client secrets on one app.
Spectre's rotation strategy uses this to maintain zero-downtime.
Timeline is driven by the Fly deploy cycle (not Microsoft-side; the
app can accept both the old and new secret during overlap).

### 4a Pre-rotation audit (T-14 days or sooner)

1. Run Section 2b.  Confirm exactly ONE active secret for the app.
   If there is already a second active secret from a prior aborted
   rotation, delete it first (`Remove-MgApplicationPassword`) and
   proceed from a clean state.
2. Confirm the current Fly staging adapter is healthy:
   ```bash
   curl -s https://staging.spectreautomation.com/api/admin/signup/debug/status \
     | jq .email
   ```
   Expected `effectiveAdapter = microsoft365`.
3. Confirm the Playwright regression is green against the current
   release:
   ```powershell
   npx playwright test \
     tests/e2e/signup-1-acceptance.staging.spec.ts \
     tests/e2e/signup-1-conditional-acceptance.staging.spec.ts \
     tests/e2e/signup-1c-ms-button-regression.staging.spec.ts \
     tests/e2e/signup-1e-role-persistence.staging.spec.ts \
     tests/e2e/signup-1f-cross-browser-recovery.staging.spec.ts \
     tests/e2e/signup-1g-expiry-deterministic.staging.spec.ts \
     tests/e2e/signup-1g-mailbox-integration-probe.staging.spec.ts \
     --reporter=line
   ```
   Expected: all pass.

### 4b Issue a new secret in Entra

In Entra -> App registrations -> **Spectre Transactional Mail** ->
**Certificates & secrets** -> **New client secret**:

- Description: `Spectre Transactional Mail -- <YYYY-MM-DD>`
  (date format identifies the rotation generation).
- Expiry: 90 days from today (operator policy).

Click **Add**.  Microsoft shows the Value column **exactly once**.

Capture that value into the founder's password manager.  **Do not**
type it into any chat, ticket, file, screenshot, or command-line
argument other than the SIGNUP-1G activation script's Read-Host
prompt.

Now both the old and the new secret are active on the Entra app.
Microsoft will accept client-credential auth with either secret
until the old one is removed (Section 4e).

### 4c Deploy the new secret to Fly staging

Use the pre-existing SIGNUP-1G activation script, which has been
designed to be idempotent and secret-safe:

```powershell
cd c:\dev\SpectreAutomation

# Self-test first (no credentials, no Fly, no M365).
.\scripts\signup-1g-fly-secrets-activate.ps1 -Test

# Then rotate the Fly secret.
.\scripts\signup-1g-fly-secrets-activate.ps1 `
    -TenantId '<Directory (tenant) ID>' `
    -AppClientId '<Spectre Transactional Mail client id>'
```

The script's Read-Host prompt accepts the **NEW** secret from
Section 4b.  Fly rolls `spectre-staging` web machines
automatically.

Expected observable change:
- `flyctl releases --app spectre-staging` shows a new release
  number (v<n+1>, incremented from the current).
- The `MICROSOFT_CLIENT_SECRET` row in `flyctl secrets list` has
  a NEW digest hash (the digest is a stable fingerprint of the
  encrypted value; a different hash means the value changed).

### 4d Verify staging on the new secret

```powershell
# Diagnostic.
curl -s https://staging.spectreautomation.com/api/admin/signup/debug/status `
  | jq .email
# Expected: effectiveAdapter = microsoft365

# Live Graph send tests, keyed by the NEW secret.
.\scripts\signup-1g-graph-send-test.ps1 `
    -TenantId '<Directory (tenant) ID>' `
    -AppClientId '<Spectre Transactional Mail client id>' `
    -NegativeControlMailbox '<a real UserMailbox or SharedMailbox other than no-reply@>' `
    -ToEmail '<a real inbox you control>'
```

Expected: positive 202 + negative 403; real email arrives at
`<ToEmail>`.

Then run the full SIGNUP regression:

```powershell
npx playwright test \
  tests/e2e/signup-1-acceptance.staging.spec.ts \
  tests/e2e/signup-1-conditional-acceptance.staging.spec.ts \
  tests/e2e/signup-1c-ms-button-regression.staging.spec.ts \
  tests/e2e/signup-1e-role-persistence.staging.spec.ts \
  tests/e2e/signup-1f-cross-browser-recovery.staging.spec.ts \
  tests/e2e/signup-1g-expiry-deterministic.staging.spec.ts \
  tests/e2e/signup-1g-mailbox-integration-probe.staging.spec.ts \
  --reporter=line
```

Expected: all pass.

### 4e Retire the OLD secret in Entra

Only after Section 4d verifies the staging deploy on the new
secret:

```powershell
Connect-MgGraph -Scopes 'Application.ReadWrite.All'
$app = Get-MgApplication -Filter "appId eq '<Spectre Transactional Mail Application (client) ID>'"
# Pick the KeyId of the OLD (not-the-one-you-just-created) secret.
Remove-MgApplicationPassword -ApplicationId $app.Id -KeyId '<old-key-id>'
```

Or, via the Entra dashboard, click **Delete** on the old secret's
row.  Microsoft invalidates the old secret for new token requests
within ~1 minute.  Active tokens remain valid until their natural
expiry (typically 1 hour).

### 4f Record the rotation

Log the rotation in Spectre's internal operational record (not in
this repo).  Required fields:

- Date of rotation.
- New secret KeyId (the GUID, not the value).
- New secret expiry (datetime).
- Operator initials.
- Any observations.

---

## 5 Rollback

If Section 4d verification fails on the new secret, roll back
BEFORE retiring the old one:

```powershell
# Rotate Fly staging back to the OLD secret via the same script.
# The founder's password manager must still contain the old value
# (do not delete it before Section 4e completes).
.\scripts\signup-1g-fly-secrets-activate.ps1 `
    -TenantId '<Directory (tenant) ID>' `
    -AppClientId '<Spectre Transactional Mail client id>'
# Paste the OLD secret at the Read-Host prompt.
```

Verify Section 4d again on the old secret.  Then delete the NEW
Entra secret (Section 4e, but choose the NEW KeyId instead).
Diagnose the root cause before trying again.

---

## 6 Operational responsibilities

- **Founder:** approves the rotation window; authenticates to Entra
  + Fly; receives / enters the new secret via the Read-Host prompt;
  updates the password manager; confirms deliverability on at
  least one real-inbox test send.
- **Future Spectre operator role (TBD when Spectre hires):** executes
  the rotation under the founder's authorisation; does not retain
  the secret value beyond the one-shot `Read-Host` session; is
  bound by Section 7's incident-response steps.

Nobody else may rotate the secret.  Microsoft 365 admins outside
Spectre (future enterprise tenant admins) see the Entra app
registration but have no authority over the Fly deploy; the two
sides must be rotated together by one authorised person.

---

## 7 Incident response (compromise or accidental exposure)

If the current client secret is suspected of exposure (committed to
a repo, pasted into a chat, visible in a screenshot, found in a
log, etc.):

1. **Immediately** issue a NEW secret per Section 4b.
2. **Immediately** deploy it to Fly staging per Section 4c (do
   NOT wait on verification -- the window of exposure is the
   priority).
3. **Immediately** delete the exposed secret in Entra per
   Section 4e.  Microsoft invalidates it within ~1 minute.
4. Review Fly staging logs for any evidence of abuse during the
   exposure window:
   ```bash
   flyctl logs --app spectre-staging | grep -Ei "signup\.resume_email|graph\." | head
   ```
   Look for anomalies in `providerMessageId` distribution,
   recipient addresses outside expected scope, send volume spikes.
5. If the exposure reached a public surface (git history, public
   chat, published screenshot), file a Microsoft support ticket
   requesting investigation of any Graph API usage with that
   specific KeyId during the exposure window.
6. Document the incident in Spectre's operational record with
   KeyId (not value), timeline, remediation steps, and lessons
   learned.

Never attempt to "scrub" an exposed secret from logs or chat
history as the remediation -- the only reliable remediation is
rotation + revocation.

---

## 8 Proposed automated expiry monitoring (NOT yet activated)

Scope note: the directive explicitly asks for this *proposal*
without recurring activation.  Here is a narrowly-scoped design
for founder approval.

### 8a Daily batch job

Add a scheduled worker job (`bin/worker.ts`-adjacent) that runs
once per day and:

1. Calls Microsoft Graph `GET /applications` filtered by the
   Transactional Mail app's AppId, reading
   `passwordCredentials.endDateTime`.
2. Computes `DaysLeft = (endDateTime - now()).TotalDays`.
3. On the day DaysLeft crosses 30, 14, 7, and 3, emits one audit
   event (`spectre.secret.rotation.warning`) and, if an operator
   notification channel is configured, posts to it.
4. Below DaysLeft < 1 and on expiry day, emits
   `spectre.secret.rotation.critical`.

### 8b Design constraints

- The monitoring job uses the SAME Transactional Mail app's token
  (via `Application.Read.All` consent) OR a separate dedicated
  app -- founder decision.  The Transactional Mail app currently
  does not have `Application.Read.All` consent; adding it would
  broaden the app's purpose and should be revisited.
- The job never reads the secret value.  It only reads expiry
  metadata.
- Audit events contain only KeyId + expiry date + severity -- no
  secret material.

### 8c Rollout gates

Not activated by this document.  Activation requires:
1. Founder approval of the design choice in Section 8b.
2. A dedicated SIGNUP-1G.1 (or similar) implementation slice.
3. DRH-1 staging deploy + Playwright regression + evidence record
   (same acceptance pattern as SIGNUP-1G).

Until that happens, Section 3's manual advance-warning intervals
are the operational control.  Calendar reminders are the fallback.

---

## 9 Related

- Entra app registration + Exchange RBAC provisioning:
  [docs/signup-1f-transactional-email.md](signup-1f-transactional-email.md).
- Accepted baseline evidence: [docs/signup-1g-acceptance.md](signup-1g-acceptance.md).
- Project memory: `signup-1g-accepted`.
