// Tenant-safe query helpers. Every service-layer database call MUST go
// through one of these helpers (or build its own filter using `tenantScope`).
//
// The contract:
//   - `tenantScope(principal)` returns `{ clubId }` for non-super users,
//     or `{}` for SUPER_ADMIN.
//   - `assertTenantOwned(record, principal)` checks an already-fetched record's
//     clubId. Use this *after* a findUnique on a primary key to make sure the
//     record actually belongs to a tenant the principal can access.
//
// The two layers together give defense-in-depth: even if a query forgets the
// scope filter, the post-read check catches the leak.

import type { Principal } from "../rbac";
import { isSuperAdmin } from "../rbac";
import { TenantViolationError } from "../errors";

export function tenantScope(principal: Principal): { clubId?: string | { in: string[] } } {
  if (isSuperAdmin(principal)) return {};
  const clubIds = principal.memberships.map((m) => m.clubId).filter((c): c is string => !!c);
  if (clubIds.length === 0) {
    // Block: a non-super user with no club memberships should never read any tenant rows.
    return { clubId: "__no_tenant__" };
  }
  if (clubIds.length === 1) return { clubId: clubIds[0] };
  return { clubId: { in: clubIds } };
}

// Stricter variant: enforce a single, explicit club for the request.
export function tenantWhere(principal: Principal, clubId: string): { clubId: string } {
  if (!isSuperAdmin(principal) && !principal.memberships.some((m) => m.clubId === clubId)) {
    throw new TenantViolationError(`no access to club ${clubId}`);
  }
  return { clubId };
}

// Defense-in-depth: assert a record we already fetched belongs to a tenant
// the principal can see. Use after any findUnique on a primary key.
export function assertTenantOwned<T extends { clubId: string }>(record: T | null, principal: Principal): asserts record is T {
  if (!record) throw new TenantViolationError("record missing");
  if (isSuperAdmin(principal)) return;
  if (!principal.memberships.some((m) => m.clubId === record.clubId)) {
    throw new TenantViolationError(`record clubId=${record.clubId} not in principal memberships`);
  }
}
