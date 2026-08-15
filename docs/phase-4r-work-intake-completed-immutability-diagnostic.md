# Work Intake Completed-State Immutability — 25-Item §F Diagnostic

**Prepared:** 2026-08-15 · **Branch:** `work-intake-state-outlook-archive-fix` (docs-only additions) · **Deployed staging remains:** web v215 / worker v112. **No AP intelligence changes. No supplier-classifier changes. No schema changes. No Completed History changes. No deploy. Diagnostic only.**

Founder direction (2026-08-15): STOP before the previously-authorised #220824 end-to-end acceptance. A more important lifecycle/data-integrity defect must be understood first — a completed Microsoft Corporation invoice card allegedly changed its displayed supplier from "Microsoft Corporation" to "Canada" after completion.

---

## 1. Exact Microsoft Work Intake ID

**Not reproducible on current staging.** Exhaustive search of the Coulee Ridge tenant (`cmrvdeny7000144372ktmmg9c`) and every other tenant on `spectre-staging` found no `WorkIntakeItem` matching:
- `displaySubject` / `displaySender` / `displayPreview` containing "Microsoft"
- `WorkIntakeFinding.statement` containing "Microsoft"
- `WorkIntakeActivity.note` containing "Microsoft"
- `IngestedDocument.filename` containing "microsoft" / "azure" / "msft" / "M365"
- `EmailMessage.subject` / `senderAddress` / `senderName` containing "microsoft"

Vendor row *does* exist: `cms4461to0002gypwkbhl8n67` on Coulee Ridge — `legalName = "Microsoft Corporation"`, `vendorNumber = V-2026-000002`, `taxRegistrationNumber = 135625069RT0001`, address One Microsoft Way, Redmond WA 98052, **country = "United States"** (not Canada). Created 2026-07-28 03:46 UTC by user `cmrvdenz700034437agp7gqs5` (founder). `status = ACTIVE`, never `approvedAt`.

**Zero APInvoice rows for this vendor exist on any tenant.** The Microsoft invoice was never posted through the AP pipeline on the staging environment I can reach. Either (a) the founder is looking at a different environment (local dev SQLite with Silver Springs seed), (b) the WI was purged, or (c) the original ingested document + email were soft-deleted after the Vendor row was created but before an APInvoice was written.

Because §F requires the diagnostic to complete BEFORE any change, and the specific Microsoft item is not queryable on staging today, the systemic questions (§B / §C / §D) are answered from source code archaeology on `work-intake-state-outlook-archive-fix` at HEAD, which is definitive.

## 2. Source invoice / message identity

Not available on staging (see §1). The Vendor row's `createdByUserId + createdAt` timestamp (2026-07-28 03:46) window shows only two `IngestedDocument` rows within ±48 hours:
- `cms45l1dm7q1henbk5dp1srjx` — `Invoice-1007565767 (2).pdf` received 2026-07-28 04:25 — this is CPA ALBERTA
- `cms5jktl902bddisy0r3btbum` — `oxio-00108064_2026-07-28.pdf` received 2026-07-29 03:44 — OXIO

Neither is a Microsoft invoice. Vendor row is orphaned.

## 3. Original supplier evidence

Not recoverable from staging. Would live in the `IngestedDocument`'s OCR / structured extraction (`extraction.vendor.guessedName`) at the time of first analysis, which is not persisted independently of the analyser's mutable output.

Historically the extraction would have produced `guessedName = "Microsoft Corporation"` (matching the corp-suffix regex at [supplier-extract.ts:99](src/lib/ap-intelligence/supplier-extract.ts#L99) — "Microsoft Corporation" matches `Corporation` in the corp-suffix alternation). At completion the user's Create Vendor & Post modal captured this value into `Vendor.legalName = "Microsoft Corporation"` — that Vendor row is the closest surviving evidence.

## 4. Current supplier extraction result

Cannot re-run because the source document is not present. However the supplier-extractor's own comments at [supplier-extract.ts:152-159](src/lib/ap-intelligence/supplier-extract.ts#L152) tell us the exact defect class and its fix history:

> Sprint 3 · Checkpoint 15Q (revised **2026-07-28**) — added Suite / Unit / Apt / Bldg / Floor / Ste prefixes so "Suite 800, 444 - 7th Ave SW Calgary, AB T2P 0X8 **Canada**" is recognised as an address. Without this, the line slipped past the address reject AND matched the corp-suffix alternation via its terminal `Canada` region token, so the full address became a supplier candidate.

This is EXACTLY the founder's regression class — the exact bug is documented. **The founder's Microsoft invoice was completed at a time when this defect was live, and the supplier-classifier vocabulary treated address lines ending in `Canada` as corp-suffix candidates.** The fix landed the same day the Microsoft Vendor was created (2026-07-28). If the invoice was analysed BEFORE the fix landed and the classifier's leader was an address line ending in Canada, and the user posted the invoice using the wrong extraction, and the card projection later re-runs analysis with the FIXED classifier... the card *should now* show the correct supplier or abstain. But per §B/§C findings, the Completed History card has no snapshot — every re-render pulls from the current live analyser, so any classifier change post-completion causes card drift.

## 5. Does current intelligence actually choose Canada?

**Cannot verify against the source Microsoft invoice** (see §1). But the systemic defect the founder hypothesized is real and documented in v206's own source. The corp-suffix regex at [supplier-extract.ts:99](src/lib/ap-intelligence/supplier-extract.ts#L99) STILL contains `Canada` (and `USA`, `Alberta`, etc.) in the alternation — this is intentional so that `TELUS Canada` and `Company USA` still classify. The 15Q address-line-rejection guard is what prevents a bare "Canada" address line from being a candidate — but any invoice text producing an address line like `Redmond WA 98052 Canada` (or the ambiguous case of a Canadian bill-to block on a US-shipping document) still risks corp-suffix matching on any prefix chain.

**Case assignment (§A2):** at completion time the case was likely **CASE B** — the historical persisted record (Vendor row) says Microsoft Corporation, but the Completed History UI reads a live-recomputed field. Post-15Q the live recomputation may or may not still return "Canada" depending on the exact source text. Either way, the founder-visible symptom (a completed card whose supplier can change) is real per §B findings, regardless of what the current analyser returns.

## 6. Microsoft vs Canada candidate evidence / scores

Cannot compute without the source document. Structurally the candidate scoring in [supplier-extract.ts:307-437](src/lib/ap-intelligence/supplier-extract.ts) awards points as: corp_suffix (+15), adjacent_tax_id (+18), remittance (+22), issuer_language (+20), adjacent_address (+10). Address lines used to be able to score corp_suffix (+15) but not adjacent_address (which is what a legitimate supplier line would score to +10 from a following address). Pre-15Q, `Microsoft Corporation` and a Canadian bill-to address block would both score corp_suffix; the tie-breaker (line position + surrounding context) could easily pick the address block if it happened to be later on the page with more surrounding tax-id-adjacent signals.

## 7. First supplier-identification failure boundary

Pre-2026-07-28 (Sprint 3 · Checkpoint 15Q), the boundary was: [supplier-extract.ts:161](src/lib/ap-intelligence/supplier-extract.ts#L161) `ADDRESS_LINE_RE` did not cover Suite/Unit/Apt/etc. prefixes, so address lines starting with `Suite 800, 444 - 7th Ave SW Calgary, AB T2P 0X8 Canada` slipped past address rejection AND matched the corp-suffix `Canada` alternation, producing an address line as a supplier candidate.

**Post-15Q that specific boundary is closed.** The founder's completed Microsoft card must have been completed pre-15Q (before 2026-07-28), or a different address-shape edge case is still slipping through.

## 8. Extraction / supplier intelligence / persistence / UI projection

**UI projection — categorically.** Every substantive supplier / total / GL / confidence field on the Completed History card is **live-recomputed on every render** via `analyseIngestedInvoice` in [intelligence-review-intakes.ts:1087](src/lib/mission-control/intelligence-review-intakes.ts#L1087), with only a 90-second process-local TTL cache.

Even if the extraction and classifier were perfect, mutating the classifier vocabulary later (as the SaaS-recall repair did) rewrites the historical card's displayed value. The defect is a **projection-layer immutability failure**, not a classifier failure.

## 9. Historical persisted supplier value(s)

None frozen. The persisted artefacts related to supplier are:
- `WorkIntakeItem.displaySender` — set to constant string `"Accounts payable"` at materialise time (`c:\dev\SpectreAutomation\src\lib\ap-intelligence\materialise.ts:476`), never overwritten by analysis. NOT the supplier.
- `Vendor.legalName` — mutable. Currently `"Microsoft Corporation"` (still correct in staging).
- `APInvoice.vendorId` → `Vendor.legalName` — mutable via vendor rename; no `vendorDisplayNameAtPost` snapshot column exists today.
- `WorkCompletionEvent.metadataJson` — empty on `RESOLVED`; `{ apInvoiceId, apInvoiceNumber, journalEntryId, journalEntryNumber }` on `POSTED_AND_CLEARED`. No supplier snapshot.
- `WorkIntakeActivity.note` — optional free-form, not schema'd for supplier.
- `AuditLog.afterJson` for `entityType="APInvoice"` on POSTED path — captures `{ invoiceNumber, vendorId, vendorRef, subtotal, tax, gross, currency, gl }` — the closest thing to a completion snapshot that exists today. Not consumed by the card projection.

The only durable supplier assertion at completion is via the `Vendor.legalName` linked through `APInvoice.vendorId` **when the invoice was POSTED**. For RESOLVED-without-posting completions, no supplier is durably captured.

## 10. Current Completed History card supplier source

**Live re-computation via `analyseIngestedInvoice`.**

Path traced by the projection-audit agent:
1. `loadMissionControlSnapshot(principal, clubId, { feedFilter: "history" })` in [intelligence-review-intakes.ts](src/lib/mission-control/index.ts) filters loader output.
2. `loadEmailIntakeItems` is the sole loader that includes RESOLVED WIs.
3. For each RESOLVED email intake with an attached AP intake, `loadLinkedIntelligenceForEmailIntakes` → `summariseApIntake` → **`analyseIngestedInvoice`** is called.
4. `summariseApIntake` has a 90-second process-local TTL cache keyed on COA/Vendor/APInvoice/OCR fingerprints and `currentAnalysisVersion()` — so the same worker process serves the same result for 90 seconds. After that, or on a different worker, or after a classifier version bump, a fresh live analysis runs.
5. The supplier value the card renders comes from `analysis.vendor.candidates[0].operatingName ?? legalName` OR `extraction.vendor.guessedName` — both live.

## 11. Does Completed History invoke live AP analysis?

**YES.** Confirmed at [intelligence-review-intakes.ts:1087](src/lib/mission-control/intelligence-review-intakes.ts#L1087). The comment on the ap-evidence *route* (`/api/mission-control/work-intake/[id]/ap-evidence/route.ts:69-71`) says "Recompute the analyser output for display. This is read-only and never writes; findings shown on the card come from the persisted rows above." — but that assertion is misleading: the LIST view for Completed History calls the same recompute code path, and every substantive AP fact except the "Completed" pill and the email's original `receivedAt` timestamp comes from the fresh analyser output, not from persisted rows.

## 12. Complete field-provenance map for completed cards

Reproduced from the projection-audit agent:

| Field | Source | Live re-compute on render? |
|---|---|---|
| Supplier / vendor NAME | `analysis.vendor.candidates[0].operatingName/legalName` OR `extraction.vendor.guessedName` | **YES** |
| Invoice number | `extraction.invoiceNumber` | **YES** |
| Amount / total | `extraction.total ?? analysis.amountHierarchy.value` | **YES** |
| Tax | `classifyGstVerification(extraction)` | **YES** |
| Currency | `extraction.currency ?? clubProfile.defaultCurrency` | **YES** (falls to ClubProfile) |
| Category label | `analysis.allocations.cardCategory ?? categoryLabel ?? purposeLabel` | **YES** |
| GL account number | Allocation authority (`allocations[0].recommendedAccount.accountNumber`) or `gl.accountNumber` | **YES** |
| GL account name | Same as above, name variant | **YES** |
| Confidence | `deriveApCardConfidence(analysis) + buildConfidenceInputs` | **YES** |
| Vendor match state | `analysis.vendor.state` | **YES** |
| PO number | `extraction.purchaseOrder` | **YES** |
| Recommendation text | `composeWorkflowReasonFromDecision(phase3Decision, analysis)` | **YES** |
| Completion state / status pill | `WorkIntakeItem.status` | **No** (stable) |
| completedBy user | `WorkIntakeItem.resolvedByUserId` — **exists but NOT RENDERED on the card** | n/a |
| completedAt timestamp | Card's timestamp label reads `EmailMessage.receivedAt` (original receipt), NOT `resolvedAt` | **No** (stable, but wrong semantic — see §20) |

## 13. Completed fields currently mutable after completion

Every AP fact except the status pill and the timestamp label. Detailed table in §16 of the projection-audit report (also §12 above). Concretely:

- Rerun OCR → supplier / invoice # / amount / tax / currency / line items all can change
- Supplier-extract vocabulary change → **supplier NAME can change** (this is the "Canada" defect)
- GL ranker weights → GL account number + name can change, category label can change
- Decision-engine change → workflow state, recommendation text can change
- State-mapping change → workflow pill can change (this is the recent Defect A slice)
- Action-derivation change → primary action button can change

**Zero snapshot is captured at completion today.**

## 14. Existing durable approval / posting records

Available:
- **`APInvoice` + `APInvoiceLine`** — for POSTED completions: captures invoice number, vendor id, subtotal/tax/total, currency, invoice date, terms, department, GL account per line, `postedAt`, `postedByUserId`, `postedJournalEntryId`. Missing: `vendorDisplayNameAtPost` (relies on mutable `Vendor.legalName`), category label (implicit — reconstructable from line accounts), confidence tier (not captured), workflow state at post (not captured).
- **`JournalEntry` + `JournalEntryLine`** — the ledger record. `memo = "${vendor.legalName} · ${vendorReference}"` — vendor name is embedded as a free-text memo at post time, immutable per-entry.
- **`Vendor`** — mutable name / address. Currently intact for Microsoft.
- **`WorkCompletionEvent`** — `clubId`, `workIntakeItemId`, `completedByUserId`, `completedAt`, `completionType`, `metadataJson` (free-form TEXT).
- **`AuditLog.afterJson`** on POST path — captures `{ invoiceNumber, vendorId, vendorRef, subtotal, tax, gross, currency, gl }`. Rich, but not consumed by any card projection.
- **`ApReviewOverride`** — captures reviewer-modified fields as `originalValueJson` / `correctedValueJson`. Not a full snapshot.

**For POSTED completions: the authoritative accounting transaction lives on `APInvoice` + `APInvoiceLine`.** For RESOLVED-without-posting: **nothing durable is captured.**

## 15. Is a new completion snapshot table required?

**No.** Extend the existing `WorkCompletionEvent.metadataJson` field with a `cardSnapshot` sub-object. It already exists, is already written on every terminal transition, is already tenant-scoped via `clubId`, and adding structure requires no Prisma migration.

For POSTED, defence-in-depth: add `APInvoice.vendorDisplayNameAtPost String?` — a nullable additive column — so the invoice-of-record's vendor label is frozen at post time and survives a subsequent `Vendor.legalName` rename. That IS a schema addition; it lives on the accounting posting path so requires the `accounting-workflows` skill review before landing.

## 16. Proposed ACTIVE vs COMPLETED lifecycle contract

```
ACTIVE (status ∈ {OPEN, IN_PROGRESS, DEFERRED, INFORMATIONAL})
  → live intelligence: current analyseIngestedInvoice output is authoritative
  → card can refresh as OCR / classifier / GL ranker improve
  → founder sees "the best Spectre can do RIGHT NOW"

USER APPROVES / POSTS / RESOLVES
  → capture a CompletionCardSnapshot at the moment of the terminal transition
  → snapshot lives in WorkCompletionEvent.metadataJson.cardSnapshot
  → for POSTED path, also freeze vendor display name on APInvoice.vendorDisplayNameAtPost

COMPLETED (status ∈ {RESOLVED, SUPPRESSED})
  → readCompletedCardFacts(clubId, wiId) returns { source: "frozen"; facts: <snapshot> }
    when snapshot is present
  → falls through to live re-projection { source: "live"; facts } only for
    historical completions where no snapshot was captured (§18)
  → later analyser vocabulary changes MAY be diagnostically visible in a
    "replay" view (§19) but MUST NOT overwrite the card
```

**Freeze boundary = the WorkCompletionEvent write.** The snapshot content is composed from the exact `ApInvoiceCardIntelligence` projection the founder was looking at when they clicked the button — passed into `resolveIntake` / `postAndClear` by the API route, not recomputed inside the completion handler.

## 17. Immutable-source hierarchy

For any completed WI card, in precedence order:

1. **If POSTED and `APInvoice.vendorDisplayNameAtPost` is set:** supplier = that value. All other card facts come from `APInvoice` + `APInvoiceLine` + `Account` (the posted transaction is authoritative for GL, amount, currency, tax).
2. **Else if `WorkCompletionEvent.metadataJson.cardSnapshot` exists for this WI:** every card fact comes from the snapshot. No live re-projection.
3. **Else (historical completion, no snapshot):** fall through to today's live-projection path with a subtle visible marker (§20) telling the founder this is "historical projection — captured before completion snapshotting."

## 18. Posted vs merely resolved

- **POSTED_AND_CLEARED completions** already have `APInvoice` + `APInvoiceLine` as the authoritative accounting transaction. Adding `APInvoice.vendorDisplayNameAtPost` closes the vendor-rename drift risk. The card projection reads from the invoice + line + account triple, not from the live analyser.
- **RESOLVED (without posting)** — for informational emails, non-financial resolves, and AP items resolved without posting — the snapshot MUST be captured in `WorkCompletionEvent.metadataJson.cardSnapshot` at the moment `resolveIntake` runs, because no APInvoice exists. This requires `resolveIntake` to accept an optional `cardSnapshot` argument that the API route computes from the projection it just rendered.

Founder rule "posted accounting transaction should take precedence over an earlier proposal" (§C) is satisfied by hierarchy step 1 above.

## 19. Historical vs current re-analysis

Two distinct concepts must be preserved:

1. **HISTORICAL APPROVED RESULT** — what the user approved. Rendered by the Completed History card from the frozen snapshot.
2. **CURRENT RE-ANALYSIS RESULT** — what today's analyser would conclude. Available via a diagnostic surface (not on the card).

Proposed diagnostic surface: a super-admin-gated route `/api/admin/ap-intelligence/replay-analysis?workIntakeItemId=X` that runs `analyseIngestedInvoice` freshly and returns the current output alongside the historical snapshot, with a side-by-side diff. Never mutates the WI. Never overwrites the snapshot. Never enqueues jobs. This is how we compare the 2000 Silver Springs historical invoices (§D) against improved intelligence without corrupting Completed History.

Card UI never shows "current re-analysis would differ" unless the founder deliberately clicks "Run current-intelligence comparison" from an audit view. Historical accounting workflow records stay historically accurate by design.

## 20. Microsoft regression-test design

Locked at four gates:

**Gate 1 — Snapshot capture on RESOLVE.** Resolve a WI whose extracted supplier is "Microsoft Corporation". Verify `WorkCompletionEvent.metadataJson.cardSnapshot.supplierDisplayName === "Microsoft Corporation"` immediately after resolution. Contract-level unit test.

**Gate 2 — Snapshot capture on POST.** Post an AP invoice whose vendor is "Microsoft Corporation". Verify `APInvoice.vendorDisplayNameAtPost === "Microsoft Corporation"` inside the same posting transaction. Contract-level unit test.

**Gate 3 — Immutability under classifier vocabulary change.** Simulate the founder's exact regression:
- Complete a WI with supplier "Microsoft Corporation" captured in the snapshot.
- Programmatically mutate the current `analyseIngestedInvoice` return value to output supplier "Canada" (via a test-mode override, no runtime supplier-extract change).
- Re-render the Completed History card.
- Assert the card STILL shows "Microsoft Corporation" and never surfaces "Canada".
- Assert the diagnostic replay surface, if called explicitly, DOES return "Canada" as the current-analysis result and clearly labels it "current re-analysis, not the approved value".

**Gate 4 — Backwards-compatible read.** For historical completions without a snapshot, the card projection must fall through to today's live behaviour AND surface the "historical projection — snapshot unavailable" marker. Assert both.

**Gate 5 — Active items still receive live updates.** An ACTIVE WI whose supplier extraction changes from "X Inc" to "X Corporation" via a classifier update MUST reflect the new value on the next render. Assert that only COMPLETED WIs are frozen.

**No Microsoft-specific rule. No brand allowlist. The test uses a generic vendor name "Regression Vendor Corp" for portability; the Microsoft-specific path is documented as the founder-observed instance.**

## 21. Smallest systemic supplier fix — IF current intelligence chooses Canada

**Not authorised by this diagnostic.** Founder direction §A3 was explicit: "Only diagnose — DO NOT repair yet." If a subsequent §A3 authorisation requires repair, the smallest systemic correction would target [supplier-extract.ts:99](src/lib/ap-intelligence/supplier-extract.ts#L99) `CORP_SUFFIX_RE`:

- Split the alternation into two lists: strong-suffix (`Corporation`, `Corp`, `Company`, `Co`, `Inc`, `Incorporated`, `Ltd`, `Limited`, `LLC`, `LLP`, `LP`, `ULC`, `PLC`, `GmbH`, `AG`, `SA`, `BV`, `NV`, `Pty`, `Association`, `Society`, `Foundation`, `Institute`, `Group`, `Holdings`) and weak-region-qualifier (`Alberta`, `Ontario`, `BC`, ..., `Canada`, `America`, `USA`, `International`, `Global`, `Worldwide`, `National`, `Regional`).
- A candidate that matches ONLY a weak-region-qualifier and has NO strong-suffix and NO adjacent-tax-id / remittance / issuer-language positive signal is not a supplier candidate.
- This retains `TELUS Canada` (strong-suffix pattern OR issuer-language OR tax-id all backfill it) while rejecting bare address lines whose only "supplier-like" signal is the terminal country.

No brand allowlist. No Microsoft rule. No Canada blacklist. Only tightens what counts as a supplier candidate when the sole positive signal is a region qualifier.

**Also NO change until the completion-immutability fix ships** — otherwise even the fixed classifier will silently rewrite historical Completed History cards during any future vocabulary evolution.

## 22. Smallest systemic completion-immutability fix

Per §15 / §16 / §17, in the shippable slice order the agent recommended:

- **Slice 1:** Add `readCompletedCardFacts` narrowing wrapper that returns `{ source: "live" | "frozen"; facts }`. Today always returns `live`. No user-visible change. Contract test only. Ships alone.
- **Slice 2:** POSTED_AND_CLEARED writes `cardSnapshot` in `WorkCompletionEvent.metadataJson`. Uses existing field, no schema change. Ships alone.
- **Slice 3:** RESOLVED writes `cardSnapshot` in `WorkCompletionEvent.metadataJson`. `resolveIntake` gains an optional `cardSnapshot` argument; the Mission Control API route computes it from the rendered projection and passes it in. No schema change. Ships alone.
- **Slice 4:** `readCompletedCardFacts` starts returning `source: "frozen"` when a snapshot exists. Card projection short-circuits `analyseIngestedInvoice` for RESOLVED WIs with snapshots. First user-visible slice. Ships after Slices 2 + 3 have been running for at least one day so back-to-back snapshots exist.
- **Slice 5:** Add `APInvoice.vendorDisplayNameAtPost String?` (nullable). Prisma migration. Requires `accounting-workflows` skill review. Ships independently; adds defence-in-depth vendor-rename protection to POSTED cards.
- **Slice 6:** Backfill script for POSTED WIs on staging — walks `WorkCompletionEvent` rows of type POSTED_AND_CLEARED whose `metadataJson.cardSnapshot` is null; composes the snapshot from `APInvoice` + `APInvoiceLine` + `Vendor` + `Account`; writes back into `metadataJson`. Tenant-scoped. Dry-run first. Not run on production without founder approval. Requires `imports-and-migrations` skill review.

Total scope: no schema change for Slices 1-4 + 6, one small nullable additive column for Slice 5. All slices are independent and rollback-safe.

## 23. Migration / backfill implications for already-completed WIs

- **POSTED completions (with `APInvoice` and, after Slice 5, `vendorDisplayNameAtPost`):** backfill from `APInvoice` + `APInvoiceLine` + `Vendor` + `Account`. Safe because the accounting transaction is durable and unambiguous. On staging today there are **zero APInvoice rows** on Coulee Ridge (§1), so this backfill would be a no-op there — it becomes relevant when the first real invoice posts.
- **RESOLVED-without-posting completions:** no durable AP snapshot exists. Cannot backfill. Recommendation: mark these completions as "historical projection — snapshot unavailable" and accept the honest gap. New completions capture the snapshot in real time.

**The Microsoft card the founder observed:** likely a RESOLVED-without-posting card (since no APInvoice exists for Microsoft on Coulee Ridge). Under the new architecture, we cannot reconstruct what the card said at approval time — only the Vendor row's current `legalName = "Microsoft Corporation"` is available. The forward-fix ensures no future Microsoft-shape invoice suffers the same drift.

## 24. Risks / regressions

Top 5, ranked by likelihood × blast radius:

1. **Snapshot vs Vendor.legalName drift creates two versions of truth for the same completed transaction.** After a vendor rename, the completed card shows the frozen approval-time name while the vendor timeline shows the current name. Likelihood: certain. Blast radius: medium (founder confusion but audit-correct). Mitigation: subtle "renamed to X" chip when they differ; document that the frozen name is intentional.
2. **RESOLVED-without-posting historical completions cannot be backfilled.** Card renders remain drift-prone for those items. Likelihood: certain. Blast radius: medium (informational items are non-financial). Mitigation: mark them and accept.
3. **`APInvoice.vendorDisplayNameAtPost` schema addition requires Prisma migration on staging + production.** Postgres additive nullable column. Backward-compatible. Likelihood: certain. Blast radius: low. Mitigation: nullable + shadow write for one deploy cycle.
4. **Testing burden — unit + integration + cross-tenant + E2E immutability under classifier change.** Likelihood: certain. Blast radius: medium. Mitigation: scope tests to the two entry points + projection reader; use test-mode analyser override for Gate 3 immutability test.
5. **Bifurcated card projection code (`if snapshot then frozen else live`) is a common bug seed when new fields are added later.** Likelihood: high. Blast radius: medium. Mitigation: single narrowing function `readCompletedCardFacts` as the sole card-facts entry point; every new card field must be added to both the frozen shape and the live projection or the type check fails.

## 25. Recommended implementation sequence

**Sequence (no code until founder-authorised):**

1. **PART A response — founder decides:** the specific Microsoft item is not reproducible on current staging. Founder to confirm whether (a) the environment they saw was local dev, (b) they can share a screenshot / WI ID / tenant slug for me to trace, or (c) accept the systemic-fix path without further specific-item analysis.
2. **PART A classifier-fix authorisation — separate from the immutability slice:** founder decides whether to authorise the [supplier-extract.ts:99](src/lib/ap-intelligence/supplier-extract.ts#L99) `CORP_SUFFIX_RE` split per §21. This is an AP-intelligence change and would need a targeted regression suite (sealed benchmark + new negative controls for bare `Canada` / `USA` / `Alberta` address lines).
3. **PART B/C immutability slices** (this is the load-bearing slice per founder direction):
   - Slice 1 (readCompletedCardFacts wrapper, no user-visible change) → local test → deploy staging
   - Slice 2 (POSTED snapshot capture) → local test → deploy staging → verify one manual post
   - Slice 3 (RESOLVED snapshot capture) → local test → deploy staging → verify one manual resolve
   - Slice 4 (read frozen path) → local test → deploy staging → verify Microsoft-shape immutability test (Gate 3)
   - Slice 5 (APInvoice.vendorDisplayNameAtPost column) → Prisma migration → deploy staging → `accounting-workflows` skill review
   - Slice 6 (backfill) → dry-run staging → real staging → do NOT run production without founder approval
4. **PART D — diagnostic replay surface:** super-admin-gated route separate from the card projection. Not urgent but required before the 2000 Silver Springs re-evaluation.
5. **PART E — regression tests:** all five gates in §20 lock the immutability contract at the test layer.
6. **Merge decision:** founder approves; not merged to main until at least one full completion cycle on staging (POST → resolve → re-render across a deliberate classifier version bump).
7. **Production:** never deployed without per-change founder authorisation.

**Do NOT during this diagnostic:**
- Any code change
- Any staging deploy
- Any production deploy
- Any schema migration
- Any AP intelligence / supplier classifier change
- Any Completed History rendering change
- Any WI mutation / re-analysis / snapshot backfill

---

## Founder-decision requests

1. **Environment/scope confirmation:** the specific Microsoft item is not on the staging tenants I can reach. Is the Microsoft/Canada regression observed on staging today, or on a local dev environment (Silver Springs seed)? If local, I can inspect the local DB if you share the SQLite path or invite me to reproduce.
2. **PART A vs PART B/C ordering:** should the immutability slices (PART B/C) ship first — closing the drift class permanently — before any supplier-classifier repair (PART A)? Or vice-versa? Recommendation: **immutability first**, because (a) it protects every future completed card against every future classifier change, (b) it is a bounded schema-lite change, (c) fixing the classifier without immutability doesn't restore historical cards.
3. **Snapshot capture strategy:** confirm the approach of extending `WorkCompletionEvent.metadataJson.cardSnapshot` (Slices 2 + 3) vs a new table. Recommendation: extend existing metadata field.
4. **RESOLVED-without-posting backfill:** confirm acceptance that historical resolves without APInvoice cannot be backfilled and will render with a "historical projection" marker. Alternative: bulk-recompute now and freeze the current output, accepting that "current" might diverge from what the founder actually approved historically.

**Awaiting founder direction. No implementation until authorised.**

---

## Compliance summary vs founder direction

| Constraint | Status |
|---|---|
| Do not modify runtime code until diagnostic complete | ✓ zero runtime changes |
| Do not modify AP intelligence | ✓ |
| Do not change supplier regexes / classifier rules yet | ✓ |
| Do not re-open or mutate the completed item | ✓ (also, not found on staging) |
| Do not re-run/replay analysis to make UI look correct | ✓ |
| STOP before authorized #220824 acceptance | ✓ |
| No AP intelligence changes | ✓ |
| No supplier-classifier changes | ✓ |
| No schema migration | ✓ |
| No Completed History changes | ✓ |
| No staging deploy | ✓ |
| No production deploy | ✓ |
| STOP after diagnostic | ✓ (this document) |

Awaiting founder review of PART A environment/scope + PART B/C/D immutability approach + PART E regression-test acceptance + PART F implementation-sequence approval.
