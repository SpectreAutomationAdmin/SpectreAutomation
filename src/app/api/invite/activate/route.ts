// TA-1B — Public invitation activation endpoint.

import { NextRequest, NextResponse } from "next/server";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { activateAdminInvitation } from "@/lib/tenant-admin/invitations";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as unknown;
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const userAgent = req.headers.get("user-agent") ?? null;
    const result = await activateAdminInvitation(body, {
      ip: ip ?? undefined,
      userAgent: userAgent ?? undefined,
    });
    return NextResponse.json({
      ok: true,
      invitationId: result.invitationId,
      userId: result.userId,
      bootstrapPrimaryAssigned: result.bootstrapPrimaryAssigned,
      createdUser: result.createdUser,
      redirectPath: result.redirectPath,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    }
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // eslint-disable-next-line no-console
    console.error("[invite activate]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
