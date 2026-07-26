# Prisma migration adoption — one-time transition

Sprint 2 introduces the first Prisma-managed migrations in this
repository. Previously the schema was managed with `db push`. Adoption
must be executed carefully per §9 of the founder's Phase B directive:

> Do not claim that `migrate resolve --applied` itself captures the
> current database. It only marks a migration as applied. The
> baseline SQL and current database schema must genuinely correspond.

## What Sprint 2 already added

Committed to the repo:

- `prisma/migrations/migration_lock.toml` — provider = "sqlite" (dev
  default; production Postgres transition is a separate slice).
- `prisma/migrations/00000000000000_baseline/migration.sql` —
  generated verbatim from the current schema via `prisma migrate diff
  --from-empty --to-schema-datamodel prisma/schema.prisma --script`.
  Represents the state produced by `db push` up to and including the
  pre-Sprint-2 schema. **This file must not be edited by hand.**
- `prisma/migrations/20260719000000_mailbox_integration/migration.sql`
  — additive tables for Sprint 2. Generated via `prisma migrate diff
  --from-migrations prisma/migrations --to-schema-datamodel
  prisma/schema.prisma --script` immediately after the baseline was
  in place.

## Local development database (existing `prisma/dev.db`)

The dev database already contains the pre-Sprint-2 schema, populated
via `db push`. Adopting migrations against it takes these steps in
this order:

1. **Snapshot the current schema** so it can be compared to the
   generated baseline:

   ```
   sqlite3 prisma/dev.db .schema > /tmp/dev-current.sql
   ```

2. **Regenerate the baseline for comparison** (idempotent; should
   produce the same output already in git):

   ```
   npx prisma migrate diff --from-empty \
     --to-schema-datamodel prisma/schema.prisma \
     --script > /tmp/baseline-regen.sql
   ```

3. **Compare** `/tmp/dev-current.sql` and
   `prisma/migrations/00000000000000_baseline/migration.sql`. The two
   describe the SAME schema. If they materially differ, `db push`
   history has drifted from schema.prisma; STOP and reconcile before
   adopting migrations.

4. **Mark the baseline applied** (only after step 3 confirms the
   correspondence):

   ```
   npx prisma migrate resolve --applied 00000000000000_baseline
   ```

5. **Apply the additive Sprint 2 migration**:

   ```
   npx prisma migrate deploy
   ```

   This runs `20260719000000_mailbox_integration/migration.sql`
   against the local dev database.

6. Verify the new tables exist:

   ```
   sqlite3 prisma/dev.db "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('WorkIntakeItem','MailboxConnection','EmailMessage')"
   ```

## Fresh database (test.db, staging, production)

For any database that does NOT already contain the pre-Sprint-2
schema (a fresh SQLite file for tests, or the first Neon Postgres
provisioned for staging):

```
npx prisma migrate deploy
```

Runs both migrations in order. No `migrate resolve` needed — the
baseline builds the pre-Sprint-2 tables and the additive migration
layers the mailbox tables on top.

## Postgres provider swap — deferred

The current `migration_lock.toml` pins the provider to `sqlite`. The
production transition to Postgres is a separate slice and is NOT
bundled with the mailbox feature per §9 of the Phase B directive:

> Do not switch production database providers during the same
> unreviewed step as the mailbox feature.

When we execute that transition:

- Regenerate the baseline against `provider = "postgresql"`.
- Diff old vs new baseline; the differences are limited to identifier
  quoting, DATETIME → TIMESTAMPTZ, TEXT → TEXT (unchanged), REAL →
  DOUBLE PRECISION. Boolean stays.
- The additive Sprint 2 migration is portable — it uses only TEXT,
  DATETIME, INTEGER, REAL, BOOLEAN — all supported by both providers
  under the Prisma layer.
- The switch happens against a fresh Postgres database, not by
  attempting to convert SQLite files. `pg_dump` / `pg_restore` do not
  apply here.

## Rollback

Every model added in Sprint 2 is on the "many" side of a relation
against a pre-existing model (`Club`, `User`). To roll back:

1. `DROP TABLE` in reverse dependency order (children first):
   `EmailAttachment`, `EmailWorkIntakeOrigin`, `EmailMessage`,
   `WorkIntakeActivity`, `GraphSubscription`, `MailboxAccess`,
   `MailboxConnection`, `WorkIntakeItem`.
2. `DELETE FROM _prisma_migrations WHERE migration_name =
   '20260719000000_mailbox_integration'`.
3. Revert `prisma/schema.prisma` and delete the Sprint 2 relations
   from `User` and `Club`.

Live data loss is limited to Sprint 2 mailbox rows only.
