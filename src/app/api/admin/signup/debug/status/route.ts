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
import { env, signupRedirectUri, mailboxRedirectUri } from "@/lib/env";
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

  // SIGNUP-1 §2 hardening (2026-10-20) — SES now usable at the
  // platform level via env creds + a verified FROM identity.
  const sesConfigured =
    !!env.AWS_REGION &&
    !!env.SES_FROM_ADDRESS &&
    !!env.AWS_ACCESS_KEY_ID &&
    !!env.AWS_SECRET_ACCESS_KEY;

  // Which adapter the platform selector WOULD choose right now:
  const effectiveAdapter =
    mode === "microsoft365" ? (microsoft365Configured ? "microsoft365" : "microsoft365_misconfigured_FALLBACK_FAILS")
    : mode === "smtp" ? (smtpConfigured ? "smtp" : "smtp_misconfigured_FALLBACK_FAILS")
    : mode === "ses" ? (sesConfigured ? "ses" : "ses_misconfigured_FALLBACK_FAILS")
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
      sesConfigured,
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
    // Platform OAuth client-id prefix (first 8 chars) + the exact
    // redirect URIs Spectre will send to Microsoft.  AADSTS50011
    // happens when ANY of these URIs isn't registered on the Entra
    // app with matching client-id.  Operator responsibility: copy
    // the two `redirectUri` strings into the Entra app registration
    // under Authentication → Web → Redirect URIs.
    microsoftOAuth: {
      delegatedClientIdPrefix:
        env.MICROSOFT_GRAPH_DELEGATED_CLIENT_ID
          ? env.MICROSOFT_GRAPH_DELEGATED_CLIENT_ID.slice(0, 8)
          : null,
      authorityAudience: env.MICROSOFT_GRAPH_AUTHORITY_AUDIENCE ?? null,
      signupRedirectUri: signupRedirectUri(),
      mailboxRedirectUri: mailboxRedirectUri(),
      readinessNote:
        "Both signupRedirectUri AND mailboxRedirectUri must be registered on the Entra app whose client-id starts with the prefix above.  AADSTS50011 at Microsoft means the URI Spectre sent is not in that list.",
    },
  }, { status: 200 });
}
