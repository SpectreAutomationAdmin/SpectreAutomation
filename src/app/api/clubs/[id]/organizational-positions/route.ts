// TA-1C — Organizational Position library endpoints.
//
// GET  /api/clubs/[id]/organizational-positions        — list
// POST /api/clubs/[id]/organizational-positions        — create
// (per-position PATCH/DELETE at /organizational-positions/[positionId])

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertTenantUsersWrite } from "@/lib/tenant-admin/profile";
import {
  createPosition,
  listPositions,
} from "@/lib/tenant-admin/org-structure";

const UNAUTHORIZED = NextResponse.json({ error: "Not authorised" }, { status: 403 });

function handleErr(err: unknown) {
  if (err instanceof ValidationError) return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
  if (err instanceof NotFoundError)   return NextResponse.json({ error: err.message }, { status: 404 });
  if (err instanceof ConflictError)   return NextResponse.json({ error: err.message }, { status: 409 });
  if (err instanceof ForbiddenError)  return NextResponse.json({ error: err.message }, { status: 403 });
  // eslint-disable-next-line no-console
  console.error("[organizational-positions API]", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return UNAUTHORIZED;
  try {
    await assertTenantUsersWrite(principal, params.id);
    const url = new URL(req.url);
    const includeInactive = url.searchParams.get("includeInactive") === "true";
    const positions = await listPositions(params.id, { includeInactive });
    return NextResponse.json({
      positions: positions.map((p) => ({
        id: p.id, name: p.name,
        departmentId: p.departmentId,
        departmentName: p.department?.name ?? null,
        description: p.description,
        sortOrder: p.sortOrder,
        isActive: p.isActive,
      })),
    });
  } catch (err) {
    return handleErr(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return UNAUTHORIZED;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const created = await createPosition(principal, { ...body, clubId: params.id });
    return NextResponse.json({
      position: {
        id: created.id, name: created.name,
        departmentId: created.departmentId,
        description: created.description,
        sortOrder: created.sortOrder,
        isActive: created.isActive,
      },
    });
  } catch (err) {
    return handleErr(err);
  }
}
