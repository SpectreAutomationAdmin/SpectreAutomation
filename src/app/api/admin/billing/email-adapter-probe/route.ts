// SIGNUP-2 M4-INT §5 (2026-10-29) -- Safe (non-collection) email
// delivery test endpoint.
//
// Exercises the EXACT same `selectPlatformEmailAdapter` path that
// `notifyClubBeforeRetry` uses in M4-retries.  Does NOT touch any
// billing state.  Does NOT read any club / member / mandate data.
// Does NOT initiate any collection or Stripe mutation.
//
// Access: SUPER_ADMIN only via `platform:signups:release` (reused
// per founder decision 1 "SUPER_ADMIN only at launch"; a finer-
// grained `platform:billing:ops:probe` can be split out in a later
// slice if the operator team expands).
//
// Audit: every probe writes an audit entry naming the SUPER_ADMIN
// that triggered it + the destination mailbox.  The probe body
// states explicitly that no sensitive data is included.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { selectPlatformEmailAdapter } from "@/lib/integrations/email";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";

export async function POST(req: Request): Promise<Response> {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }
  if (!hasPermission(principal, null, "platform:signups:release")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: { toEmail?: string; label?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const toEmail = (body.toEmail ?? "").trim();
  const label = (body.label ?? "manual-probe").slice(0, 60);
  if (!toEmail || !toEmail.includes("@")) {
    return NextResponse.json({ ok: false, error: "toEmail is required" }, { status: 400 });
  }

  // Resolve the adapter.  The call reads EMAIL_DELIVERY_MODE +
  // adapter-specific env vars, same path as M4-retries.
  const adapter = await selectPlatformEmailAdapter();

  const subject = `Spectre M4-INT email-adapter probe (${label})`;
  const sentAtIso = new Date().toISOString();
  // Body contains NO sensitive data -- no bank details, no account
  // identifiers, no club names.  It is purely a delivery probe.
  const bodyText =
    `This message is a Spectre platform email-adapter probe.\n\n` +
    `Label: ${label}\n` +
    `Sent at (UTC): ${sentAtIso}\n` +
    `Triggered by: SUPER_ADMIN probe\n\n` +
    `No billing data, no club data, and no mandate data is included ` +
    `in this message.  If you received this, the Microsoft Graph send ` +
    `path is operational and the M4-retries club-facing notification ` +
    `pipeline will reach the registration administrator.\n\n` +
    `-- Spectre Platform Operations`;

  const result = await adapter.send({
    clubId: "",
    channel: "EMAIL",
    to: { email: toEmail },
    subject,
    body: bodyText,
  });

  await audit(null, {
    action: "signup.m4.int.email_adapter_probe",
    entityType: "AdminProbe",
    entityId: "email-adapter",
    clubId: null,
    meta: {
      triggeringUserIdTail: principal.id.slice(-6),
      toEmailDomain: toEmail.split("@")[1] ?? null,
      label,
      status: result.status,
      providerMessageIdPresent: typeof result.providerMessageId === "string" && result.providerMessageId.length > 0,
      failureReason: result.failureReason ?? null,
      sentAtIso,
    },
  });

  logger.info("signup.m4.int.email_adapter_probe.completed", {
    status: result.status,
    toEmailDomain: toEmail.split("@")[1] ?? null,
    label,
    providerMessageIdTail: typeof result.providerMessageId === "string"
      ? result.providerMessageId.slice(-10)
      : null,
  });

  return NextResponse.json({
    ok: result.status === "SENT",
    status: result.status,
    providerMessageId: result.providerMessageId ?? null,
    failureReason: result.failureReason ?? null,
    sentAtIso,
    label,
  }, { status: result.status === "SENT" ? 200 : 502 });
}
