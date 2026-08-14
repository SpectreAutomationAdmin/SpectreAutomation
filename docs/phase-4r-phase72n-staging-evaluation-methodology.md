# Phase 4R · Phase 7.2N — Real-World Staging Evaluation (methodology + deployment)

**Status:** Founder-authorised Phase 7.2N real-world staging evaluation.
The complete accepted architecture (7.2K + 7.2L + 7.2M-B) is deployed
to staging. Measurement, ground-truth capture, and cohort review are
next — those require founder participation and cannot be done
algorithmically.

**Not staged.** No merge to main. No production deployment. Staging
only.

**Frozen candidate (§21):** no runtime modifications during the first
cohort run. All measurement is against `bafd2be`.

---

## §1 · Staging deployment record

- **Branch / SHA:** `refactor/gl-single-authority` @ `bafd2be`
- **Deployed at:** 2026-08-14T04:33Z (web) / 04:34Z (worker)
- **Deployment time:** ~5 min end-to-end

### Web
- **App:** `spectre-staging`
- **Release version:** v210 (was v209)
- **Image:** `spectre-staging:deployment-01KZZ8GQVY07B8GHS51CWAQDR6`
- **URL:** https://staging.spectreautomation.com
- **Rollback anchor:** v209, image `spectre-staging:deployment-01KZW9ER114RGPDZNRYMW32B6Q`

### Worker
- **App:** `spectre-staging-worker`
- **Release version:** v107 (was v106)
- **Image:** `spectre-staging-worker:deployment-01KZZ8PE0D7CHZ52V57RKJ8M4E`
- **Rollback anchor:** v106, image `spectre-staging-worker:deployment-01KZW9K85W2EJ1RRCSV8322YSK`

### Health verification

`GET https://staging.spectreautomation.com/api/health` returns **HTTP 200**:

- `status: ok`
- `apIntelligence.analysisVersion: ap-v1:extract=8:supplier=3:lines=5:tax=3:ids=1:purpose=3:gl=6`
- `eligibilityRuleVersion: 3`
- `workflowDecisionVersion: 1`
- `phase0Enabled: true`
- `phase2Enabled: true`
- `checks[database]: ok, 15ms`
- `checks[queue]: ok, dlq total=2 · active=2 · historical=0`
- Timestamp: 2026-08-14T04:55Z

Migration outcome: `release_command` machine ran and exited cleanly
(Prisma migrations up-to-date, no schema changes in K/L/M-B).

Log scan for a bounded window post-deploy: no errors observed
(inspect via `flyctl logs --app spectre-staging` for detailed review).

Both worker machines transitioned to v107 without downtime (rolling
via `strategy: immediate`).

---

## §2 · What was deployed

Three sequential architectural commits since v209/v106:
1. `5c8b47b` — Phase 7.2K: semantic contracts + structured retrieval
2. `f2888cd` — Phase 7.2L: hierarchical canonical competition
3. `bafd2be` — Phase 7.2M-B: structured accounting-class evidence

Runtime consequences for AP intelligence on real invoices:
- `CanonicalAccountingTreatment` composed from capital + nature classifiers.
- `CanonicalAccountSemantics` typed per-account (statementRole,
  accountingClass, postingRole, inventoryPrepaidRole).
- Candidate tier assignment (PRIMARY / PLAUSIBLE / CONTRADICTED /
  INELIGIBLE) inside `rankCanonical()`.
- ASSERTED_TREATMENT competition mode for strong-defensibility invoices.
- `ACCOUNTING_CLASS_MATCH` observation (TAXONOMY_ALIGNMENT +15) when
  purpose × statementRole → accountingClass matches candidate.
- Zero changes to `COMMIT_MIN_SCORE`, evidence weights, confidence
  thresholds, competitor thresholds, recommendation policy.

---

## §3 · Founder-participation requirement

**The remaining Phase 7.2N work is human-in-the-loop.** Automated
data-collection is possible; automated ground-truth generation is
not.

Specifically:
- **Cohort selection** (§3 of directive): pull 20-50 real AP invoices
  from the staging Work Intake feed. Sample for diversity, NOT
  cherry-picked for known-good behaviour.
- **Ground truth capture** (§4-5): for each invoice, record the human
  accountant's expected treatment / class / GL BEFORE looking at
  Spectre's output. This is the anti-confirmation-bias requirement.
- **Ambiguity classification** (§4): CLEAR / LEGITIMATELY_AMBIGUOUS /
  INSUFFICIENT_INFORMATION.

**Without founder ground-truth capture, no meaningful accuracy metric
can be produced.**

---

## §4 · Data-collection tooling available on staging

For each invoice in the cohort, capture the full reasoning trace via:

### Work Intake inspection endpoint

```
GET https://staging.spectreautomation.com/api/ap-intelligence/inspect-wi/<workIntakeId>
```

Returns the full `AnalyserSnapshot` including:
- Extraction (supplier / invoiceNumber / amount / tax / lineItems)
- Transaction interpretation:
  - `purposeDecision` (concept + confidence)
  - `accountingNature` (leader + defensibility + confidence)
  - `capital.state`
  - **NEW `canonicalAccountingTreatment`** (statementRole,
    defensibility, contradictions, provenance, composedNatureLeader)
  - **NEW `accountingClassHint`** (per-cluster)
- Cluster reasoning:
  - Each cluster's queryConcepts, candidate pool
  - **NEW per-candidate `tier`** (PRIMARY / PLAUSIBLE / CONTRADICTED /
    INELIGIBLE)
  - **NEW per-candidate `tierReason`**
  - Candidate scores + evidence + contradictions
  - **NEW `ACCOUNTING_CLASS_MATCH`** observation when it fires
- Decision:
  - `canonicalWinnerAccountNumber` + score
  - `recommendationStatus` + `abstentionReasons`
  - `canonicalConfidence`
  - Auto-approval eligibility

### Bulk cohort export (recommended)

```
SELECT wi.id, wi.subject, wi.createdAt, ap.canonicalWinnerAccountNumber,
       ap.canonicalWinnerScore, ap.recommendationStatus, ap.abstentionReasons
FROM WorkIntake wi
LEFT JOIN APAnalysis ap ON ap.workIntakeId = wi.id
WHERE wi.clubId = '<staging club id>'
  AND wi.createdAt > NOW() - INTERVAL '30 days'
  AND wi.categoryKey IN ('AP_INVOICE', 'AP_STATEMENT')
ORDER BY wi.createdAt DESC;
```

Run against the staging DB via
`fly ssh console --app spectre-staging` + `psql`, OR via a one-shot
Prisma script following `~/.claude/projects/c--dev-SpectreAutomation/memory/reference_staging_infra.md`.

---

## §5 · Ground-truth capture template (per invoice)

For every invoice in the cohort, produce a row like:

| Field | Value |
|---|---|
| `workIntakeId` | (from staging) |
| `supplier` | |
| `invoiceRef` | |
| `total` | |
| **Human-expected treatment** | OPERATING_EXPENSE / CAPITAL_ASSET / INVENTORY / PREPAID / COST_OF_SALES |
| **Human-expected accounting class** | IT_SERVICES / FUEL_EXPENSE / EQUIPMENT_ASSET / MEMBERSHIP_DUES / FOOD_INVENTORY / etc. |
| **Human-expected GL account** | (leave blank if ambiguous) |
| **Ambiguity flag** | CLEAR / LEGITIMATELY_AMBIGUOUS / INSUFFICIENT_INFORMATION |
| **Notes** | free text on the accounting reasoning |
| — Spectre outputs (captured separately) — | |
| Spectre purpose | (from purposeDecision.concept + confidence) |
| Spectre treatment | (from canonicalAccountingTreatment.statementRole) |
| Spectre class hint | (from accountingClassHint) |
| Spectre canonical winner | |
| Spectre score | |
| Spectre status | RECOMMEND / ABSTAIN_AMBIGUITY / ABSTAIN_NO_CANDIDATES / ABSTAIN_QUALITY |
| Spectre confidence | HIGH / MODERATE / LOW / REVIEW_REQUIRED |
| Expected account in candidates? | yes / no |
| Expected account tier | PRIMARY / PLAUSIBLE / CONTRADICTED / INELIGIBLE / absent |
| Expected account rank | (1-based, or "not in top-N") |
| Expected account score | (numeric) |

**Order of operations:** fill in the human columns FIRST, then look
up the Spectre columns. This preserves independent judgment (§5 of
the directive).

---

## §6 · Metric derivations (post-capture)

Once the cohort spreadsheet is complete, compute:

### On HUMAN_CLASSIFIABLE invoices (`ambiguity in {CLEAR}`)

- **treatmentAccuracy** = (Spectre treatment matches human) / total
- **classAccuracy** = (Spectre class hint matches human class) / total
- **recall** = (expected account in candidates) / total
- **correctTierRecall** = (expected account in PRIMARY tier when human
  treatment is asserted) / total
- **rawTop1** = (Spectre canonical winner = human expected GL) / total
- **committedTop1** = (rawTop1 AND status = RECOMMEND) / total
- **correctWinnerAbstained** = (rawTop1 AND status ≠ RECOMMEND) / total
- **wrongWinnerAbstained** = (Spectre winner ≠ human GL AND status ≠ RECOMMEND) / total
- **unsafeRate** = (Spectre winner materially different from human AND status = RECOMMEND) / total

### On ambiguous invoices (`ambiguity ≠ CLEAR`)

- **warrantedAbstain** = (status ≠ RECOMMEND) / ambiguous total
- **inappropriateRecommend** = (status = RECOMMEND when human said ambiguous) / ambiguous total

### On R1-R9 failure classification (per §22)

For every miss (Spectre wrong or abstain-when-should-recommend),
classify the FIRST failure boundary:

- **R1 extraction** — supplier/amount/line-items wrong
- **R2 treatment** — statementRole wrong (asset vs expense etc.)
- **R3 accounting class** — treatment right, class wrong
- **R4 retrieval** — expected account absent from pool
- **R5 within-tier ranking** — correct tier, wrong account #1
- **R6 evidence propagation** — expected account #1 or top-3 but score too low, structured evidence didn't reach it
- **R7 recommendation policy** — correct #1, correct score, but policy abstained
- **R8 clustering** — multi-alloc split wrong
- **R9 projection/UI** — reasoning correct but UI shows wrong result

### On score-distribution analysis (§15-16)

For every correct or plausibly-correct winner with score ∈ {0, 1-9, 10-19, 20-29}:
- Produce the accounting evidence ledger (which propositions fired, which didn't)

For every wrong winner with score ≥ 30 (dangerous):
- Trace which structured proposition was wrong
- Trace evidence family contributions

---

## §7 · Known-fixture spot-checks (§17)

If real staging data contains these vendor invoices, capture them
specifically:

| Fixture | Human expectation |
|---|---|
| **Club Support 221178** (Online Backup License) | Computer & IT Services |
| **Oakcreek 1091559** (equipment acquisition) | Capital Equipment Asset |
| **Oakcreek 1087769** | (verify real economic substance) |
| **DMM Energy** (fuel) | Fuel & Lubricants |
| **CPA Alberta** (professional membership) | Membership & Dues |
| **OXIO** / **telecom** | Telephone & Internet |

Do not block cohort progress waiting for unavailable fixtures.

---

## §8 · Multi-allocation evaluation (§18)

For real multi-allocation invoices, each cluster gets its own row
in the spreadsheet. Aggregate columns:

- **all_allocations_correct** = every cluster winner matches human
- **partial_correctness** = ≥1 correct, ≥1 wrong
- **wrong_allocation** = no cluster correct
- **unresolved_allocation** = ≥1 abstained
- **overall_review_state** = actual Work Intake state shown to user

Preserve MULTIPLE_RESOLVED as distinct from ambiguity.

---

## §9 · Semantic-vs-structured evidence assessment (§19)

For a representative subset (10 invoices minimum), for the winning
candidate list evidence contributions:

- **Semantic/textual:** LINE_ITEM_MATCH, ECONOMIC_PURPOSE,
  DOCUMENT_PHRASE, ONTOLOGY_NAME_MATCH, LINE_ITEM_JACCARD,
  ACCOUNT_NAME_SIMILARITY.
- **Structured accounting:** NATURE_COMPAT, ACCOUNT_ROLE_MATCH,
  CAPITAL_ASSET_MATCH, RM_EXPENSE_MATCH, **ACCOUNTING_CLASS_MATCH**,
  FS_GROUP_TAXONOMY, CATEGORY_TAXONOMY.

Report the RATIO of structured : semantic contribution for winning
candidates. Long-term target: structured evidence should dominate
once transaction meaning is established.

---

## §10 · Founder responsibility from here

You (founder) need to:

1. **Access staging** → https://staging.spectreautomation.com. Confirm
   the Work Intake UI is operational.
2. **Select the cohort** (20-50 real invoices — diverse per §3 of
   directive).
3. **Capture ground truth** (per §5 above) — this is the human
   accounting judgment that the evaluation compares against. Do this
   BEFORE looking at Spectre's outputs.
4. **Extract Spectre traces** via `inspect-wi` for each — or ask me
   to run bulk extraction against the staging DB.
5. **Compile the spreadsheet** — one row per invoice (or per cluster
   for multi-alloc).
6. **Return to me** with the compiled data. I will then produce the
   30-item Phase 7.2N checkpoint report per directive §26.

I can help mechanically at every step (bulk queries, trace parsing,
statistical rollups, R1-R9 classification, evidence-ledger table
generation). What I cannot do is decide what the correct GL account
IS for a given invoice — that's the human judgment the evaluation
measures against.

---

## §11 · Freeze / hands-off requirement

Per Founder §21: **no runtime modifications during the first cohort
run**. This means:

- No purpose cue changes
- No concept taxonomy changes
- No weight changes
- No COMMIT_MIN_SCORE changes
- No confidence changes
- No recommendation-policy changes
- No discovery-provider changes
- No tier-comparator changes
- No new commits to the AP intelligence surface until cohort measurement
  is complete

Any correction found during the cohort run gets DOCUMENTED, not
patched. The first pass measures the frozen candidate. Only after
the measurement is compiled does the founder authorise Phase 7.2O
or equivalent to address the observed gaps.

---

## §12 · Rollback plan

If staging becomes unusable (unlikely — health checks all green):

```bash
# Roll back web to v209
flyctl deploy --config deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01KZW9ER114RGPDZNRYMW32B6Q \
  --strategy immediate

# Roll back worker to v106
flyctl deploy --config deploy/fly.worker.toml --app spectre-staging-worker \
  --image spectre-staging-worker:deployment-01KZW9K85W2EJ1RRCSV8322YSK \
  --strategy immediate
```

Rollback anchors are captured in §1.

---

**Not merged. No production deploy.** Staging deployed and healthy.
Awaiting founder-provided cohort ground truth to complete the
Phase 7.2N 30-item checkpoint.
