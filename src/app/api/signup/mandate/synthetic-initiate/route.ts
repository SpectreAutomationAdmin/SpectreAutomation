// SIGNUP-2 M2-SyntheticSandbox (2026-10-27) -- initiate the Stripe
// sandbox mandate flow for a SYNTHETIC_TEST_ONLY registration.
//
// Reachable ONLY when ALL of:
//   - FLY_APP_NAME === "spectre-staging"
//   - SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX === "1"
//   - stripeSdkMode() === "test"
//   - the registrationId query param points at a row with
//     syntheticTestOnly=true
//
// Any failure returns HTTP 403 and never touches Stripe.

import { NextResponse, type NextRequest } from "next/server";
import { ForbiddenError, AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { initiateSyntheticMandateCollection } from "@/lib/signup/signup-2m2-synthetic-sandbox-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const registrationId = url.searchParams.get("registrationId") ?? "";
  if (!registrationId) {
    return NextResponse.json({ error: "bad_request", detail: "registrationId required" }, { status: 400 });
  }
  try {
    const { checkoutUrl } = await initiateSyntheticMandateCollection(registrationId);
    return NextResponse.redirect(checkoutUrl, { status: 303 });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      logger.warn("signup.synthetic.initiate.refused", {
        registrationIdTail: registrationId.slice(-6),
        detail: err.message,
      });
      return NextResponse.json({ error: "forbidden", detail: err.message }, { status: 403 });
    }
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.code, detail: err.message }, { status: err.httpStatus });
    }
    logger.error("signup.synthetic.initiate.failed", {
      registrationIdTail: registrationId.slice(-6),
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

// Operator path: a POST handler too, for CLI-driven testing.
export async function POST(req: NextRequest) {
  return GET(req);
}
