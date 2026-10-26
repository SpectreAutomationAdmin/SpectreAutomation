# SIGNUP-2 Phase 2G — Founder Decision Package

**Audience.** Founder (non-technical).  Readable without source
code.

**Status.** Planning only.  Implementation is **not authorised**.
Signing this package authorises Claude to build Phase 2G
to the described specification.  Signing does **NOT** authorise
production deployment, live Stripe integration, real-tenant
provisioning, or Phase 2H.

**Supersedes.** `docs/signup-2-phase-2g-plan.md` (20-section
technical draft).  This decision package is the concise,
founder-facing summary derived from that draft.  The 20-section
draft remains the implementation reference once authorised.

**Phase 2F anchor.** This package assumes the mock-backed Phase
2F staging baseline (`sha-cccb190` / `v893` / image
`sha-cccb1907c6d6`) remains the rollback anchor.

---

## 0. One-line summary

Phase 2G consumes the `TenantProvisioningJob(state=CREATED)` row
Phase 2F produced and *actually* creates the Club shell + the
founding administrator User + role grants + initial accounting
setup + welcome email, ending with an **atomic Tier 2 unlock**.
Every step revalidates financial authorisation before it writes.
Any reversal mid-flight stops provisioning without destroying
work.

---

## A. Nine-step provisioning workflow

Phase 2G walks the already-shipped `TenantProvisioningJob` state
machine (Phase 2A).  Each step is implemented as an idempotent
handler.  Before every step, Phase 2G re-asks Phase 2F "is this
authorisation still valid?"  If the answer is no, the step does
not run.

| # | Step | What it writes | Idempotency key | Retry | Compensation / recovery | Financial-auth revalidation |
|---|---|---|---|---|---|---|
| 1 | `USER_CREATED` | 1 `User` row (or reuses an existing ACTIVE user with the same Microsoft identity) | `User.(microsoftOid, microsoftTenantId)` unique on upsert; job's `provisionedUserId` stamp | Up to 10 attempts, 60s × 2ⁿ backoff capped at 1 h | Collision with a DEACTIVATED/SUSPENDED user with the same Microsoft id → refuses, writes `EXISTING_USER_CONFLICT` operator alert, does not auto-reactivate | Yes — before run |
| 2 | `CLUB_CREATED` | 1 `Club` row (new slug) + 1 `ClubSubscription` row with `accessTier = STAGED` | `Club.slug` unique + job's `provisionedClubId` stamp | Same policy | Slug collision → `EXISTING_CLUB_SLUG_CONFLICT` operator alert; no overwrite | Yes |
| 3 | `ROLES_ASSIGNED` | 1 `UserClubRole` row (user × club × `CLUB_ADMIN`) | Composite unique `(userId, clubId, roleKey)` + `rolesAssignedBatchKey` stamp | Same policy | Replay is a no-op; no permission is ever elevated on a different user | Yes |
| 4 | `COA_COMMITTED` | Chart-of-Accounts import entries scoped to the new club | `committedCoaBatchKey` stamp (hash of input) | Same policy | Replay reuses the batch key; posting-guard refuses GL writes while subscription is `STAGED` | Yes |
| 5 | `OPENING_BALANCE_COMMITTED` | Opening-balance import entries | `committedOpeningBalanceBatchKey` stamp | Same policy | Same posting-guard protection | Yes |
| 6 | `BRANDING_COMMITTED` | Branding assets uploaded under a deterministic key `clubs/<clubId>/branding/...` | `committedBrandingBatchKey` stamp | Same policy | S3 uploads are idempotent by key; replay overwrites with the same bytes | Yes |
| 7 | `INVITATIONS_DELIVERED` | Queued `UserInvitation` emails sent via the SIGNUP-1G Microsoft Graph adapter | `invitationsDeliveredBatchKey` stamp + per-invitation send-id | Same policy | Each invitation carries its own send-idempotency marker; duplicate sends cannot slip through | Yes |
| 8 | `WELCOME_EMAIL_SENT` | 1 Microsoft Graph `sendMail` call | `welcomeEmailProviderMessageId` stamp | Same policy | Replay is a no-op if the message id is already stamped | Yes |
| 9 | `COMPLETED` | Atomic: `ClubSubscription.subscriptionStatus = ACTIVE` + `accessTier = FULL` + `TenantProvisioningJob.state = COMPLETED` + one `PaymentReconciliationEntry` with `entryType = "ACTIVATION_COMPLETED"` | Executed in a single `prisma.$transaction` after one last Phase 2F revalidation inside the transaction | **No retry.** A failure here rolls back the whole transaction; the operator must retry via a Phase 2H endpoint | **Yes — twice: once pre-transaction, once inside the row-lock.** |

**All step handlers:**
- Run inside a short `prisma.$transaction`.
- Mark their anchor on success so a replay is a no-op.
- Write an audit row (`signup.provisioning.<step>.success` or
  `.failed`) with tails only.
- Never delete rows on failure.

**Retry budget:** 10 attempts per job across all steps.  Beyond
that, the job transitions to `state=FAILED`, writes
`PROVISIONING_STUCK` operator alert (IMMEDIATE), and stays in
place for operator action.

---

## B. Collision handling

Collisions are refused + alerted — Phase 2G never silently takes
over an existing identity.

| Collision | Phase 2G response |
|---|---|
| Existing Club with the same slug | **REFUSE.**  `EXISTING_CLUB_SLUG_CONFLICT` alert (IMMEDIATE).  Phase 2H's operator rename UI (future) is the remediation.  Phase 2G never attaches a new signup to an existing Club. |
| Existing User with the same `(microsoftOid, microsoftTenantId)` + ACTIVE | **REUSE.**  Stamps the existing user id on `provisionedUserId`.  No new User row.  Role assignment grants the user `CLUB_ADMIN` on the NEW club only — the existing user's other memberships are untouched. |
| Existing User with the same `(microsoftOid, microsoftTenantId)` + DEACTIVATED or SUSPENDED | **REFUSE.**  `EXISTING_USER_CONFLICT` alert (IMMEDIATE).  No automatic reactivation; operator must act. |
| Existing User with the same email but DIFFERENT Microsoft identity | **REFUSE.**  `EXISTING_USER_EMAIL_CONFLICT` alert (IMMEDIATE).  Email is not treated as identity on its own; Microsoft identity is the only reliable key. |
| Two provisioning jobs for the same registration | **IMPOSSIBLE at the DB layer.**  `TenantProvisioningJob.billingCycleId` is unique.  Phase 2F refuses to create a second job for the same cycle, and Phase 2G discovers the pre-existing job via `G9_JOB_EXISTS`. |
| Two workers try to claim the same job | **PREVENTED by claim loop.**  Phase 2G reads `TenantProvisioningJob(state=CREATED, nextAttemptAt<=now)` + writes `state=IN_PROGRESS` + `attempts++` + `nextAttemptAt` under a conditional `updateMany` matching the previous state (optimistic concurrency).  Only one worker's conditional update affects a row. |
| Existing tenants that predate SIGNUP-2 (grandfathered) | **UNTOUCHED.**  Pre-SIGNUP-2 Clubs have `subscriptionStatus = null` + `accessTier = null`, which Spectre's posting-guard treats as grandfathered PASS.  Phase 2G never attaches to them and never modifies their rows.  New signups always get a new Club. |

> Founder requirement — "do not assume matching email alone
> establishes identity" — honoured: the three identity gates
> (ACTIVE Microsoft-identity match, DEACTIVATED Microsoft-identity
> match, same-email-different-Microsoft-identity) are evaluated
> separately and only the first produces a reuse.

---

## C. Financial-reversal handling

Phase 2G revalidates Phase 2F's authorisation before every step
by calling `validateActivationAuthorisation(jobId)` (the
read-only revalidation function Phase 2F ships).  Any
revalidation failure routes the job to cancellation — not to
retry.  Behaviour at each stage:

### C.1 Reversal detected BEFORE provisioning begins

- Phase 2G's claim loop calls revalidation.  Revalidation sees
  the cycle is `reversedAt != null` and returns `ok: false,
  reason: G2_REVERSED`.
- Phase 2G never advances the job past `CREATED`.
- Job transitions to `CANCELLED(reason: pre-step revalidation
  refused, gate: G2_REVERSED)`.
- Operator inbox: `PROVISIONING_REVOCATION` (IMMEDIATE).
- Owner: Phase 2G (cancellation); Phase 2F (invalidation
  write).

### C.2 Reversal detected AFTER the Club shell exists (after step 2)

- The next step's pre-run revalidation catches the reversal.
- Steps 1–2's writes are PRESERVED (idempotency anchors
  stamped).
- `provisioningCancelledAt` sentinel column (new; see §C.6) is
  stamped on the User and Club shell rows.
- `ClubSubscription.accessTier` remains `STAGED` — Tier 2 was
  never reached.
- Owner: Phase 2G (cancellation); Phase 2H (future operator
  action to clean up or retry).

### C.3 Reversal detected AFTER initial User creation (after step 1 only)

- Same as C.2 — the User row persists, no further step runs,
  `provisioningCancelledAt` is stamped on the User.
- The User has no `UserClubRole` yet (step 3 hasn't run), so
  the user holds no access to anything.

### C.4 Reversal detected IMMEDIATELY BEFORE the final Tier 2 grant

- The final-grant transaction (step 9) performs one last
  revalidation call *inside* the same transaction as the status
  flip.
- A reversal that arrives before the transaction opens → the
  inside-tx revalidation returns `ok: false` → the transaction
  aborts → `accessTier` stays `STAGED` → cancellation path
  fires.
- Owner: Phase 2G.

### C.5 Reversal detected IMMEDIATELY AFTER Tier 2 activation

- Phase 2G's final transaction committed before the reversal
  webhook landed → the Club is ACTIVE + FULL for a brief window.
- Phase 2E's existing reversal webhook handler sets
  `BillingCycle.reversedAt + subscriptionStatus = REVERSED`.
- A **separate suspension handler (Phase 2H)** then flips
  `ClubSubscription.subscriptionStatus = SUSPENDED` + reduces
  `accessTier` to a read-only Tier 1.
- Phase 2G itself does NOT un-provision; no Club, User, or role
  row is deleted.  Operator remediation (refund, reactivate,
  rename, archive) is a Phase 2H action.
- Owner: Phase 2E (reversal observation); Phase 2H (suspension
  + remediation).  Phase 2G's only post-COMPLETED responsibility
  is the DATA-PRESERVATION guarantee: nothing is destroyed.

### C.6 `provisioningCancelledAt` sentinel

Phase 2G adds one nullable column to three tables (purely
additive, same pattern as Phase 2A/2F schema deltas):

- `User.provisioningCancelledAt`
- `Club.provisioningCancelledAt`
- `ClubSubscription.provisioningCancelledAt`

The sentinel marks a row as "created by a cancelled provisioning
job; Phase 2H may reclaim or retire me."  Posting-guard refuses
GL writes on rows with the sentinel set.  Zero backfill is
required — pre-SIGNUP-2 rows start null and stay null.

### C.7 Ownership summary

| Responsibility | Phase 2E | Phase 2F | Phase 2G | Phase 2H |
|---|---|---|---|---|
| Observe reversal (webhook) | Yes | — | — | — |
| Write `BillingCycle.reversedAt + subscriptionStatus=REVERSED` | Yes | — | — | — |
| Invalidate the authorisation (`TenantProvisioningJob.invalidatedAt`) | — | Yes | — | — |
| Cancel the provisioning job (`TenantProvisioningJob.cancelledAt + cancelReason`) | — | — | **Yes** | Via Phase 2G's cancel endpoint |
| Stamp `provisioningCancelledAt` sentinel on touched rows | — | — | **Yes** | — |
| Suspend an ACTIVE subscription post-reversal | — | — | — | Yes |
| Rename / archive / refund / retry | — | — | — | Yes |

---

## D. Final access activation (serialisation against reversal)

Phase 2G's final step 9 is engineered to make it impossible for
a stale Phase 2F authorisation to grant Tier 2.  The sequence:

```
Phase 2G step 9 (atomic Tier 2 grant):

  1. OPEN prisma.$transaction (short-lived, SERIALIZABLE on Postgres)
  2. Row-lock BillingCycle (select ... for update)
  3. Row-lock TenantProvisioningJob
  4. Call validateActivationAuthorisation(jobId) ONE LAST TIME
     ← reads inside the locks; sees any reversal/invalidation
       that landed in the previous milliseconds
  5. If not ok → ROLLBACK the transaction → cancellation path
  6. Otherwise:
     update ClubSubscription
       set subscriptionStatus = "ACTIVE",
           accessTier = "FULL",
           firstSettlementAt = cycle.settlementConfirmedAt
       where clubId = provisionedClubId
     update TenantProvisioningJob
       set state = "COMPLETED",
           completedAt = now()
       where id = jobId
     insert PaymentReconciliationEntry (entryType = "ACTIVATION_COMPLETED")
  7. COMMIT
  8. (Outside the transaction) emit audit + welcome notification
```

### Why this serialises against reversal

- Phase 2E's reversal webhook handler takes the same row-lock on
  `BillingCycle` before writing `reversedAt + subscriptionStatus
  = REVERSED`.
- Phase 2F's `invalidateActivationAuthorisation` uses a
  conditional `updateMany` on `invalidatedAt IS NULL`, which
  blocks on the same `TenantProvisioningJob` row-lock.
- Three outcomes are possible:
  1. Reversal lands BEFORE step 9 opens → step 4's revalidation
     returns `ok: false` → transaction aborts → `accessTier`
     stays `STAGED`.
  2. Reversal lands DURING step 9 → the reversal blocks on
     the row-lock until step 9 commits → reversal then flips
     the subscription state → Phase 2H's suspension handler
     fires.
  3. Reversal lands AFTER step 9 commits → same as #2.

### Preventing a stale authorisation from activating

A stale authorisation is one where Phase 2F wrote the job hours
ago and conditions have since changed.  Three defences:

1. **Authorisation TTL.**  Phase 2F stamps
   `authorisationExpiresAt = now + 15 min`.  Every revalidation
   call checks it.  If the TTL has elapsed, revalidation
   returns `AUTHORISATION_EXPIRED` and Phase 2G cancels the
   job.
2. **Per-step revalidation.**  Even inside the 15-min window,
   every step re-asks Phase 2F.  A reversal in the 10th minute
   is caught before the 11th step runs.
3. **Inside-tx revalidation at step 9.**  The last check runs
   inside the final transaction's row-locks, which closes the
   window between the pre-step check and the state flip.

### Club-shell creation versus operational activation

- **Club-shell creation (step 2):** writes a `Club` row + a
  `ClubSubscription` row with `accessTier = STAGED`.  Spectre's
  posting-guard refuses GL writes, payroll posting, member
  billing, and member-portal visibility while `accessTier =
  STAGED`.  The shell exists for the subsequent steps to
  attach rows to — not for anyone to use.
- **Operational activation (step 9):** flips `accessTier = FULL`
  and sets `subscriptionStatus = ACTIVE`.  Only now does
  posting-guard allow operational writes.  Only now does the
  member portal become addressable at the club's slug.

The two states are **separate columns**, never derived from
each other.  Pre-step revalidation + the final transaction
guarantee the second flip never occurs without current
Phase 2F authorisation.

---

## E. Mock-evidence isolation (Phase 2G layer)

Phase 2F already enforces mock isolation at the authorisation
boundary — mock evidence CAN produce a `TenantProvisioningJob`
only when BOTH `?testOnly=1` on the sweep AND the staging-only
env `SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP=1` are set, and the
job's `authorisationEvidenceSource` records `"mock-stripe"`.

Phase 2G enforces mock isolation **again, independently** at the
provisioning boundary:

- Phase 2G reads `TenantProvisioningJob.authorisationEvidenceSource`
  on every tick.
- If `authorisationEvidenceSource === "mock-stripe"` AND
  `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING !== "1"`,
  Phase 2G REFUSES to run the job + writes an operator alert.
- Production containers never set
  `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING`.  The staging
  acceptance window sets it, then unsets it (same pattern as
  Phase 2F).
- Phase 2G does NOT rely on the Phase 2F feature flag, the
  Phase 2F testOnly scope, or the caller to assert mock
  isolation.  The check is at every tick.

**Why two independent gates?**
Defence in depth.  A compromised Phase 2F path cannot bypass
Phase 2G's gate; a compromised Phase 2G path cannot bypass
Phase 2F's.  Both gates must fail OPEN simultaneously for a
mock job to provision — which is impossible without two
separate staging-only env vars.

### Fixture identification + removal

- Fixture Clubs: slug prefix `signup-2g-fixture-*` +
  `stagingDataMode = "SYNTHETIC_DEMO"`.
- Fixture Users: email prefix
  `signup-2g-fixture-*@spectre.test`.
- Fixture staging-only ToS doc: label
  `ToS-staging-acceptance-2026-10-26-*` (same mechanism Phase
  2F uses).
- Fixture teardown (same pattern as Phase 2F's
  `phase2f-super-admin-teardown` / `phase2f-teardown`):
  guaranteed to run on pass or fail via Playwright
  `test.afterAll`, confirmed by a post-teardown row count of
  zero fixture-prefixed rows.

---

## F. Outstanding founder decisions (consolidated)

The 20-section plan lists 10 open items.  I've consolidated them
into decisions, each with options, a recommendation, operational
implications, and whether they block implementation starting.

| # | Decision | Options | Recommended default | Operational implications | Blocks START? | Blocks PRODUCTION activation? |
|---|---|---|---|---|---|---|
| **D1** | Welcome email provider | (a) Reuse SIGNUP-1G's Microsoft Graph `sendMail` adapter.  (b) Build a new transactional-mail path. | **(a) Reuse.** | Reuses the dedicated transactional-mail Entra app + the Exchange RBAC already configured for SIGNUP-1G.  Lowest-risk, no new credentials. | No | No |
| **D2** | Welcome email template | (a) Minimal placeholder ("Welcome to <Club>; sign in at <link>").  (b) Polished template requiring design input. | **(a) Minimal.**  Polish deferred to a design slice. | Lets Phase 2G land without blocking on design.  Live-tenant launch will swap the template. | No | No (minimal template is live-safe but boring) |
| **D3** | Founding admin's starting role | (a) `CLUB_ADMIN`.  (b) `GENERAL_MANAGER`.  (c) New custom `CLUB_FOUNDER` role with narrower scope. | **(a) `CLUB_ADMIN`.** | Matches existing admin surfaces; needs no RBAC changes.  Operator can promote later via existing UI. | No | No |
| **D4** | Collision policy | (a) Hard refusal + operator alert (recommended).  (b) Auto-reactivate DEACTIVATED users on Microsoft-identity match.  (c) Auto-rename slug on collision. | **(a) Hard refusal.** | Auto-reactivation is a security risk — a deactivated user whose Microsoft identity is reused by a different person could be silently restored.  Auto-rename could land a club at an unexpected URL.  Operator alert is the safe default. | No | **Yes if (b).**  (b) requires a separate security review before production. |
| **D5** | Mock-isolation env-var naming | (a) `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING` (recommended, mirrors Phase 2F).  (b) A shorter / different name. | **(a).** | Consistent with Phase 2F; operator muscle memory is preserved. | No | No |
| **D6** | Automatic worker cron | (a) Phase 2G ships OPERATOR-TICK ONLY (one-shot HTTP POST per advance).  (b) Phase 2G ships an in-process Fly-worker cron that ticks every N minutes. | **(a) Operator-tick first.**  Add cron in a follow-on slice once the tick path is proven. | Starts narrow + reversible.  Lets Phase 2G's acceptance exercise the tick directly without stepping on a cron timer.  The TTL safeguard design in `staging-flag-ttl-safeguard-plan.md` is unrelated. | No | **Yes if (b).**  Production needs the cron to automate advance.  Separate authorisation for the cron slice. |
| **D7** | Compensation column name + scope | (a) `provisioningCancelledAt` on User + Club + ClubSubscription (recommended).  (b) Only on Club + ClubSubscription.  (c) A single row in a new `ProvisioningCompensation` table. | **(a) All three.** | Each row that Phase 2G created needs an unambiguous "do not use me yet" signal.  Centralised table (c) adds a join on every posting-guard check; sentinel column is cheaper + follows the Phase 2A pattern. | No | No |
| **D8** | Live-tenant acceptance gate | (a) Phase 2G IMPLEMENTATION can proceed mock-backed; live-tenant acceptance is gated on items 1.1-1.8 of the Phase 2E Stripe follow-up tracker.  (b) Block Phase 2G until live Stripe lands. | **(a) Mock-backed first.** | Lets provisioning architecture + rollback paths bake while the Stripe side is being procured.  Live-tenant window remains separately authorised. | No | **Yes.**  Live acceptance is itself a separate authorisation. |
| **D9** | Feature flag name | `SPECTRE_SIGNUP_2G_PROVISIONING_LIVE` — fail-closed, mirrors every prior phase. | Confirm the name. | None material. | No | No |
| **D10** | New operator-inbox categories | 7 new categories: `PROVISIONING_STUCK`, `EXISTING_USER_CONFLICT`, `EXISTING_USER_EMAIL_CONFLICT`, `EXISTING_CLUB_SLUG_CONFLICT`, `EXISTING_SUBSCRIPTION_CONFLICT`, `PROVISIONING_REVOCATION`, `PROVISIONING_COMPLETED`. | Confirm or trim. | Alerts routed to the operator inbox exist today for Phase 2D/2E/2F — the new categories just add bucket names.  Low cost. | No | No |

**Decisions that block starting implementation: NONE.**  You can
authorise Phase 2G to be built against the recommended defaults.

**Decisions that gate production activation:** D4 (if you pick
auto-reactivate), D6 (if you want cron on day one), D8 (always —
live-tenant acceptance requires the Stripe side).

---

## 1. Scope reminder (unchanged)

### Phase 2G ships

- The 9 step handlers (§A).
- The pre-step revalidation gate (§C).
- The atomic final-grant transaction (§D).
- The cancellation protocol + `provisioningCancelledAt`
  sentinel columns (§C.6).
- Operator diagnostics endpoint
  (`GET /api/admin/signup-ops/provisioning/[jobId]`,
  super-admin gated, read-only, audited).
- Operator-tick endpoint
  (`POST /api/admin/signup-ops/provisioning-tick`, super-admin
  gated, fail-closed on the Phase 2G flag).
- Fail-closed feature flag `SPECTRE_SIGNUP_2G_PROVISIONING_LIVE`.
- Mock-isolation env var
  `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING`.
- Contract tests (≥ 7 suites; ≥ 80 assertions).
- Playwright staging acceptance (6+ scenarios, same pattern as
  Phase 2F — synthetic SUPER_ADMIN, staging-only ToS fixture,
  controlled flag window, guaranteed teardown).

### Phase 2G does NOT ship

- Live Stripe calls (mock-only in Phase 2G baseline).
- Automatic worker cron (deferred — operator-tick only).
- Rich operator remediation UI (Phase 2H).
- Welcome email template polish (separate design slice).
- Renewal cycles or new-mandate flow (later slice).
- Member-portal public release (separate operator action
  unlocks public visibility after Tier 2 is granted).

### Non-authorisations (preserved from the authorisation email)

- No live Stripe.
- No production deploy.
- No existing-tenant modification.
- No gov-ID collection.
- No Phase 2H / 2I initiation.

---

## 2. How Phase 2G acceptance will prove it works

Six Playwright scenarios on deployed staging, under a controlled
Phase 2G flag window (same shape as Phase 2F):

| # | Name | What it proves |
|---|---|---|
| A | Full 9-step happy path | A mock-backed job progresses to COMPLETED + ClubSubscription flips to ACTIVE + accessTier = FULL + welcome email `sendMail` fired. |
| B | Revalidation refusal mid-chain | Seed a job; tick through 3 steps; trigger a Phase 2F `invalidateActivationAuthorisation`; next tick cancels. |
| C | Reversal mid-provisioning | Seed a job; tick through steps; trigger a BillingCycle reversal; next tick cancels. |
| D | Collision refusal | Pre-seed a DEACTIVATED user with the same Microsoft identity; tick refuses step 1 + alert. |
| E | Mock-isolation refusal | Deployed container WITHOUT the testOnly env var → operator-tick refuses the mock-backed job. |
| F | Fail-closed flag | `SPECTRE_SIGNUP_2G_PROVISIONING_LIVE` unset → operator-tick returns 503. |

Every fixture row is staging-only, SYNTHETIC_DEMO, and torn down
in `test.afterAll` regardless of pass/fail.

---

## 3. What signing this package authorises

If you reply **"Phase 2G AUTHORISED to implement per decision
package"** (or an equivalent explicit phrase) and specify a
value for each of D1–D10 (or "accept recommended default"), I
will:

1. Build the 9 step handlers + worker claim loop.
2. Ship the pre-step revalidation gate + the atomic final-grant
   transaction.
3. Ship the operator-tick + diagnostic endpoints.
4. Ship the contract tests + the staging-acceptance Playwright
   spec with the 6-scenario shape.
5. Ship the schema migration for the three
   `provisioningCancelledAt` columns + 7 operator inbox
   categories.
6. Ship the feature flag + mock-isolation env var scaffolding.
7. Deploy to `spectre-staging` via DRH-1.
8. Run the Playwright acceptance under a controlled flag window.
9. Flip flags OFF after acceptance and record the window.
10. Deliver a Phase 2G acceptance evidence document in the same
    shape as `docs/signup-2-phase-2f-staging-acceptance.md`.

I will NOT, under this authorisation:

- Deploy to production.
- Call live Stripe.
- Create a real applicant's tenant.
- Modify an existing tenant.
- Grant Tier 2 to any user outside the acceptance fixture.
- Introduce gov-ID collection.
- Begin Phase 2H.

---

## 4. What you give up if you decline

- Phase 2F remains the mock-backed baseline it is now.
- The live-signup pipeline cannot progress past Phase 2F's
  `TenantProvisioningJob(state=CREATED)` row.
- The architecture + mock-backed acceptance evidence remain
  intact and reusable.

Declining has zero destructive effect.  You can authorise later
without rework.

---

## 5. Reference material

- `docs/signup-2-phase-2g-plan.md` — 20-section technical draft
  (implementation specification).
- `docs/signup-2-phase-2f-acceptance.md` — Phase 2F contract
  baseline.
- `docs/signup-2-phase-2f-staging-acceptance.md` — Phase 2F
  deployed Playwright evidence.
- `docs/staging-flag-ttl-safeguard-plan.md` — separate narrow
  safety improvement, unauthorised, mentioned here only because
  Phase 2G acceptance will produce another controlled flag
  window.
- `docs/signup-2-phase-2e-stripe-followup.md` — the Stripe
  follow-up tracker whose items 1.1–1.8 gate live-tenant Phase
  2G acceptance (not implementation).

---

**End of founder decision package.**
