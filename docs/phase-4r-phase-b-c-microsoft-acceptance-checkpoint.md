# Phase 4R · Phase B v2 + Phase C — Microsoft acceptance checkpoint

**Date:** 2026-08-15  
**Author:** Claude Opus 4.7 (under founder authorization)  
**Branch:** `work-intake-state-outlook-archive-fix`  
**Commits:** `a6899f6` (Phase B v1 legacy), **`d9075f0`** (Phase B v2 primary), plus this checkpoint  
**Staging web:** v217 → **v218** (`spectre-staging:deployment-01M035BWD24JYHN9SZ5D23FMH8`)  
**Staging worker:** v114 (unchanged — no worker code touched)  
**Rollback anchors:** web v217 / `spectre-staging:deployment-01M033TNB0W40KACS72GK86R06` · worker v114 / `spectre-staging-worker:deployment-01M0345CZ89EF67DQD2NSPDN4J`

---

## 1. Root cause + Phase B v2 fix

The prior Phase B commit (a6899f6) fixed the LEGACY supplier extractor at
`src/lib/ap-intelligence/supplier-extract.ts`. That path is reached only
as a fallback; the CURRENT-runtime primary path is
`src/lib/ap-intelligence/evidence/supplier-identity.ts` +
`evidence/supplier-ranker.ts`, whose result flows through
`selectCanonicalFields` and wins over `vendorNameFromText` in
`parse-invoice.ts:857`.

The Microsoft `#E0701097E3` defect emerged from the **suffix-less
HEADER_ORG_TEXT emitter** in `supplier-identity.ts:425`. Its regex
(`HEADER_SUFFIX_LESS_LINE`) matches Title-Case / ALL-CAPS lines of 1-6
tokens; its stoplist covers column-label words but **not country /
province / state literals**. Three Sold-To / Bill-To / Service Usage
columns each ended in a bare `Canada` line, and each survived to be
emitted as a `HEADER_ORG_TEXT` candidate at confidence 78. Clustered
with the shared ADDRESS_BLOCK + PHONE_BLOCK + TAX_REGISTRATION
evidence, the identity `"canada"` scored high enough to win selection.

**Fix (commit d9075f0):** a principled `isPureGeographicPhrase(value)`
predicate lives beside the existing `isGenericLabelCandidate` in the
same module. A line whose entire content resolves to geographic
literals (COUNTRY_TOKENS ∪ CA_PROVINCE_TOKENS ∪ US_STATE_TOKENS) is
now rejected at HEADER_ORG_TEXT emission time. Legitimate legal names
that CONTAIN a geographic token (`Canada Golf Supply Inc.`,
`Alberta Equipment Ltd.`) are unaffected because they hit the
`LEGAL_SUFFIX_RE` early-continue upstream in the same loop.

- No brand / vendor / invoice-number literals
- No Microsoft-specific rule
- No Canada blacklist in winner-selection layer
- No changes to `LEGAL_ENTITY_LINE`, `ADDRESS_RE`, `TAX_REG_RE`, ranker
  scoring, GL ranking, confidence thresholds, OCR, SaaS-recall, or
  unrelated Work Intake workflow

---

## 2. Phase B validation

### 2.1 Unit + integration test set (Phase B v2)

| Suite | Result |
|---|---|
| `tests/supplier-identity-geographic-rejection.test.ts` (NEW) | **13/13 pass** |
| `tests/supplier-extract-address-vs-legal-name.test.ts` | 17/17 pass |
| `tests/phase4-slice4-supplier-identity.test.ts` | 13/13 pass |
| `tests/c15q-generalized-evaluation`, `c15q-invoice-intelligence-holdout`, `c15q-invoice-intelligence-unit`, `phase4r-supplier-and-gl-competitive` | 50/50 pass |
| `tests/ap-intelligence-parse`, `ap-intelligence-source-contract`, `phase4-slice1/2/3-extractors/cutover/evidence`, `phase4r-multi-tax-and-purpose-compatibility` | 114/114 pass |
| `tests/c15p6-vendor-resolve-unified` | **1 pre-existing** source-contract failure (looks for a variable-declaration pattern in `parse-invoice.ts` that was refactored away before this branch; confirmed via `git stash` A/B) |
| **Typecheck** | Clean |

### 2.2 Sealed AP benchmark

Identical to pre-Phase-B baseline:

| Metric | Pre (16:22) | Post (16:48) |
|---|---|---|
| Cases | 43 | 43 |
| Pass · Partial · Fail | 12 · 5 · 26 | 12 · 5 · 26 |
| Unsafe recommendations | 0 | 0 |
| Supplier accuracy | 40/43 (93.0 %) | 40/43 (93.0 %) |
| GL Top-1 | 18/43 (41.9 %) | 18/43 (41.9 %) |

### 2.3 §B7 Microsoft live acceptance (staging v218)

`GET /api/mission-control/work-intake/cms0l576g00017d6viorrz0rh/ap-evidence`

| Field | Pre (v217) | Post (v218) |
|---|---|---|
| `guessedName` | `"Canada"` | **`"Microsoft Corporation"`** |
| `guessedTaxNumber` | `135625069RT0001` | `135625069RT0001` |
| `vendorResolution.state` | `AMBIGUOUS` | **`MATCHED`** |
| Matched vendor id | — | `cms4461to0002gypwkbhl8n67` |
| Matched vendor legal name | — | `Microsoft Corporation` |
| Match signals | 8 | **9** (added `country`) |
| `glRecommendation.accountNumber` | 6062 Licenses | **6062 Licenses** (unchanged) |
| `capitalRecommendation.state` | OPERATING | OPERATING |
| `invoiceNumber` | E0701097E3 | E0701097E3 |
| Subtotal / Tax / Total | — / — / 31.29 CAD | 29.80 / 1.49 / **31.29 CAD** |

### 2.4 §B8 real regression set (staging v218)

Spec: `tests/e2e/phase-4r-phase-b-v2-regression-set.staging.spec.ts`

| Case | Supplier | Vendor | Invoice # | Total | GL | Capital | Verdict vs baseline |
|---|---|---|---|---|---|---|---|
| cs200824 (Club Support) | Club Support Inc | NOT_FOUND | 220824 | $778.16 CAD | 6071 Subscriptions | OPERATING | ✓ unchanged |
| cs221178 (Club Support) | Club Support Inc | NOT_FOUND | 221178 | $3,794.18 CAD | 6071 Subscriptions | OPERATING | ✓ unchanged |
| dmm B0037FC | DMM ENERGY INC | NOT_FOUND | B0037FC | $2,532.92 CAD | 6025 Fuel (Gas/Diesel) | OPERATING | ✓ unchanged |
| oak 1091559 | Oakcreek Golf & Turf LP | NOT_FOUND | 1091559-00 | $77,833.35 CAD | 1506 Equipment & Fixtures – Grounds | AMBIGUOUS | ✓ unchanged |
| oak 1087769 | Oakcreek Golf & Turf LP | NOT_FOUND | 1087769-00 | $1,056.22 CAD | 6031 R & M – Ground Equip | OPERATING | ✓ unchanged |
| OXIO (DOM) | OXIO | vendor match required | OXIO-23375874 | $40.32 CAD | Telephone & Internet | — | ✓ unchanged |
| CPA Alberta primary (DOM) | CPA ALBERTA | vendor match required | 1007565767 | $1,420.50 CAD | Multiple | — | ✓ unchanged |
| CPA Alberta KTVD dup (DOM) | CPA ALBERTA | vendor match required | 1007565767 | $1,420.50 CAD | Multiple | — | ✓ unchanged |

No fixture regressed. No `Canada` appeared anywhere as a supplier.
No GL account moved. Zero material regression.

---

## 3. Phase C — Microsoft end-to-end acceptance

### 3.1 §C1 Pre-completion sanity

Spec: `tests/e2e/phase-4r-phase-c-microsoft-active-shape.staging.spec.ts`

- Card DOM title: **"Microsoft Corporation invoice #E0701097E3 — $31.29 CAD · Licenses"**
- Vendor link → `/app/admin/ap/vendors/cms4461to0002gypwkbhl8n67/timeline` (existing Microsoft Vendor row)
- Amount readout: `$31.29 CAD` · Invoice: `#E0701097E3` · Category: `Licenses` · Confidence: `High`
- Primary CTA label: `Review coding` (test-id `ap-action-primary`)
- **No `Create vendor & post` CTA present** (§C1 hard requirement satisfied)

Observed footnote: workflow pill reads `Needs judgment` and recommendation
reads `Supplier identity is not resolved to sufficient confidence.` while
the API's `vendorResolution.state = MATCHED`. This is a projection /
workflow-decision divergence not in Phase B/C scope — flagged for a
separate slice. The CVAP modal opens on Step 1 (Vendor profile) as a
consequence, but the founder-facing path completes without creating a
new vendor (see §3.2).

### 3.2 §C2 Complete via UI/API path

Spec: `tests/e2e/phase-4r-phase-c-microsoft-e2e-completion.staging.spec.ts`

Founder-facing click walk (destructive, live staging):

1. Click `Review coding` primary → CVAP modal opens
2. Modal opens on `Vendor profile` (Step 1)
3. Modal presents `Microsoft Corporation` as an existing match chip
4. Test picks the chip → `vendorMode` flips to `USE_EXISTING`
5. Step 1 primary label = **"Use selected vendor"** — proves no
   duplicate Microsoft Vendor will be created
6. Click Step 1 primary → advances to `Review and post invoice` (Step 2)
7. Preview loads + balances → `cvap-post-invoice` becomes enabled
8. Post button label = **"Post & clear work item"**
9. Click Post → success confirmation:
   > "Invoice posted · **AP-2026-000001** · Journal entry balanced and
   > Work Intake item cleared. Source email queued for archive."
10. Archive-status attr = **`QUEUED`**
11. Reload feed → Microsoft cards remaining in Active view = **0**

Posting outcome:
- New AP invoice `AP-2026-000001` created
- Journal entry balanced + posted
- Work Intake `cms0i8qlp0013nc7oo377f1rl` marked RESOLVED (via
  `emitWorkCompletionEvent` inside `postApInvoiceAction`)
- No new Microsoft Vendor created — existing Vendor
  `cms4461to0002gypwkbhl8n67` reused

### 3.3 §C3-C4 Snapshot frozen + Completed History render

Spec: `tests/e2e/phase-4r-phase-c-microsoft-completed-history.staging.spec.ts`

Completed History card DOM (`/app/admin?view=history`):

| Field | Value | Source |
|---|---|---|
| Title | Microsoft Corporation invoice #E0701097E3 — $31.29 CAD · Licenses | snapshot |
| Work summary | Full sentence including "Matched to Spectre vendor Microsoft Corporation. Prepared a proposed entry to post $31.29 CAD to GL 6062 Licenses." | snapshot |
| Amount | $31.29 CAD | snapshot |
| Invoice | #E0701097E3 | snapshot |
| Category | Licenses | snapshot |
| Workflow pill | **Ready for approval** (Active was "Needs judgment") | snapshot |
| Recommendation | **Posted via Mission Control** (Active was "Supplier identity is not resolved to sufficient confidence.") | snapshot |

The pill + recommendation flip (Active → Completed) is direct evidence
that `readCompletedCardFacts` is returning `source="frozen"` and
`overlayCardSnapshotOnInvoiceSummary` is being applied. If the live
analyser were being re-run, the pill would still read "Needs judgment".

### 3.4 §C5 Immutability

- **Staging UI proof**: pill/recommendation flip described in §3.3 —
  the Completed History card is reading the frozen `cardSnapshot`, not
  the live analyser output.
- **Automated proof**: `tests/work-intake-completed-immutability.test.ts`
  (Phase A) — 15/15 pass. Simulates live-analyser drift and confirms
  Completed History still renders the frozen approved snapshot.

### 3.5 §C6 Outlook lifecycle

| Gate | Status | Evidence |
|---|---|---|
| WorkCompletionEvent emitted | ✅ | `postApInvoiceAction` calls `emitWorkCompletionEvent` inside post-commit; return payload contained `lifecycle.emailArchive.status = QUEUED` |
| Archive mutation created | ✅ | modal DOM `data-archive-status="QUEUED"`; success text: "Source email queued for archive." |
| Archive mutation succeeded | ⚠️ pending verification | See note below |
| Source email removed from Inbox | ⚠️ pending verification | See note below |

**Note on §C6 gates 3–4:** the staging worker's MAILBOX_DELTA_SYNC
jobs are currently failing MSAL token refresh for every observed
mailbox connection with `AADSTS9002313: Invalid request. Request is
malformed or invalid.` (msalSubError `bad_token`). This is a
pre-existing Outlook OAuth-infrastructure defect on staging affecting
ALL Microsoft mailbox operations — it predates and is unrelated to
Phase B / Phase C. The MAILBOX_ARCHIVE_MESSAGE job was successfully
enqueued (`QUEUED`); worker execution is subject to the same MSAL
issue and could not be verified from the log window available in this
session. The founder should either verify the Coulee Ridge intake
mailbox in Outlook directly, or authorise a separate ticket to refresh
staging mailbox tokens before closing this gate.

---

## 4. Files changed this checkpoint

Code:
- `src/lib/ap-intelligence/evidence/supplier-identity.ts` — added
  `isPureGeographicPhrase` predicate + geographic-token rejection at
  the suffix-less HEADER_ORG_TEXT emitter (commit d9075f0)

Tests:
- `tests/supplier-identity-geographic-rejection.test.ts` — 13 new unit
  tests (commit d9075f0)
- `tests/e2e/phase-4r-phase-b-v2-regression-set.staging.spec.ts` — §B8
- `tests/e2e/phase-4r-phase-c-microsoft-active-shape.staging.spec.ts` — §C1
- `tests/e2e/phase-4r-phase-c-microsoft-e2e-completion.staging.spec.ts` — §C2/C4/C6
- `tests/e2e/phase-4r-phase-c-microsoft-completed-history.staging.spec.ts` — §C3-C5

Docs:
- `docs/phase-4r-phase-b-c-microsoft-acceptance-checkpoint.md` (this
  file)

---

## 5. Remaining lifecycle gaps

1. **Outlook archive execution + Inbox verification** (§C6 gates 3–4)
   pending on the pre-existing staging-worker MSAL refresh defect.
2. **Card-projection vs API-vendor-match divergence**: `vendorMatch.state=MATCHED`
   at the API layer but the projected `workflowState=NEEDS_JUDGMENT`
   with recommendation `"Supplier identity is not resolved to sufficient
   confidence."` The primary CTA still says "Review coding" but the
   modal opens on Step 1 — a UI-consistency defect that did NOT block
   Phase C completion but should be tracked separately.
3. **AP child WI status**: the child AP-intake WI
   `cms0l576g00017d6viorrz0rh` remains `intake.status=OPEN` after
   completion; the parent EMAIL WI `cms0i8qlp0013nc7oo377f1rl` is the
   one that flipped RESOLVED and left the Active feed. Expected shape
   for this lifecycle but worth noting.

## 6. Rollback

If Phase B v2 needs to be rolled back:
```
flyctl deploy -c deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01M033TNB0W40KACS72GK86R06
```
Revert commit d9075f0 on the branch. Legacy Phase B v1 fix (a6899f6)
can also be reverted separately if desired.
