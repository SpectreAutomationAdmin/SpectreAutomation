// Payroll-3D-3B Slice 7B (2026-09-06) — shared scope-version CAS
// concurrency token.
//
// Every material writer that changes computeScopeRevision inputs
// (PayrollTimesheetEntry writes, TimeClockCorrectionRequest status
// changes) atomically bumps `PayrollDepartmentTimeScopeState.version`
// inside its own transaction. approveTimesheetScope performs a
// version CAS inside its transaction:
//
//   UPDATE PayrollDepartmentTimeScopeState
//   SET updatedAt = now()
//   WHERE clubId=X AND payPeriodId=Y AND departmentId=Z
//     AND version = expectedScopeVersion
//
// If updateMany returns count = 0 → another writer bumped the row
// between the manager's attestation and the approve tx → throw
// ConflictError → tx rolls back → no APPROVED-at-obsolete-version
// row persists.
//
// The scope-state row exists independently of whether a manager has
// ever approved the scope. It is upsert-created lazily on first
// material write OR first read (getScopeReview).

import { prisma } from "../prisma";
import { ConflictError } from "../errors";

// Prisma tx client type — accepts either the global client or an
// interactive-transaction client so bumps can be composed inside any
// existing $transaction boundary.
type PrismaTxOrClient = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export interface ScopeStateRow {
  id: string;
  clubId: string;
  payPeriodId: string;
  departmentId: string;
  version: number;
}

/**
 * Return the current scope-state row, creating it lazily on first
 * access. Safe to call concurrently under real PostgreSQL semantics —
 * Prisma's upsert on Postgres emits a single `INSERT ... ON CONFLICT
 * (unique_key) DO UPDATE SET ... RETURNING ...` statement, which is
 * atomic and NEVER raises SQLSTATE 23505 (unique_violation). No P2002
 * is caught + swallowed inside a caller's `$transaction`, so no risk
 * of transaction poisoning (SQLSTATE 25P02).
 *
 * A non-empty `update` payload (`updatedAt = now()`) is intentional —
 * with an empty update payload, some Prisma versions degrade to
 * SELECT + INSERT under the hood, which is not atomic. The `updatedAt`
 * self-touch keeps the statement on the ON CONFLICT DO UPDATE path
 * and still preserves `version` unchanged for concurrent callers.
 */
export async function ensureScopeState(
  clubId: string, payPeriodId: string, departmentId: string,
  tx?: PrismaTxOrClient,
): Promise<ScopeStateRow> {
  const client = tx ?? prisma;
  const row = await client.payrollDepartmentTimeScopeState.upsert({
    where: {
      clubId_payPeriodId_departmentId: { clubId, payPeriodId, departmentId },
    },
    // Non-empty update — keeps Prisma on the atomic ON CONFLICT DO
    // UPDATE path on Postgres. `version` is intentionally unchanged so
    // a concurrent bump on the same first-create never regresses.
    update: { updatedAt: new Date() },
    create: { clubId, payPeriodId, departmentId, version: 0 },
    select: { id: true, clubId: true, payPeriodId: true, departmentId: true, version: true },
  });
  return row;
}

/**
 * Read the current version WITHOUT creating a row. Returns 0 if the
 * scope-state row doesn't yet exist (semantically equivalent to a
 * fresh scope). Used by attestation-value readers (getScopeReview) so
 * we don't churn the DB with lazy creates on every scope-review call.
 */
export async function readScopeVersion(
  clubId: string, payPeriodId: string, departmentId: string,
  tx?: PrismaTxOrClient,
): Promise<number> {
  const client = tx ?? prisma;
  const row = await client.payrollDepartmentTimeScopeState.findUnique({
    where: {
      clubId_payPeriodId_departmentId: { clubId, payPeriodId, departmentId },
    },
    select: { version: true },
  });
  return row?.version ?? 0;
}

/**
 * Atomically bump the scope-state version for a single scope. Called
 * by every material writer INSIDE its own transaction so the bump
 * commits with the material change.
 *
 * Postgres semantics:
 *   INSERT INTO "PayrollDepartmentTimeScopeState" (...) VALUES (...)
 *   ON CONFLICT ("clubId","payPeriodId","departmentId")
 *   DO UPDATE SET "version" = "PayrollDepartmentTimeScopeState"."version" + 1
 *   RETURNING ...;
 *
 * This is a single atomic statement. Two concurrent bumps against the
 * same scope compose correctly (both take the DO UPDATE branch;
 * `version + 1` runs twice under row lock; final value = start + 2).
 * No SQLSTATE 23505 raised → no P2002 caught → no risk of poisoning
 * the enclosing transaction.
 */
export async function bumpScopeVersion(
  clubId: string, payPeriodId: string, departmentId: string,
  tx?: PrismaTxOrClient,
): Promise<void> {
  const client = tx ?? prisma;
  await client.payrollDepartmentTimeScopeState.upsert({
    where: {
      clubId_payPeriodId_departmentId: { clubId, payPeriodId, departmentId },
    },
    update: { version: { increment: 1 } },
    create: { clubId, payPeriodId, departmentId, version: 1 },
  });
}

/**
 * Bump multiple scopes atomically. Preferred over N sequential bump
 * calls when a writer affects multiple departments (e.g., a materialise
 * pass that touches entries in Events + Grounds).
 */
export async function bumpScopeVersions(
  clubId: string, payPeriodId: string, departmentIds: string[],
  tx?: PrismaTxOrClient,
): Promise<void> {
  const uniqueDeptIds = Array.from(new Set(departmentIds));
  // Sort for deterministic lock acquisition order to avoid deadlocks
  // when two concurrent writers touch overlapping department sets.
  uniqueDeptIds.sort();
  for (const departmentId of uniqueDeptIds) {
    await bumpScopeVersion(clubId, payPeriodId, departmentId, tx);
  }
}

/**
 * Approval-time CAS gate. Called inside approveTimesheetScope's
 * transaction AFTER the approval row is upserted but BEFORE the tx
 * commits. Fails with ConflictError if any material writer bumped
 * the version between the manager's attestation and the approve tx.
 *
 * Returns the current version (which equals expectedVersion when the
 * CAS succeeds) so the caller can persist it as approvedScopeVersion.
 */
export async function casScopeVersion(
  clubId: string, payPeriodId: string, departmentId: string,
  expectedVersion: number,
  tx: PrismaTxOrClient,
): Promise<number> {
  // `updateMany` with a filter that matches zero rows is a NO-OP on
  // Postgres — it returns `{ count: 0 }` cleanly, WITHOUT raising any
  // constraint or SQLSTATE error. That is the whole point: the tx
  // stays healthy, we detect the miss by inspecting `count`, and we
  // throw ConflictError ourselves so the enclosing $transaction
  // rolls back cleanly (no SQLSTATE 25P02, no zombie state).
  const result = await tx.payrollDepartmentTimeScopeState.updateMany({
    where: {
      clubId, payPeriodId, departmentId,
      version: expectedVersion,
    },
    // Touch updatedAt so the CAS is a real UPDATE with predictable row
    // contention; version stays at expectedVersion — the semantic
    // guarantee is "no material change since attestation."
    data: { updatedAt: new Date() },
  });
  if (result.count === 0) {
    throw new ConflictError(
      "The time this scope contains changed while approval was committing. Refresh and re-attest.",
    );
  }
  return expectedVersion;
}
