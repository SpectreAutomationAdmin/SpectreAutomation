// SIGNUP-1 §3 (visual acceptance) hardening — staging-only tool to
// simulate a successful Microsoft identity verification against a
// specific registration token.  The Playwright acceptance uses this
// to walk Screens 2 and 3 WITHOUT driving a real Microsoft consent
// screen (that remains a founder-driven round-trip; see
// /api/admin/signup/debug/status for the configuration diagnostic).
//
// What this endpoint does NOT do:
//   - It does NOT grant SUPER_ADMIN or CLUB_ADMIN.
//   - It does NOT create a User or Club.
//   - It does NOT touch the Microsoft provider — the identity it
//     stamps on the registration is synthetic (`debug.verified@spectre.local`,
//     oid/tid prefixed with "DEBUG_").  The ownership-verification
//     classifier then runs on those synthetic signals.
//
// Gated by SPECTRE_ALLOW_STAGING_DEBUG so production can never
// reach it.

import { NextResponse, type NextRequest } from "next/server";
import {
  resolveRegistrationByToken,
  markVerified,
} from "@/lib/signup/registration";
import { issueRecoveryLink } from "@/lib/signup/recovery-link";
import {
  classifyOrganization,
  recordOrganizationDecision,
} from "@/lib/signup/org-verification";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (process.env.SPECTRE_ALLOW_STAGING_DEBUG !== "1") {
    return NextResponse.json({ error: "debug_endpoint_disabled" }, { status: 404 });
  }
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }
  const reg = await resolveRegistrationByToken(token);
  if (!reg) {
    return NextResponse.json({ error: "unknown_or_expired_token" }, { status: 404 });
  }
  if (reg.adminVerifiedAt) {
    return NextResponse.json({ error: "already_verified" }, { status: 409 });
  }
  const syntheticOid = `DEBUG_${Date.now().toString(36)}`;
  const syntheticTid = "DEBUG_tenant_7c0a2d5e";
  const syntheticEmail = "debug.verified@spectre.local";
  // Intentionally leave adminPosition null so Screen 2 can be
  // walked in its "post-identity, position-form" state by the
  // visual-acceptance Playwright.
  await markVerified({
    registrationId: reg.id,
    adminEmail: syntheticEmail,
    adminMicrosoftOid: syntheticOid,
    adminMicrosoftTenantId: syntheticTid,
    adminDisplayName: "Debug Admin",
    adminGivenName: "Debug",
    adminSurname: "Admin",
    adminPosition: null,
  });
  const evidence = await classifyOrganization({
    registrationId: reg.id,
    websiteUrl: reg.websiteUrl,
    adminEmail: syntheticEmail,
    microsoftTenantId: syntheticTid,
    legalName: reg.legalName,
    operatingName: reg.operatingName,
  });
  await recordOrganizationDecision(reg.id, evidence);
  // SIGNUP-1F (2026-10-20) — issue via the dedicated recovery-link
  // table.  Returned to the Playwright caller so cross-browser
  // acceptance can simulate a real email click without an inbox.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const { token: emailToken, linkId, expiresAt } = await issueRecoveryLink({
    registrationId: reg.id,
    toEmail: syntheticEmail,
    issuedByIp: ip,
  });
  return NextResponse.json({
    ok: true,
    verifiedAt: new Date().toISOString(),
    emailResumeToken: emailToken,
    recoveryLinkIdTail: linkId.slice(-6),
    recoveryLinkExpiresAt: expiresAt.toISOString(),
    ownership: evidence.decision,
    reasons: evidence.reasons,
  }, { status: 200 });
}
