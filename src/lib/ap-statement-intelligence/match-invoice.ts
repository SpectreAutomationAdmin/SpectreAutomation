// Sprint 3 Checkpoint 15G (2026-07-24) — Statement invoice matching.
//
// Given a statement INVOICE line + the canonical vendor, decide the
// best match against APInvoice rows on that vendor. Layered rules:
//   1. Exact vendor + normalised invoice number + amount within
//      tolerance + date within tolerance → EXACT_MATCH
//   2. Vendor + invoice number match, amount differs → AMOUNT_MISMATCH
//   3. Vendor + invoice number match, date differs > 7d → DATE_MISMATCH
//   4. Vendor + invoice number matches 2+ APInvoices → DUPLICATE_LEDGER_ENTRY
//   5. Vendor + amount + close-in-time → PROBABLE_MATCH
//   6. Nothing → NOT_FOUND

import { prisma } from "@/lib/prisma";
import { toMoney } from "@/lib/accounting/decimal";
import type { ExtractedStatementLine, StatementMatchState } from "./types";

const AMOUNT_TOLERANCE_CENTS = 2; // ±2 cents
const DATE_TOLERANCE_DAYS = 7;    // ±7 days for date drift

export interface InvoiceMatchArgs {
  clubId: string;
  canonicalVendorId: string;
  line: ExtractedStatementLine;
}

export interface InvoiceMatchResult {
  state: StatementMatchState;
  matchedApInvoiceId: string | null;
  matchBasis: { ruleKey: string; signals: string[] };
  amountDifferenceCents: number | null;
  dateDifferenceDays: number | null;
}

function normaliseRef(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export async function matchInvoiceLine(args: InvoiceMatchArgs): Promise<InvoiceMatchResult> {
  const line = args.line;
  const lineAmount = toMoney(line.debitAmount ?? "0");
  if (lineAmount.isZero()) {
    return {
      state: "NOT_FOUND",
      matchedApInvoiceId: null,
      matchBasis: { ruleKey: "invoice.no_debit_amount", signals: [] },
      amountDifferenceCents: null,
      dateDifferenceDays: null,
    };
  }
  const refNorm = normaliseRef(line.referenceNumber);
  const lineDate = line.transactionDate ? new Date(line.transactionDate) : null;

  // Signal 1: vendor + reference (case-insensitive normalised).
  if (refNorm.length >= 3) {
    const candidates = await prisma.aPInvoice.findMany({
      where: { clubId: args.clubId, vendorId: args.canonicalVendorId, NOT: { vendorReference: null } },
      select: { id: true, vendorReference: true, total: true, invoiceDate: true, status: true },
      take: 500,
    });
    const refHits = candidates.filter((c) => normaliseRef(c.vendorReference) === refNorm);
    if (refHits.length > 1) {
      return {
        state: "DUPLICATE_LEDGER_ENTRY",
        matchedApInvoiceId: refHits[0].id,
        matchBasis: { ruleKey: "invoice.duplicate_reference_on_ledger", signals: ["ref"] },
        amountDifferenceCents: null,
        dateDifferenceDays: null,
      };
    }
    if (refHits.length === 1) {
      const hit = refHits[0];
      const hitAmount = toMoney(hit.total);
      const diffCents = Math.round(hitAmount.minus(lineAmount).abs().mul(100).toNumber());
      const dateDiffDays = lineDate ? Math.abs((lineDate.getTime() - hit.invoiceDate.getTime()) / (1000 * 60 * 60 * 24)) : 0;
      if (diffCents > AMOUNT_TOLERANCE_CENTS) {
        return {
          state: "AMOUNT_MISMATCH",
          matchedApInvoiceId: hit.id,
          matchBasis: { ruleKey: "invoice.ref_match_amount_differs", signals: ["ref"] },
          amountDifferenceCents: diffCents,
          dateDifferenceDays: Math.round(dateDiffDays),
        };
      }
      if (dateDiffDays > DATE_TOLERANCE_DAYS) {
        return {
          state: "DATE_MISMATCH",
          matchedApInvoiceId: hit.id,
          matchBasis: { ruleKey: "invoice.ref_match_date_differs", signals: ["ref", "amount"] },
          amountDifferenceCents: diffCents,
          dateDifferenceDays: Math.round(dateDiffDays),
        };
      }
      return {
        state: "EXACT_MATCH",
        matchedApInvoiceId: hit.id,
        matchBasis: { ruleKey: "invoice.ref_amount_date_exact", signals: ["ref", "amount", "date"] },
        amountDifferenceCents: diffCents,
        dateDifferenceDays: Math.round(dateDiffDays),
      };
    }
  }

  // Signal 2: no ref match — try amount + date proximity.
  if (lineDate) {
    const dayMs = 24 * 60 * 60 * 1000;
    const dateFrom = new Date(lineDate.getTime() - DATE_TOLERANCE_DAYS * dayMs);
    const dateTo = new Date(lineDate.getTime() + DATE_TOLERANCE_DAYS * dayMs);
    const candidates = await prisma.aPInvoice.findMany({
      where: {
        clubId: args.clubId, vendorId: args.canonicalVendorId,
        invoiceDate: { gte: dateFrom, lte: dateTo },
      },
      select: { id: true, total: true, invoiceDate: true, status: true },
      take: 200,
    });
    const amountHits = candidates.filter((c) => {
      const diffCents = Math.round(toMoney(c.total).minus(lineAmount).abs().mul(100).toNumber());
      return diffCents <= AMOUNT_TOLERANCE_CENTS;
    });
    if (amountHits.length === 1) {
      const hit = amountHits[0];
      const dateDiffDays = Math.abs((lineDate.getTime() - hit.invoiceDate.getTime()) / (1000 * 60 * 60 * 24));
      return {
        state: "PROBABLE_MATCH",
        matchedApInvoiceId: hit.id,
        matchBasis: { ruleKey: "invoice.amount_date_probable", signals: ["amount", "date"] },
        amountDifferenceCents: 0,
        dateDifferenceDays: Math.round(dateDiffDays),
      };
    }
    if (amountHits.length > 1) {
      return {
        state: "AMBIGUOUS_MATCH",
        matchedApInvoiceId: amountHits[0].id,
        matchBasis: { ruleKey: "invoice.amount_date_ambiguous", signals: ["amount", "date"] },
        amountDifferenceCents: 0,
        dateDifferenceDays: null,
      };
    }
  }

  return {
    state: "NOT_FOUND",
    matchedApInvoiceId: null,
    matchBasis: { ruleKey: "invoice.not_found", signals: [] },
    amountDifferenceCents: null,
    dateDifferenceDays: null,
  };
}
