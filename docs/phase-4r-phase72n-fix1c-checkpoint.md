# Phase 4R · Phase 7.2N · Fix 1C — Checkpoint (20-item)

**Status:** Semantic-contract plumbing correction. `assignCandidateTier`
now consumes `CanonicalAccountSemantics.structuralPostingRestrictions`
as the SINGLE authoritative source for structural INELIGIBLE decisions.
Duplicate raw-boolean reinterpretation removed. 241/241 targeted tests
green (including 9-test semantic-consumption guard suite with source-
level static check). Sealed benchmark byte-identical. Deployed to
staging **v212**. Playwright acceptance verified:
- 221178: 9900 ELIMINATED ✓ (but 1313 still wins — Category C)
- DMM: 1000/1001 ELIMINATED ✓ (but 1200/1201 AR surfaces — new leak)
- 1091559: safe abstain preserved

**Fix 2 remains deferred.** New structural leak class identified
(BS_AR accounts) — Fix 1D territory.

**Not merged. No production deploy.**

---

## §15 · 20-item required checkpoint

### 1 · Semantic-plumbing change

**Single authoritative source-of-truth for structural INELIGIBLE.**

- New shared type `TierSemanticsInput` exported from
  [canonical-ranker.ts:194-201](../src/lib/ap-intelligence/canonical-ranker.ts#L194).
  Widens `accountSemanticsByAccountId` values to include
  `postingRole` + `structuralPostingRestrictions` in addition to
  `statementRole` + `accountingClass`.
- `assignCandidateTier` at
  [canonical-ranker.ts:1552-1602](../src/lib/ap-intelligence/canonical-ranker.ts#L1552)
  now reads:
  ```ts
  if (preResolvedSemantics && preResolvedSemantics.structuralPostingRestrictions.length > 0) {
    return { tier: "INELIGIBLE", tierReason: `structural restriction: ...` };
  }
  ```
- Plumbed through: `analyse.ts` (`accountSemanticsByAccountId` map
  population) → `computeAllocations` → `rankClusters` →
  `rankClusterCanonically` → `rankCanonical`.

### 2 · Raw structural checks removed / retained

**REMOVED from `assignCandidateTier`:**

```ts
if ((account as unknown as { isBankAccount?: boolean }).isBankAccount === true
    || (account as unknown as { isCashAccount?: boolean }).isCashAccount === true
    || (account as unknown as { isControlAccount?: boolean }).isControlAccount === true) {
  return { tier: "INELIGIBLE", tierReason: "bank/cash/control account (structural)" };
}
```

Fully subsumed by `structuralPostingRestrictions` — `derivePostingRole`
already reads these boolean flags AND now the fs-group fallback (Fix 1),
so any account that would have tripped the raw check now emits a
BANK/CASH/CONTROL postingRole → BANK_ACCOUNT/CASH_ACCOUNT/CONTROL_ACCOUNT
restriction → INELIGIBLE via the semantic contract.

**RETAINED (with explicit rationale):** the `!postable` check at the
top of `assignCandidateTier`. `postable` derives from
`postingBlockersByAccount` (built in analyse.ts:1466-1481 from
`allowManualPosting` + `fundApplicability` — NOT from AccountSemantics).
These are the eligibility-gate blockers that predate the semantics
layer. Consolidation deferred (documented in §5 audit).

### 3 · One-source-of-truth proof

Two guards:

**(a) Runtime behavioural:**
[tests/phase4r-phase72n-fix1c-semantic-consumption.test.ts](../tests/phase4r-phase72n-fix1c-semantic-consumption.test.ts)
`§10 semantic-consumption guard`:
- `structuralPostingRestrictions` non-empty on the semantics input →
  tier INELIGIBLE even when the account's raw booleans are all false
  (the real Coulee Ridge cash/bank shape).
- Inverse: `structuralPostingRestrictions` empty + raw
  `isBankAccount=true` → tier NOT auto-INELIGIBLE (semantics is
  authoritative, ranker does not carry a hidden raw-boolean second
  opinion).

**(b) Source-level static:**
`static source guard` test reads `canonical-ranker.ts`, extracts the
`assignCandidateTier` function body, and asserts no
`.isBankAccount === true` / `.isCashAccount === true` /
`.isControlAccount === true` idiom OR `as unknown as { isBankAccount? }`
loose cast remains. Prevents accidental regression.

### 4 · Real-COA tests

New suite covers all Founder §6 mandatory shapes using the ACTUAL
Coulee Ridge staging metadata (verified via read-only Neon probe):

| Account | Real shape (verified via staging DB) | Test verdict |
|---|---|---|
| 1000 Petty Cash | `type=ASSET, accountRole=STANDARD, isCash=false, fsg=BS_CASH_EQUIVALENTS` | `postingRole=CASH`, `structuralPostingRestrictions=[CASH_ACCOUNT]`, **tier=INELIGIBLE** ✓ |
| 1001 Bank - General | same shape | `postingRole=BANK`, `[BANK_ACCOUNT]`, **INELIGIBLE** ✓ |
| 9900 Bank - Credit Facilities | same shape | `postingRole=BANK`, `[BANK_ACCOUNT]`, **INELIGIBLE** ✓ |
| 1506 Equipment & Fixtures - Grounds | `type=ASSET, fsg=BS_CAPITAL_ASSETS` | `postingRole=STANDARD`, `[]`, **NOT INELIGIBLE** ✓ (proves no ASSET blanket-ban) |
| 1313 Inventory - Proshop Repairs | `type=ASSET, fsg=BS_INVENTORY` | `postingRole=STANDARD`, `[]`, **NOT INELIGIBLE** ✓ |
| 1101 Prepaid Expenses | `type=ASSET, fsg=BS_PREPAID_EXPENSES` | `postingRole=STANDARD`, `[]`, **NOT INELIGIBLE** ✓ |

### 5 · Semantic-consumption guard

Test at
[tests/phase4r-phase72n-fix1c-semantic-consumption.test.ts § "§10 semantic-consumption guard"](../tests/phase4r-phase72n-fix1c-semantic-consumption.test.ts):

Directly-constructed synthetic `TierSemanticsInput` with `[BANK_ACCOUNT]`
restriction → ranker returns INELIGIBLE, even though the underlying
`AccountView.isBankAccount=false`. This is the exact scenario Fix 1B
would have missed if we had duplicated the fs-group check inline.

### 6 · Sealed benchmark

Post-Fix-1C sealed run at
[tests/ap-benchmark/runs/ap-bench-2026-08-15T00-54-47-788Z-p0on-p2on.json](../tests/ap-benchmark/runs/ap-bench-2026-08-15T00-54-47-788Z-p0on-p2on.json):

| | Pre-Fix-1C (Phase 7.2M-B baseline) | Post-Fix-1C | Δ |
|---|:---:|:---:|:---:|
| Pass | 18 | 18 | 0 |
| Fail | 23 | 23 | 0 |
| Unsafe | 0 | 0 ✓ | 0 |
| Canonical winner/score/status deltas | — | **0** | 0 |

All 5 LOCKED cases byte-identical. Sealed benchmark unaffected —
the sealed seed COA has proper boolean flags (`isBankAccount=true`)
so the semantic contract's fs-group fallback path never fires on
sealed corpus.

### 7 · Unsafe

**0.** ✓

### 8 · Fresh 221178 trace (staging v212, post-Fix-1C)

Full API response:
[test-results/phase72n-fix1-lrncy9ib.json](../test-results/phase72n-fix1-lrncy9ib.json).

- Extraction: `Club Support Inc`, invoice `221178`, total `3794.18 CAD`
- `capital.state`: OPERATING (small-value, no capital keywords — WEAK)
- `glRecommendation.reason`: `multi_allocation:2_clusters · status=RECOMMEND · confidence=MODERATE`
- `glRecommendation.candidates`:
  - **`1313 Inventory - Proshop Repairs` — conf 54**
  - `1100 Prepaid Deposits` — conf 26
  - `1100 Prepaid Deposits` — conf 26 (dup from 2-cluster)
- **9900 IS NOT IN CANDIDATES.** ✓ Fix 1C succeeded on this
  fixture.
- Winner: 1313 at conf 54, RECOMMEND MODERATE — **still wrong**.

### 9 · Fresh 221178 founder card

The mission-control WI card reads `glRecommendation.candidates` — top
1313 shown as suggested GL. 9900 no longer in the projection at all.
DOM verification: the API IS the source-of-truth for the card's
"Suggested GL" section. Assertion in
[tests/e2e/phase72n-fix1-acceptance.staging.spec.ts](../tests/e2e/phase72n-fix1-acceptance.staging.spec.ts)
passes:
`expect(inAllocation, "9900 must not be in allocations post-Fix-1").toBe(false)` ✓

### 10 · 9900 disposition

**INELIGIBLE — completely absent from post-Fix-1C candidates.** The
semantic-contract chain worked end-to-end for the 221178 fixture.

### 11 · 1313 disposition

**Wins with conf 54 RECOMMEND MODERATE.** Wrong destination for an
online-backup license service. 1313 is a legitimate ASSET
(BS_INVENTORY, `postingRole=STANDARD`, `structuralPostingRestrictions=[]`)
so tier assignment correctly does NOT mark it INELIGIBLE. Under
WEAK composed treatment (base-state OPERATING, no explicit operating
keyword) → competition mode OPEN_TREATMENT → tier priority does not
govern → flat score decides → 1313's lexical evidence dominates.

**Founder §7 Category C** — wrong non-bank account still wins.

### 12 · 6054 result

**Not in top candidates.** `6054 Computer & IT Services` did not
surface in the top-3 for 221178. Either it scored below 54 (and got
suppressed in top-1-per-cluster projection) OR the SOFTWARE_SUBSCRIPTION
purpose classifier didn't commit on the specific line-item wording.

Fix 1C's job was to eliminate 9900. Fixing 6054's non-emergence is
Fix 2 territory (defensibility promotion from purpose classifier) or
a separate cluster-treatment-threading diagnostic.

### 13 · Fresh DMM trace (staging v212, post-Fix-1C)

Full API response:
[test-results/phase72n-fix1-094a8uyu.json](../test-results/phase72n-fix1-094a8uyu.json).

- Extraction: `DMM ENERGY INC`, invoice `B0037FC`, total `2532.92 CAD`
- Line items: `"9 Diesel LS Dyed" $2344.30 + "PFT :" $68.00`
- `capital.state`: OPERATING
- `glRecommendation.reason`: `cluster_owned_projection:single_cluster:abstain_ambiguity`
- `glRecommendation.candidates`:
  - `1100 Prepaid Deposits` — conf 26
  - `1101 Prepaid Expenses` — conf 26
  - **`1200 Accts Receivable - Members & Assoc` — conf 26**
  - **`1201 Accts Receivable - Monthly Dues` — conf 26**
- **1000 Petty Cash and 1001 Bank - General are ELIMINATED** ✓
- Winner: null (ABSTAIN_AMBIGUITY)

### 14 · Fresh DMM founder card

Card shows ABSTAIN_AMBIGUITY with top candidate `1100 Prepaid Deposits`.
1000/1001 gone. Assertion passes:
`expect(1000, "must not be in allocations").toBe(false)` ✓.

**BUT** — `1200/1201 Accts Receivable` accounts now surface as
top-3 candidates. This is a NEW structural leak (§18).

### 15 · 1000 / 1001 disposition

Both **INELIGIBLE**. Semantic contract chain succeeded — both
accounts are BS_CASH_EQUIVALENTS on the real COA →
`derivePostingRole` returns CASH/BANK →
`deriveStructuralPostingRestrictions` returns `[CASH_ACCOUNT]` /
`[BANK_ACCOUNT]` → `assignCandidateTier` returns INELIGIBLE →
`canonicalCompare` places them last → they cannot win.

### 16 · Real 1091559 trace (staging v212, post-Fix-1C)

Full API response:
[test-results/phase72n-fix1-w2io64kn.json](../test-results/phase72n-fix1-w2io64kn.json).

- Extraction: `Oakcreek Golf & Turf LP`, invoice `1091559-00`, total `77833.35 CAD`
- Line items: `"TORO GM3500D KUBOTA ENGINE Serial #: 418124536" $74112` + `"Alberta Tire Levy" $15`
- `capital.state`: AMBIGUOUS (over threshold, no capital keyword —
  the capital classifier's lexicon doesn't match `TORO`/`KUBOTA`/`ENGINE`)
- `glRecommendation.reason`: `multi_allocation:2_clusters · status=ABSTAIN_NO_CANDIDATES · confidence=REVIEW_REQUIRED`
- `glRecommendation.candidates`: `[]` empty
- Winner: null

### 17 · Real 1091559 card

Card shows `ABSTAIN_NO_CANDIDATES / REVIEW_REQUIRED` — safe abstention.
No wrong GL displayed. Same behaviour as pre-Fix-1C on this fixture
(Fix 1C targets cash-equivalent leak, not capital-treatment path).

**Founder §7 Category D-safe.**

### 18 · Semantic-contract bypass audit

Narrow audit per Founder §11 — searching for other fields that are
authoritatively derived by `resolveAccountSemantics` but bypassed
downstream by direct raw-metadata reads.

**Findings (report-only, NOT refactored in this slice):**

| Semantic field | Consumer bypass | Impact | Priority |
|---|---|:---:|:---:|
| `AccountSemantics.postingRole` / `structuralPostingRestrictions` | **CLOSED by Fix 1C** ✓ (was: `assignCandidateTier` raw booleans) | — | — |
| `AccountSemantics.statementRole` | Canonical-ranker's `NATURE_COMPAT` observation at [canonical-ranker.ts:1071-1091](../src/lib/ap-intelligence/canonical-ranker.ts#L1071) reads `transaction.natureLeader` + `ACCEPTABLE_TYPES_BY_NATURE[leader]` against `accountType.toUpperCase()` — bypasses `AccountSemantics.statementRole` | Runtime scoring uses raw type inference not the typed statementRole. Would need broader refactor. | Medium |
| `AccountSemantics.accountingClass` | Consumed correctly by `treatmentAwareDiscovery` and `ACCOUNTING_CLASS_MATCH` (Phase 7.2M-B) ✓ | — | — |
| Raw `account.type` in scoring | canonical-ranker.ts:1215 `const accountType = account.type ?? "EXPENSE";` — used in many scoring observations. Not a bypass per se (it IS the source), but the fallback default masks missing data. | Existing pattern; Phase 7.2L noted this. | Low |
| **NEW: BS_AR structural family** | `AccountSemantics.derivePostingRole` does NOT recognize `fsGroupKey === "BS_AR"` as structurally AP-ineligible. Type=ASSET AR receivable accounts (1200 Accts Receivable - Members, 1201 Accts Receivable - Monthly Dues) surface as candidates. | **HIGH — new leak revealed by Fix 1C.** DMM now shows 1200/1201 as top-3 candidates. | **HIGH — Fix 1D territory** |
| `AccountView.type` loose default | Multiple sites default to `"EXPENSE"` when type undefined. Not a semantic bypass (type IS the source) but creates silent fallback. | Discussed in Phase 7.2L. | Low |

**Additional finding:** the `postable` gate derived from
`postingBlockersByAccount` at analyse.ts:1466-1481 remains a
SEPARATE structural authority (checks `allowManualPosting` +
`fundApplicability`). It correctly co-exists with the new
`structuralPostingRestrictions` gate (both branches in
`assignCandidateTier`). Consolidation candidate for a future
refactor — no runtime defect at present.

### 19 · Exact next first-failure boundary

Three distinct boundaries surfaced post-Fix-1C:

**(A) 221178 — Founder §7 Category C.** 1313 Inventory-Proshop-Repairs
wins at conf 54 RECOMMEND MODERATE for an online-backup license
service. **Root cause: WEAK composed treatment defensibility.**
`capital.state = OPERATING` via base state → `defensibility = WEAK` →
`accountingClassHint = null` → ACCOUNTING_CLASS_MATCH doesn't fire →
6054 Computer & IT Services gets no class-alignment boost → 1313's
lexical evidence dominates in OPEN_TREATMENT competition.

This is precisely the case class Fix 2 was designed for.

**(B) DMM — new structural leak: BS_AR family.** Post-Fix-1C top
candidates `[1100 Prepaid Deposits, 1101 Prepaid Expenses, 1200
Accts Receivable - Members, 1201 Accts Receivable - Monthly Dues]`.
Fuel account `6025 Fuel (Gas/Diesel)` still absent from top-4.

- 1100/1101 Prepaid — LEGITIMATE ASSET candidates (may be correct
  for other transaction types like annual insurance)
- **1200/1201 Accts Receivable — ILLEGITIMATE for AP debit.** AR is
  money owed TO the club by members; posting an AP payable invoice
  to AR is structurally wrong.

**Root cause: `derivePostingRole` doesn't recognize `fsGroupKey ===
"BS_AR"` as structurally ineligible.** Fix 1 covered BS_CASH_EQUIVALENTS
per founder authorization; BS_AR wasn't included because the earlier
audit found real 2000-2020 BS_AR accounts are all LIABILITY type
(blocked by `ruleLiability`). But **member-side AR accounts**
(1200/1201) are ASSET type and BS_AR — same structural-leak pattern
as cash-equivalents.

This is **Fix 1D** territory — extend the same fs-group structural
fallback pattern to cover BS_AR (or, more broadly, add a
`STRUCTURALLY_AP_INELIGIBLE_FS_GROUPS` set that
`derivePostingRole` consults).

**(C) 1091559 — Founder §7 Category D-safe.** No candidate;
`ABSTAIN_NO_CANDIDATES / REVIEW_REQUIRED`. Correct behavior for
this specific real invoice given the vague-body-shape and
capital-classifier's lexicon gap on `TORO`/`KUBOTA`/`ENGINE`. Not a
first-failure boundary in the founder's classification — the safe
abstention is correct pending fuller purpose-classifier commitment
(Fix 2 or beyond).

### 20 · Whether Fix 2 remains justified

**Fix 2 IS justified for 221178 (Category C) but STILL DEFERRED per
Founder §12.** The 221178 fresh trace shows exactly the pattern
Fix 2 targets:
- Purpose classifier likely commits (Club Support / online backup /
  license fee) with confidence >= 80
- `capital.state = OPERATING` via base state → `defensibility = WEAK`
- `accountingClassHint = null` → ACCOUNTING_CLASS_MATCH doesn't fire
- 1313 wins on flat lexical score

BUT the founder-directive priority ordering is clear: **fix the
NEW structural leak (BS_AR) before touching composition rules.**
Fix 1D (BS_AR structural fallback) is architecturally identical to
Fix 1C (BS_CASH_EQUIVALENTS structural fallback) — same one-line
extension of `derivePostingRole`. Then re-verify 221178/DMM/1091559.
If 221178 still shows 1313 winning after 1200/1201 AR are eliminated
from the pool, THAT is the point to authorize Fix 2.

**Recommendation:**

1. **Fix 1D — small extension of `derivePostingRole`** to treat
   `fsGroupKey === "BS_AR"` + `type === "ASSET"` as `postingRole =
   CONTROL` (or a new `RECEIVABLE` role) → `structuralPostingRestrictions`
   emits `CONTROL_ACCOUNT` (or new `AR_ACCOUNT`) → INELIGIBLE via
   the same semantic-contract chain Fix 1C now consumes.
2. Re-verify 221178/DMM/1091559 on staging.
3. Then Fix 2 (defensibility promotion) authorization decision.

**Fix 1D scope is architecturally identical to Fix 1C, mirrors the
same principle (fs-group structural taxonomy over raw booleans), and
requires ~5 lines in `derivePostingRole`.** No new plumbing needed —
the Fix 1C `assignCandidateTier` consumption path already handles
any new `structuralPostingRestrictions` entry automatically.

---

## §appendix · Files

**Runtime:**
- [src/lib/ap-intelligence/canonical-ranker.ts](../src/lib/ap-intelligence/canonical-ranker.ts) — new `TierSemanticsInput` type; `assignCandidateTier` consumes `structuralPostingRestrictions`; raw-boolean check removed; `resolveAccountSemanticsForCandidate` returns widened shape
- [src/lib/ap-intelligence/gl-allocations.ts](../src/lib/ap-intelligence/gl-allocations.ts) — plumbing type widened to `TierSemanticsInput`
- [src/lib/ap-intelligence/analyse.ts](../src/lib/ap-intelligence/analyse.ts) — semantics map population includes `postingRole` + `structuralPostingRestrictions`

**Tests:**
- [tests/phase4r-phase72n-fix1c-semantic-consumption.test.ts](../tests/phase4r-phase72n-fix1c-semantic-consumption.test.ts) — 9 tests: 6 real-COA controls + semantic-consumption guard + source-level static guard
- [tests/phase4r-phase72l-hierarchy-invariants.test.ts](../tests/phase4r-phase72l-hierarchy-invariants.test.ts) — mkInput widened for backwards compatibility

**Staging deployment:**
- Web v212, `spectre-staging:deployment-01M01ENE2JEBRR6VBGMXN46W0N`
- Worker v109
- `/api/health = 200`
- Rollback anchors: v211 web / v108 worker

**Playwright acceptance:**
- [tests/e2e/phase72n-fix1-acceptance.staging.spec.ts](../tests/e2e/phase72n-fix1-acceptance.staging.spec.ts) — passing 1/1
- Response artifacts:
  [test-results/phase72n-fix1-lrncy9ib.json](../test-results/phase72n-fix1-lrncy9ib.json),
  [test-results/phase72n-fix1-094a8uyu.json](../test-results/phase72n-fix1-094a8uyu.json),
  [test-results/phase72n-fix1-w2io64kn.json](../test-results/phase72n-fix1-w2io64kn.json)

---

**Not merged. No production deploy.** Cohort remains deferred.
Fix 1C closed the semantic-contract plumbing gap. **Fix 1D (BS_AR
structural extension) is the immediate next recommended step**,
followed by Fix 2 decision after Fix 1D re-verification.
