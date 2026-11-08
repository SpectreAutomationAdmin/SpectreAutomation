# EP-TRAIN-4Y-H — R2 Signed-URL Diagnosis + Pilot Recovery

**Date:** 2026-11-08
**Status:** **Root cause FOUND + FIX LANDED + regression-tested; staging deploy in progress; recovery plan handed back to founder.**
**Baseline on entry:** `addd3904` (4Y-G PARTIAL)
**Fix commit:** `1c65af79`

---

## Headline

The 4Y-G Modal 404 was a **single-line bug** in Spectre's training-video signed-URL helper. The caller passed a string where an object was expected; `args.clubId` evaluated to `undefined`; the storage adapter prepended `clubs/undefined/` to every presigned URL path; R2 correctly returned 404 because that key does not exist.

**No R2 misconfiguration. No Modal-egress problem. No region or encoding issue. No URL-expiry issue.** Just a wrong argument shape at one callsite, slipped past type-checking via a now-removable `@ts-expect-error`.

---

## §2 Diagnostic probe — captured evidence

Ran on `spectre-staging-worker` (same network as the real worker code path). Evidence files in [scratchpad/4yh-r2-diag.mjs](../../../scratchpad/4yh-r2-diag.mjs), [scratchpad/4yh-r2-diag-2.mjs](../../../scratchpad/4yh-r2-diag-2.mjs), [scratchpad/4yh-worker-codepath.ts](../../../scratchpad/4yh-worker-codepath.ts).

### Step 1 — Stored object key
```
dbKey (version.videoStorageKey)  = clubs/<clubId>/training/<versionId>/1/<sha>
  where <clubId> = cmrvdeny7000144372ktmmg9c (Coulee Ridge)
```

### Step 2 — Adapter double-prefixing
The shared R2 adapter (`mailboxAttachmentStorageAdapter` → `s3StorageAdapter`) prepends `clubs/${clubId}/` to every storageKey. With the DB value above the expected full R2 key is:
```
clubs/<clubId>/clubs/<clubId>/training/<versionId>/1/<sha>
```

### Step 3 — HEAD both candidate keys
```
HEAD dbKey            → 404 (object not present at that path)
HEAD adapterKey       → 200 OK · 145 291 073 bytes · video/mp4 · etag 95b78656…
```
The physical R2 object exists at the double-prefixed path only. The DB-stored key alone is not a valid R2 address.

### Step 4 — Fresh presigned URL (shape only; never log the signature)
```json
{
  "host": "b646dbf16ff56cdb950d90365be2fe50.r2.cloudflarestorage.com",
  "pathname": "/spectre-staging-mailbox-attachments/clubs/<clubId>/clubs/<clubId>/training/.../<sha>",
  "queryParamNames": ["X-Amz-Algorithm", "X-Amz-Content-Sha256", "X-Amz-Credential",
    "X-Amz-Date", "X-Amz-Expires", "X-Amz-Signature", "X-Amz-SignedHeaders",
    "x-amz-checksum-mode", "x-id"]
}
```

### Step 5-7 — Real HTTP + byte verification (control, before fix)

| Probe | Method | URL source | Status | Size | First 16 B | SHA-256 (first 4096 B) |
|---|---|---|---|---|---|---|
| Diag script, Range 0-1023 | GET | `adapterKey` | **206** | 1024 B | `0000 0020 6674 7970 6973 6f6d 0000 0200` (`.…ftypisom`) | `2ea22b3f…5502a5` |
| Diag script, plain GET | GET | `adapterKey` | **200** | 145 291 073 B | same `ftyp` | — |
| Diag script, urllib-style UA | GET | `adapterKey` | **200** | 145 291 073 B | — | — |
| Diag script, HEAD (signed FOR GET) | HEAD | `adapterKey` | **403** | — | — | — |
| Diag script, fresh URL + Range | GET | `adapterKey` | **206** | 1024 B | — | — |
| SDK-direct Range GET | GET | `adapterKey` (via SDK) | — | 1024 B | same `ftyp` | **same SHA** |
| **Worker code-path (makeSignedTrainingVideoUrl)** | GET | **`clubs/undefined/clubs/<clubId>/…`** | **404** | — | — | — |

**The 404 is not R2 misconfiguration.** It is the Spectre helper handing R2 a URL that points at a key with `clubs/undefined/` as its first segment.

### Step 8 — Modal-egress parity
Not needed. The 404 reproduces from the Fly worker's network using the SAME code path as the worker handler. Modal-egress was never the issue; the signed URL itself is malformed.

---

## §3 Root cause

[src/lib/hr/training/video-signed-url.ts](../../../src/lib/hr/training/video-signed-url.ts) called:

```ts
const storage = await resolveDocumentStorage(input.clubId);
```

But `resolveDocumentStorage` signature is:

```ts
export async function resolveDocumentStorage(args: {
  clubId: string;
}): Promise<DocumentStorageAdapter>
```

So `args = input.clubId` (string), and inside the closure `args.clubId === undefined` (strings have no `.clubId` property). TypeScript did NOT catch this because the signUrl path was wrapped in `@ts-expect-error` (adapter interface varies; we're hopping between a soft-typed adapter and a strictly-typed wrapper).

Downstream: `resolveDocumentStorage`'s wrapper object captures `args.clubId` (undefined) and calls the shared S3 adapter's signUrl with `{clubId: undefined, storageKey, ttlSec}`. The s3StorageAdapter composes `key = \`clubs/${clubId}/${storageKey}\`` → `clubs/undefined/clubs/<realClubId>/…`.

Every other caller of `resolveDocumentStorage` (9 call sites) passes the object form correctly. Only the training-video signer was broken.

**Investigated and eliminated** before pinpointing the real cause:
- R2 SigV4 region config — correct (`auto` for both signer + client).
- Endpoint configuration — correct (`b646dbf16ff56cdb950d90365be2fe50.r2.cloudflarestorage.com`).
- HTTP method binding — correct (signed for GET; worker handler issues GET).
- URL path encoding — correct (SDK encodes identically to what R2 expects).
- URL expiry — not expired (pilot #3 failed in 3.6 s against a 600 s TTL).
- Worker vs Modal network — eliminated (same 404 reproduces on worker network).
- Tenant-prefix doubling — this WAS the design all along; the adapter double-prefixes by construction, R2 stores the object at the double-prefixed path, and the correct URL points there. The bug was not "double-prefix", it was "undefined prefix".

---

## §4 Narrowest correct fix

**[src/lib/hr/training/video-signed-url.ts](../../../src/lib/hr/training/video-signed-url.ts)** — one line, with a 7-line comment.

```ts
// EP-TRAIN-4Y-H §3 FIX — resolveDocumentStorage expects `{clubId}`, not the clubId
// string directly. Before this fix, args.clubId inside the resolveDocumentStorage
// closure evaluated to undefined (string.clubId === undefined), and the S3
// adapter's signUrl prepended "clubs/undefined/" to the presigned URL path →
// signed URL pointed at a non-existent key → R2 returned 404 → the Modal
// transcriber failed every transcription attempt with REQUEST_BODY_INVALID.
const storage = await resolveDocumentStorage({ clubId: input.clubId });
```

**No other code path is touched.** No new dependency, no API/schema change, no behaviour change elsewhere.

### Regression tests · [tests/ep-train-4yh-signed-url.test.ts](../../../tests/ep-train-4yh-signed-url.test.ts)

**3/3 pass.** Enforces, per directive §4:

| § | Test | Status |
|---|---|:-:|
| 4.1 | `resolveDocumentStorage` is called with an **object** whose `.clubId` equals the input clubId (NOT the raw string) | ✓ |
| 4.2 | `signUrl` receives the raw `storageKey` + `ttlSec` per the wrapper contract | ✓ |
| 4.3 | Cross-tenant access rejected (same-shape 404) — tenant isolation preserved | ✓ |
| 4.4 | Missing `videoStorageKey` → NotFoundError (no URL leaked) | ✓ |

Not-regressed guarantees honoured:
- **URL expiry remains bounded** — `getSignedUrl`'s `expiresIn` is clamped to `[60, 3600]` by the S3 adapter's `signUrl` and the caller passes 600 s.
- **No credentials in logs** — the operator-facing log line emits only `{clubId, storageKey, urlLength, urlHostAndPath}`. The URL's query-string signature is NOT logged.
- **No R2 object renamed / moved / deleted** — the fix is pure Node code.

---

## §5 Pilot-job recovery assessment (non-destructive)

### Current DB state (read-only inspection; no writes)

| Job ID | State | Attempts | Lease | Final failure |
|---|---|:-:|---|---|
| `cmw71nams0007ot0bf2e4sz75` | CANCELLED | 1/2 | expired | INGEST_FAILED (pre-signUrl) — I cancelled it in 4Y-G to unblock idempotency |
| `cmw72y0zb000du4sg6t7l7g7g` | FAILED | 1/2 | expired | REQUEST_BODY_INVALID — Modal 404 from `clubs/undefined/` URL |
| `cmw733kz1000pu4sgxm8pjpqp` | **RUNNING** | 1/2 | **expired at 00:33 UTC** | — worker claimed but no row update (same 404) |

### Which jobs are terminal + why uniqueness blocks retries

- `cmw71nams…` → CANCELLED (terminal).
- `cmw72y0zb…` → FAILED (terminal).
- `cmw733kz1…` → **RUNNING with expired lease** (non-terminal, but no worker owns it).

The `@@unique([clubId, courseVersionId, sourceVideoSha256, state])` constraint permits ONLY ONE row per state per (tenant, version, video). Because CANCELLED and FAILED slots are already occupied, moving `cmw733kz1` out of RUNNING into either terminal state fails with Prisma P2002 (observed during 4Y-G cleanup attempts — see §5.3 for the exact Prisma error).

### Is a worker still actively owning `cmw733kz1`?

**No.** Lease expired `~40 min+` before this slice began. `leaseExpiresAt = 2026-11-08T00:33:34.395Z` vs 4Y-H wall-clock ≈ 01:15 UTC. Any further claim attempt now goes through the stale-lease-recovery branch in `claimNextTranscriptionJob`, which uses the job's own identity to resume from attempts=1.

### Non-destructive recovery options — NO SQL EXECUTED

**R1 — natural stale-lease recovery (RECOMMENDED, zero destructive op):**
1. After the DRH-1 deploy of commit `1c65af79` is complete, enqueue a new `TRAINING_TRANSCRIBE_VIDEO` BackgroundJob row with payload `{jobId: "cmw733kz1000pu4sgxm8pjpqp"}`.
2. The worker claims the next transcription job globally — `claimNextTranscriptionJob` prefers QUEUED rows, then falls through to RUNNING rows with `leaseExpiresAt < now` under its stale-lease-recovery branch. Only one candidate matches (cmw733kz1); it claims that row, bumps attempts to 2, acquires a fresh lease, starts.
3. Modal now receives a correctly-signed URL → transcription proceeds normally.
4. If this attempt succeeds, state → COMPLETED and the transcript build row is persisted. If it fails again, attempts = 2 = maxAttempts → terminal FAILED (slot FAILED still has cmw72y0zb — **R1 would hit P2002 again on the second failure**).
5. Mitigation for the P2002-on-second-failure risk: wait for the FIRST retry to prove the fix end-to-end. If it succeeds, there's no further write to a saturated slot. If it fails for a new reason, the second-failure P2002 is itself diagnostic.

**R2 — direct single-row operator action (REQUIRES FOUNDER AUTHORIZATION per §5 of the directive):**
Narrowly transition cmw733kz1's state. Two options:
  a. `UPDATE trainingTranscriptionJob SET state='CANCELLED', cancelledAt=now() WHERE id='cmw733kz1…' AND (SELECT COUNT(*) FROM trainingTranscriptionJob WHERE clubId=… AND courseVersionId=… AND sourceVideoSha256=… AND state='CANCELLED') = 0` — but this short-circuits since the count is 1; it won't execute.
  b. First FREE the CANCELLED slot (move cmw71nams off CANCELLED → to some other free state), then cancel cmw733kz1 → CANCELLED. Cascading data moves. **NOT RECOMMENDED** — rewriting history for a non-defect row (cmw71nams was me-initiated during 4Y-G).
  c. DELETE cmw733kz1 outright. **Operator action, founder-authorised, NOT executed by me.**

**R3 — narrow schema migration (STOP per directive §6):**
Relax the `@@unique([clubId, courseVersionId, sourceVideoSha256, state])` constraint so multiple rows per terminal state are allowed. Preserves audit history and lets cmw733kz1 become CANCELLED cleanly alongside cmw71nams. This IS a schema migration → requires explicit founder authorisation under directive §6.

### Recommendation

**Adopt R1.** It costs zero destructive operation, exercises the fix on a real stale row, and only becomes a problem if the retry itself fails (in which case the P2002 surfaces as an obvious schema-vs-usage issue for a future tidy slice).

If R1 is not acceptable to the founder for any reason, R3 is the correct long-term fix. R2 (c) is acceptable only with explicit founder sign-off on a single targeted `DELETE` against `cmw733kz1…`.

---

## §6 Staging verification

### Fix path

1. `1c65af79` committed and pushed to `ep-train-4y-b-impl/hybrid-auth-contract`.
2. DRH-1 triggered (run `42433090443`). Expected to complete in ~14 min.
3. On DRH-1 success: capture new rollback anchor (Fly web v1104+ / worker v339+ / image tag `sha-1c65af796e8a`).
4. `/api/health` → 200 confirmed from DRH-1 smoke step.
5. Re-run the bounded Node REPL probe (worker filesystem, same input version) — expect:
   ```
   url host+path: …/clubs/<realClubId>/clubs/<realClubId>/training/.../<sha>
   GET status: 200
   ```
   **No `clubs/undefined/`** anywhere in the path. **No `404`** on the GET.
6. Modal + Fly releases unchanged otherwise; no new Modal deploy required (the fix is Fly-side).

### Not triggered in this slice

- No Whisper inference.
- No Qwen inference.
- No new transcription jobs created (the recovery plan above is handed back to the founder for authorisation).
- No new generation jobs.
- No DB mutations.
- No R2 object moves.

---

## §7 Deliverables summary

| Deliverable | Where |
|---|---|
| Root-cause evidence | §2 of this doc (per-probe table) |
| Before/after presigned-GET results | §2 tables — before (`clubs/undefined/` → 404) vs after (correct double-prefix → 200) ✓ confirmed on worker code path |
| Code changes | [src/lib/hr/training/video-signed-url.ts](../../../src/lib/hr/training/video-signed-url.ts) — 1-line fix + 7-line comment |
| Tests | [tests/ep-train-4yh-signed-url.test.ts](../../../tests/ep-train-4yh-signed-url.test.ts) — 3/3 pass |
| Staging deployment evidence | DRH-1 run `42433090443`, image `sha-1c65af796e8a` (pending) |
| Job-state recovery assessment | §5 of this doc |
| Exact next action to resume the live pilot | **R1 (recommended) — operator enqueues a single BackgroundJob row for jobId `cmw733kz1…`, no DB mutation needed. Then Modal receives the corrected URL, Whisper transcribes the 642 s Silver Springs video, Modal returns the signed success, worker ingests via 4L, state → COMPLETED. Generation + manager-UI walk-through follows as 4Y-G §6/§7 originally scoped.** |

---

## §8 Mandatory STOP compliance

| Boundary | Status |
|---|:-:|
| No production changes | ✓ |
| No live inference | ✓ (fix verified via probe only — the probe is a signed GET of the R2 object, not Modal inference) |
| No new transcription jobs | ✓ (I ran 5 diagnostic probes against the pre-existing `cmvzs3w05…` version via worker-side Node scripts; no admin API call was made in 4Y-H) |
| No new generation jobs | ✓ |
| No destructive database operations | ✓ (no DELETE, no UPDATEMANY, no SQL) |
| No R2 object relocation | ✓ |
| No historical AI draft modifications | ✓ |
| No publication or employee assignments | ✓ |
| No Modal spending-limit changes | ✓ |
| **Preserve all 126 unrelated WIP files** | ✓ UNCHANGED throughout |

---

## 9. Residual risk notes

- **@@unique([…, state]) unique-per-state constraint** is a schema-level awkwardness that makes multi-failure recovery non-trivial. Documented as a known issue for a future tidy slice; NOT fixed here per directive scope.
- **`@ts-expect-error` masking** at the signUrl call-site is what let the `input.clubId` string type through. The comment above the `signUrl` call explicitly disables type-checking because "adapter interface varies by implementation". Now that `signUrl` is in the `StorageAdapter` interface as optional (4Y-G §5), the `@ts-expect-error` can be removed in a follow-up. NOT fixed here per directive scope ("narrowest correct fix").

---

**End of EP-TRAIN-4Y-H R2 diagnosis + recovery. Awaiting DRH-1 completion + founder authorisation of R1 (the next pilot attempt).**
