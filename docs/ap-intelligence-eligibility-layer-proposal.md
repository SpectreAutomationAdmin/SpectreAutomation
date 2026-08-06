# AP Intelligence — Full Eligibility Layer Proposal (Phase 2)

Prepared: 2026-08-06 · following architecture audit acceptance and
Phase 0 safety-containment implementation.

Phase 0 (already shipped in this checkpoint) refuses to surface a
recommendation whose leader is accounting-invalid. Phase 2 replaces
that reactive guard with a proactive **eligibility layer** that
filters the candidate pool *before* semantic ranking runs.

## Objectives

1. Separate two questions the current pipeline conflates:
   - **Eligibility** — is this account legally and operationally
     available to receive an AP-invoice debit?
   - **Relevance** — how well does an eligible account fit this
     document?
2. Make eligibility a first-class explainable property of every COA
   row, not an afterthought decoration on the recommendation.
3. Never rescue an ineligible account with a high semantic score.
4. Support the four distinct transaction natures cleanly (operating,
   capital, inventory, prepayment) without excluding all ASSET
   accounts or admitting all ASSET accounts.

## Module surface

```
src/lib/accounting/eligibility/
  index.ts                    # public API
  rules/
    structural.ts             # rules that use only existing schema fields
    transaction-nature.ts     # nature-conditioned rules (Phase 2b)
  types.ts                    # AccountEligibilityView, EligibilityVerdict
  __tests__/                  # one test per rule
```

**Public API**

```ts
export interface EligibilityContext {
  clubId: string;
  transactionNature: "OPERATING" | "CAPITAL" | "INVENTORY" | "PREPAYMENT" | "UNKNOWN";
  purposeDebitFor: "AP_INVOICE_LINE";
}

export interface EligibilityVerdict {
  accountId: string;
  accountNumber: string;
  eligible: boolean;
  reasons: EligibilityReason[];   // structured codes, closed enum
  ruleVersion: number;
}

export function filterEligibleAccounts(
  accounts: ReadonlyArray<AccountEligibilityView>,
  context: EligibilityContext,
): { eligible: AccountEligibilityView[]; rejected: EligibilityVerdict[] };

export function evaluateEligibility(
  account: AccountEligibilityView,
  context: EligibilityContext,
): EligibilityVerdict;
```

## Rule set

Every rule reads schema fields — no name-pattern parsing at Phase 2.

### Structural rules (all natures)

| Rule | Reason code | Trigger |
|---|---|---|
| Inactive | `INACTIVE` | `isActive === false` |
| Header | `HEADER_ACCOUNT` | `isHeader === true` |
| Control | `CONTROL_ACCOUNT` | `isControlAccount === true` |
| Manual posting disallowed | `MANUAL_POSTING_DISALLOWED` | `allowManualPosting === false` |
| Bank / cash | `BANK_OR_CASH_NOT_VALID_FOR_EXPENSE_ALLOCATION` | `isBankAccount === true \|\| isCashAccount === true` |
| Archived | `ARCHIVED` | `archivedAt != null` |
| Revenue | `REVENUE_NOT_VALID_FOR_AP_DEBIT` | `type === "REVENUE"` |
| Equity | `EQUITY_NOT_VALID_FOR_AP_DEBIT` | `type === "EQUITY"` |
| Contra-asset | `CONTRA_ASSET_NOT_VALID_FOR_PURCHASE` | `type === "ASSET" && normalBalance === "CREDIT"` |
| Normal balance contradiction | `NORMAL_BALANCE_CONTRADICTION` | `type ∈ {EXPENSE,ASSET} && normalBalance === "CREDIT"` (data-quality edge) |

### Transaction-nature rules (Phase 2b)

Nature classifier (already exists in `accounting-nature.ts`) chooses
one of: `OPERATING`, `CAPITAL`, `INVENTORY`, `PREPAYMENT`, `UNKNOWN`.

| Nature | Eligible types | Extra restriction |
|---|---|---|
| OPERATING | `EXPENSE` only | — |
| CAPITAL | `EXPENSE` + `ASSET/DEBIT` | prefer ASSET where evidence is defensible; still allow EXPENSE for capitalised repairs |
| INVENTORY | `EXPENSE` + `ASSET/DEBIT` under inventory subtype | requires `accountSubtype = "inventory"` (Phase 2c schema field) |
| PREPAYMENT | `ASSET/DEBIT` under prepaid subtype | requires `accountSubtype = "prepaid"` (Phase 2c schema field) |
| UNKNOWN | `EXPENSE` only (conservative default) | — |

Contra-asset accounts remain excluded across every nature.

### Liability rules

Liabilities are generally not AP debits, but there are exceptions
(e.g., accrued expense reversal, cash advance clearing). Phase 2b
policy: default LIABILITY excluded; explicit opt-in per account via
a new `allowedForAPDebit: Boolean` flag (Phase 2c schema).

## Wire-in

Replace `gl-recommend.ts:234–235`:

```ts
const eligibleAccounts: AccountView[] = accountsRaw
  .filter((a) => a.isActive && !a.isHeader && (a.type === "EXPENSE" || a.type === "ASSET"))
  .map((a) => ({ /* … */ }));
```

with:

```ts
import { filterEligibleAccounts } from "@/lib/accounting/eligibility";

const { eligible, rejected } = filterEligibleAccounts(
  accountsRaw.map(toEligibilityView),
  {
    clubId: args.clubId,
    transactionNature: nature.leader,           // fed in from analyse.ts
    purposeDebitFor: "AP_INVOICE_LINE",
  },
);
const eligibleAccounts: AccountView[] = eligible.map(toAccountView);
```

`rejected` is retained on the rationale surface — the reviewer can
see WHY specific accounts were excluded from ranking.

Nature-scoped promotion in `analyse.ts` must consume the SAME
eligibility filter — no separate rule set. The nature-scoped ranker's
current `excludeNameSubstrings` for CAPITAL_ASSET (`"accumulated
depreciation"`, etc.) becomes dead code and is removed once
structural rules cover it.

The Phase 0 wrapper in `analyse.ts` is retained as a defense-in-
depth check that logs a WARN if a supposedly-filtered candidate still
reaches the leader position — an invariant violation that should never
trigger, but is cheap to keep.

## Migration path

**Step 1 — Reuse existing schema (no migration).**
Ship the structural rules against fields that already exist. This is
functionally identical to Phase 0 today but positioned upstream so
ineligible accounts never enter the ranker's `.filter()`. Zero
schema change; can ship independently.

**Step 2 — Add three durable flags.**

```prisma
model Account {
  // …
  isContraAccount   Boolean @default(false)   // canonical flag; backfilled from normalBalance + name pattern one-time
  allowedForAPDebit Boolean @default(true)    // explicit opt-in gate; defaults preserve current behavior
  accountSubtype    String? // "current-asset" | "capital-asset" | "contra-asset" | "prepaid" | "inventory" | …
}
```

Backfill via one-shot script using the existing
`isAccumulatedDepreciationLine` helper in
`src/lib/reporting/ledger/classification-resolver.ts`. Once the
schema flags are populated, the structural rules delegate to them
(preferred) with the type/normal-balance rules as fallback.

**Step 3 — Nature-conditioned rules.**
Read `nature.leader` from the analyser, restrict candidate types
accordingly. The nature-scoped ranker's parallel path is retired and
its accounting-authority responsibilities move into the eligibility
layer.

## Testing contract

- Unit tests, one per rule, over the pure evaluator. Every reason
  code has a passing + a failing fixture.
- Benchmark regression — the sealed `v1-baseline-phase0-on.json`
  must not degrade after Phase 2 lands. The benchmark runs both
  Phase 0 and Phase 2 configurations against the same corpus.
- The pathological benchmark case (`pathological-vendor-default-
  contra`) must remain **abstained** — verifying the eligibility
  layer catches the same class of failure that Phase 0 catches
  today.

## Model-strategy note

Phase 2 remains fully deterministic. Model-assisted classification
(embeddings / LLM) is out of scope until the deterministic pipeline
has a clean floor to build on. If a future proposal adds a model
layer, it MUST route its output through the same eligibility filter
— no LLM output bypasses accounting rules.

## Deliverable order

1. Ship the structural-rules module with unit tests (2 days).
2. Wire into `gl-recommend.ts` and remove Phase 0's wire from
   `analyse.ts` (leave the pure function as a defense-in-depth
   caller inside the eligibility module) (1 day).
3. Benchmark regression run — must produce identical or better
   scores than the sealed `phase0-on` baseline.
4. Author + review the Phase 2b nature-conditioned rules.
5. Author + review the Phase 2c schema migration.
