// HR-2B.3.1 (2026-08-18) §4 — Employee position catalogue API.
//
// GET  /api/hr/positions       — list active positions for the active club.
// POST /api/hr/positions       — create a new position for the active club.
//
// Both routes delegate to the canonical service in
// `src/lib/hr/employee-positions.ts` so RBAC + audit + tenant
// discipline flow through the same well-worn path. The Add Employee
// form calls POST when the operator uses the inline "+ Add position"
// affordance so a new hire can be created against a fresh role
// without leaving the page.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isAppError, ValidationError } from "@/lib/errors";
import {
  createEmployeePosition,
  listEmployeePositions,
} from "@/lib/hr/employee-positions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });

  try {
    const rows = await listEmployeePositions(principal, clubId);
    return NextResponse.json({
      positions: rows.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        defaultPayRate: p.defaultPayRate.toString(),
        isExempt: p.isExempt,
        isActive: p.isActive,
      })),
    });
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });

  let body: {
    name?: string;
    code?: string;
    defaultPayRate?: number | string;
    isExempt?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const defaultPayRateNum =
    body.defaultPayRate === undefined || body.defaultPayRate === null || body.defaultPayRate === ""
      ? 0
      : typeof body.defaultPayRate === "string"
        ? Number(body.defaultPayRate)
        : body.defaultPayRate;

  try {
    const created = await createEmployeePosition(principal, clubId, {
      name: body.name ?? "",
      code: body.code,
      defaultPayRate: defaultPayRateNum,
      isExempt: body.isExempt ?? false,
    });
    return NextResponse.json(
      {
        position: {
          id: created.id,
          code: created.code,
          name: created.name,
          defaultPayRate: created.defaultPayRate.toString(),
          isExempt: created.isExempt,
          isActive: created.isActive,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(
        { error: err.safeMessage, issues: err.issues },
        { status: err.httpStatus },
      );
    }
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
