# PHASE A — Completed Work Intake Immutability Checkpoint

**Prepared:** 2026-08-15 · **Branch:** `work-intake-state-outlook-archive-fix` · **Deployed staging:** web v216 / worker v113. Rollback anchors: web v215 / worker v112. **Not merged. No production deploy.**

Founder-authorised PHASE A of the three-phase sequence (A: immutability → B: supplier repair → C: Microsoft acceptance). Zero AP intelligence changes; v206 + SaaS-recall + Work-Intake-state-derivation baseline preserved. No Prisma schema migration; extended existing `WorkCompletionEvent.metadataJson` per §A2.

**STOP** — awaiting founder to complete truncated PHASE B §B6 test list (message ended at "### Recipient address block" with no content following) and full PHASE C spec before proceeding.

---

## What shipped

**8 files changed, 4 new files, 853 insertions.** Commit `095aaaf` pushed to `origin/work-intake-state-outlook-archive-fix`.

### New modules (import-only, tenant-safe)

- **[src/lib/work-intake/completion-snapshot.ts](src/lib/work-intake/completion-snapshot.ts)** — typed `CompletionCardSnapshot` shape + `CompletionEventMetadataEnvelope` wrapper for `WorkCompletionEvent.metadataJson`. Snapshot version tag `COMPLETION_CARD_SNAPSHOT_VERSION="1"`. `parseCompletionMetadata` + `readCardSnapshotFromMetadata` never throw; return null on malformed input or version mismatch → caller falls through to legacy path.

- **[src/lib/work-intake/completion-snapshot-validate.ts](src/lib/work-intake/completion-snapshot-validate.ts)** — server-side sanitiser for client-supplied snapshots. Whitelist fields only, string clamp at 500 chars, allocations cap 32, drops NaN/Infinity numbers, drops non-object entries, forces server to stamp `completedByUserId` + `completedAt` itself (never trusts client for those). Wrong `snapshotVersion` → returns `null` (legacy fallback).

- **[src/lib/work-intake/read-completed-card-facts.ts](src/lib/work-intake/read-completed-card-facts.ts)** — `readCompletedCardFacts({clubId, workIntakeItemId})` returns discriminated union `{source: "live" | "frozen" | "legacy", ...}`. Tenant-scoped. Reads only — never writes, never invokes `analyseIngestedInvoice`. `COMPLETED_STATUSES = ["RESOLVED", "SUPPRESSED"]` — non-terminal statuses always return `"live"`.

### Modified writers

- **[src/lib/work-intake/completion.ts](src/lib/work-intake/completion.ts) `emitWorkCompletionEvent`** — accepts new optional `cardSnapshot: CompletionCardSnapshot | null` arg. Merges into envelope alongside any existing legacy metadata (POST path's `apInvoiceId/apInvoiceNumber/journalEntryId/journalEntryNumber` preserved).

- **[src/lib/work-intake/actions.ts](src/lib/work-intake/actions.ts) `resolveIntake`** — accepts optional `opts.cardSnapshot: CompletionCardSnapshot | null`, threads to emitter. Existing 1-arg and 2-arg callers still work — snapshot is opt-in.

- **[src/app/app/admin/ap/_post-ap-invoice-actions.ts](src/app/app/admin/ap/_post-ap-invoice-actions.ts):640** — composes the AUTHORITATIVE posted snapshot from rows written inside the atomic tx (§A3):
  - `supplierDisplayName = vendor.legalName` (Vendor row, NOT `extraction.vendor.guessedName`)
  - `vendorId = vendor.id`
  - `vendorMatchState = "MATCHED"` (by definition — the vendor being used to post IS matched)
  - `invoiceNumber = input.coding.invoiceNumber`
  - `invoiceDate / dueDate / subtotal / taxTotal / total / currency` all from posted APInvoice values
  - `glAccountNumber / glAccountName = expenseAccount.accountNumber / expenseAccount.name`
  - `allocations[0]` from posted APInvoiceLine
  - `workflowState = "READY_FOR_APPROVAL"`
  - `completionType = "POSTED_AND_CLEARED"`

- **[src/app/api/work-intake/action/route.ts](src/app/api/work-intake/action/route.ts) action=resolve** — accepts `cardSnapshot` from request body, sanitises via `validateCardSnapshotFromClient`, passes to `resolveIntake`. Absent snapshot → resolve still succeeds; Completed History falls through to legacy live projection.

### Modified reader

- **[src/lib/mission-control/intelligence-review-intakes.ts](src/lib/mission-control/intelligence-review-intakes.ts):948** — after `summariseApIntake` returns, calls `readCompletedCardFacts(emailIntakeId)`. If `source="frozen"`, overlays founder-facing fields onto the live projection via `overlayCardSnapshotOnInvoiceSummary` (new local function).

  **Overlaid fields** (from snapshot, when present): supplier / vendor match state / matched name / matched vendor id / invoice number / gross amount / currency / PO / category label / GL account number / GL account name / workflow state / recommendation summary.

  **Preserved from live** (auxiliary shape fields): sender + relationship, payment terms + provenance, PO variance, GST verification + rate, alternates, findings count, capital state — the summariseApIntake 90s cache keeps this cheap.

### restoreIntake (§A7) — unchanged, verified correct

Source-level guard test on [actions.ts:133-178](src/lib/work-intake/actions.ts#L133):
- Sets status=OPEN ✓
- **PRESERVES** `resolvedAt` and `resolvedByUserId` (explicit comment "NEVER clear")
- Writes `WorkRestorationEvent` + `RESTORED` activity
- **Does NOT delete `WorkCompletionEvent`** (prior snapshot preserved in audit history)
- Does NOT trigger reanalysis / cache invalidation / archive undo / Outlook restore / posting reversal

Reopened active card renders live intelligence (`readCompletedCardFacts` returns `"live"` for non-terminal status); prior snapshot remains available via the WorkCompletionEvent row for audit / historical view.

---

## Test results

**7-gate immutability suite ([tests/work-intake-completed-immutability.test.ts](tests/work-intake-completed-immutability.test.ts))** — 15/15 pass:

1. RESOLVE captures snapshot round-trip through `metadataJson` envelope ✓
2. POST & CLEAR snapshot uses authoritative posted values ✓
3. Frozen snapshot immune to later analyser changes (data invariant + source-level guard on read wrapper) ✓
4. ACTIVE items still receive live intelligence (source-level guard: `COMPLETED_STATUSES = ["RESOLVED","SUPPRESSED"]` only) ✓
5. REOPEN preserves prior WorkCompletionEvent (source-level guard: restoreIntake writes WorkRestorationEvent + never deletes WorkCompletionEvent + never clears resolvedAt) ✓
6. Legacy pre-snapshot items → `source="legacy"` fallback; malformed JSON safely returns null; version-tag mismatch returns null ✓
7. Posted authoritative snapshot beats earlier proposal — source-level guard on `_post-ap-invoice-actions` that POSTED snapshot uses `vendor.legalName + expenseAccount.accountNumber`, not `extraction.vendor.guessedName` ✓

**Plus server-side validator suite** — null / non-object / version-mismatch / whitelist-only / `__proto__` injection dropped / string clamp / NaN drop / allocation cap of 32 / non-object allocation drop.

**Adjacent regression check** — 88/88 tests pass across:
- work-intake-state-derivation (15/15)
- work-intake-completed-immutability (15/15)
- v206-saas-recall-corroborated-cues (13/13)
- phase3-1-cutover (15/15)
- c15i2-variant-d-ap-card-source-contract (30/30)

**Typecheck:** clean (`npx tsc --noEmit`).

---

## Founder-rule compliance (§A1-A10)

| Rule | Status |
|---|---|
| §A1 ACTIVE live · POSTED/RESOLVED frozen · REOPEN preserves history | ✓ (read wrapper branches on status; restoreIntake unchanged) |
| §A2 Extend `WorkCompletionEvent.metadataJson` (no new table) | ✓ (typed envelope; POST metadata preserved as siblings) |
| §A3 POSTED path uses authoritative posted transaction | ✓ (`_post-ap-invoice-actions:640` composes from Vendor + APInvoice + expenseAccount rows written inside the atomic tx) |
| §A4 `resolveIntake` extended minimally | ✓ (optional `opts.cardSnapshot`; existing signatures still work) |
| §A5 `readCompletedCardFacts` read boundary + legacy fallback | ✓ (`source: live \| frozen \| legacy` discriminated union) |
| §A6 No heuristic historical backfill | ✓ (pre-snapshot completions remain `source="legacy"`, no vendor-adjacency reconstruction) |
| §A7 restoreIntake preserves prior snapshot | ✓ (source-level guard test locks this) |
| §A8 Microsoft fixture untouched | ✓ (still ACTIVE, restored; will re-freeze on next founder Resolve after Phase B) |
| §A9 7-gate regression suite + validator suite | ✓ (15/15 pass; generic supplier names throughout; no Microsoft-specific runtime logic) |
| §A10 No diagnostic replay surface built in this phase | ✓ (deferred) |

---

## Zero-change constraints

| Prohibited | Status |
|---|---|
| Phase 7 architecture | Not reopened |
| GL ranking / scoring weights | Untouched (v206 + SaaS-recall intact) |
| Confidence thresholds | Untouched (DIMENSION_MIN_CONFIDENCE=55, CANONICAL_COMMIT_THRESHOLD=60, GL_MIN_RELEVANCE_THRESHOLD=40 all unchanged) |
| SaaS-recall logic | Corroborated cues unchanged |
| Extraction / OCR / PDF reading | Unchanged |
| Purpose classification / capital classifier / vendor matching intelligence | Unchanged |
| Prisma schema | No column adds, no migration (extended metadataJson content only) |
| Card renderer | Unchanged (still consumes `ApInvoiceCardIntelligence`; only field values overlaid) |
| Production deploy | None |

---

## Microsoft fixture status (§A8)

`cms0i8qlp0013nc7oo377f1rl` remains **ACTIVE** on staging (restored 2026-08-15 14:24 UTC by founder). Its linked AP intake `cms0l576g00017d6viorrz0rh` continues to be OPEN.

Under Phase A the founder-facing card renders **live intelligence** for this ACTIVE item (per §A1 rule that ACTIVE items may receive current intelligence). It therefore **still shows `Canada` as supplier** — this is expected and correct. The founder should not Resolve this WI in the current state; the classifier repair in PHASE B is required first to produce a correct snapshot on the next completion.

**Do not attempt to reconstruct the historical Microsoft-Corporation snapshot** per §A6 — the pre-16H completion has no persistent record beyond `resolvedAt/resolvedByUserId`; any heuristic reconstruction (e.g. vendor-creation adjacency) is not authoritative enough to rewrite history.

---

## Rollback if founder rejects

```bash
export PATH="/c/Users/cturcato/.fly/bin:$PATH"
flyctl deploy --image registry.fly.io/spectre-staging:deployment-01M01XS9BVYBPNSJFRKSR9G3Q4 --app spectre-staging
flyctl deploy --image registry.fly.io/spectre-staging-worker:deployment-01M01Y63QHHEV3MS9JQYGZ7NWT --app spectre-staging-worker
```

Restores web v215 / worker v112 (v206 + SaaS-recall + Work-Intake-state-derivation; no cardSnapshot infrastructure).

---

## STOP — awaiting founder to complete PHASE B & PHASE C spec

Your authorisation message for the three-phase sequence appears truncated:

> ## B6. Mandatory negative supplier tests
>
> Add generic tests for:
>
> ### Recipient address block
>
> [message ends here — no test content follows]

PHASE C ("Microsoft end-to-end acceptance") is named but not detailed.

I will not begin PHASE B until you confirm:

1. **B6 test list** — the recipient-address-block and any additional negative-supplier tests you want locked (I have my §24 candidates from the forensic checkpoint but await your explicit list)
2. **PHASE C spec** — Microsoft end-to-end acceptance criteria beyond §B5
3. **Ordering confirmation** — proceed to PHASE B against v216 with PHASE A snapshot infrastructure in place

Meanwhile PHASE A is deployed to staging and awaiting founder validation. If you want to exercise it before PHASE B:
- **Resolve** any current ACTIVE AP invoice on Coulee Ridge (e.g. DMM #B0037FC, one of the Oakcreek invoices, or the OXIO invoice). This will write a `cardSnapshot` per PHASE A.
- Then observe that the resulting Completed History card is frozen — subsequent live re-renders will not mutate the founder-facing fields even as the classifier evolves.
- **Do not Resolve the Microsoft item yet** (§A8 constraint).

Any WI resolved BEFORE this slice landed remains `source="legacy"` and renders via live projection — no retroactive snapshot capture per §A6.

**No implementation of PHASE B until authorised.**
