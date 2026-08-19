# Microsoft "Canada" Supplier Regression — 30-Item §10 Forensic Checkpoint

**Prepared:** 2026-08-15 · **Branch:** `work-intake-state-outlook-archive-fix` (docs+test only) · **Staging:** web v215 / worker v112 unchanged. **No code changes. No DB mutation. No deploy. No supplier-classifier changes. No completion-snapshot work.** Preserving the fixture exactly as founder observed it.

Founder correction (2026-08-15): the previous checkpoint's conclusion "Microsoft item not reproducible on staging" is superseded. The founder had manually moved the Microsoft item from Completed History back to Active via the Restore action. It is now visible in the ACTIVE feed on staging v215.

---

## 1. Exact Microsoft WorkIntakeItem ID

Two linked WIs are involved:

- **`cms0i8qlp0013nc7oo377f1rl`** — the EMAIL WI (classification = `INVOICE_LIKELY`). Subject "Invoice #93458725404" from "Chris Turcato". Originally RESOLVED 2026-07-28 03:48:55 UTC (that's the "Completed History" state the founder saw historically). **RESTORED to OPEN 2026-08-15 14:24:14 UTC (~30 min before I began tracing).** This is the WI the founder reopened.
- **`cms0l576g00017d6viorrz0rh`** — the AP intake WI (classification = `AP_INVOICE_REVIEW`). Title "93458725404.pdf" (`displaySender = "Accounts payable"` — a constant, not the real sender). Never RESOLVED. Status has been OPEN since 2026-07-25 16:30. This is the WI whose LINKED intelligence produces the founder-facing card values (supplier / invoice # / amount / GL) via `apIntakeSourcesForCanonical`.

## 2. Document / email / attachment IDs

- **IngestedDocument:** `cms0i8v540045nc7o4icv5ldp` — filename `93458725404.pdf`, byteLength **234,684**, sha256 `693f4db31734587b...`.
- **EmailMessage graphMessageId:** `AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0Ardd-dRWR00WxuT03NOeYXwAAAV7HPwAA` (from `MATERIALISED` activity note on the email WI).
- **EmailAttachment:** underlying attachment of the above email.
- **Downloaded PDF:** `test-results/microsoft-forensic/ap-intake-93458725404-doc.pdf` (234,684 bytes on disk; sha256 matches).

## 3. Lifecycle timeline

| Timestamp (UTC) | Event | Actor | Payload |
|---|---|---|---|
| 2026-07-25 15:09:16 | Email WI materialised | mailbox worker | "Invoice #93458725404" from Chris Turcato |
| 2026-07-25 16:30:30 | AP intake WI materialised | ap-intelligence worker | attached 93458725404.pdf, `analysisRunId:...:2026-07-25T16:30:29.979Z · +3 findings` |
| 2026-07-28 03:46:20 | **Microsoft Vendor row created** | founder user `cmrvdenz700034437agp7gqs5` | `legalName="Microsoft Corporation"`, address One Microsoft Way / Redmond / WA / 98052 / United States, tax# `135625069RT0001`, phone `+1 (800) 865-9408`, website `https://aka.ms/Office365Billing`. Vendor CREATE was manual via the Create Vendor & Post modal. |
| 2026-07-28 03:48:55 | **Email WI RESOLVED** | founder user | `status="RESOLVED"`, `resolvedAt` set. Historical Completed History card showed "Microsoft Corporation" as supplier. |
| 2026-08-05 23:28:59 | AP intake re-analysed | ap-intelligence worker | `analysisRunId:...:2026-08-05T23:28:59 · +1/~1/-2`, analysisVersion `ap-v1:extract=4:supplier=3:lines=3:tax=2:ids=1:purpose=1:gl=3` |
| **2026-08-15 14:24:14** | **Email WI RESTORED** | founder user | `status="OPEN"`, `resolvedAt/resolvedByUserId PRESERVED`, `WorkRestorationEvent` row `cmsugvpud01lpcwfau27nwnn7` written, activity `RESTORED (RESOLVED → OPEN)` |
| 2026-08-15 15:12+ | Live ap-evidence recomputes | founder page loads | Every list-view render since restore runs `analyseIngestedInvoice` fresh under current v206 classifier vocab; supplier extraction now returns `"Canada"` (see §11) |

**Zero WorkCompletionEvent rows for this WI on staging today** — the completionEvents relation on both `cms0i8qlp` and `cms0l576g` is empty. That means when the founder resolved the WI 2026-07-28 the `emitWorkCompletionEvent` wiring was not yet in place (Checkpoint 16H landed 2026-08-04). No archive job ever ran. No completion metadata was captured. **This confirms `RESOLVED` completions from pre-16H persist NOTHING beyond `resolvedAt` + `resolvedByUserId`.**

## 4. Current status

- Email WI `cms0i8qlp` — **status = OPEN** (restored). `resolvedAt` still `2026-07-28T03:48:55.694Z` (preserved). `resolvedByUserId` still set.
- AP intake WI `cms0l576g` — **status = OPEN** (never resolved).

## 5. Previous completion state

- Email WI was RESOLVED 2026-07-28 03:48:55 by founder user.
- No `WorkCompletionEvent` row (predates 16H wiring).
- No `AuditLog` row for `entityType="WorkIntakeItem"` at that time (verified — see §19).
- Only surviving persisted evidence: `WorkIntakeActivity` MATERIALISED row + (after restore) `RESTORED` activity + `WorkRestorationEvent`.
- Microsoft Vendor row was created ~2m30s BEFORE the WI was resolved — the founder's flow was likely: open the Create Vendor & Post modal → create Vendor → click Post/Resolve on the card. But no `APInvoice` was written, so it was either "Resolve" (dismiss) rather than "Post", OR the flow was interrupted/bypassed.

## 6. Raw PDF supplier / header / address text

`pdftotext -layout` output of the source `93458725404.pdf`:

```
                                                                                                                          Invoice
                                                                                                                                               July 2026
                                                                                                                            Invoice Date: 2026-07-22
                                                                                                                       Invoice Number: E0701097E3
                                                                                                                                Due Date: 2026-07-22
                                                                                                                                   31.29 CAD

Sold-To                                 Bill-To                               Service Usage Address
Spectre Automation
1515 25th Ave SW                        Spectre Automation                    Spectre Automation
Calgary ab T2T 0Z7                      1515 25th Ave SW                      1515 25th Ave SW
Canada                                  Calgary ab T2T 0Z7                    Calgary ab T2T 0Z7
                                        Canada                                Canada

Order Details
                                                             Billing Summary
Product:
Customer PO Number:    Online Services                       Charges:                                                  29.80
Order Number:                                                                                                           0.00
Billing Period:                                              Discounts:                                                 0.00
Due Date:                                                                                                               1.49
                       103851cc-2dea-42be-b32b-64fceed2e42f  Credits:                                                   0.00
Payment Instructions:
                       2026-07-21 - 2026-07-21               GST/HST:                                                  31.29
                       2026-07-22                            QST/PST:
                                                             Total:

                       Please DO NOT PAY. You will be charged the amount due through your selected method of payment.

                       Billing or service question? Call 1-800-865-9408 or visit https://aka.ms/Office365Billing
                                  Microsoft Corporation, One Microsoft Way, Redmond, WA 98052, United States
                                                  GST/HST 135625069RT0001 QST 1015764658TQ0002
                                                                                                                                                          1/2
```

Critical observations:
- **Three side-by-side RECIPIENT address blocks** (Sold-To / Bill-To / Service Usage Address) each ending with a bare `Canada` line. `Canada` appears at column position ~40, 80, 130 respectively.
- **The actual SUPPLIER identity appears only ONCE**, in the page footer as a comma-separated single line: `Microsoft Corporation, One Microsoft Way, Redmond, WA 98052, United States`.
- **The supplier tax registration** (`GST/HST 135625069RT0001 QST 1015764658TQ0002`) appears on the line immediately below the Microsoft footer.
- Product mention `Microsoft 365 Business Premium` appears on page 2 in the line-item area.

## 7. All supplier candidates (from current live analysis)

The projected ap-evidence response does not expose the candidate list; the runtime `extractSupplier` returns them internally but only the leader is persisted. From `analysis.extraction.vendor`:
- **Winning `guessedName = "Canada"`**
- Guessed tax number: **`135625069RT0001`** (Microsoft Corporation's real GST/HST number)
- Guessed email: null
- Guessed domain: null

The tax number the extractor found IS Microsoft's — proving the extractor DID find the supplier's tax registration line. But the extracted `guessedName` is "Canada", which cannot be co-located with Microsoft's tax number in the source PDF (the tax number appears on the line adjacent to `Microsoft Corporation, ...`, not adjacent to a `Canada` line).

## 8. Candidate scores / evidence

Not exposed by the ap-evidence route (see §7). To reveal the internal candidate list + scores would require either instrumenting `extractSupplier` to log its full candidate array or projecting it onto `ApAnalyseResult` — **explicitly out of scope for this diagnostic** per the founder's constraint "No supplier-classifier changes".

However, the extractor's scoring model at [supplier-extract.ts:307-437](src/lib/ap-intelligence/supplier-extract.ts) awards points for:
- `corp_suffix` (+15)
- `issuer_language` (+20)
- `adjacent_remittance` (+22)
- `adjacent_tax_id` (+18)
- `adjacent_address` (+10)
- `issuer_header` (+5, only if in top 15% of page)
- `repeat_across_pages` (+8)

Negative signals: `recipient_context` (heavy negative), `person_name_shape` (-8 unless strong org signal), `member_context` (-8).

The `Microsoft Corporation` supplier candidate at the page footer would score at minimum: corp_suffix (+15) + adjacent_tax_id (+18) = 33, minus `issuer_header` (missing — line is at bottom of page not top).

The `Canada` bare-word line, if it survives filtering, cannot score corp_suffix on its own (CORP_SUFFIX_RE requires a `[A-Z][A-Za-z0-9&.,'\-\s/]{2,60}?\s+Canada` prefix). Something else in the extractor produces `guessedName = "Canada"` — see §21 for the hypothesis.

## 9. Current supplier extraction winner

**`guessedName = "Canada"`**, source likely `invoice_document`.

Confirmed via live `analyseIngestedInvoice` re-invoked at ap-evidence GET time (2026-08-15 15:12+). This is CURRENT v206 output (with the SaaS-recall + Work Intake state-derivation fixes deployed). The result is deterministic — repeated GETs return the same value.

## 10. Current guessedName

`"Canada"` — literally the string `Canada`, no address prefix, no country designator. Reads to a human as the country name from the recipient address block.

## 11. Current analyseIngestedInvoice supplier

`analysis.extraction.vendor.guessedName = "Canada"` (see §9). `analysis.vendor.state = "AMBIGUOUS"` with **one match candidate** — Microsoft Corporation — matched on 8 structural signals: `taxRegistrationNumber, phone, website, addressLine1, postalCode, city, provinceState, country`.

Vendor matching correctly identifies Microsoft Corporation from the STRUCTURED fields (the extraction found the phone `+1 (800) 865-9408`, website `https://aka.ms/Office365Billing`, address `One Microsoft Way`, city `Redmond`, province `WA`, postal `98052`, country `United States`, tax# `135625069RT0001` — all match the Vendor row). But it returns AMBIGUOUS instead of MATCHED, because vendor-match probably requires a name-similarity floor and `guessedName="Canada"` is nowhere close to `Vendor.legalName="Microsoft Corporation"`.

## 12. Current card-projection supplier

Founder-facing card renders `guessedName = "Canada"` as the supplier line per prior §12 audit — `EmailIntakeCard.tsx:1098` reads `ap.vendorMatch.matchedName ?? ap.extractedVendor.name`. Since vendor state is AMBIGUOUS (not MATCHED), `matchedName` is null; falls through to `extractedVendor.name` which is `extraction.vendor.guessedName = "Canada"`.

`ap.vendorMatch.state = "AMBIGUOUS"` is treated by the card as "no matching vendor record" per the founder's observation "the card says: 'No matching vendor record exists'" — the copy for AMBIGUOUS matches the copy for NOT_FOUND in the recommendation strip.

## 13. Exact source of "Canada"

**The extractor's raw text stream splits the multi-column recipient address block by column, producing lines where `Canada` appears alone.** With `pdftotext -layout` I get row-aligned columns; without layout preservation, PDF text extraction typically reads column-by-column top-to-bottom, producing:

```
Sold-To
Spectre Automation
1515 25th Ave SW
Calgary ab T2T 0Z7
Canada           ← bare line
Bill-To
Spectre Automation
...
Canada           ← bare line
Service Usage Address
Spectre Automation
...
Canada           ← bare line
```

The v206 `extractSupplier` at [supplier-extract.ts:192-333](src/lib/ap-intelligence/supplier-extract.ts#L192) iterates lines. For a bare `Canada` line:
- `EMAIL_RE`, `ID_ISH_RE`, `DATE_ISH_RE`, `MONTH_RE`, `ADDRESS_LINE_RE` — none match a bare `Canada` (no digits, no postal-code pattern, no Suite/PO Box).
- `LABEL_TAIL_RE`, `FORM_HEADER_RE` — do not match.
- Money-line filter (line 229-230), letters-ratio filter (line 232-233), person-with-credential (line 241) — do not fire.
- **Word-count minimum at line 252-253:** `wordCount < 2 && !CORP_SUFFIX_RE.test(line)` — for `Canada` alone, `wordCount = 1` and `CORP_SUFFIX_RE.test("Canada")` — this regex REQUIRES a `[A-Z][A-Za-z0-9&.,'\-\s/]{2,60}?\s+Canada` prefix, so does NOT match a bare `Canada`. Therefore the line SHOULD be skipped here.

Yet the extractor's output IS `guessedName = "Canada"`. So one of these must be true:

- **(a)** The extractor's raw text does NOT actually split into bare `Canada` lines — the PDF text extractor concatenates the column row `Canada  Calgary ab T2T 0Z7  Calgary ab T2T 0Z7`. That line has 3 words, CORP_SUFFIX_RE could match: `Canada  Calgary ab T2T 0Z7 ...` — let me test: `^\s*([A-Z][A-Za-z0-9&.,'\-\s/]{2,60}?\s+(?:...|Canada|...)\.?)(?:\b|,|\s|$)` — from `Canada  Calgary ab T2T 0Z7 Calgary ab T2T 0Z7`, the regex tries `[A-Z]` = `C`, then `[A-Za-z0-9&.,'\-\s/]{2,60}?` = at least 2 chars — the very first suffix candidate `\s+Canada` fires. Wait — the regex needs `\s+` BEFORE a suffix word. Position 0 is `C`, next positions are `anada`, then `  Calgary`... the FIRST `\s+` is the 2-space between `Canada` and `Calgary`. So the regex would consume `[A-Z][A-Za-z0-9&.,'\-\s/]{2,60}?` = `Canada` (chars 0-5) then `\s+` = spaces (chars 6-7) then needs `(?:...|Canada|Alberta|Ontario|...|Regional)` — the next word is `Calgary` which is NOT in the suffix alternation. Match fails.

- **(b)** The extractor's line-splitting produces `Calgary ab T2T 0Z7 Canada` or similar concatenated shape where `Canada` appears at the end after a prefix. Test: for `Calgary ab T2T 0Z7 Canada`:
  - `[A-Z]` matches `C`
  - `[A-Za-z0-9&.,'\-\s/]{2,60}?` non-greedy matches `algary ab T2T 0Z7 ` (up to just before `Canada`)
  - `\s+` matches (actually `\s+` in the regex — but `[A-Za-z0-9&.,'\-\s/]` INCLUDES `\s` so the lazy match could consume the space too... but `\s+` after is required)
  - Actually, considering non-greediness: shortest match. `[A-Z]` = `C`, then `[A-Za-z0-9&.,'\-\s/]{2,60}?` minimum 2 chars = `al`, then needs `\s+` — but position after `Cal` is `g`, not `\s`. So it extends until it hits `\s`. `Calgary` = 7 chars, then space = `\s+`. Then `(?:...|Canada|...)` — next word is `ab` — NOT in alternation. Match fails.
  - Actually regex engine backtracks. `[A-Za-z0-9&.,'\-\s/]{2,60}?` can extend to include more characters, then try `\s+` at a later position. Eventually it could match `[A-Z]` = `C`, `[A-Za-z0-9&.,'\-\s/]{2,60}?` = `algary ab T2T 0Z7`, `\s+` = ` `, `(?:...|Canada|...)` = `Canada`. **Match succeeds.** Capture group `[1]` = `Calgary ab T2T 0Z7 Canada`.
  - Then `value = suffixHit[1].trim() = "Calgary ab T2T 0Z7 Canada"`. Then normalizeName is applied.

Wait — `guessedName = "Canada"` — a single word. Not the full match. There must be a normalization step that trims to the suffix word.

Actually looking at line 326:
```typescript
candidates.push({
  value: (suffixHit ? suffixHit[1] : line).trim(),
  normalized: norm ?? line.toLowerCase(),
  ...
});
```

`value = suffixHit[1]` which is the ENTIRE capture group, not just the suffix. So `value` would be `"Calgary ab T2T 0Z7 Canada"` NOT `"Canada"`.

Hmm. So `guessedName = "Canada"` alone must come from a different pathway. Possibilities:

- **(c)** The extractor's raw text HAS a bare `Canada` line, and CORP_SUFFIX_RE actually matches bare `Canada` in some edge case (regex ambiguity with `\b` boundary).
- **(d)** There's a downstream normalization/trimming that reduces "Calgary ab T2T 0Z7 Canada" to just "Canada" (the suffix word).
- **(e)** The extractor produces multiple candidates and a downstream tiebreaker selects `Canada` specifically.
- **(f)** The extraction result is NOT from `extractSupplier` — some other code path produces `guessedName` (e.g., `field-quality` gate, `evidence/supplier-identity`, or `canonicalSupplierIdentity`).

Without instrumenting the extractor at runtime (out of scope per §10), I cannot pin (a-f) definitively. **What is definitively confirmed: the current v206 supplier extraction pipeline produces `guessedName = "Canada"` for this exact PDF.** The specific line of code responsible is one of the candidate-value assignments in `extractSupplier` OR a downstream normalization in `evidence/supplier-identity.ts` or `canonicalSupplierIdentity`.

## 14. Whether 15Q is actually active on this path

**PARTIALLY active but not effective for this shape.**

15Q's `ADDRESS_LINE_RE` at [supplier-extract.ts:161](src/lib/ap-intelligence/supplier-extract.ts#L161) matches:
- `^\s*\d+\s+\w` (numbered street: `1515 25th Ave SW`) ✓ — rejects the address street line
- `^\s*(?:Suite|Unit|Apt|Bldg|Floor|Level|Ste)\s*\.?\s*\d+` — no Suite prefix here
- `^\s*PO Box\b` — no
- `^\s*\d{5}(?:-\d{4})?` — no US ZIP
- `^\s*[A-Z]\d[A-Z]\s*\d[A-Z]\d` — Canadian postal `T2T 0Z7` — WAIT, does `Calgary ab T2T 0Z7` match? The regex starts at `^\s*` then requires `[A-Z]\d[A-Z]`. `Calgary` starts with `C` (letter), not the postal-code pattern. **No match** — the postal-code pattern must be at the start of the line, but the line starts with `Calgary`.

So the address-recognition guard misses the `Calgary ab T2T 0Z7 Canada` line because the Canadian postal code doesn't appear at position 0 — it's mid-line after `Calgary ab`. **The 15Q fix only anchors `^\s*[A-Z]\d[A-Z]\s*\d[A-Z]\d` at line-start, not anywhere in the line.** This class of address lines slips through.

## 15. Why Microsoft Corporation loses

Three hypotheses (all could contribute):
- **(H1)** The `Microsoft Corporation, One Microsoft Way, Redmond, WA 98052, United States` line, being ~30 lines deep in the extracted text (page footer), does not score `issuer_header` (top 15%). It DOES score `corp_suffix` + `adjacent_tax_id` (~33 points).
- **(H2)** A `Canada`-derived candidate (via one of pathways (a)-(f) in §13) scores enough — corp_suffix (+15) + adjacent_address (+10) + possibly issuer_header (+5, top 15% since Bill-To block is on page 1) = up to 30 points. If Microsoft's line loses `adjacent_tax_id` because there's a small gap in the text-extraction ordering, Microsoft's total drops.
- **(H3)** A normalization step trims Microsoft's `Corporation` suffix down to just the leading word or trims the full match to its suffix, producing a shorter candidate name.

Without instrumenting the extractor at runtime, these hypotheses cannot be pinned. **The measurable fact is:** the extractor's leader `.value` is `"Canada"` (or something normalized to `"Canada"`) and the extractor's alternates are not exposed in the projected ap-evidence.

## 16. Existing Microsoft Vendor fields

Complete row (unchanged since 2026-07-28 creation):

```
id:                     cms4461to0002gypwkbhl8n67
clubId:                 cmrvdeny7000144372ktmmg9c  (Coulee Ridge)
vendorNumber:           V-2026-000002
legalName:              Microsoft Corporation
operatingName:          null
status:                 ACTIVE
taxRegistrationNumber:  135625069RT0001
taxRegion:              null
email:                  null
phone:                  +1 (800) 865-9408
website:                https://aka.ms/Office365Billing
address1:               One Microsoft Way
address2:               null
city:                   Redmond
provinceState:          WA
postalCode:             98052
country:                United States
notes:                  null
createdAt:              2026-07-28T03:46:20.988Z
updatedAt:              2026-07-28T03:46:20.988Z
approvedAt:             null
approvedByUserId:       null
createdByUserId:        cmrvdenz700034437agp7gqs5  (founder)
defaultExpenseAccountId: null
defaultTaxCodeKey:      null
```

**Vendor row is intact.** The name never changed to "Canada" in persistence.

## 17. Vendor-match candidate trace

`vendorResolution` in the ap-evidence response:

```
state:      AMBIGUOUS
candidates: [
  {
    id:            cms4461to0002gypwkbhl8n67
    legalName:     "Microsoft Corporation"
    operatingName: null
    matchSignals:  [
      "taxRegistrationNumber",   ← tax# 135625069RT0001 matches Vendor's tax#
      "phone",                    ← +1 (800) 865-9408 matches
      "website",                  ← https://aka.ms/Office365Billing matches
      "addressLine1",             ← One Microsoft Way matches
      "postalCode",               ← 98052 matches
      "city",                     ← Redmond matches
      "provinceState",            ← WA matches
      "country"                   ← United States matches
    ]
  }
]
```

**Eight structural signals converge on Microsoft Corporation.** The extraction found ALL of them from the PDF text. The vendor matcher correctly nominates Microsoft as the only candidate — this is a strong, unambiguous match by any human standard.

## 18. Why existing Microsoft Vendor is not MATCHED

Despite 8 signals to a single candidate, vendor state = `AMBIGUOUS` not `MATCHED`. The most likely reason: the vendor-match gate requires the extracted supplier NAME to align with the candidate's legalName (an anti-mismatch guard). Because `guessedName = "Canada"` bears zero string similarity to `"Microsoft Corporation"`, the gate refuses to elevate AMBIGUOUS → MATCHED despite the other 8 signals.

**Trace evidence:** the candidate signals list contains `taxRegistrationNumber, phone, website, addressLine1, postalCode, city, provinceState, country` — 8 signals — but does NOT include `legalName` / `operatingName` / `nameSimilarity`. The name axis is missing, and that's the exact axis the state-decision gate hinges on.

**Root cause hierarchy:** `Canada` extraction → causes name-similarity gate to fail → vendor stays AMBIGUOUS → card shows "No matching vendor record exists" and displays the extracted `guessedName="Canada"` as the supplier line. **The vendor-matcher does not have an independent defect** — it does exactly what it should when a rogue supplier extraction is fed in. If `guessedName` were `"Microsoft Corporation"` or `null`, the 8 structural signals would very likely lift the state to MATCHED.

## 19. Historical evidence — Microsoft Corporation result recoverable?

**Very limited.** Searched:
- `WorkCompletionEvent` — none for either WI (predates 16H wiring on 2026-08-04).
- `WorkIntakeActivity` — `MATERIALISED` + (post-restore) `RESTORED (RESOLVED → OPEN)`. No supplier value captured on either activity row.
- `AuditLog` — no rows for `entityType="WorkIntakeItem"` / `entityId=cms0i8qlp...` on 2026-07-28. Vendor CREATE would have written an audit row for `entityType="Vendor"` — that's the only surviving 2026-07-28 audit artefact from this session.
- `APInvoice` — zero rows for Microsoft vendor. The founder did not post an accounting transaction.
- `WorkIntakeFinding` — findings are attached to the AP intake (`cms0l576g`) which was NEVER resolved. The findings from the 2026-07-25 first analysis (`+3 findings`) and 2026-08-05 re-analysis (`+1/~1/-2`) do not include a supplier snapshot.
- Application logs — Fly logs beyond 24 hours are typically rotated out; the 2026-07-28 window is not accessible via `flyctl logs` today.
- Prior Playwright captures / test-results — no committed screenshots on this branch history reference the Microsoft item.

**Conclusion:** the historical "Microsoft Corporation" display shown to the founder in Completed History cannot be recovered from any persistent record. The Vendor row IS the strongest surviving evidence — `legalName="Microsoft Corporation"` — but that only proves what the user SAW when they created the vendor, not what the card displayed at the moment of resolution.

## 20. Behavior caused by Completed → Active reopening

Source: [src/lib/work-intake/actions.ts:133-178](src/lib/work-intake/actions.ts#L133) `restoreIntake`.

**Actual behaviour (verified from source + confirmed on the RESTORED row):**
- Sets `WorkIntakeItem.status = "OPEN"`
- **Preserves** `resolvedAt` and `resolvedByUserId` — explicit comment lines 153-155: "NEVER clear resolvedAt / resolvedByUserId — those preserve the original completion record. Restoration is a separate event, not a rewrite of history."
- Adds `WorkIntakeActivity` row: `action="RESTORED", fromValue="RESOLVED", toValue="OPEN", note="Restored to Work Intake Feed"`
- Creates `WorkRestorationEvent` row with `priorCompletionEventId` pointing to the most recent `WorkCompletionEvent` (null in this case because none exist)
- **Does NOT** delete `WorkCompletionEvent`
- **Does NOT** move the archived Outlook message back to Inbox — explicit comment lines 122-125: "Archived Outlook messages are NOT moved back to Inbox in this checkpoint. Sent replies are NOT re-sent. Posted AP invoices are NOT reversed."
- **Does NOT** trigger reanalysis
- **Does NOT** invalidate any cache
- **Does NOT** resurrect original persisted findings (they were never deleted; they persist on the WI regardless)
- **Does NOT** call analyseIngestedInvoice
- **Does NOT** mutate APInvoice or posting state

The next time the founder loads the Mission Control page, the WI renders in Active. The card projection runs `analyseIngestedInvoice` fresh under current v206 vocabulary — which now returns `guessedName="Canada"`. The historical "Microsoft Corporation" display is lost not because restoration destroyed anything, but because the projection was never immutable and there was no snapshot to fall back on.

**`restoreIntake` is well-behaved.** The founder's regression is not a restoration defect. Restoration correctly preserves audit history — the failure is upstream in the classifier + downstream in the always-live projection.

## 21. First-failure boundary

**Case A + G composite.** Ranked in order of contribution:

- **PRIMARY (Case A):** Current v206 `extractSupplier` at [supplier-extract.ts:192-333](src/lib/ap-intelligence/supplier-extract.ts#L192) genuinely selects `"Canada"` (or a normalized-to-Canada value) for this PDF's text stream. The 15Q address-line guard at line 161 does NOT protect against Canadian postal codes that appear mid-line after a city name (`Calgary ab T2T 0Z7`) — only against postal codes at line-start.
- **SECONDARY (Case F, downstream amplifier):** vendor-match gate refuses to elevate AMBIGUOUS → MATCHED without name-similarity, even though 8 structural signals converge on the only candidate. If the extractor produced `null` or the correct name, the match would resolve.
- **TERTIARY (Case G, projection-immutability):** Completed History card reads live extraction on every render — so any classifier evolution after completion silently rewrites the historical card. Confirmed by prior audit.

## 22. Failure classification

- Not OCR/extraction failure — the PDF text is faithfully extracted (all Microsoft address fields survive to `analysis.vendor.matchSignals`).
- **Candidate-generation failure** ✓ — the extractor generates `Canada` as a supplier candidate when it should not.
- **Address segmentation failure** ✓ — multi-column Sold-To/Bill-To blocks are not recognised as recipient territory; the extractor's `collectRecipientRanges` at line 187 either doesn't catch this shape or catches only the header. `Canada` lines slip through.
- **Candidate-scoring failure** ✓ — even if `Canada` becomes a candidate, it should score below `Microsoft Corporation`. It does not.
- Not a supplier/vendor distinction failure per se — but the vendor-match name-similarity gate is a downstream amplifier.
- **Vendor-match failure (secondary)** — AMBIGUOUS with 8 signals to a single candidate is not a MATCHED verdict; the name-axis veto is over-strict when the other axes are unanimous.
- **Stale-data / projection failure (parallel)** ✓ — the completed card had no snapshot. Any classifier change post-completion mutates the historical display.

## 23. Smallest systemic supplier correction (NOT IMPLEMENTED — awaiting §9 authorisation)

Two orthogonal repairs, both address-shape-general, no vendor/brand/account/country literals:

**Repair 1 — Broaden `ADDRESS_LINE_RE` to reject any line containing a Canadian postal code, US ZIP, or country-token at ANY position (not just line-start):**
- Change: replace the `^\s*` anchor with `\b` for the postal / country tokens; require `\s+Canada\s*$` at end-of-line to also count as an address line.
- Effect: `Calgary ab T2T 0Z7 Canada` matches address rejection; excluded from candidate generation.
- Risk: false-positive rejection of legitimate supplier names ending in `Canada` (e.g. `TELUS Canada`). Mitigation: only reject when the line ALSO contains a postal-code shape OR the line contains a numbered street prefix. Two-signal requirement.

**Repair 2 — Tighten `CORP_SUFFIX_RE` region-qualifier arm to require a non-region-word prefix:**
- Change: split the alternation into strong-suffix (`Corporation, Corp, Company, Co, Inc, ..., Group, Holdings`) and weak-region-qualifier (`Alberta, Ontario, ..., Canada, USA, ...`). A weak-region-qualifier alone does NOT make the line a corp_suffix candidate — it must be preceded by a strong-suffix ONE-CHAR ancestor OR combined with at least one other positive signal (adjacent_tax_id / adjacent_remittance / issuer_language).
- Effect: bare `Canada` or `Calgary ab T2T 0Z7 Canada` no longer scores `corp_suffix`. `Microsoft Corporation` still scores. `TELUS Canada` still scores if issuer-language / remittance / tax-id backs it.
- Risk: false-negative on `X Canada` name shapes that had no other positive signals. Manageable via test corpus.

**Repair 3 (defence-in-depth on vendor matcher) — allow MATCHED when structural signals ≥ N without a name axis:**
- Change: raise vendor state to `MATCHED` when `matchSignals.length >= 5` even if name-similarity is low. Currently AMBIGUOUS.
- Rationale: `taxRegistrationNumber + phone + website + address + postalCode + city + provinceState + country` all matching a single Vendor row is a stronger identity signal than the extracted supplier name alone.
- Risk: creates a false-positive vendor match if extraction hallucinates a coincidental tax# + address. Mitigation: require `taxRegistrationNumber` OR `website` as one of the ≥5 signals (identity-anchoring fields).

Both Repair 1 and Repair 2 are candidate-recall-affecting classifier changes — must be gated on sealed-benchmark regression check.

**No implementation this diagnostic.**

## 24. Regression-test design

**Fixture 1 — the exact 93458725404.pdf** — kept as a sealed corpus regression case. Expected:
- `guessedName = "Microsoft Corporation"` OR `null` (extractor can honestly abstain when it can't decide)
- `vendorResolution.state = MATCHED` when `guessedName` cleanly resolves; OR `AMBIGUOUS` with clear candidate list
- `gl.accountNumber = 6062` (unchanged — Licenses correctly identified regardless of supplier)
- Card `Category = Licenses`, Confidence = High or Moderate·Supplier, supplier surface = `Microsoft Corporation` or a truthful abstain marker.

**Fixture 2 — brand-agnostic multi-column Sold-To/Bill-To template.** Generic supplier name (`Cloud Services Corp`), Canadian recipient address ending in `Canada`, supplier line at bottom of page.

**Fixture 3 — inverse: US supplier, US recipient, `United States` country tokens on both sides.** Verify the country token doesn't produce `guessedName = "United States"`.

**Fixture 4 — legitimate `X Canada` supplier** (e.g. `TELUS Canada Communications Inc.`). Verify Repair 2 doesn't over-reject — corp_suffix still fires via `Inc`.

**Fixture 5 — supplier line only in fine-print footer** (like Microsoft's `Microsoft Corporation, One Microsoft Way, ..., United States`). Verify extractor can score bottom-of-page supplier candidates.

Add all five to `tests/ap-benchmark/corpus/`. Sealed-benchmark verifies no regression on the current 43-case corpus.

## 25. Revised completed-state immutability recommendation

Prior §22 recommendation stands, refined by this fixture:

- **Slice 1** (readCompletedCardFacts wrapper, no user-visible change) — REQUIRED regardless of classifier repair.
- **Slice 2** (POST snapshot) — REQUIRED for POSTED-AND-CLEARED items.
- **Slice 3** (RESOLVED snapshot) — REQUIRED. Without it, the founder's Microsoft-shape regression will happen every time a classifier improves.
- **Slice 4** (read frozen when snapshot present) — REQUIRED. First user-visible slice.

**New consideration from this fixture — REOPENED lifecycle:** when a WI is RESTORED from a completed state, the reopened active card should NOT silently mutate the historical snapshot. Options:
- (a) Keep the snapshot; render active card via live analysis; both are simultaneously visible via a "historical / current" toggle when applicable.
- (b) Freeze the reopen event separately (`WorkRestorationEvent.priorSnapshot`) so the completion record and the reopen-analysis are both preserved.
- (c) Both — historical snapshot persists on `WorkCompletionEvent.metadataJson.cardSnapshot`; reopened active card runs live; if the user resolves again a NEW `WorkCompletionEvent` is written with its own snapshot.

Recommendation: **(c) — historical snapshot ALWAYS survives; reopened active card renders live; each RESOLVE writes a NEW completion event with its own snapshot.** Preserves full audit trail.

## 26. POSTED vs RESOLVED vs REOPENED lifecycle recommendation

| Transition | Contract |
|---|---|
| **POSTED_AND_CLEARED** | Accounting facts become immutable (APInvoice + APInvoiceLine + JournalEntry). Also write `WorkCompletionEvent.metadataJson.cardSnapshot`. Also add `APInvoice.vendorDisplayNameAtPost` (defence-in-depth vs Vendor rename). |
| **RESOLVED without posting** | Only durable capture is `WorkCompletionEvent.metadataJson.cardSnapshot` — no APInvoice exists. Snapshot content composed from the exact `ApInvoiceCardIntelligence` the founder was looking at when they clicked Resolve. |
| **SUPPRESSED (duplicate)** | Not a founder action; done automatically by `email-materializer.ts:490-505` when a duplicate-conversation intake is merged. Should write a completion event with `completionType="SUPPRESSED_AS_DUPLICATE"` and a snapshot from the canonical intake at time of merge. Currently does neither. |
| **REOPENED (restore)** | Preserve the prior `WorkCompletionEvent` and its snapshot. Add `WorkRestorationEvent` (already does this). Active card renders live intelligence. If the founder resolves again, write a NEW `WorkCompletionEvent` — Card History surface shows the chain: completion → restoration → completion. |

## 27. Can existing persisted records be authoritative?

- **POSTED:** yes for accounting facts (APInvoice + APInvoiceLine + Vendor.legalName currently, + `vendorDisplayNameAtPost` after Slice 5). No for confidence tier, category label, workflow-state-at-post — need snapshot.
- **RESOLVED without posting:** no — nothing captures card content today. `WorkIntakeActivity.note` is optional free-form. `WorkCompletionEvent.metadataJson` was empty on pre-16H completions and empty on RESOLVED even today. Snapshot is required.
- **SUPPRESSED (duplicate):** no — no completion event or snapshot exists. Would be authored fresh on the SUPPRESSED transition.
- **REOPENED:** the WorkRestorationEvent captures who/when. Prior completion (if any) is preserved. But without Slice 2/3 the prior completion has no snapshot either.

**For the founder's Microsoft item specifically:** the closest surviving authority is `Vendor.legalName = "Microsoft Corporation"` on the Vendor row created 2026-07-28 03:46 — 2.5 minutes before the WI was resolved. That's the strongest evidence of what the founder saw at completion. But no accounting record was posted, so there's no accounting-truth authority.

## 28. Whether cardSnapshot is still required

**YES — required.** This fixture PROVES it. The Microsoft/Canada regression is exactly the drift class snapshot capture is designed to prevent. Any subsequent classifier improvement will silently mutate historical cards without the snapshot.

Approach unchanged from prior §22: extend `WorkCompletionEvent.metadataJson` with a `cardSnapshot` sub-object. No new table.

## 29. Migration / backfill implications

- **POSTED WIs:** backfill from `APInvoice + APInvoiceLine + Vendor + Account` (per prior recommendation). Safe.
- **RESOLVED without posting (this fixture's class):** **CANNOT be backfilled** without live re-analysis, and live re-analysis by definition produces the current (wrong) result. Options:
  - (a) Backfill with a "historical projection — snapshot unavailable" marker; card shows live analysis flagged as "historical proxy".
  - (b) Backfill using `Vendor.legalName` when a vendor row was created within N seconds of the resolve — treat that as the founder's approved supplier. Would restore Microsoft Corporation on this specific fixture.
  - (c) Do not backfill; forward-fix only.
- **Founder's Microsoft item specifically:** if the founder authorises approach (b), the vendor-creation-adjacency heuristic would set `cardSnapshot.supplierDisplayName = "Microsoft Corporation"` for `cms0i8qlp` at completion time (Vendor created 03:46:20, WI resolved 03:48:55 — 2m35s apart). This ONLY works because a Vendor was created; for future RESOLVED-without-Vendor completions the heuristic doesn't help.
- **Recommendation:** (a) as the safe default. Offer (b) as a targeted backfill script the founder can review case-by-case.

## 30. Recommended implementation sequence

Do NOT implement without founder authorization. The sequence:

1. **Preserve this fixture.** `cms0l576g00017d6viorrz0rh` and the source PDF are the golden test case for both the supplier-extraction repair AND the completion-immutability slice. Do not resolve, do not modify, do not delete.

2. **Founder decides the ordering:**
   - **Immutability-first (recommended):** Slices 1-4 land first. Historical cards frozen. Then when Repair 1/2 land later, historical cards are protected from the classifier change.
   - **Classifier-first:** Repair 1 or 2 lands first. Historical cards would then re-render with the corrected extraction — for Microsoft this would either fix it (if the corrected extractor returns "Microsoft Corporation") or worsen it (if extractor abstains and there's no snapshot to fall back on).

3. **Sequence:**
   - Slice 1: `readCompletedCardFacts` narrowing wrapper (no user change) — ships alone.
   - Slice 2: POSTED snapshot capture in `WorkCompletionEvent.metadataJson.cardSnapshot` — ships alone.
   - Slice 3: RESOLVED snapshot capture (opt-in via optional arg from Mission Control API) — ships alone.
   - Slice 4: Read-path uses frozen snapshot when present — first user-visible slice.
   - Slice 5: `APInvoice.vendorDisplayNameAtPost String?` — Prisma migration, `accounting-workflows` review.
   - Slice 6: POSTED backfill script (dry-run staging → real staging → founder approval before production).
   - Slice 7: Supplier-extraction Repair 1 (address-line-mid-line postal-code rejection) — gated on sealed benchmark + fixture 1-5 regression.
   - Slice 8: Supplier-extraction Repair 2 (region-qualifier-alone rejection) — gated on same.
   - Slice 9: Vendor-match name-veto relaxation (Repair 3) — gated on real-COA regression.
   - Slice 10: Diagnostic replay surface (SUPER_ADMIN-gated route) for historical re-evaluation.

4. **Do NOT during any slice:**
   - Vendor allowlists / brand-specific rules
   - Country blacklists
   - Microsoft-specific / Office-365-specific rules
   - Post-hoc mutation of existing completions
   - Deletion of any WorkIntakeActivity or WorkCompletionEvent row
   - Any change without a targeted test suite + sealed-benchmark check

---

## Compliance summary vs founder direction

| Constraint | Status |
|---|---|
| STOP before #220824 acceptance | ✓ |
| Preserve Microsoft Work Intake exactly | ✓ — no writes to any WI row |
| No code changes | ✓ |
| No database mutation | ✓ |
| No staging deploy | ✓ |
| No production deploy | ✓ |
| No supplier-classifier changes | ✓ |
| No completion-snapshot implementation | ✓ |
| Diagnose before touching supplier intelligence or completion immutability | ✓ (this document) |

**Awaiting founder review of PART 1-9 findings + ordering / scope authorization per §30.**

## Artifacts

- `test-results/microsoft-forensic/ap-intake-93458725404-ap-evidence.json` — full ap-evidence dump for `cms0l576g`
- `test-results/microsoft-forensic/ap-intake-93458725404-doc.pdf` — source PDF (234,684 bytes, sha256 `693f4db31734587b`)
- `test-results/microsoft-forensic/ap-intake-93458725404-doc-metadata.json` — document metadata
- `test-results/microsoft-forensic/feed-full.png` — Mission Control feed screenshot with the restored Microsoft card visible
- `test-results/microsoft-forensic/e0701097e3-card.png` — focused card crop
- `tests/e2e/microsoft-forensic-trace.staging.spec.ts` — repeatable read-only trace harness (never mutates)
- `tests/e2e/completed-history-audit.staging.spec.ts` — Completed History enumeration harness
- Prior diagnostic: `docs/phase-4r-work-intake-completed-immutability-diagnostic.md`
