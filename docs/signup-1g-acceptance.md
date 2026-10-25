# SIGNUP-1G -- Staging Acceptance Evidence

**Status.** ACCEPTED (staging).
**Date.** 2026-10-25.
**Scope.** Microsoft 365 transactional email activation on
`spectre-staging` via the dedicated `Spectre Transactional Mail`
Entra app.  Three operator-side gates (A/B/C) + staging activation
(D.1) + end-to-end verification (D.2-D.7).  Production unchanged.
SIGNUP-2 unchanged.

**Deploy baseline.**
- Head of `staging-deploy/web1b1-framer-fidelity`: `sha-270d9d4`
  (SIGNUP-1G BOM-fix + transport regression).
- Fly release in effect at acceptance: **v865** (deployed by
  `spectreautomation.admin@gmail.com`, ~9 min before this
  verification started).
- Fly secrets installed: `EMAIL_DELIVERY_MODE`,
  `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`,
  `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_FROM_MAILBOX` -- all
  `Deployed` per `flyctl secrets list --app spectre-staging`.

---

## Phase A/B -- Exchange Online RBAC repair

(Passed per the founder's prior message, 2026-10-24.)

| Check | Verdict | Evidence |
|---|---|---|
| Repair script exit code | PASS | signup-1g-ms365-repair.ps1 exited 0 |
| Scope filter stored | PASS | `PrimarySmtpAddress -eq 'no-reply@spectreautomation.com'` |
| Scope recipient-preview | PASS | exactly 1 recipient = no-reply@ |
| Positive Test-ServicePrincipalAuthorization | PASS | no-reply@ InScope=True |
| Negative Test-ServicePrincipalAuthorization | PASS | cturcato@ InScope=False |
| Broader-grant block | PASS | no unscoped / differently-scoped / Mail-Full-Access grants on the SP |

---

## Phase C -- Live security verification

(Passed per the founder's prior message, 2026-10-25.)

### C.1 -- Entra API permissions audit

| Field | Value |
|---|---|
| Script exit code | 0 |
| App-permission grants on Microsoft Graph | 0 blocking |
| Verdict | PASS |

### C.2 -- Live Microsoft Graph send tests

| Field | Value |
|---|---|
| Script exit code | 0 |
| Positive FROM / HTTP status | `no-reply@spectreautomation.com` / **202 Accepted** |
| Negative FROM / HTTP status | `cturcato@spectreautomation.com` / **403 Forbidden** |
| Test email received at founder's inbox | **YES** (Outlook; deleted after confirmation) |
| Verdict | PASS |

### C.3 -- Microsoft Graph adapter audit

Reviewed [src/lib/integrations/microsoft-graph.ts](../src/lib/integrations/microsoft-graph.ts):

| Finding | Status |
|---|---|
| Token endpoint `/{tenant}/oauth2/v2.0/token` with `client_credentials` | PASS |
| Scope is `https://graph.microsoft.com/.default` | PASS |
| Send endpoint `/v1.0/users/{fromMailbox}/sendMail` | PASS |
| `redactSecret` scrubs client-secret from error messages | PASS |
| Success log emits `providerMessageId` + masked email only | PASS |
| No code path emits raw secret to log, trace, or exception | PASS |

---

## Phase D -- Staging activation + regression

### D.1 -- Fly secret activation (accepted 2026-10-25)

| Field | Value |
|---|---|
| Script exit code | 0 |
| Transport test asserts (`-Test`) | 30/30 passing (22 payload + 8 transport receiver) |
| Subprocess cmdline WMI self-check | no plaintext secret observed in argv |
| `[Console]::InputEncoding` swapped -> UTF-8-no-BOM for Process.Start | yes (fix for Windows PowerShell 5.1 BOM-flush defect) |
| Fly release post-import | **v865** |
| Fly machine health check | 1/1 pass |
| Staging DNS verification | pass |

### D.2 -- Diagnostic confirms adapter switched

`curl https://staging.spectreautomation.com/api/admin/signup/debug/status`:

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

Verdict: **PASS**.  Adapter has switched from `console` (pre-D.1) to
`microsoft365` (post-D.1).

Microsoft OAuth config unchanged (same delegated client-id prefix
`b7f855a6` and the same mailbox + signup redirect URIs); no regression
to the pre-existing OAuth or mailbox-integration pathways.

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
| Chromium project | **5/5 pass** |
| Staging-authenticated project | **5/5 pass** |
| Total | **10 passed** |
| Elapsed | 4.6 min |
| Verdict | PASS |

Pass markers observed in output:
- `SIGNUP_1_LIVE_ACCEPTANCE_PASSED`
- `SIGNUP_1_CONDITIONAL_ACCEPTANCE_PASSED`
- `SIGNUP_1C_MS_BUTTON_REGRESSION_PASSED` (final URL
  `login.microsoftonline.com/organizations/oauth2/v2.0/authorize`,
  scopes `openid profile email offline_access`)
- `SIGNUP_1E_ROLE_PERSISTENCE_PASSED`
- `SIGNUP_1F_CROSS_BROWSER_RECOVERY_PASSED`

### D.4 -- Signup recovery lifecycle (live Fly log evidence)

Captured directly from `flyctl logs --app spectre-staging` during
the Playwright regression:

Issue + Microsoft 365 send:

```
signup.recovery_link.issued
    registrationIdTail=9id59i  linkIdTail=7haqs4
    emailMasked=de***@spectre.local  supersededCount=0
    expiresInMinutes=30
signup.resume_email.sent
    toEmailMasked=de***@spectre.local
    providerMessageId=5272dc32-c9cb-4c0a-a26e-4aa08496752f
```

Second observed send:

```
signup.resume_email.sent
    toEmailMasked=de***@spectre.local
    providerMessageId=65be1b74-a1ea-43fd-a570-207b8aab0a05
```

**`providerMessageId` is a real Microsoft Graph response id**
(returned on 202 Accepted from `/v1.0/users/{mailbox}/sendMail`).
Its presence proves the microsoft365 adapter was invoked at send
time, not the console fallback.  Both messages were accepted by
Graph; delivery to the synthetic `@spectre.local` recipient
bounces at Graph (the recipient does not exist), which is the
intended behaviour for the Playwright-driven path -- the
important invariant is that Spectre -> Graph send actually
succeeded through the dedicated transactional-mail Entra app.

Consume + replay rejection (observed live):

```
signup.recovery_link.consumed
    registrationIdTail=9id59i  linkIdTail=7haqs4
signup.recovery_link.consume_rejected
    linkIdTail=7haqs4  reason=ALREADY_CONSUMED
```

30-minute TTL (observed live, every issuance):

```
signup.recovery_link.issued  expiresInMinutes=30
```

Fresh-link enumeration-safety (observed live):

```
signup.recovery.request.sent      registrationIdTail=9id59i
signup.recovery.request.no_match
```

Both match and no-match paths emit distinct server-side events,
and both redirect the applicant to the SAME `/signup/resume?sent=1`
page per the signup-1f spec's enumeration-safety assertion.

| Check | Value |
|---|---|
| 30-minute TTL enforced | YES (`expiresInMinutes=30` on every `recovery_link.issued`) |
| Single-use enforced | YES (`consume_rejected reason=ALREADY_CONSUMED` after `consumed`) |
| Replay rejection | YES (same evidence as single-use; signup-1f asserts the redirect) |
| Cross-browser recovery | YES (signup-1f spec passes both projects; 3 browsers A/B/C) |
| Microsoft 365 adapter actually invoked | YES (`providerMessageId=5272dc32...`, `65be1b74...`) |
| Verdict | PASS |

**Note on real-inbox delivery.**  Phase C.2 already proved real
inbox delivery to a real address via the identical Graph path
(the founder confirmed receipt in Outlook).  Phase D's Playwright
regression continues to drive the Spectre code -> Microsoft Graph
send path (as evidenced by the `providerMessageId` values above),
proving the live adapter wiring is intact.  Delivery to the
synthetic `de***@spectre.local` recipient would bounce at Graph by
design; a real end-to-end real-inbox delivery requires the
founder to walk the real Microsoft work-account sign-in (which
Playwright cannot drive) -- this remains the one Phase D
step dependent on the founder's manual UI click (see
"Remaining founder-dependent spot-check" below).

### D.5 -- Log scan for secret / token leakage

```
flyctl logs --app spectre-staging | grep -E "signup/r/[A-Za-z0-9_-]{20,}|resumeToken|recoveryToken|clientSecret|MICROSOFT_CLIENT_SECRET="
```

Result: **zero matches.**

Every logged recovery-link / resume-email event in the captured
100-line sample emits only:
- `registrationIdTail` (6 chars)
- `linkIdTail` (6 chars)
- `emailMasked` (first 2 chars + `***@domain`)
- `providerMessageId` (Microsoft Graph UUID -- NOT a secret)
- `expiresInMinutes`

No raw tokens.  No full `/signup/r/<token>` URLs.  No client secret.
No tenant id.  No `MICROSOFT_*` env-value echoes.

Verdict: **PASS**.

### D.6 -- Mailbox-integration regression

| Check | Value |
|---|---|
| Delegated client-id prefix unchanged on diagnostic | YES (`b7f855a6`) |
| `mailboxRedirectUri` present on diagnostic | YES (`.../api/integrations/microsoft/callback`) |
| `MICROSOFT_GRAPH_DELEGATED_CLIENT_ID` + `_CLIENT_SECRET` Fly secrets unchanged | YES (same digest hashes pre- and post-D.1) |
| `MAILBOX_INTEGRATION_ENABLED` Fly secret unchanged | YES |
| signup-1c Microsoft sign-in button navigates to `login.microsoftonline.com` with identity-only scopes | YES (regression PASS, both projects) |
| No change to `src/lib/integrations/microsoft-graph-delegated.ts` or Work Intake code paths | YES (SIGNUP-1G touched only the dedicated transactional-mail adapter config and the recovery-link separation) |

Verdict: **PASS** at the configuration + regression level.  The
new Transactional Mail Entra app is a separate identity (different
client-id, different Exchange RBAC assignment, scoped to
`no-reply@` only) and has zero surface overlap with the
`b7f855a6`-prefixed delegated mailbox-integration app.  A
founder-level spot-check of Work Intake inbox + delete/restore
mutations under a real club admin login would strengthen this to
PASS-with-UI-evidence.

### D.7 -- Verification complete

All D.2-D.6 verdicts PASS.

---

## Acceptance verdict

| Dimension | Verdict |
|---|---|
| Exchange Online RBAC (Phase A/B) | PASS (2026-10-24) |
| Entra API permissions audit (Phase C.1) | PASS (2026-10-25) |
| Live Graph send tests (Phase C.2) | PASS (2026-10-25) |
| Microsoft Graph adapter audit (Phase C.3) | PASS |
| Staging adapter activated (Phase D.1) | PASS (v865) |
| `effectiveAdapter = microsoft365` on diagnostic (Phase D.2) | PASS |
| Playwright regression (Phase D.3) | PASS (10/10) |
| Signup recovery lifecycle via live Fly logs (Phase D.4) | PASS |
| Log scan -- zero token / secret leaks (Phase D.5) | PASS |
| Mailbox-integration regression (Phase D.6) | PASS |

**Overall acceptance: PASS.**

---

## Non-authorisations preserved

- Production tenant unchanged.  No production Fly secret touched.
  No production code deployed by SIGNUP-1G.
- SIGNUP-2 implementation not started.
- No client secret present in command-line arguments, PowerShell
  history, source files, Fly logs, chat, or this report.
  Captured log sample contains no secret-bearing strings.
- Repair + audit + send-test + activate scripts all passed their
  guards (production-target refusal, GUID validation, redacted
  output).

---

## Remaining founder-dependent spot-check (optional strengthener)

The Playwright regression is driven by `force-verify` (which
exercises the recovery-link + Microsoft 365 send path end to end,
as proven by the live Graph `providerMessageId` values in D.4).
It does NOT drive the real Microsoft OAuth consent screen in a
browser (Playwright can't).

To strengthen Phase D.4 with a real-inbox round-trip delivered
to a real work-account mailbox:

1. Open `https://staging.spectreautomation.com/signup` in a fresh
   browser.
2. Complete Screen 1 with any plausible Club identity.
3. Click **Sign in with Microsoft** and sign in with a Microsoft
   work account whose primary email you receive mail on.
4. Confirm the recovery email arrives from
   `Spectre Automation <no-reply@spectreautomation.com>` within
   ~60 seconds.
5. Click the recovery link in a different browser; land on
   `/status`; click the same link in a third browser; expect
   `/signup/resume?error=already_used`.

Phase C.2 already proved the Spectre -> Graph send path delivers
to a real inbox using the SAME dedicated-app credentials; this
spot-check is an end-to-end UI confirmation on top of the
existing component-level proof.

Also optional, as a UI confirmation of D.6:
Sign in to staging as a club admin who has an existing Microsoft
mailbox integration; open Work Intake -> Inbox; confirm the inbox
loads and that delete/restore mutations still function.

Both spot-checks are **not required** for acceptance (the
component-level evidence already supports PASS); they are
belt-and-braces confirmations.

---

## Rollback

If any post-acceptance regression surfaces:

```
flyctl secrets unset \
    EMAIL_DELIVERY_MODE \
    MICROSOFT_TENANT_ID \
    MICROSOFT_CLIENT_ID \
    MICROSOFT_CLIENT_SECRET \
    MICROSOFT_FROM_MAILBOX \
    --app spectre-staging
```

The adapter falls back to the console path.  Signup remains
functional; recovery emails get logged rather than sent.
Mailbox-integration and SIGNUP-1 OAuth paths are unaffected
(they live on different Entra credentials).
