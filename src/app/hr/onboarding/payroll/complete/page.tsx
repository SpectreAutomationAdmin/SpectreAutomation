// HR-2B.3 (2026-08-19) — Payroll · Complete.
//
// Employee has finished the payroll section. HR-2B.4 will replace the
// "Continue (available soon)" affordance with a link into the
// emergency-contacts flow. For HR-2B.3 the section ends here.

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { getPayrollCompletion } from "@/lib/hr/employee-self-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PayrollCompleteStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const completion = await getPayrollCompletion(actor);
  if (!completion.complete) redirect("/hr/onboarding/payroll/review");

  return (
    <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
      <h2 className="font-serif text-2xl leading-tight text-stone-900">
        Payroll information complete.
      </h2>
      <p className="mt-3 text-sm text-stone-700 leading-relaxed">
        Your information has been saved. The Club&apos;s payroll team will
        verify your direct deposit before your first pay.
      </p>
      <p className="mt-4 text-sm text-stone-500 leading-relaxed">
        You can safely close this tab. The next section &mdash; emergency
        contacts &mdash; will be available shortly.
      </p>

      <div className="mt-8 flex items-center justify-between border-t border-stone-100 pt-6">
        <Link
          href="/hr/onboarding/payroll/review"
          className="text-sm text-stone-500 hover:text-stone-800"
        >
          &larr; Back to review
        </Link>
        <button
          type="button"
          disabled
          data-testid="payroll-next"
          className="rounded-md bg-stone-200 px-5 py-2.5 text-sm font-medium text-stone-500 cursor-not-allowed"
        >
          Continue (available soon)
        </button>
      </div>
    </article>
  );
}
