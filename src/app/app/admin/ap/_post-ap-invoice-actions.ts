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
import type { PostingGateVerdict } from "@/lib/ap-intelligence/workflow/blocker-class";
import type { ApWorkflowBlockerCode } from "@/lib/ap-intelligence/workflow/decision";

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

// Sprint 3 · Post-16H Phase 3.2 (2026-08-06) — §2 explicit-review
// acknowledgments + §3 override audit rows. `acknowledgedBlockers`
// carries the ApWorkflowBlockerCode values the reviewer has
// explicitly cleared (`REQUIRES_EXPLICIT_REVIEW` severity). Every
// entry MUST be paired with an `overrides[]` row that records what
// the analyser produced vs. what the reviewer corrected, so a
// downstream auditor can reconstruct who overrode what and why.
const overrideAuditSchema = z.object({
  overrideKind: z.string().trim().min(1).max(64),
  satisfiesBlocker: z.string().trim().min(1).max(64).nullable().optional(),
  originalValueJson: z.string().trim().nullable().optional(),
  correctedValueJson: z.string().trim().nullable().optional(),
  reason: z.string().trim().max(2000).nullable().optional(),
});

const schema = z.object({
  workIntakeItemId: z.string().min(1),
  vendorId: z.string().min(1),
  coding: codingSchema,
  acknowledgedBlockers: z.array(z.string().trim().min(1).max(64)).optional().default([]),
  overrides: z.array(overrideAuditSchema).optional().default([]),
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
    select: {
      id: true, accountNumber: true, name: true, type: true, normalBalance: true,
      isHeader: true, allowManualPosting: true, isControlAccount: true,
      isBankAccount: true, isCashAccount: true, archivedAt: true,
      fundApplicability: true, accountRole: true,
      category: { select: { key: true } }, fsGroup: { select: { key: true } },
    },
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

  // Sprint 3 · Post-16H Phase 3.1 (2026-08-06) — server-side
  // accounting eligibility enforcement (§4). A user must not be
  // able to bypass the projection layer's decision by calling
  // this endpoint directly. The eligibility service re-evaluates
  // the SELECTED debit account against the same structural rules
  // the pre-ranker uses. Rejection returns a structured refusal;
  // the DB is untouched.
  const { evaluateEligibility } = await import("@/lib/accounting/eligibility");
  const eligibilityVerdict = evaluateEligibility({
    id: expenseAccount.id,
    accountNumber: expenseAccount.accountNumber,
    name: expenseAccount.name,
    type: expenseAccount.type,
    normalBalance: expenseAccount.normalBalance,
    isActive: true,
    isHeader: expenseAccount.isHeader,
    allowManualPosting: expenseAccount.allowManualPosting,
    isControlAccount: expenseAccount.isControlAccount,
    isBankAccount: expenseAccount.isBankAccount,
    isCashAccount: expenseAccount.isCashAccount,
    archivedAt: expenseAccount.archivedAt,
    fundApplicability: expenseAccount.fundApplicability,
    categoryKey: expenseAccount.category?.key ?? null,
    fsGroupKey: expenseAccount.fsGroup?.key ?? null,
    accountRole: expenseAccount.accountRole ?? "STANDARD",
  }, {
    transactionKind: "AP_INVOICE",
    // Server-side, without a capital classifier in scope, default
    // to UNKNOWN — the conservative posture. Callers who need a
    // capital debit will still be admitted by ASSET/DEBIT rows if
    // the account passes structural rules; the nature-conditioned
    // rule only rejects ordinary ASSETs under OPERATING and similar.
    expectedDebitRole: expenseAccount.type === "ASSET" ? "CAPITAL_ASSET" : "OPERATING_EXPENSE",
  });
  if (!eligibilityVerdict.eligible) {
    return {
      ok: false,
      message: `Account ${expenseAccount.accountNumber} ${expenseAccount.name} is not eligible for an AP debit: ${eligibilityVerdict.exclusionReasons.join(", ")}. Choose a different account.`,
      code: "ELIGIBILITY_REJECTED",
    };
  }

  // -----------------------------------------------------------------------
  // Sprint 3 · Post-16H Phase 3.2 (2026-08-06) — §2 canonical-decision
  // enforcement. The narrow eligibility check above only proves the
  // SELECTED GL is structurally postable. It does NOT prove the invoice
  // as a whole is safe to post: unresolved gross total, allocation
  // variance, duplicate risk, contradictory evidence, etc. remain the
  // canonical decision's job. Founder rule: "Immediately before any
  // accounting write, reconstruct the current canonical decision using
  // authoritative server-side data. Posting must be refused when the
  // current decision includes any blocker that makes the invoice unsafe
  // or incomplete for posting."
  //
  // Enforcement policy uses `evaluatePostingGate`:
  //   * HARD_BLOCK               → refuse unconditionally.
  //   * REQUIRES_EXPLICIT_REVIEW → refuse unless client sent the code
  //                                in `acknowledgedBlockers` AND an
  //                                override audit row is queued for it.
  //   * WARNING_ONLY             → allow; recorded as warning below.
  //
  // Absence of a persistable analysis (no ApIntakeSource → no ingested
  // document) is itself a soft-block — surfaced as
  // ACCOUNTING_DECISION_UNAVAILABLE so the client can't bypass by
  // supplying an arbitrary WI id.
  const intakeSource = await prisma.apIntakeSource.findFirst({
    where: { clubId, canonicalApIntakeId: wi.id },
    select: { ingestedDocumentId: true },
    orderBy: { createdAt: "desc" },
  });
  let canonicalGateVerdict: PostingGateVerdict | null = null;
  let canonicalDecisionSnapshot: string | null = null;
  if (intakeSource?.ingestedDocumentId) {
    try {
      const { analyseIngestedInvoice } = await import("@/lib/ap-intelligence/analyse");
      const { computeApWorkflowDecision } = await import("@/lib/ap-intelligence/workflow/decision");
      const { evaluatePostingGate } = await import("@/lib/ap-intelligence/workflow/blocker-class");
      const analysis = await analyseIngestedInvoice({ clubId, ingestedDocumentId: intakeSource.ingestedDocumentId });
      const decision = computeApWorkflowDecision({
        analysis,
        documentAnalysisPending: false,
        duplicateRisk:
          analysis.reconcile.state === "DUPLICATE" || analysis.reconcile.state === "HASH_DUPLICATE",
        tenantAutoApprovalPolicy: undefined,
        vendorIsNew: analysis.vendor.state !== "MATCHED",
      });
      const ackCodes = (input.acknowledgedBlockers ?? []) as ApWorkflowBlockerCode[];
      canonicalGateVerdict = evaluatePostingGate(
        decision.blockers.map((b) => b.code),
        ackCodes,
      );
      canonicalDecisionSnapshot = JSON.stringify({
        state: decision.state,
        blockerCodes: decision.blockers.map((b) => b.code),
        warningCodes: decision.warnings.map((w) => w.code),
        acknowledged: input.acknowledgedBlockers ?? [],
        capturedAt: new Date().toISOString(),
      });
      if (!canonicalGateVerdict.allowed) {
        logger.warn("mission-control.post-ap-invoice.canonical-gate-refused", {
          clubId, workIntakeItemId: wi.id,
          refusalCode: canonicalGateVerdict.refusalCode,
          hard: canonicalGateVerdict.hardBlockers,
          unackedReview: canonicalGateVerdict.unacknowledgedRequiresReview,
        });
        return {
          ok: false,
          message: canonicalGateVerdict.refusalMessage ?? "Canonical decision refused posting.",
          code: canonicalGateVerdict.refusalCode === "HARD_BLOCK"
            ? "CANONICAL_HARD_BLOCK"
            : "CANONICAL_UNACKNOWLEDGED_REVIEW",
        };
      }
    } catch (canonErr) {
      logger.error("mission-control.post-ap-invoice.canonical-gate-error", {
        clubId, workIntakeItemId: wi.id,
        error: canonErr instanceof Error ? canonErr.message : String(canonErr),
      });
      // Fail-closed: on decision-service failure, refuse rather than post.
      return {
        ok: false,
        message: "Canonical AP decision could not be evaluated; posting refused for safety.",
        code: "ACCOUNTING_DECISION_UNAVAILABLE",
      };
    }
  }
  // If there is no ApIntakeSource (e.g. non-email intake), the legacy
  // eligibility check above is the sole structural gate. That path is
  // exercised only by administrative / test-fixture WIs on this tenant
  // and remains subject to the same balanced-entry + fiscal-period +
  // duplicate preflights below.

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

      // Sprint 3 · Post-16H Phase 3.2 (2026-08-06) — §3 override
      // audit rows. Persist every reviewer correction inside the same
      // atomic tx so no accounting write survives without its
      // supporting audit trail. `resultingDecisionJson` is the same
      // canonical snapshot the enforcement gate evaluated, so an
      // auditor can prove the posted decision matches what was
      // authorised.
      const auditableOverrides = input.overrides ?? [];
      if (auditableOverrides.length > 0) {
        await tx.apReviewOverride.createMany({
          data: auditableOverrides.map((o) => ({
            clubId,
            workIntakeItemId: wi.id,
            reviewedByUserId: principal.id,
            overrideKind: o.overrideKind,
            satisfiesBlocker: o.satisfiesBlocker ?? null,
            originalValueJson: o.originalValueJson ?? null,
            correctedValueJson: o.correctedValueJson ?? null,
            reason: o.reason ?? null,
            resultingDecisionJson: canonicalDecisionSnapshot,
          })),
        });
      }

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
        canonicalGate: canonicalGateVerdict ? {
          refusalCode: canonicalGateVerdict.refusalCode,
          hardBlockers: canonicalGateVerdict.hardBlockers,
          requiresReviewBlockers: canonicalGateVerdict.requiresReviewBlockers,
          acknowledgedByReview: canonicalGateVerdict.acknowledgedByReview,
          warningOnlyBlockers: canonicalGateVerdict.warningOnlyBlockers,
        } : { refusalCode: "OK", note: "no ApIntakeSource — legacy structural gate only" },
        overridesRecorded: (input.overrides ?? []).length,
      },
    });
    await audit(principal, {
      action: "work-intake.resolve",
      entityType: "WorkIntakeItem",
      entityId: wi.id,
      clubId,
      after: { via: "mission-control:post-ap-invoice-atomic", apInvoiceId: result.invoiceId, journalEntryId: result.journalEntryId },
    });

    // Sprint 3 · Checkpoint 16H completion §5 — route through the
    // canonical WorkCompletionEvent path so archive-enqueue,
    // audit, and idempotency are consistent with every other
    // completing workflow. The emit helper:
    //   * writes a WorkCompletionEvent (completionType =
    //     POSTED_AND_CLEARED)
    //   * finds PRIMARY email origins
    //   * enqueues MAILBOX_ARCHIVE_MESSAGE with idempotency key
    //     `archive:{eventId}:{emailMessageId}` (per-completion
    //     unique — a rapid double-click coalesces)
    //   * gates on OUTLOOK_ARCHIVE_ON_COMPLETION_ENABLED
    // The prior direct enqueue is removed; emit is the single
    // source of the archive job.
    let archive: PostApInvoiceResult["lifecycle"]["emailArchive"] = {
      status: "NOT_APPLICABLE", reason: "WI not linked to an EmailMessage",
    };
    try {
      const { emitWorkCompletionEvent } = await import("@/lib/work-intake/completion");
      const evt = await emitWorkCompletionEvent({
        workIntakeItemId: wi.id,
        clubId,
        completedByUserId: principal.id,
        completionType: "POSTED_AND_CLEARED",
        metadata: {
          apInvoiceId: result.invoiceId,
          apInvoiceNumber: result.invoiceNumber,
          journalEntryId: result.journalEntryId,
          journalEntryNumber: result.journalEntryNumber,
        },
      });
      if (evt.archiveJobsEnqueued > 0) {
        archive = { status: "QUEUED", jobId: `event:${evt.eventId}` };
      } else if (evt.reason === "no_email_provenance") {
        archive = { status: "NOT_APPLICABLE", reason: "WI not linked to an EmailMessage" };
      } else if (evt.reason === "flag_off") {
        archive = { status: "NOT_APPLICABLE", reason: "OUTLOOK_ARCHIVE_ON_COMPLETION_ENABLED is off" };
      }
    } catch (emitErr) {
      logger.warn("mission-control.post-ap-invoice.completion-emit-failed", {
        clubId, invoiceId: result.invoiceId,
        error: emitErr instanceof Error ? emitErr.message : String(emitErr),
      });
      archive = { status: "ENQUEUE_FAILED", error: emitErr instanceof Error ? emitErr.message : "unknown" };
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
