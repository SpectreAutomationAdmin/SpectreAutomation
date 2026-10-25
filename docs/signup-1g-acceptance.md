# SIGNUP-1G -- Staging Acceptance Evidence

**Scope.** Microsoft 365 transactional email activation on
`spectre-staging` via the dedicated `Spectre Transactional Mail`
Entra app.  Three operator-side gates (A/B/C) and a staging
activation + regression step (D).  Production unchanged.
SIGNUP-2 unchanged.

**Deploy baseline.**
- Current head of `staging-deploy/web1b1-framer-fidelity`:
  `<fill: sha from git log -1>`.
- Fly release in effect at acceptance time: `<fill: v<n> (image-digest-tail)>`.

---

## Phase A/B -- Exchange Online RBAC repair

(Already PASSED per the founder's prior message, 2026-10-24.)

| Check | Verdict | Evidence |
|---|---|---|
| Repair script exit code | PASS | signup-1g-ms365-repair.ps1 exited 0 |
| Scope filter stored | PASS | `PrimarySmtpAddress -eq 'no-reply@spectreautomation.com'` |
| Scope recipient-preview | PASS | exactly 1 recipient = no-reply@ |
| Positive Test-ServicePrincipalAuthorization | PASS | no-reply@ InScope=True |
| Negative Test-ServicePrincipalAuthorization | PASS | cturcato@ InScope=False |
| Broader-grant block | PASS | no unscoped / differently-scoped / Mail-Full-Access grants on the SP |
| Negative control used | `cturcato@spectreautomation.com` | discovered via Phase 1b read-only enumeration |

---

## Phase C -- Live security verification

Fill each row from the actual script output.

### C.1 -- Entra API permissions audit

```
scripts/signup-1g-entra-permissions-audit.ps1 -AppClientId '<...>'
```

| Field | Value |
|---|---|
| Script exit code | `<0 expected>` |
| App-permission grants on Microsoft Graph | `<n>` (expected: 0 blocking) |
| Blocking app-permissions found | `<none / list>` |
| Delegated OAuth2 grants on Microsoft Graph | `<n>` (expected: 0) |
| Verdict | `<PASS / FAIL>` |

### C.2 -- Live Microsoft Graph send tests

```
scripts/signup-1g-graph-send-test.ps1 `
    -TenantId '<...>' -AppClientId '<...>' `
    -NegativeControlMailbox 'cturcato@spectreautomation.com' `
    -ToEmail '<...>'
```

| Field | Value |
|---|---|
| Script exit code | `<0 expected>` |
| Positive FROM | `no-reply@spectreautomation.com` |
| Positive HTTP status | `<202 expected>` |
| Negative FROM | `cturcato@spectreautomation.com` |
| Negative HTTP status | `<403 expected>` |
| ToEmail used | `<a real inbox>` |
| Test email received at ToEmail | `<yes / no>` |
| Test email deleted after confirmation | `<yes / no>` |
| Verdict | `<PASS / FAIL>` |

### C.3 -- Microsoft Graph adapter audit

Reviewed in-tree at
[src/lib/integrations/microsoft-graph.ts](../src/lib/integrations/microsoft-graph.ts).
Audited for:

| Finding | Status |
|---|---|
| Token endpoint uses `/{tenant}/oauth2/v2.0/token` with `client_credentials` grant | PASS |
| Scope is `https://graph.microsoft.com/.default` | PASS |
| Send endpoint is `/v1.0/users/{fromMailbox}/sendMail` | PASS |
| Error messages redact `clientSecret` from the fallback-detail path (`redactSecret`) | PASS |
| Returns `providerMessageId` only in success log; masked email | PASS |
| No code path emits the raw secret to a log, trace, or exception message | PASS |

---

## Phase D -- Staging activation + regression

### D.1 -- Fly secret activation

```
scripts/signup-1g-fly-secrets-activate.ps1 `
    -TenantId '<...>' -AppClientId '<...>'
```

| Field | Value |
|---|---|
| Script exit code | `<0 expected>` |
| Fly app targeted | `spectre-staging` (production refused by guard) |
| Secrets set | `EMAIL_DELIVERY_MODE, MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_FROM_MAILBOX` |
| Fly release after set | `v<n>  (image <digest-tail>)` |

### D.2 -- Diagnostic confirms adapter switched

```
curl -s https://staging.spectreautomation.com/api/admin/signup/debug/status | jq .email
```

Paste the response here:

```json
{
  "mode": "<fill>",
  "microsoft365Configured": <fill>,
  "fromAddress": "<fill>",
  "effectiveAdapter": "<fill>"
}
```

Verdict: `<PASS if effectiveAdapter == "microsoft365", else FAIL>`

### D.3 -- Playwright regression

```
npx playwright test \
    tests/e2e/signup-1-acceptance.staging.spec.ts \
    tests/e2e/signup-1-conditional-acceptance.staging.spec.ts \
    tests/e2e/signup-1c-ms-button-regression.staging.spec.ts \
    tests/e2e/signup-1e-role-persistence.staging.spec.ts \
    tests/e2e/signup-1f-cross-browser-recovery.staging.spec.ts \
    --reporter=line
```

| Field | Value |
|---|---|
| Chromium project passes | `<n>/5` |
| Staging-authenticated project passes | `<n>/5` |
| Elapsed | `<m>m <s>s` |
| Verdict | `<PASS if 10 passed, else FAIL>` |

### D.4 -- Real signup walk

| Check | Value |
|---|---|
| Microsoft work account used | `<address>` |
| From on received email | `<expected: Spectre Automation <no-reply@spectreautomation.com>>` |
| Subject | `<expected: Resume your Spectre registration>` |
| Body contains /signup/r/<token> link | `<yes / no>` |
| Body states "expires in 30 minutes" | `<yes / no>` |
| Cross-browser click lands on /status for same registration | `<yes / no>` |
| Replay click returns /signup/resume?error=already_used | `<yes / no>` |

### D.5 -- Log scan

```
flyctl logs --app spectre-staging --since 10m | grep -Ei "signup\.resume_email|signup\.recovery_link"
flyctl logs --app spectre-staging --since 10m | grep -E "signup/r/[A-Za-z0-9_-]{20,}|resumeToken|recoveryToken"
```

| Check | Value |
|---|---|
| First grep shows masked emails + ID tails + providerMessageId only | `<yes / no>` |
| Second grep returns zero matches | `<yes / no>` |
| Verdict | `<PASS / FAIL>` |

### D.6 -- Mailbox-integration regression

| Check | Value |
|---|---|
| Signed in to staging as club admin with mailbox integration | `<yes / no>` |
| Work Intake inbox lists recent emails | `<yes / no>` |
| Delete-to-recycle still works | `<yes / no>` |
| Restore-from-recycle still works | `<yes / no>` |
| `delegatedClientIdPrefix` on diagnostic still `b7f855a6` | `<yes / no>` |
| Verdict | `<PASS / FAIL>` |

---

## Acceptance verdict

| Dimension | Verdict |
|---|---|
| Exchange Online RBAC (Phase A/B) | PASS (reported 2026-10-24) |
| Entra API permissions audit (Phase C.1) | `<PASS / FAIL>` |
| Live Graph send tests (Phase C.2) | `<PASS / FAIL>` |
| Staging adapter activated (Phase D.1 / D.2) | `<PASS / FAIL>` |
| Playwright regression (Phase D.3) | `<PASS / FAIL>` |
| Real signup round-trip (Phase D.4) | `<PASS / FAIL>` |
| Log scan (Phase D.5) | `<PASS / FAIL>` |
| Mailbox integration preserved (Phase D.6) | `<PASS / FAIL>` |

**Overall acceptance:** `<PASS if every row above is PASS, else FAIL>`

**Non-authorisations preserved:**
- Production tenant unchanged.
- SIGNUP-2 implementation not started.
- No client secret present in command-line arguments, shell
  history, source files, Fly logs, or chat.

---

## Rollback (if any dimension FAILs after Fly activation)

```
flyctl secrets unset \
    EMAIL_DELIVERY_MODE \
    MICROSOFT_TENANT_ID \
    MICROSOFT_CLIENT_ID \
    MICROSOFT_CLIENT_SECRET \
    MICROSOFT_FROM_MAILBOX \
    --app spectre-staging
```

Resets `EMAIL_DELIVERY_MODE` to the previous value (console or
unset).  The adapter falls back to the console path; signup still
functions but recovery emails are logged, not sent.
