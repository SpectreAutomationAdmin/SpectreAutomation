// Sprint 3 · Checkpoint 15P-2 — due-date resolution.
//
// Rules (from the founder brief):
//   1. Explicit invoice due date wins whenever the extractor found
//      one on the PDF.
//   2. Otherwise: invoice date + termsDays.
//   3. Auto-pay collapses to invoiceDate (day-zero).
//
// Kept deliberately tiny — one function, no I/O, no Prisma. The
// caller is responsible for extracting the two dates from the
// invoice.

export type DueDateSource = "INVOICE_PDF" | "COMPUTED_FROM_TERMS" | "AUTO_PAY";

export interface ResolvedDueDate {
  dueDate: Date;
  source: DueDateSource;
  provenanceHuman: string;
}

export interface ResolveDueDateInput {
  explicitInvoiceDueDate?: Date | null;
  invoiceDate: Date;
  termsDays: number;                // 0 for due-on-receipt / auto-pay
  isAutoPay: boolean;
}

export function resolveDueDate(input: ResolveDueDateInput): ResolvedDueDate {
  // 1. Explicit invoice due date wins.
  if (input.explicitInvoiceDueDate instanceof Date && !Number.isNaN(input.explicitInvoiceDueDate.getTime())) {
    return {
      dueDate: input.explicitInvoiceDueDate,
      source: "INVOICE_PDF",
      provenanceHuman: "Due date on invoice",
    };
  }

  // 2. Auto-pay collapses to invoice date.
  if (input.isAutoPay) {
    return {
      dueDate: input.invoiceDate,
      source: "AUTO_PAY",
      provenanceHuman: "Auto-pay — due immediately",
    };
  }

  // 3. Invoice date + termsDays.
  const dueMs = input.invoiceDate.getTime() + Math.max(0, input.termsDays) * 86_400_000;
  return {
    dueDate: new Date(dueMs),
    source: "COMPUTED_FROM_TERMS",
    provenanceHuman: `Invoice date + ${input.termsDays} day${input.termsDays === 1 ? "" : "s"}`,
  };
}
