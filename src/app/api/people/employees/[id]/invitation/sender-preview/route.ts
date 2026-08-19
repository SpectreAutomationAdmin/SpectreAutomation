// HR-2B.3 tail (2026-08-18) — Read-only preview of the sender identity
// the Club's next invitation will fire from.
//
// GET /api/people/employees/[id]/invitation/sender-preview
//
// Small operator-facing preview so the "Invite to complete onboarding"
// button can render "Invitation will be sent from <email>" BEFORE the
// operator clicks. No token acquisition; no Graph call; no mutation.
// Just reads the canonical `getEmailDeliveryDescriptor(clubId)` and
// surfaces the safe fields.
//
// Authorization:
//   • Admin principal required (getCurrentPrincipal → 401 if absent).
//   • Principal must have `hr:onboarding:invite` at the employee's
//     clubId — the same gate the actual invitation POST enforces —
//     so a caller who cannot issue the invitation cannot preview
//     the sender identity either.
//
// Response body (never carries tokens, scopes, or provider secrets):
//   {
//     mode: "microsoft365_delegated" | "microsoft365" | "smtp" | "ses" | "console",
//     senderIdentity: string | null,   // present for microsoft365_delegated
//     provider: same as mode,
//     ready: boolean                    // whether a real provider is configured
//   }

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getEmailDeliveryDescriptor } from "@/lib/integrations/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const employee = await prisma.employee.findUnique({
    where: { id: params.id },
    select: { id: true, clubId: true },
  });
  if (!employee) return NextResponse.json({ error: "Employee not found" }, { status: 404 });
  if (!hasPermission(principal, employee.clubId, "hr:onboarding:invite")) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  }

  const descriptor = await getEmailDeliveryDescriptor(employee.clubId);
  const senderIdentity =
    descriptor.mode === "microsoft365_delegated" ? (descriptor.designatedConnectedEmail ?? null) : null;
  const ready = descriptor.mode !== "console";

  return NextResponse.json({
    mode: descriptor.mode,
    provider: descriptor.mode,
    senderIdentity,
    ready,
  });
}
