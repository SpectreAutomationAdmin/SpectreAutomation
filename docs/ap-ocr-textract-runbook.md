# AP Document OCR — AWS Textract runbook

Status: **staging (IAM gated closed) — not yet enabled for real
provider calls**. This runbook documents the architecture, the
verified input path, the region + credential design, the required
IAM policies, and the go-live gate for Checkpoint 15X continuation.

---

## Architecture — where paid calls happen

```
Web tier (Mission Control render / analyser projection):
  ↓ reads persisted DocumentOcrExtraction row
  ↓ if missing: enqueue AP_DOCUMENT_OCR job (idempotent) + return "pending"
  ↓ NEVER invokes AWS Textract directly

Worker tier (bin/worker.ts on spectre-staging-worker):
  ↓ picks up AP_DOCUMENT_OCR job
  ↓ atomically claims DocumentOcrExtraction (PENDING → PROCESSING)
  ↓ fetches PDF bytes from R2
  ↓ calls AWS Textract AnalyzeExpense (the ONLY paid call site)
  ↓ normalises response into CanonicalDocumentExtraction
  ↓ persists row (PROCESSING → SUCCEEDED / FAILED_*)
  ↓ touches ApIntakeSource → WorkIntakeItem so projection cache flips
```

**Rule**: no route handler, no server component, no projection
loader, no browser page ever invokes `runTextractExpense`. Only
`src/lib/ap-intelligence/ocr/worker.ts#runAPDocumentOcrJob` may.

---

## §6 — verified input path (AWS AnalyzeExpense)

Per the AWS SDK for JavaScript v3 `@aws-sdk/client-textract@^3.1098.0`
and the AWS Textract Developer Guide, **AnalyzeExpense sync mode**
accepts these input shapes:

| Input                         | PDF | PNG | JPEG | TIFF | Max size (sync) | Max pages (sync) |
|-------------------------------|-----|-----|------|------|-----------------|------------------|
| `Document.Bytes` (raw bytes)  | ✅   | ✅  | ✅   | ✅   | 10 MB           | 1                |
| `Document.S3Object` (S3 URI)  | ✅   | ✅  | ✅   | ✅   | 10 MB           | 1                |

**Rendering a PDF to PNG/JPEG is NOT required** for image-only PDFs.
The service accepts image-only PDFs as PDF bytes and internally
handles the page rasterization. Rendering client-side would (a)
add a dependency (pdftoppm / poppler / pdfjs canvas), (b) risk
resolution loss, (c) introduce another failure mode.

**Chosen input path**: `Document.Bytes` with raw single-page PDF.

**Why not `Document.S3Object`**:
- The document is already in Cloudflare R2 (S3-compatible but not
  AWS-native). Passing an R2 URI to AWS Textract would fail with
  `InvalidS3ObjectException` because R2 is not a bucket AWS Textract
  can access. Bridging via AWS S3 would double the storage cost
  and add a data-egress hop.
- Raw bytes stays under 10 MB for the target document
  (1087769.pdf is 342,862 bytes = 0.33 MB).

Adapter contract lives in
[`src/lib/ap-intelligence/document-extractors/aws-textract-expense.ts`](../src/lib/ap-intelligence/document-extractors/aws-textract-expense.ts).

Gates enforced BEFORE any provider call:
- `input.bytes.length ≤ 10 MB` → else `PROVIDER_FILE_TOO_LARGE`
- `input.mimeType ∈ {application/pdf, image/*}` → else `PROVIDER_UNSUPPORTED_MIME`
- `input.pageCount ≤ 1` → else `PROVIDER_MULTI_PAGE_NOT_SUPPORTED`
- region resolvable → else `PROVIDER_UNAUTHENTICATED`
- credentials resolvable → else `PROVIDER_UNAUTHENTICATED`

**Multi-page PDFs**: NOT SUPPORTED this checkpoint. They require
`StartExpenseAnalysis` (async API + S3 input + polling). This is a
follow-up checkpoint (deferred). Multi-page docs currently produce
a `PROVIDER_MULTI_PAGE_NOT_SUPPORTED` terminal failure — the
extraction row is marked `FAILED_TERMINAL` with a code operators
can pattern-match on.

---

## §7 — region design

**Chosen Textract region**: `us-east-1`.

Why `us-east-1`:
- Lowest latency from Fly's `iad` (Ashburn, Virginia) region where
  `spectre-staging-worker` runs.
- Broadest AWS service coverage — every AnalyzeExpense feature is
  available.
- Same AWS commercial region as the KMS key (`AWS_KMS_KEY_ID`) —
  simplifies CloudTrail + billing consolidation while remaining
  configurably independent.

Data residency implications:
- Invoice content transits from R2 (Cloudflare, currently Auto
  region) → Fly worker (`iad`) → AWS Textract (`us-east-1`).
- All three transit hops are TLS-in-transit.
- Textract is stateless per-request: AWS documents that it does NOT
  retain document images after processing when called via
  synchronous `AnalyzeExpense`.
- Persisted `DocumentOcrExtraction` rows live in Neon Postgres
  (`prisma-postgres`, currently in AWS `us-east-1`).

**Env var**: `SPECTRE_TEXTRACT_REGION` — REQUIRED for the OCR
worker to invoke a provider. If unset, the adapter returns
`PROVIDER_UNAUTHENTICATED` with a message pointing to this variable.

**NEVER**: the Textract adapter refuses to read `AWS_REGION` as a
fallback. `AWS_REGION` is the KMS provider's region. Reusing it
would silently couple two independent subsystems — a KMS region
change (compliance-driven) would also move Textract processing, or
a Textract region change would migrate KMS. Kept independent by
design.

---

## §8 — IAM design

### Current staging principal (sanitized)

- Principal: `arn:aws:iam::162105037982:user/spectre-staging-app`
- Currently attached (2026-07-29): unknown to Claude; the operator
  must confirm via `aws iam list-attached-user-policies --user-name
  spectre-staging-app`.
- Known-used services on this principal: `kms:Encrypt`, `kms:Decrypt`
  (via `AWS_ACCESS_KEY_ID` shared with the OCR adapter — see §8b
  below).

### Recommended target: dedicated Textract principal

**Preferred**: create a NEW IAM user or role dedicated to Textract:

- Name: `spectre-staging-textract`
- Access key stored in Fly secrets as
  `SPECTRE_TEXTRACT_ACCESS_KEY_ID` + `SPECTRE_TEXTRACT_SECRET_ACCESS_KEY`.
- Adapter automatically prefers these over the shared `AWS_*`
  credentials — see `resolveTextractCredentials()` in
  [`src/lib/ap-intelligence/ocr/config.ts`](../src/lib/ap-intelligence/ocr/config.ts).
- The adapter LOGS a warning when it falls back to shared
  credentials so operators can see the drift.

Benefits:
1. **Least privilege**: this principal has no other actions.
2. **Independent rotation**: rotate Textract credentials without
   touching KMS.
3. **Separate CloudTrail actor**: OCR-related events are attributable
   to `spectre-staging-textract`, not the shared KMS user.
4. **Independent revocation**: if a Textract-related incident occurs,
   the principal can be disabled without breaking encryption.

### Interim: shared with KMS (current staging fallback)

Acceptable ONLY during bring-up. The adapter emits
`ap-intelligence.textract.shared_credential` at WARN so ops can
migrate. Nothing in staging code prevents the shared path; it's a
policy choice.

### Required IAM policy

Attach the following inline policy to whichever principal is chosen
(`spectre-staging-textract` recommended, `spectre-staging-app`
acceptable as interim). This is the MINIMUM viable policy for the
sync `AnalyzeExpense` path:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SpectreOcrTextractAnalyzeExpense",
      "Effect": "Allow",
      "Action": "textract:AnalyzeExpense",
      "Resource": "*"
    }
  ]
}
```

### Resource-level restriction — verified answer

Per the [AWS service authorization reference for Amazon Textract]
(https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazontextract.html),
`textract:AnalyzeExpense` does NOT support resource-level
restriction: the "Resources" column is empty for every Textract
action. `Resource: "*"` is therefore the **only** valid value, not
a shortcut. Least-privilege here comes from restricting the
**action list** (one action), not the resource ARN.

Operators may still add condition keys (`aws:SourceIp`,
`aws:RequestedRegion`, `aws:MultiFactorAuthPresent`) if the
environment supports them.

### Rotation plan

- Rotate every 90 days: create new access key, deploy to Fly
  secrets under a temporary alias, cut over, delete old key.
- Rotation is fully independent of KMS rotation once dedicated
  credentials are in place.

### CloudTrail monitoring

- Enable data events for the Textract account.
- Alert on any `textract:*` action outside `AnalyzeExpense` — no
  other action is authorised.
- Alert on `AccessDenied` from the dedicated principal (indicates
  policy drift).
- Alert on invocation from an unexpected source IP (Fly's IAD
  egress range).

---

## §9 — security controls

The adapter and worker enforce:

- Raw document bytes: never logged (only length + sha16 prefix).
- Extracted text: never logged (only field-presence booleans in
  `confidenceSummaryJson`).
- Provider raw response: never logged (attempts, latency, and
  `expenseDocumentCount` only).
- Sanitized error codes: the provider error `message` is REPLACED
  with the classified code (`PROVIDER_PERMISSION_DENIED` etc.)
  before logging. Provider-supplied text is dropped.
- TLS in transit: AWS SDK default.
- At-rest storage: `normalizedExtractionJson` lives in Postgres.
  Additional column-level KMS envelope encryption is a follow-up
  checkpoint — Neon Postgres uses AES-256 at the volume layer
  already.
- Banking / EFT fields: NEVER included in `confidenceSummaryJson`
  or `DocumentOcrExtraction` telemetry.

---

## §10 — retry + failure taxonomy

| Provider error class                     | Sanitized code                   | Retry? |
|------------------------------------------|----------------------------------|--------|
| `AccessDeniedException` / HTTP 403       | `PROVIDER_PERMISSION_DENIED`     | ❌     |
| `UnrecognizedClientException` / HTTP 401 | `PROVIDER_UNAUTHENTICATED`       | ❌     |
| `InvalidParameterException`              | `PROVIDER_INVALID_INPUT`         | ❌     |
| `UnsupportedDocumentException`           | `PROVIDER_INVALID_INPUT`         | ❌     |
| `ProvisionedThroughputExceededException` | `PROVIDER_RATE_LIMITED`          | ✅     |
| `ThrottlingException` / HTTP 429         | `PROVIDER_RATE_LIMITED`          | ✅     |
| `InternalServerError` / HTTP ≥ 500       | `PROVIDER_INTERNAL_ERROR`        | ✅     |
| `TimeoutError` / `ETIMEDOUT`             | `PROVIDER_TIMEOUT`               | ✅     |
| Anything else                            | `PROVIDER_UNKNOWN_ERROR`         | ❌     |

Retryable failures use exponential backoff (5s, 10s, 20s cap 5m)
and stop at `OCR_MAX_ATTEMPTS = 3`. On the last retryable attempt
the row transitions to `FAILED_TERMINAL`.

Permission / authentication errors are TERMINAL — no retry burns
budget until an IAM change occurs. On configuration change, an
operator can enqueue a controlled reprocessing by bumping
`OCR_EXTRACTION_VERSION` (see §14 below).

---

## §11 — projection cache invalidation

`intelligence-review-intakes.ts` includes a new cache-key axis
`ocr=<per-club fingerprint>` fed by
`loadOcrExtractionRevision(clubId)`. When the worker persists a
new SUCCEEDED extraction, `DocumentOcrExtraction.updatedAt` bumps
and the aggregate `count@maxUpdatedAt` fingerprint flips → every
warm AP-card projection for that club invalidates naturally.

No manual `apSummaryCache.delete(...)` is required by any caller.

The worker also touches every canonical AP intake sourced from the
document (via `ApIntakeSource`) by clearing `analysisVersion`,
which forces the projection to rerun the analyser on the next
render — belt-and-braces.

---

## §12 — telemetry (content-free)

Every worker attempt emits `ap-intelligence.ocr.telemetry` with:

- `clubId`, `extractionRowIdTail`, `documentClass`, `strategy`
- `outcome` ∈ SUCCESS | RETRYABLE_FAIL | TERMINAL_FAIL | SKIPPED_DUPLICATE | PENDING
- `sanitizedErrorCode` (never provider message text)
- `attempt`, `latencyMs`, `byteLength`, `pageCount`, `providerRegion`

Every duplicate prevention emits `ap-intelligence.ocr.duplicate-prevented`
with `reason` ∈ already_persisted | already_pending | ocr_disabled.

To convert into dashboard metrics: aggregate by
`(clubId, documentClass, outcome)` per hour. No document content
leaves the worker.

**AWS Budget alert (operator task before enabling)**: create an AWS
Budget for the Textract account. Suggested limits:
- $10 USD/month cost budget, alert at 50%/80%/100%.
- 100 invocations/day usage budget (matches ~one clubful of
  invoices — well above real staging usage).

---

## §14 — go-live gate

Before attaching the IAM policy above, the following must all be
green:

- [x] `DocumentOcrExtraction` table exists in staging DB.
- [x] `AP_DOCUMENT_OCR` handler registered in worker.
- [x] Strategy router never invokes a paid provider synchronously.
- [x] Web tier reads persisted rows only.
- [x] Cache invalidation axis (`ocr=<revision>`) present.
- [x] Adapter reads `SPECTRE_TEXTRACT_REGION` explicitly.
- [x] Adapter prefers dedicated credentials over shared.
- [x] Sanitized error taxonomy in place.
- [x] Required tests pass (see [tests/c15x-ocr-*.test.ts](../tests)).
- [ ] IAM policy attached to chosen principal.
- [ ] Single controlled live call on `1087769.pdf` succeeds.
- [ ] Repeated page refreshes on the resulting Work Intake card
      trigger ZERO additional provider calls (verified via
      CloudTrail count).

Only when all boxes are checked does the checkpoint pass.

---

## Reprocessing an extraction after a version bump

To force a controlled reprocessing (§5 rule) across the entire
tenant fleet:

1. Bump `OCR_EXTRACTION_VERSION` in
   [`src/lib/ap-intelligence/ocr/config.ts`](../src/lib/ap-intelligence/ocr/config.ts).
2. Deploy web + worker.
3. Next projection render for each affected AP intake enqueues one
   new job per document (against the new version). Prior version
   rows remain in the DB for audit.
4. To reprocess a single document manually, delete the specific
   row and the next render will re-enqueue.

Never mutate a `SUCCEEDED` row — the audit trail must remain
immutable per identity.
