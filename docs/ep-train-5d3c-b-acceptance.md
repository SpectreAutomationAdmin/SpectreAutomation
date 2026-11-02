# EP-TRAIN-5D-3C-B — Acceptance Report

**Date:** 2026-11-02
**Author of operation:** founder (Chris Turcato, `cmrvdenz700034437agp7gqs5`)
**Driver:** Claude Opus 4.7 under the founder's EP-TRAIN-5D-3C-B directive
**Environment:** `spectre-staging` only — no production action taken.
**Final staging baseline:** `sha-f59afa2` + Fly release `v1090` (web).

## §1 Objective

Repair the structurally defective ORIENTATION_2027 v3 by reconstructing a
correct v4 from the intact v2 instructional content, using the real
`publishDraft` service, without issuing new employee obligations.

## §2 Approach (founder-authorised Option 2 of 5D-3C-A)

Add a narrowly scoped, staging-only administrative endpoint that invokes
the real `publishDraft` service; remove it after successful execution.
Two deployments through DRH-1:

| Phase | Commit | Fly release | Image |
|-------|--------|-------------|-------|
| Rollback anchor | `0853d59` (EP-TRAIN-5D-3B closure) | v1086 | `sha-0853d59f990c` |
| Deploy #1 (endpoint add) | `f418d29` | v1087 | `sha-f418d2971ad3` |
| Secret apply (`SPECTRE_5D3C_RECONSTRUCT_ENABLED=1`) | (no code change) | v1088 | `sha-f418d2971ad3` |
| Deploy #2 (endpoint removal) | `f59afa2` | v1089 | `sha-f59afa2f51c5` |
| Secret unset (clean) | (no code change) | v1090 | `sha-f59afa2f51c5` |

GitHub Actions runs: `41491171712` (Deploy #1, 15m1s success) + `41494037218` (Deploy #2, success).

## §3 Code shipped in Deploy #1 (removed in Deploy #2)

Three files, 651 lines added then deleted:

1. [src/app/api/dev/5d3c-reconstruct/route.ts](../src/app/api/dev/5d3c-reconstruct/route.ts) — temporary admin endpoint with seven defence-in-depth guards:
   - `process.env.FLY_APP_NAME === "spectre-staging"` (physical gate).
   - `process.env.SPECTRE_5D3C_RECONSTRUCT_ENABLED === "1"` (secret-flag gate).
   - `getCurrentPrincipal()` session (iron-session cookie, not a static secret).
   - `caller.email === "cturcato@spectreautomation.com"` (founder allowlist).
   - `hasPermission(caller, COULEE_CLUB_ID, "hr:training:publish")` (RBAC).
   - Hard-coded Orientation IDs match the request body verbatim; unknown parameters refused.
   - Baseline obligation shape must match `{OUTSTANDING: 1, SUPERSEDED: 1, CANCELED: 5}`; otherwise refused with 409.
   - Calls the real `publishDraft` from `@/lib/hr/training/courses` for publication.
2. [src/lib/hr/training/reconstruct-5d3c-helper.ts](../src/lib/hr/training/reconstruct-5d3c-helper.ts) — clone helper for an explicit non-latest source, preserving checkpoints, `question.questionType`, and `question.checkpointId` FK remap. Writes `hr.training.version.draft` via the standard `audit()` service.
3. [tests/hr/training/reconstruct-5d3c.test.ts](../tests/hr/training/reconstruct-5d3c.test.ts) — 9 regression scenarios (§6 of directive): cross-tenant rejection, missing/mismatched source, wrong `passingScore`, structural preservation (checkpoints + `TRUE_FALSE` + `checkpointId` remap + options), sequential-version math, zero obligation issuance, source byte-identity, audit shape. **9/9 PASS** before Deploy #1.

Supporting regression coverage: the broader `tests/hr/training` suite ran clean (79/79 PASS) between Deploy #1's commit and push.

## §4 Preflight (READ-ONLY, before execution)

| Check | Result |
|-------|--------|
| v2 intact: 2 checkpoints, 6 questions, TRUE_FALSE preserved | PASS |
| v3 is current PUBLISHED but structurally defective (0 checkpoints, questionType downgraded) | PASS (defect confirmed) |
| v3 zero engagement (0 attempts/completions/in-flight progress) | PASS |
| 5 CANCELED v3 REVISION obligations intact (issuanceKeys preserved) | PASS |
| Marc Orientation v2 INITIAL `cmvzb74ed0002g41rrbxtlyk5` → status=`SUPERSEDED`, supersededBy=`cmvzdkr86001qwu9jckxe8wp2` | PASS |
| Marc Fire Safety INITIAL `cmvzb74i90007g41ryj0d7rc2` → status=`OUTSTANDING` | PASS |
| Founder record `{completions:9, attempts:30, progress:9}` | PASS |
| Obligation universe = 7 (`OUTSTANDING:1, SUPERSEDED:1, CANCELED:5`) | PASS |
| Deployed sha-00ef288 EP-TRAIN-5D-3 clone fix in-place | PASS |
| Founder principal CLUB_ADMIN with `hr:training:publish` on Coulee Ridge | PASS |
| v2/v3 metadata differed only in `passingScore` (v2=80, v3=85) → founder authorised v4.passingScore=80 (match v2) | PASS |

## §5 Execution

Driver: Playwright-based login flow using `.env.playwright.local` founder
credentials; iron-session cookie inherited by `APIRequestContext`; one
HTTP `POST /api/dev/5d3c-reconstruct` with the exact expected body:

```json
{
  "expectedCourseId": "cmvvgznyf000gz9nu3nbqm09q",
  "expectedSourceVersionId": "cmvwwd7vw004jjjkgpzpn5tzx",
  "expectedCurrentVersionId": "cmvzdjzt10002wu9jpfsp9hjc",
  "expectedPassingScore": 80
}
```

Response: HTTP 200, `ok: true`, zero errors. Full response captured at
`scratchpad/5d3c-b-driver-1793641378164.json`.

Operation performed by the endpoint:

- **TX1 (clone helper)** — created v4 DRAFT `cmvzjrk8c000ac8zqw0ui8os5` cloned from v2 `cmvwwd7vw004jjjkgpzpn5tzx`, with 2 checkpoints (new ids), 6 questions (checkpointId remapped, questionType preserved), 15 answer options, `passingScore=80`. Audit `hr.training.version.draft` written at `2026-11-02T17:42:57.748Z` by founder with `clonedFromVersion: 2, slice: EP-TRAIN-5D-3C-B`.
- **TX2 (real `publishDraft` service)** — retired v3 at `2026-11-02T17:42:58.043Z`, published v4 at the same instant, flipped `course.currentVersionId` to v4, wrote the standard `hr.training.version.publish` audit at `2026-11-02T17:42:58.251Z` by founder.

## §6 Post-execution verification

### v4 structural fidelity (vs v2)

| Field | v2 (source, now RETIRED) | v4 (now PUBLISHED) |
|-------|--------------------------|---------------------|
| title | Coulee Ridge Staff Orientation | same |
| description | Orientation for the upcoming golf season | same |
| passingScore | 80 | **80** ✅ |
| retakesAllowed / requiresKnowledgeTest / appliesToAll / required | true / true / true / true | same |
| videoStorageKey / videoDurationSec | `…bc79` / 51 | same |
| checkpointCount | 2 | 2 |
| checkpoint 1 (Blah Blah @10s, maxRetries 3, requiredToProceed) | — | preserved |
| checkpoint 2 (Ta Dah @13s, maxRetries 3, requiredToProceed) | — | preserved |
| questionCount | 6 | 6 |
| checkpoint-bound questions | 2 | **2** (fixed from v3's 0) |
| final-assessment questions | 4 | 4 |
| TRUE_FALSE on "Ta dah?" | yes | **TRUE_FALSE** (fixed from v3's downgrade to SINGLE_CHOICE) |

### Preservation (§4 of directive)

| Preservation condition | Before | After |
|------------------------|--------|-------|
| 5 v3 REVISION obligations CANCELED | 5 CANCELED | 5 CANCELED (same ids, same `issuanceKey`s) ✅ |
| Marc v2 INITIAL SUPERSEDED | SUPERSEDED → `cmvzdkr86001qwu9jckxe8wp2` | SUPERSEDED → `cmvzdkr86001qwu9jckxe8wp2` ✅ |
| Marc FIRE_SAFETY INITIAL OUTSTANDING | OUTSTANDING | OUTSTANDING ✅ |
| Founder TrainingCompletion | 9 | 9 ✅ |
| Founder TrainingAttempt | 30 | 30 ✅ |
| Founder TrainingProgress | 9 | 9 ✅ |
| Total TrainingObligation rows | 7 | 7 ✅ (zero new rows) |
| Obligation status mix | `{OUTSTANDING:1, SUPERSEDED:1, CANCELED:5}` | same ✅ |
| v2 content | 2 checkpoints, 6 questions, TRUE_FALSE preserved | byte-identical ✅ |
| v3 content | 0 checkpoints, 6 all-SINGLE_CHOICE questions | byte-identical, state now RETIRED ✅ |

### Scheduling eligibility (compliance delta)

Per-employee outstanding-course count unchanged by the operation (confirmed
by direct scheduling-eligibility query against staging):

| Employee | Pre-execution outstanding | Post-execution outstanding |
|----------|---------------------------|-----------------------------|
| E-FOUNDER-DEMO `cmvvgku5e00022ml0iz618mul` | 10 | 10 ✅ |
| E-00002 (Chris, founder) `cmu0fiaod000187prcy9ufo2d` | 3 | 3 ✅ |
| E-00003 (Marc) `cmu0ndf4p001vk9md2ntmo2ck` | 8 | 8 ✅ |
| E-PAY1A-Test-A `cmuizrw1w000cgmtia9hma0b6` | 10 | 10 ✅ |
| E-PAY1A-Test-B `cmuizrw4j000ggmtiq6yutgtz` | 10 | 10 ✅ |

Marc's compliance for ORIENTATION_2027 is `INITIAL_REQUIRED_INFERRED` on
v4 (the resolver infers because he has no completion on v4 and the course
remains applicable); this is identical in behaviour to his pre-execution
compliance on v3. His legacy scheduling-eligibility list carries
ORIENTATION_2027 in both states, so no gate was created or removed.

### Audit chain (fetched post-execution)

- `hr.training.version.draft` `cmvzjrkk4001kc8zqvz3zfoif` — userId=founder, clubId=Coulee, entityId=v4, `afterJson.clonedFrom=v2`, `afterJson.slice=EP-TRAIN-5D-3C-B`, HeadlessChrome user agent (Playwright driver).
- `hr.training.version.publish` `cmvzjrky3001nc8zq0ty4vxcc` — userId=founder, clubId=Coulee, entityId=v4, `afterJson.version=4`, `afterJson.publishedAt=2026-11-02T17:42:58.043Z`, same HeadlessChrome user agent.

Both events written by the real `audit()` service through the standard
`AuditLog` table; both attribute the mutation to the founder principal.

## §7 Cleanup

- **Deploy #2 (`sha-f59afa2`, Fly v1089)** removed all three temporary files (route + helper + tests). `npm run typecheck` clean.
- **Secret `SPECTRE_5D3C_RECONSTRUCT_ENABLED` unset + redeployed as Fly v1090** so the flag is no longer in the environment.
- **Final endpoint verification:** `POST /api/dev/5d3c-reconstruct` → HTTP 404. `/api/health` → 200.
- **No secrets remain in staging matching `5d3c`** (confirmed via `flyctl secrets list`).

## §8 STOP boundaries honoured

| Boundary | Status |
|----------|--------|
| No NO_RETAKE policy introduced | ✅ |
| `publishDraftWithPolicy` unmodified | ✅ |
| No bulk assignment path | ✅ |
| No employee-facing training UX change | ✅ |
| Compliance resolver unmodified | ✅ |
| Scheduling enforcement unmodified | ✅ |
| No superseded obligation restored | ✅ |
| No historical version deleted | ✅ |
| No production deploy | ✅ |

## Residual risk

None material to the operation. Marc's SUPERSEDED pointer still targets
the now-RETIRED-course + CANCELED-obligation `cmvzdkr86001qwu9jckxe8wp2`;
this is historically accurate (the supersession happened; the superseding
obligation was later cancelled). The resolver treats Marc as
`INITIAL_REQUIRED_INFERRED` on ORIENTATION_2027 v4, which is the correct
behaviour: Marc still needs the orientation, no outstanding obligation is
persisted, but applicability + required=true cause the inference. A
future slice may elect to repair the SUPERSEDED pointer to the current
PUBLISHED v4 or to re-issue Marc an INITIAL obligation against v4 — out
of scope for 5D-3C-B.

## Current staging state

- `ORIENTATION_2027` course `cmvvgznyf000gz9nu3nbqm09q`:
  - `currentVersionId = cmvzjrk8c000ac8zqw0ui8os5` (v4)
  - v1 RETIRED, v2 RETIRED, v3 RETIRED, v4 PUBLISHED
- Marc's two INITIAL obligations and compliance state intact per the table above.
- Founder record `{9, 30, 9}` byte-identical.
- Fly release `v1090` on image `sha-f59afa2f51c5`.
- Rollback anchor: v1086 (`sha-0853d59f990c`, EP-TRAIN-5D-3B closure).

**EP-TRAIN-5D-3C-B is ACCEPTED and CLOSED on staging. STOPPING.**
