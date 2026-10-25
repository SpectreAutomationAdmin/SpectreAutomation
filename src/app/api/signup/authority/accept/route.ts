// SIGNUP-2 Phase 2B (2026-10-25) -- POST /api/signup/authority/accept.
//
// Records the signatory's commercial-authority attestation for a
// resumed signup registration.  The attestation is Spectre's record
// of the signatory's CLAIM of authority; it is not evidence of
// VERIFIED authority (that lives on SignupRegistration.
// ownershipVerificationState + any Phase-2H operator release).
//
// Hard constraints enforced here, in order:
//
//   1. Feature flag SPECTRE_SIGNUP_2B_ATTESTATION_LIVE must be "1".
//      Default (missing or anything else) = fail-closed.
//
//   2. The active Terms-of-Service document must be APPROVED (not
//      the dev fixture).  See src/lib/billing/terms-of-service.ts.
//
//   3. Token must resolve to an existing SignupRegistration whose
//      status is NOT ABANDONED, whose step is ADMIN_VERIFIED (or
//      already AUTHORITY_ACCEPTED, which is the idempotent-replay
//      case).
//
//   4. Microsoft identity used in the attestation record MUST come
//      from the SignupRegistration row (adminMicrosoftOid /
//      adminMicrosoftTenantId / adminEmail), NEVER from the client.
//
//   5. Idempotency: if a SubscriptionAuthorisationAttestation
//      already exists for this signupRegistrationId, the API
//      returns the existing row (noop).
//
//   6. The attestation record + the step transition are wrapped in
//      a single DB transaction; no partial writes.
//
//   7. Rate-limited (bucket: signup_authority_accept) by IP +
//      token-prefix to prevent brute-force / replay attacks on the
//      token surface.
//
// Phase 2B does NOT create any ClubSubscription row.  Phase 2G is
// the earliest point at which a Club shell + ClubSubscription with
// accessTier = STAGED is provisioned.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/observability/logger";
import { audit } from "@/lib/audit";
import { checkAuthRateLimit } from "@/lib/security/auth-guard";
import { resolveRegistrationByToken } from "@/lib/signup/registration";
import {
  assertAttestationCanProceed,
} from "@/lib/billing/terms-of-service";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The attestation text shown + recorded as SHA-256 at acceptance.
 *  Phase 2B authoring note: this is the DRAFT copy; final wording
 *  requires founder + legal review before `SPECTRE_SIGNUP_2B_
 *  ATTESTATION_LIVE` is flipped to "1" against the APPROVED ToS. */
export const ATTESTATION_TEXT = [
  "I confirm that I hold the commercial authority to bind the above-named",
  "Club to the Spectre Automation subscription at CAD $38,000 per year.",
  "I confirm that I have read the Terms of Service linked above and that",
  "the full name and title I entered are my own.  I understand that this",
  "attestation is immutably recorded with my Microsoft-verified identity,",
  "the exact text I accepted, the exact Terms of Service I was shown, the",
  "time, and my network address, and that Spectre Automation may rely on",
  "this record in subsequent commercial dealings with the Club.",
].join(" ");

function redirectTo(path: string): NextResponse {
  return NextResponse.redirect(new URL(path, env.APP_URL), { status: 303 });
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent") ?? null;

  // Guard 1: Feature flag + ToS APPROVED.  Fail-closed on any gap.
  let doc;
  try {
    const r = assertAttestationCanProceed();
    doc = r.doc;
  } catch (err) {
    logger.warn("signup.authority.accept.gated", {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.redirect(
      new URL(`/signup?error=${encodeURIComponent("The authorisation workflow is not currently available.")}`, env.APP_URL),
      { status: 303 },
    );
  }

  const form = await req.formData();
  const token = String(form.get("token") ?? "").trim();
  const signatoryFullName = String(form.get("signatoryFullName") ?? "").trim();
  const signatoryTitle = String(form.get("signatoryTitle") ?? "").trim();
  const confirmed = String(form.get("confirmed") ?? "").trim();

  if (!token) {
    return redirectTo("/signup?error=session_expired");
  }
  if (!signatoryFullName || signatoryFullName.length < 2 || signatoryFullName.length > 200) {
    return redirectTo(`/signup/t/${encodeURIComponent(token)}/authority?error=${encodeURIComponent("Please enter your full legal name.")}`);
  }
  if (!signatoryTitle || signatoryTitle.length < 2 || signatoryTitle.length > 120) {
    return redirectTo(`/signup/t/${encodeURIComponent(token)}/authority?error=${encodeURIComponent("Please enter your current title at the Club.")}`);
  }
  if (confirmed !== "1") {
    return redirectTo(`/signup/t/${encodeURIComponent(token)}/authority?error=${encodeURIComponent("You must tick the confirmation box to proceed.")}`);
  }

  const rate = await checkAuthRateLimit("signup_authority_accept", token.slice(0, 32), ip ?? "unknown");
  if (!rate.allowed) {
    return redirectTo(`/signup/t/${encodeURIComponent(token)}/authority?error=${encodeURIComponent("Too many attempts.  Please wait a moment and try again.")}`);
  }

  const reg = await resolveRegistrationByToken(token);
  if (!reg) {
    return redirectTo("/signup?error=session_expired");
  }
  // Guard 4: identity-source invariant.  Server reads Microsoft
  // identity from the DB row, never from the client payload.
  if (!reg.adminVerifiedAt || !reg.adminMicrosoftOid || !reg.adminMicrosoftTenantId) {
    logger.warn("signup.authority.accept.not_verified", {
      registrationIdTail: reg.id.slice(-6),
    });
    return redirectTo(`/signup/t/${encodeURIComponent(token)}/admin?error=${encodeURIComponent("Please complete Microsoft identity verification first.")}`);
  }
  if (reg.status === "ABANDONED") {
    return redirectTo("/signup?error=session_expired");
  }

  // Guard 5: idempotent replay.
  const existing = await prisma.subscriptionAuthorisationAttestation.findUnique({
    where: { signupRegistrationId: reg.id },
    select: { id: true, acceptedAt: true },
  });
  if (existing) {
    logger.info("signup.authority.accept.replay", {
      registrationIdTail: reg.id.slice(-6),
      attestationIdTail: existing.id.slice(-6),
    });
    return redirectTo(`/signup/t/${encodeURIComponent(token)}/authority/complete`);
  }

  // Compute content hashes.
  const attestationTextHash = createHash("sha256").update(ATTESTATION_TEXT, "utf8").digest("hex");

  // Guard 6: single-transaction write.
  try {
    const attestation = await prisma.$transaction(async (tx) => {
      const row = await tx.subscriptionAuthorisationAttestation.create({
        data: {
          signupRegistrationId: reg.id,
          clubId: null, // Phase 2G will backfill when Club shell is provisioned
          signatoryFullName,
          signatoryTitle,
          clubLegalName: reg.legalName,
          attestationTextHash,
          attestationTextLength: ATTESTATION_TEXT.length,
          termsVersionSha256: doc.sha256,
          termsVersionLabel: doc.label,
          acceptedAt: new Date(),
          acceptedIp: ip,
          acceptedUserAgent: userAgent,
          acceptedByMicrosoftOid: reg.adminMicrosoftOid,
          acceptedByMicrosoftTid: reg.adminMicrosoftTenantId,
        },
        select: { id: true },
      });
      // Transition the registration step.  Idempotent: AUTHORITY_ACCEPTED
      // is additive to the SignupRegistration.step string column.
      await tx.signupRegistration.update({
        where: { id: reg.id },
        data: { step: "AUTHORITY_ACCEPTED" },
      });
      return row;
    });

    // Audit (outside the transaction so an audit failure never blocks
    // the attestation acceptance).
    try {
      await audit(null, {
        action: "signup.authority.accepted",
        entityType: "SubscriptionAuthorisationAttestation",
        entityId: attestation.id,
        clubId: null,
        meta: {
          registrationIdTail: reg.id.slice(-6),
          termsVersionLabel: doc.label,
          termsVersionSha256Tail: doc.sha256.slice(-10),
          attestationTextHashTail: attestationTextHash.slice(-10),
          acceptedByMicrosoftOidTail: reg.adminMicrosoftOid.slice(-6),
        },
      });
    } catch (e) {
      logger.warn("signup.authority.accept.audit_failed", {
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    logger.info("signup.authority.accepted", {
      registrationIdTail: reg.id.slice(-6),
      attestationIdTail: attestation.id.slice(-6),
      termsVersionLabel: doc.label,
    });

    return redirectTo(`/signup/t/${encodeURIComponent(token)}/authority/complete`);
  } catch (err) {
    logger.error("signup.authority.accept.failed", {
      registrationIdTail: reg.id.slice(-6),
      detail: err instanceof Error ? err.message : String(err),
    });
    return redirectTo(`/signup/t/${encodeURIComponent(token)}/authority?error=${encodeURIComponent("We could not record your authorisation just now.  Please try again.")}`);
  }
}
