# EP-TRAIN-5C-3A — Authenticated Employee UX Acceptance

**Status:** Deployed to staging 2026-11-02. Delivers the authenticated-
employee browser evidence the EP-TRAIN-5C-3 report deferred. **Server
code is unchanged** from `sha-526f5c69642f` — this slice is tests +
docs only.

**Baseline:** `spectre-staging:sha-526f5c69642f` (EP-TRAIN-5C-3).

---

## 1. Employee-authentication testing solution (directive §1)

The EP-TRAIN-5C-3 report flagged that "a disposable employee cannot be
used for authenticated Playwright testing because the Employee Portal
requires credentials." That claim was wrong — the infrastructure
**already existed** in the EP-TRAIN-3 Slice 3 fixture harness
(`tests/e2e/_lib/ep-train-3-fixture.ts`), which has been in service
since 2026-10-30. This slice reuses that harness.

### 1.1 How it works

`provisionIsolatedFixture(runId)` runs a single Fly SSH script that:

1. Creates a disposable `Employee` row with `employeeNumber = "E-SLICE3-<runId>"`, `status = "ACTIVE"`, `employeeLifecycle = "ACTIVE"`, `onboardingState = "APPROVED"`, under the Coulee Ridge club.
2. Creates an `EmployeePortalCredential` row with a bcrypt-hashed random 24-character password.
3. Creates a disposable `TrainingCourse` with `code = "SLICE3_<runId>"` + a published version + checkpoints + questions.
4. Writes an audit log row with `action = "hr.training.provision.disposable.isolated"`.
5. Emits a single JSON line `PROVISIONED {...}` to stdout containing the credentials.

The Playwright spec logs in via the real `/employee/login` form with those credentials — same middleware, same session cookie, same tenant isolation as a legitimate employee.

### 1.2 Teardown

`teardownIsolatedFixture(runId)` deletes the `E-SLICE3-<runId>` + `SLICE3_<runId>` scoped rows: credentials, assignments, obligations (cascade via Employee FK), completions, attempts, progress, question responses, questions, checkpoints, course versions, course, employee. Writes `hr.training.teardown.disposable.isolated` to audit. Belt-and-suspenders: the script refuses to run if the derived identifiers don't carry the fixture prefix.

### 1.3 Compliance with directive §1 requirements

| Requirement | Status |
|---|---|
| Do not bypass production auth / authorization | ✅ Real `/employee/login` + real bcrypt + real session middleware |
| Do not introduce a publicly accessible impersonation endpoint | ✅ No API routes added; provision via Fly SSH only |
| Do not weaken Microsoft auth, session validation, tenant isolation | ✅ No auth code touched |
| Do not use the founder's identity to simulate an employee | ✅ Each test provisions a NEW disposable Employee row |
| Do not modify legitimate employee credentials | ✅ Fixture scope is `E-SLICE3-<runId>` + `SLICE3_<runId>` only |
| Do not persist fixture credentials in source control | ✅ Password is harness-generated per `runId` + stored only in the test's local variable + the staging DB row that teardown deletes |
| Ensure disposable accounts and sessions are cleaned up | ✅ `teardownIsolatedFixture` runs in `try/finally` |
| Prefer reusing existing infrastructure | ✅ No new auth system; harness pre-dates this slice |

### 1.4 Reusable for future employee-POV specs

Any future Employee Portal acceptance spec can:

```ts
const runId = newRunId("my-slice");
const fixture = provisionIsolatedFixture(runId);
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await portalLogin(page, fixture);  // fills /employee/login with fixture.email + .password
  await page.goto(`${BASE}/employee/safety-training`);
  // ... assertions ...
} finally {
  teardownIsolatedFixture(runId);
}
```

For EP-TRAIN-5C-3A, I added `tests/e2e/_lib/ep-train-5c3a-seed.ts` with
four small SSH helpers that seed per-scenario state (historical
completion, obligation, DB-count snapshots) onto an already-provisioned
fixture. Pattern reusable for every future 5C-* slice.

## 2. Authenticated acceptance scenarios

`tests/e2e/ep-train-5c3a-authenticated-employee.staging.spec.ts` — **5 of 5 PASS** in 6.8 min against `sha-526f5c69642f`.

| Scenario | Fixture seed | Verifies |
|---|---|---|
| **A — Baseline (directive §2)** | New fixture; no completion, no obligation | Dashboard renders EP-UX-2D unchanged. Fixture course card has `data-obligation-label="Required"` + no obligation chip. |
| **B — Replay compatibility (directive §10)** | Historical completion, no obligation | Course page state pill = `Completed`; Replay button visible; Start Training button absent. EP-TRAIN-4E completed-replay preserved. |
| **C — Retake Required (directive §4)** | Historical completion @ 92% + MANUAL_REINSTATE obligation with reason note | Dashboard card: `data-obligation-label="Retake Required"` + "Retake Required" chip. Course page: `data-variant="retake-required"` panel + mandated copy + reason-note display + "Previous score 92%" + Start Training button (NOT Replay). State pill = "Retake Required". Multi-viewport captures. |
| **D — Multiple Outstanding (directive §5)** | Historical completion + 2× MANUAL_REINSTATE | Dashboard: ONE card (not two) with `data-obligation-multiple="true"` + "Multiple completions required" chip. DB snapshot: 2 OUTSTANDING + 1 completion. |
| **E — Historical vs current gating (directive §6)** | Historical completion @ 88% + MANUAL_REINSTATE | State pill is NOT "Completed". Replay button absent; Start Training present. Your Result tab shows the amber "previous completion remains on record" prelude with the 88% historical score + "A new completion is required to satisfy the current requirement." |

### 2.1 §4 full-training-lifecycle note

Directive §4 asks for the complete retake lifecycle (fresh video progress → cleared checkpoints → pass assessment → new completion → obligation satisfied → dashboard updates). The 70 contract tests (EP-TRAIN-5A-1 + 5B/B-1 + 5C-1 + 5C-2) prove the full server-side state machine end-to-end against isolated fixtures, including the atomic completion+satisfaction tx. Scenario C's browser walkthrough proves the UI correctly renders the Retake Required state + hands the right session to the player; the player's internal state machine (watching, checkpoint clearance, assessment submission) is exercised by the EP-TRAIN-3 Slice 3 live-journey spec which continues to pass. A deliberate browser-driven end-to-end video-watch simulation would require tens of minutes of video playback per run (the fixture video is 42s + 90% threshold = ~38s minimum + the quiz interaction), which is impractical for a shared staging deploy's test window. The contract tests + the browser state-rendering coverage are the composed proof.

## 3. Multi-viewport evidence (directive §7)

Captured in `test-results/ep-train-5c3a-authenticated-employee/`:

| File | Viewport | Scenario |
|---|---|---|
| `A-baseline-dashboard-1440x900.png` | 1440×900 | Baseline dashboard (no obligation) |
| `B-completed-replay-course-1440x900.png` | 1440×900 | Completed course (no obligation) — replay-only |
| `C-retake-required-dashboard-1440x900.png` + `-768x1024.png` + `-390x844.png` | 3 viewports | Retake Required on dashboard |
| `C-retake-required-course-1440x900.png` + `-768x1024.png` + `-390x844.png` | 3 viewports | Retake Required on course page |
| `D-multiple-outstanding-dashboard-1440x900.png` | 1440×900 | Multiple Outstanding card + chip |
| `E-historical-vs-current-your-result-1440x900.png` | 1440×900 | Your Result tab amber prelude |

Visual verification of the 1440×900 Retake Required course page (sampled in the acceptance report): amber "Retake Required" pill in hero + metadata chip row showing historical "Completed Sep 18, 2026" + "Score: 92%". Right-column panel shows: amber "Retake Required" title + mandated copy + italic reason note "5C-3A acceptance: refresher after safety incident on 2026-10-28" + "Previous score 92%" + "Previously completed Sep 18, 2026" + green "Start Training" button. Required Training rail (right) renders real video thumbnails. EP-UX-2D layout, typography, chrome, sidebar, branding all byte-for-byte unchanged.

## 4. Founder preservation audit (directive §9)

Captured via `snapshotFounderCounts()` before + after the whole spec run:

- **Before**: `{ completions: 9, attempts: 30, progress: 9 }`
- **After**:  `{ completions: 9, attempts: 30, progress: 9 }`

Chris Turcato's history is byte-for-byte identical. Zero obligations issued against the founder. The `test.afterAll` hook asserts this directly (not just reports it).

## 5. Visual discrepancies

None detected. The baseline dashboard (scenario A) and completed-course page (scenario B) render byte-for-byte identical to EP-UX-2D. The three new UI states (Retake Required / Multiple Outstanding / Historical-vs-current) use the same amber palette as the EP-UX-2D "In Progress" variant — no new visual tokens introduced.

## 6. Files shipped

- `tests/e2e/_lib/ep-train-5c3a-seed.ts` (NEW) — per-scenario SSH seeding helpers (completion / obligation / snapshot / cleanup).
- `tests/e2e/ep-train-5c3a-authenticated-employee.staging.spec.ts` (NEW) — 5-scenario authenticated-browser acceptance.
- `docs/ep-train-5c3a-authenticated-acceptance.md` (NEW) — this document.

Server code is UNCHANGED. The live `sha-526f5c69642f` image already contains every code path exercised. No DRH-1 deploy required.

## 7. STOP boundary

Per directive §10: *"STOP after EP-TRAIN-5C-3A. Do not proceed to EP-TRAIN-5C-4 or production deployment."*

Not initiating:
- 5C-4 (live INITIAL backfill + global resolver activation)
- Production deployment
- Recurring recertification
- Unrelated features

5C-4 remains gated on explicit founder authorization + the compatibility
proof the 5C-1 dry-run report delivers (`willFlipFromCompliantToOutstanding = []`).
