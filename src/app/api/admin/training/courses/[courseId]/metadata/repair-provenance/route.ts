// EP-TRAIN-4Y-X §3 (2026-11-09) — Batch B provenance-repair HTTP wrapper.
//
// Thin route wrapper around `repairCourseMetadataProvenance`. The
// founder directive is explicit:
//   - Caller MUST supply `expectedAuthoredBy` out-of-band.
//   - Caller MUST supply the `titleAtRepair` compare-and-set value.
//   - Service never writes title / description / code.
//
// Permission: hr:training:write on the course's club. Tenant-scoped.
// Audited via the service's audit() call.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import {
  repairCourseMetadataProvenance,
  ProvenanceRepairRejected,
} from "@/lib/hr/training/ai-metadata/provenance-repair-service";
import { AppError, UnauthenticatedError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RawBody {
  readonly expectedAuthoredBy?: unknown;
  readonly titleAtRepair?: unknown;
  readonly evidence?: unknown;
}

function same404() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function POST(
  req: Request,
  context: { params: Promise<{ courseId: string }> },
): Promise<NextResponse> {
  const { courseId } = await context.params;
  if (!courseId) return same404();

  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    return same404();
  }

  let body: RawBody = {};
  try {
    body = (await req.json()) as RawBody;
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "JSON body required" },
      { status: 400 },
    );
  }

  const expectedAuthoredBy = body.expectedAuthoredBy;
  if (expectedAuthoredBy !== "deterministic" && expectedAuthoredBy !== "ai") {
    return NextResponse.json(
      {
        error: "invalid_body",
        message: "expectedAuthoredBy must be 'deterministic' or 'ai'",
      },
      { status: 400 },
    );
  }
  if (typeof body.titleAtRepair !== "string" || body.titleAtRepair.length === 0) {
    return NextResponse.json(
      { error: "invalid_body", message: "titleAtRepair (string) is required" },
      { status: 400 },
    );
  }
  const evidence = typeof body.evidence === "string" ? body.evidence : undefined;

  try {
    const r = await repairCourseMetadataProvenance(principal, {
      courseId,
      clubId,
      expectedAuthoredBy,
      titleAtRepair: body.titleAtRepair,
      evidence,
    });
    return NextResponse.json({
      ok: true,
      outcome: r.outcome,
      courseId: r.courseId,
      attributedAt: r.attributedAt,
      attributedSource: r.attributedSource,
    });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (err instanceof ProvenanceRepairRejected) {
      return NextResponse.json(
        {
          error: "repair_rejected",
          outcome: err.outcome,
          message: err.safeMessage,
        },
        { status: err.httpStatus },
      );
    }
    if (err instanceof AppError) {
      return NextResponse.json(
        { error: err.code, message: err.safeMessage },
        { status: err.httpStatus },
      );
    }
    throw err;
  }
}
