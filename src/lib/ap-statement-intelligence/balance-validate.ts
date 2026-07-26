// Sprint 3 Checkpoint 15G (2026-07-24) — Balance validation.
//
// Two orthogonal checks:
//   1. Statement arithmetic: opening + Σ(debits) − Σ(credits) = closing
//   2. Spectre ledger vs statement closing: computed vendor balance
//      as of statementDate compared to statement's closing balance
//
// Decimal-safe throughout — never uses parseFloat / Number for money.

import { prisma } from "@/lib/prisma";
import { toMoney, sumMoney } from "@/lib/accounting/decimal";
import type { ExtractedStatement, ExtractedStatementLine } from "./types";

const TOLERANCE_CENTS = 2;

export interface StatementArithmeticFinding {
  key: "ap.statement.opening_balance_mismatch" | "ap.statement.closing_balance_mismatch";
  severity: "MEDIUM" | "HIGH";
  statement: string;
  differenceCents: number;
}

export interface LedgerBalanceFinding {
  key: "ap.statement.ledger_balance_mismatch";
  severity: "MEDIUM" | "HIGH";
  statement: string;
  spectreBalance: string;
  vendorBalance: string;
  differenceCents: number;
}

export function validateStatementArithmetic(extraction: ExtractedStatement): StatementArithmeticFinding[] {
  const findings: StatementArithmeticFinding[] = [];
  const opening = extraction.header.openingBalance ? toMoney(extraction.header.openingBalance) : null;
  const closing = extraction.header.closingBalance ? toMoney(extraction.header.closingBalance) : null;

  // Skip opening/closing checks unless both header values were extracted;
  // we already emit ap.statement.opening_balance_mismatch when totals disagree.
  if (opening === null || closing === null) return findings;

  // Sum debits + credits from lines (skip the opening-balance pseudo-line).
  const debitTotal = sumMoney(
    extraction.lines
      .filter((l) => l.transactionKind !== "OPENING_BALANCE" && l.transactionKind !== "BALANCE_FORWARD")
      .map((l) => l.debitAmount ?? "0"),
  );
  const creditTotal = sumMoney(
    extraction.lines
      .filter((l) => l.transactionKind !== "OPENING_BALANCE" && l.transactionKind !== "BALANCE_FORWARD")
      .map((l) => l.creditAmount ?? "0"),
  );

  const computedClosing = opening.plus(debitTotal).minus(creditTotal);
  const diff = closing.minus(computedClosing).abs();
  const diffCents = Math.round(diff.mul(100).toNumber());
  if (diffCents > TOLERANCE_CENTS) {
    findings.push({
      key: "ap.statement.closing_balance_mismatch",
      severity: "HIGH",
      statement: `Statement arithmetic fails: ${opening.toFixed(2)} + ${debitTotal.toFixed(2)} - ${creditTotal.toFixed(2)} = ${computedClosing.toFixed(2)}, printed closing = ${closing.toFixed(2)}. Difference ${diff.toFixed(2)}.`,
      differenceCents: diffCents,
    });
  }
  return findings;
}

// -----------------------------------------------------------------------------
// Spectre vendor balance as of a specific date.
// -----------------------------------------------------------------------------
export async function computeVendorBalanceAsOf(args: {
  clubId: string;
  vendorId: string;
  asOf: Date;
}): Promise<string> {
  const invoices = await prisma.aPInvoice.findMany({
    where: {
      clubId: args.clubId,
      vendorId: args.vendorId,
      status: { in: ["POSTED", "PARTIALLY_PAID", "PAID"] },
      invoiceDate: { lte: args.asOf },
    },
    select: { total: true, id: true },
  });
  const invoiceTotal = sumMoney(invoices.map((i) => i.total));

  const payments = await prisma.vendorPayment.findMany({
    where: {
      clubId: args.clubId,
      vendorId: args.vendorId,
      status: { in: ["PROCESSED", "PENDING"] },
      paymentDate: { lte: args.asOf },
    },
    select: { amount: true },
  });
  const paymentTotal = sumMoney(payments.map((p) => p.amount));

  return invoiceTotal.minus(paymentTotal).toFixed(2);
}

export async function validateLedgerBalance(args: {
  clubId: string;
  vendorId: string;
  statementDate: Date;
  extraction: ExtractedStatement;
}): Promise<LedgerBalanceFinding | null> {
  const closing = args.extraction.header.closingBalance
    ? toMoney(args.extraction.header.closingBalance)
    : args.extraction.header.amountDue
      ? toMoney(args.extraction.header.amountDue)
      : null;
  if (!closing) return null;
  const spectreBalance = toMoney(await computeVendorBalanceAsOf({ clubId: args.clubId, vendorId: args.vendorId, asOf: args.statementDate }));
  const diff = closing.minus(spectreBalance).abs();
  const diffCents = Math.round(diff.mul(100).toNumber());
  if (diffCents <= TOLERANCE_CENTS) return null;
  return {
    key: "ap.statement.ledger_balance_mismatch",
    severity: "HIGH",
    statement: `Spectre AP balance ${spectreBalance.toFixed(2)} does not match vendor statement closing balance ${closing.toFixed(2)}. Difference ${diff.toFixed(2)}.`,
    spectreBalance: spectreBalance.toFixed(2),
    vendorBalance: closing.toFixed(2),
    differenceCents: diffCents,
  };
}
