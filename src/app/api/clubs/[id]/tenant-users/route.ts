// TA-1B closeout (2026-09-03) — Tenant Users API.
//
// GET  /api/clubs/[id]/tenant-users
//   Returns active administrative users + pending invitations for the
//   founder-facing Tenant Users page.
//
// POST /api/clubs/[id]/tenant-users
//   Creates an admin invitation AND dispatches the email through
//   Spectre's canonical multi-provider email stack. Returns delivery
//   status + a public-safe subset of the invitation row. NEVER
//   returns the raw activation URL in the normal response.
//
// Test-only escape hatch: when the deployed process has
//   SPECTRE_ALLOW_ACTIVATION_URL=true
// AND the caller is SUPER_ADMIN AND the request carries
//   ?includeActivationUrl=true
// the response ADDITIONALLY includes `activationUrl`. Production never
// sets the env var; staging sets it so Playwright can drive activation.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from "@/lib/errors";
import {
  createAdminInvitation,
  listAdminInvitations,
} from "@/lib/tenant-admin/invitations";
import { listActiveProfiles, assertTenantUsersWrite } from "@/lib/tenant-admin/profile";
import { listActiveAssignments } from "@/lib/tenant-admin/responsibilities";
import { resolvePublicHost } from "@/lib/tenant-admin/invitation-email";
import { listPositions, loadOrgTree } from "@/lib/tenant-admin/org-structure";
import { prisma } from "@/lib/prisma";

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
    const [users, invitations, tenantAdmins, positions, orgTree, employees, linkedProfiles] = await Promise.all([
      listActiveProfiles(clubId),
      listAdminInvitations(principal, clubId, { includeTerminal }),
      listActiveAssignments(clubId, "TENANT_ADMINISTRATION"),
      listPositions(clubId),
      loadOrgTree(clubId),
      // Only display-safe Employee fields — the modal needs enough to
      // let a Tenant Admin recognise an existing Employee and link
      // them to a new invitation. NEVER SIN / bank / TD1 / comp.
      prisma.employee.findMany({
        where: { clubId, employeeLifecycle: { in: ["PRE_HIRE", "ACTIVE", "LEAVE"] } },
        select: {
          id: true, employeeNumber: true,
          firstName: true, lastName: true, preferredName: true,
          personalEmail: true, email: true, employeeLifecycle: true,
          department: { select: { id: true, name: true } },
          position: { select: { id: true, name: true } },
        },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      }),
      // Which Employee ids already have a UserClubProfile at this club?
      // The picker uses this to grey-out already-linked employees so a
      // Tenant Admin cannot accidentally double-link.
      prisma.userClubProfile.findMany({
        where: { clubId, NOT: { employeeId: null } },
        select: { employeeId: true },
      }),
    ]);
    const linkedEmployeeIds = new Set(linkedProfiles.map((p) => p.employeeId).filter((id): id is string => id !== null));
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
      positions: positions.map((p) => ({
        id: p.id, name: p.name,
        departmentId: p.departmentId,
        departmentName: p.department?.name ?? null,
        description: p.description, sortOrder: p.sortOrder, isActive: p.isActive,
      })),
      orgTree,
      employees: employees.map((e) => ({
        id: e.id,
        employeeNumber: e.employeeNumber,
        name: `${e.preferredName ?? e.firstName} ${e.lastName}`.trim(),
        email: e.personalEmail ?? e.email ?? null,
        lifecycle: e.employeeLifecycle,
        departmentName: e.department?.name ?? null,
        positionName: e.position?.name ?? null,
        alreadyLinked: linkedEmployeeIds.has(e.id),
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
    const url = new URL(req.url);
    const body = (await req.json()) as Record<string, unknown>;
    const payload = { ...body, clubId };
    const created = await createAdminInvitation(principal, payload);

    // Test-only escape hatch. Multi-gated:
    //   (a) process env SPECTRE_ALLOW_ACTIVATION_URL=true — set ONLY
    //       on staging; production Fly config never sets this
    //   (b) explicit request opt-in ?includeActivationUrl=true
    //   (c) caller already passed assertTenantUsersWrite above so
    //       is a SUPER_ADMIN, CLUB_ADMIN, or TENANT_ADMINISTRATION
    //       holder at this club
    // All three must hold; production is closed by (a).
    const gateOn = process.env.SPECTRE_ALLOW_ACTIVATION_URL === "true";
    const requested = url.searchParams.get("includeActivationUrl") === "true";
    const allowActivationUrl = gateOn && requested;

    const responseBody: Record<string, unknown> = {
      invitation: {
        id: created.invitation.id,
        email: created.invitation.email,
        status: created.invitation.status,
        expiresAt: created.invitation.expiresAt,
        sentAt: created.invitation.sentAt,
        initialRoleKeys: created.invitation.initialRoleKeys.split(",").filter(Boolean),
        bootstrap: created.invitation.bootstrap,
      },
      delivery: {
        status: created.delivery.status,
        externalSendConfirmed: created.delivery.externalSendConfirmed,
        operatorAlert: created.delivery.operatorAlert,
        provider: created.delivery.provider,
        // failureReason surfaced to founder-visible copy — safe (never
        // contains the token, per invitation-email.ts contract).
        failureReason: created.delivery.failureReason,
      },
      existingUser: created.existingUser,
    };
    if (allowActivationUrl) {
      const publicHost = safePublicHost();
      responseBody.activationUrl = publicHost ? `${publicHost.replace(/\/$/, "")}/invite/${created.rawToken}` : null;
      responseBody.rawTokenReturnedOnce = true;
    }
    return NextResponse.json(responseBody);
  } catch (err) {
    return handleErr(err);
  }
}

function safePublicHost(): string | null {
  try { return resolvePublicHost(); } catch { return null; }
}
