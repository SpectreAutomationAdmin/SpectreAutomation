// WEB-1D · Employee Portal login — repositioned inside the Spectre auth
// design system so the portal reads as an extension of the marketing
// surface without exposing the "Spectre" wordmark to employees.
//
// HR-2B.5 §7-9 semantics preserved:
//  - §7 white-label brand shielding: club name only, never "Spectre"
//  - §8 club-scoped auth: server action re-resolves the Club from host
//  - §9 rate-limit + AccountLock live in the service, unchanged here

import { redirect } from "next/navigation";
import Link from "next/link";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { getActiveBranding } from "@/lib/branding";
import EmployeeLoginForm from "./EmployeeLoginForm";
import { employeePortalLoginAction } from "../_login-actions";
import { PortalPicture } from "@/components/marketing/AuthPhoto";
import "@/components/marketing/auth.css";

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
  const clubName = branding.mode === "club" && branding.wordmark
    ? branding.wordmark
    : "Your Club";

  return (
    <main className="spectre-auth" data-auth="employee">
      <div className="auth-shell">
        {/* Photographic field ------------------------------------------- */}
        <div className="auth-photo">
          <PortalPicture />
          <div className="auth-photo-scrim" aria-hidden="true" />
          <div className="auth-photo-inner">
            <Link href="/employee" className="auth-photo-brand" aria-label="Spectre Automation home">
              SPECTRE / AUTOMATION
            </Link>
            <div>
              <div className="auth-photo-eyebrow">EMPLOYEE PORTAL</div>
              <h1 className="auth-photo-heading">
                {`Welcome to ${clubName}.`}
              </h1>
              <p className="auth-photo-tag">
                Sign in with your email address to reach your schedule, pay statements
                and the tools you use every day.
              </p>
            </div>
            <span aria-hidden="true" />
          </div>
        </div>

        {/* Form field --------------------------------------------------- */}
        <div className="auth-form-field">
          <div className="auth-form-inner">
            <div className="auth-eyebrow">Sign in</div>
            <h2 className="auth-heading">Employee Portal</h2>
            <p className="auth-lead">
              {`Enter your email address and password. If you have not signed in before, use the invite link we sent you.`}
            </p>

            {reset && !err && (
              <div
                role="status"
                className="auth-error"
                style={{
                  borderColor: "rgba(120, 190, 140, 0.38)",
                  background: "rgba(28, 82, 45, 0.22)",
                  color: "#B8E4C6",
                }}
                data-testid="employee-login-password-reset-success"
              >
                Your password has been updated. Sign in with your email address and your
                new password.
              </div>
            )}
            {err && (
              <div className="auth-error" role="alert" data-testid="employee-login-error">
                {err}
              </div>
            )}

            <EmployeeLoginForm action={employeePortalLoginAction} />

            <div className="auth-utility">
              <Link href="/employee/forgot-password">Forgot your password?</Link>
              <span className="auth-utility-muted">Not an employee? <Link href="/login">Manager login</Link></span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
