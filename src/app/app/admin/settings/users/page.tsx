// TA-1B (2026-09-03) — Tenant Users page.
//
// Founder-facing surface at /app/admin/settings/users. Shows two
// sections:
//   1. Active administrative users at this Club (name, email, title,
//      department, roles, last login).
//   2. Pending invitations (email, title, invited by, sent, expiry,
//      status; actions: resend, revoke).
// Plus an "Invite user" button that opens a modal form.
//
// Access: uses the tenant-side write gate (assertTenantUsersWrite).
// Rendered inside the standard admin shell.

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { prisma } from "@/lib/prisma";
import { listActiveProfiles, assertTenantUsersWrite } from "@/lib/tenant-admin/profile";
import { listAdminInvitations } from "@/lib/tenant-admin/invitations";
import { listActiveAssignments } from "@/lib/tenant-admin/responsibilities";
import { listPositions, loadOrgTree } from "@/lib/tenant-admin/org-structure";
import { ROLE_LABELS } from "@/lib/tenant-admin/constants";
import { TenantUsersClient } from "./TenantUsersClient";

export const dynamic = "force-dynamic";

export default async function TenantUsersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  try {
    await assertTenantUsersWrite(principal, clubId);
  } catch {
    redirect("/app/admin");
  }

  const [users, invitations, tenantAdmins, departments, positions, orgTree, employees, linkedProfiles] = await Promise.all([
    listActiveProfiles(clubId),
    listAdminInvitations(principal, clubId),
    listActiveAssignments(clubId, "TENANT_ADMINISTRATION"),
    prisma.department.findMany({
      where: { clubId, isActive: true },
      select: { id: true, name: true, code: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    listPositions(clubId),
    loadOrgTree(clubId),
    prisma.employee.findMany({
      where: { clubId, employeeLifecycle: { in: ["PRE_HIRE", "ACTIVE", "LEAVE"] } },
      select: {
        id: true, employeeNumber: true,
        firstName: true, lastName: true, preferredName: true,
        personalEmail: true, email: true, employeeLifecycle: true,
        department: { select: { id: true, name: true } },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
    prisma.userClubProfile.findMany({
      where: { clubId, NOT: { employeeId: null } },
      select: { employeeId: true },
    }),
  ]);

  const tenantAdminUserIds = new Set(tenantAdmins.map((a) => a.userId));
  const linkedEmployeeIds = new Set(linkedProfiles.map((p) => p.employeeId).filter((id): id is string => id !== null));
  // Fold each user's profileId + position + reportsTo hint into their row.
  const orgByUserId = new Map(orgTree.map((n) => [n.userId, n]));

  return (
    <main
      className="mx-auto max-w-6xl px-6 py-8"
      data-testid="tenant-users-page"
      data-club-id={clubId}
    >
      <header className="mb-6" data-testid="tenant-users-header">
        <div
          className="text-[11px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--spectre-text-muted, #6b6357)" }}
        >
          Configuration · Tenant Administration
        </div>
        <h1
          className="mt-1 text-2xl font-semibold"
          style={{ color: "var(--spectre-text-primary, #1a1a1a)" }}
        >
          Tenant Users
        </h1>
        <p
          className="mt-2 max-w-3xl text-sm"
          style={{ color: "var(--spectre-text-secondary, #4a453d)" }}
        >
          People who can operate Spectre for this Club. Invite an administrative user, resend or revoke
          a pending invitation, or review who currently holds the Tenant Administrator responsibility.
        </p>
      </header>

      <TenantUsersClient
        clubId={clubId}
        initialUsers={users.map((u) => {
          const orgNode = orgByUserId.get(u.userId);
          return {
            id: u.id,
            userId: u.userId,
            name: u.user.name,
            email: u.user.email,
            userStatus: u.user.status,
            profileStatus: u.status,
            displayTitle: u.displayTitle,
            positionId: (u as unknown as { positionId: string | null }).positionId ?? null,
            positionName: orgNode?.positionName ?? null,
            department: u.department
              ? { id: u.department.id, name: u.department.name }
              : null,
            reportsToProfileId: orgNode?.reportsToProfileId ?? null,
            roleKeys: u.user.clubRoles.map((r) => r.roleKey),
            roleLabels: u.user.clubRoles.map((r) => ROLE_LABELS[r.roleKey as keyof typeof ROLE_LABELS] ?? r.roleKey),
            lastLoginAt: u.user.lastLoginAt?.toISOString() ?? null,
            isTenantAdmin: tenantAdminUserIds.has(u.userId),
            hasEmployeeLink: orgNode?.hasEmployeeLink ?? false,
          };
        })}
        initialInvitations={invitations.map((inv) => ({
          id: inv.id,
          email: inv.email,
          displayName: inv.displayName,
          displayTitle: inv.displayTitle,
          status: inv.status,
          expiresAt: inv.expiresAt.toISOString(),
          sentAt: inv.sentAt?.toISOString() ?? null,
          createdAt: inv.createdAt.toISOString(),
          initialRoleKeys: inv.initialRoleKeys.split(",").filter(Boolean),
          bootstrap: inv.bootstrap,
          invitedByName: inv.invitedBy?.name ?? inv.invitedBy?.email ?? "—",
          department: inv.department ? { id: inv.department.id, name: inv.department.name } : null,
        }))}
        departments={departments.map((d) => ({ id: d.id, name: d.name, code: d.code }))}
        initialPositions={positions.map((p) => ({
          id: p.id, name: p.name,
          departmentId: p.departmentId,
          departmentName: p.department?.name ?? null,
          sortOrder: p.sortOrder,
          isActive: p.isActive,
        }))}
        initialOrgTree={orgTree}
        initialEmployees={employees.map((e) => ({
          id: e.id,
          employeeNumber: e.employeeNumber,
          name: `${e.preferredName ?? e.firstName} ${e.lastName}`.trim(),
          email: e.personalEmail ?? e.email ?? null,
          lifecycle: e.employeeLifecycle,
          departmentName: e.department?.name ?? null,
          alreadyLinked: linkedEmployeeIds.has(e.id),
        }))}
      />
    </main>
  );
}
