// Sprint 3 · Checkpoint 15P-2 (2026-07-27) — the ONE canonical
// domain function that builds a proposed AP journal entry.
//
// Both the client-side Step-2 preview AND the server-side posting
// action call this. The founder's rule from §Phase 10 is direct:
// "Do not independently calculate one entry in the React component
// and another entry in the server action."
//
// This module is pure: it takes IDs + amounts + Prisma-loaded
// account rows and returns the entry as a plain shape. Persistence,
// I/O, and RBAC are the caller's problem.
//
// The entry pattern (standard taxable operating invoice) — matches
// the existing `postInvoiceToGl` adapter (src/lib/ap/ap-events.ts)
// so the preview mirrors what will actually post:
//
//   Account                                Debit      Credit
//   6054 Computer & IT Services            $29.80          —
//   1310 GST Recoverable (ITC)              $1.49          —
//   2010 Accounts Payable                       —      $31.29
//
// Non-recoverable tax rolls into the expense debit. Auto-pay uses
// the same accrual pattern (still CR AP control, then a separate
// payment JE clears it).

import { Prisma } from "@prisma/client";
import { toMoney, sumMoney, isZero } from "@/lib/accounting/decimal";

export type ApLineRole = "EXPENSE" | "ASSET" | "TAX_RECOVERABLE" | "TAX_NON_RECOVERABLE" | "AP_CONTROL";

// Kept as strings (not Prisma.Decimal) at this boundary so the
// object can be serialised across the server-action boundary
// without a JSON reviver. Callers on the server side convert via
// toMoney() when they need to persist.
export interface ProposedApLine {
  accountId: string;
  accountNumber: string;
  accountName: string;
  debit: string;                    // decimal-safe string; "0.00" when only credit
  credit: string;                   // decimal-safe string; "0.00" when only debit
  role: ApLineRole;
  description: string;
}

export interface ProposedApEntry {
  currency: string;
  subtotal: string;
  tax: string;
  gross: string;
  lines: ProposedApLine[];
  totalDebits: string;
  totalCredits: string;
  difference: string;               // debits - credits; must be "0.00"
  isBalanced: boolean;
  warnings: string[];
}

// -----------------------------------------------------------------------------
// Input shape — narrow, no Prisma types leak past the domain boundary.
// -----------------------------------------------------------------------------

export interface ExpenseAccountInfo {
  id: string;
  accountNumber: string;
  name: string;
  type: "EXPENSE" | "ASSET";        // AP debits must land on one of these
}

export interface ControlAccountInfo {
  id: string;
  accountNumber: string;
  name: string;
}

// The tax treatment tells the builder how to split the tax.
export type TaxTreatment =
  | { kind: "RECOVERABLE";     recoverableAccount: ControlAccountInfo }   // DR ITC account, CR AP
  | { kind: "NON_RECOVERABLE" }                                            // roll into expense DR
  | { kind: "NONE" };                                                      // zero-tax invoice

export interface BuildProposedApEntryInput {
  currency: string;
  subtotal: string | number | Prisma.Decimal;
  tax: string | number | Prisma.Decimal;
  gross: string | number | Prisma.Decimal;
  expenseAccount: ExpenseAccountInfo;
  apControlAccount: ControlAccountInfo;
  taxTreatment: TaxTreatment;
  // Description used on the expense line + AP control line.
  vendorLegalName: string;
  invoiceRef: string;                // extracted invoice # from the PDF
}

// -----------------------------------------------------------------------------
// The builder.
// -----------------------------------------------------------------------------

export function buildProposedApEntry(input: BuildProposedApEntryInput): ProposedApEntry {
  const warnings: string[] = [];

  const subtotalD = toMoney(input.subtotal);
  const taxD = toMoney(input.tax);
  const grossD = toMoney(input.gross);

  // Arithmetic sanity — subtotal + tax should equal gross within
  // cent precision. If not, we still build the entry but WARN so
  // the UI can surface the mismatch and posting can be blocked.
  const derivedGross = subtotalD.plus(taxD);
  if (!derivedGross.equals(grossD)) {
    warnings.push(
      `Arithmetic mismatch: subtotal ${subtotalD.toFixed(2)} + tax ${taxD.toFixed(2)} = ${derivedGross.toFixed(2)}, not gross ${grossD.toFixed(2)}.`,
    );
  }
  if (subtotalD.isNegative()) warnings.push("Subtotal is negative.");
  if (taxD.isNegative())      warnings.push("Tax is negative.");
  if (grossD.isNegative())    warnings.push("Gross is negative.");

  const lines: ProposedApLine[] = [];

  // ---- Expense / asset DR ---------------------------------------------------
  // Non-recoverable tax rolls INTO the expense line (matches
  // ap-events.ts:88 semantics so preview and posting agree).
  const rollNonRecoverableIntoExpense = input.taxTreatment.kind === "NON_RECOVERABLE";
  const expenseDebit = rollNonRecoverableIntoExpense ? subtotalD.plus(taxD) : subtotalD;

  if (!isZero(expenseDebit)) {
    lines.push({
      accountId: input.expenseAccount.id,
      accountNumber: input.expenseAccount.accountNumber,
      accountName: input.expenseAccount.name,
      debit: expenseDebit.toFixed(2),
      credit: "0.00",
      role: input.expenseAccount.type === "ASSET" ? "ASSET" : "EXPENSE",
      description: `${input.vendorLegalName} · ${input.invoiceRef}`,
    });
  }

  // ---- Recoverable tax DR ---------------------------------------------------
  if (input.taxTreatment.kind === "RECOVERABLE" && !isZero(taxD)) {
    const acct = input.taxTreatment.recoverableAccount;
    lines.push({
      accountId: acct.id,
      accountNumber: acct.accountNumber,
      accountName: acct.name,
      debit: taxD.toFixed(2),
      credit: "0.00",
      role: "TAX_RECOVERABLE",
      description: "Recoverable tax (ITC)",
    });
  } else if (input.taxTreatment.kind === "NON_RECOVERABLE" && !isZero(taxD)) {
    // Already rolled into expense above — no separate line, but
    // we record the fact for downstream consumers.
    warnings.push(`Non-recoverable tax of ${taxD.toFixed(2)} rolled into ${input.expenseAccount.accountNumber} ${input.expenseAccount.name}.`);
  }

  // ---- AP control CR --------------------------------------------------------
  lines.push({
    accountId: input.apControlAccount.id,
    accountNumber: input.apControlAccount.accountNumber,
    accountName: input.apControlAccount.name,
    debit: "0.00",
    credit: grossD.toFixed(2),
    role: "AP_CONTROL",
    description: `${input.vendorLegalName} · ${input.invoiceRef}`,
  });

  // ---- Totals ---------------------------------------------------------------
  const totalDebits = sumMoney(lines.map((l) => l.debit));
  const totalCredits = sumMoney(lines.map((l) => l.credit));
  const difference = totalDebits.minus(totalCredits);
  const isBalanced = difference.abs().lessThan(new Prisma.Decimal("0.005"));

  return {
    currency: input.currency,
    subtotal: subtotalD.toFixed(2),
    tax: taxD.toFixed(2),
    gross: grossD.toFixed(2),
    lines,
    totalDebits: totalDebits.toFixed(2),
    totalCredits: totalCredits.toFixed(2),
    difference: difference.toFixed(2),
    isBalanced,
    warnings,
  };
}
