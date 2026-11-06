# EP-TRAIN-6D-4R — Staging Deployment — Acceptance

Status: **PHASE A ACCEPTED; PHASE B PAUSED FOR FOUNDER AUTHORISATION.**

Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4r/staging-deployment` (documentation only; not
pushed).

## 1. Summary

The EP-TRAIN-6D-4R directive authorises a staging deployment of
the 4K–4P stack, CONDITIONAL on the preconditions in Phase A + the
identity authorisation gate in Phase B.

- **Phase A** — all eight preconditions passed. Zero drift from the
  4Q preflight. The release candidate is byte-for-byte the accepted
  4P commit `b2180d53`.
- **Phase B** — triggered the directive's explicit STOP clause: the
  narrowest grant for `hr:training:ai:approve` is not expressible
  in the existing RBAC catalogue without a permanent change. The
  only tenant-bounded synthetic identity available is a
  `UserClubRole{clubId: Coulee Ridge, roleKey: SUPER_ADMIN}`, which
  grants EVERY permission on that club — broader than the three
  needed (training:read + ai:read + ai:approve).

Per directive §B (second clause): "If existing RBAC cannot support
this identity, document the exact limitation and STOP for founder
authorization of the proposed SUPER_ADMIN fallback."

4R STOPS at Phase B with the limitation documented. **No deploy
executed. No migration applied. No test identity created.**

## 2. Phase A evidence (five-line summary; full detail in `PHASE-D-4R-DEPLOYMENT.md`)

- **Baseline anchor**: Fly v1095 / `sha-5e60fa59894f`; last release
  11h2m before probe; no drift from 4Q.
- **Release candidate**: `b2180d53` on
  `ep-train-6d-4p/interactive-reviewer-ux`; 4Q preflight (`d44bbd1f`)
  pushed to origin; diff 4Q→4P is docs-only.
- **Regression**: 179/179 PASS across 12 suites (4B/4D/4L/4M/4N/4P).
- **Schemas**: both Prisma schemas validate. 4K migration mirror
  parity confirmed; zero destructive SQL in either dialect.
- **Staging DB**: 4B applied 2026-11-04; 4K pending; 8 Coulee Ridge
  drafts (5 REQUIRES_HUMAN_REVIEW + 3 REJECTED); no drift from 4Q.
- **Neon PITR anchor**: `2026-11-06T00:40:19Z`.
- **DRH-1 path**: `.github/workflows/deploy-staging.yml` →
  `workflow_dispatch` or push to `staging-deploy/**`.
- **release_command**: `prisma migrate deploy` + `sync-rbac.ts`
  auto-executed BEFORE new image serves traffic.

## 3. Phase B — RBAC limitation + STOP cause

### Required bundle

`hr:training:read + hr:training:ai:read + hr:training:ai:approve` on
Coulee Ridge (`cmrvdeny7000144372ktmmg9c`).

### Catalogue state

| Role          | ai:read | ai:approve | training:read | Bundle match                 |
| ------------- | :-----: | :--------: | :-----------: | ---------------------------- |
| SUPER_ADMIN   | ✅       | ✅          | ✅             | superset — holds all keys    |
| CLUB_ADMIN    | ✅       | **❌**      | ✅             | missing ai:approve           |
| CONTROLLER    | ❌       | ❌          | ❌             | none                         |
| GENERAL_MANAGER | ❌     | ❌          | ✅             | partial                      |
| STAFF         | ❌       | ❌          | ❌             | none                         |

`hr:training:ai:approve` is withheld from CLUB_ADMIN deliberately
(per EP-TRAIN-6D-4G comment at
[permissions.ts:479](../../src/lib/permissions.ts#L479)). Extending
CLUB_ADMIN is a permanent catalogue change that would propagate to
every existing tenant admin — out of scope for 4R.

### Fallback option

A synthetic `UserClubRole{clubId: Coulee Ridge, roleKey: SUPER_ADMIN}`
is tenant-bounded (not a true global SUPER_ADMIN because `clubId !=
null` — `isSuperAdmin()` returns `false`), but it still carries
EVERY permission on Coulee Ridge. See `PHASE-D-4R-DEPLOYMENT.md` §B.3
for the mechanics and §B.5 for the proposed mitigations.

## 4. GitHub Actions run / Fly release IDs

**NONE executed.** No workflow_dispatch triggered. No deploy
initiated. Phase C would produce these; Phase C has not run.

## 5. Migration verification

**NONE executed on staging.** The 4K migration remains proven safe
on disposable PG16 (4Q rehearsal, 7/7 PASS, unchanged). It has NOT
been applied to the shared staging database.

## 6. Health + regression results

- Offline regression: **179/179 PASS** (Phase A.3).
- Staging `/api/health`: NOT yet re-probed (Phase C step 5 not
  executed). Last known healthy at v1095 (from implicit Fly
  machine status).

## 7. Authentication + permission results

- RBAC catalogue state confirmed via static inspection (Phase B.2).
- No synthetic identity created. No role grant issued.
- Existing SUPER_ADMIN account `spectreautomation.admin@gmail.com`
  retains cross-tenant administrative access (unchanged from
  baseline).

## 8. Synthetic approval evidence

**NONE.** Fixture not seeded. Dialog not opened. Approval POST not
submitted.

## 9. Desktop + mobile screenshots

**NONE.** Playwright not executed. The accepted Spectre three-
column layout + evidence panel + approval dialog remain covered
only by the jsdom suite under `tests/ep-train-6d4p-*`.

## 10. Historical-candidate preservation evidence

- Pre-release count: **8** drafts on Coulee Ridge (reconfirmed via
  `flyctl ssh console` query at the preflight timestamp).
- Post-release count: **not yet measured** (Phase C–F not executed).
- The 4K migration's additive NULL columns preserve every existing
  row byte-identical — proven in 4Q rehearsal T5.

## 11. Cleanup results

**NONE required.** Phase D/F did not run. No synthetic fixture
seeded; no synthetic identity created; nothing to tear down. The
`scratchpad/ep-train-6d4q/release-timestamp.txt` file is a local-
only text record (git-ignored).

## 12. Rollback anchor + recovery readiness

- **App rollback image**: `registry.fly.io/spectre-staging:sha-5e60fa59894f` (v1095, 2026-11-05).
- **App rollback command (reversible, app-only)**: `flyctl deploy --app spectre-staging --image <above> --strategy immediate`.
- **Neon PITR anchor**: `2026-11-06T00:40:19Z` (recorded; procedure in `PHASE-D-4R-DEPLOYMENT.md` §A.5).
- **Rollback mode selected if Phase C ever runs and fails**: app-
  only unless data corruption is proven. Neon PITR is the escape
  hatch of last resort.

No rollback has been executed; no rollback is needed (Phase C did
not run).

## 13. Explicit founder visual-acceptance status

**NOT GRANTED.** No deployed-staging screenshots exist. The
founder has not inspected the deployed interface. Per directive
§E: "Do not claim visual acceptance until the founder reviews the
screenshots or deployed interface."

## 14. Awaiting founder authorisation

To advance past Phase B, the founder must select one of the three
paths documented in `PHASE-D-4R-DEPLOYMENT.md` §Requested founder
authorisation:

- **(A)** Authorise the SUPER_ADMIN fallback with the mitigations in
  §B.5, time-boxed strictly to the Phase D–F window.
- **(B)** Pause 4R and authorise a separate slice to add a narrow
  `TRAINING_AI_REVIEWER` role to the RBAC catalogue.
- **(C)** Any other narrower identity path.

Until the founder picks A, B, or C, 4R remains paused at Phase B
and no further staging action is taken.

## 15. STOP compliance (directive §Mandatory STOP) — honoured

| Boundary                                | Status                                  |
| --------------------------------------- | --------------------------------------- |
| No production changes                   | HONOURED                                |
| No historical backfill                  | HONOURED                                |
| No permanent broad role grants          | HONOURED                                |
| No Modal/Qwen inference                 | HONOURED                                |
| No employee assignments                 | HONOURED                                |
| No publication                          | HONOURED                                |
| No unrelated UI redesign                | HONOURED                                |
| Preserve the 126 unrelated WIP files    | HONOURED — stashed at entry             |
| STOP triggered on identity authorisation | **YES** — this is the correct STOP     |
