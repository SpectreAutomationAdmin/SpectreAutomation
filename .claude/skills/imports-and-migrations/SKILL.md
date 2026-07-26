---
name: imports-and-migrations
description: Rules for ImportBatch, templates, and opening-balance migration.
---

# Imports and migrations

## When to use
Any change to `src/lib/imports/**`, `src/lib/import-templates/**`,
`src/lib/opening-balance/**`, or the admin pages under
`/app/admin/imports` and `/app/admin/opening-balances`.

## Steps
1. The 3-phase rule is non-negotiable: `createBatch → validateBatch →
   commitBatch`. Never write directly to domain tables from an upload
   route.
2. `validateBatch` MUST set `dryRunAt` and refuse to commit without it.
3. Financial domains (COA, OPENING_TRIAL_BALANCE, AR_HISTORY) call
   `assertPostingAllowed` at commit time. Non-financial domains
   (MEMBERS, VENDORS, INVENTORY) do not.
4. Every row gets a `status` of VALID / INVALID / IMPORTED. No
   "PENDING forever" rows after a commit.
5. Duplicate detection runs WITHIN the batch (between rows) before
   commit. Across-batch duplicates are caught at the unique constraint.
6. Opening balance posting requires debits == credits AND, if AR/AP
   subledgers are supplied, those subledgers reconcile to the control
   accounts within $0.005.
7. Imported rows in finance-adjacent tables are never destroyed.
   Rollback flips them to INACTIVE / ARCHIVED / status=DRAFT.
8. Audit every batch action with the row count.

## Completion criteria
- Dry run never writes a domain row.
- Commit refuses cleanly if `errorRows > 0` and `allowPartial` is false.
- Rollback works for the supported entity types (Member, Vendor,
  InventoryItem) and is a no-op for the rest (Account, Charge, ...).
- A test covers: empty file, all-valid, mixed valid+invalid,
  duplicate-within-batch, allowPartial=true, rollback.

## Red flags
- A new financial domain in `commitDomainRow` without a posting-guard
  check at the top of `commitBatch`.
- "TODO: handle subledger reconciliation later".
- Float math anywhere in the import path.
- A direct `prisma.charge.create` outside the AR service.
- A commit that doesn't audit.
