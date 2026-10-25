# SIGNUP-1G -- Outstanding Untested Scopes (separately tracked)

**Status.** SIGNUP-1G accepted on staging per founder's 2026-10-25
message.  Two end-to-end validation steps were explicitly NOT
executed by SIGNUP-1G acceptance; the founder directed that they
remain separately tracked, with their untested scope clearly
documented, rather than silently expanded into SIGNUP-1G.

**Preserve the accepted baseline.**  Nothing in this document
reopens SIGNUP-1G implementation.  These items are confidence-
strengtheners, not blockers.

---

## 1 Real Microsoft work-account signup walkthrough (end-to-end UI)

### What SIGNUP-1G acceptance did verify

- **Phase C.2 live Microsoft Graph send test** (founder-run,
  2026-10-25): a real email from the dedicated transactional-mail
  app's credentials, delivered through Microsoft Graph, arrived
  at the founder's Outlook inbox.  This proves the Spectre
  Transactional Mail Entra app -> Microsoft Graph `/sendMail` ->
  real inbox pipeline.
- **Phase D.3 Playwright regression** (automated, 2026-10-25):
  `signup-1c-ms-button-regression` walks the real UI, clicks the
  Microsoft sign-in button, and asserts the browser navigates to
  `login.microsoftonline.com/organizations/oauth2/v2.0/authorize`
  with identity-only scopes.  Does NOT drive the Microsoft
  consent screen.
- **Phase D.4 live Fly logs** (automated, 2026-10-25):
  `signup.resume_email.sent` events recorded two real Microsoft
  Graph `providerMessageId` UUIDs during the regression, proving
  the microsoft365 adapter was invoked at send time (not console
  fallback).

### What is still untested

A single, uninterrupted real-world UI walk:

1. Open `https://staging.spectreautomation.com/signup` in a fresh
   browser.
2. Complete Screen 1 with any plausible Club identity.
3. Click **Sign in with Microsoft**, complete real OAuth consent
   with a Microsoft work account whose primary email the operator
   receives mail on.
4. Confirm within ~60 s that the recovery email arrives from
   `Spectre Automation <no-reply@spectreautomation.com>`.
5. In a DIFFERENT browser (different vendor if practical), click
   the recovery link within 30 min.  Confirm it lands on the
   status page for the SAME registration.
6. In a THIRD browser, click the same email link.  Confirm it
   returns `/signup/resume?error=already_used`.

### Why Playwright does not cover it

- Microsoft's OAuth consent screen (login.microsoftonline.com)
  intentionally cannot be driven headlessly: MFA + anti-automation
  controls block Playwright.
- No test harness in the repo currently holds a real Microsoft
  work-account credential + MFA bypass.
- The founder is the only person who can satisfy the real-identity
  path end-to-end.

### Risk if it stays untested

Low.  The component-level proofs in Phase C.2 and D.4 together
cover the subcomponents that would be exercised by this walk:

- Microsoft OAuth sign-in (verified via `signup-1c-ms-button-regression`).
- Spectre -> Graph -> real inbox (verified in Phase C.2 with the
  founder's confirmed Outlook delivery).
- Recovery-link single-use + replay rejection (verified via
  `signup-1f-cross-browser-recovery` + the deterministic expiry
  spec committed in sha-fb604f9).

A failure in the end-to-end walk would manifest as a failure in
one of those components; each component has its own regression.

### When to execute

Opportunistic.  Any time the founder onboards a new Microsoft
work-account identity (e.g. during a future SIGNUP-2 phase that
provisions a new Spectre operator), this walk can piggy-back the
onboarding.

If a specific defect report surfaces that this walk would catch,
it jumps to blocker status; otherwise it remains an opportunistic
strengthener.

---

## 2 Outlook -> Spectre delete-sync convergence

### What SIGNUP-1G acceptance did verify

- **Phase D.6 configuration preservation** (2026-10-25):
  diagnostic shows `delegatedClientIdPrefix=b7f855a6` unchanged;
  `mailboxRedirectUri` present; `MICROSOFT_GRAPH_DELEGATED_*` Fly
  secret digests unchanged pre- and post-D.1.
- **Phase D.6 regression preservation**:
  `signup-1c-ms-button-regression` continues to drive the
  `b7f855a6` delegated OAuth app's `/authorize` endpoint; passes
  on both Playwright projects.
- **Phase D.6 Work Intake probe** (`signup-1g-mailbox-integration-probe.staging.spec.ts`,
  sha-fb604f9): the Work Intake admin page loads for an
  authenticated founder session; `wi-hero-greeting` and
  `wi-hero-sync` are visible; zero 5xx responses + zero uncaught
  page errors during load.

### What is still untested

A real Outlook-to-Spectre delete convergence walk:

1. Sign in to staging as a club admin whose Microsoft mailbox is
   connected to Spectre (Coulee Ridge admin + Microsoft mailbox).
2. Open Work Intake -> Inbox; note a specific recent message
   row.
3. In Outlook (web or desktop), delete that same message from the
   mailbox.
4. Return to Work Intake.  Confirm the row disappears
   **automatically**, within the live-sync window, **without
   clicking Refresh**.
5. Restore the message in Outlook; confirm the row reappears
   automatically.

The historical defect: previously the row persisted in Work
Intake until the user clicked a manual Refresh button.
WI-SYNC-1a..1i (closed 2026-10) addressed this with Graph change
notifications + `OutlookDeleteMutation` / `OutlookRestoreMutation`
models + worker-driven feed convergence.

### Why automation does not cover it

- Driving Outlook (web OR desktop) from Playwright is impractical
  (Outlook web is cross-origin + MFA-gated; Outlook desktop isn't
  a web app at all).
- The test harness has no deterministic hook to inject a
  "delete-from-Outlook" event other than operating on the real
  Graph API, which requires the delegated-mailbox-integration
  Entra app's client-credentials + a verifiable test mailbox.
- A synthetic test that writes directly to
  `OutlookDeleteMutation` bypasses the Graph-notification side
  of the sync pipeline (defeats the purpose).

### Risk if it stays untested

Medium.  The WI-SYNC-1 series proved the convergence pipeline
works under its own test harness (Graph change notifications,
delete-mutation worker, restore-mutation worker, feed-sync).
SIGNUP-1G changes did not touch any WI-SYNC code; the probe in
sha-fb604f9 proves the Work Intake code paths still load + the
delegated OAuth secrets are unchanged.

A regression in Outlook-to-Spectre delete-sync that didn't
originate in the WI-SYNC code would require an environmental
change (Microsoft Graph notification configuration, Fly
networking) rather than a code change -- an unlikely but
possible class of failure.

### When to execute

- Any time a founder-driven onboarding of a new Microsoft mailbox
  integration happens (natural piggy-back).
- Any time a defect report arrives mentioning "deleted in Outlook
  but still showing in Spectre" (jumps to blocker).
- Otherwise, every ~quarterly as a healthcheck.

### Separate from SIGNUP-1G

If this walk reveals a regression, it is a WI-SYNC-family defect,
not a SIGNUP-1G defect, and should be filed as such.  SIGNUP-1G
only wrote new transactional-mail code paths and recovery-link
code paths; it did not modify any WI-SYNC code.

---

## 3 Tracking cadence

- This document stays in the repo as the canonical registry of
  SIGNUP-1G's known-untested scope.
- Updated when either walk is executed (record who / when /
  outcome / any defect found).
- Linked from `~/.claude/projects/c--dev-SpectreAutomation/memory/project_signup_1g_accepted.md`.

---

## 4 What this document is NOT

- NOT a SIGNUP-1G reopener.
- NOT a reason to delay SIGNUP-2.
- NOT a defect report.  No defect was reproduced in either scope.
- NOT a commitment to execute either walk on a fixed timeline.
