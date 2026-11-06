# EP-TRAIN-6D-4V — Automatic Video Transcription Integration — Acceptance

Status: **PAUSED AT §3 SCHEMA + CORRECTION GATE.** Per directive
§3: "If the required worker credentials, deployment model or schema
cannot be supported safely, STOP and propose the smallest
correction."

Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4v/transcription-orchestration` (design doc only; not
pushed).

## 1. One-line summary

4V assumes a transcription lifecycle table, Modal-side credentials,
and provider wiring that do NOT exist on the accepted 4T baseline.
A minimum additive correction is required before implementation.
See [PHASE-D-4V-TRANSCRIPTION-DESIGN.md](PHASE-D-4V-TRANSCRIPTION-DESIGN.md)
for the proposed `TrainingTranscriptionJob` table + runtime
architecture + cost governance + failure classification.

**No code written. No migration authored. No tests run. No Modal
call. No worker activation. No role grant.**

## 2. Preflight findings (summary)

| Referenced by 4V directive                                   | Present on `9f1ba080` baseline? |
| ------------------------------------------------------------ | :------------------------------: |
| "faster-whisper transcription provider architecture"         | ✗                                |
| Modal secrets / env wiring                                   | ✗                                |
| `SPECTRE-SEC-1` credential helpers (runtime)                 | ✗ (WIP-only workstation tooling) |
| `TrainingTranscriptionJob` lifecycle table                   | ✗                                |
| Worker queue handler for transcription                       | ✗                                |
| Admin API route to request transcription                     | ✗                                |
| EP-TRAIN-6A audit specifying the service contract            | ✓ (`de8653f5`, read-only)        |
| 4K schema (COMPLETED evidence identity)                      | ✓                                |
| 4L ingest services                                           | ✓                                |
| R2 video storage + SHA verification + authenticated proxy    | ✓                                |
| Fly worker (`spectre-staging-worker`) + queue registry       | ✓                                |

## 3. Minimum correction requested (§3 STOP cause)

Add ONE new table `TrainingTranscriptionJob` (SQLite + PG mirror)
with:

- Tenant + target: `clubId`, `courseVersionId`, `sourceVideoSha256`.
- State machine: `REQUESTED | QUEUED | RUNNING | COMPLETED | FAILED | CANCELLED`.
- Lifecycle timestamps: `requestedAt / queuedAt / startedAt / completedAt / cancelledAt`.
- Bounded retry budget: `attempts`, `maxAttempts` (default 2).
- Cost-governance snapshot: `estimatedCostUsdMicros` + timing.
- Failure classification: `failureCode` + safe `failureMessage`.
- Audit attribution: `requestedByUserId` / `cancelledByUserId`.
- FK on success: `resolvedTranscriptBuildId` → `TrainingTranscriptBuild`.
- Uniqueness on `(clubId, courseVersionId, sourceVideoSha256, state)`
  to collapse duplicate requests.

Zero changes to existing production columns. Follows the 4B / 4K /
4T sidecar-table pattern.

## 4. Why no code change was made in this preflight

Per directive §3: "If the required worker credentials, deployment
model or schema cannot be supported safely, STOP and propose the
smallest correction." + §11: "No shared database migration."

Authoring a migration or service implementation before the founder
approves the schema shape would:

- Silently commit a schema design the founder has not reviewed.
- Lock Spectre into a lifecycle model that may not match the
  founder's billing / cost / retention expectations.
- Deviate from the pattern established in 4T (which also stopped
  for schema authorization before implementation).

## 5. Proposed runtime surface (post-authorization, documented but
NOT written)

The design doc enumerates:

- Fly secret surface: `MODAL_TRANSCRIBE_URL` +
  `MODAL_SPECTRE_SHARED_TOKEN` (worker + web). Fail-closed on
  absence.
- Worker-system Principal — synthetic in-process, carrying ONLY
  `hr:training:transcription:write` on the target club. Mirrors
  4R's narrow-scope pattern.
- Admin API route `POST /api/admin/training/versions/[id]/transcribe`
  gated on existing `hr:training:write` (no new RBAC permission).
- Queue handler `TRAINING_TRANSCRIBE_VIDEO` registered via
  `src/lib/queue/handlers.ts`.
- Cost governance: per-tenant daily USD cap (configurable, default
  $10 to match the founder's Modal account cap), per-job wall-clock
  cap, bounded retries, no auto-restart.
- Quality heuristics (no LLM) that flag empty / repetition /
  timestamp-anomaly / hallucination-template / pending source-org
  check.
- Failure classification: 7 codes
  (`MODAL_HTTP_ERROR | MODAL_TIMEOUT | MODAL_HMAC_INVALID |
  SHA_MISMATCH | INGEST_FAILED | CREDENTIAL_ABSENT | COST_CAP_EXCEEDED`).

## 6. SPECTRE-SEC-1 clarification

The WIP `scripts/spectre-sec-1/` PowerShell tree is a
developer-workstation credential vault for local Modal runs. It is
NOT required for 4V's runtime integration — the Fly worker reads
credentials from Fly secrets via `process.env`. A future slice can
bring SEC-1 into the repo for local dev ergonomics, but 4V does not
block on it.

## 7. Historical-candidate preservation (directive §7)

The 8 EP-TRAIN-6D-4H candidates on Coulee Ridge remain
`groundingProjectionId = NULL` (verified in 4R + 4T). 4V's new
table does not reference those rows. Even post-implementation, the
`TrainingTranscriptionJob` table carries no row for any historical
video (those videos never existed on the 4K schema). Historical
candidates remain unapprovable via the 4T promotion bridge for the
documented reason (`EVIDENCE_HISTORICAL_UNAVAILABLE`), independent
of 4V.

## 8. Request for founder authorization

The founder must EITHER:

- **(A)** Approve the §2 `TrainingTranscriptionJob` schema as
  proposed. Implementation + tests + mocked-Modal contract land in
  the next sub-slice on this same branch.
- **(A')** Approve a modified schema (describe in reply).
- **(B)** Pause 4V and prioritise a different slice (e.g. 4T-UI
  admin button, 4U narrow approval role).
- **(C)** Request additional preflight (e.g. local Modal spike
  outside 4V scope).

## 9. STOP compliance (directive §11) — every boundary honoured

| Boundary                                 | Status                            |
| ---------------------------------------- | --------------------------------- |
| No staging or production deployment      | HONOURED                          |
| No shared database migration             | HONOURED                          |
| No Modal/Qwen inference or GPU activation | HONOURED                          |
| No automatic question generation         | HONOURED                          |
| No checkpoint placement                  | HONOURED                          |
| No publication                           | HONOURED                          |
| No employee assignments                  | HONOURED                          |
| No historical candidate modification     | HONOURED                          |
| No role grants                           | HONOURED                          |
| No unrelated UI redesign                 | HONOURED                          |
| 126 unrelated WIP files preserved        | HONOURED — stashed at entry        |
| STOP for correction (§3)                 | **TRIGGERED — correct STOP cause** |
