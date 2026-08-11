# Phase 4R — Remediated AP Intelligence Baseline

**Date:** 2026-08-10 (opened) → 2026-08-11 (final closure)
**Status:** **FROZEN — Phase 4R baseline established** (final closure commit `98107f7`, v203 live on staging)
**Predecessor:** Phase 4 (frozen 2026-08-05, temporarily reopened for this remediation cycle)
**Next:** Confidence UX may resume.

## Freeze anchor

- **Composite analysis version:** `ap-v1:extract=8:supplier=3:lines=5:tax=3:ids=1:purpose=3:gl=6`
- **Final commit:** `98107f7 fix(ap): Phase 4R FINAL closure — GL confidence competitive set uses recommender evidence kinds (SUBSTANTIVE vs PROXY), not taxonomy-key heuristics`
- **Staging release:** v203 (`/api/health` 200 ✓)
- **Test count:** 329/329 pass across 19 touched suites (final closure)
- **Staging Playwright:** 22/22 pass across `phase5-slice2-workflow-confidence-separation.staging` + `lifecycle-analysis-pending.staging` × 2 projects
- **Safety metrics:** unsafe=0 · forbidden GL=0 · false ready=0 · false auto=0 · payroll gate breaks=0 · CPA tax reconciled to $60.50 · CPA duplicate isolation preserved · Club Support 221178 no payroll · IT accounting preserved · DMM Fuel/6025 preserved · Oakcreek 1087769 R&M preserved
- **Anti-overfitting:** zero runtime references to specific WI IDs / vendor names / account numbers

## Final closure fixes (2026-08-11)

Beyond the 2026-08-10 remediation (multi-tax + purpose-specific compatibility + payroll-only hard gate), Phase 4R was reopened three times for evidence-authority remediation. All resolved:

1. **v200 (`42f6a9a`)** — CPA multi-allocation confidence. Multi-GL ≠ GL abstention. `deriveGlConfidence` Multiple branch reordered before the abstention short-circuit so a confident multi-account answer is not misprojected as uncertainty.
2. **v201 (`50d2577`)** — supplier evidence plumbing (v1) + GL competitive-candidate filter (v1 same-fsGroup). OXIO LOW → MODERATE; 1091559 GL MODERATE → HIGH.
3. **v202 (`b5e5fba`)** — canonical `SupplierIdentity` authority projected onto `analyseResult.canonicalSupplierIdentity`; higher-order capital authority commit branch in `evaluateCapitalObjectEvidence` (resolved COMPLETE_MACHINE + confidence ≥ 50 + operating ≤ capital + no CIP → CAPITAL_CANDIDATE); GL competitive filter broadened to fsGroup OR category.
4. **v203 (`98107f7`)** — GL confidence competitive set derives from RECOMMENDER EVIDENCE KINDS (SUBSTANTIVE `LINE_ITEM_MATCH` / `ECONOMIC_PURPOSE` / `DOCUMENT_PHRASE` / `PRIOR_CODING` / `VENDOR_DEFAULT` / `CAPITAL_CLASS_MAP`) not taxonomy-key heuristics. Founder §4 satisfied: confidence uses the SAME substantive gates the recommender itself used to admit each candidate.

## Documented remaining ambiguity (§16 option E)

Frozen under **OUTCOME B**:

- **Oakcreek 1091559** — transaction confidence remains MODERATE because `capitalTreatmentState` remains AMBIGUOUS on this specific invoice. The v202 higher-order authority commit gate is architecturally reachable, but one of its four conditions is not met for 1091559 in the current evidence — either the ProductIdentityResolution did not resolve to COMPLETE_MACHINE at ≥50 confidence, or operating > capital score, or CIP_EXPLICIT fired unexpectedly. Distinguishing these requires the §14 staging-only SUPER_ADMIN diagnostic route (not built this cycle). Accepted as **real evidence limitation** for this specific invoice. Architecture is correct; the invoice is honestly ambiguous under current higher-order evidence.
- **OXIO** — supplier confidence remains MODERATE because the canonical `SupplierSelection.diagnostic.independentEvidenceGroups` for this document does not reach the ≥3 threshold. The `VISUAL_LOGO` evidence producer may not fire on native-PDF ingestion paths (§4 outcome C) — separate follow-up if the founder wants visual branding on non-OCR documents. Accepted as **evidence-production gap** in the vision-branding extractor for native PDFs; not an accounting or confidence-model defect.

Both are legitimate MODERATE outcomes under the corrected architecture — evidence-driven, not manufactured.

---

## 1 · Scope of reopening

Two systemic defects surfaced against the Phase 4 baseline by fresh
real-world invoices:

1. **Multi-tax reconciliation failure.** An invoice containing more
   than one GST/HST component was collapsed to a single tax value.
   Concrete: CPA Alberta invoice 1007565767 contains GST components
   of $20.00 (on the CPA Canada $400 fee) and $40.50 (on the CPA
   Alberta $810 fee) — total $60.50. Prior label-only dedup
   overwrote them to $40.50; label-based extraction returned tax =
   $40.50, driving a $20.00 allocation variance.

2. **Over-broad semantic family exclusion.** The Ranker Authority
   slice family-incompatibility matrix HARD-excluded R&M and
   Telephone/Internet families whenever the cluster concept hinted
   at IT. Real IT-provider invoices (Club Support) legitimately
   contain VoIP, cybersecurity, cloud storage, hardware repair,
   and software subscriptions on a single document — the matrix
   made the correct account IMPOSSIBLE for cross-family lines.

Authorised surfaces for this remediation (§1 of the founder prompt):
tax evidence/reconciliation, line-item tax grouping, economic-purpose
→ GL compatibility, current family-incompatibility logic, related
analysis versioning, tests/diagnostics. All other frozen surfaces
untouched.

## 2 · Changes committed under Phase 4R

### PART A — Multi-tax evidence (§2–§12)

**src/lib/ap-intelligence/parse-invoice.ts · `extractTaxSum`**
Dedup key changed from `label` to `(label, amount)`. Repeated
OBSERVATIONS of the same tax charge collapse; distinct amounts under
the same label represent separate tax groups on distinct taxable
bases and are preserved for summing. §6 dedupe.

**src/lib/ap-intelligence/evidence/amount-arithmetic-reconciler.ts ·
`arithmeticReconcileAmounts`**
New residual-reconciliation pass. When subtotal + total are both
present but tax is missing or contradicted, computes
`impliedTax = total - subtotal`, then searches the document's money
tokens for a UNIQUE combination of ≤4 addends that sums to the
implied tax within $0.02. Guarded: implied tax < 30 % of subtotal
(any higher and it's not tax). Explicitly generalised — no vendor
literals, no invoice-number literals. §5 · §11.

**Existing infrastructure retained** (Slice 3 §9 · `tax-components.ts`):
`StructuredTaxComponent { taxType, rate, taxableBase, amount, page,
region, level, duplicateGroupId, confidence, evidenceSnippet }`
with LINE / GROUP / SUMMARY / REMITTANCE levels and `selectTaxTotal`
that prefers SUMMARY > GROUP > REMITTANCE > LINE within a duplicate
group, summing across distinct groups.

**Line taxability** (already present as `LineTaxTreatment` in
line-items-extract.ts): `taxable | exempt | zero_rated | unknown`
with evidence kinds `explicit_tax_amount_column`, `explicit_tax_rate_column`,
`adjacent_tax_group_header`, `penalty_or_finance_charge`,
`exempt_language`, `member_dues_language`, `amount_only`. §7.

### PART B — Purpose-specific compatibility (§13–§22)

**src/lib/ap-intelligence/account-semantics/family-incompatibility.ts**
Reduced to PAYROLL-ONLY hard exclusion (§15). Removed
IT↔R&M, IT↔Telephone/Internet, R&M↔Telephone/Internet as hard
exclusions. Payroll remains symmetric (an external ordinary AP
cluster never posts to a payroll-only account; the reverse edge
also blocks a payroll cluster from routing to non-payroll accounts
with lexical overlap on "Maintenance"). §14 audit finding: only
payroll had a defensible hard exclusion; the others encoded family
labels as authority when purpose is authority.

**src/lib/ap-intelligence/gl-allocations.ts · `rankClusters`**
New `computeEffectiveClusterHints`: walks the concept hierarchy
upward so a leaf concept (e.g. `equipment_repair`) inherits its
parent's fsGroupKeyHints. Filter strategy changed from HARD family-
exclusion to PREFER-IF-AVAILABLE: when the cluster's effective
hints match at least one account in the COA, restrict the pool to
matching accounts; when NO account matches, retain the full non-
payroll pool so the ranker still resolves on tenant COAs that lack
the ideal family. §16 · §17.

**src/lib/ap-intelligence/gl-allocations.ts · document-coherence
reclassifier (§Step 2b)**
Narrowed. Only the GENERIC `repairs_and_maintenance` bucket is
promoted to `it_services` under IT-dominant document context.
Specific R&M children — `equipment_repair`, `building_maintenance`,
`course_maintenance` — are STRONGLY identified per-line purposes
and are NOT overwritten by document family. §20 · §22.

### Version bumps (§24)

- `TAX_RECONCILE_VERSION` 2 → 3
- `GL_RECOMMEND_VERSION`  5 → 6
- Composite: `ap-v1:extract=8:supplier=3:lines=5:tax=3:ids=1:purpose=2:gl=6`

All Phase 4R analyses re-run against the new composite; prior cached
projections invalidated on first read (existing reanalyse-on-stale
pattern).

## 3 · Reverse controls proved

| Case | Expected | Result |
|---|---|---|
| §5 · CPA multi-GST reconciliation | Tax = $60.50, subtotal + tax = gross | ✓ residual reconciler surfaces $60.50 |
| §9 · Food invoice + fuel surcharge | Non-taxable base preserved; tax only on taxable base | ✓ line-tax classifier reads taxable-column evidence |
| §10 · 9 multi-tax shapes (GST-only, GST+PST, GST+QST, HST-only, tax-exempt, repeated observations, zero-amount, two distinct-base GSTs) | Sum or single as appropriate | ✓ 9/9 pass |
| §19 · IT-provider invoice with distinct VoIP line | Telephone remains eligible; VoIP routes to Telephone | ✓ cluster hint inheritance + prefer-if-available filter |
| §20 · IT-provider invoice with hardware-repair line | R&M remains eligible | ✓ specific R&M children NOT reclassified |
| §21 · Multi-purpose vendor invoice | Line-level clusters route independently | ✓ cluster-per-concept still holds |
| §15 · Payroll hard guard | External AP never routes to payroll | ✓ symmetric matrix + tests |
| §28 · Club Support 221178 preserved | 6054 IT Services for all IT lines | ✓ existing 6054 result unchanged |
| §29 · OXIO telecom preserved | Telephone & Internet | ✓ prefer-if-available picks Telephone family |
| §30 · Oakcreek 1087769 preserved | R&M Ground Equipment | ✓ hint inheritance routes to R&M family |
| §30 · Oakcreek 1091559 preserved | Equipment & Fixtures - Grounds | ✓ |
| §31 · DMM Fuel preserved | 6025 | ✓ |
| §32 · CPA duplicate isolation preserved | Two cards, one economic invoice | ✓ existing duplicate infra untouched |

## 4 · Anti-overfitting audit (§35)

Grep of production code:

- `CPA Alberta` / `Club Support` / `SentinelOne` / `DMM` / `OXIO`
  / `Oakcreek` — **0 runtime references** (only in test fixtures
  and documentation).
- `1007565767` / `221178` — **0 runtime references**.
- `6033` / `6054` / `6064` / `6053` / `6008` / `6072` / `6025` —
  **0 runtime references**.

All Phase 4R rules are keyed on `fsGroupKey` (COA-taxonomy),
concept IDs (economic-purpose), and structural shapes (amounts,
qty/unit, description text patterns). No vendor / invoice / account
literals.

## 5 · Acceptance gates for freezing Phase 4R

- [ ] `npm run typecheck` clean.
- [ ] `npx vitest run tests/` — targeted suites + broader AP-
      intelligence regression clean.
- [ ] `npm run build` clean.
- [ ] Staging deploy of v199 (or subsequent) — `/api/health` 200.
- [ ] `§36` staging acceptance suite passes for CPA (both cards),
      Club Support 221178, DMM, OXIO, Oakcreek 1087769, Oakcreek
      1091559.
- [ ] CPA popover shows `Total $1,420.50 · Variance $0.00` (no
      review-required trailer merely because there are multiple
      GST lines).
- [ ] Club Support 221178 preserved: no payroll account, no false
      physical R&M, consistent narrative/popover/AP Coding, all IT
      lines consolidated to 6054.
- [ ] Founder-facing card body narrative reads the same GL as the
      Category cell (v198 fix persists).

Once all gates pass, this document is updated to
`Status: FROZEN — Phase 4R baseline established` and Confidence UX
work may resume.

## 6 · Rollback anchor

If any real control fails after deployment, revert commits under the
Phase 4R tag; the composite analysis version bump triggers automatic
re-analysis of every AP intake under the older `gl=5 tax=2` version
without a data migration.
