// SIGNUP-1 §2 hardening (2026-10-20) — staging-only diagnostic.
// Reports:
//   - EMAIL_DELIVERY_MODE
//   - Which provider credentials are populated at the env level
//     (never the secret values themselves — only booleans).
//   - The configured FROM address (if present).
//   - A SIGNUP registration count by status, for operator-level
//     visibility while verifying the resume-email pipeline.
//
// Gated by SPECTRE_ALLOW_STAGING_DEBUG so production never exposes it.

import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest) {
  if (process.env.SPECTRE_ALLOW_STAGING_DEBUG !== "1") {
    return NextResponse.json({ error: "debug_endpoint_disabled" }, { status: 404 });
  }

  const mode = env.EMAIL_DELIVERY_MODE ?? "console";

  const microsoft365Configured =
    !!env.MICROSOFT_TENANT_ID &&
    !!env.MICROSOFT_CLIENT_ID &&
    !!env.MICROSOFT_CLIENT_SECRET &&
    !!env.MICROSOFT_FROM_MAILBOX;

  const smtpConfigured =
    !!env.SMTP_HOST &&
    !!env.SMTP_PORT &&
    !!env.SMTP_FROM;

  // Which adapter the platform selector WOULD choose right now:
  const effectiveAdapter =
    mode === "microsoft365" ? (microsoft365Configured ? "microsoft365" : "microsoft365_misconfigured_FALLBACK_FAILS")
    : mode === "smtp" ? (smtpConfigured ? "smtp" : "smtp_misconfigured_FALLBACK_FAILS")
    : mode === "ses" ? "ses_misconfigured_requires_per_club_secrets"
    : "console";

  const byStatus = await prisma.signupRegistration.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const byStep = await prisma.signupRegistration.groupBy({
    by: ["step"],
    _count: { _all: true },
  });
  const byOwnership = await prisma.signupRegistration.groupBy({
    by: ["ownershipVerificationState"],
    _count: { _all: true },
  });

  return NextResponse.json({
    email: {
      mode,
      microsoft365Configured,
      smtpConfigured,
      fromAddress:
        mode === "microsoft365" ? env.MICROSOFT_FROM_MAILBOX ?? null
        : mode === "smtp" ? env.SMTP_FROM ?? null
        : mode === "ses" ? env.SES_FROM_ADDRESS ?? null
        : null,
      effectiveAdapter,
    },
    registrations: {
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      byStep: byStep.map((r) => ({ step: r.step, count: r._count._all })),
      byOwnership: byOwnership.map((r) => ({ state: r.ownershipVerificationState, count: r._count._all })),
    },
    // Platform OAuth client-id prefix (first 6 chars) so SpectreAdmin
    // can verify the signup OAuth client without exposing the secret.
    microsoftOAuth: {
      delegatedClientIdPrefix:
        env.MICROSOFT_GRAPH_DELEGATED_CLIENT_ID
          ? env.MICROSOFT_GRAPH_DELEGATED_CLIENT_ID.slice(0, 8)
          : null,
      authorityAudience: env.MICROSOFT_GRAPH_AUTHORITY_AUDIENCE ?? null,
    },
  }, { status: 200 });
}
