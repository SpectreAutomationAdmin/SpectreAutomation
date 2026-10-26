// SIGNUP-2 Phase 2D (2026-10-25) -- POST standing-verified.
//
// Accepts BOTH application/json (programmatic callers) and
// application/x-www-form-urlencoded (operator UI).  HTML form POSTs
// 303-redirect back to the review page; JSON POSTs get a JSON
// response.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { ForbiddenError, AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { checkAuthRateLimit } from "@/lib/security/auth-guard";
import { recordStandingVerification } from "@/lib/signup/operator-verification";
import {
  readOperatorBody,
  wantsHtmlRedirect,
  reviewRedirect,
} from "@/lib/signup/operator-action-shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent") ?? null;
  const html = wantsHtmlRedirect(req);
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) {
    return html
      ? NextResponse.redirect(new URL("/login", req.url), { status: 303 })
      : NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const rate = await checkAuthRateLimit("signup_operator_action", principal.id, ip ?? "unknown");
  if (!rate.allowed) {
    return html
      ? reviewRedirect(params.id, "rate_limited")
      : NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = await readOperatorBody(req);

  try {
    const row = await recordStandingVerification(principal, params.id, {
      evidenceSource: (body.evidenceSource ?? "").trim(),
      evidenceProvenance: body.evidenceProvenance ? body.evidenceProvenance.trim() : undefined,
      evidenceReference: (body.evidenceReference ?? "").trim(),
      reason: body.reason ? body.reason.trim() : undefined,
      operatorIp: ip,
      operatorUserAgent: userAgent,
    });
    return html
      ? reviewRedirect(params.id, "standing_recorded")
      : NextResponse.json({ ok: true, recordIdTail: row.id.slice(-6) });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      logger.warn("signup.operator.standing_verified.refused", {
        registrationIdTail: params.id.slice(-6),
        detail: err.message,
      });
      return html
        ? reviewRedirect(params.id, "forbidden")
        : NextResponse.json({ error: "forbidden", detail: err.message }, { status: 403 });
    }
    if (err instanceof AppError) {
      return html
        ? reviewRedirect(params.id, `error_${err.code.toLowerCase()}`)
        : NextResponse.json({ error: err.code, detail: err.message }, { status: err.httpStatus });
    }
    logger.error("signup.operator.standing_verified.failed", {
      registrationIdTail: params.id.slice(-6),
      detail: err instanceof Error ? err.message : String(err),
    });
    return html
      ? reviewRedirect(params.id, "server_error")
      : NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
