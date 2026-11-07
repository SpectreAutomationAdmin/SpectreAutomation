# EP-TRAIN-6D-4Z-D — Reviewer Authorization (ACCEPTANCE)

**Status:** Offline implementation complete. **Not pushed.** Not
deployed. Not activated on staging.

**Branch:** `ep-train-6d-4z-d/reviewer-auth`
**Parent commit:** `f08dbd6c` (accepted 4Z-C)
**Date:** 2026-11-07

## 1. §3 Preflight — infrastructure sufficiency CONFIRMED

A new role can be added using the existing role model:
- `UserClubRole.roleKey` is a string FK to `Role.key`.
- `hasPermission()` consults the static `ROLE_PERMISSIONS` map keyed
  by the role string.
- Tenant Administrator invitation UI picks assignable roles from
  `TENANT_ASSIGNABLE_ROLES`.
- `prisma/seed.ts` iterates `ROLES` + `ROLE_PERMISSIONS` so fresh
  databases seed automatically.

**No schema change. No new API. No new UI component. No new
authorisation infrastructure.** Full inventory in the design doc §3.

## 2. §4 Role definition — EXACTLY 3 permissions

```ts
ROLE_PERMISSIONS.TRAINING_AI_REVIEWER = [
  "hr:training:read",
  "hr:training:ai:read",
  "hr:training:ai:approve",
];
```

Zero of the forbidden grants (SUPER_ADMIN, general training write,
AI ingestion, payroll/accounting/HR admin, course publication,
employee assignment, role management). Enforced by the authorization
test `carries EXACTLY three permissions, no more`.

## 3. §5 CLUB_ADMIN behaviour preserved

CLUB_ADMIN's permission array is **untouched**. The authorization
test `CLUB_ADMIN alone CANNOT approve AI drafts` asserts the gap
remains, and `CLUB_ADMIN + TRAINING_AI_REVIEWER together CAN approve`
asserts the role-union path works for a CLUB_ADMIN who is separately
granted the reviewer role.

## 4. §6 Authorization tests — results

### Pure vitest (no DB) — 27/27 PASS

File: [tests/ep-train-6d4zd-reviewer-authorization.test.ts](../../../tests/ep-train-6d4zd-reviewer-authorization.test.ts)

| § | Scenario                                                              | Result |
|---|-----------------------------------------------------------------------|--------|
| 6 | Reviewer can view AI drafts (`hr:training:ai:read`)                   | ✅     |
| 6 | Reviewer can read training catalogue (`hr:training:read`)             | ✅     |
| 6 | Reviewer can approve eligible questions (`hr:training:ai:approve`)    | ✅     |
| 6 | Reviewer eligibility computes `canApprove = true`                     | ✅     |
| 6 | Reviewer cannot promote (`hr:training:write` = false)                 | ✅     |
| 6 | Reviewer cannot publish (`hr:training:publish` = false)               | ✅     |
| 6 | Reviewer cannot assign employees (`hr:training:assign` = false)       | ✅     |
| 6 | Reviewer cannot generate/edit/revalidate/review-write/remediate/archive | ✅   |
| 6 | Reviewer cannot access payroll/finance/HR admin modules               | ✅     |
| 5 | CLUB_ADMIN alone CANNOT approve                                       | ✅     |
| 5 | CLUB_ADMIN preserved: read/write/publish/assign/ai:read               | ✅     |
| 5 | CLUB_ADMIN + reviewer together CAN approve (role union)               | ✅     |
| 6 | STAFF cannot approve                                                  | ✅     |
| 6 | PAYROLL_ADMIN alone cannot approve                                    | ✅     |
| 6 | CONTROLLER alone cannot approve                                       | ✅     |
| 6 | Cross-tenant: reviewer at Club A has no approve grant at Club B       | ✅     |
| 6 | Reviewer eligibility reports `canApprove = false` on wrong club       | ✅     |
| 6 | Approve route documents 404 same-shape mapping (static pointer)       | ✅     |
| 6 | Revocation: next `hasPermission` after removing membership = false    | ✅     |
| 6 | Audit attribution: eligibility returns reviewer's principal id        | ✅     |
| 6 | Approval service writes `reviewedByUserId: principal.id` (static)     | ✅     |
| 6 | Lifecycle transition declares `requires: ["hr:training:ai:approve"]`  | ✅     |

Plus 5 role-registration guards (metadata, label, TENANT_ASSIGNABLE
membership, exact 3-permission count, no SUPER_ADMIN membership).

**27/27 PASS in 19.25 s.**

### Disposable PG16 integration — 6/6 PASS

Harness: [scratchpad/ep-train-6d4zd/pg16-integration-harness.ts](../../../scratchpad/ep-train-6d4zd/pg16-integration-harness.ts)

Target: `localhost:15442` (disposable Docker container; safety-stopped
on any other URL).

| # | Scenario                                                                      | Result |
|---|-------------------------------------------------------------------------------|--------|
| 1 | Pre-seed: `UserClubRole` insert WITHOUT the `Role` row fails with FK 23503    | ✅     |
| 2 | `Role` row INSERT is idempotent (`ON CONFLICT ... DO NOTHING`)                | ✅     |
| 3 | Post-seed: `UserClubRole` with `roleKey='TRAINING_AI_REVIEWER'` succeeds      | ✅     |
| 4 | `loadPrincipal`-shape query returns the reviewer membership at the right club | ✅     |
| 5 | Revocation: deleting the row removes the membership on next read              | ✅     |
| 6 | `Role` seed INSERT remains idempotent after revoke                            | ✅     |

**6/6 PASS.**

### Combined 4B-4Y regression — 171/171 PASS

Ran sequentially to avoid parallel SQLite flakes:
`ep-train-6d4b` + `6d4d-api-routes` + `6d4d-no-mutation` + `6d4m` +
`6d4n` + `6d4p` + `6d4t` + `6d4y` + `6d4zd-reviewer-authorization`.

**171/171 PASS in 323 s.** No regression from the role addition,
constants update, or §7 workspace polish.

### Scoped typecheck — clean

```
npx tsc --noEmit -p scratchpad/ep-train-6d4zd/tsconfig.scoped.json
```
0 errors on the 4 touched files (permissions.ts + constants.ts + page.tsx + AiWorkspaceClient.tsx).

### Placeholder scan — no new hits

`npm run scan:placeholders` reports no new entries from 4Z-D files.

## 5. §7 Minor workspace corrections — shipped

Both corrections targeted; no global chrome, layout, or unrelated
component touched.

1. **Promote button auto-disables after successful promotion** —
   `locallyPromoted` client state in `AiWorkspaceClient.tsx` flips
   the row to "Already promoted · <destination>" immediately after
   the successful POST, no page reload needed.
2. **Informative initial badge** — `initialStageHints` passed from
   the server page (`page.tsx`) seeds the stepper badge with
   `NOT_STARTED` when the server can prove it (no video / no
   candidates), replacing the "…" initial state.

Verified: scoped typecheck clean, 4Y + 4Z route tests still pass.

## 6. Files added / modified

### Added

```
docs/training/ai-generation/PHASE-D-4Z-D-REVIEWER-AUTH-DESIGN.md
docs/training/ai-generation/PHASE-D-4Z-D-ACCEPTANCE.md
tests/ep-train-6d4zd-reviewer-authorization.test.ts
scratchpad/ep-train-6d4zd/tsconfig.scoped.json
scratchpad/ep-train-6d4zd/pg16-integration-harness.ts
```

### Modified

```
src/lib/permissions.ts                                                 (ROLES + ROLE_PERMISSIONS)
src/lib/tenant-admin/constants.ts                                      (TENANT_ASSIGNABLE_ROLES + ROLE_LABELS)
src/app/app/admin/people/safety-training/[courseId]/[versionId]/
  ai-workspace/page.tsx                                                (initialStageHints)
src/app/app/admin/people/safety-training/[courseId]/[versionId]/
  ai-workspace/AiWorkspaceClient.tsx                                   (initialStageHints seeding + locallyPromoted state)
```

## 7. Existing role-grant UI path (no changes)

A Tenant Administrator (CLUB_ADMIN with Tenant Administration
responsibility) grants the role via the existing invitation /
role-change workflow:

1. Navigate to **Settings → Users** (`/app/admin/settings/users`).
2. Open a user's row.
3. In the role picker (sourced from `TENANT_ASSIGNABLE_ROLES`), the
   new **"AI Training Reviewer"** option appears automatically.
4. Save. The invitations service validates the role via
   `isTenantAssignableRole()`, writes the `UserClubRole` row, and
   the recipient's next authenticated request carries the grant
   via `loadPrincipal()`.

No new endpoint. No new UI. No new fixture.

## 8. Staging activation prerequisites (deferred)

Per design doc §8:

1. **Seed `Role` row on staging** via a one-shot idempotent SQL
   insert (NOT a Prisma migration).
2. **Deploy 4Z-D via DRH-1** — the diff is 2 config files + 2 UI
   files + 1 test file + 2 docs. No schema change, no API change.
3. **Grant the role** to one or more club reviewers via the existing
   Tenant Administrator invitation UI.
4. **Acceptance walk** — reviewer logs in, opens persisted-review
   surface, approves a candidate, verifies
   `TrainingQuestionAiReview.reviewedByUserId = reviewer.id` (NOT
   founder).

## 9. STOP boundaries (§9) — all confirmed

| STOP                                 | Confirmed |
|--------------------------------------|-----------|
| No staging/production deploy         | ✅        |
| No shared DB migration               | ✅        |
| No live Modal/Qwen inference         | ✅        |
| No GPU activation                    | ✅        |
| No historical candidate modification | ✅        |
| No publication                       | ✅        |
| No employee assignments              | ✅        |
| No permanent role grants in shared envs | ✅     |
| No unrelated UI changes              | ✅        |
| 126 unrelated WIP files preserved    | ✅ (stashed on entry, restored on exit) |

## 10. Recommended next slice

**4Z-E — Live reviewer activation on staging** (requires separate
founder authorisation):

1. Apply the `Role` row seed via SQL on staging DB.
2. Deploy 4Z-D via DRH-1.
3. Grant the role to a dedicated synthetic reviewer user (or to the
   founder's existing session, with explicit §6 attribution
   guidance per 4Z-C).
4. Run a Playwright acceptance that:
   - Confirms reviewer can view + approve via persisted-review surface
   - Confirms CLUB_ADMIN alone CANNOT approve (negative test)
   - Captures the resulting `TrainingQuestionAiReview.reviewedByUserId`
     attribution evidence.

Also deferred:
- End-to-end PIPELINE acceptance (reviewer approves → CLUB_ADMIN
  promotes → publish) via two distinct authenticated sessions.

## 11. Awaiting

Founder review of the design + acceptance docs. Any further action
(push, deploy, grant on staging) requires separate authorisation.
