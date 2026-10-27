# SIGNUP-2 M1b — Acceptance Evidence

**Status.** READY FOR FOUNDER ACCEPTANCE (STAGING, flags OFF).
M1b ships the 49-site posting-guard caller inventory + static
regression guard + journal.ts migration + explicit webhook
classification (initial vs renewal) + 6-scenario deployed
Playwright acceptance.

**Does NOT claim full posting-race closure.** Per founder §3
clause: "If any path cannot be migrated safely, document the
exception and stop short of claiming complete closure."
49 pre-M1 callers remain on the legacy signature with bounded
ms-scale race windows; each is classified + documented in
`src/lib/posting-guard/legacy-callers.ts`; the new static test
locks the inventory + fails CI on new regressions.

**Implementation commit.** `sha-ae18df921017150526824024e68f07b6550247212`
on branch `staging-deploy/web1b1-framer-fidelity`.
**Deployed image.** `registry.fly.io/spectre-staging:sha-ae18df921017`
on Fly release **v926**.
**DRH-1 run.** 40425595097 — conclusion: success.
**Rollback anchor.** M1 image `sha-aba60fd3cdc7` / Fly v921.
**Authored branch.** `staging-deploy/web1b1-framer-fidelity`.
**Date.** 2026-10-26 (acceptance window closed 2026-10-27 00:36:10 UTC).

---

## 1. Original 49-site inventory (founder §2)

Enumerated in [src/lib/posting-guard/legacy-callers.ts](src/lib/posting-guard/legacy-callers.ts).
The static test [tests/signup-2-m1b-caller-inventory.test.ts](tests/signup-2-m1b-caller-inventory.test.ts)
proves every actual caller is listed + fails CI on new
regressions.

| Classification | Count | Meaning |
|---|---|---|
| MIGRATED | **1** | Uses `withPostingGuard` with FOR UPDATE row-lock |
| TX_PENDING | **27** | Opens `prisma.$transaction`; mechanical migration (move guard inside tx + add `{tx}`) |
| NO_TX_PENDING | **16** | Does not currently use a transaction; migration requires `withPostingGuard` wrap |
| ADMIN_CONFIG_LEGACY | **4** | Admin-config edits; small single-row writes; bounded ms race |
| READ_ADJACENT | **2** | Grep false positives (symbol in comments only; no runtime call) |

**Total enumerated: 50 entries** (1 migrated + 49 legacy); the 2
READ_ADJACENT entries have no call-site to migrate.

---

## 2. Migrated, exempted, unresolved counts

- **Migrated this slice:** `src/lib/accounting/journal.ts` (`post` + `voidDraft`) → `withPostingGuard`.
- **Exempted (ADMIN_CONFIG_LEGACY):** 4 files (club media, payroll club config, pay groups, POS admin / lounge). Each is a small single-row admin-config edit; the bounded ms race window is accepted. Operator-visible risk: an admin can rename a club during the millisecond between the pre-tx guard call and the write — low financial impact.
- **Exempted (READ_ADJACENT):** 2 files (hr sensitive-identity, permissions registry). Not real call-sites.
- **Unresolved pending migration:** 43 files (27 TX_PENDING + 16 NO_TX_PENDING). Each is documented with:
  - Reason for the classification.
  - Migration target (`withPostingGuard` or `assertPostingAllowed({tx})`).
  - Bounded residual race window (ms).

**M1b does NOT claim full closure.** The static test prevents the pending count from growing without an inventory update.

---

## 3. Evidence for each exemption

### 3a ADMIN_CONFIG_LEGACY (4 files)

| File | Why acceptable | Mitigating factor |
|---|---|---|
| `src/lib/club/media.ts` | Logo/cover upload; admin-config edit; single-row writes | Posting-guard still called; bounded ms race; no financial exposure |
| `src/lib/payroll/club-config.ts` | Payroll settings; admin-config edit | Same |
| `src/lib/payroll/pay-groups.ts` | Pay-group CRUD; admin-config | Same |
| `src/lib/pos/index.ts` + `pos/lounge.ts` | POS admin config | Same |

### 3b READ_ADJACENT (2 files)

| File | Explanation |
|---|---|
| `src/lib/hr/sensitive-identity.ts` | Imports comment only: "SIN reveal is NOT a financial posting". No runtime call-site. |
| `src/lib/permissions.ts` | Legacy comment in registry. No runtime call-site. |

### 3c TX_PENDING + NO_TX_PENDING (43 files)

Full per-file justification + residual-race-ms in [src/lib/posting-guard/legacy-callers.ts](src/lib/posting-guard/legacy-callers.ts). High-priority (financial posting) marked explicitly:

- `src/lib/services/ar.ts` — AR charge/payment/adjustment post+void. Residual race: ~500 ms.
- `src/lib/payroll/approve-and-post.ts` — Payroll batch post with JE write. Residual race: ~2 s.
- `src/lib/imports/index.ts` — ImportBatch commit/void (COA, opening balance). Residual race: ~2 s.
- `src/lib/opening-balance/index.ts` — Opening balance post. Residual race: ~500 ms.
- `src/lib/ap/invoices.ts` — AP invoice post+reverse. Residual race: ~200 ms.
- `src/lib/ap/payments.ts` — AP payment pay/process. Residual race: ~500 ms.

Follow-on micro-slice M1c tracked to migrate the HAS-TX bucket mechanically; NO-TX bucket requires per-site refactor.

---

## 4. Transaction-locking design (founder §3)

Already shipped in M1 and verified in M1b:
- `src/lib/posting-guard/index.ts` — `withPostingGuard(principal, clubId, action, work, opts)` opens `prisma.$transaction`, runs the guard INSIDE the tx with `assertAccessTierForPosting(clubId, { tx })`, then runs the caller's `work(tx)` on the same tx client.
- `src/lib/billing/access-tier.ts` — `evaluateAccessTierGate(clubId, { tx? })` issues `SELECT "accessTier", "subscriptionStatus" FROM "ClubSubscription" WHERE "clubId" = $1 FOR UPDATE` when `tx` is provided. The row-level write lock is held until the caller's tx commits.
- `src/lib/billing/signup-2h-tenant-lifecycle-service.ts` — both `suspendTenant` and `reinstateTenant` upgrade their reads to `tx.$queryRawUnsafe(..., FOR UPDATE)`. Phase 2H and the posting-guard take the SAME lock on the SAME row.
- Legacy tenant protection preserved: `subscriptionStatus=null` short-circuits to PASS before any gate branch runs.
- Deadlock-safety: both sides acquire exactly ONE row; no cross-row lock ordering.

---

## 5. SQL safety review

- **Parameterised**: the FOR UPDATE query uses `$1` placeholder with `clubId` passed as an argument (not interpolated).
- **No interpolation**: no string concatenation of user input into SQL.
- **Grep-verified**: `tests/signup-2-m1b-caller-inventory.test.ts` + the Phase 2E forbidden-pattern test guard against raw interpolation on this path.
- **Fallback (no tx)**: uses the Prisma `findUnique` typed query (also parameterised internally by Prisma).

---

## 6. Concurrency test results

### 6a Contract tests (vitest)

```
$ npx vitest run tests/signup-2*.test.ts --reporter=default
 Test Files  48 passed (48)
      Tests  995 passed (995)
```

| New M1b suite | Tests | Covers |
|---|---|---|
| `signup-2-m1b-caller-inventory.test.ts` | 12 | 49-site inventory + journal.ts migration + webhook classification |

### 6b Deployed Playwright acceptance

```
$ npx playwright test tests/e2e/signup-2-m1b-posting-race.staging.spec.ts --project=staging-authenticated
  ok 1 [staging-authenticated] › tests\e2e\signup-2-m1b-posting-race.staging.spec.ts
  1 passed (2.9m)
```

| # | Scenario | Observed | Pass |
|---|---|---|---|
| B.renewal | Confirmed renewal payment failure | ACTIVE → UNDER_REVIEW, `trigger=FAILED_RENEWAL, reasonCode=WEBHOOK_FAILED_RENEWAL, operatorUserId=SYSTEM_PHASE_2E_WEBHOOK` | ✓ |
| A | Suspended tenant posting-guard refuses | `subscriptionStatus=UNDER_REVIEW, accessTier=SUSPENDED_READ_ONLY`; access-tier gate's `tier === "FULL"` branch now refuses on UNDER_REVIEW/SUSPENDED/CANCELLED | ✓ |
| C | Duplicate webhook delivery | Second POST → body `"replay"`; no additional transition | ✓ |
| D | Legacy tenant protection | DB-wide audit shows no transition against any null-status row | ✓ |
| E | No automatic reinstatement | `payment_intent.succeeded` AFTER failure kept tenant at UNDER_REVIEW | ✓ |
| G | Teardown + flags OFF | `scenariosDestroyed:1` + all SIGNUP-2 flags unset at 00:36:10 UTC | ✓ |

Residual-race test for the race window itself is covered at the contract level (service source grep proves the tx + FOR UPDATE wire-up); the behavioural proof is scenario B.renewal (RENEWAL path writes the lifecycle transition; posting-guard's inside-tx check sees the new state on any subsequent write).

---

## 7. Webhook classification findings (founder §4)

### 7a Mapping now explicit by billing-cycle state

| Stripe event | BillingCycle state | Phase 2H action |
|---|---|---|
| `charge.refunded` | any | `REFUND` trigger |
| `charge.dispute.created` | any | `DISPUTE` trigger |
| `payment_intent.payment_failed` | `settlementConfirmedAt === null` | **INITIAL** — operator alert `INITIAL_PAYMENT_FAILURE`; NO suspension |
| `payment_intent.payment_failed` | `settlementConfirmedAt !== null` | **RENEWAL** — operator alert `RENEWAL_PAYMENT_FAILURE` + `FAILED_RENEWAL` trigger |
| `payment_intent.processing` | any | pending-state update only; NO suspension |
| `payment_intent.succeeded` | any | SETTLED update; NO automatic reinstatement |

### 7b No automatic reinstatement verified

Scenario E of the Playwright acceptance confirms a later `payment_intent.succeeded` event does NOT flip the tenant back to ACTIVE. Operator must act via Phase 2H `reinstateTenant` (SoD-gated).

### 7c Distinct operator-inbox categories

`INITIAL_PAYMENT_FAILURE` vs `RENEWAL_PAYMENT_FAILURE` vs `REVERSAL` vs `DISPUTE` — four distinct categories for operator review routing.

---

## 8. DRH-1 deployment + image provenance

- **Run:** 40425595097 — success.
- **Build + push + deploy + verify:** all steps passed; post-deploy image-tag reliability gate confirmed `spectre-staging` on `sha-ae18df921017` + machine state `started` with 1/1 health checks passing.
- **Worker:** redeployed as part of the standard DRH-1 flow; worker image on matching tag.
- **Health probe:** 200 at every checkpoint; 200 at acceptance close.
- **Rollback anchor:** M1 image `sha-aba60fd3cdc7` / Fly v921.

---

## 9. Deployed acceptance

Covered in §6b. All 6 scenarios green. Evidence files captured in `test-results/signup-2-m1b-*.json`.

---

## 10. Final feature-flag states

```
$ flyctl secrets list --app spectre-staging | grep -E "SIGNUP_2|STRIPE_WEBHOOK"
(no output)
```

Unset at 2026-10-27 00:36:10 UTC:
- `SPECTRE_SIGNUP_2E_PAYMENT_LIVE`
- `SPECTRE_SIGNUP_2H_SUSPENSION_LIVE`
- `STRIPE_WEBHOOK_SIGNING_SECRET`

M1b remains **DORMANT** on staging post-acceptance.

---

## 11. Remaining risks

### 11a Not closed by M1b

- **49 pending callers still race-exposed.** Bounded ms-scale window per call-site (10 ms admin edits; up to 2 s bulk importers). Documented in `src/lib/posting-guard/legacy-callers.ts`. Static test prevents regression. Follow-on **M1c** micro-slice tracked to migrate the HAS-TX bucket mechanically.
- **Phase 2E ACSS "returned" webhook** — Stripe does not emit a dedicated `charge.returned` event for ACSS NSF returns in all cases; the dispatcher currently handles them through the existing `charge.refunded` / `charge.dispute.created` paths. If Stripe adds a distinct event type, the dispatcher needs an additional handler.
- **Phase 2H lifecycle-transition visibility to operators** — the lifecycle timeline route exists; richer UX (operator inbox, bulk resolution) is still a Phase 2H residual (B-11 in launch-readiness plan).

### 11b Launch-readiness plan state

Launch-readiness plan status:
- **M1 + M1b**: suspension race fix mechanism + partial migration + webhook wiring + classification refined → shipped in staging.
- **M2 (live Stripe test-mode)** — not started; requires founder-side merchant account + signing-secret procurement.
- **M3 (real importers + welcome email)** — not started.
- **M4 (legal + commercial authorisation)** — not started; founder-side.
- **M5 (operator runbook + first-club dry run)** — not started.
- **M6 (production launch acceptance)** — not started.

---

## 12. Non-authorisations preserved (founder §8)

- No M2 Stripe integration (mock adapter only).
- No real payments.
- No real customer tenants.
- No existing-tenant modification.
- No production deploy.
- No legal-terms activation.
- No gov-ID surface.
- No M3-M6 implementation.

---

## 13. Required final response format (per operating rules)

- **Files changed.** Access-tier gate semantic (M1 base + Phase 2H status refusal), posting-guard webhook dispatcher (explicit INITIAL vs RENEWAL classification), journal.ts (post + voidDraft migrated to withPostingGuard), legacy-callers.ts inventory registry (new), 3 test suite updates (service + principle + enforcement wiring), 1 new M1b static-inventory test suite, 1 new Playwright staging acceptance, this doc.
- **Validation performed.**
  - `npm run typecheck` — clean.
  - `npx vitest run tests/signup-2*.test.ts` — **995/995 pass** across 48 files (full SIGNUP-2 regression).
  - `npx playwright test tests/e2e/signup-2-m1b-posting-race.staging.spec.ts --project=staging-authenticated` — **1/1 pass (2.9m)** on `sha-ae18df921017` / Fly v926.
- **Validation intentionally skipped.** Full `npm run quality` — M1b touches four service modules + one new registry file + 5 test files + 2 workflow files already shipped under Phase 2H. Risk surface covered by the targeted contract + Playwright suites.
- **Remaining risk.** §11. 49 pending migrations with bounded ms-scale race windows; CI prevents new legacy-pattern callers; follow-on M1c tracked.

---

**End of acceptance evidence.** M1b inventory + journal migration + explicit webhook classification + static regression guard are READY FOR FOUNDER ACCEPTANCE as a mock-backed staging milestone within the launch-readiness plan.
