// Sprint 3 · Checkpoint 15P-7 (2026-07-28) — atomic AP-invoice
// posting. Fixes the founder-observed defect where clicking "Post
// invoice" left the AP invoice as DRAFT while the Work Intake was
// resolved.
//
// Pre-15P-7 defect (proven from staging):
//   The outer $transaction created the AP invoice (status=DRAFT) +
//   line + resolved the Work Intake, THEN called `postInvoiceToGl`
//   OUTSIDE that transaction. When the Coulee Ridge tenant had no
//   fiscal period covering the invoice date, `postInvoiceToGl` →
//   `resolvePostingPeriod` threw → the outer catch returned
//   ok:false BUT the AP invoice + WI writes were already committed.
//   Result: DRAFT invoice, resolved WI, no journal entry.
//
// 15P-7 fix — the founder's atomicity invariant:
//   "Do not leave: a posted journal entry with a Draft AP invoice;
//    a completed Work Intake item with no posted invoice; an AP
//    invoice marked Posted with an unbalanced or missing journal
//    entry."
//
//   All accounting writes happen INSIDE one Prisma $transaction.
//   Every failure mode that can be caught before the write phase
//   is caught in a preflight — including the fiscal-period gap
//   (idempotently bootstrapped by `ensureFiscalPeriodForPosting`)
//   and the control-account gap. By the time the tx opens, only
//   Prisma-level failures can roll us back, and those correctly
//   roll back ALL writes.
//
// Post-commit (best-effort, never blocks the accounting result):
//   - Audit event
//   - Enqueue Outlook archive job (MAILBOX_ARCHIVE_MESSAGE) when
//     the WI has an EmailWorkIntakeOrigin

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
import { ensureFiscalPeriodForPosting } from "@/lib/ap-intelligence/fiscal-period-preflight";
import { nextEntryNumberTx } from "@/lib/accounting/journal";
import { enqueue as enqueueJob } from "@/lib/queue";

const codingSchema = z.object({
  invoiceNumber: z.string().trim().min(1),
  subtotal: z.string().trim().min(1),
  tax: z.string().trim(),
  gross: z.string().trim().min(1),
  currency: z.string().trim().min(1).max(6),
  glAccountNumber: z.string().trim().min(1),
  glAccountName: z.string().trim().min(1),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  paymentTermsSource: z.enum(["VENDOR_PROFILE","INVOICE_PDF","PRIOR_INVOICE","CLUB_DEFAULT","SPECTRE_DEFAULT"]).nullable().optional(),
  invoiceDate: z.string().datetime().optional(),
  explicitInvoiceDueDate: z.string().datetime().nullable().optional(),
  taxTreatment: z.enum(["RECOVERABLE","NON_RECOVERABLE","NONE"]),
  taxCodeKey: z.string().trim().nullable().optional(),
  clientTotalDebits: z.string().trim().optional(),
  clientTotalCredits: z.string().trim().optional(),
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
  // 15P-7: user-facing lifecycle summary. The modal renders this
  // as the success confirmation ("Journal entry balanced and Work
  // Intake item cleared" + email-archive status).
  lifecycle: {
    apInvoicePosted: true;
    journalEntryPosted: true;
    workIntakeResolved: true;
    emailArchive:
      | { status: "QUEUED"; jobId: string }
      | { status: "NOT_APPLICABLE"; reason: string }
      | { status: "ENQUEUE_FAILED"; error: string };
    fiscalPeriodBootstrapped: boolean;
  };
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

  // =========================================================================
  // PREFLIGHT — every failure mode we can catch BEFORE the write phase.
  // Nothing here writes; a throw / return leaves the DB untouched.
  // =========================================================================
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
    select: { id: true, accountNumber: true, name: true, type: true },
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

  const subtotalD = toMoney(input.coding.subtotal);
  const taxD = toMoney(input.coding.tax);
  const grossD = toMoney(input.coding.gross);
  if (subtotalD.isNegative() || taxD.isNegative() || !grossD.isPositive()) {
    return { ok: false, message: "Amounts must be non-negative and gross must be positive.", code: "BAD_AMOUNTS" };
  }
  if (!subtotalD.plus(taxD).equals(grossD)) {
    return { ok: false, message: `Subtotal (${subtotalD.toFixed(2)}) + tax (${taxD.toFixed(2)}) does not equal gross (${grossD.toFixed(2)}).`, code: "UNBALANCED_AMOUNTS" };
  }

  const needsTax = input.coding.taxTreatment !== "NONE" && !isZero(taxD);
  const control = await resolveControlAccounts({
    clubId,
    needsTax: needsTax && input.coding.taxTreatment === "RECOVERABLE",
    taxCodeKey: input.coding.taxCodeKey ?? null,
  });
  if (!control.ok) return { ok: false, message: control.message, code: control.code };

  const treatment: TaxTreatment =
    input.coding.taxTreatment === "RECOVERABLE" && control.gstRecoverable
      ? { kind: "RECOVERABLE", recoverableAccount: control.gstRecoverable }
      : input.coding.taxTreatment === "NON_RECOVERABLE"
      ? { kind: "NON_RECOVERABLE" }
      : { kind: "NONE" };

  // Server rebuild via the SHARED builder — modal preview + server
  // post must produce identical entries. This ALSO validates the
  // journal will be balanced.
  const proposed = buildProposedApEntry({
    currency: input.coding.currency,
    subtotal: subtotalD, tax: taxD, gross: grossD,
    expenseAccount: {
      id: expenseAccount.id, accountNumber: expenseAccount.accountNumber,
      name: expenseAccount.name, type: expenseAccount.type as "EXPENSE" | "ASSET",
    },
    apControlAccount: control.apControl,
    taxTreatment: treatment,
    vendorLegalName: vendor.legalName,
    invoiceRef: input.coding.invoiceNumber,
  });
  if (!proposed.isBalanced) {
    return { ok: false, message: `Proposed entry is not balanced (debits ${proposed.totalDebits} · credits ${proposed.totalCredits} · diff ${proposed.difference}).`, code: "UNBALANCED_ENTRY" };
  }
  if (input.coding.clientTotalDebits && !eqMoney(input.coding.clientTotalDebits, proposed.totalDebits)) {
    logger.warn("mission-control.post-ap-invoice.client-server-debit-drift", {
      clubId, vendorId: vendor.id,
      client: input.coding.clientTotalDebits, server: proposed.totalDebits,
    });
  }

  // Dates + terms — server RE-RESOLVES from the vendor profile.
  const invoiceDate = input.coding.invoiceDate ? new Date(input.coding.invoiceDate) : new Date();
  const resolvedTerms = resolvePaymentTerms({
    vendorProfileTermsDays: vendor.paymentTermsDays,
    extractedTerms: null,
  });
  const termsDays = input.coding.paymentTermsDays ?? resolvedTerms.days;
  const explicitDue = input.coding.explicitInvoiceDueDate ? new Date(input.coding.explicitInvoiceDueDate) : null;
  const due = resolveDueDate({
    explicitInvoiceDueDate: explicitDue,
    invoiceDate,
    termsDays,
    isAutoPay: resolvedTerms.isAutoPay,
  });

  // 15P-7 preflight: fiscal period must cover invoiceDate. If none
  // does, bootstrap the FY containing that date. Idempotent + safe.
  let fiscalPeriodBootstrapped = false;
  let periodId: string;
  try {
    const fp = await ensureFiscalPeriodForPosting(clubId, invoiceDate);
    periodId = fp.periodId;
    fiscalPeriodBootstrapped = fp.bootstrapped;
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Fiscal period configuration prevented posting.",
      code: "NO_FISCAL_PERIOD",
    };
  }

  // Preflight duplicate check (best-effort — the tx repeats it).
  const dupCheck = await prisma.aPInvoice.findFirst({
    where: { clubId, vendorId: vendor.id, vendorReference: input.coding.invoiceNumber },
    select: { id: true, invoiceNumber: true },
  });
  if (dupCheck) {
    return {
      ok: false,
      message: `Invoice ${input.coding.invoiceNumber} already exists on this vendor as ${dupCheck.invoiceNumber}.`,
      code: "DUPLICATE",
    };
  }

  // Which JournalEntryLine.accountId does each proposed line map to?
  // buildProposedApEntry returns lines carrying accountId already —
  // no additional resolution needed.

  // =========================================================================
  // ATOMIC WRITE PHASE — every accounting write in ONE Prisma tx.
  // Any failure rolls back everything: no orphaned invoice, no
  // orphaned JE, no resolved-but-unposted WI.
  // =========================================================================
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Repeat the duplicate check inside the tx (defense against
      // a concurrent post landing between preflight and here).
      const dupInv = await tx.aPInvoice.findFirst({
        where: { clubId, vendorId: vendor.id, vendorReference: input.coding.invoiceNumber },
        select: { id: true, invoiceNumber: true },
      });
      if (dupInv) throw new ConflictError(`Invoice ${input.coding.invoiceNumber} already exists on this vendor as ${dupInv.invoiceNumber}.`);

      const yr = new Date().getFullYear();
      const seq = await tx.aPInvoice.count({ where: { clubId } });
      const invoiceNumber = `AP-${yr}-${String(seq + 1).padStart(6, "0")}`;
      const nowTs = new Date();

      // AP invoice — created directly as POSTED. postedJournalEntryId
      // is backfilled after JE creation below.
      const inv = await tx.aPInvoice.create({
        data: {
          clubId,
          invoiceNumber,
          vendorReference: input.coding.invoiceNumber,
          vendorId: vendor.id,
          invoiceDate,
          dueDate: due.dueDate,
          terms: `Net ${termsDays}`,
          description: `AP posted from Mission Control · ${wi.displaySender ?? "email"}`,
          departmentId: null,
          subtotal: new Prisma.Decimal(subtotalD.toFixed(2)),
          taxTotal: new Prisma.Decimal(taxD.toFixed(2)),
          total: new Prisma.Decimal(grossD.toFixed(2)),
          currency: input.coding.currency,
          status: "POSTED",
          postedAt: nowTs,
          postedByUserId: principal.id,
          captureId: null,
          createdByUserId: principal.id,
        },
        select: { id: true, invoiceNumber: true },
      });

      // AP line.
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
          taxCodeId: treatment.kind === "RECOVERABLE" ? control.gstTaxCodeId : null,
          taxAmount: new Prisma.Decimal(taxD.toFixed(2)),
          isCapital: expenseAccount.type === "ASSET",
          isInventory: false,
        },
      });

      // Journal entry — created + posted inline within the same tx
      // so an accounting failure rolls back with the invoice.
      // Line account ids are threaded from `proposed.lines`. AP
      // control + GST recoverable ids came from resolveControlAccounts;
      // the expense id came from expenseAccount above.
      const entryNumber = await nextEntryNumberTx(tx, clubId);
      const je = await tx.journalEntry.create({
        data: {
          clubId,
          entryNumber,
          entryDate: invoiceDate,
          periodId,
          description: `AP invoice ${invoiceNumber}`,
          memo: `${vendor.legalName} · ${input.coding.invoiceNumber}`,
          source: "AP_INVOICE",
          sourceEntityType: "APInvoice",
          sourceEntityId: inv.id,
          totalDebits: new Prisma.Decimal(proposed.totalDebits),
          totalCredits: new Prisma.Decimal(proposed.totalCredits),
          status: "POSTED",
          postedAt: nowTs,
          postedByUserId: principal.id,
          createdByUserId: principal.id,
        },
        select: { id: true, entryNumber: true },
      });

      await tx.journalEntryLine.createMany({
        data: proposed.lines.map((l, i) => ({
          clubId,
          journalEntryId: je.id,
          lineNumber: i + 1,
          accountId: l.accountId,
          departmentId: null,
          costCenterId: null,
          debit: new Prisma.Decimal(l.debit),
          credit: new Prisma.Decimal(l.credit),
          description: l.description,
          memberId: null,
        })),
      });

      // Backfill the invoice's JE reference.
      await tx.aPInvoice.update({
        where: { id: inv.id },
        data: { postedJournalEntryId: je.id },
      });

      // Resolve the Work Intake.
      await tx.workIntakeItem.update({
        where: { id: wi.id },
        data: { status: "RESOLVED", resolvedAt: nowTs, resolvedByUserId: principal.id },
      });

      return { invoiceId: inv.id, invoiceNumber, journalEntryId: je.id, journalEntryNumber: je.entryNumber };
    }, { timeout: 60_000, maxWait: 15_000 });

    // =======================================================================
    // POST-COMMIT — audit + Outlook archive job. Failures here do NOT
    // reverse the accounting posting (per founder rule: "Do not
    // reverse the accounting posting merely because Outlook is
    // temporarily unavailable").
    // =======================================================================
    await audit(principal, {
      action: "ap.invoice.post",
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
        journalEntryId: result.journalEntryId,
        journalEntryNumber: result.journalEntryNumber,
        entryBalanced: true,
        entryLines: proposed.lines.map((l) => ({
          number: l.accountNumber, name: l.accountName, debit: l.debit, credit: l.credit, role: l.role,
        })),
        source: "mission-control:post-ap-invoice-atomic",
        recommendationAccepted: input.coding.recommendationAccepted ?? null,
        fiscalPeriodBootstrapped,
      },
    });
    await audit(principal, {
      action: "work-intake.resolve",
      entityType: "WorkIntakeItem",
      entityId: wi.id,
      clubId,
      after: { via: "mission-control:post-ap-invoice-atomic", apInvoiceId: result.invoiceId, journalEntryId: result.journalEntryId },
    });

    // Outlook archive job enqueue (only when the WI originated
    // from an Outlook email).
    let archive: PostApInvoiceResult["lifecycle"]["emailArchive"] = {
      status: "NOT_APPLICABLE", reason: "WI not linked to an EmailMessage",
    };
    try {
      const emailOrigin = await prisma.emailWorkIntakeOrigin.findFirst({
        where: { workIntakeItemId: wi.id, role: "PRIMARY" },
        select: {
          emailMessageId: true,
          emailMessage: { select: { graphMessageId: true, mailboxConnectionId: true } },
        },
      });
      if (emailOrigin?.emailMessage?.graphMessageId && emailOrigin.emailMessage.mailboxConnectionId) {
        const job = await enqueueJob({
          clubId,
          kind: "MAILBOX_ARCHIVE_MESSAGE",
          payload: {
            apInvoiceId: result.invoiceId,
            workIntakeItemId: wi.id,
            emailMessageId: emailOrigin.emailMessageId,
            graphMessageId: emailOrigin.emailMessage.graphMessageId,
            mailboxConnectionId: emailOrigin.emailMessage.mailboxConnectionId,
          },
          idempotencyKey: `mailbox-archive:${result.invoiceId}`,
        });
        archive = { status: "QUEUED", jobId: job.id };
      }
    } catch (queueErr) {
      logger.warn("mission-control.post-ap-invoice.archive-enqueue-failed", {
        clubId, invoiceId: result.invoiceId,
        error: queueErr instanceof Error ? queueErr.message : String(queueErr),
      });
      archive = { status: "ENQUEUE_FAILED", error: queueErr instanceof Error ? queueErr.message : "unknown" };
    }

    logger.info("mission-control.post-ap-invoice.success", {
      clubId, workIntakeItemId: wi.id, vendorId: vendor.id,
      invoiceId: result.invoiceId, journalEntryId: result.journalEntryId,
      archive: archive.status,
      fiscalPeriodBootstrapped,
    });

    return {
      ok: true,
      vendorId: vendor.id,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      journalEntryId: result.journalEntryId,
      timelineUrl: `/app/admin/ap/vendors/${encodeURIComponent(vendor.id)}/timeline`,
      apInvoiceUrl: `/app/admin/ap/invoices/${encodeURIComponent(result.invoiceId)}`,
      lifecycle: {
        apInvoicePosted: true,
        journalEntryPosted: true,
        workIntakeResolved: true,
        emailArchive: archive,
        fiscalPeriodBootstrapped,
      },
    };
  } catch (err) {
    if (isAppError(err)) return { ok: false, message: err.safeMessage, code: err.name };
    logger.error("mission-control.post-ap-invoice.failed", {
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
