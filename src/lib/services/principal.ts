// Resolves the current request's Principal from the session, falling back to
// null if unauthenticated. This is the single entry point pages/actions use
// to access the caller's identity + permissions.

import { getSession } from "../session";
import { loadPrincipal, resolveActiveClubId, type Principal } from "../rbac";
import { UnauthenticatedError } from "../errors";

export async function getCurrentPrincipal(): Promise<Principal | null> {
  const session = await getSession();
  if (!session.userId) return null;
  const principal = await loadPrincipal(session.userId, session.activeClubId ?? null);
  if (!principal) return null;
  // Lazily fix up activeClubId if missing/stale.
  if (!principal.activeClubId) {
    principal.activeClubId = await resolveActiveClubId(principal, session.activeClubId);
  }
  return principal;
}

export async function requirePrincipal(): Promise<Principal> {
  const p = await getCurrentPrincipal();
  if (!p) throw new UnauthenticatedError();
  return p;
}
