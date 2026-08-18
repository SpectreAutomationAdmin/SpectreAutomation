// HR-2B.3 (2026-08-19) — Payroll · Provincial TD1 step.
//
// Employee declares their provincial TD1 claim (using the province
// stored at the federal step), an optional additional-tax-per-pay
// deduction, and attests.

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import {
  getSelfTaxProfileMasked,
  getSelfTd1Attestation,
} from "@/lib/hr/employee-self-service";
import {
  getProvincialTd1,
  TD1_PROVINCIAL_ADDITIONAL_CLAIMS,
} from "@/lib/hr/td1-forms";
import { saveProvincialTd1Action } from "../_actions";
import Td1ClaimFields from "../Td1ClaimFields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVINCE_NAMES: Record<string, string> = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
};

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default async function ProvincialTd1Step() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const existing = await getSelfTaxProfileMasked(actor);
  if (!existing) redirect("/hr/onboarding/payroll/td1-federal");

  const provincialSpec = getProvincialTd1(existing.province);
  if (!provincialSpec) redirect("/hr/onboarding/payroll/td1-federal");

  const attestation = await getSelfTd1Attestation(actor, "provincial");
  const provinceName = PROVINCE_NAMES[existing.province] ?? existing.province;

  return (
    <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
      <h2 className="font-serif text-2xl leading-tight text-stone-900">
        {provinceName} tax details.
      </h2>
      <p className="mt-2 text-sm text-stone-500 leading-relaxed">
        Same idea as the federal form. Most employees claim the basic
        provincial amount only; add additional claims if they apply to
        you.
      </p>

      <form action={saveProvincialTd1Action} className="mt-8 space-y-6" noValidate>
        <Td1ClaimFields
          basicPersonalAmount={provincialSpec.basicPersonalAmount}
          basicLabel={`Basic personal amount (${provinceName})`}
          additionalClaims={TD1_PROVINCIAL_ADDITIONAL_CLAIMS}
          testidPrefix="td1-provincial"
        />

        <label className="block">
          <span className="block text-sm text-stone-700">
            Additional tax deducted from each pay
            <span className="ml-1 text-stone-400 text-xs">(optional)</span>
          </span>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-xs text-stone-500">CAD $</span>
            <input
              type="text"
              name="additionalDeductions"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              maxLength={12}
              data-testid="td1-provincial-additional-deductions"
              className="block w-40 rounded-md border border-stone-300 px-3 py-1.5 text-sm font-mono text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
            />
          </div>
          <span className="mt-1 block text-xs text-stone-500">
            Some employees ask their employer to withhold extra income tax each
            pay. This is optional.
          </span>
        </label>

        <div className="rounded-md border border-stone-200 bg-stone-50 px-4 py-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="attestation"
              value="1"
              required
              defaultChecked={Boolean(attestation)}
              data-testid="td1-provincial-attestation"
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
            href="/hr/onboarding/payroll/td1-federal"
            className="text-sm text-stone-500 hover:text-stone-800"
          >
            &larr; Back
          </Link>
          <button
            type="submit"
            data-testid="td1-provincial-continue"
            className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
          >
            Continue
          </button>
        </div>
      </form>

      <p className="mt-6 text-xs text-stone-400">
        Form: {provincialSpec.version} ({provincialSpec.year})
      </p>
    </article>
  );
}
