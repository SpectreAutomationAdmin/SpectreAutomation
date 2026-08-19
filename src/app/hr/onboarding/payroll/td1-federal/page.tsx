// HR-2B.3 (2026-08-19) — Payroll · Federal TD1 step.
//
// HR-2B.3.5 (2026-08-19) — Province of employment is a CLUB property,
// not an employee question. The province selector was removed; the
// applicable provincial TD1 is derived server-side from
// `Club.payrollProvince` (see src/lib/hr/club-payroll-province.ts).
// If the Club is unconfigured we render a neutral fail-safe message
// and hide the form entirely — no employee is asked to guess.

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import {
  getSelfTaxProfileMasked,
  getSelfTd1Attestation,
} from "@/lib/hr/employee-self-service";
import {
  TD1_FEDERAL_ADDITIONAL_CLAIMS,
  TD1_FEDERAL_CURRENT,
} from "@/lib/hr/td1-forms";
import { resolveClubPayrollProvince } from "@/lib/hr/club-payroll-province";
import { saveFederalTd1Action } from "../_actions";
import Td1ClaimFields from "../Td1ClaimFields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default async function FederalTd1Step() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const [existing, attestation, clubPayroll] = await Promise.all([
    getSelfTaxProfileMasked(actor),
    getSelfTd1Attestation(actor, "federal"),
    resolveClubPayrollProvince(actor.clubId),
  ]);

  // Fail-safe: if the Club has no payroll province configured, do not
  // ask the employee. Show a neutral setup message. The employee's
  // progress on prior steps is preserved server-side.
  if (!clubPayroll.configured) {
    return (
      <article
        data-testid="td1-federal-unconfigured"
        className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10"
      >
        <h2 className="font-serif text-2xl leading-tight text-stone-900">
          Federal tax details.
        </h2>
        <p className="mt-4 text-sm text-stone-700 leading-relaxed">
          We need one Club payroll setting before you can complete this
          section. Your progress is saved — please check back with your
          Club administrator.
        </p>
        <div className="mt-8 flex items-center justify-between">
          <Link
            href="/hr/onboarding/payroll/direct-deposit"
            className="text-sm text-stone-500 hover:text-stone-800"
          >
            &larr; Back
          </Link>
        </div>
      </article>
    );
  }

  return (
    <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
      <h2 className="font-serif text-2xl leading-tight text-stone-900">
        Federal tax details.
      </h2>
      <p className="mt-2 text-sm text-stone-500 leading-relaxed">
        This mirrors the CRA&apos;s TD1 (Personal Tax Credits Return).
        Most employees only need the basic personal amount — the default
        below. If you have additional claims (age, disability, tuition,
        dependants), you can add them.
      </p>

      <form action={saveFederalTd1Action} className="mt-8 space-y-6" noValidate>
        {/* HR-2B.3.5 — province is resolved server-side from the Club.
            The subtle non-editable line below confirms which provincial
            form the employee will complete next; the province itself is
            never a question posed to the employee. */}
        <p
          data-testid="td1-federal-province-note"
          className="text-xs text-stone-500"
        >
          Your provincial tax form will be for {clubPayroll.name}.
        </p>

        <Td1ClaimFields
          basicPersonalAmount={TD1_FEDERAL_CURRENT.basicPersonalAmount}
          basicLabel="Basic personal amount (federal)"
          additionalClaims={TD1_FEDERAL_ADDITIONAL_CLAIMS}
          testidPrefix="td1-federal"
        />

        <div className="rounded-md border border-stone-200 bg-stone-50 px-4 py-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="attestation"
              value="1"
              required
              defaultChecked={Boolean(attestation)}
              data-testid="td1-federal-attestation"
              className="mt-1 text-emerald-700 focus:ring-emerald-700"
            />
            <span className="text-sm text-stone-800 leading-relaxed">
              I certify that the information given on this form is, to the
              best of my knowledge, correct and complete.
            </span>
          </label>
          {attestation && (
            <p className="mt-2 pl-7 text-xs text-stone-500">
              Previously acknowledged on {formatDate(attestation.acknowledgedAt)}.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between pt-2">
          <Link
            href="/hr/onboarding/payroll/direct-deposit"
            className="text-sm text-stone-500 hover:text-stone-800"
          >
            &larr; Back
          </Link>
          <button
            type="submit"
            data-testid="td1-federal-continue"
            className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
          >
            Continue
          </button>
        </div>
      </form>

      <p className="mt-6 text-xs text-stone-400">
        Form: {TD1_FEDERAL_CURRENT.version} ({TD1_FEDERAL_CURRENT.year})
        {existing && ` · Previously saved for ${existing.province}`}
      </p>
    </article>
  );
}
