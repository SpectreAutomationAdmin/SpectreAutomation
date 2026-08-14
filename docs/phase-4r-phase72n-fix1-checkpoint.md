# Phase 4R · Phase 7.2N · Fix 1 — Checkpoint (fsGroup structural fallback)

**Status:** Founder-authorised Fix 1 (only). Implemented, tested,
sealed-benchmark verified, and deployed to staging (web v211, worker
v108) for founder-mandatory §6-§8 re-runs on 221178 / DMM / 1091559.

Fix 2 NOT implemented. Broad cohort NOT resumed. Runtime otherwise
frozen.

**Not merged. No production deploy.**

---

## §11 · 18-item required checkpoint

### 1 · Exact Fix 1 implementation

[account-semantics/index.ts:307-359](../src/lib/ap-intelligence/account-semantics/index.ts#L307)
`derivePostingRole` extended with an fsGroupKey structural fallback
after the existing configured-accountRole + boolean-flag chain:

```ts
// After configured accountRole + isBankAccount/isCashAccount/
// isControlAccount fallbacks:
const fsg = (account.fsGroupKey ?? "").toUpperCase();
const nameLower = (account.name ?? "").toLowerCase();
if (fsg === "BS_CASH_EQUIVALENTS") {
  if (/\bbank\b/i.test(nameLower)) return { postingRole: "BANK", source: "FS_GROUP" };
  return { postingRole: "CASH", source: "FS_GROUP" };
}
return { postingRole: "STANDARD", source: "ACCOUNT_ROLE" };
```

`deriveStructuralPostingRestrictions` (unchanged) already emits
`BANK_ACCOUNT` / `CASH_ACCOUNT` from `postingRole`. Downstream tier
assignment (`assignCandidateTier` in canonical-ranker.ts) reads
`structuralPostingRestrictions.length > 0` → **INELIGIBLE**.

Net change: 17 lines. One PURE function extended. Zero weight /
threshold / policy changes.

### 2 · Why structural rather than inferred treatment filtering

The restriction fires on `fsGroupKey === "BS_CASH_EQUIVALENTS"` —
the account's own financial-statement taxonomy, a fact about the
account itself, not an inference about the transaction. It is not
gated on:
- transaction purpose classifier
- composed treatment defensibility
- accounting-nature classifier
- capital-vs-operating verdict

Any inferred-treatment-driven CONTRADICTED-vs-INELIGIBLE ambiguity is
avoided: an account whose fsGroup is BS_CASH_EQUIVALENTS is
INELIGIBLE **on every transaction, forever, regardless of what the
transaction is**. Founder §2 satisfied.

The bounded name-check (`/\bbank\b/i`) exists ONLY to distinguish
BANK vs CASH diagnostic labels — the ineligibility itself fires
whether the name matches or not (both branches produce a
`structuralPostingRestriction`).

### 3 · Related real-COA metadata audit (Founder §4)

Query across Coulee Ridge staging COA for AP-inappropriate account
families that may have unreliable boolean flags:

| Family | fsGroupKey | Rows found | Existing block | Additional runtime restriction needed |
|---|---|:---:|---|:---:|
| AR/AP control | BS_AP | 8 (Accts Payable + Bank-Visa liabilities) | `ruleLiability` (type=LIABILITY) | **NO** |
| Equity | BS_OTHER_EQUITY | 1 (Members' equity) | `ruleEquity` (type=EQUITY) | **NO** |
| Revenue | IS_MEMBERSHIP_DUES etc. | 29 (Golf Shareholder etc.) | `ruleRevenue` (type=REVENUE) | **NO** |
| Deferred capital contributions | BS_DEFERRED_CAPITAL_CONTRIBUTIONS | 1 | `ruleLiability` | **NO** |
| Section funds | BS_SECTION_FUNDS | 8 (Mens/Ladies/Senior/Juniors sections) | `ruleLiability` | **NO** |
| Cash equivalents | **BS_CASH_EQUIVALENTS** | **3** (1000/1001/9900) | **NONE** (isBankAccount=false) | **YES — Fix 1 addresses this** |

**Only BS_CASH_EQUIVALENTS lacks a structural block on the real
tenant.** All other AP-inappropriate targets fall under LIABILITY /
EQUITY / REVENUE types which are already caught by the existing
type-based rules.

### 4 · Cash / bank / control regression tests

New test suite
[tests/phase4r-phase72n-fix1-cash-equivalents.test.ts](../tests/phase4r-phase72n-fix1-cash-equivalents.test.ts):
**12 tests, all green**. Coverage:

- 5 real-COA cash-equivalent shapes (Petty Cash 1000 / Bank-General
  1001 / Credit Facilities 9900 / no-bank-in-name cash-equivalent /
  anti-fragility non-'bank' name)
- 4 counter-controls (capital ASSET / inventory ASSET / prepaid ASSET
  / real Coulee Ridge 1313 Inventory-Proshop-Repairs all remain
  STANDARD-eligible; Founder §3 proves the fix is not an asset
  blanket-ban)
- 3 legacy-path preservation (configured accountRole=BANK still wins,
  boolean-flag isBankAccount still wins, ordinary EXPENSE remains
  STANDARD)

### 5 · Sealed benchmark delta

Post-Fix-1 sealed benchmark run at
[tests/ap-benchmark/runs/ap-bench-2026-08-14T22-17-43-412Z-p0on-p2on.json](../tests/ap-benchmark/runs/ap-bench-2026-08-14T22-17-43-412Z-p0on-p2on.json):

| | Phase 7.2M-B baseline | Post-Fix-1 | Δ |
|---|:---:|:---:|:---:|
| Pass | 18 | 18 | 0 |
| Fail | 23 | 23 | 0 |
| Partial | 1 | 1 | 0 |
| Unsafe | 0 | **0** ✓ | 0 |
| Cases with any canonical winner/score/status delta | — | **0** | 0 |

**Zero deltas.** The sealed benchmark seed COA sets `isBankAccount=true`/
`isCashAccount=true` on its bank/cash accounts (per
`tests/ap-benchmark/seed.ts:99-100`), so the boolean-flag chain fires
before the new fsGroup fallback. Fix 1 exclusively targets the
real-COA metadata gap without affecting the sealed benchmark.

### 6 · Unsafe count

**Unsafe = 0.** Sealed benchmark verified. Real-staging verification
pending founder §6-§8 re-runs.

### 7 · 221178 before / after

**BEFORE (pre-Fix-1 staging run — from founder screenshot):**
- Vendor: Club Support
- Product: Online Backup License Fee
- Recommendation: **1313 Inventory - Proshop Repairs + 9900 Bank -
  Credit Facilities/Mortgage at HIGH confidence** (multi-allocation
  or dual-cluster resolution)

**AFTER (post-Fix-1 architectural expectation on the same invoice):**
- 9900 Bank - Credit Facilities/Mortgage: `fsGroupKey =
  BS_CASH_EQUIVALENTS`, name contains "Bank" → `postingRole = BANK`
  (source FS_GROUP) → `structuralPostingRestrictions =
  ["BANK_ACCOUNT"]` → **tier = INELIGIBLE**.
- Under `assignCandidateTier`
  ([canonical-ranker.ts:1401-1409](../src/lib/ap-intelligence/canonical-ranker.ts#L1401)):
  the early-return path fires — `structuralPostingRestrictions.length
  > 0` → `{ tier: "INELIGIBLE", tierReason: "postable=false
  (structural posting restriction)" }`.
- 9900 lands last in `canonicalCompare` regardless of competition
  mode (INELIGIBLE always last, unconditional). Cannot appear as
  a winner OR as a legitimate AP allocation candidate.

**1313 Inventory - Proshop Repairs remains STANDARD-eligible** per
Founder §3 (counter-control test confirms). Fix 1 does not touch
1313. Whether 6054 Computer & IT Services now beats 1313 depends on
the OPEN_TREATMENT / WEAK-defensibility issue that is Fix-2 territory.

**Founder-mandatory re-verification:** requires the analyser to re-run
on 221178 with the newly-deployed Fix 1. The persisted
`WorkIntakeFinding` records reflect the analysis at last-analysed
time (before Fix 1). Options: (a) trigger a re-analyse via the
staging inspect-wi endpoint's replay path, (b) wait for a new
Outlook ingestion of a similar invoice. Details in §12 below.

### 8 · DMM before / after

**BEFORE (per founder screenshot):**
- Vendor: DMM Energy
- Product: dyed low-sulphur diesel
- Purpose classifier: identified as Fuel/petroleum ✓
- Recommendation: **1000 Petty Cash** ← wrong destination

**AFTER (post-Fix-1 architectural expectation):**
- 1000 Petty Cash: `fsGroupKey = BS_CASH_EQUIVALENTS`, name does NOT
  contain "bank" → `postingRole = CASH` (source FS_GROUP) →
  `structuralPostingRestrictions = ["CASH_ACCOUNT"]` → **tier =
  INELIGIBLE**.
- 1000 lands last. Cannot win.
- Whether 6025 Fuel (Gas/Diesel) now wins depends on cluster-treatment
  threading — separate question.

Founder-mandatory re-verification same as §7.

### 9 · Real 1091559 trace

Staging DB probe found three OPEN AP_INVOICE_REVIEW work-intake items
that match the search criteria — one likely corresponds to 1091559
based on the finding statement "The total is over the capitalisation
threshold but the description does not clearly indicate a durable
asset..." (WI `w2io64kn`, characteristic vague-body Oakcreek shape).

Findings persisted (before Fix 1):
- ap.invoice.missing_invoice_date (MEDIUM)
- ap.invoice.missing_subtotal (LOW)
- ap.invoice.missing_tax (INFO)
- ap.invoice.requires_review (MEDIUM) — capital-classifier says
  "AMBIGUOUS: over threshold, no capital keyword"
- ap.invoice.vendor_not_found (MEDIUM)

Real-staging trace of composed treatment / accountingClassHint /
canonical scoring / per-candidate tier is NOT persisted in the
findings table — the AP intelligence layer re-derives on read. Would
require inspect-wi API call (SUPER_ADMIN-gated) or a new re-analyse
trigger. Direct trace deferred to founder re-verification step.

Fix 1 does not directly affect 1091559 (which is a capital-treatment
case, not a cash-equivalent-leak case) — the LOCKED-baseline
behavior (1506 correctly identified but score 3, ABSTAIN) should
persist byte-identical, consistent with the sealed benchmark
verification (§5).

### 10 · Whether 6054 becomes canonical winner after removal of 9900

**Undetermined by Fix 1 alone.** Removing 9900 eliminates the wrong-
family competitor but does not add positive evidence to 6054. Under
the current WEAK/OPEN_TREATMENT mode for 221178:
- ACCOUNTING_CLASS_MATCH doesn't fire (defensibility WEAK).
- 6054's score depends on lexical evidence + Phase 7.2I-a fs-group
  affinity (SHARED_FS_GROUP_AFFINITY = 35 for IT_SERVICES concept
  vs SOFTWARE_SUBSCRIPTION query).
- 1313 Inventory-Proshop-Repairs may still be a competitor if its
  name-tokens overlap the invoice text.

**Likely outcome per Founder §6 expectation:** either 6054 becomes
canonical winner (if its lexical/fs-group evidence beats 1313) OR
canonical status shifts from RECOMMEND to ABSTAIN (if no candidate
scores above COMMIT_MIN_SCORE=30 without the accountingClassHint).
Either outcome is safe. Neither would be a false RECOMMEND on a
bank/mortgage account. **This is the point.**

### 11 · Whether DMM reaches the appropriate fuel account after removal of 1000

**Likely yes.** DMM's composed treatment IS defensibly STRONG
(operating keyword `\bfuel\b` fires positively in
capital-vs-operating). Composition rule 7 → STRONG. `accountingClassHint
= FUEL_EXPENSE` (per M-B mapping). ACCOUNTING_CLASS_MATCH fires on
6025 Fuel (Gas/Diesel) which resolves to `accountingClass =
FUEL_EXPENSE` via the name regex path. 6025 gets +15 in
TAXONOMY_ALIGNMENT.

With 1000 removed from the competition, 6025 should win the fuel
family. If it does not, the failure boundary shifts to cluster-
treatment threading (composed treatment not reaching the ranker),
which is a distinct diagnostic to run post-verification.

### 12 · Whether 221178 still fails because treatment.defensibility is WEAK

**Yes, likely — but the failure mode changes shape.**

Fix 1 eliminates 9900 (the catastrophic wrong-family cash-equivalent
winner) but does not change treatment defensibility. For 221178:
- capital.state = OPERATING via base state (no explicit operating
  keyword in "Online Backup License Fee" wording) → composed
  defensibility = WEAK.
- Under WEAK, `deriveAccountingClassHint = null` →
  ACCOUNTING_CLASS_MATCH does not fire → 6054 doesn't get the +15
  boost.
- Competition mode = OPEN_TREATMENT → tier priority does not govern
  cross-tier ordering → 1313 (PLAUSIBLE) can still outrank 6054
  (PRIMARY) on lexical evidence in the flat competition.

**This IS the case class Fix 2 was designed to address.** Whether
the pattern is still "wrong RECOMMEND on 1313" or shifts to "correct
ABSTAIN" depends on whether 6054's remaining evidence beats 1313's
lexical evidence in a flat score competition.

### 13 · Evidence ledger for 221178 (post-Fix-1, if still unresolved)

Reconstructed from static analysis of the frozen post-Fix-1 candidate
architecture (actual runtime scores not persisted; would require
inspect-wi call on re-analysed WI):

**For 6054 Computer & IT Services** (`type=EXPENSE`, `fsg=IS_IT_SOFTWARE`,
`cat=ADMIN_EXPENSES`, `accountingClass=IT_SERVICES`,
`statementRole=OPERATING_EXPENSE`):

| Proposition | Fires? | Contribution |
|---|:---:|---:|
| PURPOSE_TYPE_COMPAT (SOFTWARE_SUBSCRIPTION accepts EXPENSE) | Yes if purpose reaches ranker | +12 |
| ONTOLOGY_NAME_MATCH (`software`/`subscription`/`saas` vs "Computer & IT Services") | **No** — name doesn't contain any bridge substring | 0 |
| FS_GROUP_TAXONOMY (via 7.2I-a SHARED_FS_GROUP_AFFINITY on IS_IT_SOFTWARE) | Partial — cross-tree affinity value 35 → modest boost | +5-8 |
| ACCOUNT_NAME_SIMILARITY (dominant concept ↔ name tokens) | Partial | +5-10 |
| NATURE_COMPAT (nature accepts EXPENSE type) | Depends on defensibility | +0 to +15 |
| **ACCOUNTING_CLASS_MATCH** (M-B) | **NO** — accountingClassHint=null under WEAK defensibility | 0 |
| Total (rough): | | 20-40 |

**For 1313 Inventory - Proshop Repairs** (`type=ASSET`,
`fsg=BS_INVENTORY`, `accountingClass=MERCHANDISE_INVENTORY` default):

| Proposition | Fires? | Contribution |
|---|:---:|---:|
| Tier | Under OPEN_TREATMENT: PLAUSIBLE (equal to 6054's PRIMARY) | metadata only |
| LINE_ITEM_MATCH / ONTOLOGY_MATCH | Depends on invoice tokens matching "Inventory"/"Proshop"/"Repairs" | 0-20 |
| NATURE_INCOMPATIBLE | Would fire IF nature classifier is defensibly OPERATING_EXPENSE — but for 221178 nature likely UNKNOWN | 0 |
| Total (rough): | | 0-20 |

**Key insight:** post-Fix-1, 6054 likely EDGES OUT 1313 on evidence
strength (fs-group affinity + purpose signals accrue). But if 6054
scores below COMMIT_MIN_SCORE=30, the status remains ABSTAIN (not
RECOMMEND). That's SAFE — no false high-confidence recommendation.

The remaining evidence gap for 221178 corresponds exactly to what
Fix 2 (defensibility promotion from committed high-confidence
purpose) is designed to close.

### 14 · Evidence ledger for 1091559

Not derivable from staging findings alone. Static-analysis expectation
consistent with Phase 7.2I-b / 7.2K / 7.2L / 7.2M-B behavior on the
sealed proxy `vague-body-invoice-attachment`:

| Proposition | Fires? | Contribution |
|---|:---:|---:|
| Composed treatment defensibility | STRONG (via 7.2I-b nature=CAPITAL_ASSET defensible on "Equipment & fixtures — grounds") | — |
| accountingClassHint | Depends on purpose classifier committing CAPITAL_EQUIPMENT/CAPITAL_IMPROVEMENT (uncertain for vague-body) | possibly EQUIPMENT_ASSET |
| ACCOUNTING_CLASS_MATCH on 1506 | Fires IF hint = EQUIPMENT_ASSET AND 1506.accountingClass = EQUIPMENT_ASSET | +15 |
| CAPITAL_ASSET_MATCH | Depends on capital.state (AMBIGUOUS → capitalConfidence=0 → does NOT fire) | 0 |
| NATURE_COMPAT (CAPITAL_ASSET accepts ASSET) | Fires (7.2I-b path) | +15 |
| Estimated: | | 3-30 |

If purpose commits CAPITAL_EQUIPMENT with STRONG defensibility, 1506
score = 3 + 15 (class match) + 15 (nature compat) = 33 → RECOMMEND.
If purpose does NOT commit, ACCOUNTING_CLASS_MATCH doesn't fire and
score stays ~3-18 → ABSTAIN. Neither case is unsafe.

**Same Fix 2 territory:** if purpose confidence is high but capital
state is AMBIGUOUS, treatment defensibility currently stays at
STRONG (via 7.2I-b nature route) but capital.state may not
independently promote. Requires actual runtime trace to distinguish.

### 15 · Static authority guards

- `rankCanonical()` remains sole winner authority.
- Tier assignment unchanged in Fix 1 — the new INELIGIBLE tier
  simply fires for one additional class of accounts (BS_CASH_EQUIVALENTS
  cash/bank) via the existing `structuralPostingRestrictions.length > 0`
  check.
- Winner = candidates[0] by construction.
- No new selector introduced.
- No scoring weight added or changed.

### 16 · Anti-overfitting

- Fix 1 consumes ONLY canonical fsGroupKey structural taxonomy
  (`BS_CASH_EQUIVALENTS`) — a standard financial-statement classifier
  value.
- The bounded name check `/\bbank\b/i` distinguishes BANK vs CASH
  diagnostic labels; **ineligibility itself does not depend on the
  name match** (Founder §2). Verified by the "no bank in name"
  regression test (Undeposited Funds Clearing → CASH tier=INELIGIBLE).
- No vendor / invoice / account-number literals in runtime logic.
- No new lexical cues.
- No purpose-cue changes.
- No taxonomy changes.

### 17 · Targeted tests / typecheck

- `npm run typecheck` — clean.
- Targeted vitest — **232/232 green** across 12 suites (including
  the new 12-test cash-equivalents suite + full K/L/M-B/I-a/I-b/
  canonical-ranker/allocation-canonical/refactor-single-authority/
  evidence-integrity/treatment-aware-discovery/account-semantics-
  extensions/treatment-composition regression coverage).
- Sealed benchmark — 42 cases pass 18 / fail 23 / unsafe 0, zero
  deltas vs Phase 7.2M-B baseline.
- Staging deployed: web v211
  (`spectre-staging:deployment-01M015TJA8C0F6E43Y9JJK5FXZ`), worker
  v108. `/api/health = 200`.

### 18 · Recommendation on whether Fix 2 or a different composition repair is justified

**Fix 2 is likely justified in principle** — the 221178 case class
(committed high-confidence purpose + base-state-OPERATING capital →
WEAK composed treatment) is real, not sealed-corpus-specific, and
blocks the M-B ACCOUNTING_CLASS_MATCH mechanism from firing on cases
where a competent human accountant would readily conclude the
transaction is IT/SOFTWARE.

**BUT** the founder §9 caveat is architecturally correct: "Purpose
confidence and accounting-treatment defensibility are related but
are not automatically equivalent." A universal
`purpose confidence >= 80 → defensibility = STRONG` rule risks:
- SOFTWARE_SUBSCRIPTION conf 96 committing incorrectly on a vendor
  service invoice that's actually a physical equipment purchase (e.g.
  "software-defined radio hardware")
- MEMBERSHIP_DUES conf 96 committing on something the club treats
  as INVENTORY

**Proposed generalized composition rule** (for a subsequent Fix 2
authorization if founder chooses):

```
If purpose classifier commits at confidence >= 80
AND the purpose has a semantic mapping to a treatment statementRole
    (per M-B PURPOSE_STATEMENT_TO_CLASS)
AND accounting-nature classifier does NOT defensibly contradict that
    statementRole (i.e., nature.leader NOT in a contradictory-type set)
THEN treatment.defensibility can be promoted to STRONG based on
    purpose-classifier verdict alone.
```

This is stronger than "confidence >= 80 alone" — it requires the
purpose to have a documented downstream treatment interpretation AND
requires the nature classifier not to contradict. Two structured
gates rather than one confidence threshold.

**Recommendation:** post-founder verification of Fix 1 impact on
221178 / DMM / 1091559, propose the above generalized composition
rule as Fix 2 for a bounded implementation. If Fix 1 alone reveals
that 221178 now abstains safely (rather than recommending 1313
incorrectly), that's an acceptable interim state and Fix 2 becomes a
"lift correct-#1-below-threshold cases" enhancement rather than a
safety fix.

---

## §12 · Deployment record

- Web: **spectre-staging v211**,
  image `spectre-staging:deployment-01M015TJA8C0F6E43Y9JJK5FXZ`
- Worker: **spectre-staging-worker v108**
- Rollback anchors:
  - Web v210 `spectre-staging:deployment-01KZZ8GQVY07B8GHS51CWAQDR6`
  - Worker v107 `spectre-staging-worker:deployment-01KZZ8PE0D7CHZ52V57RKJ8M4E`
- `/api/health = 200`
- Fix 1 impact scope on real COA: exactly 3 accounts (1000, 1001, 9900)

**To trigger Founder §6-§8 re-runs on 221178 / DMM / 1091559** on the
newly-deployed Fix 1:
- New Outlook ingestions of the same invoice types will now use Fix 1
  automatically.
- Existing OPEN work-intakes (WI `lrncy9ib`, `094a8uyu`, `w2io64kn`)
  have persisted findings from the pre-Fix-1 analysis. Re-analysing
  them requires a replay-analyse trigger. The `inspect-wi` endpoint's
  replay path is SUPER_ADMIN-gated at
  [src/app/api/ap-intelligence/replay-analyse/route.ts](../src/app/api/ap-intelligence/replay-analyse/route.ts).
- Alternatively, re-forward the source Outlook emails to re-ingest.

---

**Not merged. No production deploy.** Awaiting founder verification
of the three real-invoice re-runs before considering Fix 2 or
resuming the 20-50 invoice cohort.
