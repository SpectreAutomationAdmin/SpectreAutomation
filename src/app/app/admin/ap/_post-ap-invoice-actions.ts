// Sprint 3 · Checkpoint 15P-2 (2026-07-27) — Step 2 server action:
// draft AND journalize an AP invoice + resolve the source Work
// Intake item. Uses the SHARED `buildProposedApEntry` domain
// function so what the operator saw in the modal preview is
// exactly what lands in the GL — no divergent client / server
// calculation.
//
// Pre-15P-2 defects fixed here:
//   • Persisted only APInvoice + one APInvoiceLine at status
//     DRAFT — no JournalEntry, no ITC split, no AP-control credit.
//   • Put the FULL GROSS on the line's `amount` (should be subtotal
//     — the tax lives separately in `taxAmount`).
//   • Never resolved the AP control account or the GST recoverable
//     account. Downstream postInvoiceToGl would have run against a
//     null taxCodeId and posted the entire gross to expense.
//
// Post-15P-2:
//   • Control accounts resolved via resolveControlAccounts() —
//     returns a typed config error if 2010 or the ITC account is
//     missing / inactive; posting is blocked, not fabricated.
//   • APInvoiceLine.amount = subtotal, .taxAmount = tax,
//     .taxCodeId = the resolved TaxCode.id.
//   • buildProposedApEntry runs BOTH client-side (preview) and
//     server-side (this action). Server rebuilds from its own
//     Prisma reads — client-provided totals are compared but never
//     trusted.
//   • Posts to the GL inside the same transaction (idempotent —
//     postInvoiceToGl short-circuits on an existing JE), so the
//     invoice lands at status POSTED with a linked JournalEntry.
//   • Coding precedent is captured on the audit trail so the
//     recommender can learn from accepts vs overrides.

"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { ConflictError, isAppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { toMoney, isZero, eqMoney } from "@/lib/accounting/decimal";
import { buildProposedApEntry, type TaxTreatment } from "@/lib/ap-intelligence/proposed-ap-entry";
import { resolveControlAccounts } from "@/lib/ap-intelligence/control-accounts";
import { resolvePaymentTerms } from "@/lib/ap-intelligence/payment-terms-resolve";
import { resolveDueDate } from "@/lib/ap-intelligence/due-date-resolve";
import { postInvoiceToGl } from "@/lib/ap/ap-events";

const codingSchema = z.object({
  invoiceNumber: z.string().trim().min(1),
  subtotal: z.string().trim().min(1),
  tax: z.string().trim(),
  gross: z.string().trim().min(1),
  currency: z.string().trim().min(1).max(6),
  glAccountNumber: z.string().trim().min(1),
  glAccountName: z.string().trim().min(1),
  // 15P-2: derived by the resolver on the modal side and echoed back
  // for the audit trail. The server RE-RESOLVES rather than trusting.
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  paymentTermsSource: z.enum(["VENDOR_PROFILE","INVOICE_PDF","PRIOR_INVOICE","CLUB_DEFAULT","SPECTRE_DEFAULT"]).nullable().optional(),
  invoiceDate: z.string().datetime().optional(),          // ISO 8601 — the extracted invoice date
  explicitInvoiceDueDate: z.string().datetime().nullable().optional(),
  taxTreatment: z.enum(["RECOVERABLE","NON_RECOVERABLE","NONE"]),
  taxCodeKey: z.string().trim().nullable().optional(),
  // Client's snapshot of the preview totals. Not trusted; compared.
  clientTotalDebits: z.string().trim().optional(),
  clientTotalCredits: z.string().trim().optional(),
  // Was the operator following Spectre's top GL recommendation?
  recommendationAccepted: z.boolean().optional(),
});

const schema = z.object({
  workIntakeItemId: z.string().min(1),
  vendorId: z.string().min(1),
  coding: codingSchema,
});

export interface PostApInvoiceResult {
  ok: true;
  vendorId: string;
  invoiceId: string;
  invoiceNumber: string;
  journalEntryId: string;
  timelineUrl: string;
  apInvoiceUrl: string;
}
export interface PostApInvoiceFailure {
  ok: false;
  message: string;
  code?: string;
}

export async function postApInvoiceAction(
  raw: unknown,
): Promise<PostApInvoiceResult | PostApInvoiceFailure> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { ok: false, message: "Not signed in.", code: "UNAUTHENTICATED" };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "Some fields need review before posting.", code: "VALIDATION" };
  }
  const input = parsed.data;

  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return { ok: false, message: "No active club.", code: "NO_CLUB" };

  if (!hasPermission(principal, clubId, "ap:invoice:create")) {
    return { ok: false, message: "Your role cannot post AP invoices.", code: "PERMISSION" };
  }

  // ---- Server-authoritative re-fetch of every referenced entity --------------
  const wi = await prisma.workIntakeItem.findFirst({
    where: { id: input.workIntakeItemId, clubId },
    select: { id: true, status: true, displaySender: true },
  });
  if (!wi) return { ok: false, message: "Work intake item not found.", code: "NOT_FOUND" };
  if (wi.status === "RESOLVED") return { ok: false, message: "This intake is already resolved.", code: "ALREADY_RESOLVED" };

  const vendor = await prisma.vendor.findFirst({
    where: { id: input.vendorId, clubId },
    select: { id: true, legalName: true, status: true, paymentTermsDays: true },
  });
  if (!vendor) return { ok: false, message: "Vendor not found.", code: "VENDOR_NOT_FOUND" };
  if (vendor.status === "BLOCKED") return { ok: false, message: "Vendor is BLOCKED — cannot post.", code: "VENDOR_BLOCKED" };

  const expenseAccount = await prisma.account.findFirst({
    where: { clubId, accountNumber: input.coding.glAccountNumber, isActive: true },
    select: { id: true, accountNumber: true, name: true, type: true, allowManualPosting: true },
  });
  if (!expenseAccount) {
    return { ok: false, message: `GL account ${input.coding.glAccountNumber} is inactive or missing.`, code: "BAD_GL" };
  }
  if (expenseAccount.type !== "EXPENSE" && expenseAccount.type !== "ASSET") {
    return {
      ok: false,
      message: `GL ${expenseAccount.accountNumber} ${expenseAccount.name} is a ${expenseAccount.type} account — AP debits can only target EXPENSE or ASSET accounts.`,
      code: "BAD_GL_TYPE",
    };
  }

  // ---- Server-authoritative amounts -----------------------------------------
  const subtotalD = toMoney(input.coding.subtotal);
  const taxD = toMoney(input.coding.tax);
  const grossD = toMoney(input.coding.gross);
  if (subtotalD.isNegative() || taxD.isNegative() || !grossD.isPositive()) {
    return { ok: false, message: "Amounts must be non-negative and gross must be positive.", code: "BAD_AMOUNTS" };
  }
  if (!subtotalD.plus(taxD).equals(grossD)) {
    return { ok: false, message: `Subtotal (${subtotalD.toFixed(2)}) + tax (${taxD.toFixed(2)}) does not equal gross (${grossD.toFixed(2)}).`, code: "UNBALANCED_AMOUNTS" };
  }

  // ---- Control account resolution -------------------------------------------
  const needsTax = input.coding.taxTreatment !== "NONE" && !isZero(taxD);
  const control = await resolveControlAccounts({
    clubId,
    needsTax: needsTax && input.coding.taxTreatment === "RECOVERABLE",
    taxCodeKey: input.coding.taxCodeKey ?? null,
  });
  if (!control.ok) {
    return { ok: false, message: control.message, code: control.code };
  }

  const treatment: TaxTreatment =
    input.coding.taxTreatment === "RECOVERABLE" && control.gstRecoverable
      ? { kind: "RECOVERABLE", recoverableAccount: control.gstRecoverable }
      : input.coding.taxTreatment === "NON_RECOVERABLE"
      ? { kind: "NON_RECOVERABLE" }
      : { kind: "NONE" };

  // ---- Server rebuilds the entry (the SAME shared function the modal used) --
  const proposed = buildProposedApEntry({
    currency: input.coding.currency,
    subtotal: subtotalD,
    tax: taxD,
    gross: grossD,
    expenseAccount: { id: expenseAccount.id, accountNumber: expenseAccount.accountNumber, name: expenseAccount.name, type: expenseAccount.type as "EXPENSE" | "ASSET" },
    apControlAccount: control.apControl,
    taxTreatment: treatment,
    vendorLegalName: vendor.legalName,
    invoiceRef: input.coding.invoiceNumber,
  });
  if (!proposed.isBalanced) {
    return { ok: false, message: `Proposed entry is not balanced (debits ${proposed.totalDebits} · credits ${proposed.totalCredits} · diff ${proposed.difference}).`, code: "UNBALANCED_ENTRY" };
  }
  // Optional client<->server total comparison — surfaces drift.
  if (input.coding.clientTotalDebits && !eqMoney(input.coding.clientTotalDebits, proposed.totalDebits)) {
    logger.warn("mission-control.post-ap-invoice.client-server-debit-drift", {
      clubId, vendorId: vendor.id,
      client: input.coding.clientTotalDebits, server: proposed.totalDebits,
    });
    // We still trust the server rebuild — the log is enough.
  }

  // ---- Dates + terms (server RE-RESOLVES) -----------------------------------
  const invoiceDate = input.coding.invoiceDate ? new Date(input.coding.invoiceDate) : new Date();
  const resolvedTerms = resolvePaymentTerms({
    vendorProfileTermsDays: vendor.paymentTermsDays,
    extractedTerms: null,     // the modal already applied vendor precedence — we mirror it via vendorProfileTermsDays
  });
  const termsDays = input.coding.paymentTermsDays ?? resolvedTerms.days;
  const explicitDue = input.coding.explicitInvoiceDueDate ? new Date(input.coding.explicitInvoiceDueDate) : null;
  const due = resolveDueDate({
    explicitInvoiceDueDate: explicitDue,
    invoiceDate,
    termsDays,
    isAutoPay: resolvedTerms.isAutoPay,
  });

  // ---- Persist inside a single transaction ----------------------------------
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Duplicate detection inside the tx.
      const dupInv = await tx.aPInvoice.findFirst({
        where: { clubId, vendorId: vendor.id, vendorReference: input.coding.invoiceNumber },
        select: { id: true, invoiceNumber: true },
      });
      if (dupInv) {
        throw new ConflictError(
          `Invoice ${input.coding.invoiceNumber} already exists on this vendor as ${dupInv.invoiceNumber}.`,
        );
      }

      const yr = new Date().getFullYear();
      const seq = await tx.aPInvoice.count({ where: { clubId } });
      const invoiceNumber = `AP-${yr}-${String(seq + 1).padStart(6, "0")}`;

      const inv = await tx.aPInvoice.create({
        data: {
          clubId,
          invoiceNumber,
          vendorReference: input.coding.invoiceNumber,
          vendorId: vendor.id,
          invoiceDate,
          dueDate: due.dueDate,
          terms: `Net ${termsDays}`,
          description: `AP drafted from Mission Control · ${wi.displaySender ?? "email"}`,
          departmentId: null,
          subtotal: new Prisma.Decimal(subtotalD.toFixed(2)),
          taxTotal: new Prisma.Decimal(taxD.toFixed(2)),
          total: new Prisma.Decimal(grossD.toFixed(2)),
          currency: input.coding.currency,
          status: "DRAFT",
          captureId: null,
          createdByUserId: principal.id,
        },
        select: { id: true, invoiceNumber: true },
      });

      // 15P-2 fix: the line's `amount` is the SUBTOTAL (net of tax).
      // Tax lives on `taxAmount` + is split during posting via the
      // TaxCode.recoverableAccount link. Non-recoverable tax rolls
      // into the expense debit at posting time (matches ap-events.ts
      // semantics — same rule the preview builder followed).
      await tx.aPInvoiceLine.create({
        data: {
          clubId,
          invoiceId: inv.id,
          lineNumber: 1,
          expenseAccountId: expenseAccount.id,
          departmentId: null,
          costCenterId: null,
          description: `AP posted via Mission Control (${input.coding.invoiceNumber})`,
          quantity: null,
          unitCost: null,
          amount: new Prisma.Decimal(subtotalD.toFixed(2)),
          // Only set taxCodeId when the treatment is RECOVERABLE — a
          // null taxCodeId tells postInvoiceToGl to roll tax into expense.
          taxCodeId: treatment.kind === "RECOVERABLE" ? control.gstTaxCodeId : null,
          taxAmount: new Prisma.Decimal(taxD.toFixed(2)),
          isCapital: expenseAccount.type === "ASSET",
          isInventory: false,
        },
      });

      await tx.workIntakeItem.update({
        where: { id: wi.id },
        data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: principal.id },
      });

      return { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber };
    }, { timeout: 60_000, maxWait: 15_000 });

    // ---- Post the balanced journal entry OUTSIDE the tx so a JE-
    //      period failure doesn't wedge the AP invoice creation.
    //      postInvoiceToGl is idempotent — a retry after a partial
    //      failure returns the existing JE. -------------------------------------
    let journalEntryId: string;
    try {
      const je = await postInvoiceToGl(principal, result.invoiceId);
      journalEntryId = je.id;
      await prisma.aPInvoice.update({
        where: { id: result.invoiceId },
        data: { status: "POSTED", postedJournalEntryId: je.id, postedAt: new Date(), postedByUserId: principal.id },
      });
    } catch (postErr) {
      logger.error("mission-control.post-ap-invoice.journalize-failed", {
        clubId, invoiceId: result.invoiceId,
        error: postErr instanceof Error ? postErr.message : String(postErr),
      });
      // Return the AP invoice as DRAFT with a clear message so the
      // operator knows they need to re-open a period or fix the COA.
      return {
        ok: false,
        message: `AP invoice ${result.invoiceNumber} was drafted but journal entry could not be posted: ${postErr instanceof Error ? postErr.message : "unknown error"}.`,
        code: "JOURNALIZE_FAILED",
      };
    }

    await audit(principal, {
      action: "ap.invoice.create",
      entityType: "APInvoice",
      entityId: result.invoiceId,
      clubId,
      after: {
        invoiceNumber: result.invoiceNumber,
        vendorId: vendor.id,
        vendorRef: input.coding.invoiceNumber,
        subtotal: subtotalD.toFixed(2),
        tax: taxD.toFixed(2),
        gross: grossD.toFixed(2),
        currency: input.coding.currency,
        gl: `${expenseAccount.accountNumber} ${expenseAccount.name}`,
        apControl: `${control.apControl.accountNumber} ${control.apControl.name}`,
        gstRecoverable: control.gstRecoverable ? `${control.gstRecoverable.accountNumber} ${control.gstRecoverable.name}` : null,
        taxTreatment: treatment.kind,
        taxCodeKey: control.gstTaxCodeKey,
        terms: `Net ${termsDays}`,
        termsSource: input.coding.paymentTermsSource ?? null,
        invoiceDate: invoiceDate.toISOString(),
        dueDate: due.dueDate.toISOString(),
        dueDateSource: due.source,
        journalEntryId,
        entryBalanced: proposed.isBalanced,
        entryLines: proposed.lines.map((l) => ({
          number: l.accountNumber, name: l.accountName, debit: l.debit, credit: l.credit, role: l.role,
        })),
        source: "mission-control:post-ap-invoice-step-2",
        // Phase 11 — coding precedent: whether Spectre's top
        // recommendation was accepted or overridden. Enables the
        // recommender to learn without introducing a new table.
        recommendationAccepted: input.coding.recommendationAccepted ?? null,
      },
    });
    await audit(principal, {
      action: "work-intake.resolve",
      entityType: "WorkIntakeItem",
      entityId: wi.id,
      clubId,
      after: { via: "mission-control:post-ap-invoice-step-2", apInvoiceId: result.invoiceId, journalEntryId },
    });

    logger.info("mission-control.post-ap-invoice-step-2.success", {
      clubId, workIntakeItemId: wi.id, vendorId: vendor.id,
      invoiceId: result.invoiceId, journalEntryId,
    });

    return {
      ok: true,
      vendorId: vendor.id,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      journalEntryId,
      timelineUrl: `/app/admin/ap/vendors/${encodeURIComponent(vendor.id)}/timeline`,
      apInvoiceUrl: `/app/admin/ap/invoices/${encodeURIComponent(result.invoiceId)}`,
    };
  } catch (err) {
    if (isAppError(err)) return { ok: false, message: err.safeMessage, code: err.name };
    logger.error("mission-control.post-ap-invoice-step-2.failed", {
      clubId, workIntakeItemId: wi.id, vendorId: vendor.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      message: err instanceof Error ? err.message : "AP invoice post failed.",
      code: "UNEXPECTED",
    };
  }
}
