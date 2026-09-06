# Backlog · AP intake `INGESTED_DOCUMENT` dual-writer semantics

**Filed:** 2026-09-06 during Payroll-3D-3B Slice 0 audit.
**Priority:** AP intake correctness (product decision needed before any
platform-wide `WorkIntakeOrigin` uniqueness constraint can be applied).
**Deferred from:** Payroll-3D-3B (explicit founder decision, 2026-09-06).

## Problem

Two independent AP materialisers currently write PRIMARY-role
`WorkIntakeOrigin` rows with `kind='INGESTED_DOCUMENT'` and
`referenceId=IngestedDocument.id`:

- **AP invoice review** —
  [ap-intelligence/materialise.ts:485](../../src/lib/ap-intelligence/materialise.ts#L485)
  dedupes against `workIntakeOrigin.findFirst`.
- **AP statement review** —
  [ap-statement-intelligence/materialise.ts:246](../../src/lib/ap-statement-intelligence/materialise.ts#L246)
  dedupes against `workIntakeItem.classificationRuleKey`.

Each pipeline dedupes against its own view; neither knows about the
other. If a document is processed by both classifiers (reclassification,
misclassification, dual-analysis path) two distinct `WorkIntakeItem`
rows result — both carrying `(clubId, kind='INGESTED_DOCUMENT', referenceId=doc.id, role='PRIMARY')`.

## Why this blocks a broader constraint

A platform-wide
`UNIQUE (clubId, kind, referenceId) WHERE role='PRIMARY'` on
`WorkIntakeOrigin` would fail the moment a document lands in both
pipelines — breaking AP intake for that document.

Slice 0 audit of Payroll-3D-3B documented this as the hard blocker for
the global variant; 3D-3B instead ships a `kind IN (…)` filtered
partial-unique that touches only the two new correction-review kinds.

## Product question to resolve

**Is two-card behaviour intentional?** Possible answers:

- **Yes, intentional** — an invoice PDF that also arrives as a
  statement PDF really is two review obligations. In that case, either
  (a) diverge the `kind` (`INGESTED_DOCUMENT_INVOICE_REVIEW` /
  `INGESTED_DOCUMENT_STATEMENT_REVIEW`) so each pipeline has its own
  namespace, or (b) diverge the `referenceId` (append pipeline suffix)
  so tuples can't collide.
- **No, unintentional** — one document should produce one canonical
  review card and the second-writer path should either resolve/link or
  skip. In that case, cross-pipeline dedupe is the fix.

Neither is safe to pick without an AP product review — this backlog item
holds the space for that decision.

## Not this slice

Do NOT expand Payroll-3D-3B to touch AP intake. Payroll-3D-3B ships a
narrow, kind-filtered partial-unique that provably does not affect
`INGESTED_DOCUMENT`.
