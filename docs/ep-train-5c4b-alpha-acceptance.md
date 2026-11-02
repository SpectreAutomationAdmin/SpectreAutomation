# EP-TRAIN-5C-4B-α — Persisted INITIAL Obligation UI Parity — Acceptance

**Status:** READY FOR ACCEPTANCE on staging 2026-11-02.

**Baseline:** `spectre-staging:sha-804b91611d2d` (Fly v1075).
**Rollback anchor:** `spectre-staging:sha-a6bf36202d71` (Fly v1074 — pre-α 5C-3C baseline).
**Image digest:** `sha256:...` (via `flyctl image show --app spectre-staging`).
**Health:** `/api/health` → 200.
**Worker deploy:** yes (DRH-1 default; worker code unchanged in this slice).
**Founder preservation:** `{completions:9, attempts:30, progress:9, obligations:0}` byte-identical before + after.

**Pilot NOT executed in this slice** — directive §1 explicitly deferred Marc's 2-obligation pilot to a post-α re-presentation.

Companion docs:
- [docs/ep-train-5c4b-compatibility-preflight.md](docs/ep-train-5c4b-compatibility-preflight.md) — the preflight STOP finding that drove this slice.
- [docs/ep-train-5c4b-applicability-audit.md](docs/ep-train-5c4b-applicability-audit.md) — the applicability model + proposed per-course config.
- [docs/ep-train-5c4a-readiness-report.md](docs/ep-train-5c4a-readiness-report.md) — the 5C-4A activation audit.

---

## 1. What shipped

### Code changes (3 files, ~70 lines additive)

- **`src/app/employee/(authed)/safety-training/page.tsx`** — dashboard chip label branch now distinguishes `activeObligation.reason === "INITIAL"` (which renders "Initial Training Required") from the generic inferred `INITIAL_REQUIRED` state (which keeps the chip-suppressed "Required" label).
- **`src/app/employee/(authed)/safety-training/[versionId]/page.tsx`** — `StatePill` for `state === "initial-required"` is promoted from the stone/grey "Not Started" fallback to the amber "Initial Training Required" obligation-aware palette, matching the Retake/Updated precedent. The state is only reached when a persisted OUTSTANDING INITIAL obligation exists (see the state computation at page.tsx:184).
- **`src/app/employee/(authed)/safety-training/[versionId]/page.tsx`** — new `TrainingStatusPanel` variant for `state === "initial-required" && activeObligation`, mirroring the Retake Required panel pattern with the founder-approved copy ("Your club requires you to complete this training. Start the course to meet your current training requirement.").

### Tests + fixtures (2 files)

- **`tests/e2e/_lib/ep-train-5c3a-seed.ts`** — `seedObligation` now accepts an optional `status` parameter so the §7/§8 acceptance scenarios can create SATISFIED / CANCELED / SUPERSEDED rows.
- **`tests/e2e/ep-train-5c4b-alpha-initial-chip.staging.spec.ts`** (NEW) — 5-block acceptance spec covering §1-2 (inferred vs persisted, multi-viewport), §4 (MANUAL_REINSTATE unchanged), §7 (SATISFIED non-trigger), §8 (CANCELED + SUPERSEDED non-trigger), §9+§10 (founder preservation + cross-tenant isolation).

### No changes to

- `src/lib/hr/training/compliance-resolver.ts` — zero semantic change. The resolver still returns `INITIAL_REQUIRED` for both inferred and persisted cases; the UI distinguishes them via `activeObligation != null && reason === "INITIAL"`.
- `src/lib/hr/training/applicability.ts` — zero change.
- `src/lib/hr/scheduling-eligibility.ts` — zero change.
- Any admin UI, posting path, or scheduling code.

---

## 2. §5 acceptance scenarios — 5/5 PASS

| # | Scenario | Spec block | Status | Duration |
|---|---|---|---|---|
| §1 | Required course with NO persisted obligation — existing generic presentation (chip suppressed, "Not Started" pill, default panel). | combined in §1-2 Phase A | **PASS** | included |
| §2 | OUTSTANDING INITIAL — new amber "Initial Training Required" chip + amber state pill + new Status Panel variant. **Multi-viewport (1440 / 768 / 390).** | §1-2 Phase B | **PASS** | 2.0 min |
| §3 | Completed, no obligation — existing Completed + Replay presentation. | **Covered by EP-TRAIN-5C-3B §6 regression** (replay-only preserved after retake) — 5C-3C regression run post-deploy, 4/4 PASS. | **PASS (regression)** | — |
| §4 | OUTSTANDING MANUAL_REINSTATE — existing Retake Required presentation; must NOT contain "Initial Training Required". | §4 | **PASS** | 45.7 s |
| §5 | OUTSTANDING REVISION — existing Updated Training Required presentation. | **Covered by EP-TRAIN-5C-3C §2 regression** — 4/4 PASS. | **PASS (regression)** | — |
| §6 | Multiple outstanding obligations — existing multiple-completion presentation. | **Covered by EP-TRAIN-5C-3C §1 Keep Both regression** — 4/4 PASS. | **PASS (regression)** | — |
| §7 | SATISFIED INITIAL — no outstanding INITIAL chip; dashboard renders fallback "Required" (suppressed); state pill = "Not Started". | §7 | **PASS** | 44.5 s |
| §8 | CANCELED and SUPERSEDED INITIAL — no outstanding INITIAL chip. | §8 | **PASS** | 54.1 s |
| §9 | Cross-tenant isolation — fixture obligations never bleed to founder/Marc. | §9+§10 (asserted inside `afterAll`) | **PASS** | 4.9 s |
| §10 | No change to dashboard compliance metrics or scheduling eligibility. | §9+§10 (counts byte-identical before+after) | **PASS** | 4.9 s |

**Total 5C-4B-α acceptance:** 5 test blocks, 4.8 min wall-clock, 5/5 PASS.

**Total 5C-3A/B/C regression on α baseline:** 4/4 PASS in 7.4 min (full retake lifecycle + Keep Both + Revised Course + Supersession + 1× sanity).

### 2.1 §9+§10 isolation proof

- Founder (E-00002) counts byte-identical before + after the full test run: `{completions:9, attempts:30, progress:9, obligations:0}`.
- Global counts byte-identical: `{obligations:0, completions:11, attempts:33, progress:12}`. The 0 obligations global count is unchanged because every fixture obligation was torn down with the fixture in `try/finally`.
- Resolver filtering by `clubId: employee.clubId` guarantees fixture-tenant obligations cannot surface on legitimate-employee dashboards (asserted indirectly by zero founder mutation + the resolver's own query at `compliance-resolver.ts:127`).

---

## 3. State-source integrity (directive §4)

The new UI branches derive the "amber Initial Training Required" presentation EXCLUSIVELY from `compliance.courses[].activeObligation`, which the resolver constructs only when a row satisfies:
- `status: "OUTSTANDING"` (per the resolver's query filter at `compliance-resolver.ts:141`),
- `clubId == employee.clubId` (per the same query),
- `employeeId == principal.employeeId`,
- `courseId` ∈ `applicableCourseIds` (per the resolver's applicability resolution),
- `reason: "INITIAL" | "REVISION" | "MANUAL_REINSTATE"` — the UI then narrows further to `reason === "INITIAL"`.

Guarantees proved by acceptance scenarios:
- SATISFIED INITIAL rows produce no `activeObligation` output → no amber chip (§7).
- CANCELED INITIAL rows produce no `activeObligation` output → no amber chip (§8).
- SUPERSEDED INITIAL rows produce no `activeObligation` output → no amber chip (§8).
- MANUAL_REINSTATE OUTSTANDING rows produce `activeObligation.reason === "MANUAL_REINSTATE"` → "Retake Required" (not "Initial Training Required") (§4).
- REVISION OUTSTANDING rows → "Updated Training Required" (via 5C-3C §2 regression).
- Multiple OUTSTANDING → "Additional Retake Required" + multiple-completions chip (via 5C-3C §1 regression).

---

## 4. Deployment evidence

| Field | Value |
|---|---|
| Rollback anchor | `spectre-staging:sha-a6bf36202d71` (Fly v1074) |
| New baseline | `spectre-staging:sha-804b91611d2d` (Fly v1075) |
| Image digest | `flyctl image show` on request |
| Worker | redeployed (DRH-1 default; no worker code touched) |
| Health | `/api/health` → 200 immediately after deploy and after spec runs |
| Deploy workflow | GitHub Actions run `41448202853` — success |
| Smoke test | public login page reachable |
| Playwright acceptance | 5/5 PASS (run2 after locator fix) |
| 5C-3C regression | 4/4 PASS |
| Contract regression | 10/10 compliance-resolver tests PASS pre-deploy |
| Typecheck | clean on all touched files |

---

## 5. Risk recap

| # | Risk | Mitigation / outcome |
|---|---|---|
| R1 | New UI logic triggers for inferred (no-obligation) cases | Guard: `activeObligation != null && reason === "INITIAL"`. §1 Phase A asserts chip is NOT rendered for the inferred case. |
| R2 | Non-OUTSTANDING INITIAL obligations trigger the new chip | Resolver filters `status: "OUTSTANDING"` at the query level. §7 + §8 prove SATISFIED / CANCELED / SUPERSEDED do not surface. |
| R3 | Other obligation reasons regress (REVISION, MANUAL_REINSTATE) | §4 asserts MANUAL_REINSTATE still renders "Retake Required"; 5C-3C regression covers REVISION. |
| R4 | Multi-viewport layout regression | Dashboard + course page screenshots captured at desktop (1440×900), tablet (768×1024), mobile (390×844) in §1-2 Phase B. |
| R5 | Cross-tenant leakage | Resolver's `clubId: employee.clubId` filter + fixture isolation. §9 + founder preservation prove no cross-tenant bleed. |
| R6 | Scheduling-eligibility change | Legacy `resolveEmployeeSchedulingEligibility` untouched. No scheduling code path reads TrainingObligation. |
| R7 | Historical completion mutation | Zero `TrainingCompletion` writes. Fixture teardown removes only disposable rows. Counts byte-identical. |

---

## 6. Screenshots captured

All in `test-results/ep-train-5c4b-alpha-initial-chip/` on the final (run2) PASS:

**§1 inferred:**
- `s1-01-dashboard-inferred-no-chip.png` (1440×900)
- `s1-02-course-inferred-not-started.png` (1440×900)

**§2 persisted OUTSTANDING INITIAL — multi-viewport:**
- `s2-01-dashboard-persisted-desktop-1440x900.png`
- `s2-01-dashboard-persisted-tablet-768x1024.png`
- `s2-01-dashboard-persisted-mobile-390x844.png`
- `s2-02-course-persisted-desktop-1440x900.png`
- `s2-02-course-persisted-tablet-768x1024.png`
- `s2-02-course-persisted-mobile-390x844.png`

---

## 7. STOP boundaries honoured (directive §10)

Not initiating:
- Marc's 2-obligation pilot (directive §1 defers).
- Course applicability changes.
- Global compliance enforcement activation.
- Scheduling-eligibility changes.
- The broader INITIAL backfill (39 proposed obligations).
- Production deploy.
- Recurring recertification.
- Any modification to unrelated modules.

**Awaiting founder acceptance of this α slice.** Once accepted, the Marc 2-obligation pilot (per the 5C-4B founder decision + applicability audit §8) can be re-presented and executed against the α baseline — the UI will now visibly distinguish the 2 persisted obligations from the 6 inferred requirements on Marc's dashboard, course page state pills, and status panels.
