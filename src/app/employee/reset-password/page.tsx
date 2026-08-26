// HR mobile-hotfix (2026-08-26) — Employee Portal password-reset
// completion page. Reads ?token=... from the email link, verifies
// state at render time (so an expired/used link shows the right
// message instead of the form), then posts new password + token to
// the canonical server action.

import Link from "next/link";
import { getActiveBranding } from "@/lib/branding";
import {
  verifyPortalPasswordResetToken,
} from "@/lib/hr/password-reset";
import { PORTAL_PASSWORD_MIN } from "@/lib/hr/employee-portal-credential";
import { completePortalPasswordResetAction } from "../_password-reset-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; err?: string }>;
}) {
  const sp = await searchParams;
  const rawToken = (sp.token ?? "").trim();
  const err = sp.err ?? null;

  const branding = await getActiveBranding();
  const clubName = branding.mode === "club" && branding.wordmark
    ? branding.wordmark
    : "Your Club";

  const state = await verifyPortalPasswordResetToken(rawToken);

  return (
    <main className="min-h-screen bg-stone-50 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md rounded-lg border border-stone-200 bg-white px-8 py-10">
        <header className="text-center">
          <p className="text-[11px] uppercase tracking-[0.25em] text-stone-500">
            {clubName}
          </p>
          <h1 className="mt-2 font-serif text-2xl leading-tight text-club-ink">
            Choose a new password
          </h1>
        </header>

        {state.kind !== "valid" && (
          <div
            role="alert"
            className="mt-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900"
            data-testid="portal-reset-password-invalid"
          >
            {state.kind === "expired" && "This reset link has expired. Request a new one."}
            {state.kind === "consumed" && "This reset link has already been used. Request a new one."}
            {state.kind === "invalid" && "This reset link is invalid or malformed. Request a new one."}
          </div>
        )}

        {state.kind === "valid" && (
          <>
            {err && (
              <div
                role="alert"
                className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                data-testid="portal-reset-password-error"
              >
                {err}
              </div>
            )}
            <form
              action={completePortalPasswordResetAction}
              className="mt-6 space-y-4"
              noValidate
              data-testid="portal-reset-password-form"
            >
              <input type="hidden" name="token" value={rawToken} />
              <div>
                <label className="label" htmlFor="password">New password</label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  className="input"
                  autoComplete="new-password"
                  required
                  minLength={PORTAL_PASSWORD_MIN}
                  data-testid="portal-reset-password-new"
                />
                <p className="mt-1 text-xs text-stone-500">
                  At least {PORTAL_PASSWORD_MIN} characters.
                </p>
              </div>
              <div>
                <label className="label" htmlFor="confirmPassword">Confirm new password</label>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  className="input"
                  autoComplete="new-password"
                  required
                  minLength={PORTAL_PASSWORD_MIN}
                  data-testid="portal-reset-password-confirm"
                />
              </div>
              <button
                type="submit"
                className="w-full rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
                data-testid="portal-reset-password-submit"
              >
                Set new password
              </button>
            </form>
          </>
        )}

        <div className="mt-6 text-center text-xs text-stone-500 space-x-3">
          <Link href="/employee/forgot-password" className="hover:text-stone-800 underline underline-offset-4">
            Request a new link
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/employee/login" className="hover:text-stone-800 underline underline-offset-4">
            Back to sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
