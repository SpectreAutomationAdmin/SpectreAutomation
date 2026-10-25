// SIGNUP-2 Phase 2C (2026-10-25) -- Read-only operator diagnostic.
//
// Returns the three verification artefacts for a single
// SignupRegistration -- classifier decision, attestation metadata,
// and the latest EntityStandingCheck + verdict.
//
// Gated by isSuperAdmin() (Spectre's current platform-level gate).
// The founder authorised a "least-privilege, read-only access
// through `platform:signups:read`" scope; `platform:signups:read`
// is not yet a concrete RBAC permission in this codebase, so Phase
// 2C uses the equivalent super-admin gate.  A future RBAC extension
// can introduce the finer-grained permission without changing this
// handler's contract.
//
// Every call is audited; the payload NEVER contains raw tokens, the
// registry raw payload, or director personal data.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isSuperAdmin } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!isSuperAdmin(principal)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = params.id;
  if (!id || typeof id !== "string" || id.length < 10) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const reg = await prisma.signupRegistration.findUnique({
    where: { id },
    select: {
      id: true,
      legalName: true,
      operatingName: true,
      country: true,
      provinceState: true,
      step: true,
      status: true,
      ownershipVerificationState: true,
      verificationVerdict: true,
      verificationDecidedAt: true,
      verificationDeciderUserId: true,
      verificationHoldCategory: true,
      signingAuthoritySignal: true,
      adminVerifiedAt: true,
      createdAt: true,
    },
  });
  if (!reg) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const attestation = await prisma.subscriptionAuthorisationAttestation.findUnique({
    where: { signupRegistrationId: reg.id },
    select: {
      id: true,
      signatoryTitle: true,
      termsVersionLabel: true,
      acceptedAt: true,
    },
  });

  const standingCheck = await prisma.entityStandingCheck.findFirst({
    where: { signupRegistrationId: reg.id },
    orderBy: { fetchedAt: "desc" },
    select: {
      id: true,
      jurisdiction: true,
      businessNumber: true,
      standing: true,
      officerMatch: true,
      fetchedAt: true,
      // registryPayloadJson deliberately NOT selected -- never
      // surfaced in diagnostics.
    },
  });

  await audit(principal, {
    action: "signup.verification.diagnostic_read",
    entityType: "SignupRegistration",
    entityId: reg.id,
    clubId: null,
    meta: {
      registrationIdTail: reg.id.slice(-6),
      operatorUserIdTail: principal.id.slice(-6),
    },
  });

  logger.info("signup.verification.diagnostic_read", {
    registrationIdTail: reg.id.slice(-6),
    operatorUserIdTail: principal.id.slice(-6),
  });

  return NextResponse.json({
    registration: {
      id: reg.id,
      legalName: reg.legalName,
      operatingName: reg.operatingName,
      jurisdiction: `${reg.country}-${reg.provinceState}`,
      step: reg.step,
      status: reg.status,
      adminVerifiedAt: reg.adminVerifiedAt,
      createdAt: reg.createdAt,
      verification: {
        classifierDecision: reg.ownershipVerificationState,
        verdict: reg.verificationVerdict,
        decidedAt: reg.verificationDecidedAt,
        deciderUserIdTail: reg.verificationDeciderUserId ? reg.verificationDeciderUserId.slice(-6) : null,
        holdCategory: reg.verificationHoldCategory,
        signingAuthoritySignal: reg.signingAuthoritySignal,
      },
    },
    attestation: attestation
      ? {
          id: attestation.id,
          signatoryTitle: attestation.signatoryTitle,
          termsVersionLabel: attestation.termsVersionLabel,
          acceptedAt: attestation.acceptedAt,
        }
      : null,
    entityStandingCheck: standingCheck
      ? {
          id: standingCheck.id,
          jurisdiction: standingCheck.jurisdiction,
          businessNumber: standingCheck.businessNumber,
          standing: standingCheck.standing,
          officerMatch: standingCheck.officerMatch,
          fetchedAt: standingCheck.fetchedAt,
        }
      : null,
  });
}
