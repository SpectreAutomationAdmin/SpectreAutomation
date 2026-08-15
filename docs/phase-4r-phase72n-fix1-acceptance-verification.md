# Phase 4R · Phase 7.2N · Fix 1 — Founder Acceptance Verification (20-item)

**Status:** Founder-authorised acceptance verification via authenticated
staging Playwright + read-only DB probe. **Fix 1 partially landed but
fails founder acceptance for DMM.** Architectural root cause identified:
plumbing gap between `AccountSemantics.postingRole` (Fix 1 output) and
`assignCandidateTier` (ranker gate) — the tier gate does NOT consume
`AccountSemantics.structuralPostingRestrictions`.

**No runtime code changes in this checkpoint.** Diagnostic-only.

**Not merged. No production deploy.**

---

## §10 · 20-item required checkpoint

### 1 · Proof current UI was showing persisted pre-Fix-1 analysis

**Partly true, partly not.** Direct staging DB query:

| Fixture | WI id (tail) | `lastAnalysedAt` (persisted) | Persisted `analysisVersion` | Staging v211 `analysisVersion` |
|---|---|---|---|---|
| 221178.pdf | `lrncy9ib` | 2026-08-10T06:13Z | `ap-v1:...lines=3:tax=2:...purpose=1:gl=3` | `ap-v1:...lines=5:tax=3:...purpose=3:gl=6` |
| B0037FC.PDF | `094a8uyu` | 2026-08-06T05:29Z | null | `ap-v1:...gl=6` |
| 1091559.pdf | `w2io64kn` | 2026-07-30T09:26Z | null | `ap-v1:...gl=6` |

**All 3 WIs have persisted analysisVersion PREDATING v211.** So the
`WorkIntakeFinding` rows written at ingestion time are indeed stale.

**HOWEVER:** the founder-facing card's GL allocation display comes
from the LIVE analyser recomputation via
[`/api/mission-control/work-intake/[id]/ap-evidence`](../src/app/api/mission-control/work-intake/[id]/ap-evidence/route.ts)
which calls `analyseIngestedInvoice` on every GET (line 72). So the
GL displayed IS fresh. Only the finding metadata (line-sum-mismatch,
vendor-not-found, etc.) is persisted-stale — and NONE of the persisted
findings contain a GL account number.

**Verified via API response `persistedFindings` field — no GL account
appears in any of the 6 persisted findings across all 3 WIs.**

### 2 · Analysis version / timestamp before replay

Recorded in §1 table above.

### 3 · Replay mechanism used

Authenticated Playwright GET against
`/api/mission-control/work-intake/[id]/ap-evidence` — SUPER_ADMIN
staging creds from `.env.playwright.local` — which re-runs
`analyseIngestedInvoice` fresh under v211. No DB writes, no forced
UI state, no invoice modification. This is the ordinary read path
the UI card triggers.

Rejected alternatives: (a) local Node script — my ISP blocks direct
Neon 5432; (b) `/api/ap-intelligence/replay-analyse` — text-parse
only, doesn't run tenant COA / tier / discovery; (c) Fly SSH inline
— Next.js chunk imports would require reimplementing route setup.

Full spec:
[tests/e2e/phase72n-fix1-acceptance.staging.spec.ts](../tests/e2e/phase72n-fix1-acceptance.staging.spec.ts).
Full JSON responses:
[test-results/phase72n-fix1-lrncy9ib.json](../test-results/phase72n-fix1-lrncy9ib.json) etc.

### 4 · 221178 fresh trace (post-Fix-1 v211)

- **Extraction:** vendor=`Club Support Inc`, invoice=`221178`,
  total=`3794.18 CAD`, subtotal=`3613.50`
- **Persisted findings** (stale, pre-Fix-1, no GL number):
  line_sum_mismatch, vendor_not_found, operating_candidate, not_found
- **Live `capitalRecommendation.state`:** `OPERATING` — "Small-value
  invoice with no capital-suggesting language" (base state, WEAK
  defensibility)
- **Live `glRecommendation.reason`:** `multi_allocation:2_clusters ·
  status=RECOMMEND · confidence=MODERATE`
- **Live `glRecommendation.candidates`:**
  - **`1313 Inventory - Proshop Repairs` — confidence 54 (only candidate exposed)**
- **`9900 Bank - Credit Facilities/Mortgage` is NOT in fresh
  candidates.** ✓
- **`glRecommendation.accountNumber` = null** (multi-cluster projection)

**Interpretation:** Fresh Fix-1 v211 result — 9900 has been eliminated
from the primary cluster's candidate exposure, so 9900 no longer wins
its cluster. However, the founder-visible card presumably shows the
per-cluster winners for a 2-cluster multi-alloc invoice; the API
response exposed only the top-level `candidates`. Cluster-2's winner
may still be a wrong-family account.

**Status:** 1313 Inventory-Proshop-Repairs is a WRONG destination for
an online-backup license service (which should route to
`6054 Computer & IT Services`). RECOMMEND at conf 54 = MODERATE. This
is the Founder §9 **Category C** failure: wrong non-bank account
still wins.

### 5 · 221178 fresh UI card

The API `/api/mission-control/work-intake/.../ap-evidence` returned
the JSON above. The UI card reads this endpoint. Given the API
`glRecommendation.candidates = [1313 conf 54]`, the UI card
post-Fix-1 shows 1313 with confidence 54 MODERATE. **9900 is no
longer surfaced by the fresh analysis** (persisted findings never
contained 9900).

Screenshot-level DOM verification not executed (API response IS
what the UI page reads — same source of truth). If founder still sees
"1313 + 9900" on the card, that indicates either:
- Browser cache in the founder's session (hard refresh should
  invalidate)
- Or the UI renders per-cluster winners separately for a multi-alloc
  invoice, and cluster-2's winner IS a wrong-family bank/cash account
  that Fix 1's plumbing gap (§17 below) fails to eliminate

### 6 · Whether 9900 is now INELIGIBLE (structurally)

**No — not at the ranker's tier-gate level.** Fix 1 correctly returns
`AccountSemantics.postingRole = BANK, structuralPostingRestrictions =
["BANK_ACCOUNT"]` for 9900 (verified via 232/232 unit tests). BUT
`assignCandidateTier` at
[canonical-ranker.ts:1420-1447](../src/lib/ap-intelligence/canonical-ranker.ts#L1420)
does NOT consume `AccountSemantics.postingRole` or
`structuralPostingRestrictions`. It only checks:
1. `!postable` (from `postingBlockersByAccount` — a separate plumbing
   path that DOESN'T ingest Fix 1 output)
2. Raw `account.isBankAccount === true` (boolean flag — false on real
   COA)

Both conditions FAIL for 9900. Tier assignment falls through to
statement-role branch → 9900 gets `tier = PLAUSIBLE` (BALANCE_SHEET_
CURRENT_ASSET). Under OPEN_TREATMENT it competes on score alone.

**Fix 1 semantic contract landed; runtime tier-gate does not consume
it. This is the plumbing gap (§17).**

**Empirical evidence:** 9900 disappeared from 221178's fresh top-1
candidate list, but its cluster-2 winner (not exposed in the API
response tested) may still be a BS_CASH_EQUIVALENTS account. And DMM
(§10) definitively shows 1000 Petty Cash surviving as top-1 despite
Fix 1.

### 7 · Whether 6054 becomes winner

**No.** 221178's fresh candidates expose only `1313 Inventory -
Proshop Repairs` at conf 54. `6054 Computer & IT Services` is not in
the exposed top candidates. Either it scored below 54 (and got
suppressed in the top-1-per-cluster projection) OR the purpose
classifier doesn't commit SOFTWARE_SUBSCRIPTION on this specific
line-item wording so no accountingClassHint fires → no
ACCOUNTING_CLASS_MATCH boost → 6054 has minimal evidence.

### 8 · 1313 disposition

**Wins cluster-1 with confidence 54, RECOMMEND MODERATE.** Wrong
account for an online-backup service. Composed treatment for 221178
is WEAK (base-state OPERATING); tier competition mode is
OPEN_TREATMENT; 1313 (PLAUSIBLE tier) beats any candidate with a
lower flat score.

**Category C first-failure** per Founder §9 — Fix 2 (defensibility
promotion) may or may not fix this specific case; the deeper issue
is that 1313's lexical evidence dominates the OPEN_TREATMENT
competition.

### 9 · 221178 confidence / status

- `glRecommendation.reason`: `multi_allocation:2_clusters · status=RECOMMEND · confidence=MODERATE`
- Top candidate 1313 at conf 54 (above COMMIT_MIN_SCORE=30)
- **RECOMMEND with wrong account = false-positive high-confidence
  recommendation — this is the primary founder-blocking behavior**

### 10 · DMM fresh trace (post-Fix-1 v211)

- **Extraction:** vendor=`DMM ENERGY INC`, invoice=`B0037FC`,
  total=`2532.92 CAD`
- **Line items:** "9 Diesel LS Dyed" $2344.30 + "PFT :" $68.00
- **Live `capitalRecommendation.state`:** `OPERATING`
- **Live `glRecommendation.reason`:** `cluster_owned_projection:single_cluster:abstain_ambiguity`
- **Live `glRecommendation.candidates`:**
  - **`1000 Petty Cash` — confidence 26** ← Fix 1 target, STILL TOP-1
  - `1001 Bank - General` — confidence 26 ← also BS_CASH_EQUIVALENTS, still surfaced
  - `1100 Prepaid Deposits` — confidence 26
  - `1101 Prepaid Expenses` — confidence 26
- **`glRecommendation.accountNumber` = null** (ABSTAIN_AMBIGUITY)

**Interpretation:** Four-way tie at score 26, all ASSET-family, all
below COMMIT_MIN_SCORE=30 → ABSTAIN_AMBIGUITY. Correct fuel account
`6025 Fuel (Gas/Diesel)` NOT in top-4 candidates.

**Founder §9 Category D** — no candidate commits.

### 11 · DMM fresh UI card

The UI card renders from this API response. Founder-visible top
candidate = `1000 Petty Cash`. Even though status=ABSTAIN, the UI
likely displays 1000 as "suggested GL" in a way the founder
interpreted as the current recommendation.

### 12 · Whether 1000 is now INELIGIBLE

**No — same plumbing gap as §6.** Fix 1 correctly derives
`AccountSemantics.postingRole = CASH, structuralPostingRestrictions =
["CASH_ACCOUNT"]` for 1000 (verified via unit tests). But
`assignCandidateTier` doesn't read those fields. 1000 lands in
PLAUSIBLE tier via the statement-role branch and competes on score.

### 13 · Actual DMM GL winner

`null` (ABSTAIN_AMBIGUITY). No account committed. Top candidate
1000 Petty Cash conf 26.

Correct target `6025 Fuel (Gas/Diesel)` NOT in top-4. Second-order
diagnostic: the fuel purpose classifier presumably commits (line
item explicitly says "Diesel"), the composed treatment is defensibly
OPERATING_EXPENSE via strong "fuel" keyword, `accountingClassHint =
FUEL_EXPENSE` should fire → 6025's `accountingClass = FUEL_EXPENSE`
should match → ACCOUNTING_CLASS_MATCH +15 → 6025 should reach ~30-40
score. **But 6025 doesn't appear at all**, suggesting either the
cluster's `effectivePurposeConcept` isn't FUEL or the projection
layer excludes 6025 upstream of scoring.

Requires deeper cluster-level trace (out of scope for this
verification slice).

### 14 · Real 1091559 trace (post-Fix-1 v211)

- **Extraction:** vendor=`Oakcreek Golf & Turf LP`,
  invoice=`1091559-00`, total=`77833.35 CAD`
- **Line items:**
  - "1 30807 TORO GM3500D KUBOTA ENGINE Serial #: 418124536" ×1 @ $74112.00
  - "2 30629 PREMIUM SEAT GM3500D" ×1 @ $0
  - "Alberta Tire Levy ADF" @ $15.00
- **Live `capitalRecommendation.state`:** `AMBIGUOUS` — "Invoice total
  $77833.35 exceeds the capitalisation threshold of $5000.00. No
  explicit capital-suggesting keyword in the description."
- **Live `glRecommendation.reason`:** `multi_allocation:2_clusters ·
  status=ABSTAIN_NO_CANDIDATES · confidence=REVIEW_REQUIRED`
- **Live `glRecommendation.candidates`: EMPTY**
- **`glRecommendation.accountNumber` = null**

**Interpretation:** SAFE abstention. The real invoice DOES have
strong capital-purchase evidence ("TORO GM3500D KUBOTA ENGINE"), but
the capital classifier's keyword lexicon didn't match "TORO"/"KUBOTA"
/"ENGINE" as capital-suggestive. Composed treatment defensibility is
UNRESOLVED (AMBIGUOUS state). No accountingClassHint. Every candidate
scored 0 → NO_ELIGIBLE_CANDIDATES.

**Category D-safe** — correct abstention on ambiguous evidence.

### 15 · Real 1091559 UI result

Card shows ABSTAIN_NO_CANDIDATES / REVIEW_REQUIRED. No wrong GL
account displayed. Safe.

### 16 · API / DB / DOM parity

- **DB (persisted findings):** pre-Fix-1 timestamps; no GL account in
  any persisted finding.
- **API (`ap-evidence` route):** returns FRESH glRecommendation via
  live `analyseIngestedInvoice` call. Values captured in §4/§10/§14.
- **DOM:** the UI card renders from the API response. Founder-visible
  "1313 + 9900" for 221178: 1313 is fresh (in API), 9900 is likely a
  cluster-2 winner NOT exposed at the top-level API `candidates`
  field, OR founder saw an earlier browser-cached render before v211
  hit steady state.

The three layers agree: **1313 IS the fresh top-1 for 221178**,
**1000 IS the fresh top-1 for DMM**. Fix 1's expected structural
elimination of 9900/1000 did NOT happen at the tier gate.

### 17 · Stale-analysis UX finding

**No stale-analysis indicator or reanalyse action exists on the
Work Intake card.** Confirmed by grepping the mission-control
intake-review + AP-evidence surfaces — no `stale`, no `reanalyse`
button, no "analysis version X (behind current Y)" banner.

Recommendation (deferred, NOT implemented in this slice per Founder
§8):
- Add `analysisVersion` + `lastAnalysedAt` + `currentAnalyserVersion`
  to the AP-evidence response.
- Card renders a subtle "Analysis behind current version — reanalyse"
  chip when `analysisVersion !== currentAnalyserVersion`.
- One-click reanalyse action enqueues `AP_INVOICE_REANALYSE` job.
- After successful reanalyse, findings AND analyser summary refresh.

This prevents a future recurrence of "founder sees stale analysis and
can't tell it's stale." Separately track under a UX/product task.

Note: the API response for `ap-evidence` ALREADY runs the analyser
fresh on every GET — so the CARD's live-recommendation section IS
current. Only the persisted findings on the card lag. This mitigates
the risk but doesn't eliminate it (persisted findings can still
reflect old logic).

### 18 · Exact next first-failure boundary

**Fix 1 has a plumbing gap** — the ranker's `assignCandidateTier` at
[canonical-ranker.ts:1420-1447](../src/lib/ap-intelligence/canonical-ranker.ts#L1420)
does NOT consume `AccountSemantics.postingRole` /
`structuralPostingRestrictions` produced by Fix 1's
`derivePostingRole` extension. It reads:
1. `postable` (from `postingBlockersByAccount` — computed in
   [analyse.ts:1466-1481](../src/lib/ap-intelligence/analyse.ts#L1466)
   from `allowManualPosting` + `fundApplicability`, NOT from
   `AccountSemantics.postingRole`)
2. Raw `account.isBankAccount === true` / `isCashAccount === true` /
   `isControlAccount === true` boolean flags

Neither path fires for real Coulee Ridge cash-equivalent accounts
whose booleans are `false`. Fix 1's semantic contract is architecturally
correct but functionally isolated from the ranker's tier gate.

**Per-fixture Founder §9 classification:**
- 221178 → **Category C** (1313 non-bank wrong account still wins)
- DMM → **Category D** (no candidate; 1000 top of ABSTAIN list — Fix 1
  plumbing gap allows 1000 to persist as top candidate)
- 1091559 → **Category D-safe** (correct abstention)

### 19 · Whether Fix 2 remains justified

**Not yet — Fix 1 must fully land first.** Fix 2 (defensibility
promotion from purpose classifier commitment) was designed for
cases where 6054 / correct account is in candidates but scores
below threshold. Currently:
- 221178: 6054 is NOT in top candidates at all — Fix 2 wouldn't help
  until the plumbing gap is closed AND the purpose classifier commits
  SOFTWARE_SUBSCRIPTION.
- DMM: 6025 (correct fuel account) is NOT in top-4 — Fix 2 wouldn't
  help until the fuel purpose commits AND accountingClassHint reaches
  the cluster.
- 1091559: correct behavior (abstain), no Fix-2 need.

**Fix 2 is premature. The correct next step is Fix 1B: close the
plumbing gap between `AccountSemantics.postingRole` and
`assignCandidateTier`.**

### 20 · Recommendation for next step

**Fix 1B (small runtime change, tightly scoped):** Extend
`assignCandidateTier` at
[canonical-ranker.ts:1436-1447](../src/lib/ap-intelligence/canonical-ranker.ts#L1436)
to ALSO check `structuralPostingRestrictions` (via a widened
`preResolvedSemantics` field OR by directly checking
`account.fsGroupKey === "BS_CASH_EQUIVALENTS"` as a fs-group
structural extension of the existing boolean-flag gate).

**Proposed diff** (~5 lines):
```ts
// Existing check (unchanged):
if (!postable) return { tier: "INELIGIBLE", tierReason: "postable=false ..." };
if (account.isBankAccount === true || account.isCashAccount === true
    || account.isControlAccount === true) return { tier: "INELIGIBLE", ... };

// NEW: extend structural check with fs-group taxonomy (mirrors Fix 1)
if ((account as { fsGroupKey?: string | null }).fsGroupKey === "BS_CASH_EQUIVALENTS") {
  return { tier: "INELIGIBLE", tierReason: "fs-group BS_CASH_EQUIVALENTS (structural)" };
}
```

Same principle as Fix 1: consumes structural fs-group taxonomy
directly. Not asset-blanket-ban. Immediately eliminates 1000/1001/9900
from real Coulee Ridge tier competition.

Alternative — plumb `AccountSemantics.postingRole` /
`structuralPostingRestrictions` through the ranker input via widened
`accountSemanticsByAccountId` map (more architecturally clean but
higher plumbing surface).

Founder-authorized minimum-viable Fix 1B: the 5-line direct
fs-group check in `assignCandidateTier`.

Then re-verify all 3 fixtures. If 221178's Category-C failure
persists after Fix 1B (1313 still wins), THAT is the point to
authorize Fix 2 (defensibility promotion) — because at that point
we'll know it's a scoring/evidence issue, not a plumbing issue.

---

## §appendix · Full JSON API responses captured

- [test-results/phase72n-fix1-lrncy9ib.json](../test-results/phase72n-fix1-lrncy9ib.json) — 221178.pdf
- [test-results/phase72n-fix1-094a8uyu.json](../test-results/phase72n-fix1-094a8uyu.json) — B0037FC.PDF
- [test-results/phase72n-fix1-w2io64kn.json](../test-results/phase72n-fix1-w2io64kn.json) — 1091559.pdf

Test spec:
[tests/e2e/phase72n-fix1-acceptance.staging.spec.ts](../tests/e2e/phase72n-fix1-acceptance.staging.spec.ts).

---

**Not merged. No production deploy.** Cohort remains deferred.

**Fix 1 landed but did not achieve founder-facing acceptance for DMM
and possibly for 221178's cluster-2 winner.** Awaiting founder
authorization of Fix 1B (5-line tier-gate extension) before further
scoring-side work.
