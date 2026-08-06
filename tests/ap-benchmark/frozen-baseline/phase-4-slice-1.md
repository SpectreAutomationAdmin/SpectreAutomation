# AP Intelligence Benchmark — ap-bench-2026-08-06T05-21-40-208Z-p0on-p2on

| | |
|---|---|
| Corpus | `v1-2026-08-06` |
| Phase 0 containment | `ENABLED` |
| Started | 2026-08-06T05:21:40.209Z |
| Finished | 2026-08-06T05:21:45.862Z |
| Cases | 17 (pass 7 · partial 0 · fail 10 · n/a 0) |
| Unsafe recommendations | **0** |
| Correct abstention on unreadable | 5 |
| False abstention | 0 |
| Latency p50 / p95 (ms) | 58 / 187 |

## Per-dimension

| Dimension | Pass | Fail | Partial | N/A | Avg score |
|---|---:|---:|---:|---:|---:|
| `abstention` | 5 | 0 | 0 | 0 | 1.000 |
| `currency` | 14 | 1 | 0 | 0 | 0.933 |
| `gl-forbidden` | 17 | 0 | 0 | 0 | 1.000 |
| `gl-top1` | 11 | 6 | 0 | 0 | 0.647 |
| `gl-top3` | 6 | 8 | 0 | 0 | 0.429 |
| `invoiceNumber` | 15 | 0 | 0 | 0 | 1.000 |
| `subtotal` | 14 | 0 | 0 | 0 | 1.000 |
| `supplier` | 15 | 0 | 0 | 0 | 1.000 |
| `taxTotal` | 14 | 0 | 0 | 0 | 1.000 |
| `total` | 14 | 1 | 0 | 0 | 0.933 |
| `vendorMatch` | 3 | 2 | 0 | 0 | 0.600 |
| `workflow-false-auto` | 17 | 0 | 0 | 0 | 1.000 |
| `workflow-false-ready` | 17 | 0 | 0 | 0 | 1.000 |
| `workflowState` | 17 | 0 | 0 | 0 | 1.000 |

## Case results

### DMM Energy — dyed low-sulphur diesel · Québec French headers
- Split: `dev` · Category: `FUEL_INVOICE` · Overall: **FAIL** · Latency: 187 ms
- Supplier: `DMM Energy Inc`
- Invoice #: `B0037FC`
- Total: `2532.92 CAD`
- GL Top-1: `(abstained) ` (confidence: `null`)

| Dimension | Verdict | Reason |
|---|---|---|
| `supplier` | PASS | Extracted supplier matched an acceptable alias. |
| `invoiceNumber` | PASS | Extracted invoice number matched expected exactly. |
| `subtotal` | PASS | subtotal matched within tolerance. |
| `taxTotal` | PASS | taxTotal matched within tolerance. |
| `total` | PASS | total matched within tolerance. |
| `currency` | PASS | Currency matched. |
| `vendorMatch` | PASS | Vendor state matched expected. |
| `gl-top1` | FAIL | No Top-1 recommendation; expected one of [5310, 5311, 5320]. |
| `gl-top3` | FAIL | No Top-3 candidate in acceptable set. |
| `gl-forbidden` | PASS | Top-1 did not land on a forbidden account. |
| `workflowState` | PASS | Workflow state matched expected. |
| `workflow-false-ready` | PASS | No false-ready state. |
| `workflow-false-auto` | PASS | No auto-approval eligibility declared (correct for Coulee Ridge — no policy). |

### Capital irrigation pump — text-layer PDF
- Split: `dev` · Category: `CAPITAL_INVOICE` · Overall: **FAIL** · Latency: 185 ms
- Supplier: `Northside Course Maintenance Inc.`
- Invoice #: `INV-2026-9010`
- Total: `11235.00 CAD`
- GL Top-1: `6020 Grounds Maintenance` (confidence: `95`)

| Dimension | Verdict | Reason |
|---|---|---|
| `supplier` | PASS | Extracted supplier matched an acceptable alias. |
| `invoiceNumber` | PASS | Extracted invoice number matched expected exactly. |
| `subtotal` | PASS | subtotal matched within tolerance. |
| `taxTotal` | PASS | taxTotal matched within tolerance. |
| `total` | PASS | total matched within tolerance. |
| `currency` | PASS | Currency matched. |
| `vendorMatch` | PASS | Vendor state matched expected. |
| `gl-top1` | FAIL | Top-1 6020 not in acceptable set [1530, 1540]. |
| `gl-top3` | FAIL | No Top-3 candidate in acceptable set. |
| `gl-forbidden` | PASS | Top-1 did not land on a forbidden account. |
| `workflowState` | PASS | Workflow state matched expected. |
| `workflow-false-ready` | PASS | No false-ready state. |
| `workflow-false-auto` | PASS | No auto-approval eligibility declared (correct for Coulee Ridge — no policy). |

### Monthly maintenance service — operating expense with vendor default GL
- Split: `dev` · Category: `OPERATING_INVOICE` · Overall: **FAIL** · Latency: 84 ms
- Supplier: `Northside Course Maintenance Inc`
- Invoice #: `INV-2026-9011`
- Total: `472.50 CAD`
- GL Top-1: `6020 Grounds Maintenance` (confidence: `95`)

| Dimension | Verdict | Reason |
|---|---|---|
| `supplier` | PASS | Extracted supplier matched an acceptable alias. |
| `invoiceNumber` | PASS | Extracted invoice number matched expected exactly. |
| `subtotal` | PASS | subtotal matched within tolerance. |
| `taxTotal` | PASS | taxTotal matched within tolerance. |
| `total` | PASS | total matched within tolerance. |
| `currency` | PASS | Currency matched. |
| `vendorMatch` | FAIL | Vendor state AMBIGUOUS did not match expected MATCHED. |
| `gl-top1` | PASS | Top-1 in acceptable set. |
| `gl-top3` | PASS | At least one Top-3 candidate in acceptable set. |
| `gl-forbidden` | PASS | Top-1 did not land on a forbidden account. |
| `workflowState` | PASS | Workflow state matched expected. |
| `workflow-false-ready` | PASS | No false-ready state. |
| `workflow-false-auto` | PASS | No auto-approval eligibility declared (correct for Coulee Ridge — no policy). |

### Vague email body carrying a real invoice — attachment authority
- Split: `dev` · Category: `ATTACHMENT_AUTHORITY` · Overall: **FAIL** · Latency: 72 ms
- Supplier: `Oakcreek Golf & Turf LP`
- Invoice #: `1091559-00`
- Total: `81725.02 CAD`
- GL Top-1: `(abstained) ` (confidence: `null`)

| Dimension | Verdict | Reason |
|---|---|---|
| `supplier` | PASS | Extracted supplier matched an acceptable alias. |
| `invoiceNumber` | PASS | Extracted invoice number matched expected exactly. |
| `subtotal` | PASS | subtotal matched within tolerance. |
| `taxTotal` | PASS | taxTotal matched within tolerance. |
| `total` | PASS | total matched within tolerance. |
| `currency` | PASS | Currency matched. |
| `vendorMatch` | PASS | Vendor state matched expected. |
| `gl-top1` | PASS | Correctly abstained. |
| `gl-top3` | FAIL | No Top-3 candidate in acceptable set. |
| `gl-forbidden` | PASS | Top-1 did not land on a forbidden account. |
| `workflowState` | PASS | Workflow state matched expected. |
| `abstention` | PASS | Correctly abstained. |
| `workflow-false-ready` | PASS | No false-ready state. |
| `workflow-false-auto` | PASS | No auto-approval eligibility declared (correct for Coulee Ridge — no policy). |

### HTML newsletter with no attachment — must NOT route to AP
- Split: `dev` · Category: `INFORMATIONAL_EMAIL` · Overall: **PASS** · Latency: 42 ms
- Supplier: `Weekly Club Update — Course news for the week.`
- Invoice #: `(none)`
- Total: `(none) `
- GL Top-1: `(abstained) ` (confidence: `0`)

| Dimension | Verdict | Reason |
|---|---|---|
| `gl-top1` | PASS | Correctly abstained. |
| `gl-forbidden` | PASS | Top-1 did not land on a forbidden account. |
| `workflowState` | PASS | Workflow state matched expected. |
| `abstention` | PASS | Correctly abstained. |
| `workflow-false-ready` | PASS | No false-ready state. |
| `workflow-false-auto` | PASS | No auto-approval eligibility declared (correct for Coulee Ridge — no policy). |

### Unreadable / empty extraction — must abstain
- Split: `dev` · Category: `UNREADABLE` · Overall: **PASS** · Latency: 32 ms
- Supplier: `(none)`
- Invoice #: `(none)`
- Total: `(none) `
- GL Top-1: `(abstained) ` (confidence: `0`)

| Dimension | Verdict | Reason |
|---|---|---|
| `gl-top1` | PASS | Correctly abstained. |
| `gl-forbidden` | PASS | Top-1 did not land on a forbidden account. |
| `workflowState` | PASS | Workflow state matched expected. |
| `abstention` | PASS | Correctly abstained. |
| `workflow-false-ready` | PASS | No false-ready state. |
| `workflow-false-auto` | PASS | No auto-approval eligibility declared (correct for Coulee Ridge — no policy). |

### Vendor statement of account — must NOT create AP invoice
- Split: `dev` · Category: `STATEMENT` · Overall: **FAIL** · Latency: 32 ms
- Supplier: `Oakcreek Golf & Turf LP`
- Invoice #: `STMT-2026-08-1091559`
- Total: `(none) `
- GL Top-1: `(abstained) ` (confidence: `null`)

| Dimension | Verdict | Reason |
|---|---|---|
| `supplier` | PASS | Extracted supplier matched an acceptable alias. |
| `invoiceNumber` | PASS | Extracted invoice number matched expected exactly. |
| `total` | FAIL | No total extracted; expected 78889.57. |
| `currency` | FAIL | Currency (none) did not match expected CAD. |
| `gl-top1` | PASS | Correctly abstained. |
| `gl-forbidden` | PASS | Top-1 did not land on a forbidden account. |
| `workflowState` | PASS | Workflow state matched expected. |
| `abstention` | PASS | Correctly abstained. |
| `workflow-false-ready` | PASS | No false-ready state. |
| `workflow-false-auto` | PASS | No auto-approval eligibility declared (correct for Coulee Ridge — no policy). |

### Fuel invoice mentioning "purchase order" — CAPITAL_ASSET nature trap
- Split: `dev` · Category: `FUEL_INVOICE` · Overall: **PASS** · Latency: 58 ms
- Supplier: `Grande Prairie Petroleum Inc`
- Invoice #: `GPP-2026-4471`
- Total: `1416.45 CAD`
- GL Top-1: `5310 Fuel — Grounds Equipment` (confidence: `95`)

| Dimension | Verdict | Reason |
|---|---|---|
| `supplier` | PASS | Extracted supplier matched an acceptable alias. |
| `invoiceNumber` | PASS | Extracted invoice number matched expected exactly. |
| `subtotal` | PASS | subtotal matched within tolerance. |
| `taxTotal` | PASS | taxTotal matched within tolerance. |
| `total` | PASS | total matched within tolerance. |
| `currency` | PASS | Currency matched. |
| `gl-top1` | PASS | Top-1 in acceptable set. |
| `gl-top3` | PASS | At least one Top-3 candidate in acceptable set. |
| `gl-forbidden` | PASS | Top-1 did not land on a forbidden account. |
| `workflowState` | PASS | Workflow state matched expected. |
| `workflow-false-ready` | PASS | No false-ready state. |
| `workflow-false-auto` | PASS | No auto-approval eligibility declared (correct for Coulee Ridge — no policy). |

### Vendor default expense = contra-asset — Phase 0 must suppress
- Split: `dev` · Category: `PATHOLOGICAL` · Overall: **FAIL** · Latency: 45 ms
- Supplier: `Legacy Copier Service Ltd`
- Invoice #: `LCS-2026-01`
- Total: `367.50 CAD`
- GL Top-1: `(abstained) ` (confidence: `null`)

| Dimension | Verdict | Reason |
|---|---|---|
| `supplier` | PASS | Extracted supplier matched an acceptable alias. |
| `invoiceNumber` | PASS | Extracted invoice number matched expected exactly. |
| `subtotal` | PASS | subtotal matched within tolerance. |
| `taxTotal` | PASS | taxTotal matched within tolerance. |
| `total` | PASS | total matched within tolerance. |
| `currency` | PASS | Currency matched. |
| `vendorMatch` | FAIL | Vendor state AMBIGUOUS did not match expected MATCHED. |
| `gl-top1` | PASS | Correctly abstained. |
| `gl-top3` | FAIL | No Top-3 candidate in acceptable set. |
| `gl-forbidden` | PASS | Top-1 did not land on a forbidden account. |
| `workflowState` | PASS | Workflow state matched expected. |
| `abstention` | PASS | Correctly abstained. |
| `workflow-false-ready` | PASS | No false-ready state. |
| `workflow-false-auto` | PASS | No auto-approval eligibility declared (correct for Coulee Ridge — no policy). |

### Diesel fuel invoice + Jonas-convention accum-depr accounts (ASSET/DEBIT) on the seed COA
- Split: `dev` · Category: `STRUCTURAL_GAP_MEASUREMENT` · Overall: **PASS** · Latency: 70 ms
- Supplier: `Grande Prairie Petroleum Inc`
- Invoice #: `GPP-2026-4499`
- Total: `2236.50 CAD`
- GL Top-1: `5310 Fuel — Grounds Equipment` (confidence: `95`)

| Dimension | Verdict | Reason |
|---|---|---|
| `supplier` | PASS | Extracted supplier matched an acceptable alias. |
| `invoiceNumber` | PASS | Extracted invoice number matched expected exactly. |
| `subtotal` | PASS | subtotal matched within tolerance. |
| `taxTotal` | PASS | taxTotal matched within tolerance. |
| `total` | PASS | total matched within tolerance. |
| `currency` | PASS | Currency matched. |
| `gl-top1` | PASS | Top-1 in acceptable set. |
| `gl-top3` | PASS | At least one Top-3 candidate in acceptable set. |
| `gl-forbidden` | PASS | Top-1 did not land on a forbidden account. |
| `workflowState` | PASS | Workflow state matched expected. |
| `workflow-false-ready` | PASS | No false-ready state. |
| `workflow-false-auto` | PASS | No auto-approval eligibility declared (correct for Coulee Ridge — no policy). |

### Adversarial: CAPITAL nature + accum-depr account with strong semantic hits (Jonas convention)
- Split: `dev` · Category: `ADVERSARIAL_CAPITAL` · Overall: **FAIL** · Latency: 53 ms
- Supplier: `Prairie Computer Equipment Co.`
- Invoice #: `PCE-2026-1188`
- Total: `17430.00 CAD`
- GL Top-1: `(abstained) ` (confidence: `null`)

| Dimension | Verdict | Reason |
|---|---|---|
| `supplier` | PASS | Extracted supplier matched an acceptable alias. |
| `invoiceNumber` | PASS | Extracted invoice number matched expected exactly. |
| `subtotal` | PASS | subtotal matched within tolerance. |
| `taxTotal` | PASS | taxTotal matched within tolerance. |
| `total` | PASS | total matched within tolerance. |
| `currency` | PASS | Currency matched. |
| `gl-top1` | FAIL | No Top-1 recommendation; expected one of [1506, 1530, 1540]. |
| `gl-top3` | FAIL | No Top-3 candidate in acceptable set. |
| `gl-forbidden` | PASS | Top-1 did not land on a forbidden account. |
| `workflowState` | PASS | Workflow state matched expected. |
| `workflow-false-ready` | PASS | No false-ready state. |
| `workflow-false-auto` | PASS | No auto-approval eligibility declared (correct for Coulee Ridge — no policy). |

### Mixed-tax invoice — GST + PST
- Split: `validation` · Category: `OPERATING_INVOICE` · Overall: **FAIL** · Latency: 58 ms
- Supplier: `Prairie Turf Supplies Ltd`
- Invoice #: `PTS-2026-33421`
- Total: `1125.60 CAD`
- GL Top-1: `(abstained) ` (confidence: `null`)

| Dimension | Verdict | Reason |
|---|---|---|
| `supplier` | PASS | Extracted supplier matched an acceptable alias. |
| `invoiceNumber` | PASS | Extracted invoice number matched expected exactly. |
| `subtotal` | PASS | subtotal matched within tolerance. |
| `taxTotal` | PASS | taxTotal matched within tolerance. |
| `total` | PASS | total matched within tolerance. |
| `currency` | PASS | Currency matched. |
| `gl-top1` | FAIL | No Top-1 recommendation; expected one of [6020, 6025]. |
| `gl-top3` | FAIL | No Top-3 candidate in acceptable set. |
| `gl-forbidden` | PASS | Top-1 did not land on a forbidden account. |
| `workflowState` | PASS | Workflow state matched expected. |
| `workflow-false-ready` | PASS | No false-ready state. |
| `workflow-false-auto` | PASS | No auto-approval eligibility declared (correct for Coulee Ridge — no policy). |

### CPA professional membership dues — must NOT auto-code as grounds/fuel/capital · PASS
_Holdout case — detail suppressed. Overall verdict only._

### Food-service invoice — must route to F&B cost of sales · FAIL
_Holdout case — detail suppressed. Overall verdict only._

### Blind holdout case #1 · FAIL
_Holdout case — detail suppressed. Overall verdict only._

### Blind holdout case #2 · PASS
_Holdout case — detail suppressed. Overall verdict only._

### Blind holdout case #3 · PASS
_Holdout case — detail suppressed. Overall verdict only._
