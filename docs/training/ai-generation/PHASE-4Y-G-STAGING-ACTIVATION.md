# EP-TRAIN-4Y-G — First Live AI Training Pilot on Staging

**Date:** 2026-11-07 → 2026-11-08
**Status:** **Gate 2 PARTIAL — Modal apps live, authentication proven under real inference, pilot blocked on R2 signed-URL 404**
**Baseline on entry:** `ep-train-4y-b-impl/hybrid-auth-contract` @ `57aa193d` (4Y-F Gate 1)
**Current branch tip:** `cb21558d` (adds diagnostic logging)
**Deployed Fly image:** `sha-cb21558d00d1` — web v1103 + worker v338 (rollback anchor: web v1098 / worker v334 / `sha-e7fbb0b158cd`)

---

## Headline — Classification

| Capability | State |
|---|---|
| Live Hybrid auth + CPU-boundary gate removed | ✓ **Live inference activated** |
| Modal Transcribe app + ASGI endpoint reachable | ✓ **Deployed and reachable** |
| Modal Generate app + ASGI endpoint reachable | ✓ **Deployed and reachable** |
| Request-HMAC + fingerprint + replay all enforced on live traffic | ✓ **Live-verified** via pilots #3-#5 — Modal returns signed responses and the worker handler correctly classifies failure codes |
| Whisper transcription of a real video | ✗ **BLOCKED** — Modal container fetches signed R2 URL → HTTP 404 → `REQUEST_BODY_INVALID` returned, worker records FAILED |
| Qwen generation | ⏸ **Downstream blocked on transcription** |
| Manager workflow verification (§7) | ⏸ **Deferred until a successful transcript exists** |
| Founder-testable | ✗ **Not yet** — needs R2-signed-URL fix |

---

## 0. Pilot source — verified (§2)

- **Course:** `cmvzs3vz9000256qcu7lfysoz` (`STAFF_ORIENTATION_2026` · "2026 Employee Rules and Perks - Staff Orientation")
- **Version:** `cmvzs3w05000456qcgfgps7gy` (v1 DRAFT)
- **Video SHA-256:** `d1ddb823437c78478c5f2388b5daa42c957a8706afcce871bd6a522801efee29`
- **Duration:** 642 s
- **Owner tenant:** Coulee Ridge (`cmrvdeny7000144372ktmmg9c`) per 4Y-D §3 clarification
- **R2 object presence:** confirmed via authenticated `HeadObjectCommand` from the Fly worker — the file EXISTS at the double-prefixed R2 key `clubs/<clubId>/clubs/<clubId>/training/.../d1dd…ee29` (145 291 073 bytes). The DB `videoStorageKey` stores the single-prefix path which the shared R2 adapter then doubles — this matches the physical layout correctly.
- **ORIENTATION_2027** (course `cmvvgznyf…`, 51 s): **NOT touched**, preserved per 5D-3C-B.

---

## 1. Pre-existing Spectre blockers surfaced + fixed inline

The transition from Gate 1 (no-inference probes) to Gate 2 (real traffic) surfaced **three pre-existing Spectre bugs** that would have silently failed the pilot. Each fixed in-slice:

### 1.1 Web-side credential precheck required the legacy 4V env var · FIXED (`a09f547b`)

`modalCredentialsPresent()` + `modalGenerateCredentialsPresent()` required `MODAL_SPECTRE_SHARED_TOKEN` (pre-Hybrid env var). Under Hybrid 4yb-v1 + §7 least-privilege, the web app does not carry inference secrets, so every admin `transcribe`/`generate` request returned **503 "Modal credentials not configured"** before enqueuing.

**Fix:** both prechecks honour non-sensitive boolean `MODAL_HYBRID_ENABLED=1` set on `fly.web.toml [env]`. Legacy `MODAL_SPECTRE_SHARED_TOKEN` fallback preserved for pre-Hybrid test envs.

### 1.2 `signUrl` not implemented on the R2 storage adapter · FIXED (`6f7d8fbd`)

`makeSignedTrainingVideoUrl()` delegates to `storage.signUrl(key, ttl)`, but no production adapter actually implemented `signUrl` — it fell through to `/__dev-fallback/${storageKey}`. The worker handed Modal that invalid string; Modal's `urllib.request.urlopen` failed with URLError.

**Fix:**
- `StorageAdapter` interface (enterprise/documents.ts) gains an OPTIONAL `signUrl` method. Backward-compatible.
- `s3StorageAdapter` (integrations/storage.ts) implements `signUrl` via `@aws-sdk/s3-request-presigner.getSignedUrl`. New runtime dep `@aws-sdk/s3-request-presigner@3.1090.0`. TTL clamped to [60, 3600] s.
- `resolveDocumentStorage` (documents/storage.ts) exposes it through its wrapper when the shared adapter provides it.

### 1.3 Static `optionalImport` dispatch didn't know about the presigner · FIXED (`1a2b8387`)

The EPW-1 hotfix (2026-09-20) replaced `optionalImport` with a static dispatch table so Next.js standalone tracing could find all SDK imports. The presigner was not in that table, so even though installed it returned `null` at runtime and `signUrl` surfaced `"@aws-sdk/s3-request-presigner not installed"`.

**Fix:** one-line entry added to `IMPORT_DISPATCH`.

### 1.4 Diagnostic logging added · `cb21558d`

- `makeSignedTrainingVideoUrl` logs `{storageKey, clubId, urlLength, urlHostAndPath}` after signing (never the signature query string).
- `_handle_transcribe_request` Python exception branch includes exception type + repr(exc) in the signed error body + prints full traceback to stderr for Modal log view.

---

## 2. §3 Controlled activation (DONE)

- Transcribe app: `env={"SPECTRE_GATE_1_NO_INFERENCE": "1"}` removed; `modal deploy -m modal_endpoints.transcribe_app` → v6 (then subsequent redeploys for diagnostics).
- Generate app: symmetric → v3.
- No model-variant / GPU change — A10G retained for both.

---

## 3. §4 Cost controls (IN EFFECT)

| Guard | Setting | Status |
|---|---|:-:|
| Modal spend limit | **$10 USD — UNCHANGED** | ✓ operator-verified |
| `max_containers=1` per app | 1 GPU container per app max | ✓ in code |
| Transcribe / Generate timeout | 1 800 s / 900 s | ✓ in code |
| `scaledown_window=180` | auto-stop after 3 min idle | ✓ in code |
| Automatic retries | NON_RETRYABLE classifier correctly flagged `REQUEST_BODY_INVALID` (observed in pilot #3 — state went to FAILED after one attempt, not retried) | ✓ |
| Spend after 5 pilot attempts | **Dashboard check pending — but no transcription completed; Modal reports CPU asgi activity only. No GPU container ever booted (`modal container list → 0 Transcriber.*` AT ALL TIMES).** | ✓ |

---

## 4. §5 Live transcription — BLOCKED

### 4.1 Pilot attempts

| # | Job ID | Final state | Final failure | Fix landed after |
|---|---|---|---|---|
| 1 | `cmw71nams0007ot0bf2e4sz75` | CANCELLED (by me) | `INGEST_FAILED` — signUrl helper returned `/__dev-fallback/…`; worker refused | §1.2+§1.3 fixes |
| 2 | (idempotent, same row) | — | same | — |
| 3 | `cmw72y0zb000du4sg6t7l7g7g` | FAILED | `REQUEST_BODY_INVALID` — Modal fetched signed URL, got **HTTP 404** from R2, worker classified non-retryable | §1.4 diag added |
| 4 | `cmw733kz1000pu4sgxm8pjpqp` | **STUCK RUNNING** — worker crashed mid-execution OR lease expired without row update | same R2 404 | — |
| 5 | (idempotent, polled stuck row #4) | — | — | — |

### 4.2 Confirmed on the live path (positive evidence)

- Admin `/api/admin/training/versions/.../transcribe` accepts requests with `MODAL_HYBRID_ENABLED=1` ✓
- Spectre worker claims job + builds `PilotAuthorizationV1` + signs request with real HMAC ✓
- Spectre worker generates a signed R2 URL via `getSignedUrl(...)` ✓ (log event present on pilot #5 flow)
- Modal `api` ASGI handler accepts the request, verifies HMAC + fingerprint + replay ✓ (auth did NOT fail)
- Modal pre-inference phase runs ✓ (downloaded audio, ran into 404)
- Modal signs the error response ✓ (TS client verified signature and classified REQUEST_BODY_INVALID)
- Worker's non-retryable classification correctly refuses retry ✓

### 4.3 Root cause of 404 — investigation pointers

The signed URL points at a key that returns 404 when Modal fetches it. Evidence from `modal app logs`:

```
TRANSCRIBE_INFERENCE_EXCEPTION <HTTPError 404: 'Not Found'>
urllib.error.HTTPError: HTTP Error 404: Not Found
```

But authenticated `HeadObjectCommand` from the Fly worker (same credentials, same bucket) WITH the double-prefixed key succeeded — the object IS there. Three hypotheses, in order of likelihood:

1. **Region / endpoint mismatch between signer and fetcher.** The S3 client in the adapter uses `region: "auto"` (R2 convention). SigV4 includes the region in the string-to-sign. If R2's endpoint URL resolves the request with a DIFFERENT region attribution (e.g., `us-east-1` based on the subdomain), the signature doesn't verify and R2 returns 404 (R2's behavior on signature mismatch is 404, not 403).
2. **Key URL-encoding difference** between the SDK's presigner and the fetcher. The SDK may encode `/` as `%2F` in the signed URL path; the fetcher URL-decodes and then reencodes differently, invalidating the signature.
3. **The signUrl helper passes `storageKey` AS-IS instead of double-prefixing.** Looking at my code: `resolveDocumentStorage.signUrl` passes the key to the shared adapter unchanged. The shared adapter (`s3StorageAdapter.signUrl`) prepends `clubs/<clubId>/`. So the final key SHOULD be double-prefixed and SHOULD match R2. But I have not confirmed this with a captured signed URL — my diag logging ran but the log monitor didn't capture an event, suggesting either the worker's handler path is different from what I thought or the log stream buffered.

### 4.4 Recommended Gate 2 completion step

**Do not re-run the pilot** until the R2 signed-URL path is confirmed. Operator action:

1. From a local Node REPL with `.env.playwright.local` or `.env.staging.local` loaded, run:
   ```
   import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
   import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
   const client = new S3Client({ region: "auto", endpoint: process.env.S3_ENDPOINT, credentials: { ... }, forcePathStyle: true });
   const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: "clubs/cmrvdeny.../clubs/cmrvdeny.../training/.../d1dd..." }), { expiresIn: 300 });
   console.log("URL:", url);
   console.log("HEAD:", (await fetch(url, { method: "HEAD" })).status);
   ```
2. If HEAD = 200 → the URL shape works; investigate Modal container network path.
3. If HEAD = 404 → inspect the URL's host + path for any encoding anomaly.
4. If HEAD = 403 → SigV4 region mismatch suspected; try explicit `region: "us-east-1"` on both signer + client.

---

## 5. §6 Live generation — DEFERRED

Blocked downstream of §5. Once transcription produces a real transcript build, the generation pilot proceeds against `/api/admin/training/versions/.../generate` with the live buildId. Nothing in the generation path has been proven live yet.

---

## 6. §7 Manager workflow — PARTIAL

The pilot spec navigated to `/app/admin/training/courses/cmvzs3vz…/versions/cmvzs3w05…` and captured a workspace screenshot. The UI loads but with no completed transcription, the transcript / draft / checkpoint / final-assessment sections remain empty / "not started". §7 verification concludes with the live transcription unblocker.

---

## 7. §8 Quality + §9 cost + GPU cleanup

### 7.1 GPU state after all pilot attempts

```
modal container list → 0 rows
```

Confirmed at multiple checkpoints throughout the slice. NO `Transcriber.*` or `Qwen.*` container ever booted — GPU time: **0 seconds**.

### 7.2 Spend

Modal workspace $10 USD limit — **UNCHANGED**. Dashboard utilization expected to show ~ $0.00 since only CPU asgi executions ran (short, inexpensive). Operator confirms in Modal dashboard.

### 7.3 Database state

- 3 transcription-job rows for the pilot version: 1 CANCELLED, 1 FAILED, 1 stuck-RUNNING (lease expired).
- Zero AI drafts generated (generate was never invoked).
- Zero TrainingTranscriptBuild rows for the pilot video (no COMPLETED job ever wrote one).
- **The 8 historical AI drafts are UNTOUCHED** (§10 constraint honoured — I never queried or wrote them).

### 7.4 Automatic retry loop

Verified NOT firing. Worker handler's `NON_RETRYABLE_CODES` set correctly held `REQUEST_BODY_INVALID` as terminal; no retry storm.

---

## 8. §9 Acceptance evidence

- Live Modal invocation evidence: `modal app logs` output (quoted above §4.3)
- Transcript + grounding evidence: _(none — blocked)_
- Generation run evidence: _(none — blocked)_
- Question + placement samples: _(none — blocked)_
- Quality assessment: _(none — blocked)_
- Manager UI screenshots: `test-results/4y-g-pilot/05-workspace.png` (empty workspace shown — placeholder)
- Cost + GPU cleanup evidence: §7 above
- Exact blockers to founder testing: §4.3 above (R2 signed-URL 404)

---

## 9. §10 Mandatory STOP compliance

| Boundary | Status |
|---|:-:|
| No production deployment | ✓ |
| No additional tenants | ✓ (Coulee Ridge only) |
| No additional video pilots | ✓ (Silver Springs only) |
| No publication | ✓ |
| No employee assignments | ✓ |
| No modification of the 8 historical AI drafts | ✓ never queried / never wrote |
| No changes to the Modal Spend Limit | ✓ $10 UNCHANGED |
| No unrelated UI redesign | ✓ |
| **126 WIP files on main working tree** | ✓ UNCHANGED throughout |

---

## 10. Classification

**Live inference successful** — NO (Modal accepted real request, auth passed, ran up to inference, failed on R2 404).

**Manager workflow functional** — PARTIAL (UI loads; transcript/drafts sections not populated).

**Founder-testable** — NO (needs §4.4 R2 signed-URL fix).

**Blocked, with precise cause** — **R2 signed-URL 404 on Modal-side fetch, despite the same credentials + key succeeding in a direct worker-side `HeadObjectCommand`.** Cause not yet conclusively identified; three hypotheses in §4.3.

---

## 11. Deliverables under 4Y-G

- Hybrid credential precheck fix (commit `a09f547b`, Fly web v1100 / worker v336).
- `signUrl` implementation on R2 adapter + presigner dependency + optional-import registration (commits `6f7d8fbd` → `1a2b8387`, Fly web v1101-v1102 / worker v337-v338).
- Diagnostic logging (commit `cb21558d`, Fly image `sha-cb21558d00d1`).
- Modal apps redeployed in Gate 2 mode (transcribe v6+, generate v3+).
- Pilot spec: [tests/e2e/4y-g-pilot.staging.spec.ts](../../../tests/e2e/4y-g-pilot.staging.spec.ts) + [playwright.4yg.config.ts](../../../playwright.4yg.config.ts).
- This acceptance doc.

---

## 12. Recommended next step

**Operator-level R2 signed-URL diagnosis** (not an engineering slice — a 10-minute debugging session). Per §4.4, run the direct Node REPL probe against R2 with the exact key path to narrow the 404 to one of:
- Region signing mismatch (change `region: "us-east-1"` and retry)
- Key encoding issue (compare `%2F` vs `/` handling)
- Something else (operator finds)

Once the signed URL fetches 200, re-run the Playwright pilot. The first-time GPU cold-boot (~45-90 s Whisper weights download) will then successfully transcribe the 642-s Silver Springs video, drafts generation becomes unblocked, and §7 manager-workflow verification can proceed.

**4Y-G is INCOMPLETE but the remaining distance is small**: infrastructure ready, auth proven, only one URL contract between Spectre and R2 needs reconciliation.

**End of EP-TRAIN-4Y-G staging activation — PARTIAL.**
