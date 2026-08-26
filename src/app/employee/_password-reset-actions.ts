"use server";

// HR mobile-hotfix (2026-08-26) — Employee Portal password-reset
// server actions. Split from _login-actions.ts to keep the auth-critical
// login path free of unrelated write surfaces.

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { hashEmail } from "@/lib/security/auth-guard";
import { consumeRate } from "@/lib/security/rate-limit";
import { RateLimitError } from "@/lib/errors";
import { normaliseLoginEmail } from "@/lib/hr/employee-portal-credential";
import { getActiveBranding } from "@/lib/branding";
import {
  requestPortalPasswordReset,
  completePortalPasswordReset,
} from "@/lib/hr/password-reset";
import { destroyEmployeePortalSession } from "@/lib/employee-portal-session";

function withErr(path: string, safeMessage: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}err=${encodeURIComponent(safeMessage)}`;
}

/**
 * Resolve the public origin the emailed reset link should use.
 * Reads x-forwarded-host / x-forwarded-proto exactly like the
 * canonical logout route so the URL points to the browser's
 * requested origin, not the container's internal bind host.
 */
async function resolvePublicOrigin(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Request — /employee/forgot-password
// ---------------------------------------------------------------------------

export async function requestPortalPasswordResetAction(formData: FormData): Promise<void> {
  const emailRaw = (formData.get("email") as string | null) ?? "";
  const email = normaliseLoginEmail(emailRaw);
  const branding = await getActiveBranding();
  const clubId = branding.clubId ?? null;

  if (!email) {
    // Same neutral outcome shape — never leak whether the email was
    // even syntactically parseable versus missing.
    redirect("/employee/forgot-password?sent=1");
  }

  // Rate-limit per (clubId-or-platform + normalised email). Hashed.
  const rateKey = hashEmail(`${clubId ?? "platform"}:${email}`);
  try {
    await consumeRate("login", rateKey);
  } catch (err) {
    if (err instanceof RateLimitError) {
      // Even the rate-limit response is neutral to avoid leaking
      // that an email was previously targeted.
      redirect("/employee/forgot-password?sent=1");
    }
    throw err;
  }

  const publicOrigin = await resolvePublicOrigin();
  await requestPortalPasswordReset({
    email, clubId, actorSource: "EMPLOYEE", publicOrigin,
  });
  redirect("/employee/forgot-password?sent=1");
}

// ---------------------------------------------------------------------------
// Complete — /employee/reset-password
// ---------------------------------------------------------------------------

export async function completePortalPasswordResetAction(formData: FormData): Promise<void> {
  const rawToken = (formData.get("token") as string | null) ?? "";
  const password = (formData.get("password") as string | null) ?? "";
  const confirmPassword = (formData.get("confirmPassword") as string | null) ?? "";

  if (!rawToken) {
    redirect(withErr("/employee/reset-password", "Reset link is missing or malformed."));
  }

  const result = await completePortalPasswordReset({ rawToken, password, confirmPassword });

  if (result.kind === "success") {
    // If the user happened to have an active session in this browser
    // (edge case: they opened the reset link while still signed in),
    // wipe it so their next request goes through fresh login.
    await destroyEmployeePortalSession();
    redirect("/employee/login?reset=1");
  }

  const message = (() => {
    switch (result.kind) {
      case "invalid_token": return "This reset link is invalid. Request a new one.";
      case "expired_token": return "This reset link has expired. Request a new one.";
      case "consumed_token": return "This reset link has already been used. Request a new one.";
      case "password_mismatch": return "The two password entries do not match.";
      case "password_policy": return result.policyMessage ?? "Password does not meet the required policy.";
    }
  })();
  const params = new URLSearchParams();
  if (rawToken) params.set("token", rawToken);
  params.set("err", message);
  redirect(`/employee/reset-password?${params.toString()}`);
}
