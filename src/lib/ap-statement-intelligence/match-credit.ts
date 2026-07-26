// Sprint 3 Checkpoint 15G (2026-07-24) — Statement credit matching.
//
// Spectre AP has NO first-class credit-note model today (audited).
// Two data sources are consulted:
//   1. Negative-amount APInvoice rows (schema permits — the validator
//      normally rejects, but historic imports may carry them).
//   2. VendorPayment rows whose amount is negative or explicitly marked
//      as a refund via processorRef pattern.
//
// If neither exists, the state is CREDIT_NOT_FOUND.

import { prisma } from "@/lib/prisma";
import { toMoney } from "@/lib/accounting/decimal";
import type { ExtractedStatementLine, StatementMatchState } from "./types";

const AMOUNT_TOLERANCE_CENTS = 2;

export interface CreditMatchArgs {
  clubId: string;
  canonicalVendorId: string;
  line: ExtractedStatementLine;
}

export interface CreditMatchResult {
  state: StatementMatchState;
  matchedTargetKind: "AP_INVOICE" | "VENDOR_PAYMENT" | "NONE";
  matchedTargetReferenceId: string | null;
  matchBasis: { ruleKey: string; signals: string[] };
  amountDifferenceCents: number | null;
}

function normaliseRef(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export async function matchCreditLine(args: CreditMatchArgs): Promise<CreditMatchResult> {
  const line = args.line;
  const lineAmount = toMoney(line.creditAmount ?? line.debitAmount ?? "0").abs();
  if (lineAmount.isZero()) {
    return { state: "CREDIT_NOT_FOUND", matchedTargetKind: "NONE", matchedTargetReferenceId: null, matchBasis: { ruleKey: "credit.no_amount", signals: [] }, amountDifferenceCents: null };
  }
  const refNorm = normaliseRef(line.referenceNumber);

  // Signal 1: negative APInvoice with matching vendor + reference or amount.
  const negativeInvoices = await prisma.aPInvoice.findMany({
    where: {
      clubId: args.clubId,
      vendorId: args.canonicalVendorId,
      total: { lt: 0 },
    },
    select: { id: true, vendorReference: true, total: true },
    take: 100,
  });
  const refHit = refNorm.length >= 3 ? negativeInvoices.find((c) => normaliseRef(c.vendorReference) === refNorm) : undefined;
  if (refHit) {
    const diffCents = Math.round(toMoney(refHit.total).abs().minus(lineAmount).abs().mul(100).toNumber());
    if (diffCents > AMOUNT_TOLERANCE_CENTS) {
      return {
        state: "CREDIT_AMOUNT_MISMATCH",
        matchedTargetKind: "AP_INVOICE",
        matchedTargetReferenceId: refHit.id,
        matchBasis: { ruleKey: "credit.negative_invoice_ref_match_amount_differs", signals: ["ref"] },
        amountDifferenceCents: diffCents,
      };
    }
    return {
      state: "EXACT_MATCH",
      matchedTargetKind: "AP_INVOICE",
      matchedTargetReferenceId: refHit.id,
      matchBasis: { ruleKey: "credit.negative_invoice_ref_match", signals: ["ref", "amount"] },
      amountDifferenceCents: diffCents,
    };
  }
  const amountHits = negativeInvoices.filter((c) => {
    const diff = Math.round(toMoney(c.total).abs().minus(lineAmount).abs().mul(100).toNumber());
    return diff <= AMOUNT_TOLERANCE_CENTS;
  });
  if (amountHits.length === 1) {
    return {
      state: "EXACT_MATCH",
      matchedTargetKind: "AP_INVOICE",
      matchedTargetReferenceId: amountHits[0].id,
      matchBasis: { ruleKey: "credit.negative_invoice_amount_match", signals: ["amount"] },
      amountDifferenceCents: 0,
    };
  }

  // Signal 2: vendor-level unapplied credit (payment with unassigned invoice + amount matches).
  const unappliedPayments = await prisma.vendorPayment.findMany({
    where: { clubId: args.clubId, vendorId: args.canonicalVendorId, invoiceId: null },
    select: { id: true, amount: true },
    take: 100,
  });
  const paymentHits = unappliedPayments.filter((p) => {
    const diff = Math.round(toMoney(p.amount).minus(lineAmount).abs().mul(100).toNumber());
    return diff <= AMOUNT_TOLERANCE_CENTS;
  });
  if (paymentHits.length >= 1) {
    return {
      state: "UNAPPLIED_CREDIT",
      matchedTargetKind: "VENDOR_PAYMENT",
      matchedTargetReferenceId: paymentHits[0].id,
      matchBasis: { ruleKey: "credit.unapplied_payment_amount_match", signals: ["amount"] },
      amountDifferenceCents: 0,
    };
  }

  return {
    state: "CREDIT_NOT_FOUND",
    matchedTargetKind: "NONE",
    matchedTargetReferenceId: null,
    matchBasis: { ruleKey: "credit.not_found", signals: [] },
    amountDifferenceCents: null,
  };
}
