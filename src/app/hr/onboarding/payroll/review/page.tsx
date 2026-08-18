// HR-2B.3 (2026-08-19) — Payroll · Review step.
//
// Read-only summary of the four payroll sub-sections. Renders masked
// helpers ONLY (no plaintext reveal), a "Change" link per sub-section,
// and a "Complete Payroll" button gated on the canonical completion
// state. No new persistence — completion is derived from the row set.

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import {
  getPayrollCompletion,
  getSelfBankAccountMasked,
  getSelfBankingDocument,
  getSelfSinMasked,
  getSelfTaxProfileMasked,
  getSelfTd1Attestation,
} from "@/lib/hr/employee-self-service";
import { getProvincialTd1, TD1_FEDERAL_CURRENT } from "@/lib/hr/td1-forms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function formatBankingStatus(status: string): string {
  if (status === "VERIFIED") return "Verified";
  if (status === "PENDING_PENNY_TEST") return "Pending Club verification";
  return status;
}

const PROVINCE_NAMES: Record<string, string> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories",
  NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec",
  SK: "Saskatchewan", YT: "Yukon",
};

export default async function PayrollReviewStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const [completion, sin, bank, doc, tax, fedAtt, provAtt] = await Promise.all([
    getPayrollCompletion(actor),
    getSelfSinMasked(actor),
    getSelfBankAccountMasked(actor),
    getSelfBankingDocument(actor),
    getSelfTaxProfileMasked(actor),
    getSelfTd1Attestation(actor, "federal"),
    getSelfTd1Attestation(actor, "provincial"),
  ]);

  const provincialSpec = tax ? getProvincialTd1(tax.province) : null;
  const provinceName = tax ? (PROVINCE_NAMES[tax.province] ?? tax.province) : null;

  const missing: string[] = [];
  if (!completion.sin) missing.push("Social Insurance Number");
  if (!completion.banking) missing.push("Direct deposit");
  if (!completion.taxProfile || !completion.federalAttestation) missing.push("Federal TD1");
  if (!completion.taxProfile || !completion.provincialAttestation) missing.push("Provincial TD1");

  return (
    <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
      <h2 className="font-serif text-2xl leading-tight text-stone-900">
        Review your payroll information.
      </h2>
      <p className="mt-2 text-sm text-stone-500 leading-relaxed">
        Confirm what you&apos;ve provided below. You can change any section
        before finishing.
      </p>

      <div className="mt-8 divide-y divide-stone-200 rounded-md border border-stone-200">
        {/* SIN */}
        <ReviewRow
          label="Social Insurance Number"
          href="/hr/onboarding/payroll/sin"
          testid="review-sin"
        >
          {sin ? (
            <p className="font-mono text-sm text-stone-900">{sin}</p>
          ) : (
            <p className="text-sm text-stone-500">Not yet submitted</p>
          )}
        </ReviewRow>

        {/* Direct deposit */}
        <ReviewRow
          label="Direct deposit"
          href="/hr/onboarding/payroll/direct-deposit"
          testid="review-banking"
        >
          {bank ? (
            <>
              <p className="text-sm text-stone-900">{bank.holderName}</p>
              <p className="mt-0.5 font-mono text-sm text-stone-700">
                Account ending in {bank.accountMasked.slice(-4)}
              </p>
              <p className="mt-0.5 text-xs text-stone-500">
                {formatBankingStatus(bank.status)}
              </p>
              {doc && (
                <p className="mt-1 text-xs text-stone-500">
                  Supporting document on file
                  {doc.category === "direct_deposit_form" ? " (direct deposit form)" : " (void cheque)"}
                </p>
              )}
            </>
          ) : doc ? (
            <p className="text-sm text-stone-500">
              Supporting document uploaded &mdash; banking details still required.
            </p>
          ) : (
            <p className="text-sm text-stone-500">Not yet submitted</p>
          )}
        </ReviewRow>

        {/* Federal TD1 */}
        <ReviewRow
          label="Federal tax (TD1)"
          href="/hr/onboarding/payroll/td1-federal"
          testid="review-td1-federal"
        >
          {fedAtt ? (
            <>
              <p className="text-sm text-stone-900">
                Completed {formatDate(fedAtt.acknowledgedAt) ?? ""}
              </p>
              <p className="mt-0.5 text-xs text-stone-500">
                Form: {TD1_FEDERAL_CURRENT.version}
              </p>
            </>
          ) : (
            <p className="text-sm text-stone-500">Not yet completed</p>
          )}
        </ReviewRow>

        {/* Provincial TD1 */}
        <ReviewRow
          label={
            provinceName
              ? `Provincial tax (${provinceName})`
              : "Provincial tax"
          }
          href="/hr/onboarding/payroll/td1-provincial"
          testid="review-td1-provincial"
        >
          {provAtt ? (
            <>
              <p className="text-sm text-stone-900">
                Completed {formatDate(provAtt.acknowledgedAt) ?? ""}
              </p>
              {provincialSpec && (
                <p className="mt-0.5 text-xs text-stone-500">
                  Form: {provincialSpec.version}
                </p>
              )}
              {tax?.hasAdditionalDeductions && (
                <p className="mt-0.5 text-xs text-stone-500">
                  Additional per-pay deduction requested
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-stone-500">Not yet completed</p>
          )}
        </ReviewRow>
      </div>

      {missing.length > 0 && (
        <div className="mt-6 rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
          <p className="font-medium">Still to finish:</p>
          <ul className="mt-1 list-disc pl-5 space-y-0.5 text-stone-600">
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8 flex items-center justify-between border-t border-stone-100 pt-6">
        <Link
          href="/hr/onboarding/payroll/td1-provincial"
          className="text-sm text-stone-500 hover:text-stone-800"
        >
          &larr; Back
        </Link>
        {completion.complete ? (
          <Link
            href="/hr/onboarding/payroll/complete"
            data-testid="payroll-complete"
            className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
          >
            Complete Payroll
          </Link>
        ) : (
          <button
            type="button"
            disabled
            data-testid="payroll-complete"
            className="rounded-md bg-stone-200 px-5 py-2.5 text-sm font-medium text-stone-500 cursor-not-allowed"
          >
            Complete Payroll
          </button>
        )}
      </div>
    </article>
  );
}

function ReviewRow({
  label,
  href,
  testid,
  children,
}: {
  label: string;
  href: string;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-start gap-4 px-4 py-4" data-testid={testid}>
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-stone-500">{label}</p>
        <div className="mt-2">{children}</div>
      </div>
      <Link href={href} className="text-sm text-stone-600 underline hover:text-stone-900">
        Change
      </Link>
    </div>
  );
}
