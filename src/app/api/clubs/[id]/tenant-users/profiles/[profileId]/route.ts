// TA-1C (2026-09-04) — Tenant profile organizational fields endpoint.
//
// PATCH /api/clubs/[id]/tenant-users/profiles/[profileId]
//   Payload may contain any subset of:
//     displayTitle:        string | null
//     positionId:          string | null   (must belong to same Club)
//     departmentId:        string | null   (must belong to same Club)
//     reportsToProfileId:  string | null   (same-Club, no cycles, must be ACTIVE)
//
// Access role (UserClubRole.roleKey) is NEVER changed by this endpoint.
// Payroll / HR sensitive fields are NEVER touched here.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  setProfileOrganizationalFields,
  setReportsTo,
} from "@/lib/tenant-admin/org-structure";

const UNAUTHORIZED = NextResponse.json({ error: "Not authorised" }, { status: 403 });

function handleErr(err: unknown) {
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
  }
  if (err instanceof NotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
  if (err instanceof ConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  // eslint-disable-next-line no-console
  console.error("[tenant-users profile API]", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; profileId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return UNAUTHORIZED;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    // Explicit allowed shape — never spread `body` blindly into the
    // Prisma update. Rejects any field not listed here.
    const orgUpdate: Record<string, unknown> = { clubId: params.id, profileId: params.profileId };
    if ("displayTitle" in body) orgUpdate.displayTitle = body.displayTitle;
    if ("positionId" in body)   orgUpdate.positionId = body.positionId;
    if ("departmentId" in body) orgUpdate.departmentId = body.departmentId;
    const orgTouched = "displayTitle" in body || "positionId" in body || "departmentId" in body;

    if (orgTouched) {
      await setProfileOrganizationalFields(principal, orgUpdate);
    }

    // Reporting relationship is a separate service (cycle detection,
    // tenant-scope enforcement, transaction). Handle in the same PATCH
    // as a matter of UX.
    if ("reportsToProfileId" in body) {
      await setReportsTo(principal, {
        clubId: params.id,
        profileId: params.profileId,
        reportsToProfileId: body.reportsToProfileId,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleErr(err);
  }
}
