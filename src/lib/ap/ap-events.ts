// AP → GL adapter.
//
// Posting model:
//   AP Invoice (post):
//     DR Expense / Inventory / Asset accounts (per line)
//     DR Recoverable tax (1310) for each line's tax (when isRecoverable=true)
//     CR AP Control (2010) for invoice total
//     Non-recoverable tax rolls into the expense account (we add taxAmount
//     onto the expense DR when the tax code is non-recoverable).
//
//   AP Invoice (reverse):
//     Contra-entry built off the original lines. Posted via the journal
//     engine's createPostedFromAdapter (status REVERSED on the original is
//     not set — the back-relation does that semantic, matching the AR
//     reversal pattern from Phase 2D).
//
//   Vendor Payment (post):
//     DR AP Control (2010)
//     CR Cash / Bank (default 1010 unless batch.bankAccountId)

import { prisma } from "../prisma";
import { createPostedFromAdapter } from "../accounting/journal";
import { findPeriodForDate } from "../accounting/periods";
import { toMoney } from "../accounting/decimal";
import type { Principal } from "../rbac";

// Idempotent: returns the existing JE if one already exists for this invoice.
export async function postInvoiceToGl(principal: Principal, invoiceId: string) {
  const existing = await prisma.journalEntry.findFirst({
    where: { sourceEntityType: "APInvoice", sourceEntityId: invoiceId, status: { in: ["POSTED", "DRAFT", "APPROVED"] } },
  });
  if (existing) return existing;

  const inv = await prisma.aPInvoice.findUnique({
    where: { id: invoiceId },
    include: { lines: { include: { expenseAccount: true, taxCode: { include: { recoverableAccount: true } } } }, vendor: true },
  });
  if (!inv) throw new Error("AP invoice not found");

  const period = await findPeriodForDate(inv.clubId, inv.invoiceDate);
  if (!period) throw new Error(`No fiscal period for ${inv.invoiceDate.toISOString().slice(0, 10)}`);

  // Build lines: for each AP line, debit expense (+ non-recoverable tax) and
  // debit recoverable tax separately.
  type AdapterLine = {
    accountNumber: string;
    departmentCode?: string | null;
    costCenterCode?: string | null;
    description?: string | null;
    debit?: string;
    credit?: string;
  };
  const lines: AdapterLine[] = [];

  // Resolve department codes back from ids.
  const deptIds = inv.lines.map((l) => l.departmentId).filter((x): x is string => !!x);
  const departments = deptIds.length ? await prisma.department.findMany({ where: { id: { in: deptIds } } }) : [];
  const deptIdToCode = new Map(departments.map((d) => [d.id, d.code]));

  // Aggregate recoverable tax by account to keep the JE compact.
  const recoverableByAccountNumber = new Map<string, { amount: number; deptCode?: string | null }>();
  let totalRecoverable = 0;

  for (const l of inv.lines) {
    const expenseAmount = Number(l.amount.toString());
    const taxAmount = Number(l.taxAmount.toString());
    const isRecoverable = l.taxCode?.isRecoverable ?? false;
    const recoverableAccount = l.taxCode?.recoverableAccount?.accountNumber ?? null;
    const deptCode = l.departmentId ? (deptIdToCode.get(l.departmentId) ?? null) : null;

    // Phase 5: inventory and capital lines route to clearing/asset accounts
    // instead of expense. Non-recoverable tax always rolls into whatever the
    // DR side becomes.
    //
    //   isInventory: DR Goods Received Not Invoiced (2050).
    //     The matching inventory receiving will later DR Inventory / CR 2050,
    //     netting to: DR Inventory / CR AP Control.
    //
    //   isCapital:   DR the line's expense account directly (the COA should
    //     have routed the line to an asset account at entry time, e.g.
    //     1540 Equipment). Capital lines do NOT pass through the GRNI account.
    //
    //   default:     DR expense account (with non-recoverable tax rolled in).
    let drAccountNumber = l.expenseAccount.accountNumber;
    if (l.isInventory) {
      drAccountNumber = "2050";
    }
    const drExpense = expenseAmount + (isRecoverable ? 0 : taxAmount);
    if (drExpense > 0) {
      lines.push({
        accountNumber: drAccountNumber,
        departmentCode: deptCode,
        description: l.description ?? null,
        debit: drExpense.toFixed(2),
      });
    }
    // Recoverable tax DR.
    if (isRecoverable && recoverableAccount && taxAmount > 0) {
      const existing = recoverableByAccountNumber.get(recoverableAccount) ?? { amount: 0, deptCode: null };
      existing.amount = Math.round((existing.amount + taxAmount) * 100) / 100;
      recoverableByAccountNumber.set(recoverableAccount, existing);
      totalRecoverable = Math.round((totalRecoverable + taxAmount) * 100) / 100;
    }
  }
  for (const [accountNumber, { amount, deptCode }] of recoverableByAccountNumber.entries()) {
    lines.push({
      accountNumber,
      departmentCode: deptCode ?? null,
      description: "Recoverable tax (ITC)",
      debit: amount.toFixed(2),
    });
  }
  // AP Control CR.
  lines.push({
    accountNumber: "2010",
    description: `${inv.vendor.legalName} · ${inv.invoiceNumber}${inv.vendorReference ? ` · ${inv.vendorReference}` : ""}`,
    credit: Number(inv.total.toString()).toFixed(2),
  });

  return createPostedFromAdapter(
    principal,
    inv.clubId,
    {
      entryDate: inv.invoiceDate,
      description: `AP invoice ${inv.invoiceNumber}`,
      memo: inv.description ?? null,
      lines,
    },
    { source: "AP_INVOICE", sourceEntityType: "APInvoice", sourceEntityId: inv.id }
  );
}

// Post the reverse of a posted AP invoice. Idempotent on existing reversal.
export async function postInvoiceReversalToGl(principal: Principal, invoiceId: string, reason: string) {
  const inv = await prisma.aPInvoice.findUnique({
    where: { id: invoiceId },
    include: { lines: { include: { expenseAccount: true, taxCode: true } }, vendor: true },
  });
  if (!inv) throw new Error("AP invoice not found");

  // Look for existing reversal JE.
  const existing = await prisma.journalEntry.findFirst({
    where: { sourceEntityType: "APInvoiceReversal", sourceEntityId: invoiceId, status: "POSTED" },
  });
  if (existing) return existing;

  // Build a contra-entry: same lines, swap DR/CR.
  type AdapterLine = { accountNumber: string; departmentCode?: string | null; description?: string | null; debit?: string; credit?: string };
  const deptIds = inv.lines.map((l) => l.departmentId).filter((x): x is string => !!x);
  const departments = deptIds.length ? await prisma.department.findMany({ where: { id: { in: deptIds } } }) : [];
  const deptIdToCode = new Map(departments.map((d) => [d.id, d.code]));

  const lines: AdapterLine[] = [];
  const recoverableByAccountNumber = new Map<string, number>();

  for (const l of inv.lines) {
    const expenseAmount = Number(l.amount.toString());
    const taxAmount = Number(l.taxAmount.toString());
    const isRecoverable = !!(l.taxCode && l.taxCodeId);
    // Reverse exactly what postInvoiceToGl did, including the Phase 5 routing
    // of isInventory lines through the Goods Received Not Invoiced account.
    const drAccountNumber = l.isInventory ? "2050" : l.expenseAccount.accountNumber;
    const drExpenseOriginal = expenseAmount + (isRecoverable ? 0 : taxAmount);
    if (drExpenseOriginal > 0) {
      lines.push({
        accountNumber: drAccountNumber,
        departmentCode: l.departmentId ? deptIdToCode.get(l.departmentId) ?? null : null,
        description: `Reversal: ${l.description ?? inv.invoiceNumber}`,
        credit: drExpenseOriginal.toFixed(2),
      });
    }
    if (isRecoverable && taxAmount > 0) {
      // Look up the actual recoverable account on the tax code at posting time.
      const tc = await prisma.taxCode.findUnique({ where: { id: l.taxCodeId! }, include: { recoverableAccount: true } });
      const recAccount = tc?.recoverableAccount?.accountNumber;
      if (recAccount) {
        recoverableByAccountNumber.set(recAccount, (recoverableByAccountNumber.get(recAccount) ?? 0) + taxAmount);
      }
    }
  }
  for (const [accountNumber, amount] of recoverableByAccountNumber.entries()) {
    lines.push({
      accountNumber,
      description: "Reversal: Recoverable tax (ITC)",
      credit: amount.toFixed(2),
    });
  }
  lines.push({
    accountNumber: "2010",
    description: `Reversal: ${inv.vendor.legalName} · ${inv.invoiceNumber}`,
    debit: Number(inv.total.toString()).toFixed(2),
  });

  // Use entry date = today for reversal so it can land in an open period.
  return createPostedFromAdapter(
    principal,
    inv.clubId,
    {
      entryDate: new Date(),
      description: `Reversal of AP invoice ${inv.invoiceNumber}: ${reason}`,
      memo: reason,
      lines,
    },
    { source: "AP_REVERSAL", sourceEntityType: "APInvoiceReversal", sourceEntityId: inv.id }
  );
}

// Vendor payment → GL: DR 2010 AP Control, CR bank (default 1010).
export async function postPaymentToGl(principal: Principal, paymentId: string) {
  const existing = await prisma.journalEntry.findFirst({
    where: { sourceEntityType: "VendorPayment", sourceEntityId: paymentId, status: { in: ["POSTED", "DRAFT", "APPROVED"] } },
  });
  if (existing) return existing;

  const payment = await prisma.vendorPayment.findUnique({
    where: { id: paymentId },
    include: { vendor: true, batch: { include: { bankAccount: true } } },
  });
  if (!payment) throw new Error("Vendor payment not found");

  const bankAccountNumber = payment.batch?.bankAccount?.accountNumber ?? "1010";
  const amount = toMoney(payment.amount).toFixed(2);

  return createPostedFromAdapter(
    principal,
    payment.clubId,
    {
      entryDate: payment.paymentDate,
      description: `Vendor payment ${payment.paymentNumber} · ${payment.vendor.legalName}`,
      memo: payment.processorRef ?? null,
      lines: [
        { accountNumber: "2010", debit: amount, description: payment.vendor.legalName },
        { accountNumber: bankAccountNumber, credit: amount, description: `Payment ${payment.paymentNumber}` },
      ],
    },
    { source: "AP_PAYMENT", sourceEntityType: "VendorPayment", sourceEntityId: payment.id }
  );
}
