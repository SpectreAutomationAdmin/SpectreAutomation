// HR mobile-hotfix (2026-08-26) — Employee Portal password-reset request page.

import Link from "next/link";
import { getActiveBranding } from "@/lib/branding";
import { requestPortalPasswordResetAction } from "../_password-reset-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const { sent } = await searchParams;
  const branding = await getActiveBranding();
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
            Reset your password
          </h1>
          <p className="mt-1 text-sm text-stone-500">
            Enter your Employee Portal email address and we&rsquo;ll send you
            a one-time reset link.
          </p>
        </header>

        {sent ? (
          <div
            className="mt-6 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900"
            data-testid="portal-forgot-password-sent"
            role="status"
          >
            If an Employee Portal account exists for that email address, a
            password-reset link has been sent. Check your inbox
            (and your junk folder just in case). Links expire after
            about 45 minutes.
          </div>
        ) : (
          <form action={requestPortalPasswordResetAction} className="mt-6 space-y-4" noValidate>
            <div>
              <label className="label" htmlFor="email">Email address</label>
              <input
                id="email"
                name="email"
                type="email"
                className="input"
                autoComplete="username"
                inputMode="email"
                required
                maxLength={254}
                placeholder="you@example.com"
                data-testid="portal-forgot-password-email"
              />
            </div>
            <button
              type="submit"
              className="w-full rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
              data-testid="portal-forgot-password-submit"
            >
              Send reset link
            </button>
          </form>
        )}

        <div className="mt-6 text-center text-xs text-stone-500">
          <Link href="/employee/login" className="hover:text-stone-800 underline underline-offset-4">
            Back to sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
