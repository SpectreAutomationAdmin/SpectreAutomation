// AUTH-3B (2026-09-26) — Canonical employee session-revocation layer.
//
// Every event that must invalidate an employee's active EMPLOYEE sessions
// funnels through this file so:
//   • the reason/actor/audit metadata stays identical across surfaces;
//   • the transactional/failure contract is uniform;
//   • a new lifecycle event added later has one obvious place to wire in.
//
// Callers:
//   • terminateEmployee / archiveEmployee — use `revokeEmployeeSessionsTx`
//     inside their existing atomic $transaction; extend their own audit
//     meta with `sessionsRevoked`.
//   • completePortalPasswordReset — same pattern (already runs in a
//     $transaction).
//   • Admin "Sign out on all devices" — uses `signOutEmployeeEverywhere`
//     which is a standalone, non-transactional action that emits its
//     OWN audit row (`hr.employee.sessions_revoked`).

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { NotFoundError } from "../errors";
import {
  revokeAllForEmployee,
  revokeAllForEmployeeTx,
} from "../services/session-store";
import type { Prisma } from "@prisma/client";

/** Machine-readable reason strings written to `Session.revokeReason`
 *  and audit `meta.reason`. Kept as a discriminated union so a future
 *  event class must be added deliberately. */
export type EmployeeRevocationReason =
  | "lifecycle:terminate"
  | "lifecycle:archive"
  | "password-reset"
  | "admin-force";

/**
 * Transactional variant — call this from inside your own
 * `prisma.$transaction` alongside the business mutation you want to
 * atomically pair with revocation. Returns the count so the caller
 * can attach `sessionsRevoked: N` to their existing audit row.
 *
 * If the surrounding transaction rolls back, the revocation rolls
 * back too — the "employee terminated but sessions still valid"
 * window is impossible.
 */
export async function revokeEmployeeSessionsTx(
  tx: Prisma.TransactionClient,
  employeeId: string,
  opts: { revokedBy?: string | null; reason: EmployeeRevocationReason },
): Promise<number> {
  return revokeAllForEmployeeTx(tx, employeeId, {
    revokedBy: opts.revokedBy ?? null,
    reason: opts.reason,
  });
}

/**
 * Standalone, non-transactional revocation — used by the manual
 * administrative action. Emits its own audit row.
 *
 * The caller is responsible for authorization. The wrapping
 * `signOutEmployeeEverywhere` below is the normal entry point.
 */
export async function revokeEmployeeSessions(input: {
  actor: Principal | { id: string } | null;
  employeeId: string;
  clubId: string;
  reason: EmployeeRevocationReason;
}): Promise<{ sessionsRevoked: number }> {
  const count = await revokeAllForEmployee(input.employeeId, {
    revokedBy: input.actor?.id ?? undefined,
    reason: input.reason,
  });
  await audit(input.actor, {
    action: "hr.employee.sessions_revoked",
    entityType: "Employee",
    entityId: input.employeeId,
    clubId: input.clubId,
    meta: { reason: input.reason, sessionsRevoked: count },
  });
  return { sessionsRevoked: count };
}

/**
 * Admin action — "Sign out [Employee] on all devices."
 *
 * Reused by:
 *   • Employee Profile page control (AUTH-3C).
 *   • Any future admin surface that needs to force-revoke an employee.
 *
 * Authorization contract (per §13 + amendment 3):
 *   • Target must be loaded from DB via `findUnique`, then guarded
 *     with `assertTenantOwned` so a cross-tenant employeeId cannot
 *     be revoked.
 *   • Principal must hold `hr:employee:security` at the target's tenant.
 *     AUTH-3D.RBAC.FIX (2026-09-26) narrowed this from `hr:employee:write`
 *     so an operator can lock a compromised employee's browser without
 *     also gaining authority to edit / archive / terminate that employee.
 *   • Cross-tenant or forged-id attempts throw `NotFoundError` — the
 *     same shape used elsewhere in HR services so response bodies
 *     cannot enumerate whether the id refers to a real employee in
 *     another tenant.
 *   • Employee lifecycle/status does NOT change here — signing a
 *     person out is orthogonal to terminating them.
 */
export async function signOutEmployeeEverywhere(
  principal: Principal,
  employeeId: string,
): Promise<{ sessionsRevoked: number; employeeId: string; clubId: string }> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, clubId: true },
  });
  if (!employee) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(employee, principal);
  requirePermission(principal, employee.clubId, "hr:employee:security");

  const { sessionsRevoked } = await revokeEmployeeSessions({
    actor: principal,
    employeeId: employee.id,
    clubId: employee.clubId,
    reason: "admin-force",
  });
  return { sessionsRevoked, employeeId: employee.id, clubId: employee.clubId };
}
