// TA-1B (2026-09-03) — Tenant Users API (invitations list + create).
//
// GET  /api/clubs/[id]/tenant-users
//   Returns current active administrative users + pending invitations
//   for the founder-facing Tenant Users page.
//
// POST /api/clubs/[id]/tenant-users
//   Creates an admin invitation. Returns the invitation row + raw token
//   ONCE (the caller is expected to hand off to email delivery — TA-1B
//   surfaces the raw activation URL in the UI response so the founder
//   can copy it during acceptance testing).

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from "@/lib/errors";
import {
  createAdminInvitation,
  listAdminInvitations,
} from "@/lib/tenant-admin/invitations";
import { listActiveProfiles, assertTenantUsersWrite } from "@/lib/tenant-admin/profile";
import { listActiveAssignments } from "@/lib/tenant-admin/responsibilities";

const UNAUTHORIZED = NextResponse.json({ error: "Not authorised" }, { status: 403 });

function handleErr(err: unknown) {
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof ConflictError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  // eslint-disable-next-line no-console
  console.error("[tenant-users API]", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal) return UNAUTHORIZED;
  try {
    await assertTenantUsersWrite(principal, clubId);
    const url = new URL(req.url);
    const includeTerminal = url.searchParams.get("includeTerminal") === "true";
    const [users, invitations, tenantAdmins] = await Promise.all([
      listActiveProfiles(clubId),
      listAdminInvitations(principal, clubId, { includeTerminal }),
      listActiveAssignments(clubId, "TENANT_ADMINISTRATION"),
    ]);
    return NextResponse.json({
      users: users.map((u) => ({
        id: u.id,
        userId: u.userId,
        name: u.user.name,
        email: u.user.email,
        userStatus: u.user.status,
        profileStatus: u.status,
        displayTitle: u.displayTitle,
        department: u.department ? { id: u.department.id, name: u.department.name } : null,
        roleKeys: u.user.clubRoles.map((r) => r.roleKey),
        lastLoginAt: u.user.lastLoginAt,
        createdAt: u.createdAt,
      })),
      invitations: invitations.map((inv) => ({
        id: inv.id,
        email: inv.email,
        displayName: inv.displayName,
        displayTitle: inv.displayTitle,
        status: inv.status,
        expiresAt: inv.expiresAt,
        sentAt: inv.sentAt,
        openedAt: inv.openedAt,
        createdAt: inv.createdAt,
        initialRoleKeys: inv.initialRoleKeys.split(",").filter(Boolean),
        bootstrap: inv.bootstrap,
        invitedBy: inv.invitedBy ? { name: inv.invitedBy.name, email: inv.invitedBy.email } : null,
        department: inv.department ? { id: inv.department.id, name: inv.department.name } : null,
        employee: inv.employee
          ? { id: inv.employee.id, name: `${inv.employee.firstName} ${inv.employee.lastName}` }
          : null,
      })),
      tenantAdministrators: tenantAdmins.map((a) => ({
        assignmentId: a.id,
        userId: a.userId,
        role: a.role,
        userName: a.user.name,
        userEmail: a.user.email,
        effectiveFrom: a.effectiveFrom,
      })),
    });
  } catch (err) {
    return handleErr(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal) return UNAUTHORIZED;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const payload = { ...body, clubId };
    const { invitation, token } = await createAdminInvitation(principal, payload);
    const origin = new URL(req.url).origin;
    return NextResponse.json({
      invitation: {
        id: invitation.id,
        email: invitation.email,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        initialRoleKeys: invitation.initialRoleKeys.split(",").filter(Boolean),
        bootstrap: invitation.bootstrap,
      },
      activationUrl: `${origin}/invite/${token}`,
      rawTokenReturnedOnce: true,
    });
  } catch (err) {
    return handleErr(err);
  }
}
