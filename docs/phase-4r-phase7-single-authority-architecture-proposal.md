# Phase 4R · Phase 7 (proposal) · Single-Authority Cluster-Owned Architecture

- **Date**: 2026-08-12
- **Branch**: `refactor/gl-single-authority`
- **HEAD**: `234f118` (Phase 6 staging acceptance report)
- **Status**: **PROPOSAL — awaiting founder authorization to implement**

Per founder directive on 221178 divergence: "Return with the proposed architecture and first-failure analysis before making a broad implementation if resolving this requires materially restructuring the document/allocation relationship." It does.

---

## §1 · First-failure analysis · 221178

### Invoice facts (from staging inspect-wi)

- Supplier: `Club Support Inc`
- Invoice: 221178 · Subtotal $3,613.50 · Tax $180.68 · Total $3,794.18 CAD
- Line-item evidence attached to `legacyEconomicPurposeTop3.supporting`: `"Online Backup License Fee: $100.00 x 2 servers = $200.00"`
- Nature classifier (whole-document): leader `REPAIR_AND_MAINTENANCE` (score 20, defensible), tied with `TAX_OR_REGULATORY` (score 20)
- Nature classifier evidence: REPAIR_AND_MAINTENANCE fired on the phrase `\bmaintenance\b`; TAX_OR_REGULATORY fired on `\blicense\s+fee\b`
- Capital classifier: `OPERATING`
- Allocation clustering: **single cluster** (`entryCount: 1`)

### The word "maintenance"

The line-item text does NOT contain "maintenance" (it says "Online Backup **License Fee**"). "Maintenance" appears elsewhere in the invoice's full OCR text — plausibly in a services description like "software maintenance", "annual maintenance included", or similar contract language. Regardless of exact location, it is NOT part of the line-item description of the goods/services purchased.

### Two canonical competitions on the same invoice

1. **Document-level canonical call** at [analyse.ts:1714](src/lib/ap-intelligence/analyse.ts#L1714):
   - `queryConcepts` built via [`extractQueryConcepts`](src/lib/ap-intelligence/gl-query-concepts.ts) with `{ lineItems, economicPurposeCandidates, fullDocumentText (whole PDF), supplierName, vendorHistoryConceptIds }`
   - Includes `fullDocumentText` — so any word in the invoice contributes concepts
   - Result: **winner 6033 R & M Preventative Maintenance** (conf 70, source SEMANTIC_MATCH)

2. **Cluster-level canonical call** per-cluster inside [`rankClusterCanonically`](src/lib/ap-intelligence/gl-allocations.ts):
   - `queryConcepts` built with `{ lineItems: clusterLines, economicPurposeCandidates: null, fullDocumentText: null, supplierName: null }`
   - Cluster-SCOPED per Phase 5 §6 cross-cluster-contamination guard
   - Result: **winner 6054 Computer & IT Services**

Both consume the same `natureLeader = REPAIR_AND_MAINTENANCE` (Phase 3.3 signal), same capital decision, same purchased-object context. The nature classifier itself is invariant across the two calls.

The single discriminator is the queryConcepts breadth: document-level sees the full invoice text (including the incidental "maintenance" phrase); cluster-level sees only line-item text ("Online Backup License Fee").

### Why 6033 wins at doc-level

`6033 R & M Preventative Maintenance` has strong name-token matches for:
- `\bmaintenance\b` (in account name)
- `\bpreventative\b` / `\bpreventive\b` (if the incidental "maintenance" phrase has "preventative" or "annual" nearby)

Combined with `natureLeader = REPAIR_AND_MAINTENANCE` (`NATURE_COMPAT +15` for any R&M expense account), it accumulates:
- ACCOUNT_NAME_SIMILARITY (TAXONOMY_ALIGNMENT family): high, up to +20
- FS_GROUP_TAXONOMY (TAXONOMY_ALIGNMENT family): probable +15
- NATURE_COMPAT (CAPITAL_NATURE family): +15
- RM_EXPENSE_MATCH: +20 (fires when capitalDecision derives to REPAIR_MAINTENANCE via Phase 3.3 facade lifting)
- Additional line-item concept scoring from the "maintenance" phrase

Total combined via SUM-across-families ≈ 70, matching the reported `confidence: 70`.

### Why 6054 wins at cluster-level

`6054 Computer & IT Services` matches:
- Line-item concept extraction on "Online Backup License Fee" → `subscriptions` / `computer_it_services` concepts
- Account name matches "computer" / "IT services" tokens
- No RM_EXPENSE_MATCH boost because the cluster's own `capitalDecision` derived from cluster-scoped signals is OPERATING (not REPAIR_MAINTENANCE)

Cluster-scoped queryConcepts contain no maintenance-derived tokens because "Online Backup License Fee" text has no maintenance token, so 6033 gets no name-similarity boost from the query side. Combined with fs-group compat + name similarity to `Computer & IT Services`, 6054 wins the cluster.

### Founder's diagnosis is correct

The founder's articulation:
> "arbitrary full OCR text must not become a parallel semantic authority that can contradict the purchased goods/services represented by the transaction cluster."

**That is exactly what happened.** The word "maintenance" appears somewhere in the invoice that is NOT describing the purchased item, yet at document-level it becomes a queryConcept and steers the canonical winner into R&M territory. The cluster-level scoping correctly ignores that noise and identifies the actual economic substance (IT services).

### Why the founder's accounting reading matches 6054

An online backup license fee is IT services, not repairs and maintenance. The bookkeeper's coding is `6054 Computer & IT Services`. The allocation surface got it right; the document-level surface was contaminated by incidental full-OCR text.

### Not a canonical-ranker defect. Not a nature-classifier defect

- `rankCanonical` did exactly what it was designed to do: score every eligible account against its inputs and pick the highest-scoring winner.
- The nature classifier fired on `\bmaintenance\b` — that's its job. `REPAIR_AND_MAINTENANCE` is a legitimate top-tied nature reading for an invoice containing that word.
- The Phase 3.3 facade RM lifting (`capitalDecision → REPAIR_MAINTENANCE` when nature is defensibly REPAIR_AND_MAINTENANCE) correctly propagated the classifier's reading.

The defect is at a **higher architectural layer**: we are running TWO independent canonical competitions per invoice (one on the full document, one per cluster) and asking founder-facing surfaces to reconcile them. When they disagree, the founder sees contradictory GL vs category evidence — exactly what §15 forbids.

---

## §2 · The founder's proposed architecture (transcribed)

> "The economic transaction—not the invoice document—is the unit of GL classification.
>
> For a genuinely single-cluster invoice, there should not be two independently constructed canonical competitions capable of producing different winners.
>
> Investigate a design in which:
> - invoice extraction/interpretation identifies economic transaction cluster(s);
> - each cluster owns its transaction-specific semantic evidence;
> - rankCanonical() operates on those clusters;
> - a single-cluster document's GL recommendation is the canonical result of that cluster;
> - a multi-cluster document exposes its allocation results;
> - document-level GL/category state is a projection/aggregation of cluster results rather than a second independent full-document ranking.
>
> Full-document evidence may still provide contextual information where appropriate—supplier identity, department, invoice metadata, reliable vendor history, etc.—but arbitrary full OCR text must not become a parallel semantic authority that can contradict the purchased goods/services represented by the transaction cluster."

This is architecturally correct. Adopting it eliminates the doc-vs-cluster split entirely.

---

## §3 · Proposed implementation ("cluster-owned classification")

### Data-flow (target)

```
IngestedDocument
  → extraction (line items, printed totals, supplier candidate, invoice metadata)
  → allocation clustering (buildClusters — same as today)
  → per-cluster canonical competition (rankClusterCanonically — same as today)
      · cluster-scoped queryConcepts (unchanged)
      · shared context: supplier identity, department, capital nature classifier,
        purchased-object durable-asset context, financing evidence, vendor
        history preferred accounts. Same globalSignals surface Phase 5 built.
  → RankedCluster[] with per-cluster {winnerAccountNumber, candidates, evidence,
      recommendationStatus, canonicalConfidence}
  → document-level projection:
      · if RankedCluster.length === 1  → single-cluster document
          gl.accountNumber          = clusters[0].canonicalWinnerAccountNumber
          gl.candidates             = clusters[0].candidates
          gl.canonicalConfidence    = clusters[0].canonicalConfidence
          gl.recommendationStatus   = clusters[0].recommendationStatus
          allocations.entries[0]    = same cluster (mirrored)
      · if RankedCluster.length > 1   → multi-cluster document
          gl.accountNumber          = null (or the dominant cluster, TBD)
          gl.candidates             = null (or aggregated, TBD)
          gl.canonicalConfidence    = aggregated (or "MULTI_ALLOCATION" sentinel)
          gl.recommendationStatus   = derived: RECOMMEND iff every cluster is RECOMMEND
          allocations.entries       = clusters (as today)
      · gl.cardCategory / gl.derived surfaces come from the same cluster set
```

### What disappears

- Document-level `runCanonicalGlRanking(...)` call in [analyse.ts:1714](src/lib/ap-intelligence/analyse.ts#L1714).
- `canonical-runtime-facade.ts::runCanonicalGlRanking` becomes the **single-cluster** case of the cluster ranker (or is deleted; per-cluster ranker becomes the sole entry point).
- The `fullDocumentText` → `queryConcepts` pathway at document scope no longer exists as a semantic input to GL selection. It remains available for OCR / diagnostics / evidence explanation but does not vote.
- `computeConfidenceDimensions.glClassification` continues to consume `gl.canonicalConfidence.level` as it already does (Phase 5 §22.14), but now that confidence is the cluster's confidence rather than a separate doc-level ranker's confidence.

### What stays

- `rankCanonical` — unchanged. Still the single ranking authority.
- Recommendation policy, canonical confidence, competitor qualification — unchanged.
- Phase 3.3-3.5 signal set (nature, capital, purchased-object, financing) — unchanged.
- Phase 5 per-cluster canonical facade + global-signals plumbing — unchanged.
- Phase 6 projection semantics fix (`c9d9291`) — unchanged.
- Static architectural guards — unchanged.

### What needs to be decided (founder choices)

1. **Multi-cluster document-level `gl.accountNumber` projection**:
   - Option A: **null**. Document card shows "Multiple" / no single GL. AP coding modal shows per-allocation.
   - Option B: **dominant cluster** by amount. Document card shows dominant account name. Founder sees "the invoice mostly goes to X" summary.
   - Option C: **highest-confidence cluster**. Different notion of "dominant" — prefers the surest classification.
   
   Recommendation: **A** — for a genuinely multi-cluster invoice there is no single GL account; surfacing one is a projection lie.

2. **Full-document evidence retention for `contextual` inputs**:
   - Keep as context ONLY when clearly transaction-substance (line items, purpose extraction from line items, purchased-object identity, capital nature classifier already run on line-item-scoped text)
   - Remove from queryConcepts entirely: `fullDocumentText` (raw OCR), footer/marketing/policy-region text
   - Keep: supplier identity, department (organisational), matched vendor history preferred accounts
   
   Recommendation: **that** exact split. The nature classifier already runs against `transactionalTextValue` (footer/policy regions excluded) or raw pdfText fallback — it already tries not to be OCR-noise-driven. That remains.

3. **`natureLeader` propagation to clusters**:
   - Currently: nature is classified once at document level and passed as globalSignals to every cluster.
   - Preserve: cluster receives natureLeader as context. Cluster's own rankCanonical sees NATURE_COMPAT, CAPITAL_ASSET_MATCH etc.
   - Consider: allow cluster to OVERRIDE the doc-level natureLeader when the cluster's own line-item text has a strong contradictory nature signal. Phase 5 doesn't do this today.
   
   Recommendation: **defer**. Adopt cluster-owned architecture first without cluster-level nature re-classification; add cluster-nature-override in a follow-up phase if evidence shows single-cluster invoices need it.

### Estimated scope

- Code changes: **moderate** (~200 lines in analyse.ts + ~50 in canonical-runtime-facade.ts + ~150 in gl-allocations.ts projection). No new modules. No canonical-ranker changes.
- Test changes: **material**. The Phase 4R architectural guard test still passes (doc-level 0 overrides, alloc-level 0 overrides). But the semantics tests (Phase 4R canonical + evidence-integrity + recommendation-policy) need to be reviewed for assumptions that "doc-level canonical result" is independent of "cluster canonical result" — most tests today use single-cluster fixtures, so they're insensitive to this.
- New test cases required (founder-listed):
  1. 221178-style: single-cluster invoice with incidental full-OCR maintenance text → cluster winner reaches document-level (6054, not 6033)
  2. Single-cluster genuine R&M invoice where R&M SHOULD win at both surfaces (regression against over-correction)
  3. Single-cluster software/service invoice → IT services surfaces at document-level
  4. Capital acquisition with incidental service/maintenance language in body → capital account still wins at cluster (dominant purchase)
  5. Genuine multi-allocation (CPA-style) → per-allocation results preserved; document-level shows either "Multiple" or dominant cluster per founder choice above

- Real-fixture regression: 221178, 1091559, 1087769 + restore CPA, OXIO, DMM.

### Risk analysis

- **Low**: canonical ranker itself is unchanged. All Phase 4R architectural guarantees hold.
- **Low**: existing Phase 4R + Phase 5 + Phase 6 targeted regression stays green because the tests operate at rankCanonical level and don't depend on doc-level having a SECOND competition.
- **Moderate**: some existing UI surfaces may currently display something driven off `gl.canonicalConfidence.level` even for multi-cluster invoices; those need reconfirmation once doc-level becomes an aggregation.
- **Moderate**: `computeConfidenceDimensions.glClassification` legitimately projects the canonical assessment level. For multi-cluster invoices under Option A above, it would need to project a MULTI_ALLOCATION-shaped level (or aggregate). Not hard, but needs explicit thought.
- **Low**: no schema change. No migration. No new prisma table.

### What does NOT change

- The founder-facing accounting behavior for **single-cluster invoices** where the cluster and document already agree (which is the majority of invoices).
- Any Phase 3/4/5 acceptance criterion. All prior architectural invariants continue to hold.
- Anti-overfitting guards, static architectural guards, confidence-consumer audit result.

---

## §4 · Concrete request for founder

Please confirm:

1. **Adopt the cluster-owned architecture** as described in §3.
2. **Multi-cluster document-level `gl.accountNumber` projection choice**: A (null / "Multiple"), B (dominant by amount), or C (highest-confidence cluster). I recommend **A**.
3. **fullDocumentText removal from queryConcepts**: confirm removal (line items + purpose + purchased-object identity + supplier + vendor history are the only semantic inputs).
4. **`natureLeader` propagation**: keep current behavior (document-level nature classification → passed as globalSignals to every cluster; no cluster-level override in this phase).
5. **Test scope**: I'll add the 5 new synthetic archetypes listed in §3 + rerun the 3 real fixtures on staging + attempt to restore CPA / OXIO / DMM before requesting merge.

Once authorised, I'll implement, run the full targeted regression + full vitest + baseline compare, redeploy to staging, re-inspect 221178 (should return single-authority 6054), and produce a Phase 7 acceptance report before requesting merge to main.

---

## §5 · Status summary

- Phase 6 refactor branch deployed to staging at v207 (web) / v104 (worker). **Left in place per founder instruction; not rolled back.**
- Main / production unchanged.
- Phase 4R architectural invariants intact.
- **DO NOT MERGE TO MAIN** until Phase 7 architectural correction is implemented, tested against real fixtures, and reviewed.

Awaiting authorization of §4 to proceed with implementation.
