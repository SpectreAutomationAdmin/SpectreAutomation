// HR-2B.3 (2026-08-19) — Payroll · Federal TD1 step.
//
// Employee declares their federal TD1 claim (basic personal amount by
// default; additional claims via progressive disclosure) and attests.
// Claim amounts are KMS-encrypted at rest by `submitSelfTaxProfile`;
// the audit payload carries province + form version + hasAdditionalDeductions
// only — never the dollar values.

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
import { saveFederalTd1Action } from "../_actions";
import Td1ClaimFields from "../Td1ClaimFields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVINCES: Array<{ code: string; name: string }> = [
  { code: "AB", name: "Alberta" },
  { code: "BC", name: "British Columbia" },
  { code: "MB", name: "Manitoba" },
  { code: "NB", name: "New Brunswick" },
  { code: "NL", name: "Newfoundland and Labrador" },
  { code: "NS", name: "Nova Scotia" },
  { code: "NT", name: "Northwest Territories" },
  { code: "NU", name: "Nunavut" },
  { code: "ON", name: "Ontario" },
  { code: "PE", name: "Prince Edward Island" },
  { code: "QC", name: "Quebec" },
  { code: "SK", name: "Saskatchewan" },
  { code: "YT", name: "Yukon" },
];

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default async function FederalTd1Step() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const [existing, attestation] = await Promise.all([
    getSelfTaxProfileMasked(actor),
    getSelfTd1Attestation(actor, "federal"),
  ]);

  const provinceDefault = existing?.province ?? "";

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
        {!provinceDefault && (
          <label className="block">
            <span className="block text-sm text-stone-700">
              Which province will you be working in?
            </span>
            <select
              name="province"
              required
              defaultValue=""
              data-testid="td1-federal-province"
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
            >
              <option value="" disabled>
                Choose a province or territory
              </option>
              {PROVINCES.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-stone-500">
              This determines which provincial TD1 you complete next.
            </span>
          </label>
        )}
        {provinceDefault && (
          <input type="hidden" name="province" value={provinceDefault} />
        )}

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
      </p>
    </article>
  );
}
