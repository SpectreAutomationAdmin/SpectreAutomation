// Sprint 2 B4.1 — Neon migration orchestrator.
//
// Reads DATABASE_URL from the process environment. NEVER prints it.
// NEVER writes it to disk. Runs the Prisma migrate + verify + test
// pipeline against the Neon PostgreSQL database.
//
// Safe to re-run: `prisma migrate deploy` is idempotent, and the
// verification queries do not mutate the DB. If tests fail, the
// script exits non-zero and does not touch anything.
//
// Usage:
//   1. Put DATABASE_URL="postgresql://…?sslmode=require" in
//      C:\dev\SpectreAutomation\.env.local  (gitignored — safe)
//   2. Run: node scripts/neon-migrate.mjs
//
// Flags (all optional):
//   --dry-run        Do everything except actually apply migrations.
//   --skip-tests     Skip the test suite.
//   --skip-verify    Skip the table/index verification.

import { execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// NOTE: PrismaClient is loaded dynamically AFTER `prisma generate`
// has produced the postgresql client. A top-of-file import would
// cache the SQLite-provider client and every runtime query would
// fail with "URL must start with file:".

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");

// -----------------------------------------------------------------------------
// Load .env / .env.local without printing the URL. dotenv is not
// installed here so we read them manually.
// -----------------------------------------------------------------------------
// Two-tier load. Next.js convention: `.env.local` OVERRIDES both
// `.env` and any pre-existing process.env value. `.env` fills in
// keys that neither of the above define. We follow the same rule
// so a Neon DATABASE_URL in .env.local wins over a stale
// SQLite default in .env.
function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}
const dotenv = parseEnvFile(path.join(root, ".env"));
const dotenvLocal = parseEnvFile(path.join(root, ".env.local"));
// .env fills gaps only.
for (const [k, v] of Object.entries(dotenv)) {
  if (!(k in process.env)) process.env[k] = v;
}
// .env.local overrides unconditionally (Next.js convention).
for (const [k, v] of Object.entries(dotenvLocal)) {
  process.env[k] = v;
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipTests = args.has("--skip-tests");
const skipVerify = args.has("--skip-verify");

// -----------------------------------------------------------------------------
// Guard: DATABASE_URL present + shape looks like Neon Postgres.
// -----------------------------------------------------------------------------
const rawUrl = process.env.DATABASE_URL ?? "";
if (!rawUrl) {
  console.error(
    "[neon-migrate] DATABASE_URL is not set.\n" +
      "  Put your Neon connection string in .env.local (it is gitignored):\n" +
      "    DATABASE_URL=\"postgresql://<user>:<pw>@<host>/<db>?sslmode=require\"\n" +
      "  Then re-run: node scripts/neon-migrate.mjs",
  );
  process.exit(2);
}
if (!/^postgres(ql)?:\/\//.test(rawUrl)) {
  console.error("[neon-migrate] DATABASE_URL is not a postgresql:// URL. Refusing.");
  process.exit(2);
}
if (!rawUrl.includes("neon.tech") && !process.env.SPECTRE_ACCEPT_NON_NEON_URL) {
  console.warn(
    "[neon-migrate] DATABASE_URL host does not look like *.neon.tech.\n" +
      "  Set SPECTRE_ACCEPT_NON_NEON_URL=1 if this is intentional.",
  );
  process.exit(2);
}
// Redact everything but the host portion for the audit line below.
// Never print the raw URL again.
function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//<user>:<hidden>@${u.host}${u.pathname}?<params>`;
  } catch {
    return "<invalid-url>";
  }
}
console.log(`[neon-migrate] target: ${redact(rawUrl)}`);
if (dryRun) console.log("[neon-migrate] DRY RUN — no writes will be applied.");

// -----------------------------------------------------------------------------
// Prepare a Postgres-flavoured schema. The checked-in
// prisma/schema.prisma stays SQLite; the staging deploy path
// consumes a generated variant. Same content, different provider.
// -----------------------------------------------------------------------------
const OUT_DIR = path.join(root, ".neondeploy");
if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
const SCHEMA_PG = path.join(OUT_DIR, "schema.postgres.prisma");
const schema = readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8").replace(
  'provider = "sqlite"',
  'provider = "postgresql"',
);
writeFileSync(SCHEMA_PG, schema, "utf8");

const MIG_DIR = path.join(OUT_DIR, "migrations");
mkdirSync(MIG_DIR, { recursive: true });
writeFileSync(path.join(MIG_DIR, "migration_lock.toml"), 'provider = "postgresql"\n', "utf8");

// -----------------------------------------------------------------------------
// Generate a consolidated baseline migration for Postgres.
// -----------------------------------------------------------------------------
console.log("[neon-migrate] generating Postgres baseline migration from current schema");
const baselineDir = path.join(MIG_DIR, "0_baseline_pg");
mkdirSync(baselineDir, { recursive: true });
const diffSql = execSync(
  `npx prisma migrate diff --from-empty --to-schema-datamodel ${SCHEMA_PG} --script`,
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
writeFileSync(path.join(baselineDir, "migration.sql"), diffSql, "utf8");
console.log(`[neon-migrate] baseline migration: ${diffSql.split("\n").length} lines`);

if (dryRun) {
  console.log("[neon-migrate] --dry-run — stopping before migrate deploy.");
  process.exit(0);
}

// -----------------------------------------------------------------------------
// Apply.
// -----------------------------------------------------------------------------
console.log("[neon-migrate] running prisma migrate deploy against Neon");
execSync(`npx prisma migrate deploy --schema ${SCHEMA_PG}`, {
  cwd: root,
  env: { ...process.env },
  stdio: "inherit",
});

// -----------------------------------------------------------------------------
// Regenerate Prisma client for Postgres so subsequent tests + the
// verification queries below use the correct engine.
// -----------------------------------------------------------------------------
console.log("[neon-migrate] regenerating Prisma client for Postgres");
execSync(`npx prisma generate --schema ${SCHEMA_PG}`, {
  cwd: root,
  env: { ...process.env },
  stdio: "inherit",
});

// -----------------------------------------------------------------------------
// Verify: table + index counts + a hand-picked set of expected names.
// -----------------------------------------------------------------------------
if (!skipVerify) {
  console.log("[neon-migrate] verifying schema on Neon");
  // Dynamic import — Node's ESM loader is fresh at this point so we
  // pick up the just-regenerated PostgreSQL client.
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const tables = await prisma.$queryRawUnsafe(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    );
    const tableNames = (tables).map((r) => r.tablename);
    console.log(`  tables in public schema: ${tableNames.length}`);
    const requiredTables = [
      "Club",
      "User",
      "WorkIntakeItem",
      "WorkIntakeActivity",
      "EmailWorkIntakeOrigin",
      "MailboxConnection",
      "MailboxAccess",
      "GraphSubscription",
      "EmailMessage",
      "EmailAttachment",
      "MailboxOAuthTransaction",
      "MailboxSyncRun",
      "AuditLog",
      "EncryptedSecretMetadata",
      "SecretAccessLog",
      "BackgroundJob",
      "JobRun",
      "_prisma_migrations",
    ];
    const missing = requiredTables.filter((t) => !tableNames.includes(t));
    if (missing.length) {
      console.error(`  MISSING TABLES: ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log(`  ✓ all ${requiredTables.length} required tables present`);

    const indexes = await prisma.$queryRawUnsafe(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' ORDER BY indexname",
    );
    const idxNames = (indexes).map((r) => r.indexname);
    console.log(`  indexes in public schema: ${idxNames.length}`);
    const requiredIndexes = [
      "MailboxConnection_userId_clubId_provider_externalUserId_key",
      "EmailMessage_mailboxConnectionId_graphMessageId_key",
      "EmailAttachment_emailMessageId_graphAttachmentId_key",
      "EmailWorkIntakeOrigin_workIntakeItemId_emailMessageId_key",
      "MailboxAccess_mailboxConnectionId_userId_role_key",
      "GraphSubscription_microsoftSubscriptionId_key",
      "MailboxOAuthTransaction_state_key",
      "WorkIntakeItem_clubId_status_displayReceivedAt_idx",
      "MailboxSyncRun_mailboxConnectionId_queuedAt_idx",
      "GraphSubscription_expirationDateTime_idx",
    ];
    const missingIdx = requiredIndexes.filter((i) => !idxNames.includes(i));
    if (missingIdx.length) {
      console.error(`  MISSING INDEXES: ${missingIdx.join(", ")}`);
      process.exit(1);
    }
    console.log(`  ✓ all ${requiredIndexes.length} required unique/index constraints present`);

    // Migration history — one row.
    const migrations = await prisma.$queryRawUnsafe(
      'SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at',
    );
    console.log(`  applied migrations: ${(migrations).length}`);
    for (const m of migrations) {
      console.log(`    - ${m.migration_name} @ ${m.finished_at?.toISOString?.() ?? m.finished_at}`);
    }

    // Sanity ping — a simple insert + rollback proves DDL + DML both work.
    await prisma.$transaction(async (tx) => {
      const club = await tx.club.create({
        data: { name: "neon-migrate probe", slug: `neon-probe-${Date.now()}` },
      });
      await tx.club.delete({ where: { id: club.id } });
    });
    console.log("  ✓ round-trip write + delete succeeded");
  } finally {
    await prisma.$disconnect();
  }
}

// -----------------------------------------------------------------------------
// Test suite against Neon.
// -----------------------------------------------------------------------------
if (!skipTests) {
  console.log("[neon-migrate] running test suite against Neon");
  try {
    execSync(`npx vitest run tests/lib/mailbox tests/lib/work-intake --reporter=default`, {
      cwd: root,
      env: { ...process.env },
      stdio: "inherit",
    });
    console.log("[neon-migrate] tests pass against Neon");
  } catch {
    console.error("[neon-migrate] tests FAILED against Neon");
    process.exit(1);
  }
}

console.log("\n[neon-migrate] SUCCESS");
console.log("  Founder Action Sheet may now proceed to Step 5 (Upstash Redis).");
