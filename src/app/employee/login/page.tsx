// HR-2B.5 §7-9 (2026-08-19) — Employee Portal permanent login.
//
// Uses the Club's white-label branding — the word "Spectre" never
// appears (§7). Login inputs are Employee Number + password. The
// action re-resolves the Club from the current host so employees
// on club-scoped domains only ever sign into their own club (§8);
// rate-limiting + AccountLock live in the service.

import { redirect } from "next/navigation";
import Link from "next/link";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { getActiveBranding } from "@/lib/branding";
import EmployeeLoginForm from "./EmployeeLoginForm";
import { employeePortalLoginAction } from "../_login-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmployeePortalLogin({
  searchParams,
}: {
  searchParams: Promise<{ err?: string; next?: string; reset?: string }>;
}) {
  const already = await getEmployeePortalPrincipal();
  if (already) redirect("/employee");

  const { err, reset } = await searchParams;
  const branding = await getActiveBranding();
  // §7 + [[feedback_member_brand_shielding]]: the Employee Portal
  // NEVER shows the "Spectre" wordmark. When the host resolves to
  // the platform (e.g. staging.spectreautomation.com), fall back to
  // a neutral label — real clubs deploy at their own domain where
  // `branding.mode === "club"` and the Club name surfaces.
  const clubName = branding.mode === "club" && branding.wordmark
    ? branding.wordmark
    : "Your Club";

  return (
    <main className="min-h-screen bg-stone-50 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md rounded-lg border border-stone-200 bg-white px-8 py-10">
        <header className="text-center">
          <p className="text-[11px] uppercase tracking-[0.25em] text-stone-500">
            {clubName}
          </p>
          <h1 className="mt-2 font-serif text-2xl leading-tight text-club-ink">
            Employee Portal
          </h1>
          <p className="mt-1 text-sm text-stone-500">
            Sign in with your email address.
          </p>
        </header>

        {reset && !err && (
          <div
            role="status"
            className="mt-6 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
            data-testid="employee-login-password-reset-success"
          >
            Your password has been updated. Sign in with your email address and
            your new password.
          </div>
        )}
        {err && (
          <div
            role="alert"
            className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            data-testid="employee-login-error"
          >
            {err}
          </div>
        )}

        <div className="mt-6">
          <EmployeeLoginForm action={employeePortalLoginAction} />
        </div>

        <div className="mt-6 text-center text-xs text-stone-500">
          <Link href="/employee/forgot-password" className="hover:text-stone-800 underline underline-offset-4">
            Forgot your password?
          </Link>
        </div>
      </div>
    </main>
  );
}
