# PostgreSQL transition plan — Sprint 2 B4

Sprint 2 B4 introduces the last app-side pieces that need PostgreSQL
verification before staging can accept a real mailbox. This document
is the checklist for the transition; it is not the transition itself.
Nothing here changes the checked-in development environment away
from SQLite.

## Current state (2026-07-19)

- `prisma/schema.prisma` datasource is `provider = "sqlite"`.
- `prisma/migrations/migration_lock.toml` is `provider = "sqlite"`.
- Three migrations exist:
  1. `00000000000000_baseline` — snapshot of the pre-Sprint-2 schema.
  2. `20260719000000_mailbox_integration` — B1 additive.
  3. `20260719120000_mailbox_b2_oauth_transaction` — B2 additive.
  4. `20260719140000_mailbox_b3_nullable_token_refs` — B3 additive.
- Local dev + tests run against SQLite files. Docker compose file
  provisions a Postgres 16 container for future use.
- All B1–B4 code has been written with portability in mind: no
  Postgres-only types (`String[]`, JSONB), no SQLite-only quirks in
  the query paths. Every enum-style column uses `String` per the
  top-of-schema portability comment.

## Why B4 forces the decision now

- Staging must accept a real mailbox connection (§21 of B4 directive
  says C1 webhook work does NOT block staging use). Real OAuth
  requires HTTPS + a stable public URL, which requires the Fly
  deployment, which requires Postgres.
- The founder's directive §19 is explicit: "Do not attempt to run a
  SQLite migration baseline directly against Neon. Treat staging as
  a fresh PostgreSQL database unless founder-approved data migration
  is required."

## Compatibility audit — findings

Grep results across `src/**` and `prisma/**` for constructs that
behave differently between SQLite and PostgreSQL:

| Pattern | SQLite behaviour | Postgres behaviour | Locations | Status |
|---|---|---|---|---|
| `String[]` fields | Not supported natively; would be TEXT | Native TEXT[] | none | ✓ |
| Prisma `Json` type | TEXT | JSONB | none — every JSON is stored as `String` | ✓ |
| Enum types | TEXT | Native enums | none — every enum is `String` per schema comment | ✓ |
| Boolean defaults | INT 0/1 | true/false | in schema, defaults are `false` / `true` — Prisma translates | ✓ |
| Case-insensitive text | LOWER(x) in queries | citext or LOWER | queries in coa export etc. use `.toLowerCase()` in code | ✓ |
| Native `CURRENT_TIMESTAMP` on datetime | Second precision | Microsecond precision | any code that compares timestamps within the same second uses ISO strings, not equality | ✓ |
| SQLite-specific PRAGMA in generated migrations | `PRAGMA defer_foreign_keys=ON;` in the "add column via table rebuild" flow | Not applicable | present in `20260719120000_mailbox_b2_oauth_transaction/migration.sql` and `20260719140000_mailbox_b3_nullable_token_refs/migration.sql` (add-column flow) | Requires the Postgres regeneration below |

**Actionable finding:** the migrations for B2 and B3 include a
SQLite-specific "rebuild table" pattern (create new_MailboxConnection
→ copy → drop → rename) that Postgres does not need — it can `ALTER
TABLE … ADD COLUMN` in place. This is a normal Prisma output shape;
the resolution is to regenerate the migration set against the
Postgres provider before deploying.

## Transition procedure — step by step

Executed against a fresh Postgres database only. The SQLite dev DB
is not migrated.

1. **Duplicate the schema for Postgres validation** (do not edit the
   checked-in schema):

   ```
   cp prisma/schema.prisma prisma/schema.postgres.prisma
   sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.postgres.prisma
   ```

2. **Regenerate migration set against Postgres** to eliminate the
   SQLite table-rebuild pattern:

   ```
   mkdir -p /tmp/pg-mig && cp prisma/migrations/migration_lock.toml /tmp/pg-mig/
   sed -i 's/provider = "sqlite"/provider = "postgresql"/' /tmp/pg-mig/migration_lock.toml
   # Generate a single consolidated migration from empty against the pg schema
   DATABASE_URL="$STAGING_DATABASE_URL" \
     npx prisma migrate diff \
       --from-empty \
       --to-schema-datamodel prisma/schema.postgres.prisma \
       --script > /tmp/pg-mig/0_baseline_pg.sql
   ```

3. **Provision the Neon staging database** — see the Founder Action
   Sheet §Neon.

4. **Apply against fresh Postgres**:

   ```
   DATABASE_URL="$STAGING_DATABASE_URL" \
     psql -f /tmp/pg-mig/0_baseline_pg.sql
   ```

   Alternatively, ship this via `prisma migrate deploy` after moving
   the regenerated migration into `prisma/migrations/` on the branch
   that becomes the staging deploy.

5. **Regenerate the Prisma client for Postgres**:

   ```
   PRISMA_SCHEMA_ENGINE_BINARY="" \
     npx prisma generate --schema prisma/schema.postgres.prisma
   ```

6. **Run the relevant integration test suite against Postgres**:

   ```
   DATABASE_URL="$STAGING_DATABASE_URL" \
     npx vitest run tests/lib/mailbox tests/lib/work-intake
   ```

   Expected outcome: all 99 mailbox + 40 work-intake tests pass
   against Postgres exactly as they pass against SQLite. If any test
   fails, STOP and treat the failure as blocking the staging cutover.

## Data migration

None. Staging is a fresh Postgres database seeded from
`prisma/seed.ts`. Local dev data does not travel to staging; there
is no founder-approved data migration for B4.

## Rollback

If a Postgres-specific migration fails partway through:

- The Neon control plane keeps a point-in-time backup — restore to
  the pre-migration snapshot.
- The Fly release command uses `prisma migrate deploy`; a failed
  migration prevents the release from promoting, so app traffic
  never sees the half-migrated schema.
- On rollback, revert the branch, redeploy, and re-run migrate
  deploy against a restored DB.

## What this document is NOT

- It is NOT authorisation to run the transition. That requires the
  Neon connection string and Founder approval per the Action Sheet.
- It is NOT a schema change. `prisma/schema.prisma` remains SQLite.
- It does NOT modify the SQLite migration history. The B1/B2/B3
  migrations stay as they are; the Postgres path is a separately
  generated set consumed by the staging deploy.
