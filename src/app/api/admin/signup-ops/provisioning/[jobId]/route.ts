// SIGNUP-2 Phase 2G (2026-10-26) -- Operator diagnostic GET.
//
// Returns the full TenantProvisioningJob row + its idempotency
// anchors so an operator can inspect provisioning state.  READ-ONLY.
// Super-admin gated.  Does NOT run tickProvisioningJob; use the
// POST sibling endpoint for that.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isSuperAdmin } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } },
): Promise<Response> {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!isSuperAdmin(principal)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const job = await prisma.tenantProvisioningJob.findUnique({
    where: { id: params.jobId },
    select: {
      id: true,
      billingCycleId: true,
      signupRegistrationId: true,
      clubSubscriptionClubId: true,
      state: true,
      attempts: true,
      nextAttemptAt: true,
      lastError: true,
      startedAt: true,
      completedAt: true,
      cancelledAt: true,
      cancelReason: true,
      authorisationEvidenceSource: true,
      authorisationExpiresAt: true,
      invalidatedAt: true,
      invalidatedReason: true,
      provisionedUserId: true,
      provisionedClubId: true,
      rolesAssignedBatchKey: true,
      committedCoaBatchKey: true,
      committedOpeningBalanceBatchKey: true,
      committedBrandingBatchKey: true,
      invitationsDeliveredBatchKey: true,
      welcomeEmailProviderMessageId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!job) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  logger.info("signup.provisioning.diagnostic_api", {
    operatorUserIdTail: principal.id.slice(-6),
    jobIdTail: params.jobId.slice(-6),
    state: job.state,
  });
  return NextResponse.json({ ok: true, job });
}
