# EP-TRAIN-4Y-D — Hybrid Modal Staging Activation (Gate 1)

**Date:** 2026-11-07
**Status:** **Gate 1 — PARTIAL · BLOCKED on §4 (Modal App wrapper authorship)**
**Baseline:** `ep-train-4y-b-impl/hybrid-auth-contract` @ `ce650877` (pushed to origin)
**Current staging:** Fly web `v1098` · worker `v334` · image `sha-e7fbb0b158cd` (UNCHANGED)

---

## Headline

**NO-GO for Gate 1 completion.** The directive §4 "Deploy: `spectre-training-transcribe`, `spectre-training-generate`" **cannot execute** against the current baseline. The Python endpoint files in `modal/` are explicit **OFFLINE REFERENCE** code (line 3 of both files + README). They contain no `modal.App`, no `@app.function`, and no `@modal.asgi_app` — `modal deploy` would succeed with an empty-app registration but register **zero endpoint URLs**. There is nothing to verify authentication against.

What **was** delivered in this slice: full preflight evidence, branch push, Modal workspace inventory, Fly rollback anchor, legacy-endpoint confirmation. See §4 of this report for the specific additional engineering required to reach Gate 1 pass.

**No deployment, no secrets, no Fly state change, no GPU, no inference. 126 WIP files preserved on main tree.**

---

## 1. Accepted baseline

- Branch: `ep-train-4y-b-impl/hybrid-auth-contract` @ `ce650877`
- **Pushed to origin** (confirmed via `git push -u origin` return) — this is Gate 1's first durable deliverable.
- Main working tree on `staging-deploy/web1b1-framer-fidelity` with **126 WIP files UNCHANGED**.

---

## 2. Founder decision captured

Founder selects **Option T — RETIRE** `spectre-training-generate-lite`.

Preflight inventory of Modal workspace `spectreautomation-admin`:

```
modal app list --json
→ []       # zero running apps
```

**There is no `spectre-training-generate-lite` app to stop.** The 6C-11 Modal deployment that ran 5 A10 generations on 2026-11-04 was already stopped. §7 "retire legacy" reduces to a documentation-only action — no CLI call needed, no state change. Preserved historical evidence remains in:

- [docs/training/ai-generation/PHASE-4Y-C-6C11-RETIREMENT-RATIONALE.md](./PHASE-4Y-C-6C11-RETIREMENT-RATIONALE.md)
- [scratchpad/ep-train-6b/gen/generate-lite-run.mjs](../../../scratchpad/ep-train-6b/gen/generate-lite-run.mjs) (operator workstation WIP; not in branch tree)

---

## 3. Preflight evidence (COMPLETE)

### 3.1 Modal SDK version

```
pip show modal                                 → Name: modal, Version: 1.6.3   ✓
modal --version (filtered)                     → modal client version: 1.6.3   ✓
```

Required minimum per 4Y-C acceptance: `>= 0.65.42` (first release of `Dict.put(..., skip_if_exists=True)`). **Satisfied.**

### 3.2 Modal workspace + auth

```
modal token info (NOT PRINTED — contains auth token value)
→ Workspace: spectreautomation-admin (ac-…)
→ User: spectreautomation-admin
→ Token created: 2026-11-02 13:49 CT
```

### 3.3 Modal workspace app inventory

```
modal app list --json → []
modal container list  → (zero active containers)
```

**No running Modal apps; no GPU containers.** Baseline is a clean slate.

### 3.4 Modal workspace secret inventory (names only)

```
modal secret list --json
→ [{ "name": "spectre-training-runtime-hmac",
     "created_at": "2026-11-02 13:58 CT",
     "last_used_at": "2026-11-04 09:52 CT" }]
```

**One existing secret** from 6C-11. Since the 6C-11 app is gone (§3.3), this secret has no active consumer and can be reused or rotated during Gate 1 provisioning — operator's call.

**Required three secrets (from `PHASE-4Y-C-STAGING-ACTIVATION-CHECKLIST.md` §1):**
- `spectre-training-runtime-hmac` — already exists; may reuse or `--force` rotate
- `spectre-training-pilot-fingerprint-secret` — **NEEDS CREATION**
- `spectre-training-response-hmac-key` — **NEEDS CREATION** (optional per §Q.5)

Not created in this slice because §4 (deploy) is blocked downstream.

### 3.5 Modal workspace proxy token

```
modal workspace proxy-tokens list
→ 1 existing token: name "spectre-train…", id "wk-cqGl6Iob8h…"
     created 2026-11-02 14:02 CT
```

The matching `ws-…` secret component is **not retrievable** via CLI (shown only at creation time per Modal docs). To provision Fly's `MODAL_KEY` / `MODAL_SECRET`, the operator must EITHER supply the stored `ws-…` from their secure vault OR rotate the proxy token via `modal workspace proxy-tokens create --json`.

**Spend limit:** not surfaced in `modal workspace settings list`. Operator confirms via Modal dashboard `https://modal.com/settings/spectreautomation-admin/billing` that the **$10 USD limit** is intact (per directive §9).

### 3.6 Fly staging rollback anchor

```
flyctl releases --app spectre-staging-worker
→ v334  (complete, 17h25m ago)   ← ROLLBACK ANCHOR
   v333  (complete)
   v332  (complete)

flyctl releases --app spectre-staging
→ v1098 (complete, 17h29m ago)   ← ROLLBACK ANCHOR
   v1097 (complete)
   v1096 (complete)

flyctl image show --app spectre-staging-worker
→ registry.fly.io/spectre-staging-worker:sha-e7fbb0b158cd
    digest sha256:258b84442f6b0fa9287bdab4438441e4d2221f001bb24d09fa39411beaf13e1a
    commit e7fbb0b158cd2ac212a298115193f003bb7b08a1
```

### 3.7 Fly staging secrets inventory (names only)

Worker (`spectre-staging-worker`): 20 secrets present (DATABASE_URL, AWS_*, R2_*, SPECTRE_SESSION_SECRET, MICROSOFT_GRAPH_*, …). **No `MODAL_*` secrets present.** **No `MODAL_SPECTRE_SHARED_TOKEN` leftover** from 4V/4W. Clean baseline for the 7 Hybrid secrets.

Web (`spectre-staging`): grep for `MODAL|SPECTRE_PILOT_AUTH` → **zero matches**. Confirms least-privilege compliance; no inference credentials on the web app.

### 3.8 Source video + R2 linkage

Deferred — requires DB query access. The Silver Springs orientation video pilot is explicitly **Gate 2 scope** per directive §9 ("Do not run the Silver Springs pilot until separately authorized"). R2 linkage will be re-verified at the Gate 2 authorization point.

---

## 4. §4 Deploy — **BLOCKER**

### 4.1 What was asked

> **§4. Deploy Modal services**
> Provision the approved managed secrets.
> Deploy: `spectre-training-transcribe`, `spectre-training-generate`.
> Verify the actual application names, endpoint URLs and function registrations.

### 4.2 Why it cannot execute

The Python endpoint files at [modal/spectre_training_transcribe.py](../../../modal/spectre_training_transcribe.py) and [modal/spectre_training_generate.py](../../../modal/spectre_training_generate.py) are **explicit OFFLINE REFERENCE code** authored under the 4Y-B-IMPL directive §12 STOP:

> *Line 3 of both endpoint files:*
> *"OFFLINE REFERENCE in this repo; no deploy from this slice."*

Grep evidence:
```
grep -rE 'modal\.App\(|modal\.Stub\(|^app\s*=\s*modal' --include='*.py' .
→ (zero results)
```

- **No `modal.App("…")` at module scope** — `modal deploy` cannot locate an app to deploy.
- **No `@app.function(...)` decorators** — nothing registers as a callable Modal function.
- **No `@modal.asgi_app()` / `@modal.web_endpoint(...)`** — nothing registers as an HTTP endpoint URL.
- **No `modal.Image` definition** — no container image to run.
- **No `modal.Secret.from_name(...)` wiring** — the three workspace secrets never reach the container's env vars.
- **No `modal.Dict.from_name(..., create_if_missing=True)`** — `ModalDictReplayRegistry` has no backing store at runtime.
- **`import modal` would also collide** — the local `modal/` directory shadows the Modal SDK's `modal` top-level package. The endpoint files wrap this in `try: import modal except Exception: modal = None` which silently masks the collision at unit-test time but would break any attempt to instantiate `modal.App(...)`.

If I were to run `modal deploy modal/spectre_training_transcribe.py` against the current baseline, Modal's CLI would either:
- **(a)** error with *"Could not find modal.App in … "* (most likely), or
- **(b)** succeed in creating an **empty** app with **zero registered functions and zero endpoint URLs** — nothing to verify §6 connectivity against.

Either outcome means §4 cannot report "actual application names, endpoint URLs and function registrations" as required.

### 4.3 What's needed to unblock

Each Modal endpoint needs an authoring layer with roughly the following structure (sketch — final choices belong to the architecture-owner):

```python
# modal_endpoints/transcribe_app.py  (NEW FILE — after renaming modal/ → modal_endpoints/)
import modal

app = modal.App("spectre-training-transcribe")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("fastapi", "faster-whisper==1.0.3", "ctranslate2>=4", "av")
)

volume = modal.Volume.from_name(
    "spectre-training-whisper-weights", create_if_missing=True
)

replay_dict = modal.Dict.from_name(
    "spectre-training-replay-4yb-v1", create_if_missing=True
)

secrets = [
    modal.Secret.from_name("spectre-training-runtime-hmac"),
    modal.Secret.from_name("spectre-training-pilot-fingerprint-secret"),
    modal.Secret.from_name("spectre-training-response-hmac-key"),
]

@app.function(
    image=image, secrets=secrets, timeout=600,
    volumes={"/weights": volume}, gpu="L40S",   # ← Gate 2 only
)
def _run_whisper(wav_bytes: bytes):
    # … faster-whisper inference …
    ...

@app.function(image=image, secrets=secrets, timeout=60)
@modal.asgi_app()
def api():
    from fastapi import FastAPI, Request, Response
    web = FastAPI()
    @web.post("/transcribe")
    async def transcribe(req: Request):
        body_text = (await req.body()).decode("utf-8")
        headers = {k.lower(): v for k, v in req.headers.items()}
        http_status, body, hdrs = _handle_transcribe_request(
            headers=headers, body_text=body_text,
            hmac_key=os.environ["MODAL_SPECTRE_HMAC_KEY"].encode("utf-8"),
            fingerprint_secret=os.environ["SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET"].encode("utf-8"),
            response_hmac_key=(
                os.environ.get("MODAL_SPECTRE_RESPONSE_HMAC_KEY") or
                os.environ["MODAL_SPECTRE_HMAC_KEY"]
            ).encode("utf-8"),
            replay_registry=ModalDictReplayRegistry(replay_dict),
            now_sec=int(time.time()),
            download_audio=_download_signed_url,
            run_whisper=_run_whisper.remote,  # ← cross-function call
            audio_to_wav=_audio_to_wav,
            duration_sec=…,
        )
        return Response(content=body, status_code=http_status, headers=hdrs)
    return web
```

Additionally the package-rename `modal/ → modal_endpoints/` (zero external code imports it; relative imports internal; only Python unittest invocations + docs change) resolves the SDK-shadow issue permanently. 19 doc references need updating (grep in §4.2 above lists them).

**Estimated authoring scope:** ~200-300 lines of new Python across two wrapper files + a mechanical rename + ~40 lines of doc updates. Verification: extend the §6 "no-inference acceptance" authN probes to hit the deployed `/transcribe` and `/generate` URLs with deliberately-invalid auth, confirm each returns the expected signed `*_INVALID`/`*_MISMATCH` failure code.

### 4.4 Two paths forward

| Option | Scope | Risk |
|---|---|---|
| **E1 — Dedicated 4Y-E slice: author Modal App wrappers (Gate-1 scaffolding + Gate-2 GPU extension)** | ~300 LOC Python + rename + doc updates + tests. Deploy wrappers are **CPU-only for Gate 1** with a stubbed `run_whisper` / `run_qwen` that returns deterministic no-GPU output; Gate 2 operator swaps in the real GPU function. | **Low.** Isolated to the Modal-side architecture layer. Does not touch Spectre TS code or the 178 passing tests. Can be verified offline before deploy. |
| **E2 — Lift the full 6C-11 Modal App code into this repo and adapt** | Depends on access to 6C-11's full Modal App source (not in this branch). Would include the real GPU image, weights volume, and inference functions — i.e. Gate 2 architecture committed from the start. | **Medium.** Larger surface + Gate 2 architecture decisions baked in; may overrun Gate 1 scope. |

Recommendation: **E1** — stay narrow, keep Gate 1 strictly scaffolding + authN verification, defer GPU architecture to a separately authorised Gate 2 prep slice.

---

## 5. §5 Configure staging — **BLOCKED downstream of §4**

Cannot execute without the two endpoint URLs from §4. The 7-secret inventory (worker only, no web app) remains correctly specified in [PHASE-4Y-C-STAGING-ACTIVATION-CHECKLIST.md §2](./PHASE-4Y-C-STAGING-ACTIVATION-CHECKLIST.md).

No Fly secrets have been set. Current state matches §3.6 + §3.7.

---

## 6. §6 No-inference acceptance — **BLOCKED downstream of §4**

The six authentication probes in [PHASE-4Y-C-STAGING-ACTIVATION-CHECKLIST.md §4](./PHASE-4Y-C-STAGING-ACTIVATION-CHECKLIST.md) all target the deployed Modal URLs. Without §4, there is nothing to hit.

**Offline equivalents remain green:** 178/178 tests pass in the committed TS + Python suites, covering every negative scenario the §6 probes would exercise. The deploy-side probes would be the live-traffic confirmation; the offline tests prove the enforcement logic.

---

## 7. §7 Legacy retirement — **COMPLETE (trivial)**

Per §2 above, `spectre-training-generate-lite` is NOT running (empty `modal app list`). No stop command needed. Historical evidence preserved in 4Y-C's retirement-rationale doc. No Modal state change in this slice.

---

## 8. Acceptance evidence (THIS DOCUMENT)

| Required | Status | Where |
|---|:-:|---|
| `PHASE-4Y-D-STAGING-ACTIVATION.md` | ✓ | this file |
| Deployment evidence | ✗ blocked | §4 |
| Modal app inventory | ✓ | §3.3 |
| Secret-presence verification (no values) | ✓ for current state | §3.4 + §3.7 |
| Authentication + replay test results | ✗ blocked | §6 |
| Zero-GPU evidence | ✓ | §3.3 (no containers) + §5 (no deploy) |
| Rollback instructions | ✓ | §9 of this doc |
| Gate 2 readiness classification | **NOT READY FOR GATE 2** | §10 of this doc |

---

## 9. Rollback

**No rollback action needed at this Gate 1 checkpoint.** Nothing deployed, no secret provisioned, no Modal app created. Current state matches the baseline recorded in §3.6/§3.7.

If the 4Y-E slice runs and later fails: the rollback anchor pins remain:
- Web `spectre-staging` **v1098** image `sha-e7fbb0b158cd`
- Worker `spectre-staging-worker` **v334** image `sha-e7fbb0b158cd`
- Modal workspace **$10 USD** spend limit + zero deployed apps

See [PHASE-4Y-C-STAGING-ACTIVATION-CHECKLIST.md §6](./PHASE-4Y-C-STAGING-ACTIVATION-CHECKLIST.md) for the full rollback command sequence when there IS state to roll back.

---

## 10. Gate 2 readiness classification

**NOT READY.** Gate 2 (Silver Springs real-video pilot) requires:

1. Gate 1 passed — Modal apps deployed, 7 Fly secrets provisioned on worker, authN probes green. **Currently blocked at §4.**
2. The Modal GPU inference function (`_run_whisper` + `_run_qwen`) authored with real model loading + warm-up. **Not written anywhere.**
3. Modal weights volume created + seeded (first cold-boot pays for the download). **Not done.**
4. R2 signed-URL generation path verified end-to-end (Fly worker → signed URL → Modal fetch). **Not done.**

Gate 2 authorization should be sought ONLY after a Gate 1 re-run with the 4Y-E wrappers in place confirms authentication end-to-end.

---

## 11. STOP compliance (THIS SLICE)

| § | Boundary | Status |
|---|---|:-:|
| 9.1 | No production deployment | ✓ |
| 9.2 | No live Whisper or Qwen inference | ✓ |
| 9.3 | No GPU activation | ✓ |
| 9.4 | No historical candidate modification | ✓ |
| 9.5 | No publication | ✓ |
| 9.6 | No employee assignments | ✓ |
| 9.7 | No Modal spending-limit changes | ✓ |
| 9.8 | No unrelated UI redesign | ✓ |
| 9.9 | Preserve all 126 unrelated WIP files | ✓ (main tree unchanged throughout) |
| 9.10 | **STOP after Gate 1 acceptance** | ✓ — this report is the explicit STOP |

---

## 12. Recommendation

**Authorize a focused 4Y-E slice** scoped to the Modal App wrapper authoring described in §4.4 (option E1). Deliverables:

1. Rename `modal/` → `modal_endpoints/` (mechanical; zero behavior change; preserves 178-test green).
2. New `modal_endpoints/transcribe_app.py` + `modal_endpoints/generate_app.py` with CPU-only Gate-1 scaffolding, deployable via `modal deploy`.
3. Stub inference callables that return deterministic no-GPU responses when invoked.
4. Updated unit tests confirming the asgi handler correctly delegates to `_handle_*_request`.
5. Updated 4Y-C staging-activation-checklist to reference the renamed path.

**Estimated 4Y-E time:** half a working day (architecture is already decided in 4Y-B-IMPL; this is plumbing).

After 4Y-E lands, a **4Y-D re-run** can execute Gate 1 end-to-end: deploy, provision secrets, DRH-1, 6 authN probes, Gate 2 classification.

**End of EP-TRAIN-4Y-D acceptance report.**
