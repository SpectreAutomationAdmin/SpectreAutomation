// HR-2B.3 (2026-08-19) — Payroll · SIN step.
//
// Employee enters their Social Insurance Number. The plaintext never
// leaves the encrypt+persist scope inside `submitSelfSin` — this page
// stores nothing client-side and displays only the masked helper on
// revisit (see `maskSin` for the mask shape).

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { getSelfSinMasked } from "@/lib/hr/employee-self-service";
import { clearSinAction, saveSinAction } from "../_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SinStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const masked = await getSelfSinMasked(actor);

  return (
    <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
      <h2 className="font-serif text-2xl leading-tight text-stone-900">
        Your Social Insurance Number.
      </h2>
      <p className="mt-2 text-sm text-stone-500 leading-relaxed">
        Your SIN is required to report your income to the CRA. It is
        encrypted at rest and only available to authorized payroll staff.
      </p>

      {masked ? (
        <div className="mt-8 space-y-6">
          <div className="rounded-md border border-stone-200 bg-stone-50 px-4 py-4">
            <p className="text-xs uppercase tracking-[0.2em] text-stone-500">
              Social Insurance Number
            </p>
            <p className="mt-1 font-mono text-lg text-stone-900" data-testid="sin-masked">
              {masked}
            </p>
          </div>
          <form action={clearSinAction} noValidate>
            <button
              type="submit"
              data-testid="sin-change"
              className="text-sm text-stone-600 underline hover:text-stone-900"
            >
              Change SIN
            </button>
          </form>

          <div className="flex items-center justify-between pt-2">
            <Link
              href="/hr/onboarding/about-you/complete"
              className="text-sm text-stone-500 hover:text-stone-800"
            >
              &larr; Back
            </Link>
            <Link
              href="/hr/onboarding/payroll/direct-deposit"
              className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
            >
              Continue
            </Link>
          </div>
        </div>
      ) : (
        <form action={saveSinAction} className="mt-8 space-y-6" noValidate>
          <label className="block">
            <span className="block text-sm text-stone-700">Social Insurance Number</span>
            <input
              type="text"
              name="sin"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              required
              placeholder="123 456 789"
              maxLength={13}
              data-testid="sin-input"
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base font-mono tracking-wider text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
            />
            <span className="mt-2 block text-xs text-stone-500">
              9 digits. Spaces or dashes are okay.
            </span>
          </label>

          <div className="flex items-center justify-between pt-2">
            <Link
              href="/hr/onboarding/about-you/complete"
              className="text-sm text-stone-500 hover:text-stone-800"
            >
              &larr; Back
            </Link>
            <button
              type="submit"
              className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
            >
              Continue
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
