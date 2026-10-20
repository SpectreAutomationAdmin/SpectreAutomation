# Post-Configuration Email Verification Checklist

**Context.** Spectre is wired for Microsoft 365 Graph transactional
email in staging as of SIGNUP-1G.  Real delivery is gated by the
operator steps in
[docs/signup-1f-transactional-email.md](signup-1f-transactional-email.md).
Once those are complete, run this checklist to prove the end-to-end
pipeline is working correctly and that nothing adjacent regressed.

**Who runs this.** The founder, or any Spectre operator with
access to a real mailbox and a browser.  Non-technical: every
check has a copy-paste command or a URL + an expected result.

**When to run.** Immediately after the Microsoft + Fly setup in
Phases 1–5 of the transactional-email operator guide, before
declaring SIGNUP-1G acceptance complete.

**Pre-check.** Verify `effectiveAdapter` is `microsoft365`:

```bash
curl https://staging.spectreautomation.com/api/admin/signup/debug/status | jq .email
```

Expected: `"effectiveAdapter": "microsoft365"`.  If anything
else, stop and complete Phases 1–5 first.

---

## Check 1 — Delivery to a real external inbox

**Steps:**
1. Open `https://staging.spectreautomation.com/signup` in a
   browser.
2. Complete Screen 1 with any plausible Club identity.
3. Click **Sign in with Microsoft**.
4. Complete the Microsoft work-account sign-in using an identity
   whose email you actually receive mail on.
5. On the status page, note the time to the second.

**Expected (within 60 seconds of step 4):**
- An email arrives at the Microsoft-verified address.
- From: `Spectre Automation <no-reply@spectreautomation.com>`.
- Subject: `Resume your Spectre registration`.
- Body contains a `https://staging.spectreautomation.com/signup/r/<token>` link.
- Body contains the text "This link is single-use and expires in 30 minutes".

**Pass criteria:**
- ✅ Email arrives in the real inbox (not spam folder; if spam, note the SPF/DKIM check at the bottom).
- ✅ From-address is exactly `no-reply@spectreautomation.com`.
- ✅ TTL in body says "30 minutes".

---

## Check 2 — Cross-browser recovery

Confirms recovery works when the applicant moves to a different
device.

**Steps:**
1. Still signed in from Check 1 — note the browser (call it A).
2. Open a different browser (B) — different vendor if possible
   (Firefox if A was Chrome; Safari if A was Edge).  B must have
   no cookies for `staging.spectreautomation.com`.
3. In browser B, open the email received in Check 1 and click the
   recovery link.

**Expected:**
- Browser B lands on the status page for the same registration
  (same Club name).
- The role captured in A is visible in B.
- Browser B has a fresh HTTPOnly cookie set
  (`spectre_signup_resume`).

**Pass criteria:**
- ✅ Status page in B shows the SAME registration as A.
- ✅ Role is persisted (not "Pending").
- ✅ No prompt to sign in with Microsoft again.

---

## Check 3 — 30-minute expiration

Confirms the recovery link stops working after 30 minutes.

**Option A — fast check (requires `flyctl` and takes 1 minute):**
```bash
flyctl ssh console -a spectre-staging --command "node -e \"\
  const { PrismaClient } = require('@prisma/client'); \
  const p = new PrismaClient(); \
  (async () => { \
    const links = await p.signupRecoveryLink.findMany({ \
      orderBy: { issuedAt: 'desc' }, take: 5, \
      select: { issuedAt: true, expiresAt: true, consumedAt: true } \
    }); \
    for (const l of links) { \
      const d = Math.round((l.expiresAt - l.issuedAt) / 60000); \
      console.log('issuedAt=' + l.issuedAt.toISOString() + ' ttl_min=' + d + ' consumed=' + !!l.consumedAt); \
    } \
    await p.\$disconnect(); \
  })();\""
```
Expected: every row shows `ttl_min=30`.

**Option B — real timing check (takes 30+ min):**
1. Trigger a fresh send (walk Check 1 to step 4).
2. Wait 31 minutes without clicking the link.
3. Click the recovery link in the email.

**Expected (Option B):**
- Browser lands on `/signup/resume?error=expired`.
- Page renders the "This recovery link has expired" message.
- A fresh-link request form is visible on the same page.

**Pass criteria:**
- ✅ Option A rows all read 30 min, OR
- ✅ Option B: 31-minute wait produces the expired error.

---

## Check 4 — Single-use (replay) rejection

Confirms a used link cannot be reused.

**Steps:**
1. From Check 2, Browser B has already consumed the recovery link.
2. Open a third browser (C) — again different if possible, no cookies.
3. Paste the same recovery link URL from the email into C's address bar.
4. Press Enter.

**Expected:**
- Browser C lands on `/signup/resume?error=already_used`.
- Page renders "This recovery link has already been used".

**Pass criteria:**
- ✅ Second use rejected with the already-used error.
- ✅ Browser C does NOT see the status page.
- ✅ Browser B's existing session is unaffected.

---

## Check 5 — No raw recovery tokens in logs

Confirms the logging posture holds under real traffic.

**Steps (from the operator workstation, with `flyctl` configured):**
```bash
flyctl logs --app spectre-staging | grep -Ei "signup\.(resume_email|recovery_link|recovery\.)" | head -50
```

**Expected log lines (examples):**
```
signup.resume_email.sent          toEmailMasked="jd***@example.com" providerMessageId=AAMk...
signup.recovery_link.issued       registrationIdTail=5a9f3c linkIdTail=e2b108 emailMasked="jd***@example.com" supersededCount=0 expiresInMinutes=30
signup.recovery_link.consumed     registrationIdTail=5a9f3c linkIdTail=e2b108
signup.resume_token.rotated       registrationIdTail=5a9f3c
```

**Pass criteria:**
- ✅ Every logged recipient address is masked (`xx***@domain`).
- ✅ No log line contains a 32+ char token (`/[A-Za-z0-9_-]{32,}/`).
- ✅ No log line contains a full `/signup/r/<...>` URL.
- ✅ No log line contains "resumeUrl", "resumeToken", or "token".

**Scan command for raw tokens (should return zero matches):**
```bash
flyctl logs --app spectre-staging --since 30m | grep -E "signup/r/[A-Za-z0-9_-]{20,}|resumeToken|recoveryToken"
```

---

## Check 6 — Existing Microsoft mailbox integrations unaffected

Confirms the new dedicated transactional-mail Entra app did not
disturb the existing `b7f855a6…` delegated OAuth app or any club's
mailbox integration.

**Steps:**
1. Sign in to `https://staging.spectreautomation.com` as a club
   admin who has previously connected a Microsoft mailbox for
   Work Intake.
2. Navigate to Work Intake → Inbox.
3. Confirm that:
   - Recent emails list loads.
   - A delete-to-recycle action still works.
   - A restore-from-recycle action still works.
4. In parallel, check the mailbox-integration diagnostic:
   ```bash
   curl https://staging.spectreautomation.com/api/admin/signup/debug/status | jq .microsoftOAuth
   ```

**Expected:**
- Both `signupRedirectUri` AND `mailboxRedirectUri` are present
  in the response.
- `delegatedClientIdPrefix` is still `b7f855a6`.
- Work Intake inbox renders with real messages.

**Pass criteria:**
- ✅ Delegated client-id prefix unchanged.
- ✅ Mailbox integration continues to function.
- ✅ No "re-authorise your Microsoft connection" prompt appears.

---

## Check 7 — Playwright regression against the new deploy

**Steps (from the operator workstation):**
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

**Expected:** `10 passed` (5 specs × chromium + staging-authenticated).

**Pass criteria:**
- ✅ All 10 specs pass.
- ✅ No new flakes vs the SIGNUP-1F baseline.

---

## SPF / DKIM troubleshooting (if emails land in spam)

If Check 1's email arrives in spam, verify Microsoft 365's send
authentication is correctly published for `spectreautomation.com`:

```bash
dig +short TXT spectreautomation.com | grep -i spf
# Expected to include "include:spf.protection.outlook.com"

dig +short TXT selector1._domainkey.spectreautomation.com
dig +short TXT selector2._domainkey.spectreautomation.com
# Each expected to be a Microsoft-published DKIM record

dig +short TXT _dmarc.spectreautomation.com
# Expected: "v=DMARC1; p=quarantine; ..." or similar
```

If any of these are missing or point to the wrong provider, update
the Spectre DNS zone and give it up to 24 hours to propagate.
Email deliverability is a DNS-side responsibility, not a code
one.

---

## Acceptance

SIGNUP-1G email delivery is accepted when ALL of Checks 1–7
pass.  Report the result back to the founder; any failure is a
BLOCKER and must be resolved before beginning SIGNUP-2.
