# EP-TRAIN-6D-4Z-D — Least-Privilege AI Training Reviewer (DESIGN)

Offline implementation. NOT deployed. NOT pushed. Builds on the
accepted 4Z-C baseline (`f08dbd6c`).

## 1. Objective

Allow a designated club reviewer to approve grounded AI-generated
training questions without granting SUPER_ADMIN, without expanding
every CLUB_ADMIN's authority, and without introducing new
authorisation infrastructure.

## 2. Non-goals

- No schema change. No shared DB migration. No new API route. No new
  UI component. No new permission-grant endpoint.
- No CLUB_ADMIN behavioural change. CLUB_ADMIN continues to carry
  `hr:training:read/write/publish/assign/ai:read` but NOT the approve
  grant.
- No cross-tenant privilege. Every grant is scoped to the clubId on
  the UserClubRole row.

## 3. §3 Preflight — infrastructure sufficiency

| Component                          | Already exists? | Change needed?                                         |
|------------------------------------|-----------------|--------------------------------------------------------|
| Role model (`Role` + `UserClubRole`)| Yes            | None (roleKey is a string FK — accepts new values)    |
| `ROLES` map in permissions.ts      | Yes             | **Add** `TRAINING_AI_REVIEWER` entry                  |
| `ROLE_PERMISSIONS` map             | Yes             | **Add** 3-permission entry                             |
| `TENANT_ASSIGNABLE_ROLES` allowlist| Yes             | **Add** `TRAINING_AI_REVIEWER` so the invitation UI picks it up |
| `ROLE_LABELS` in constants         | Yes             | **Add** human-readable label                          |
| Tenant Admin invitation UI         | Yes             | None (reads `TENANT_ASSIGNABLE_ROLES` + `ROLE_LABELS`) |
| Role-change API endpoints          | Yes (`/api/clubs/[id]/tenant-users/profiles/[profileId]`) | None |
| Approval endpoint / service / guard| Yes (4N)        | None (already checks `hr:training:ai:approve`)        |
| Reviewer eligibility (4P)          | Yes             | None (already reads the approve grant from `hasPermission`) |
| Workspace page (4Y)                | Yes             | None for reviewer — reviewer uses the persisted-review surface, not the workspace |
| Persisted-review page              | Yes             | None (gates on `hr:training:ai:read`)                 |
| Seed catalog (`prisma/seed.ts`)    | Yes             | Automatic — `seed.ts` iterates `ROLES` + `ROLE_PERMISSIONS` |
| Staging `Role` table row           | Not present     | **Documented** as a staging-activation prerequisite (single `INSERT ... ON CONFLICT DO NOTHING`); NOT a schema migration |

**Conclusion**: a new role can be added using the existing role model.
**No schema change. No new role-assignment API. No new authorisation
infrastructure.** All §3 STOP conditions are satisfied.

## 4. Role definition

```ts
// src/lib/permissions.ts
ROLES.TRAINING_AI_REVIEWER = {
  name: "AI Training Reviewer",
  description:
    "Approves human-reviewed AI training-question drafts. Cannot author, promote, publish, or assign courses; cannot access unrelated modules.",
};

ROLE_PERMISSIONS.TRAINING_AI_REVIEWER = [
  "hr:training:read",        // read the course catalogue for context
  "hr:training:ai:read",     // view AI draft queue + detail + evidence
  "hr:training:ai:approve",  // record approval (4N service re-verifies)
];
```

Exactly three permissions. Nothing more.

## 5. Permission matrix

The matrix shows what each role resolves to for the training-AI
permission surface (and the key non-training perms for contrast).

| Permission                          | SUPER_ADMIN | CLUB_ADMIN | **TRAINING_AI_REVIEWER** | CLUB_ADMIN + REVIEWER | STAFF |
|-------------------------------------|-------------|------------|--------------------------|-----------------------|-------|
| `hr:training:read`                  | ✅          | ✅         | **✅**                    | ✅                    | ❌    |
| `hr:training:write`                 | ✅          | ✅         | **❌**                    | ✅                    | ❌    |
| `hr:training:publish`               | ✅          | ✅         | **❌**                    | ✅                    | ❌    |
| `hr:training:assign`                | ✅          | ✅         | **❌**                    | ✅                    | ❌    |
| `hr:training:compliance:read`       | ✅          | ✅         | **❌**                    | ✅                    | ❌    |
| `hr:training:ai:read`               | ✅          | ✅         | **✅**                    | ✅                    | ❌    |
| `hr:training:ai:generate`           | ✅          | ❌         | **❌**                    | ❌                    | ❌    |
| `hr:training:ai:review`             | ✅          | ❌         | **❌**                    | ❌                    | ❌    |
| `hr:training:ai:edit`               | ✅          | ❌         | **❌**                    | ❌                    | ❌    |
| `hr:training:ai:revalidate`         | ✅          | ❌         | **❌**                    | ❌                    | ❌    |
| `hr:training:ai:approve`            | ✅          | **❌**     | **✅**                    | **✅** (via union)     | ❌    |
| `hr:training:ai:remediate-rejected` | ✅          | ❌         | **❌**                    | ❌                    | ❌    |
| `hr:training:ai:archive`            | ✅          | ❌         | **❌**                    | ❌                    | ❌    |
| `hr:training:transcription:write`   | ✅          | ❌         | **❌**                    | ❌                    | ❌    |
| `payroll:*`                         | ✅          | some       | **❌**                    | some                  | ❌    |
| `reports:*`                         | ✅          | some       | **❌**                    | some                  | ❌    |
| `packages:write`                    | ✅          | ✅         | **❌**                    | ✅                    | ❌    |

The row that implements the directive: **`hr:training:ai:approve`**
— ❌ on CLUB_ADMIN alone, ✅ on TRAINING_AI_REVIEWER, ✅ on the union.

## 6. Where the authority surface lives

| Surface                                                                    | Permission read |
|----------------------------------------------------------------------------|-----------------|
| `POST /api/admin/ai-training/drafts/[id]/approve` (4N route)               | `hr:training:ai:approve` (via approval-service → approval-guard) |
| `approval-service.ts` service-layer check                                  | `hr:training:ai:approve` |
| `approval-guard.ts` eligibility evaluator                                  | `hr:training:ai:approve` |
| `reviewer-eligibility.ts` `canApprove` flag                                | `hr:training:ai:approve` |
| `lifecycle.ts` transition `REQUIRES_HUMAN_REVIEW → APPROVED_DRAFT`         | `hr:training:ai:approve` |
| `read-service.ts` queue + detail                                           | `hr:training:ai:read` |
| `evidence-reader.ts` evidence resolution                                   | `hr:training:ai:read` |
| `verified-answer-reader.ts` verified-answer resolution                     | `hr:training:ai:read` |
| `persisted/page.tsx` page gate                                             | `hr:training:ai:read` |
| 4Y workspace page gate                                                     | `hr:training:read`  (reviewer can view the catalogue page but will not be routed to the workspace by default) |
| 4Y Course Assembly `promote` button + endpoint                             | `hr:training:write` (NOT on reviewer — button is disabled / not rendered) |
| 4Y Publish panel / existing Publish button                                 | `hr:training:publish` (NOT on reviewer) |
| Tenant Admin invitation (grant/revoke role)                                | existing `packages:write` style grant held by the Tenant Administrator |

Reviewer flow end-to-end (no new UI, no developer script needed):

1. Tenant Admin opens the existing invitation UI at
   `/app/admin/settings/users`, selects a user, and grants
   `TRAINING_AI_REVIEWER` via the existing role picker (which now
   includes the new role because it was added to
   `TENANT_ASSIGNABLE_ROLES`).
2. Reviewer logs in. Their session's Principal carries the new
   `UserClubRole` on reload.
3. Reviewer navigates to `/app/admin/ai-training/review/persisted`.
4. The persisted-review page server-side gates on `hr:training:ai:read`
   — reviewer passes.
5. Each candidate's approval button is gated by
   `computeReviewerEligibility().canApprove` — reviewer carries
   `hr:training:ai:approve`, so the button is enabled.
6. Reviewer clicks Approve → the `POST .../approve` route calls
   `approvalService` → `approval-guard` → verifies the reviewer
   carries `hr:training:ai:approve` AT THE ACTIVE CLUB → writes the
   `TrainingQuestionAiReview` row with `reviewedByUserId = reviewer.id`
   AND transitions the draft to `APPROVED_DRAFT`.
7. A separate CLUB_ADMIN manager sees the approved draft in the 4Y
   workspace's Course Assembly stage and clicks Promote.

## 7. CLUB_ADMIN behaviour (§5)

Unchanged. The CLUB_ADMIN permission array is untouched. No role
addition. Verified via the 4Z-D authorization tests:

```
expect(hasPermission(clubAdmin, clubA, "hr:training:ai:approve")).toBe(false);
```

A club administrator who should also be able to approve is granted
the TRAINING_AI_REVIEWER role separately (the existing UI and the
union of their `UserClubRole` rows carries both sets).

## 8. Staging activation prerequisites (deferred)

Live activation on staging — **not performed in this slice** — needs:

1. **Seed the `Role` row on staging DB** (one-shot, idempotent):
   ```sql
   INSERT INTO "Role" ("key", "name", "description", "isSystem", "createdAt")
   VALUES ('TRAINING_AI_REVIEWER', 'AI Training Reviewer',
           'Approves human-reviewed AI training-question drafts.',
           true, now())
   ON CONFLICT ("key") DO NOTHING;
   ```
   (Not a Prisma migration — this is a seed row insert, equivalent
   in impact to what `prisma/seed.ts` does for fresh dev databases.)
2. **Deploy the 4Z-D code** via DRH-1. The deploy is a pure
   permission-matrix extension — no schema change, no new API.
3. **Grant the role to one or more club reviewers** via the Tenant
   Administrator invitation UI (existing, unchanged).
4. **Acceptance walk**: a reviewer logs in, opens
   `/app/admin/ai-training/review/persisted`, approves a candidate,
   confirms the `TrainingQuestionAiReview` row carries the reviewer's
   id — NOT a founder impersonation.

## 9. §7 Minor workspace corrections (shipped)

Two §7 polish items landed alongside the role addition:

1. **Promote button auto-disables after successful promotion**
   (`AiWorkspaceClient.tsx`): added a `locallyPromoted: Record<string,string>`
   state in the parent client; a successful `POST .../promote`
   fires `onLocalPromote(draftId, destinationKind)`, which the
   Assembly panel reads as `effectiveAlreadyPromoted = approved.alreadyPromoted || locallyPromoted[draftId]`.
   The Promote buttons disappear immediately; no page reload needed.
2. **Informative initial badge** (page.tsx + AiWorkspaceClient.tsx):
   added `initialStageHints` prop computed server-side from
   `latestBuildPresent` + `candidates.length`. The transcription +
   generation stepper badges render `NOT_STARTED` ("idle") on first
   paint when the server can prove it, instead of "…" until the
   first poll completes.

Neither change touches global chrome, layout, or any unrelated
component.

## 10. Files added / modified

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
src/lib/permissions.ts                                                              (+ ROLES.TRAINING_AI_REVIEWER + ROLE_PERMISSIONS[...])
src/lib/tenant-admin/constants.ts                                                   (+ TENANT_ASSIGNABLE_ROLES entry + ROLE_LABELS entry)
src/app/app/admin/people/safety-training/[courseId]/[versionId]/ai-workspace/
  page.tsx                                                                          (+ initialStageHints prop)
src/app/app/admin/people/safety-training/[courseId]/[versionId]/ai-workspace/
  AiWorkspaceClient.tsx                                                             (+ initialStageHints seeding + locallyPromoted state)
```

## 11. STOP boundaries (§9) — all confirmed

| STOP                                 | Confirmed |
|--------------------------------------|-----------|
| No staging/production deploy         | ✅        |
| No shared DB migration               | ✅ (no `prisma/migrations/*` added) |
| No live Modal/Qwen inference         | ✅        |
| No GPU activation                    | ✅        |
| No historical candidate modification | ✅        |
| No publication                       | ✅        |
| No employee assignments              | ✅        |
| No permanent role grants in shared envs | ✅ (no grants made on staging; the PG16 integration harness uses a disposable local DB) |
| No unrelated UI changes              | ✅ (only the 4Y workspace, targeted per §7) |
| 126 unrelated WIP files preserved    | ✅ (stashed) |

## 12. Related slices

- 4Z-C (f08dbd6c) — promote-step acceptance which surfaced this gap.
- 4Y — workspace + promote endpoint consumer.
- 4N — approval service the reviewer drives.
- 4P — reviewer-eligibility UI gate.
- 4D — persisted-review surface (page gate consumes `hr:training:ai:read`).
- TA-1B — Tenant Administration invitation / role-change UI.
