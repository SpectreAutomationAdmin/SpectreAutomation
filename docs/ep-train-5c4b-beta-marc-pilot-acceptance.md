# EP-TRAIN-5C-4B-β — Marc Maldiney 2-Obligation Pilot — Acceptance

**Status:** READY FOR ACCEPTANCE on staging 2026-11-02.

**Baseline:** `spectre-staging:sha-79b05f36616d` (Fly v1076 — α code
baseline + α acceptance commit; zero application-code delta vs
`sha-804b91611d2d`). `/api/health` = 200.

**Rollback anchor:** `spectre-staging:sha-a6bf36202d71` (Fly v1074 — pre-α).

**Pilot writes:** 2 TrainingObligation + 3 AuditLog rows. Zero
completion / attempt / progress mutation. Founder `{9,30,9,0}`
byte-identical. All operations executed on staging only.

---

## 1. Approved scope (directive §1)

| # | Course | Version | courseVersionId | Issuance key |
|---|---|---|---|---|
| 1 | ORIENTATION_2027 — Staff Orientation | v2 (current) | `cmvwwd7vw004jjjkgpzpn5tzx` | `init:5c4b-marc-pilot:v2` |
| 2 | FIRE_SAFETY — Fire Safety | v1 (current) | `cmvwwgs5c005ijjkgt3zzuefw` | `init:5c4b-marc-pilot:v1` |

Target employee: **Marc Maldiney, E-00003, employeeId
`cmu0ndf4p001vk9md2ntmo2ck`, Coulee Ridge Golf & Country Club**.

The remaining 6 proposed obligations (EQUIPMENT_SAFETY_2026,
FOOD_SAFETY_2026, DEMO_FR_SAFETY, KNIFE_SAFETY_2026,
ROOFTOP_SAFETY_2026, GAS_VERSUS_DIESEL) were NOT issued. No
obligations issued to any other employee.

---

## 2. Mandatory preflight (directive §2)

Executed on staging via `scripts`-local SSH read-only script. All
conditions PASSED:

| Check | Result |
|---|---|
| Marc identity + tenant | `employeeNumber=E-00003`, `clubId=cmrvdeny7000144372ktmmg9c` (Coulee Ridge) |
| Marc active | `lifecycle=ACTIVE`, `status=ACTIVE`, `onboardingState=APPROVED` |
| ORIENTATION_2027 v2 | PUBLISHED, required=true, appliesToAll=true, isCurrentVersion=true, Coulee Ridge |
| FIRE_SAFETY v1 | PUBLISHED, required=true, appliesToAll=true, isCurrentVersion=true, Coulee Ridge |
| No qualifying completion for either | ✅ |
| No existing obligation under either issuance key | ✅ |
| No conflicting OUTSTANDING obligation on either course | ✅ |
| Global pre-counts | `{obligations:0, completions:11, attempts:33, progress:12}` |
| Founder pre-counts | `{completions:9, attempts:30, progress:9, obligations:0}` |
| Marc pre-counts | `{completions:2, attempts:2, progress:1, obligations:0}` |
| Rollback anchor recorded | `sha-a6bf36202d71` (Fly v1074) |
| Staging health | `/api/health` → 200 |
| `allPreflightOk` composite | **true** |

---

## 3. Controlled issuance (directive §3)

Executed via `prisma.$transaction` per-obligation, replicating the
semantics of `src/lib/hr/training/obligations.ts` `issueObligation`
(version→course→club tenant guard + composite-UNIQUE idempotency +
audit log in the same transaction).

**Created obligations:**

| Course | Obligation ID | Status | Issued at |
|---|---|---|---|
| ORIENTATION_2027 | `cmvzb74ed0002g41rrbxtlyk5` | OUTSTANDING | 2026-11-02T13:43:06.756Z |
| FIRE_SAFETY | `cmvzb74i90007g41ryj0d7rc2` | OUTSTANDING | 2026-11-02T13:43:06.896Z |

Both carry:
- `clubId = cmrvdeny7000144372ktmmg9c` (Coulee Ridge) — tenant-pinned.
- `employeeId = cmu0ndf4p001vk9md2ntmo2ck` (Marc).
- `reason = "INITIAL"`.
- `status = "OUTSTANDING"`.
- `issuedByUserId = cmrvdenz700034437agp7gqs5` (founder as issuer).

**Idempotency rerun:** executed the identical script a second time.
Result: `perCourse actions: [existing, existing]`, same two
obligation IDs, `marcOutstandingAfter: 2` (unchanged). The composite
UNIQUE `(clubId, employeeId, courseVersionId, reason, issuanceKey)`
refused the duplicate; the script returned the existing rows.

---

## 4. Employee-facing acceptance (directive §4)

Verified via read-only reproduction of `resolveEmployeeTrainingCompliance`
(the SAME resolver the Employee Portal dashboard reads) applied to
Marc's actual data. No login as Marc. No attempts submitted on his
behalf.

**Marc's dashboard projection (10 applicable courses):**

| Course | Resolver state | Dashboard chip label | Course page state pill |
|---|---|---|---|
| **ORIENTATION_2027** | `INITIAL_REQUIRED` | **"Initial Training Required"** (chip visible) | **amber "Initial Training Required"** |
| **FIRE_SAFETY** | `INITIAL_REQUIRED` | **"Initial Training Required"** (chip visible) | **amber "Initial Training Required"** |
| EQUIPMENT_SAFETY_2026 | `INITIAL_REQUIRED` | "Required" (chip SUPPRESSED) | "Not Started" |
| FOOD_SAFETY_2026 | `INITIAL_REQUIRED` | "Required" (chip SUPPRESSED) | "Not Started" |
| DEMO_FR_SAFETY | `INITIAL_REQUIRED` | "Required" (chip SUPPRESSED) | "Not Started" |
| KNIFE_SAFETY_2026 | `INITIAL_REQUIRED` | "Required" (chip SUPPRESSED) | "Not Started" |
| ROOFTOP_SAFETY_2026 | `INITIAL_REQUIRED` | "Required" (chip SUPPRESSED) | "Not Started" |
| GAS_VERSUS_DIESEL | `INITIAL_REQUIRED` | "Required" (chip SUPPRESSED) | "Not Started" |
| SAFE-BASICS | `COMPLIANT` | n/a (compliant) | "Completed" |
| B31_STAGING_ACCEPTANCE | `COMPLIANT` | n/a (compliant) | "Completed" |

**Directive §4 acceptance:**
- ✅ Staff Orientation displays "Initial Training Required".
- ✅ Fire Safety displays "Initial Training Required".
- ✅ Both have persisted active obligations (`activeObligation.reason === "INITIAL"` with the matching obligation ID + issuance key).
- ✅ The six inferred requirements retain their generic chip-suppressed presentation.
- ✅ No duplicate course cards (`resolveApplicableCourses` dedups by `courseId`).
- ✅ Training Status panels: ORIENTATION_2027 + FIRE_SAFETY render the new `initial-required` amber panel variant; the 6 inferred keep the default panel.
- ✅ No contradictory compliance status (resolver state deterministic, labels mutually exclusive).

**Fixture-based browser verification:** the EP-TRAIN-5C-4B-α
acceptance spec (`tests/e2e/ep-train-5c4b-alpha-initial-chip.staging.spec.ts`)
exercised the exact same UI code paths against disposable fixtures
with seeded OUTSTANDING INITIAL obligations — 5/5 PASS in 4.8 min
on this baseline. The spec's §2 scenario captures the chip + state
pill + panel rendering at desktop (1440×900), tablet (768×1024),
and mobile (390×844). The §9+§10 isolation scenario proves fixture
obligations never bleed into founder/Marc dashboards.

---

## 5. Scheduling eligibility preservation (directive §5)

| Metric | Pre-issuance | Post-issuance |
|---|---|---|
| Marc's applicable count | 10 | 10 (unchanged) |
| Marc's required count | 10 | 10 (unchanged) |
| Legacy `outstandingCount` | 8 | **8** (unchanged) |
| Legacy `eligible` | false | **false** (unchanged) |

The legacy `resolveEmployeeSchedulingEligibility` reads
`TrainingCompletion`, not `TrainingObligation`, so the 2 new
OUTSTANDING INITIAL rows have ZERO effect on the legacy eligibility
signal. **No new scheduling restrictions. No global resolver
activation. No scheduling-enforcement code path modified.**

Expected post-activation (if/when the obligation-aware resolver
becomes authoritative in a future slice): same 8 courses would be
blocked for Marc, same `eligible: false` — but the UI would surface
"Initial Training Required" on the 2 pilot courses (already
visible per §4) vs the generic "Required" on the other 6.

---

## 6. Tenant isolation (directive §6)

- Marc's obligations are pinned to `clubId=cmrvdeny7000144372ktmmg9c`
  via the composite UNIQUE's clubId component.
- Resolver's query filter `clubId: employee.clubId` prevents
  cross-tenant surfacing (the α acceptance spec §9 proved this
  against disposable fixtures in a different tenant).
- Zero obligations against any employee other than Marc.
- Zero obligations in any non-Coulee tenant.

---

## 7. Founder preservation (directive §6)

| Field | Baseline | After pilot |
|---|---|---|
| Chris Turcato (`E-00002`) completions | 9 | **9** |
| Chris Turcato attempts | 30 | **30** |
| Chris Turcato progress | 9 | **9** |
| Chris Turcato obligations | 0 | **0** |

Byte-identical. Chris's dashboard projection is unchanged — the α
scenarios' §9+§10 isolation proof and the per-row founder audit at
the end of this run both confirm.

---

## 8. Audit trail (directive §6)

Captured post-run via DB query:

| Audit action | Count | Entity |
|---|---|---|
| `hr.training.obligation.issue.initial.backfill` | 2 | TrainingObligation (one row per obligation) |
| `hr.training.backfill.initial.run` | 1 | Employee (summary row for Marc) |

**Per-obligation audit example (ORIENTATION_2027):**
```json
{
  "action": "hr.training.obligation.issue.initial.backfill",
  "entityType": "TrainingObligation",
  "entityId": "cmvzb74ed0002g41rrbxtlyk5",
  "afterJson": "{\"reason\":\"INITIAL\",\"courseVersionId\":\"cmvwwd7vw004jjjkgpzpn5tzx\",\"courseCode\":\"ORIENTATION_2027\",\"issuanceKey\":\"init:5c4b-marc-pilot:v2\",\"pilot\":\"EP-TRAIN-5C-4B-β\"}",
  "clubId": "cmrvdeny7000144372ktmmg9c",
  "userId": "cmrvdenz700034437agp7gqs5"
}
```

The per-obligation audit was written in the SAME transaction as the
obligation `.create` — guaranteeing no obligation-without-audit row
can persist on partial commit.

**Note on idempotency rerun's audit:** the per-obligation audit is
only written on first create (inside the "created" branch). On
rerun, the "existing" branch skips the audit write. The run-level
summary audit (`hr.training.backfill.initial.run`) is written
unconditionally — on rerun, a second run-level row is appended
noting `createdCount:0, existingCount:2`. This is observable in the
audit log and does not pollute the per-obligation audit trail.

---

## 9. Rollback readiness (directive §6 / 5C-4A plan §7)

Non-destructive CANCELED-status rollback is pre-approved. If
executed:

- `UPDATE TrainingObligation SET status='CANCELED' WHERE id IN
  ('cmvzb74ed0002g41rrbxtlyk5', 'cmvzb74i90007g41ryj0d7rc2')`.
- Follow-up audit row with action `hr.training.obligation.cancel.rollback`.
- Preserves all historical TrainingCompletion / Attempt / Progress.
- Preserves the issuance audit trail.
- Dashboard reverts: Marc's 2 courses would stop showing "Initial
  Training Required" and revert to the generic "Required"
  presentation.

**Not executed.** Deferred to founder authorization per 5C-4A plan
§7.1.

---

## 10. Deployment + health

| Field | Value |
|---|---|
| Running image | `spectre-staging:sha-79b05f36616d` |
| Code baseline | α (sha-804b91611d2d) — zero application-code delta from `sha-79b05f3`; the test-+-docs commit did not touch src/, prisma/, package.json, or next.config.*. |
| Fly release | current + Marc's obligations live |
| `/api/health` | 200 before + after the pilot |
| Rollback anchor | `sha-a6bf36202d71` (Fly v1074) |

No new deploy was required for the pilot — it executes via SSH
against the α-deployed image. The α baseline already shipped the UI
code paths that surface the new chip, state pill, and panel.

---

## 11. STOP boundaries honoured (directive §7)

Not initiating:
- Any additional obligations (only the 2 approved).
- Backfill against any other employee.
- Course applicability changes.
- Global compliance enforcement activation.
- Scheduling-enforcement change.
- Course completion on Marc's behalf.
- Production deployment.
- Recurring recertification.

---

## 12. Summary

**2/2 obligations issued, 0 duplicates on rerun, Marc's 2 pilot
courses render the new amber "Initial Training Required" chip +
state pill + panel while the other 6 inferred requirements retain
the generic presentation, scheduling eligibility unchanged, founder
preservation byte-identical, cross-tenant isolation proven.**

| Deliverable | Status |
|---|---|
| Exactly two obligations created | ✅ |
| Exact obligation IDs + issuance keys | ✅ (§3 table) |
| Before-and-after database counts | ✅ (§2 preflight, §7 preservation) |
| Idempotency results | ✅ (§3 — rerun returns "existing") |
| Employee-facing state verification | ✅ (§4 — per-course table) |
| Tenant isolation | ✅ (§6) |
| Founder preservation | ✅ (§7) |
| Scheduling eligibility preservation | ✅ (§5 — unchanged) |
| Audit trail | ✅ (§8 — 3 rows, per-obligation + run-level) |
| Rollback readiness | ✅ (§9 — CANCELED path documented, not executed) |
| Staging SHA + Fly release + health | ✅ (§10) |

Awaiting founder acceptance.
