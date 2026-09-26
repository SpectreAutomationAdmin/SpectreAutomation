// AUTH-3B (2026-09-26) — Canonical admin-user session-revocation layer.
//
// Companion to `src/lib/hr/employee-session-revocation.ts` for the ADMIN
// surface. Every event that must invalidate a User's active ADMIN
// sessions funnels through here.
//
// Callers today:
//   • Admin "Sign out on all devices" for another user → `signOutUserEverywhere`.
//   • Admin self-service "Sign out on all devices" → same service, passing
//     the principal's own id as target (§15 — no special-casing).
//   • MFA state changes → use `revokeAllForUserTx` inside the existing
//     MFA transaction and extend the MFA audit meta (not a fresh row).
//
// Amendment 2 notes:
//   Admin User deactivation, admin password change/reset, and admin role
//   removal DO NOT currently exist as product mutations. Their AUTH-3
//   disposition is NOT APPLICABLE. When they eventually ship, the
//   canonical wiring is `revokeAllForUserTx` inside the same
//   $transaction — same shape as the employee-side wiring in
//   `terminateEmployee` — and this file is where the standalone-action
//   entry points would grow.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, isSuperAdmin, type Principal } from "../rbac";
import { NotFoundError } from "../errors";
import { revokeAllForUser } from "../services/session-store";

/** Machine-readable reason strings for ADMIN Session revocation. */
export type AdminRevocationReason =
  | "admin-force"
  | "self-force"
  | "mfa-change";

/**
 * Admin action — "Sign out [User] on all devices."
 *
 * Authorization (per amendment 3 — Option A, reuse settings:write):
 *   • Self-revocation is ALWAYS allowed regardless of settings:write.
 *   • Target-revocation requires the principal to hold `settings:write`
 *     at a tenant the target is a member of. The tenant match is what
 *     defines "manages this person"; SUPER_ADMIN naturally inherits
 *     via memberships in every tenant.
 *   • Cross-tenant attempts throw NotFoundError — target metadata is
 *     never leaked, so response cannot be used to enumerate whether
 *     a user id exists in another tenant.
 *
 * Return contract:
 *   `sessionsRevoked` — count of Session rows updated (may be 0 if the
 *     target had no active sessions; the call is still audited and
 *     the caller may still show a friendly "signed out on all
 *     devices" message per §35).
 *   `selfRevocation` — true iff `principal.id === targetUserId`; the
 *     admin UI uses this to decide whether to redirect the caller to
 *     `/login` immediately after the response lands.
 */
export async function signOutUserEverywhere(
  principal: Principal,
  targetUserId: string,
): Promise<{ sessionsRevoked: number; selfRevocation: boolean }> {
  const selfRevocation = principal.id === targetUserId;

  // Load the target with its membership clubIds so we can decide
  // authorization based on shared tenants — never on client input.
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: {
      id: true,
      clubRoles: { select: { clubId: true } },
    },
  });
  if (!target) throw new NotFoundError("User", targetUserId);

  if (!selfRevocation) {
    // Principal must have settings:write at a tenant the target
    // is a member of. Non-null clubIds only — a target that only
    // has platform-level memberships (SUPER_ADMIN with clubId=null)
    // can only be signed out by another SUPER_ADMIN.
    const sharedClubs = target.clubRoles
      .map((r) => r.clubId)
      .filter((c): c is string => !!c);
    const hasSharedTenantAuth = sharedClubs.some((clubId) =>
      hasPermission(principal, clubId, "settings:write"),
    );
    const authorized = isSuperAdmin(principal) || hasSharedTenantAuth;
    if (!authorized) {
      // Same 404 shape as an unknown user — no enumeration signal.
      throw new NotFoundError("User", targetUserId);
    }
  }

  const reason: AdminRevocationReason = selfRevocation ? "self-force" : "admin-force";
  const count = await revokeAllForUser(target.id, {
    revokedBy: principal.id,
    reason,
  });

  await audit(principal, {
    action: "iam.user.sessions_revoked",
    entityType: "User",
    entityId: target.id,
    // Best-effort tenant attribution: prefer the first shared tenant,
    // else the target's first membership clubId. May be null for
    // platform-level actors; audit accepts null.
    clubId: null,
    meta: {
      reason,
      sessionsRevoked: count,
      selfRevocation,
    },
  });

  return { sessionsRevoked: count, selfRevocation };
}

/** Guard used by AUTH-3C UI to decide whether to render the button.
 *  Server-side authorization above still runs on the actual action —
 *  never rely on hiding the button. */
export async function canSignOutUser(
  principal: Principal,
  targetUserId: string,
): Promise<boolean> {
  if (principal.id === targetUserId) return true;
  if (isSuperAdmin(principal)) return true;
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, clubRoles: { select: { clubId: true } } },
  });
  if (!target) return false;
  const sharedClubs = target.clubRoles
    .map((r) => r.clubId)
    .filter((c): c is string => !!c);
  return sharedClubs.some((clubId) => hasPermission(principal, clubId, "settings:write"));
}
