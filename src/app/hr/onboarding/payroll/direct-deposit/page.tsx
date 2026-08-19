// HR-2B.3 (2026-08-19) — Payroll · Direct deposit step.
//
// Employee enters their banking details for direct deposit. Two
// parallel affordances:
//   1. "Enter my banking information" — four fields, KMS-encrypted at
//      rest via `submitSelfBankAccount`. The employee CANNOT set
//      status=VERIFIED; that requires `hr:banking:approve`.
//   2. "Upload a void cheque or direct-deposit form" — supporting
//      evidence via `uploadSelfBankingDocument`. Optional; not a
//      substitute for the banking fields.

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import {
  getSelfBankAccountMasked,
  getSelfBankingDocument,
} from "@/lib/hr/employee-self-service";
import {
  saveBankAccountAction,
  uploadBankingDocumentAction,
} from "../_actions";
import DirectDepositCards from "./DirectDepositCards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatBankingStatus(status: string): string {
  if (status === "VERIFIED") return "Verified";
  if (status === "PENDING_PENNY_TEST") return "Pending Club verification";
  return status;
}

export default async function DirectDepositStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const [bank, doc] = await Promise.all([
    getSelfBankAccountMasked(actor),
    getSelfBankingDocument(actor),
  ]);

  return (
    <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
      <h2 className="font-serif text-2xl leading-tight text-stone-900">
        Where should we deposit your pay?
      </h2>
      <p className="mt-2 text-sm text-stone-500 leading-relaxed">
        You can enter your banking information directly, upload a void cheque
        or direct-deposit form for us to key in, or both. Everything is
        encrypted at rest.
      </p>

      {(bank || doc) && (
        <div className="mt-6 space-y-3">
          {bank && (
            <div
              className="rounded-md border border-emerald-100 bg-emerald-50 px-4 py-3"
              data-testid="banking-summary"
            >
              <p className="text-xs uppercase tracking-[0.18em] text-emerald-900">
                Direct deposit
              </p>
              <p className="mt-1 text-sm text-stone-900">
                <span className="font-medium">{bank.holderName}</span>
                <span className="mx-2 text-stone-400">|</span>
                <span className="font-mono">Account ending in {bank.accountMasked.slice(-4)}</span>
              </p>
              <p className="mt-1 text-xs text-emerald-900">
                {formatBankingStatus(bank.status)}
              </p>
            </div>
          )}
          {doc && (
            <div
              className="rounded-md border border-stone-200 bg-stone-50 px-4 py-3"
              data-testid="banking-document-summary"
            >
              <p className="text-xs uppercase tracking-[0.18em] text-stone-500">
                {doc.category === "direct_deposit_form" ? "Direct deposit form" : "Void cheque"}
              </p>
              <p className="mt-1 text-sm text-stone-800">
                {doc.displayName ?? "Uploaded file"}{" "}
                <span className="text-stone-400">| Uploaded {formatDate(doc.uploadedAt)}</span>
              </p>
            </div>
          )}
        </div>
      )}

      <DirectDepositCards
        hasBank={Boolean(bank)}
        hasDoc={Boolean(doc)}
        saveBankAccountAction={saveBankAccountAction}
        uploadBankingDocumentAction={uploadBankingDocumentAction}
      />

      <div className="mt-8 flex items-center justify-between border-t border-stone-100 pt-6">
        <Link
          href="/hr/onboarding/payroll/sin"
          className="text-sm text-stone-500 hover:text-stone-800"
        >
          &larr; Back
        </Link>
        {bank && (
          <Link
            href="/hr/onboarding/payroll/td1-federal"
            data-testid="banking-continue"
            className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
          >
            Continue to tax details
          </Link>
        )}
      </div>
    </article>
  );
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
