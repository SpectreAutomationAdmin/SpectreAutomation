# Posting-Guard / Phase 2H Suspension Race — Investigation

**Status.** Investigation only.  No implementation under this
authorisation.  Documents the exact race flagged as Phase 2H
production launch blocker #10.

**Scope.** Read-committed race between the posting-guard's
`assertAccessTierForPosting` read and Phase 2H's
`suspendTenant` state flip.  Proposes a transaction / locking
strategy with the smallest regression surface, plus regression
tests + existing-tenant compatibility implications.

**Non-authorisation.**  Per founder §2: do NOT implement a broad
posting-system rewrite without separate authorisation.  This
document proposes the fix; the fix itself is deferred to a
separately-authorised slice.

---

## 1. The race in detail

### 1a Minimal interleaving

```
Time   Thread A (operational write)         Thread B (suspension)
----   ------------------------------        -----------------------
T0     POST /api/ar/charges/post             (idle)
       begin posting-guard call
T1       assertAccessTierForPosting(clubId)  (idle)
         → prisma.clubSubscription.findUnique(...)
         (reads at T1 under read-committed; sees:
          subscriptionStatus=ACTIVE, accessTier=FULL)
         → PASS
T2       assertNotTraining(...)              (idle)
T3       assertAllowedAction(...)            POST /api/admin/signup-ops/tenants/[id]/suspend
                                             begin suspendTenant tx
T4     (posting-guard returns)               tx: ClubSubscription.update(
         [DANGER WINDOW OPENS]                 subscriptionStatus=UNDER_REVIEW,
         caller proceeds to post the GL        accessTier=SUSPENDED_READ_ONLY)
         journal / charge / etc.             tx: TenantLifecycleTransition.create(...)
T5                                           tx: commit
                                             (TRANSITION VISIBLE TO LATER READS)
T6     Thread A writes the Charge row
       (COMMITS AFTER T5)
       [DANGER WINDOW CLOSES]
```

### 1b Why this happens

- Spectre's existing posting-guard
  (`src/lib/posting-guard/index.ts`) performs its tier read
  **inside the caller's existing transaction** (if any), **or
  outside any transaction** on routes that don't wrap writes in
  a transaction.
- Postgres' default isolation is `READ COMMITTED`.  A tier read
  at T1 does NOT lock the row; another transaction can update
  it between T1 and T6.
- Under `READ COMMITTED`, Thread A's eventual GL insert at T6
  **does not re-read the subscription row**, so the stale tier
  decision made at T1 governs the whole write.

### 1c Danger-window bound

The window from the end of the posting-guard call to the end of
the write transaction is small:

- Simple routes (single-row insert + audit): ~ 10-100 ms.
- Posting routes (journal + ledger + audit, often inside their
  own transaction): ~ 50-500 ms.
- Pathological routes (bulk imports): seconds, occasionally
  tens of seconds.

**For single-row posts the race is bounded at the millisecond
scale.** For bulk importers (COA import, opening balance
import, payroll bulk run) the window reaches multiple seconds
— the practical risk is highest on bulk paths.

Suspension itself is also a short operation (one row update +
one row insert in a single tx; ~ 20-80 ms typical).

### 1d Why Phase 2H's own transaction doesn't fix it

Phase 2H already wraps `suspendTenant` in a short
`prisma.$transaction`.  That protects:

- The suspension itself (atomic flip + lifecycle row).
- Any OTHER operation that READS the subscription row **inside
  the same tx scope**.

It does NOT protect:

- An operation that read the row OUTSIDE a tx (plain
  `prisma.clubSubscription.findUnique`) and will write without
  re-reading.
- An operation that read inside a DIFFERENT tx with
  `READ COMMITTED` isolation.

That is the gap this document covers.

---

## 2. Affected posting + worker paths

### 2a Financial-posting paths (highest priority)

All paths that call `assertPostingAllowed()` from
`src/lib/posting-guard/index.ts`:

- `src/app/api/ar/charges/post/route.ts`
- `src/app/api/ar/payments/post/route.ts`
- `src/app/api/ar/adjustments/post/route.ts`
- `src/app/api/ap/invoices/post/route.ts`
- `src/app/api/ap/bills/post/route.ts`
- `src/app/api/ap/payment-runs/execute/route.ts`
- `src/app/api/gl/journal/post/route.ts`
- `src/app/api/payroll/batch/run/route.ts`
- `src/app/api/payroll/statements/publish/route.ts`
- `src/app/api/member/billing/post/route.ts`
- `src/app/api/member/statement/publish/route.ts`
- Every COA / opening-balance / branding importer under
  `src/app/api/imports/*`.

(Enumeration is approximate; the authoritative list is any
file that calls `assertPostingAllowed`.)

### 2b Sensitive-action paths

Files that call `assertSensitiveActionAllowed()`:

- Secret rotation endpoints.
- RBAC admin endpoints.
- Billing-edit endpoints.
- Operator-only admin surfaces.

### 2c Background workers

Workers that will need the Phase 2H guard
(`isTenantOperationallyActive(clubId)` helper):

- Monthly reporting generator.
- Statement run.
- AR aging / collections.
- AP payment-run scheduler.
- Payroll statement generator.
- Email digest sender.
- POS end-of-day close.
- Reconciliation worker.
- Phase 2G provisioning tick.
- Phase 2E webhook dispatcher.

Workers typically process multiple tenants per tick.  The race
window per tenant mirrors the single-request case but the
total exposure is larger because workers run on schedules.

### 2d Admin-edit (STAGED-tier) paths

Routes that let an admin edit club identity, departments,
role templates, user invites queue, etc.  These go through
`assertTierForCapability` (not `assertPostingAllowed`) and the
access-tier model treats SUSPENDED_READ_ONLY as satisfying
STAGED.  **Admin-config writes during suspension are a smaller
secondary gap** — the current Phase 2H baseline does not block
them.  Addressed in §4 below.

---

## 3. Proposed transaction / locking strategy

### 3a Primary mitigation — row-lock inside the posting-guard

Change `assertAccessTierForPosting(clubId)` to accept an optional
`tx` parameter.  When called INSIDE a `prisma.$transaction`,
it issues `SELECT ... FOR UPDATE` on the ClubSubscription row.
Callers that want serialisation-safe behaviour pass the
transaction client in; the row lock holds until the caller's
transaction commits.

Mechanism:

```ts
// Pseudo-SQL inside the posting-guard:
SELECT accessTier, subscriptionStatus
  FROM "ClubSubscription"
  WHERE "clubId" = $1
  FOR UPDATE;
```

Semantics:
- The `FOR UPDATE` acquires a row-level write lock.
- Phase 2H's `suspendTenant` transaction (which itself writes
  the row) BLOCKS until the posting transaction commits.
- Conversely, a posting transaction that opens while a
  suspension transaction holds the row waits for the suspension
  to commit, then re-reads the fresh state and fails the
  posting-guard.

The race window closes to zero.

### 3b Caller change pattern

Every operational write that opens its own `prisma.$transaction`
is updated to call the posting-guard inside that transaction:

```ts
// BEFORE
await assertPostingAllowed(principal, clubId, action, entityType, entityId);
await prisma.$transaction(async (tx) => {
  await tx.charge.create({ ... });
  await tx.auditLog.create({ ... });
});

// AFTER
await prisma.$transaction(async (tx) => {
  await assertPostingAllowed(principal, clubId, action, entityType, entityId, { tx });
  await tx.charge.create({ ... });
  await tx.auditLog.create({ ... });
});
```

Routes that currently DON'T wrap in a transaction get wrapped
as part of the fix.  Each affected route is a one-liner move
of the guard call into the tx.

### 3c Fallback — guard without tx

For routes that genuinely cannot use a transaction (streaming
imports, chunked work), the guard falls back to a repeated-read
pattern:

```ts
// Pseudo-code
let decision = evaluateAccessTierGate(clubId);  // first read
if (decision.pass) {
  await heavyOperation();
  decision = evaluateAccessTierGate(clubId);    // post-op re-read
  if (!decision.pass) {
    await reverseHeavyOperation();
    throw new SuspendedDuringOperationError();
  }
}
```

**But this fallback adds complexity + a reversal path.**  The
preferred solution is to wrap everything in a transaction.
Streaming / chunked importers that can't do that should chunk
*between* small transactions and re-check at every chunk
boundary — a pattern that already exists for CSV imports.

### 3d Suspension-side change

`suspendTenant` already runs inside a transaction.  To
cooperate with the posting-guard's `FOR UPDATE`, it ALSO
upgrades its initial read to `SELECT ... FOR UPDATE`:

```ts
// BEFORE (in Phase 2H's current suspendTenant)
const sub = await tx.clubSubscription.findUnique({ ... });

// AFTER
const sub = await tx.$queryRaw`
  SELECT "subscriptionStatus", "accessTier"
    FROM "ClubSubscription"
    WHERE "clubId" = ${args.clubId}
    FOR UPDATE
`;
```

Both sides take the lock on the same row, so one BLOCKS the
other.  No deadlock risk — both acquire exactly one row.

### 3e Reinstatement-side change

Symmetric: `reinstateTenant`'s inside-tx re-read also upgrades
to `FOR UPDATE`.  Prevents a posting-guard decision in flight
during reinstatement from being made against pre-reinstatement
tier.

---

## 4. Secondary gap — admin-config writes under SUSPENDED_READ_ONLY

Phase 2H's current access-tier model treats SUSPENDED_READ_ONLY
as satisfying STAGED.  STAGED-tier admin writes
(`club.identity.edit`, `club.departments.edit`,
`admin.profile.edit`) are NOT currently blocked when a tenant
is SUSPENDED.

**Decision.**  Introduce a new boolean helper
`isSubscriptionWriteBlocked(sub)` that returns `true` when
`subscriptionStatus` ∈ {`UNDER_REVIEW`, `SUSPENDED`,
`CANCELLED`}.  Admin-edit routes call this helper via a new
wrapper `assertAdminEditAllowed(clubId)` placed next to
`assertAccessTierForPosting`.  Same row-lock mechanism as §3.

This is a tightening change but it changes current behaviour:
a tenant in UNDER_REVIEW CAN still have its name edited today.
After this change they can't.  **The founder must approve this
tightening in the launch-readiness plan before the fix lands.**

---

## 5. Required regression tests

### 5a Contract tests (vitest)

Add a new test file `tests/signup-2-phase-2h-race-serialization.test.ts`:

1. `assertAccessTierForPosting(clubId, { tx })` uses the
   provided tx (string match on the service for `tx.$queryRaw`
   / `tx.clubSubscription`).
2. Default call (no tx) still runs the plain findUnique path
   (preserves current behaviour for routes not yet migrated).
3. `suspendTenant` upgrades its initial read to `FOR UPDATE`
   (string match on the raw SQL).
4. `reinstateTenant` upgrades its inside-tx re-read likewise.
5. `isSubscriptionWriteBlocked` helper is exported from
   access-tier.
6. Every operational write route that calls
   `assertPostingAllowed` has been migrated (source grep: every
   `assertPostingAllowed(` call sits inside a
   `prisma.$transaction(` scope).

### 5b Integration tests (vitest with DB)

Add a new test file
`tests/signup-2-phase-2h-posting-suspension-serialization.test.ts`:

1. Open two transactions concurrently via `Promise.all`:
   - Tx A: posting-guard check → GL insert.
   - Tx B: suspendTenant.
   One must block the other; whichever commits first dictates
   the outcome.  No interleaving produces a committed GL insert
   under a committed SUSPENDED state.
2. Reverse order: suspend first, then posting-guard check.
   Posting-guard must refuse.
3. Both operations with the same clubId re-ordered by scheduler.
   Fuzz 100 iterations; no post-COMPLETED GL insert should
   land under a SUSPENDED tenant.

### 5c Playwright staging acceptance

Add scenario M to
`tests/e2e/signup-2-phase-2h-suspension-acceptance.staging.spec.ts`:

- Seed an ACTIVE tenant.
- Fire 10 parallel ar-charge POSTs via `Promise.all`.
- In the same `Promise.all`, fire 1 suspend POST.
- Verify: among the 10 charges, every charge that committed
  before the suspension committed is PRESENT, and every charge
  that would have committed after is REFUSED.
- Verify total committed GL writes + suspension state are
  self-consistent (either N charges + ACTIVE, or (N-k) charges +
  UNDER_REVIEW with k charges 403'd).

### 5d Existing-tenant compatibility

The `FOR UPDATE` lock on a legacy tenant with
`subscriptionStatus = null` returns the same row as before; no
lock contention is introduced for grandfathered tenants
(since no suspension handler ever touches them — Phase 2H
refuses legacy tenants per §5 of the Phase 2H authorisation).

**Legacy tenant GL posts continue to flow with no behavioural
change.**

---

## 6. Change surface summary

| Layer | Change |
|---|---|
| `src/lib/billing/access-tier.ts` | `assertAccessTierForPosting(clubId, {tx?})` + `isSubscriptionWriteBlocked` + optional `assertAdminEditAllowed` |
| `src/lib/posting-guard/index.ts` | Pass `tx` through from caller + call `assertAccessTierForPosting(clubId, {tx})` |
| `src/lib/billing/signup-2h-tenant-lifecycle-service.ts` | `suspendTenant` + `reinstateTenant`: upgrade initial read + inside-tx re-read to `tx.$queryRaw` with `FOR UPDATE` |
| Every operational write route | Move `assertPostingAllowed` call inside the `prisma.$transaction` + pass tx |
| Admin-edit routes (optional §4) | Add `assertAdminEditAllowed(clubId)` wrapper |
| Workers | Call `assertTenantOperationallyActive(clubId)` at tick top (already shipped as a helper in Phase 2H) |
| Tests | 3 new vitest files + 1 new Playwright scenario (M) |

**Rough implementation estimate** (not authorised to implement):
- ~ 20-30 operational-write routes to migrate.
- ~ 5-10 admin-edit routes to migrate (if §4 is approved).
- ~ 10 workers to add the tenant-active check.
- 3 vitest suites + 1 Playwright scenario.
- 1 doc update (acceptance evidence).

Mostly mechanical migration + ~ 150 lines of guard-helper
plumbing.

---

## 7. Existing-tenant compatibility implications

- Legacy tenants (`subscriptionStatus=null`): no behaviour
  change.  The posting-guard's existing legacy-grandfather
  short-circuit covers them.
- Pre-SIGNUP-2 Clubs that never went through Phase 2A: no
  behaviour change.
- SIGNUP-2 tenants currently in STAGED (Phase 2G pre-COMPLETED):
  no behaviour change — the row-lock mechanism takes effect
  only when the state is one of {ACTIVE, UNDER_REVIEW,
  SUSPENDED, CANCELLED}.
- SIGNUP-2 tenants currently in ACTIVE: performance impact of
  the `FOR UPDATE` is minimal for single-row reads (micro-second
  scale).  The sole observable difference is that an
  operational write + a suspension cannot interleave.

**No migration of existing tenant records is required.**  The
change is a code-only slice.

---

## 8. What this document is + is not

**IS:**
- A specification of the exact race.
- A proposed smallest-surface fix.
- Enumeration of affected routes + workers.
- A regression-test plan.
- An existing-tenant compatibility statement.

**IS NOT:**
- Authorisation to implement.
- A broad posting-system rewrite.
- A change to any live code path.

**The fix is DEFERRED to a separately-authorised slice.**  Per
founder closure §2: "Do not implement a broad posting-system
rewrite without separate authorisation."  This document is
investigation-only.

---

## 9. Launch-readiness recommendation

This item is **production launch blocker #10** in Phase 2H
acceptance §13.  Recommended release milestone (see
`docs/signup-2-launch-readiness-plan.md`): **M1 — Suspension
lifecycle production-ready**, alongside blockers #11 (legacy-
tenant adoption) and #12 (Phase 2E webhook adapter wiring).
Together these three complete the "a reversal cannot leave a
real tenant operationally active" invariant.
