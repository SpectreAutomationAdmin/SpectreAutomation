# v206 Paired Forensic Diagnostic — Club Support #221178 vs #200824

**Prepared:** 2026-08-15 · **Staging:** v206 (web v213 / worker v110 · commit `cbb1b52`) · **Mode:** Forensic only — no v206 modifications, no Phase 7 port, no threshold changes, no deploy.

Note on the invoice number: founder's message referenced **#220824**; the actual filename on staging is **`200824.pdf`** (extracted invoice # = `220824`, filename = `200824.pdf`). Both refer to the same real Coulee Ridge Work Intake. All references below use `#200824` for the filename and `220824` for the extracted invoice number where relevant.

---

## 1. Exact #200824 invoice contents relevant to classification

| Field | Value |
|---|---|
| WI ID | `cmstrkoyy030913qwre6er2cq` |
| Document ID | `cmstrko8t030113qw5kk5j6ev` (docIdTail `k5j6ev`) |
| Filename | `200824.pdf` (71,369 bytes) |
| Received | 2026-08-15 02:35:38 UTC (30 min after v206 deploy) |
| Extraction state | `STRUCTURED`, 1,045 text chars, rule version 8 |
| Supplier | Club Support Inc (`contactus@clubsupport.ca`, domain `clubsupport.ca`) |
| Invoice # | `220824` (note: differs from filename digits) |
| Date / Due | 2026-04-28 / 2026-04-28 |
| Subtotal / Tax / Total | $741.10 / $37.06 / **$778.16 CAD** |
| Line items | 7 |

**Line items (verbatim):**
1. `Microsoft 365 Business Standard - 1Year Commit Paid Monthly.` — qty 26, unit $17.85, amt $464.10
2. `Microsoft 365 Business Basic - 1Year Commit Paid Monthly.` — qty 5, unit $8.51, amt $42.55
3. `Microsoft 365 Business Premium - Monthly Commit.` — qty 5, unit $35.76, amt $178.80
4. `Microsoft 365 Visio Plan 2 - 1Year Commit Paid Monthly.` — qty 2, unit $21.42, amt $42.84
5. `Microsoft Entra ID P2 - 1Year Commit Paid Monthly.` — qty 1, unit $12.81, amt $12.81
6. `MS Office 365 Fees.` — qty null, amt $741.10 (summary/roll-up row)
7. `Billing Cycle: April, 2026. 8640-5` — qty null, amt $37.06 (metadata/tax line)

## 2. Human accounting interpretation

**HUMAN_CLASSIFIABLE = YES.**

This is a **Microsoft 365 SaaS subscription** invoice — recurring monthly software-as-a-service billing for productivity licenses (Business Standard × 26, Business Basic × 5, Business Premium × 5, Visio × 2, Entra ID P2 × 1) sold through Club Support Inc as reseller. Not capital, not hardware, not repair, not one-time service. Small dollar ($778.16), monthly commitment shape, all lines are software-license SKUs.

## 3. Expected GL / account family

Two defensible answers on Coulee Ridge COA (both would be founder-acceptable):
1. **`6071 Subscriptions`** — recurring subscription accounting (best functional fit; matches monthly-billing shape).
2. **`6054 Computer & IT Services`** — broader IT-services bucket (matches vendor + IT nature).

Either would be a materially correct v206 outcome. Both are present in the Coulee Ridge COA and both appear on #221178's candidate list at conf 95.

## 4. #221178 vs #200824 — extraction comparison

| Evidence | #221178 | #200824 |
|---|---|---|
| Supplier | Club Support Inc | Club Support Inc |
| Supplier domain | clubsupport.ca | clubsupport.ca |
| Supplier tax # | null | null |
| Invoice # | 221178 | 220824 |
| Invoice date | 2026-01-06 | 2026-04-28 |
| Subtotal / Tax / Total | 3,613.50 / 180.68 / **3,794.18 CAD** | 741.10 / 37.06 / **778.16 CAD** |
| Extraction state | STRUCTURED | STRUCTURED |
| Text chars | 940 | **1,045 (more, not less)** |
| Line items | 5 | 7 |
| Line-item excerpts | `Service Maintenance Fee`; `Online Backup Storage Fee`; `Online Backup License Fee: $100.00 x 2 servers = $200.00`; `Cyber Security ($17.00 x 33 users = $561.00)`; `SentinelOne Antivirus for Computers and Servers` | `Microsoft 365 Business Standard - 1Year Commit Paid Monthly`; `Microsoft 365 Business Basic - 1Year Commit Paid Monthly`; `Microsoft 365 Business Premium - Monthly Commit`; `Microsoft 365 Visio Plan 2 - 1Year Commit Paid Monthly`; `Microsoft Entra ID P2 - 1Year Commit Paid Monthly`; `MS Office 365 Fees`; `Billing Cycle: April, 2026. 8640-5` |
| Purpose-classifier cue matches | **Line 2 "Online Backup Storage Fee"** matches `\bbackup\s*storage\b`; **Line 3 "Online Backup License Fee"** matches `\bonline\s*backup\b` (both in `SOFTWARE_SUBSCRIPTION` cues at [economic-purpose-taxonomy.ts:129](src/lib/ap-intelligence/economic-purpose-taxonomy.ts#L129)) | **Zero matches** against `SOFTWARE_SUBSCRIPTION` cue regex. No line item contains "software", "SaaS", "user license", "seat license", "annual subscription", "cloud service", "monthly subscription", "online backup", "cloud backup" or any other cue in the concept vocabulary. |
| Purchased object | (not surfaced in projected response) | (not surfaced in projected response) |
| Supplier enrichment | (not surfaced) | (not surfaced) |
| Vendor history | vendor state `NOT_FOUND` — no matched Vendor record on Coulee Ridge | vendor state `NOT_FOUND` — no matched Vendor record on Coulee Ridge |
| PO | none | none |

Both invoices extract cleanly. The extraction is not the defect. **The lexical content of the line items differs materially in ways that affect downstream classification.**

## 5. Economic-purpose comparison

Direct evidence from `flyctl logs` on staging during three separate re-analyses per case, grepped by `docIdTail`:

### #221178 (`1u07nu`) — purpose classifier COMMITS
```
event: ap-intelligence.purpose-ontology.abstain
  concept: SOFTWARE_SUBSCRIPTION, clearedWinner: 6033

event: ap-intelligence.purpose-driven-ranker.promotion
  concept: SOFTWARE_SUBSCRIPTION, winner: 6071, score: 75
```
- Purpose classifier commits `SOFTWARE_SUBSCRIPTION`.
- Purpose-ontology-abstain clears base-ranker winner 6033.
- Purpose-driven-ranker fires (evidence-quality gate passes) and promotes 6071.
- GL winner (document level): `6071 Subscriptions` at conf 90.

### #200824 (`k5j6ev`) — purpose classifier DOES NOT COMMIT
```
event: ap-intelligence.analyse.complete
  extractionState: STRUCTURED, textChars: 1045, ...

event: ap-intelligence.semantic-match.override-denied
  candidate: 6065, denials: nature_confidence_below_threshold(27<40)
```
- **No `purpose-ontology.abstain` event.** (Only fires when a base winner exists to clear.)
- **No `purpose-driven-ranker.promotion` event.**
- Only downstream signal: nature-scoped promotion tried `6065` (Software Support / adjacent) and was correctly denied by `semantic-match-gate` because nature confidence 27 < threshold 40.
- Base ranker returns `candidates: []`. GL reason string: `"Ranker found no account with supporting evidence — no GL recommendation can be made from this document."`

## 6. Accounting-nature comparison

| Signal | #221178 | #200824 |
|---|---|---|
| Capital state (legacy) | OPERATING | OPERATING |
| Reconciliation | INSUFFICIENT_SIGNAL | INSUFFICIENT_SIGNAL |
| Nature confidence (via semantic-match-gate log) | (no override-denied event) | **27** (below the 40 threshold) |
| Nature defensibility | (not observable via v206 log surface) | (not observable) |

Both invoices are correctly classified as OPERATING (small-dollar, no capital-suggesting language finding on either — [both cards show `ap.invoice.operating_candidate` OBSERVED]).

## 7. Base GL ranker (`recommendGlAccount`) comparison

| | #221178 | #200824 |
|---|---|---|
| Base winner produced | `6033 R & M Preventative Maintenance` (later cleared by purpose-ontology-abstain) | **null** — no winner |
| Candidate pool size | 5+ candidates at conf 95 | **0 candidates** |
| Reason string | `purpose_driven_full_coa_search:SOFTWARE_SUBSCRIPTION(96,quality=MEDIUM)->6071(score=75,considered=79)` | `Ranker found no account with supporting evidence — no GL recommendation can be made from this document.` |
| Top-5 candidates (final projection) | 6033 R&M Preventative Maint (95), **6054 Computer & IT Services (95)**, 5016 Proshop Cost of Sales - Repairs (95), 6030 R&M - Cart Paths (94), 6031 R&M - Ground Equip (94) | (empty) |

**#221178's base ranker has many candidates because the line-item vocabulary lexically overlaps with Coulee Ridge account names** — words like "Maintenance", "Computer", "Servers", "Security" appear in both line-item descriptions AND in expense-account names (6033, 6054, 6030, 6031, 5016). The overlapping vocabulary drives `directLineMatch`, `accountNameSimilarity`, `fsGroupTaxonomySimilarity`, `categoryTaxonomySimilarity` scoring.

**#200824's base ranker has zero candidates because the invoice line-item vocabulary is BRAND-DOMINATED** — "Microsoft 365", "Business Standard", "Business Basic", "Business Premium", "Visio Plan 2", "Entra ID P2", "MS Office 365", "1Year Commit", "Paid Monthly". None of these tokens appear in any Coulee Ridge expense-account name. The base ranker's discovery mechanism relies on lexical overlap and finds none.

*(§10 arch-map component reference: [gl-recommend.ts:241](src/lib/ap-intelligence/gl-recommend.ts#L241) `recommendGlAccount` — 11-component additive scoring.)*

## 8. Complete `6054 Computer & IT Services` evidence comparison

| Property | #221178 | #200824 |
|---|---|---|
| Eligible (Phase-2 filter) | YES | YES (same COA, same eligibility gate) |
| In initial candidate pool | **YES** (conf 95) | **NO** — no direct-line, name-similarity, or taxonomy signal survives to score 6054 above the ranker floor |
| Direct-line evidence | "SentinelOne Antivirus for **Computers** and **Servers**" — "Computer" match | none — no line item mentions "computer", "IT", "service" |
| Purpose evidence | SOFTWARE_SUBSCRIPTION committed → 6054's account-name affinity kicks in via the ontology | SOFTWARE_SUBSCRIPTION not committed → no ontology contribution |
| Name/semantic evidence | "Cyber Security" + "Antivirus for Computers" → weak IT-service alignment | line items contain no IT-adjacent generic words |
| Vendor history | none (vendor NOT_FOUND) | none (vendor NOT_FOUND) |
| Supplier context | supplier name "Club Support" — doesn't itself contain "IT/Computer" | supplier name "Club Support" — same |
| Contradictions | none | none |
| Enters any recovery ranker? | Yes — purpose-driven-ranker considered 6054 (score-considered=79 accounts) but selected 6071 with higher score 75 | NO — purpose-driven-ranker does not run (see §5); nature-scoped surfaces `6065` (not `6054`) which is then correctly semantic-gate-blocked |
| Final disposition | Alternate at conf 95 (not winner; 6071 selected) | Absent from output entirely |

**Answer to the founder's clarifying question**: 6054 is not eligible-excluded, not policy-removed, not thresholded-out. **It is invisible on #200824 because the discovery mechanism never surfaces it** — no lexical bridge from the invoice's brand-dominated text to 6054's account name.

## 9. Vendor-history comparison

| | #221178 | #200824 |
|---|---|---|
| `vendorResolution.state` | `NOT_FOUND` | `NOT_FOUND` (log detail: `AMBIGUOUS`, `leaderClassification=conflicting`, `matchedWeight=91` — resolver flagged for review) |
| Matched Vendor record | none | none |
| Prior GL coding available | **none** — Club Support has no persisted Vendor row on Coulee Ridge | **none** — same |
| Prior 6054 coding enters evidence? | No — vendor-history has nothing to propagate | No |
| Vendor default account | null | null |

**Vendor history is not the defect for either invoice, and it is not the missing rescue mechanism for #200824.** Even if #221178 had been persisted with `vendorDefaultAccountId = 6054`, the founder's own principle applies: vendor history informs but does not blindly determine. On #200824 the invoice contents differ materially (recurring SaaS vs mixed IT services + backup + security), and a rigid vendor-default would be the wrong mechanism.

## 10. Downstream authority comparison

Traced from staging logs + `analyse.ts` execution order (§10 arch map):

| Stage | #221178 | #200824 |
|---|---|---|
| 1. `recommendGlAccount` (base) | 5 candidates at 95, leader 6033 | 0 candidates, leader null |
| 2. `purpose-ontology.override` | did not fire (winner not in an override path) | did not fire (no winner to override) |
| 3. `purpose-ontology.abstain` | **fired** → cleared 6033 | did not fire (no winner to clear) |
| 4. `rankPurposeDrivenAccounts` (full-COA search) | **fired** → promoted 6071 at score 75 | did not fire (see §5 — trigger conditions `winnerIsNull && purposeDecision != null && evidenceQuality.commitEligible` are only partially met; `purposeDecision` appears to be null) |
| 5. Stage-A nature promotion | not triggered | not triggered |
| 6. Stage-B nature-scoped full-COA | (no log) | surfaced candidate `6065`, denied at semantic-match-gate |
| 7. `rankCapitalAwareAccounts` | not triggered (capital=OPERATING, decision does not COMMIT to CAPITAL_CANDIDATE) | not triggered |
| 8. Slice 5.3 object-authority guard | did not fire | did not fire |
| 9. Field-quality gate | passed (winner was 6071 at that point) | passed (no winner to gate) |
| 10. Post-promotion Phase-2 eligibility | passed | did not run (no promoted winner) |
| 11. Phase-0 safety re-check | passed | passed (nothing to guard) |

## 11. The exact point #200824 loses a GL winner — FIRST DIVERGENCE

**Boundary: [economic-purpose-taxonomy.ts:124-129](src/lib/ap-intelligence/economic-purpose-taxonomy.ts#L124) — the `SOFTWARE_SUBSCRIPTION` concept's cue-regex vocabulary.**

The SOFTWARE_SUBSCRIPTION classifier cues are:
```js
/\b(software\s*(?:licen[cs]e|subscription)|saas|user\s*licen[cs]e|seat\s*licen[cs]e|annual\s*subscription|cloud\s*service|monthly\s*subscription|renewal\s*—?\s*software)\b/i
/\b(online\s*backup|cloud\s*backup|offsite\s*backup|backup\s*storage|backup\s*service|cloud\s*storage|data\s*storage|data\s*backup|hosted\s*storage)\b/i
```

- **#221178** line 2 "Online Backup Storage Fee" matches `\bbackup\s*storage\b`; line 3 "Online Backup License Fee" matches `\bonline\s*backup\b`. Multiple corroborating hits → classifier commits `SOFTWARE_SUBSCRIPTION`.
- **#200824** line items ("Microsoft 365 Business Standard - 1Year Commit Paid Monthly", "MS Office 365 Fees", "Microsoft Entra ID P2 - 1Year Commit Paid Monthly", etc.) contain zero matches. Classifier does not commit `SOFTWARE_SUBSCRIPTION`. `purposeDecision` is null (or committed to a different, non-eligible concept). Trigger for `rankPurposeDrivenAccounts` at [analyse.ts:1513](src/lib/ap-intelligence/analyse.ts#L1513) fails. Full-COA search never runs. No recovery. Winner remains null.

This is a **discovery / recall failure** at the classifier stage. The correct account exists in the COA and is eligible, but the classifier vocabulary predates SaaS-brand-dominant invoice patterns (Microsoft 365 / Google Workspace / Adobe Creative Cloud / Slack / Salesforce / etc. all sell through brand-heavy line-item text without the generic terms `software`/`SaaS`/`user license`/`subscription`).

## 12. Was a correct winner ever produced before abstention?

**NO.** The base ranker returned zero candidates. `6054 Computer & IT Services` and `6071 Subscriptions` were never scored. No downstream authority ever proposed either as a candidate. The only account any authority surfaced was `6065` (via nature-scoped Stage-B), and semantic-match-gate correctly blocked it because nature confidence 27 was legitimately below the 40 threshold — that gate did the right thing (nature signal was too weak on brand-dominated text). This is **not** a case of a valid winner being destroyed downstream. This is a case of a valid winner never being discovered.

## 13. Is thresholding involved?

**Indirectly, and not as the primary defect.** The semantic-match-gate `40` threshold ([semantic-match-gate.ts]) correctly rejected `6065` — nature confidence 27 on that candidate did not warrant a promotion. Lowering that threshold would risk laundering weak nature signal into a GL winner across many other invoices where the current threshold protects against wrong-family promotions.

**The primary defect is upstream of any threshold**: the vocabulary regex does not match brand-dominant SaaS invoices, so the purpose classifier never even commits, so purpose-driven-ranker never runs. Lowering `COMMIT_MIN_SCORE`, `MIN_RELEVANCE`, capital-commit-floor, or confidence thresholds would not surface 6054/6071 for #200824 because those accounts are not in any candidate pool. **No amount of threshold lowering fixes an empty pool.**

## 14. Is the correct account in Top 3 / Top 10 for #200824?

**NO.** Base ranker returns 0 candidates → not in Top 10, not in Top 3, not in Top 1. `6054 Computer & IT Services` and `6071 Subscriptions` are absent from every rank position.

## 15. #200824 HUMAN_CLASSIFIABLE

**YES.** A competent accountant reading the invoice would immediately identify:
- Microsoft 365 SaaS subscription (recurring monthly billing)
- Small dollar ($778.16) — operating expense, not capital
- Correct GL: 6071 Subscriptions OR 6054 Computer & IT Services

The invoice contains ample evidence of what it is; the classifier vocabulary just doesn't recognize brand-dominant SaaS terminology.

## 16. Similar failure count in sealed / staging corpus

**Sealed corpus (`tests/ap-benchmark/corpus/`):** ZERO cases in the same failure shape.
- Only software-adjacent case is `software-intangible.case.json` — a **perpetual on-premises license** with line-item text `"Member Management Suite — perpetual licence, 50-user seat"` and supplier "Clubhouse Software Systems Inc." That text matches `\bseat\s*licen[cs]e\b` and the supplier name contains "Software" — the classifier commits SOFTWARE_SUBSCRIPTION successfully.
- No Microsoft 365 / Google Workspace / Adobe Creative Cloud / Slack / Salesforce / Zoom / Dropbox / brand-dominant SaaS invoices exist in the sealed corpus. This entire failure class is untested there.

**Staging (Coulee Ridge Mission Control feed today, 9 items):** #200824 is the ONLY invoice exhibiting this failure shape. The other four AP invoices (#221178, DMM, 1091559, 1087769) all classify because their line-item text contains generic accounting-adjacent vocabulary that matches concept cues. The OXIO Internet invoice matches `INTERNET_CONNECTIVITY`, the two CPA ALBERTA invoices match `PROFESSIONAL_MEMBERSHIP`.

**Systemically, however, this failure shape represents a whole class of invoices**: any recurring SaaS billing whose line items use only brand names + plan tiers + commit terms (no generic "software", "SaaS", "subscription", "license", "cloud service"). Popular brands with this shape include Microsoft 365 / Office 365, Google Workspace, Adobe Creative Cloud, Slack, Salesforce, Zoom, Dropbox, Notion, Figma, GitHub Enterprise, and dozens of others. A Spectre tenant that uses any of these — most tech-adjacent private clubs do — will hit this failure.

## 17. First-failure category

**B — purpose-classifier recall problem.**

Specifically: the purpose classifier's `SOFTWARE_SUBSCRIPTION` cue vocabulary does not include SaaS-brand or SaaS-commitment-shape terminology. The classifier fails to identify the correct concept for brand-dominant SaaS invoices. Because the classifier doesn't commit, no downstream recovery (`rankPurposeDrivenAccounts`, `rankNatureScopedAccounts` in a purpose-informed mode, etc.) can rescue the winner.

**Not A** — the extraction succeeds (STRUCTURED, 1045 chars, 7 line items faithfully captured).
**Not C** — this is not a scoring problem; the correct account is absent from every candidate pool, not present-but-below-floor.
**Not D** — no downstream authority destroys a valid winner; there is no valid winner to destroy.
**Not E** — vendor is not persisted, so no vendor-history propagation could have helped; but vendor-history is not the missing mechanism either (the founder's own principle constrains it to inform, not determine).
**Not F** — B is sufficient; no other category is primary.

Secondary contribution: the account-name-similarity component of `recommendGlAccount` also has a related brand-vs-generic gap — accounts like `6071 Subscriptions` don't contain "microsoft", "365", or "office", so even a partial name-similarity match doesn't surface them. But this is downstream of the primary defect; fixing the classifier addresses it.

## 18. Proposed smallest systemic fix

**Two lines added to `SOFTWARE_SUBSCRIPTION` cue vocabulary at [economic-purpose-taxonomy.ts:124-129](src/lib/ap-intelligence/economic-purpose-taxonomy.ts#L124) — SaaS-commitment-shape and SaaS-plan-tier-shape general patterns, no vendor names:**

```js
concept: "SOFTWARE_SUBSCRIPTION",
cues: [
  /\b(software\s*(?:licen[cs]e|subscription)|saas|user\s*licen[cs]e|seat\s*licen[cs]e|annual\s*subscription|cloud\s*service|monthly\s*subscription|renewal\s*—?\s*software)\b/i,
  /\b(online\s*backup|cloud\s*backup|offsite\s*backup|backup\s*storage|backup\s*service|cloud\s*storage|data\s*storage|data\s*backup|hosted\s*storage)\b/i,
  /\b(?:1|2|3|multi)[-\s]?year\s+commit(?:ment)?\b/i,        // NEW — general SaaS-commitment
  /\b(?:monthly|annually?|yearly)\s+commit(?:ment)?\b/i,      // NEW — general SaaS-commitment
],
```

And **the same two patterns** added to `CONCEPT_ITEM_VOCABULARY['SOFTWARE_SUBSCRIPTION']` at [purpose-evidence-quality.ts:79](src/lib/ap-intelligence/purpose-evidence-quality.ts#L79) so the evidence-quality gate accepts the same signal.

**Why this specific fix:**
- **General, not vendor-specific** (§11 rule). "1 year commit", "monthly commit", "annual commit" are SaaS commitment-billing terminology used by Microsoft, Google, Adobe, Slack, and many others.
- **Add-only** — does not remove any existing cue.
- **Small** — 4 lines of regex source (2 file locations × 2 patterns each), maybe a dozen lines total including tests.
- **Does NOT touch threshold values** (§9 rule).
- **Does NOT touch scoring weights**.
- **Does NOT add account-specific rules**.
- **Does NOT touch v206 architecture** — no ranker changes, no new authority, no eligibility change.
- Would classify #200824 as `SOFTWARE_SUBSCRIPTION` because line item 1 ("Microsoft 365 Business Standard - 1Year Commit Paid Monthly") matches `\b1[-\s]?year\s+commit\b` AND matches `\bmonthly\s+commit\b`. That triggers `purposeDecision` != null, which triggers `rankPurposeDrivenAccounts`, which discovers `6071 Subscriptions` and/or `6054 Computer & IT Services` via full-COA search.

## 19. Expected regression surface

**Very low.**
- Sealed benchmark: 0 cases in the corpus contain "year commit" or "monthly commit" terminology (verified via `grep`). Neither existing sealed case nor its winner changes. **Expected Δ = 0 pass, 0 fail, 0 unsafe.**
- False positive risk in accounting-invoice context: minimal. "Year commit" and "monthly commit" are SaaS-billing terms; a non-software invoice with "1 year commit" would need to also contain enough SaaS-adjacent context to overpower other concept cues. In the wild, the phrase almost exclusively appears on subscription-software invoices.
- Interaction with other concepts: no overlap. The two new patterns don't collide with FUEL / LUBRICANTS / EQUIPMENT / EQUIPMENT_PARTS / REPAIR_MAINTENANCE / TELECOMMUNICATIONS / INTERNET_CONNECTIVITY / PROFESSIONAL_MEMBERSHIP / PROFESSIONAL_SERVICES / FOOD / other concept vocabularies.
- Interaction with the evidence-quality gate: symmetric change (both cue and vocabulary broadened), so gate outcomes remain internally consistent.

## 20. What the fix changes

| Component | Change |
|---|---|
| **Candidate recall** | ✓ CHANGED — purpose classifier now identifies SaaS-brand invoices; purpose-driven-ranker fires; full-COA discovery surfaces `6071` / `6054` / peers into the candidate pool. |
| **Winner selection weights** | not changed |
| **Confidence thresholds** | not changed |
| **COMMIT_MIN_SCORE / MIN_RELEVANCE / capital commit floor** | not changed |
| **Abstention rules** | not changed |
| **Structural eligibility** | not changed |
| **Account-specific rules** | not added |
| **Vendor-specific rules** | not added |

**The fix operates strictly at the recall boundary** — it changes what enters the candidate pool, not how winners are chosen from the pool. This matches the founder's principle: "First determine why the score is low." The score wasn't low; it wasn't computed. Discovery was empty.

## 21. Sealed benchmark impact expectation

**Δ = 0 pass / 0 fail / 0 unsafe.**

Verified: `grep -irE "year\s*commit|monthly\s*commit|annual\s*commit" tests/ap-benchmark/corpus/` returns zero matches. No sealed case's `source.text` contains either pattern. The two added regexes are inert on the current sealed corpus.

**Recommended before merge**: add ONE new sealed corpus case modeled on #200824 (Microsoft 365 SaaS-brand-dominant invoice, expected winner `6071` or `6054`, `HUMAN_CLASSIFIABLE=YES`) as a regression fixture. This closes the class-untested gap identified in §16.

## 22. Real-case regression set

Before authorizing the fix, verify the following on staging (all can run via authenticated Playwright, no code changes):

1. **#221178** — must remain `6054 Computer & IT Services`, Moderate·GL (baseline unchanged).
2. **DMM B0037FC** — must remain `6025 Fuel (Gas/Diesel)`, High.
3. **Oakcreek 1091559** — must remain `Equipment & Fixtures - Grounds`, Moderate·Category.
4. **Oakcreek 1087769** — must remain `6031 R & M - Ground Equip`, High.
5. **OXIO OXIO-23375874** — must remain `6072 Telephone & Internet`, Moderate·Supplier.
6. **CPA ALBERTA #1007565767** (both copies) — must remain `Multiple`, High.
7. **#200824** — target new outcome: winner ∈ {`6071 Subscriptions`, `6054 Computer & IT Services`}, confidence tier likely Moderate or High depending on purpose-driven-ranker score.

Also on the sealed benchmark: 42/17/0 (v206 baseline) must remain 42/17/0 with the same per-case winners.

## 23. Explicit recommendation

**Authorize the two-file, four-line, add-only vocabulary extension described in §18.**

This fix:
- Directly addresses the first-failure boundary identified in §11.
- Respects every constraint in the founder direction: no v206 architecture change, no Phase 7 port, no threshold change, no weight change, no account-specific rules, no vendor-specific rules, no deploy.
- Has near-zero regression surface (§19, §21).
- Fixes an entire class of invoices (any brand-dominant SaaS billing that uses commitment terminology).
- Adds one sealed corpus fixture as regression cover for the class.

**Alternative — if the founder prefers even smaller scope**: extend only `SOFTWARE_SUBSCRIPTION` cues at `economic-purpose-taxonomy.ts:124` (skip `purpose-evidence-quality.ts:79` extension). The evidence-quality gate would then need to pass via the "multiple corroborating strong evidence citations" HIGH-quality path (multiple line items with substantive content — #200824 has 5+ Microsoft 365 SKU lines). Whether that path reaches HIGH depends on how the gate scores non-discriminative-but-substantive lines; safer to extend both.

**Do NOT** authorize:
- Adding "microsoft", "office 365", or any vendor/brand-specific token (violates §11).
- Lowering `MIN_RELEVANCE`, `COMMIT_MIN_SCORE`, `capital commit floor`, `semantic-match-gate` threshold, or any confidence threshold (violates §9 without cause).
- Building any new structural gate, discovery union, canonical ranker, or Phase 7 mechanism (violates §11).
- Any vendor-history-based auto-code rule that would apply Club Support's prior 6054 blindly to future Club Support invoices (violates §6).

## 24. STOP for founder review before runtime change

**No v206 modifications applied.** No files changed under `src/`. No merge. No production deploy. Staging remains on v213 (web) / v110 (worker) — exact v206 as founder accepted in the last checkpoint.

Awaiting founder authorization to apply the §18 fix, then re-run §22 regression set.

---

## Artifacts

- `test-results/v206-paired-cs/cs221178-ap-evidence.json`
- `test-results/v206-paired-cs/cs200824-ap-evidence.json`
- `test-results/v206-paired-cs/cs221178.pdf` (real invoice bytes)
- `test-results/v206-paired-cs/cs200824.pdf` (real invoice bytes)
- `test-results/v206-paired-cs/mission-control-feed.png`
- `test-results/v206-paired-cs/cs221178-card-focused.png`
- `test-results/v206-paired-cs/cs200824-card-focused.png`
- `tests/e2e/v206-paired-cs221178-vs-cs200824.staging.spec.ts` (repeatable capture harness)

## Live log evidence (three re-analyses per case, captured 2026-08-15)

For #200824 (`k5j6ev`), every re-analysis produces the same two events and nothing else:
```
event=ap-intelligence.analyse.complete extractionState=STRUCTURED textChars=1045 capitalState=OPERATING
event=ap-intelligence.semantic-match.override-denied candidate=6065 denials=nature_confidence_below_threshold(27<40)
```

For #221178 (`1u07nu`), every re-analysis produces:
```
event=ap-intelligence.purpose-ontology.abstain concept=SOFTWARE_SUBSCRIPTION clearedWinner=6033
event=ap-intelligence.purpose-driven-ranker.promotion concept=SOFTWARE_SUBSCRIPTION winner=6071 score=75
event=ap-intelligence.analyse.complete extractionState=STRUCTURED textChars=940 capitalState=OPERATING
```

The `purpose-driven-ranker.promotion` event is deterministic evidence that the classifier committed on #221178 and did not commit on #200824.
