// AUTH-2B.1 regression — schema drift between SQLite dev schema
// (`prisma/schema.prisma`) and Postgres runtime schema
// (`prisma-postgres/schema.prisma`) is the exact defect that caused
// digest 745435047 on staging: the AUTH-2 `Session` model and its
// migration were added to SQLite but never to Postgres, so the
// runtime Prisma client (generated from `prisma-postgres/schema.prisma`
// per `Dockerfile:49`) had no `prisma.session` accessor, and calls to
// `prisma.session.findUnique(...)` threw `TypeError: Cannot read
// properties of undefined (reading 'create')` inside the login route.
//
// This test guards against the same class of regression. Any model or
// migration added to the SQLite schema MUST also be present in the
// Postgres schema before the build image can run correctly on staging.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const SQLITE_SCHEMA = join(REPO_ROOT, "prisma", "schema.prisma");
const POSTGRES_SCHEMA = join(REPO_ROOT, "prisma-postgres", "schema.prisma");
const SQLITE_MIGRATIONS = join(REPO_ROOT, "prisma", "migrations");
const POSTGRES_MIGRATIONS = join(REPO_ROOT, "prisma-postgres", "migrations");

function extractModelNames(schemaPath: string): Set<string> {
  const src = readFileSync(schemaPath, "utf8");
  const names = new Set<string>();
  const re = /^model\s+(\w+)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return names;
}

function listMigrationDirs(migrationsRoot: string): Set<string> {
  const out = new Set<string>();
  for (const entry of readdirSync(migrationsRoot)) {
    if (entry === "migration_lock.toml") continue;
    if (statSync(join(migrationsRoot, entry)).isDirectory()) out.add(entry);
  }
  return out;
}

describe("AUTH-2B.1 · schema parity between SQLite dev and Postgres runtime", () => {
  const sqliteModels = extractModelNames(SQLITE_SCHEMA);
  const postgresModels = extractModelNames(POSTGRES_SCHEMA);

  it("every model in prisma/schema.prisma also exists in prisma-postgres/schema.prisma", () => {
    // Staging generates the Prisma client from prisma-postgres/schema.prisma
    // (Dockerfile:49). If a model exists only in SQLite, the runtime client
    // has no accessor for it and every call to prisma.<model>.<method>()
    // throws TypeError at request time. That is the digest-745435047 bug.
    const missing = [...sqliteModels].filter((m) => !postgresModels.has(m));
    expect(
      missing,
      `models in SQLite but missing from Postgres schema (staging Prisma ` +
        `client will not have accessors for these — cause of digest 745435047): ` +
        `${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("Session model is present in both schemas (AUTH-2 specific pin)", () => {
    expect(sqliteModels.has("Session")).toBe(true);
    expect(postgresModels.has("Session")).toBe(true);
  });

  it("Session model in Postgres schema declares the AUTH-2 authoritative columns", () => {
    const src = readFileSync(POSTGRES_SCHEMA, "utf8");
    const modelMatch = src.match(/model\s+Session\s*\{([\s\S]*?)\n\}/m);
    expect(modelMatch, "Session model block not found in Postgres schema").not.toBeNull();
    const body = modelMatch![1];
    for (const col of [
      "tokenHash",
      "surface",
      "userId",
      "employeeId",
      "clubId",
      "activeClubId",
      "createdAt",
      "lastSeenAt",
      "expiresAt",
      "revokedAt",
      "revokedBy",
      "revokeReason",
    ]) {
      expect(body).toContain(col);
    }
    expect(body).toContain('@relation("SessionUser"');
    expect(body).toContain('@relation("SessionEmployee"');
    expect(body).toContain('@relation("SessionClub"');
  });

  it("20260926_auth2_session migration exists in BOTH prisma/migrations and prisma-postgres/migrations", () => {
    const sqliteMigs = listMigrationDirs(SQLITE_MIGRATIONS);
    const postgresMigs = listMigrationDirs(POSTGRES_MIGRATIONS);
    expect(sqliteMigs.has("20260926_auth2_session")).toBe(true);
    expect(postgresMigs.has("20260926_auth2_session")).toBe(true);
  });

  it("Postgres AUTH-2 migration creates the Session table with all required columns and indexes", () => {
    const path = join(POSTGRES_MIGRATIONS, "20260926_auth2_session", "migration.sql");
    expect(existsSync(path), `missing migration file: ${path}`).toBe(true);
    const sql = readFileSync(path, "utf8");
    expect(sql).toMatch(/CREATE TABLE\s+"Session"/i);
    for (const col of [
      '"tokenHash"',
      '"surface"',
      '"userId"',
      '"employeeId"',
      '"clubId"',
      '"activeClubId"',
      '"createdAt"',
      '"lastSeenAt"',
      '"expiresAt"',
      '"revokedAt"',
      '"revokedBy"',
      '"revokeReason"',
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toMatch(/CREATE UNIQUE INDEX\s+"Session_tokenHash_key"/i);
    expect(sql).toMatch(/Session_userId_fkey/);
    expect(sql).toMatch(/Session_employeeId_fkey/);
    expect(sql).toMatch(/Session_clubId_fkey/);
  });
});
