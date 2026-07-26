---
name: accounting-workflows
description: Rules for GL, AR, AP, opening balance, and posting paths.
---

# Accounting workflows

## When to use
Any change in `src/lib/accounting/**`, `src/lib/services/ar.ts`,
`src/lib/ap/**`, `src/lib/opening-balance/**`, or any function that
writes JournalEntry / Charge / Payment / AccountAdjustment / APInvoice
/ VendorPayment rows.

## Steps
1. Confirm money types: `Decimal` end-to-end. Floats are banned.
2. Confirm the posting guard:
   `await assertPostingAllowed(principal, clubId, action, entityType, entityId)`
   is called BEFORE the first write.
3. Confirm balanced debits == credits before posting any JournalEntry.
4. Confirm the period gate via `resolvePostingPeriod()` (or its adapter
   call path) accepts the posting date.
5. Recompute denormalized balances (`recomputeAccount`) after AR / AP
   state changes that affect a member's balance.
6. Write an `audit()` row with action/entityType/entityId and a
   before/after snapshot.
7. If a contra entry is required (reversal, void), refuse to operate
   on already-reversed rows.
8. Test that voiding / reversing is itself blocked by the posting guard.

## Completion criteria
- The function refuses cleanly when training mode is on
  (TrainingModeBlockedError) and when a READ_ONLY support session is
  active (SupportReadOnlyError).
- The function refuses cleanly when the period is LOCKED/CLOSED.
- A test exists for: success, tenant-violation, period-closed,
  unbalanced-entry, and one role-permission failure.

## Red flags
- `Number(...)` math inside a posting path.
- Direct writes to `MemberAccount.currentBalance` (must go through
  `recomputeAccount`).
- Missing `requirePermission` or missing `assertPostingAllowed`.
- "TODO: reverse path" or "needs GL wiring" comments.
- A reversal that doesn't create a contra row.
