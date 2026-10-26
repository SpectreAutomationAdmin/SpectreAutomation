// SIGNUP-2 Phase 2D (2026-10-25) -- GET /api/admin/signup-ops/queue
//
// Returns up to 50 oldest HOLD_FOR_REVIEW registrations for the
// operator inbox UI.  Super-admin gated.  Never surfaces raw
// payload or PII; registrationId tails only.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { readOperatorQueue, computeQueueState } from "@/lib/signup/operator-verification";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest) {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!hasPermission(principal, null, "platform:signups:release")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const rows = await readOperatorQueue(50);
  const payload = rows.map((r) => ({
    id: r.registration.id,
    legalName: r.registration.legalName,
    operatingName: r.registration.operatingName,
    jurisdiction: `${r.registration.country}-${r.registration.provinceState}`,
    holdCategory: r.registration.verificationHoldCategory,
    decidedAt: r.registration.verificationDecidedAt,
    createdAt: r.registration.createdAt,
    state: computeQueueState({
      verdict: "HOLD_FOR_REVIEW",
      holdCategory: r.registration.verificationHoldCategory,
      standingVerified: !!r.standingLatest && r.standingLatest.finding === "VERIFIED",
      authorityVerified: !!r.authorityLatest && r.authorityLatest.finding === "VERIFIED",
    }),
    standingLatest: r.standingLatest
      ? {
          operatorUserIdTail: r.standingLatest.operatorUserId.slice(-6),
          verifiedAt: r.standingLatest.createdAt,
          expiresAt: r.standingLatest.expiresAt,
        }
      : null,
    authorityLatest: r.authorityLatest
      ? {
          operatorUserIdTail: r.authorityLatest.operatorUserId.slice(-6),
          verifiedAt: r.authorityLatest.createdAt,
          expiresAt: r.authorityLatest.expiresAt,
        }
      : null,
  }));
  return NextResponse.json({ queue: payload });
}
