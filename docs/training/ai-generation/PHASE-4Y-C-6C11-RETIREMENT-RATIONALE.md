# EP-TRAIN-4Y-C §2 — 6C-11 Operator Path: Retirement Rationale

**Status:** PROPOSAL. Founder authorisation required before cutover.

**Context:** EP-TRAIN-4Y-B-IMPL's deployment runbook §5 claimed the
new Hybrid Modal function would accept the EP-TRAIN-6C-11 legacy
envelope for a 90-day compatibility window. The EP-TRAIN-4Y-B-VERIFY
slice flagged this as a docs/code divergence; EP-TRAIN-4Y-C §2
investigates and reconciles.

---

## 1. What the 6C-11 operator path actually is

**Source:** [scratchpad/ep-train-6b/gen/generate-lite-run.mjs](../../../../dev/SpectreAutomation/scratchpad/ep-train-6b/gen/generate-lite-run.mjs) (lives on the founder's main-tree WIP, not in the verify branch).

Shape of the 6C-11 request:

| Field | 6C-11 value |
|---|---|
| Operation | **`spectre.training.generate.lite.v1`** |
| Target URL | **`web_lite`** Modal app endpoint (distinct from `spectre_training_generate`) |
| Body schemaVersion | **`generate-questions-v2`** |
| Signature encoding | **`hex`** (`.digest("hex")`) |
| Content | `pilotAuthorization` + `grounding` + `mode` + `maxQuestions` + `courseTitle` |
| Contract-version header | **Absent** |

Shape of the new 4yb-v1 request:

| Field | 4yb-v1 value |
|---|---|
| Operation | **`spectre.training.generate.v1`** |
| Target URL | **`spectre_training_generate`** |
| Body `contractVersion` | **`4yb-v1`** |
| Signature encoding | **`base64url` no padding** |
| Content | `pilotAuthorization` + `payload.{modelVariant, systemPrompt, transcript, constraints}` |
| Contract-version header | **Required** |

**Conclusion:** these are not two envelopes on one endpoint. They
are two different Modal apps with two different operations and two
different request-body shapes. The 6C-11 operator path was never
going to route to `spectre_training_generate` regardless of header
handling — it sends `operation = "...generate.lite.v1"` which the
new endpoint's `UNKNOWN_OPERATION` guard refuses.

---

## 2. The runbook §5 claim was architecturally wrong

The prior deploy-rollback runbook §5 stated:

> "the Modal function accepts requests WITHOUT
> `x-spectre-contract-version` as the legacy envelope and returns
> unsigned legacy responses."

That claim could only be implemented by one of two paths, each
worse than retirement:

### Option R — Implement a legacy branch inside `spectre_training_generate.py`

- Detect missing `x-spectre-contract-version` + `operation ==
  "spectre.training.generate.lite.v1"`.
- Parse the `generate-questions-v2` body shape.
- Verify the hex signature with the different signing format.
- Call `run_qwen` with the legacy `grounding` field in place of
  `transcript`.
- Return an unsigned legacy response.

This is a full second code path that duplicates the entire
request-handling stack with weaker security semantics
(unsigned responses, no replay registry integration, no
PilotAuthorizationV1 fingerprint check). It violates §D.6's own
rule: *"New Hybrid contract MUST NOT weaken to accommodate
legacy; both paths coexist via header-based routing."* — a
one-endpoint two-contract implementation isn't header-based
routing, it's security-posture downgrade.

### Option K — Keep the 6C-11 `generate_lite` Modal app running separately

- Leave `spectre_training_generate_lite` deployed at its own URL.
- Operator continues to point `generate-lite-run.mjs` at that URL.
- The new `spectre_training_generate` + `spectre_training_transcribe`
  apps serve the 4yb-v1 contract exclusively.

This is the architecturally honest option. It requires zero code
changes to either side: the 6C-11 app keeps the 6C-11 contract,
the new apps keep the 4yb-v1 contract, they coexist as separate
Modal deployments.

### Option T — Retire the 6C-11 operator path at Hybrid cutover

- Stop the `spectre_training_generate_lite` Modal app on the first
  Hybrid deploy.
- `generate-lite-run.mjs` returns connection-refused / 404.
- Operator either upgrades to a new 4yb-v1-compatible workstation
  script OR stops using the diagnostic path.

---

## 3. Who depends on the 6C-11 operator path?

Evidence:

- **No tenant / customer** uses `generate-lite-run.mjs`. It runs on
  the founder's workstation (Chris's machine), invoked via
  PowerShell, with secrets stored in SPECTRE-SEC-1 DPAPI.
- **No Spectre application code** calls `generate-lite-run.mjs`.
  The web + worker tier use the new `callModalTranscribe` /
  `callModalGenerate` clients.
- **Zero traffic** has flowed through the 6C-11 endpoint since its
  single 2026-11-04 deployment (5 A10 generations, $0.029 metered,
  per the EP-TRAIN-4Y-A preflight audit).

The 6C-11 path is an operator diagnostic tool, not a production
dependency.

---

## 4. Recommendation — Option T (retire)

The Spectre web + worker uses the new Hybrid contract exclusively.
The 6C-11 operator path provides no ongoing value that justifies
either Option R's security downgrade or Option K's dual-spend of
GPU cold-boot / idle cost.

**Proposed cutover:**

1. On the first authorised Hybrid deploy, the operator ALSO runs:
   ```
   modal app stop spectre_training_generate_lite
   ```
2. The `generate_lite` Modal app remains in the workspace listing
   (not deleted), so it can be re-started if needed for forensic
   purposes.
3. The deploy-rollback runbook is updated to this document.
4. If a future operator-diagnostic need arises, a new
   workstation-local script is written against the 4yb-v1 contract
   (reuses `issuePilotAuthorization` + `signRequest` + `verifyResponseSignature`
   from `src/lib/hr/training/modal-shared/`).

**Residual risk:** zero — no tenant, customer, or production code
depends on the 6C-11 operator path.

**Alternative:** Option K (keep both apps running) is also
acceptable. It costs one extra idle Modal app in the workspace and
no additional Spectre-side maintenance. If the founder prefers
Option K over Option T, the deploy runbook §5 can be updated to
document the dual-Modal-app state.

---

## 5. Explicit founder-authorisation required

Per EP-TRAIN-4Y-C directive §2 — *"Either implement the explicitly
approved 90-day compatibility path securely or demonstrate why it
must be retired and STOP for founder authorization"* — this slice
STOPS here on §2 and surfaces the decision in the final acceptance
report.

**Three paths:**

- **T** (recommended): retire the 6C-11 operator path at Hybrid
  cutover (stop the Modal app).
- **K**: keep both Modal apps running independently; no code
  change needed; cost is one idle Modal app worth of workspace
  storage / cold-boot.
- **R**: implement a legacy branch in the new Python endpoint
  (NOT recommended — see §2.R above for the security-downgrade
  argument).

No code implementing any path has been written in this slice. The
new endpoints currently REJECT legacy envelopes with
`REQUEST_HMAC_INVALID` (safe, closed). Whichever path the founder
authorises, the subsequent operator-deploy slice makes it happen.

**End of 6C-11 retirement rationale.**
