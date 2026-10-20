// SIGNUP-1 (2026-10-19) — POST /api/signup/start.
//
// Receives Screen 1's identity form submission.  Creates a
// SignupRegistration row, sets the HTTPOnly resume cookie, and
// 303-redirects to /signup/t/<token>.
//
// Scope restrictions:
//   • NO writes to User / Club / UserClubRole / ClubSubscription.
//   • NO payment captured.
//   • Rate-limited (public_application bucket) to prevent abuse.

import { NextResponse, type NextRequest } from "next/server";
import { createRegistration } from "@/lib/signup/registration";
import { checkAuthRateLimit } from "@/lib/security/auth-guard";
import { isAppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RESUME_COOKIE = "spectre_signup_resume";
// 7 days — matches the registration TTL.
const RESUME_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function appOriginRedirect(path: string): NextResponse {
  // Mirrors the mailbox-callback pattern — never use req.url for the
  // origin (Fly container's internal origin is unreachable from the
  // user's browser).  env.APP_URL is Zod-validated at boot.
  return NextResponse.redirect(new URL(path, env.APP_URL), { status: 303 });
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent") ?? null;

  // Rate limit by IP + a stable per-form token (we don't have an
  // email yet; use the legal name hash as the per-caller key).
  const form = await req.formData();
  const legalName = String(form.get("legalName") ?? "").trim();
  const rate = await checkAuthRateLimit(
    "signup_start",
    legalName || "anon",
    ip ?? "unknown",
  );
  if (!rate.allowed) {
    return appOriginRedirect(
      `/signup?error=${encodeURIComponent("Too many registration attempts. Please wait a moment and try again.")}`,
    );
  }

  const input = {
    legalName,
    operatingName: String(form.get("operatingName") ?? "").trim(),
    country: String(form.get("country") ?? "").trim().toUpperCase(),
    provinceState: String(form.get("provinceState") ?? "").trim().toUpperCase(),
    addressLine1: String(form.get("addressLine1") ?? "").trim(),
    addressLine2: String(form.get("addressLine2") ?? "").trim(),
    city: String(form.get("city") ?? "").trim(),
    postalCode: String(form.get("postalCode") ?? "").trim(),
    websiteUrl: String(form.get("websiteUrl") ?? "").trim(),
  };

  try {
    const { registrationId, resumeToken } = await createRegistration({
      input,
      ip,
      userAgent,
    });
    logger.info("signup.start.ok", {
      registrationIdTail: registrationId.slice(-6),
    });
    const res = appOriginRedirect(`/signup/t/${encodeURIComponent(resumeToken)}`);
    res.cookies.set(RESUME_COOKIE, resumeToken, {
      httpOnly: true,
      secure: env.APP_URL.startsWith("https://"),
      sameSite: "lax",
      path: "/signup",
      maxAge: RESUME_COOKIE_MAX_AGE_SECONDS,
    });
    return res;
  } catch (err) {
    if (isAppError(err)) {
      return appOriginRedirect(
        `/signup?error=${encodeURIComponent(err.safeMessage)}`,
      );
    }
    logger.error("signup.start.failed", {
      detail: err instanceof Error ? err.message : String(err),
    });
    return appOriginRedirect(
      `/signup?error=${encodeURIComponent("Something went wrong. Please try again.")}`,
    );
  }
}
