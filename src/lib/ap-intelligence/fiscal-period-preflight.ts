// Sprint 3 · Checkpoint 15P-7 (2026-07-28) — fiscal-period preflight
// for the AP posting workflow.
//
// Founder-observed defect: the Coulee Ridge staging tenant had ZERO
// fiscal periods on 2026-07-28. `postInvoiceToGl` → `findPeriodForDate`
// returned null → `resolvePostingPeriod` threw → the posting failed
// AFTER the AP invoice + Work Intake commit. The invoice was stuck
// as DRAFT and the WI was resolved without a journal entry.
//
// Fix: check for a period covering the invoice date BEFORE any
// writes. If none exists, idempotently bootstrap the fiscal year
// containing that date via `ensureFiscalYear`. Because the bootstrap
// is a small, safe write on tables no other posting depends on, it
// runs OUTSIDE any transaction — and if it fails, we throw with an
// actionable error before the AP write phase even starts.
//
// This preserves the founder's invariant: the AP write transaction
// cannot fail mid-way through the accounting side, because every
// failure mode is eliminated before the writes begin.

import { findPeriodForDate, ensureFiscalYear } from "@/lib/accounting/periods";
import { logger } from "@/lib/observability/logger";
import { ConflictError } from "@/lib/errors";

export interface FiscalPeriodPreflightResult {
  periodId: string;
  periodLabel: string;
  bootstrapped: boolean;
}

/**
 * Ensure a fiscal period covers `invoiceDate` for the given club.
 * Idempotent — safe to call multiple times.
 *
 * Bootstrap policy: when no period covers the date, create a
 * calendar-year fiscal year for `invoiceDate.getUTCFullYear()`.
 * This mirrors how the seed populates fresh clubs (Jan-Dec periods,
 * status OPEN). A club that has DIFFERENT fiscal-year boundaries
 * (e.g. April-March) should have been seeded correctly OR will get
 * this fallback and can adjust via the FY admin UI later.
 *
 * On the rare case where the tenant explicitly wants a locked
 * period for this date (e.g. year-end freeze), the bootstrap
 * creates status OPEN — the founder can lock immediately after.
 *
 * Throws only when both lookup AND bootstrap fail (extremely
 * unlikely — a Prisma outage would land us there, in which case
 * the AP posting is also going to fail).
 */
export async function ensureFiscalPeriodForPosting(
  clubId: string,
  invoiceDate: Date,
): Promise<FiscalPeriodPreflightResult> {
  const existing = await findPeriodForDate(clubId, invoiceDate);
  if (existing) {
    return { periodId: existing.id, periodLabel: existing.label, bootstrapped: false };
  }

  const year = invoiceDate.getUTCFullYear();
  logger.info("ap.fiscal-period.bootstrap", {
    clubId,
    year,
    reason: "no_period_covers_invoice_date",
  });

  await ensureFiscalYear(clubId, { startYear: year });

  const created = await findPeriodForDate(clubId, invoiceDate);
  if (!created) {
    // Belt-and-braces: if the bootstrap ran but the lookup STILL
    // finds nothing, the tenant has a non-calendar fiscal year that
    // our default bootstrap couldn't infer. Throw with an actionable
    // config-error message so the operator knows to configure FYs.
    throw new ConflictError(
      `No fiscal period covers ${invoiceDate.toISOString().slice(0, 10)} for this club. Configure a fiscal year that includes this date before posting.`,
    );
  }
  return { periodId: created.id, periodLabel: created.label, bootstrapped: true };
}
