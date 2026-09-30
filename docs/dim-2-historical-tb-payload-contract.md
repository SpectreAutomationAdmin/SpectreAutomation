# DIM-2 · Historical TB snapshot payload contract

**Effective 2026-09-29.** Extends the `entityKind="trial-balance"`
snapshot payload written into `ReportingLedgerSnapshot.payloadJson`
so it can carry Department + Fund dimensions when the caller has
already resolved them externally (per DIM-2 Section 12).

Historical Jonas conversion happens **outside Spectre**. The
importer receives already-converted Spectre natural-account numbers
plus optional per-row Department + Fund dimensions and preserves
them at storage time.

## Contract

`ReportingLedgerSnapshot.payloadJson` for `entityKind="trial-balance"`:

```jsonc
{
  "version": 2,                        // DIM-2 shape (was: implicit v1)
  "rows": [
    {
      "account": "6098",              // Spectre natural account number (required)
      "department": "GROUNDS",        // Optional — Spectre canonical department code
      "fund": "OPERATING",            // Optional — canonical Fund key
      "debit": "1200.00",             // string-serialized Decimal, non-negative
      "credit": "0.00"                // string-serialized Decimal, non-negative
    },
    {
      "account": "6098",
      "department": "F&B",
      "fund": "OPERATING",
      "debit": "2400.00",
      "credit": "0.00"
    }
  ]
}
```

The pre-DIM-2 shape (v1) omitted `department` and `fund`. Readers MUST
accept both v1 and v2. v1 rows are treated as `department: null,
fund: null` (no dimension).

### Rules

1. **Natural account key.** `account` is the Spectre account number
   AFTER any external Jonas legacy-number conversion. Spectre never
   parses Jonas suffixes (`6098-1`, `6098-4`, …) — the external
   conversion strips the suffix and emits `account: "6098"` with the
   corresponding dimension.

2. **Same natural account, multiple rows.** Two rows sharing an
   `account` but with different `department` and/or `fund` are
   independent dimensional slices — they MUST NOT be collapsed into
   a single dimensionless row at storage time. Consolidated
   reporting MAY aggregate them at read time.

3. **Nullable dimensions.** `department` and `fund` are optional; a
   row without them is a genuinely-unassigned line and lands in
   "Unassigned" at report time (no inference from
   `account.defaultDepartmentId` or `account.fundApplicability` CSV).

4. **Debit / credit.** Both non-negative; at least one must be
   positive. Rows are typically half-balanced pairs whose totals
   reconcile across the whole snapshot.

5. **No Jonas crosswalk.** Spectre does not persist a Jonas legacy-
   number map. If the caller wishes to preserve the source-line
   provenance for their own audit trail, they may attach a
   `sourceMemo` field per row, but Spectre neither reads nor
   validates it.

## Validation preview (Section 13)

Before the caller commits a historical TB snapshot, they should run
a preview that validates:

- Every `account` exists as an Account on the target club.
- Every `department` (if supplied) exists as a Department on the club.
- Every `fund` (if supplied) exists as a Fund on the club.
- Every dimension row belongs to the target club (cross-tenant
  rejected — the resolver filters by `where.clubId = clubId`).
- Each account's `departmentPolicy` and `fundPolicy` are satisfied
  by the row's dimensional data.
- `AccountDepartment` applicability is respected (department, if
  supplied, must be in the account's applicability set — or the
  account must be unconstrained).
- `AccountFund` applicability is respected symmetrically.
- Debits and credits sum to a balanced total (within a $0.01
  tolerance) across the whole snapshot.

The centralised `validateManyLineDimensions()` service (DIM-1)
provides the per-line validation primitive that Spectre uses for
Manual JE + AP. The historical TB validator MUST reuse it — it must
not implement its own copy.

**DIM-2 status:** contract defined + preview requirements
documented. Writer / reader integration deferred until the founder
resumes historical TB import (out of scope for DIM-2 per Section 13
"Do NOT import any real historical TB in DIM-2").

## Storage-vs-reporting boundary (Section 14)

Reporting-ledger snapshots preserve dimensional identity at storage
time (rule 2 above). Reporting engines aggregate across dimensions
at read time. Storage MUST NOT destroy the identity of same-account
different-dimension rows — that identity is the founder's
consolidated-vs-departmental reconciliation guarantee.
