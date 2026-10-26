// SIGNUP-2 Phase 2E (2026-10-26) -- POST /api/signup/mandate/initiate
//
// Called by the applicant-facing /signup/t/[token]/mandate page.
// Returns a redirect to the Stripe Checkout URL (mock-adapter in
// Phase 2E baseline).  Fail-closed on flag + Phase 2B + Phase 2D
// gates.

import { NextResponse, type NextRequest } from "next/server";
import { ForbiddenError, AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { resolveRegistrationByToken } from "@/lib/signup/registration";
import { initiateMandateCollection } from "@/lib/billing/signup-2e-mandate-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let token: string | null = null;
  try {
    const form = await req.formData();
    token = String(form.get("token") ?? "").trim();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!token) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const reg = await resolveRegistrationByToken(token);
  if (!reg) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const { checkoutUrl } = await initiateMandateCollection(reg.id);
    return NextResponse.redirect(checkoutUrl, { status: 303 });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      logger.warn("signup.mandate.initiate.refused", {
        registrationIdTail: reg.id.slice(-6),
        detail: err.message,
      });
      return NextResponse.json({ error: "forbidden", detail: err.message }, { status: 403 });
    }
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.code, detail: err.message }, { status: err.httpStatus });
    }
    logger.error("signup.mandate.initiate.failed", {
      registrationIdTail: reg.id.slice(-6),
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
