// TA-1C — Per-position endpoints.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { archivePosition, updatePosition } from "@/lib/tenant-admin/org-structure";

const UNAUTHORIZED = NextResponse.json({ error: "Not authorised" }, { status: 403 });

function handleErr(err: unknown) {
  if (err instanceof ValidationError) return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
  if (err instanceof NotFoundError)   return NextResponse.json({ error: err.message }, { status: 404 });
  if (err instanceof ConflictError)   return NextResponse.json({ error: err.message }, { status: 409 });
  if (err instanceof ForbiddenError)  return NextResponse.json({ error: err.message }, { status: 403 });
  // eslint-disable-next-line no-console
  console.error("[organizational-position API]", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; positionId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return UNAUTHORIZED;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const updated = await updatePosition(principal, params.positionId, body);
    return NextResponse.json({ position: { id: updated.id, name: updated.name, departmentId: updated.departmentId, description: updated.description, sortOrder: updated.sortOrder, isActive: updated.isActive } });
  } catch (err) {
    return handleErr(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; positionId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return UNAUTHORIZED;
  try {
    await archivePosition(principal, params.positionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleErr(err);
  }
}
