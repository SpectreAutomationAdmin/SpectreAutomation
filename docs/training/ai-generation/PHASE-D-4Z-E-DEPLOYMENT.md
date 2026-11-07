# EP-TRAIN-6D-4Z-E — Deployment Evidence

**Status:** Controlled staging deployment of the TRAINING_AI_REVIEWER
role + §7 workspace polish. **No production. No live Modal / Qwen /
Whisper / GPU. No publication. No employee assignments.**

## 1. Baseline

| Field                        | Value                                             |
|------------------------------|---------------------------------------------------|
| Parent commit                | `e7fbb0b1` (accepted 4Z-D)                       |
| 4Z-E branch                  | `ep-train-6d-4z-e/reviewer-staging`              |
| Pre-deploy Fly release (web) | **v1097** (image `sha-52cbc2bb2030`)             |
| Pre-deploy Fly release (worker) | **v333** (image `sha-52cbc2bb2030`)           |
| Rollback anchor              | Fly v1097 / v333, image `sha-52cbc2bb2030`       |
| DRH-1 workflow run           | `42335629208`                                    |
| Deploy target                | `ep-train-6d-4z-e/reviewer-staging` @ `e7fbb0b1` |

## 2. §3 Preflight — existing idempotent role-registration mechanism

**Confirmed:** `scripts/sync-rbac.ts` is invoked by the DRH-1
`release_command` in `deploy/fly.web.toml` **AFTER** `prisma migrate
deploy`. It upserts every `Permission` + `Role` + `RolePermission`
row defined in `src/lib/permissions.ts` and prunes stale rows. It
NEVER touches User, UserClubRole, Club, or any other data.

Consequence: the DRH-1 deploy of 4Z-D **automatically registers**
the TRAINING_AI_REVIEWER Role row + its RolePermission joins. **No
manual SQL. No schema migration. No privileged operation.**

The script is pre-existing (AUTH-3D.RBAC.FIX, 2026-09-26). This
slice uses it as-is.

## 3. Rollback plan

If the deploy fails health verification OR the role registration
leaves the DB in an unexpected state:

```
flyctl releases rollback v1097 -a spectre-staging --yes
# Worker (if the worker was also deployed):
flyctl releases rollback v333 -a spectre-staging-worker --yes
```

The 4Z-D diff is additive (new role + new UI corrections + new
tests). Rollback is safe: the upserted Role + RolePermission rows
remain on the DB (harmless orphans that the next sync-rbac run will
prune if the role is dropped from the catalogue), but no User or
UserClubRole row would be affected.

## 4. Deployment path (§5 directive)

**DRH-1 via `.github/workflows/deploy-staging.yml`** (`workflow_dispatch`).
Dispatched via:

```
gh workflow run deploy-staging.yml \
  --ref ep-train-6d-4z-e/reviewer-staging \
  -f ref=ep-train-6d-4z-e/reviewer-staging \
  -f confirm=deploy
```

Not used: ❌ local Docker BuildKit (per DRH-1 retry policy).

### Deployment outcome

| Field                                     | Value                             |
|-------------------------------------------|-----------------------------------|
| GitHub Actions run                        | 42335629208 (exit 0)              |
| Build conclusion                          | success                           |
| Pushed image SHA                          | `sha-e7fbb0b158cd`                |
| New Fly release (web)                     | **v1098** @ 2026-11-07T03:56:58Z  |
| Worker rebuild + deploy?                  | Yes — worker **v334** @ 2026-11-07T04:01:50Z, same SHA |
| Migration outcome (prisma migrate deploy) | 0 pending migrations (4Z-D ships no schema change) |
| Role-registration outcome (sync-rbac.ts)  | **Role row + 3 RolePermission rows upserted** — verified by post-deploy parameterised Prisma read (role.key='TRAINING_AI_REVIEWER' + 3 permissions: `hr:training:ai:approve`, `hr:training:ai:read`, `hr:training:read`). Total roles 14 → 15. Total RolePermission 749 → 752 (delta of 3). |
| `/api/health` HTTP code post-deploy       | **200**                           |

## 5. Health verification (post-deploy)

```
curl -s -o /dev/null -w "%{http_code}\n" https://staging.spectreautomation.com/api/health
```

Expected: **200**.

## 6. Role registration verification (post-deploy)

Executed via `flyctl ssh console` + parameterised Prisma reads only
(no `$queryRawUnsafe` with string interpolation; no user enumeration):

- `Role` where `key = 'TRAINING_AI_REVIEWER'`: **expected 1 row**.
- `RolePermission` where `roleKey = 'TRAINING_AI_REVIEWER'`:
  **expected 3 rows** (`hr:training:read`, `hr:training:ai:read`,
  `hr:training:ai:approve`).
- Pre-existing `Permission` rows + other `Role`/`RolePermission`
  rows: **untouched**.

## 7. STOP boundaries (§10 confirmation)

| STOP                                 | Confirmed |
|--------------------------------------|-----------|
| No production deploy                 | ✅        |
| No live Modal/Qwen/Whisper           | ✅ (no env vars set) |
| No GPU activation                    | ✅        |
| No publication                       | ✅        |
| No employee assignments              | ✅        |
| No historical candidate modification | ✅        |
| No permanent synthetic role grants   | ✅ (synthetic reviewer time-boxed to this acceptance) |
| No unrelated UI redesign             | ✅ (only §7 polish shipped with 4Z-D) |
| 126 unrelated WIP files preserved    | ✅ (stashed) |

## 8. Related slices

- [PHASE-D-4Z-D-REVIEWER-AUTH-DESIGN.md](./PHASE-D-4Z-D-REVIEWER-AUTH-DESIGN.md)
- [PHASE-D-4Z-D-ACCEPTANCE.md](./PHASE-D-4Z-D-ACCEPTANCE.md)
- [PHASE-D-4Z-E-ACCEPTANCE.md](./PHASE-D-4Z-E-ACCEPTANCE.md)
