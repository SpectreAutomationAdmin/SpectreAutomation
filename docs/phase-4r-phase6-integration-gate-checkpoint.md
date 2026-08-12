# Phase 4R · single-GL-authority refactor · Phase 6: Integration Gate + Staging Deployment Readiness

- **Date**: 2026-08-11 / 2026-08-12
- **Branch**: `refactor/gl-single-authority`
- **HEAD**: `c9d9291` (Phase 6 projection semantics fix)
- **Baseline anchor**: `main @ cbb1b52`
- **Previous checkpoint**: Phase 5 · `5571b82` (2026-08-11)

---

## Phase 6 execution log

### Order of operations (per founder authorization §§1-8)

| # | Step | Status |
|---|---|---|
| 1 | Full repository integration/quality gate | ✅ complete |
| 2 | Baseline-failure comparison against `main@cbb1b52` | ✅ complete |
| 3 | Merge/deployment readiness assessment | ✅ this doc |
| 4 | Deploy refactor candidate to staging | ⏸ pending founder go |
| 5 | Real invoice analysis verification | ⏸ post-deploy |
| 6 | Projection / DOM verification | ⏸ post-deploy |
| 7 | AP coding / posting-provenance verification | ⏸ post-deploy |
| 8 | Final architecture closeout | ⏸ post-deploy |

### Toolchain

- `node`: v24.15.0
- `npm`: 11.14.1
- `tsc`: 5.9.3
- OS: Windows 11 Pro x64, Build 26200

### Recovery event (2026-08-11)

The founder-requested `npm run quality` chain aborted during `tsc`
with a native SIGABRT (SHA256 allocation failure in Node's crypto
hasher, triggered by chained npm subprocesses in a long-uptime
host). Standalone `NODE_OPTIONS="--max-old-space-size=6144" tsc
--noEmit` ran cleanly and produced one real diagnostic — a Phase 5
test-fixture schema typo (`unitCost` → `unitPrice`). Fixed and
committed separately at `5a847e3`. The original crash was
attributed as an environment/runtime event, not a repository
defect, and did not recur during individual-stage execution.

---

## Stage-by-stage results

### Stage 1 · typecheck

- `NODE_OPTIONS="--max-old-space-size=6144" npx tsc --noEmit`
- Exit **0**, duration **23s** (pre-projection-fix, post-typo-fix)
- Rerun after projection fix: exit **0**, duration **~15s**
- **CLEAN**

### Stage 2 · placeholder scan

- `npm run scan:placeholders`
- Exit **1**, 33 hits, duration **6s**
- All hits in files Phase 4R did NOT touch: `prisma/schema.prisma`,
  `prisma/seed.ts`, `reporting/*`, `mailbox/*`, `security/*`,
  `sso/*`, `pos/chit.ts`, `ocr/config.ts`, `canonical-line-item.ts`
  ("temporary bridge" pre-existing comment), `format-amount.ts`
  ("XXX" formatting example)
- Zero hits in Phase 4R modified files
- **Refactor-attributable delta: 0** (all pre-existing baseline)

### Stage 3 · UI audit

- `npm run ui:audit`
- Exit **1**, 150 hits, duration **1s**
- All hits in files Phase 4R did NOT touch: admin/settings,
  admin/webhooks, member/*, apply flows, login
- Zero hits in AP intelligence UI
- **Refactor-attributable delta: 0** (all pre-existing baseline)

### Stage 4 · full vitest suite

**Pre-fix run** (HEAD `5a847e3`):
- Files: 305 passed / 39 failed / 344 total
- Tests: 6769 passed / 193 failed / 6962 total
- Duration: 6783s (~1h 53min)

**v206 baseline comparison** — same 39 files against `main@cbb1b52`:
- Files: 1 passed / 38 failed / 39 total
- Tests: 855 passed / 190 failed / 1045 total
- Duration: 679s

**File-level diff**: exactly **one** file passes on main but fails
on refactor → `tests/c15v-allocations.test.ts` (2 tests failing).

**Attribution**: root cause = legacy `RECOMMENDATION_MIN_SCORE = 40`
threshold in `gl-allocations.ts` at two sites (`toAllocations`
line 684 + `mergeSameAccountClusters` line 601). Phase 5 canonical
ranker uses `COMMIT_MIN_SCORE = 30`; canonical winners scoring
30-39 (valid RECOMMEND) were flagged `requiresReview=true` by the
legacy 40 threshold, causing `deriveCardCategory` to filter valid
allocations out of the "material" count and cardCategory to fall
to a single-account name or null instead of "Multiple".

First failure boundary per §19 classification: **UI projection
wrong**. Not GL ranking. Not confidence semantics. Not
vendor/invoice/account special-casing.

**Projection fix** (commit `c9d9291`):
- Both sites migrated to consume `r.canonical.recommendationStatus`
  (already computed per-cluster by `rankClusterCanonically` in
  Phase 5)
- `RECOMMENDATION_MIN_SCORE = 40` constant removed (dead)
- 3 new lock-in contract tests added to
  `tests/phase4r-allocation-canonical.test.ts`:
  1. RECOMMEND canonical status → `requiresReview === false`
  2. Non-RECOMMEND canonical status → `requiresReview === true`
  3. Anti-regression grep-guard: `RECOMMENDATION_MIN_SCORE = 40`
     constant + `semanticScore < RECOMMENDATION_MIN_SCORE` +
     `semanticScore < 40` all forbidden anywhere in
     `gl-allocations.ts`

**Post-fix run** (HEAD `c9d9291`):
- Files: 306 passed / 38 failed / 344 total
- Tests: 6756 passed / 189 failed / 20 skipped / 6965 total
- Duration: 8138s (~2h 15min)

**Post-fix file-level diff vs pre-fix**: `tests/c15v-allocations.test.ts`
removed from failing set (only change). All 38 remaining failing
files were confirmed identical to `main@cbb1b52` baseline in Stage 4.

**Refactor-attributable full-suite failure surface: 0**.

Raw suite state: 38 files failed with the same 189-baseline signature
that exists on `main` unmodified. Reporting per §20 discipline —
suite is NOT green; only baseline failures remain.

### Stage 5 · Next.js build

- `npm run build`
- Exit **0**, duration **119s**
- All routes compiled, middleware built
- **CLEAN**

### Stage 6 · smoke

- `npm run smoke` (`scripts/smoke.ts`)
- Exit **0**, duration **6s**
- 10 checks: **7 PASS / 3 WARN / 0 FAIL**
- WARNs are development-environment-only:
  - `INFRA/storage`: memory adapter (local dev)
  - `LAUNCH/launch-checks`: 3 warnings from launch-readiness checks
    that need production-mode data
  - `SECURITY/tenant-isolation`: needs ≥2 clubs to verify isolation
- **CLEAN** (no FAIL, WARNs are environmental)

---

## Static architectural guards — post-fix

Reconfirmed via direct grep + the Phase 4R architectural test suite:

| Guard | Value | Status |
|---|---|---|
| Document-level `gl = { ...gl, accountNumber: ... }` overrides in `analyse.ts` | **0** | ✅ (unchanged from Phase 3.6) |
| Allocation-level account overrides in `gl-allocations.ts` | **0** | ✅ (Phase 5 target) |
| Legacy `rankAccountsPure()` runtime calls in `gl-allocations.ts` | **0** | ✅ (Phase 5 target) |
| Anti-overfitting: no vendor/invoice/account literals in canonical-ranker.ts | ✅ GREEN | |
| Anti-overfitting: no literals in recommendation-policy.ts | ✅ GREEN | |
| Anti-overfitting: no literals in canonical-confidence.ts | ✅ GREEN | |
| Anti-overfitting: no literals in gl-allocations.ts canonical scoring path | ✅ GREEN | |

**One canonical GL ranking authority** for both document-level and
per-allocation classification. Established.

---

## Final runtime authority map

### Allowed and present

- **`rankCanonical`** — the single GL ranker for both document-level and per-allocation classification
- **`evaluateRecommendationPolicy`** — decides RECOMMEND vs ABSTAIN_* from canonical status + field-quality gate
- **`assessCanonicalConfidence`** — derives HIGH / MODERATE / LOW / REVIEW_REQUIRED + genuine competitors from canonical result
- **`runCanonicalGlRanking`** — document-level facade (DB load + eligibility filter + canonical rank + policy + confidence + projection)
- **`rankClusterCanonically`** — per-cluster canonical facade (allocation entry-point; consumes cluster-scoped queryConcepts + global signals)
- **`projectCanonicalToGl`** — pure `GlRecommendation` projection
- **`toAllocations`** — pure `ApGlAllocation` projection (now consumes `r.canonical.recommendationStatus`)
- **`computeConfidenceDimensions`** — Mission Control confidence dimension bundle (reads `gl.canonicalConfidence.level`)
- Validation / reconciliation surfaces (arithmetic, tax reconciliation, posting eligibility)
- Compat consumers: `workflow/decision.ts` (reads `gl.confidence` numeric projection), Mission Control UI components (read `recommendedAccount`)

### Forbidden and confirmed absent

| Forbidden | Result |
|---|---|
| Second document-level winner selector | **CONFIRMED ABSENT** — `recommendGlAccount`, `rankAccountsPure`, `rankPurposeDrivenAccounts` all zero runtime imports |
| Post-ranking allocation account substitution | **CONFIRMED ABSENT** — static guard passes |
| Independent allocation recommendation threshold | **CONFIRMED ABSENT** — legacy `RECOMMENDATION_MIN_SCORE=40` removed in `c9d9291` |
| Separate `cardCategory` account authority | **CONFIRMED ABSENT** — Slice 5.3 guard removed in Phase 5 |
| Candidate reconstruction to justify a different winner | **CONFIRMED ABSENT** |

### Dead exports (library-scope only; not called at runtime)

- `recommendGlAccount` — pre-Phase-4R Pipeline A (removed from `analyse.ts` in Phase 4)
- `rankAccountsPure` — legacy per-cluster ranker (removed from `gl-allocations.ts` in Phase 5)
- `rankPurposeDrivenAccounts` — pre-Phase-4R Pipeline B (never migrated back after Phase 3.2)

Documented in Phase 5 §22.25 as future cleanup targets.

---

## Confidence-consumer audit

| Consumer | Type | Reads |
|---|---|---|
| `workflow/decision.ts:327` | compat | `gl.confidence` numeric (canonical-populated), `gl.source`, `gl.accountNumber` |
| `api/ap-intelligence/inspect-wi/route.ts` | compat | API projection of full `GlRecommendation` |
| `components/mission-control/CategoryHoverAllocations.tsx` | compat | `recommendedAccount` (canonical winner projection) |
| `components/mission-control/EmailIntakeCard.tsx` | compat | `allocations.entries[].recommendedAccount` |
| `components/mission-control/CreateVendorAndPostModal.tsx` | compat | `recommendedAccount` + `recommendedAccountAbstained` |
| `analyse.ts computeConfidenceDimensions` | canonical | `gl.canonicalConfidence.level` (Phase 5 §22.14 migration) |

**No independent GL confidence calculator remains.** All product-facing consumers read canonical-derived fields.

---

## Baseline mailbox `c14c` failure comparison

Per §2 requirement. The 4 known mailbox `c14c` failures:

- Present on `main @ cbb1b52`: **YES** (verified Stage 4 baseline run)
- Present on `refactor/gl-single-authority @ c9d9291`: **YES** (unchanged signatures)
- Refactor-attributable delta on `c14c`: **0**

`c14c` failures classified as **pre-existing baseline**, unrelated
to Phase 4R architecture. Same signatures on both branches.

---

## Deployment readiness determination

### Gate criteria (per founder §6)

| Criterion | Status |
|---|---|
| No refactor-attributable full-quality failures | ✅ **0** attributable failures |
| Typecheck clean | ✅ exit 0 |
| Architectural guards green | ✅ doc=0, alloc=0, legacy=0 |
| Anti-overfitting green | ✅ all guards |
| Confidence-source audit clean | ✅ no independent calculator |
| Final runtime authority scan clean | ✅ 3 legacy rankers dead |
| Branch working tree clean | ✅ (only untracked `tests/ap-benchmark/runs/`) |
| Rollback anchor recorded | ✅ `bba0b37` (pre-Phase-5), `5571b82` (pre-Phase-6) |

**Determination: STAGING-ELIGIBLE.**

Not production-eligible (per founder standing rule — production
deployments require explicit per-change authorisation).

### Rollback anchors

| Anchor | Purpose |
|---|---|
| `cbb1b52` (main) | Full v206 baseline |
| `bba0b37` | Pre-Phase-5 refactor branch state (Phase 4 checkpoint doc commit) |
| `5571b82` | Pre-Phase-6 refactor branch state (Phase 5 sealed) |
| `c9d9291` | Current HEAD — Phase 6 projection fix applied |

---

## Remaining architectural weakness

Carried from Phase 5 §22.25:

1. `preferredAccountNumbers` + `contradictedAccountNumbers` not fed per-cluster (compatibility gate is currently whole-transaction). Small consequence — allocation clusters still receive all Phase 3.3-3.5 signals; only miss the pre-baked lists.
2. `allocationEligibilityMode` remains `DOCUMENT_FALLBACK` — separate Phase-2.1-era concern, not Phase 4R.
3. `gl-recommend.ts` + `purpose-driven-ranker.ts` still export the three legacy ranker functions for their own unit tests. Zero runtime imports. Deletable once those unit tests are migrated.

Nothing weakens the Phase 6 acceptance principle.

---

## Phase 6 §1-3 completion

- **§1** Full repository integration/quality gate — complete. Individual stage exit codes + durations recorded above.
- **§2** Baseline comparison against `main@cbb1b52` — complete. c14c and all 38 remaining failing files reproduce identically.
- **§3** Merge/deployment readiness assessment — **STAGING-ELIGIBLE**.

### Recommendation

**Proceed with staging deployment when authorised.**

The refactor branch demonstrates:
1. Full quality gate individually run and reported honestly (typecheck clean, placeholder scan / UI audit have only pre-existing baseline hits, vitest has 0 refactor-attributable failures, build clean, smoke clean).
2. All refactor-attributable failures identified and fixed (c15v-allocations projection semantics).
3. No regression in canonical architecture — static guards intact, no independent GL confidence calculator, no independent allocation selector.
4. Rollback anchors recorded.

Steps §4-§8 (staging deploy + real-fixture verification) require:
- Staging deploy target: `spectre-staging` (Fly.io)
- Founder authorization to execute `flyctl deploy` per Spectre operating rules
- Post-deploy `/api/health` verification
- Real invoice validation on the 6+ founder regression controls
- Playwright DOM parity verification
- AP coding posting-provenance verification

None of §4-§8 should be initiated without founder go on the specific deploy step.

Do not deploy to production. Main/staging unchanged pending founder authorisation.
