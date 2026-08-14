# Phase 4R · Phase 7.2N — Real-COA First-Failure Trace

**Status:** Founder-authorised STOP on the 20-50 cohort. Real-world
staging screenshot showed Club Support #221178 at **High confidence**
proposing **1313 Inventory - Proshop Repairs + 9900 Bank - Credit
Facilities/Mortgage** for an online-backup license service — a
high-confidence wrong-account failure. Runtime frozen. This document
traces the failure to a single systemic root cause.

**No runtime changes in this checkpoint.** Diagnostic-only.

**Not staged. Not merged. No production deploy.**

---

## §1 · Real Coulee Ridge staging COA vs sealed-benchmark seed COA — the primary structural gap

The staging tenant `cmrvdeny7000144372ktmmg9c` ("Coulee Ridge Golf &
Country Club", slug `spectre-staging-platform`) — **not "Silver
Springs"; there is no Silver Springs club on staging** — carries a
real COA that materially differs from `tests/ap-benchmark/seed.ts`.

### Fatal structural finding — bank/cash accounts NOT flagged

| Account | Type | `accountRole` | `isBankAccount` | `isCashAccount` | `fsGroupKey` | Structural posting risk |
|---|---|---|:---:|:---:|---|---|
| **1000 Petty Cash** | ASSET | STANDARD | **false** | **false** | BS_CASH_EQUIVALENTS | **NOT INELIGIBLE** |
| **1001 Bank - General** | ASSET | STANDARD | **false** | **false** | BS_CASH_EQUIVALENTS | **NOT INELIGIBLE** |
| **9900 Bank - Credit Facilities/Mortgage** | ASSET | STANDARD | **false** | **false** | BS_CASH_EQUIVALENTS | **NOT INELIGIBLE** |
| 2000 Bank - Visa 8103 | LIABILITY | STANDARD | false | false | BS_AP | caught by `ruleLiability` |

**All three cash-equivalent accounts pass hard eligibility.** The
existing eligibility rules
[rules-structural.ts:57-63](../src/lib/accounting/eligibility/rules-structural.ts#L57)
`ruleBank` / `ruleCash` / `ruleControl` gate on the boolean flags
alone. Real staging accounts don't set those booleans; they set
`fsGroupKey = BS_CASH_EQUIVALENTS`.

Consequently `AccountSemantics.postingRole = STANDARD` and
`structuralPostingRestrictions = []`. Tier assignment treats these
accounts as fully postable ASSET candidates.

### Statement-role misclassification cascade

For 1000/1001/9900, my Phase 7.2K
[`deriveStatementRole`](../src/lib/ap-intelligence/account-semantics/index.ts#L253):
- `type === "ASSET"` ✓
- `capitalRole !== "NOT_CAPITAL_ASSET"`? — `deriveCapitalRole` reads
  `categoryKey = CURRENT_ASSETS ≠ CAPITAL_ASSETS` and
  `fsGroupKey = BS_CASH_EQUIVALENTS ≠ BS_CAPITAL*` → falls through to
  `NOT_CAPITAL_ASSET` at line 173. So the capital-role branch does not
  fire.
- Not INVENTORY (no `BS_INVENTORY`), not PREPAID (no `BS_PREPAID`).
- **Falls to the default `BALANCE_SHEET_CURRENT_ASSET`** at line 291.

Then [`deriveAccountingClass`](../src/lib/ap-intelligence/account-semantics/index.ts#L340):
- `inventoryPrepaidRole = NONE`
- No inventory or prepaid name match
- **Falls to `OTHER_ASSET`** at line 373.

Net result: 1000 / 1001 / 9900 all look to canonical scoring like
"a legitimate current-asset that happens to be an `OTHER_ASSET`
class." They can win when they lexically resemble the transaction.

### Other real-vs-seed divergences (secondary)

| Account | Seed COA (sealed benchmark) | Real staging COA |
|---|---|---|
| **6020** | Grounds Maintenance | **Employee Incentives Expenses** (cat=OTHER_EXPENSES, fsg=IS_OTHER_EXPENSES) — a completely different account |
| Fuel | 5310/5311/5320, no fsGroupKey | **6025** "Fuel (Gas/Diesel)", cat=REPAIRS_MAINTENANCE, fsg=**IS_VEHICLE_EQUIPMENT** (NOT `IS_FUEL_LUBRICANTS`) |
| F&B COGS | 5100/5101 EXPENSE | **DOES NOT EXIST** — F&B is stored ONLY as inventory (1300-1316). No expense-side COGS accounts. |
| Land | 1580 | not in query result (may not exist on staging COA) |
| Software Intangible | 1610 | not in query result |
| Buildings | 1550 | not in query result |
| F&B Inventory | 1250/1260 (single account each) | **fine-grained 1300-1316** (Food / Liquor / Beer / Draught / Wine / Pop / Proshop-Clothes / -Balls / -Clubs / -Bags / -Shoes / -Miscel / -Corp / **Proshop Repairs** / Prof Uniform / Course Chem&Fert / Receiving Accrual) |

**Key implication:** The 42-case sealed benchmark's account numbers
and semantics are **not portable to the real tenant COA**. My K/L/M-B
`AccountSemantics` derivation was designed against the seed shapes;
the real COA exposes gaps in the fsGroup-based derivation logic.

---

## §2 · Club Support #221178 — trace

### Transaction

- Vendor: Club Support (from screenshot)
- Product: Online Backup License Fee
- Expected economic conclusion: **operating IT/software service → 6054 Computer & IT Services**

### Purpose / treatment / class-hint

- **Purpose classifier:** SOFTWARE_SUBSCRIPTION cue `/online\s*backup/`
  fires on line-item text → commits at confidence 96 (Phase 7.2H trace
  confirms this on staging text).
- **capital-vs-operating:** the invoice text lacks explicit operating
  keywords ("maintenance", "utility", "hydro" — absent) AND has no
  capital keywords AND likely sits below $5,000 threshold → returns
  `state = OPERATING` via BASE STATE. `capital.supportingEvidence`
  contains only "Total below threshold" + "No capital keywords".
- **accounting-nature:** UTILITY_OR_RECURRING_SERVICE may fire on
  "monthly subscription" strong term if that vocabulary appears.
  Alternatively UNKNOWN if the invoice text doesn't hit strong terms.
- **Composed treatment (7.2I-b + 7.2K composition):** rule 8 fires —
  `capitalState === "OPERATING"` via base state → `statementRole =
  OPERATING_EXPENSE`, **`defensibility = "WEAK"`**,
  `composedNatureLeader` falls back to raw, `composedNatureIsDefensible`
  falls back to raw.
- **`accountingClassHint`:** `deriveAccountingClassHint` requires
  `treatment.defensibility === "STRONG"` (per Founder §3 M-B gate).
  Treatment here is WEAK → **returns `null`**. **ACCOUNTING_CLASS_MATCH
  does NOT fire.**
- **Competition mode:** `treatment?.defensibility === "STRONG" ? …`
  → **`OPEN_TREATMENT`** — tier priority does NOT govern cross-tier
  ordering; flat numeric score decides.

### Candidate universe + tier assignment

For OPEN_TREATMENT mode, every eligible account gets tier `PLAUSIBLE`
(from `assignCandidateTier`). Bank/cash accounts NOT flagged as
INELIGIBLE (see §1) → they compete on numeric score.

For the material candidates:

| Account | postingRole | statementRole | accountingClass | Tier | Notes |
|---|---|---|---|---|---|
| **6054 Computer & IT Services** | STANDARD | OPERATING_EXPENSE | IT_SERVICES | PLAUSIBLE (OPEN_TREATMENT) | correct target |
| **1313 Inventory - Proshop Repairs** | STANDARD | BALANCE_SHEET_CURRENT_ASSET | MERCHANDISE_INVENTORY (via §4 default) | PLAUSIBLE | wrong family |
| **9900 Bank - Credit Facilities/Mortgage** | **STANDARD** (should be BANK) | **BALANCE_SHEET_CURRENT_ASSET** (should be INELIGIBLE) | OTHER_ASSET | **PLAUSIBLE** (should be INELIGIBLE) | catastrophically wrong family |

### Canonical evidence emitted (reconstruction — full ranker output not persisted)

Under OPEN_TREATMENT with WEAK treatment, none of the accounting-class
evidence fires. Only lexical/name evidence fires:

- **6054** — TRANSACTION_TEXT: `PURPOSE_TYPE_COMPAT` (+12, purpose
  SOFTWARE_SUBSCRIPTION accepts EXPENSE type) IF the ranker gets a
  committed purpose passed through. `ONTOLOGY_NAME_MATCH` requires
  substring match — `PURPOSE_ACCOUNT_NAME_SUBSTRINGS.SOFTWARE_SUBSCRIPTION
  = ["software","subscription","saas"]` — **none match "Computer & IT
  Services"**. Zero.
  - TAXONOMY_ALIGNMENT: `FS_GROUP_TAXONOMY` requires the query concept
    to have `fsGroupKeyHints` intersecting `IS_IT_SOFTWARE`. Post-Phase
    7.2I-a, `conceptRelatedness(software_subscription_service,
    it_services)` returns SHARED_FS_GROUP_AFFINITY = 35 (both have
    `IS_IT_SOFTWARE`). So `bestFsGroup = (accountFsGroupMatchStrength ×
    35) / 100`. Modest — perhaps +5-8 fsg contribution.
  - CAPITAL_NATURE: none (weak defensibility).
  - Total estimated: 15-25.
- **1313** — TRANSACTION_TEXT: name has "Inventory" / "Repairs". Any
  query-concept token overlap with "Inventory" or "Repairs" → some
  contribution.
  - The purpose-driven-direct discovery invoked v206's legacy ranker
    for `SOFTWARE_SUBSCRIPTION` purpose. `rankPurposeDrivenAccounts`
    has extensive fallback scoring that could surface an
    `Inventory-Proshop-Repairs` account if "software/subscription"
    query concepts have any overlap with "Inventory Proshop Repairs"
    tokens. Unlikely, but if the invoice email subject or body
    contains "Proshop" or "Repairs" as unrelated words, this could
    boost.
- **9900** — TRANSACTION_TEXT: name has "Bank", "Credit", "Facilities",
  "Mortgage". If the invoice text/email body contains any of these
  words (e.g. "credit card" in the email footer, or a payment-terms
  note), Jaccard would score.

**Without persisted per-candidate scores I cannot reconstruct exact
numbers**, but the mechanism is clear: **under WEAK/OPEN_TREATMENT
mode, tier priority does not filter — any lexical similarity can win**.
The HIGH confidence comes from `canonicalConfidence` computing a
strong margin between whatever wrong-account scored highest and the
runner-up, both in the same PLAUSIBLE tier.

### First-failure boundary for 221178

**R2 — accounting treatment.** `composed treatment.defensibility = WEAK`
because `capital.state = OPERATING` via BASE STATE (no positive
keyword). Under WEAK, `accountingClassHint = null`, ACCOUNTING_CLASS_MATCH
does not fire, tier priority does not govern. This defeats the entire
M-B intervention on the exact case class the founder identified.

**Secondary contributing failure — §1's bank/cash-not-flagged**.
9900 shouldn't be in the candidate universe at all; it should be
INELIGIBLE via postingRole = BANK.

---

## §3 · DMM #B0037FC — trace

### Transaction

- Vendor: DMM Energy
- Product: dyed low-sulphur diesel (fuel)
- Screenshot: **Fuel / petroleum product** identified correctly by
  Spectre; GL proposed **1000 Petty Cash**.

### Purpose / treatment / class-hint

- **Purpose classifier:** FUEL cue matches "diesel"/"low sulphur"/
  "fuel" strongly → commits at conf ~96.
- **capital-vs-operating:** `OPERATING_HINTS` includes `/\bfuel\b/i` →
  hits. Returns `state = OPERATING` via **strong** operating-keyword
  path (`operatingKeyword && !capitalKeyword` branch).
  `supportingEvidence` contains `"Operating-suggesting keyword: fuel"`.
- **Composed treatment:** rule 7 fires — `capitalState = OPERATING`
  AND `capitalStrong = true` (positive operating keyword) →
  `statementRole = OPERATING_EXPENSE`, **`defensibility = "STRONG"`**,
  `composedNatureLeader = OPERATING_EXPENSE`, defensible.
- **`accountingClassHint`:** `FUEL × OPERATING_EXPENSE → FUEL_EXPENSE`
  per M-B `PURPOSE_STATEMENT_TO_CLASS`. **NON-NULL. STRONG.**
- **Competition mode:** `ASSERTED_TREATMENT`.

### Candidate universe + tier assignment (ASSERTED_TREATMENT mode)

For material candidates on the real staging COA:

| Account | postingRole | statementRole | accountingClass | Tier | Notes |
|---|---|---|---|---|---|
| **6025 Fuel (Gas/Diesel)** | STANDARD | OPERATING_EXPENSE | FUEL_EXPENSE (via name regex `/\bfuel\b/`) | **PRIMARY** ✓ | correct target |
| **1000 Petty Cash** | STANDARD (BUG — should be CASH) | BALANCE_SHEET_CURRENT_ASSET | OTHER_ASSET | **CONTRADICTED** | STRONG treatment says operating, ASSET is cross-family |
| **1001 Bank - General** | STANDARD (BUG — should be BANK) | BALANCE_SHEET_CURRENT_ASSET | OTHER_ASSET | **CONTRADICTED** | same |
| **9900 Bank - Credit Facilities/Mortgage** | STANDARD (BUG) | BALANCE_SHEET_CURRENT_ASSET | OTHER_ASSET | **CONTRADICTED** | same |
| 6031 R&M - Ground Equip | STANDARD | OPERATING_EXPENSE | REPAIRS_MAINTENANCE | PLAUSIBLE (expense-family, but class ≠ FUEL_EXPENSE hint) | related-family |

### The gap

Under ASSERTED_TREATMENT + tier priority: 6025 (PRIMARY, FUEL_EXPENSE
class match, ACCOUNTING_CLASS_MATCH +15) should outrank 1000
(CONTRADICTED). Tier priority orders PRIMARY before CONTRADICTED.

**How does 1000 win?** Possibilities:

1. **6025 has zero query-concept overlap or its scoring is even
   weaker than 1000's spurious lexical match.** Under
   `canonicalCompare`, within CONTRADICTED tier 1000 could beat other
   CONTRADICTED candidates by score, but a PRIMARY candidate should
   still win over ANY CONTRADICTED. So 6025 must not be reaching the
   PRIMARY tier at runtime.

2. **The composed treatment is NOT being threaded through to the
   ranker.** If `input.canonicalAccountingTreatment` arrives as
   `undefined` at `rankCanonical`, competition mode falls to
   OPEN_TREATMENT and all candidates land in PLAUSIBLE. Then 1000
   wins on lexical score.

3. **The cluster's `effectivePurposeConcept` is null** at
   `rankClusterCanonically` (composed treatment reaches the ranker
   but the cluster's cluster.conceptId doesn't correspond to FUEL) →
   `deriveAccountingClassHintForCluster({ purposeConcept: null })`
   returns null → ACCOUNTING_CLASS_MATCH doesn't fire on 6025 → 6025
   scores lower than the lexical-similar 1000 despite tier PRIMARY
   still holding.

Actually **the third possibility is the most likely**. If
`purposeDecision.concept` doesn't successfully thread from purpose
classifier → gl-allocations.ts → the cluster → `effectivePurposeConcept`,
then even a defensibly-classified transaction gets `accountingClassHint
= null` at ranker time.

### First-failure boundary for DMM

**R9 projection failure** — the actual UI shows **1000 Petty Cash**
as the recommendation despite the fuel invoice being CORRECTLY
identified per the screenshot. This means one of two failures upstream:
- **Cluster-purpose-projection failure**: the committed
  SOFTWARE_SUBSCRIPTION-style purpose (here FUEL) does not reach
  `rankClusterCanonically.canonicalPurposeConcept`, so the tier
  machinery doesn't see PRIMARY-worthy candidates.
- OR **eligibility leak** (§1): 1000 Petty Cash bypasses the CASH
  gate because `isCashAccount=false`, becomes a scored PLAUSIBLE/
  CONTRADICTED candidate, and wins by lexical accident.

**Working hypothesis without the raw persisted trace:** the leak (§1)
is the root cause. Under any competition mode, 1000 Petty Cash MUST
be INELIGIBLE. It fails that gate on the real COA.

---

## §4 · Oakcreek #1091559 — trace

Not currently in the visible screenshot. Based on the sealed-corpus
proxy (`vague-body-invoice-attachment`) which the founder authorised
as the LOCKED case for this shape:
- Post-L behaviour: 1506 correctly identified as canonical winner but
  scores 3 (below COMMIT_MIN_SCORE=30) → correctly ABSTAINS.
- On real staging with fuller invoice text, purpose classifier
  should commit (CAPITAL_EQUIPMENT) → composed treatment STRONG →
  accountingClassHint = EQUIPMENT_ASSET → ACCOUNTING_CLASS_MATCH fires
  on 1506 → score elevated by +15.

**Cannot definitively trace without running against staging data for
this specific invoice.** The mechanism should work IF the real
capital-classifier commits STRONG and the purpose classifier commits
CAPITAL_EQUIPMENT / CAPITAL_IMPROVEMENT on real invoice wording.

**Likely first-failure boundary:** if 1506 abstains with correct
identification (matching the LOCKED proxy behaviour), R6 evidence
propagation. If 1506 loses to a lexically-adjacent account, R2/R5
(cluster-treatment threading gap similar to DMM).

---

## §5 · Real-COA metadata vs Phase 7.2K/L/M assumptions

The Phase 7.2K semantic contracts were designed against the sealed
benchmark seed COA. Checking each assumption against the real
staging Coulee Ridge tenant:

| Assumption | Sealed COA | Real Coulee Ridge staging | Verdict |
|---|---|---|---|
| **Bank/cash accounts marked via `isBankAccount`/`isCashAccount`** | true (per `tests/ap-benchmark/seed.ts:99-100`) | **false** for 1000, 1001, 9900 | **FALSE** — `derivePostingRole` boolean-flag fallback path never fires on real COA |
| **`accountRole = CONTRA_ASSET` for contra-asset accounts** | true (per seed line 79-91) | true (real 1513) | ✓ |
| **`categoryKey = CAPITAL_ASSETS` for capital assets** | not populated in seed | **populated** (1506/1513) | ✓ better than seed |
| **`fsGroupKey` populated** | ALL null in seed | ALL populated on real COA | ✓ better than seed |
| **`fsGroupKey = IS_FUEL_LUBRICANTS` for fuel accounts** | N/A (null in seed) | **NO** — real uses `IS_VEHICLE_EQUIPMENT` | **FALSE** — my `deriveAccountingClass` fuel path relies on name match, not fsg |
| **`fsGroupKey = BS_CASH_EQUIVALENTS` maps to INELIGIBLE** | N/A | **NOT** — `derivePostingRole` doesn't consult fsg | **FALSE** — cash equivalents leak into ranker |
| **Standard COA account numbers (1580 Land, 1610 Software, 1550 Buildings, 5100/5101 F&B COGS)** | true (test fixture) | Not verified — may not exist | **UNKNOWN** — benchmark-vs-real portability is broken |
| **6020 = Grounds Maintenance** | true | **FALSE** — real 6020 = Employee Incentives | Divergence — sealed benchmark's expected-6020 wins don't apply to real tenant |

**Phase 7.2K's `deriveStructuralPostingRestrictions` and
`derivePostingRole` are the primary vector for the leak.** They
consult boolean flags but not `fsGroupKey` structural taxonomy. On
the real tenant, the fsgroup IS the primary structural signal.

---

## §6 · Systemic correction proposal (no code change in this checkpoint)

### Fix 1 — Structural bank/cash inference via fsGroupKey (HIGH PRIORITY)

Extend `derivePostingRole` at
[account-semantics/index.ts:207-224](../src/lib/ap-intelligence/account-semantics/index.ts#L207)
to consult `fsGroupKey` before falling to STANDARD:

```ts
function derivePostingRole(account) {
  // configured accountRole (unchanged)
  if (configured === "CONTRA_ASSET") return { postingRole: "CONTRA_ASSET", source: "CONFIGURED" };
  // ...

  // Boolean-flag fallback (unchanged)
  if (account.isBankAccount) return { postingRole: "BANK", source: "ACCOUNT_ROLE" };
  // ...

  // NEW: fsGroup-based structural inference (Phase 7.2M-N fix)
  const fsg = (account.fsGroupKey ?? "").toUpperCase();
  const nameLower = (account.name ?? "").toLowerCase();
  if (fsg === "BS_CASH_EQUIVALENTS") {
    // Distinguish bank vs cash by name; both are structurally
    // ineligible for AP debit.
    if (/\bbank\b/i.test(nameLower)) return { postingRole: "BANK", source: "FS_GROUP" };
    return { postingRole: "CASH", source: "FS_GROUP" };
  }
  if (fsg === "BS_AR" && /\bcontrol\b/i.test(nameLower)) {
    return { postingRole: "CONTROL", source: "FS_GROUP" };
  }
  return { postingRole: "STANDARD", source: "ACCOUNT_ROLE" };
}
```

**Effect:** 1000 / 1001 / 9900 (all BS_CASH_EQUIVALENTS on real COA)
get `postingRole = BANK/CASH`. `deriveStructuralPostingRestrictions`
emits `BANK_ACCOUNT` / `CASH_ACCOUNT`. `AccountSemantics.
structuralPostingRestrictions.length > 0` → **tier = INELIGIBLE** at
`assignCandidateTier` line 1442 → **never wins.**

**This one fix eliminates the 221178 catastrophic 9900 recommendation
and the DMM 1000 misrouting.**

### Fix 2 — Treatment defensibility should treat committed purpose as defensible signal

Under current composition rule 8, `capital.state = OPERATING` via
base state → defensibility = WEAK regardless of what the purpose
classifier says. This blocks ACCOUNTING_CLASS_MATCH for 221178.

Proposed rule change (composition-only, no scoring/weights):

```ts
// Rule 7b (new): STRONG operating verdict from committed purpose
if (capitalState === "OPERATING"
  && !capitalStrong                          // base-state OPERATING
  && purposeConcept != null
  && purposeConfidence >= 80) {              // strongly committed purpose
  return {
    ...
    defensibility: "STRONG",
    winningSource: "purpose_classifier_strong",
  };
}
```

**Effect on 221178:** SOFTWARE_SUBSCRIPTION conf 96 → composed
treatment STRONG → accountingClassHint = IT_SERVICES →
ACCOUNTING_CLASS_MATCH fires on 6054 +15 → 6054 competes as PRIMARY
tier, wins over CONTRADICTED (1313 inventory).

### Fix 3 — Fuel account fsGroup recognition

Extend `deriveAccountingClass` line 415:
```ts
if (fsGroupKey === "IS_FUEL_LUBRICANTS"
    || fsGroupKey === "IS_VEHICLE_EQUIPMENT"  // NEW: real Coulee Ridge stores fuel under vehicle-equipment fsg
    || /\bfuel\b|\blubric/.test(nameLower)) {
  return { accountingClass: "FUEL_EXPENSE", source: "FS_GROUP" };
}
```

Actually — the name path already catches this. The issue for DMM is
elsewhere (see §3 first-failure classification). Fix 3 is
optional/defensive.

### Fix 4 — Full COA metadata portability audit

Before further sealed-corpus tuning, systematically compare every
Phase 7.2K derivation rule against every real staging tenant's actual
`categoryKey` / `fsGroupKey` / `accountRole` / name distribution. The
sealed benchmark's homogeneous seed hid taxonomy assumptions that fail
on real production COAs.

---

## §7 · One first-failure boundary per invoice

| Invoice | First-failure boundary | Root cause |
|---|:---:|---|
| **Club Support #221178** | **R2** (treatment defensibility) | Composed treatment.defensibility = WEAK despite SOFTWARE_SUBSCRIPTION purpose committing at conf 96, because capital.state = OPERATING via base state (no explicit operating keyword). This blocks ACCOUNTING_CLASS_MATCH from firing. Secondary contributing factor: `9900 Bank - Credit Facilities/Mortgage` bypasses hard eligibility because `fsGroupKey=BS_CASH_EQUIVALENTS` isn't recognized as a bank/cash marker (only boolean flags are). |
| **DMM #B0037FC** | **R2** (structural eligibility) — `1000 Petty Cash` bypasses hard eligibility for the identical reason (fsGroupKey=BS_CASH_EQUIVALENTS not treated as CASH). Alternative diagnosis if 1000 IS getting INELIGIBLE: R5 cluster-treatment threading — committed FUEL purpose fails to reach cluster's `effectivePurposeConcept`, so accountingClassHint = null at ranker time, 6025 loses tier PRIMARY status. Without the raw persisted per-cluster snapshot I cannot definitively distinguish; the systemic §1 fix resolves the eligibility leak either way. |
| **Oakcreek #1091559** | **R6** (evidence propagation) — proxy behaviour suggests 1506 correctly identified but scores below COMMIT_MIN_SCORE. On real invoice text with fuller wording, purpose classifier should commit → M-B mechanism should fire. Not conclusive without direct staging trace. |

---

## §8 · Freeze status

**No runtime changes in this checkpoint** per founder directive.
All findings are diagnostic. Existing 220 targeted tests remain green.
Staging is running the frozen `bafd2be` candidate.

Systemic correction (§6 Fix 1 + Fix 2) proposed — awaits founder
authorisation. **Fix 1 alone is the highest-impact single change.**
The change is small (~15 lines), architecturally clean (extends the
existing `derivePostingRole` provenance chain), and directly addresses
the observed HIGH-confidence wrong-account failure on 221178 + DMM.

**Not staged. Not merged. No production deploy.** Cohort remains
deferred until fix 1 (+ optionally fix 2) lands and re-verification
demonstrates 221178 + DMM behave coherently.
