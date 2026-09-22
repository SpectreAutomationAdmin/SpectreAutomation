// Payroll MVP posting (2026-09-05) — Approve + Post services.
//
// State transitions completed by this module:
//     CALCULATED → APPROVED   (approvePayrollBatch)
//     APPROVED   → POSTED     (postPayrollBatch, which also writes GL)
//
// Governing rules:
//   - Separation of duties: only a user with `payroll:approve` may
//     approve; only a user with `payroll:post` may post. Neither
//     needs SIN / banking / TD1 reveal — payroll results are pre-
//     computed by the calculator on immutable snapshots.
//   - Idempotency: repeat approval / posting attempts are refused
//     with a ConflictError. A batch that has already reached the
//     target state (or beyond) never re-transitions.
//   - GL posting: constructs one balanced journal via the canonical
//     createPostedFromAdapter helper (accounting/journal.ts) inside
//     a single transaction. On any GL failure the batch stays
//     APPROVED — posting can be retried once the failure is fixed.
//   - Payment transmission is DELIBERATELY out of scope for this
//     MVP. Neither service triggers EFT/bank submission. Callers
//     surface `Payroll posted — payment transmission not yet
//     enabled` (or repository-consistent copy) in the UI.
//
// See docs/deployment/FOUNDER-PREVIEW-AND-DEPLOYMENT-WORKFLOW.md
// for the local Founder Preview workflow this MVP enables.

import { prisma } from "../prisma";
import { audit } from "../audit";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../errors";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { assertPostingAllowed } from "../posting-guard";
import { createPostedFromAdapter } from "../accounting/journal";
import type { JournalSource } from "../accounting/types";
import { Prisma } from "@prisma/client";
import { resolvePayrollJournal } from "./payroll-gl-resolver";
import { loadPayrollGlInputs } from "./payroll-gl-inputs";

const PAYROLL_ENTITY = "PayrollBatch";
const FINAL_APPROVAL_ORIGIN_KIND = "PAYROLL_FINAL_APPROVAL";

/**
 * Close the Controller's PAYROLL_FINAL_APPROVAL Work Intake item
 * when the batch reaches POSTED. Never fails posting — logs only.
 */
async function resolveFinalApprovalItem(
  clubId: string, batchId: string, actorUserId: string,
): Promise<void> {
  const link = await prisma.workIntakeOrigin.findFirst({
    where: { clubId, kind: FINAL_APPROVAL_ORIGIN_KIND, referenceId: batchId, role: "PRIMARY" },
    select: { workIntakeItemId: true },
  });
  if (!link) return;
  const now = new Date();
  await prisma.workIntakeItem.updateMany({
    where: { id: link.workIntakeItemId, status: { not: "RESOLVED" } },
    data: { status: "RESOLVED", resolvedAt: now, resolvedByUserId: actorUserId },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: link.workIntakeItemId, actorUserId, action: "RESOLVED",
      note: "Payroll batch posted to the general ledger.",
    },
  });
}

// ---------------------------------------------------------------------
// Load — always tenant-owned, includes calculation totals.
// ---------------------------------------------------------------------
async function loadBatchOrThrow(principal: Principal, batchId: string) {
  const batch = await prisma.payrollBatch.findUnique({
    where: { id: batchId },
    include: {
      employees: true,
      payGroup: true,
      payPeriod: true,
    },
  });
  if (!batch) throw new NotFoundError(PAYROLL_ENTITY, batchId);
  assertTenantOwned(batch, principal);
  return batch;
}

// Sum a Prisma.Decimal field across an array with .Decimal-safe add.
function sumDec(rows: Array<Record<string, unknown>>, field: string): Prisma.Decimal {
  let acc = new Prisma.Decimal(0);
  for (const r of rows) {
    const v = r[field];
    if (v == null) continue;
    acc = acc.plus(v as Prisma.Decimal);
  }
  return acc;
}

// ---------------------------------------------------------------------
// Approve — SUBMITTED_FOR_APPROVAL → APPROVED.
//
// Payroll Admin Slice 3E (2026-09-12): approve is now the Controller's
// deliberate act on a SUBMITTED_FOR_APPROVAL batch. The prior CALCULATED
// branch is closed — Payroll Admin must Submit first (see
// submit-payroll-batch.ts). New guards (§13-15, §26-29):
//
//   • Refuses non-SUBMITTED_FOR_APPROVAL states (idempotent on
//     APPROVED/POSTED only when same-actor re-hits).
//   • CAS on (id, status="SUBMITTED_FOR_APPROVAL",
//     calculationVersion=expectedVersion, submittedAt=expectedSubmitted).
//   • Optional expectedCalculationVersion pin — the Controller's
//     review surface passes the version they reviewed; a stale v1
//     approval against a resubmitted v2 batch refuses.
//   • Segregation of duties (§25, §43): the submitter (submittedByUserId)
//     MUST NOT be the approver. SUPER_ADMIN / founder does NOT bypass —
//     if the same user submitted and would approve, refuse.
//   • Closes the Controller PAYROLL_FINAL_APPROVAL card on success.
// ---------------------------------------------------------------------
export class ApproveConcurrencyConflictError extends Error {
  readonly code = "PAYROLL_APPROVE_CONCURRENCY_CONFLICT";
  readonly batchId: string;
  readonly expectedStatus: string;
  readonly expectedVersion: number;
  constructor(batchId: string, expectedStatus: string, expectedVersion: number) {
    super(
      `Concurrent Approve detected on batch ${batchId}: expected status=${expectedStatus} version=${expectedVersion} ` +
        "but the row changed under the transaction. Reload the batch and retry.",
    );
    this.batchId = batchId;
    this.expectedStatus = expectedStatus;
    this.expectedVersion = expectedVersion;
  }
}

/** Retained for backwards-compatibility of consumers that catch this
 *  error class. The two-person governance change (2026-09-13) no
 *  longer *throws* this — the submitter is now permitted to post
 *  provided a distinct Controller approved the payroll first. Kept
 *  exported so downstream imports do not break in one revision. */
export class PostSegregationOfDutiesError extends Error {
  readonly code = "PAYROLL_POST_SOD_REFUSED";
  readonly batchId: string;
  readonly actorUserId: string;
  readonly conflictingRole: "submitter";
  constructor(batchId: string, actorUserId: string, conflictingRole: "submitter") {
    super(
      `Posting refused: the user who submitted this payroll may not also post it. ` +
        `batchId=${batchId}, actorUserId=${actorUserId}.`,
    );
    this.batchId = batchId;
    this.actorUserId = actorUserId;
    this.conflictingRole = conflictingRole;
  }
}

export class ApproveSegregationOfDutiesError extends Error {
  readonly code = "PAYROLL_APPROVE_SOD_REFUSED";
  readonly batchId: string;
  readonly actorUserId: string;
  constructor(batchId: string, actorUserId: string) {
    super(
      `Approval refused: the user who submitted this payroll may not also approve it. batchId=${batchId}, actorUserId=${actorUserId}.`,
    );
    this.batchId = batchId;
    this.actorUserId = actorUserId;
  }
}

export interface ApprovePayrollBatchOptions {
  /** Optional pin: the calculationVersion the Controller reviewed.
   *  Refuses if the batch's current calculationVersion differs. */
  expectedCalculationVersion?: number;
}

export async function approvePayrollBatch(
  principal: Principal,
  batchId: string,
  options: ApprovePayrollBatchOptions = {},
): Promise<Awaited<ReturnType<typeof prisma.payrollBatch.findUnique>>> {
  const batch = await loadBatchOrThrow(principal, batchId);
  requirePermission(principal, batch.clubId, "payroll:approve");
  await assertPostingAllowed(principal, batch.clubId, "payroll.batch.approve", PAYROLL_ENTITY, batchId);

  if (batch.status === "APPROVED" || batch.status === "POSTED") {
    // Idempotent — already at or past target.
    if (batch.approvedByUserId === principal.id) return batch;
    throw new ConflictError(`Batch is already ${batch.status.toLowerCase()}.`);
  }
  if (batch.status !== "SUBMITTED_FOR_APPROVAL") {
    throw new ConflictError(
      `Batch must be SUBMITTED_FOR_APPROVAL before it can be approved; current status is ${batch.status}.`,
    );
  }
  if (options.expectedCalculationVersion != null &&
      batch.calculationVersion !== options.expectedCalculationVersion) {
    throw new ConflictError(
      `Approval refused: expected calculationVersion=${options.expectedCalculationVersion} but the batch is now v${batch.calculationVersion}. Reload and re-review.`,
    );
  }
  if (batch.submittedByUserId && batch.submittedByUserId === principal.id) {
    throw new ApproveSegregationOfDutiesError(batch.id, principal.id);
  }

  const now = new Date();
  const gate = await prisma.payrollBatch.updateMany({
    where: {
      id: batch.id, clubId: batch.clubId,
      status: "SUBMITTED_FOR_APPROVAL",
      calculationVersion: batch.calculationVersion,
      submittedByUserId: batch.submittedByUserId,
    },
    data: {
      status: "APPROVED",
      approvedAt: now,
      approvedByUserId: principal.id,
    },
  });
  if (gate.count !== 1) {
    throw new ApproveConcurrencyConflictError(batch.id, "SUBMITTED_FOR_APPROVAL", batch.calculationVersion);
  }

  // Close the Controller's queue-side task on approve (mirror of
  // Return's Controller-side close). Non-fatal on failure.
  //
  // Payroll 3F (2026-09-13) — also materialise the Payroll Admin's
  // PAYROLL_READY_TO_POST card so posting responsibility is routed
  // to the correct owner. Idempotent per-origin. Non-fatal on
  // failure — approval already succeeded regardless.
  try {
    const {
      resolveFinalApprovalItem: resolveFinal,
      materialiseReadyToPostItem,
    } = await import("./controller-work-intake");
    await resolveFinal(batch.clubId, batch.id, principal.id,
      `Payroll approved by Controller — batch ${batch.id} at calculationVersion ${batch.calculationVersion}.`);

    // Pre-Phase-5 governance restoration (2026-09-16):
    // Ready-to-Post routes to the Payroll Admin — the same actor who
    // prepared + submitted the payroll. Fallback to the batch's
    // recorded submitter, then the Controller (approver), so a
    // misconfiguration cannot leave the card ownerless.
    const cfg = await prisma.payrollClubConfig.findUnique({ where: { clubId: batch.clubId } });
    const posterUserId =
      cfg?.payrollAdminUserId ??
      batch.submittedByUserId ??
      cfg?.controllerUserId ??
      principal.id;
    if (posterUserId) {
      const period = await prisma.payrollPayPeriod.findFirst({
        where: { id: batch.payPeriodId, clubId: batch.clubId },
        select: { periodStart: true, periodEnd: true, payDate: true },
      });
      const dateLabel = period
        ? `${period.periodStart.toISOString().slice(0, 10)} → ${new Date(period.periodEnd.getTime() - 86_400_000).toISOString().slice(0, 10)}`
        : batch.payPeriodId;
      // Executive summary — reuse the persisted per-employee results.
      const bes = await prisma.payrollBatchEmployee.findMany({
        where: { batchId: batch.id, clubId: batch.clubId },
        select: {
          grossPay: true, netPay: true, totalEmployeeDeductions: true,
          employerCppCombined: true, employerCpp2: true, employerEi: true,
        },
      });
      const totals = bes.reduce(
        (acc, be) => ({
          gross:    acc.gross    + Math.round(Number(be.grossPay ?? 0) * 100),
          deducted: acc.deducted + Math.round(Number(be.totalEmployeeDeductions ?? 0) * 100),
          net:      acc.net      + Math.round(Number(be.netPay ?? 0) * 100),
          employer: acc.employer + Math.round(Number(be.employerCppCombined ?? 0) * 100)
                                + Math.round(Number(be.employerCpp2 ?? 0) * 100)
                                + Math.round(Number(be.employerEi ?? 0) * 100),
        }),
        { gross: 0, deducted: 0, net: 0, employer: 0 },
      );
      const money = (cents: number) => (cents / 100).toFixed(2);
      const reviewUrl = `/app/admin/payroll/batches/${batch.id}`;
      const preview =
        `v${batch.calculationVersion} · ${bes.length} employees · ` +
        `gross $${money(totals.gross)} · deductions $${money(totals.deducted)} · ` +
        `net $${money(totals.net)} · employer contributions $${money(totals.employer)} · ` +
        `Post payroll → ${reviewUrl}`;
      await materialiseReadyToPostItem({
        clubId: batch.clubId, batchId: batch.id,
        payrollAdminUserId: posterUserId,
        subject: `Payroll Approved — Ready to Post · ${dateLabel}`,
        preview,
        approvedByUserId: principal.id,
      });
    }
  } catch (err) {
    // Non-fatal — approval succeeded regardless.
    // eslint-disable-next-line no-console
    console.warn("[payroll approve] Ready-to-Post handoff failed", err);
  }

  const updated = await prisma.payrollBatch.findUnique({ where: { id: batch.id } });

  await audit(principal, {
    clubId: batch.clubId,
    action: "payroll.batch.controller-approve",
    entityType: PAYROLL_ENTITY,
    entityId: batch.id,
    before: {
      status: "SUBMITTED_FOR_APPROVAL",
      calculationVersion: batch.calculationVersion,
      submittedByUserId: batch.submittedByUserId,
    },
    after: {
      status: "APPROVED",
      approvedAt: now,
      preparedByUserId: batch.preparedByUserId,
      submittedByUserId: batch.submittedByUserId,
      approvedByUserId: principal.id,
      calculationVersion: batch.calculationVersion,
      packageChecksum: batch.packageChecksum,
    },
  });
  return updated;
}

// ---------------------------------------------------------------------
// Post — APPROVED → POSTED. Writes the balanced GL journal in the
// SAME transaction so a failure leaves the batch APPROVED and no
// half-posted state.
// ---------------------------------------------------------------------
export async function postPayrollBatch(
  principal: Principal,
  batchId: string,
): Promise<{
  batch: Awaited<ReturnType<typeof prisma.payrollBatch.findUnique>>;
  journalEntryId: string;
  totalDebits: string;
  totalCredits: string;
}> {
  const batch = await loadBatchOrThrow(principal, batchId);
  requirePermission(principal, batch.clubId, "payroll:post");
  await assertPostingAllowed(principal, batch.clubId, "payroll.batch.post", PAYROLL_ENTITY, batchId);

  if (batch.status === "POSTED") {
    // Idempotent — already posted. Return the existing journal.
    if (!batch.glJournalEntryId) {
      throw new ConflictError("Batch is POSTED but has no linked GL journal — investigate manually.");
    }
    const totals = await totalsForResponse(batch.clubId, batch.glJournalEntryId);
    return { batch, journalEntryId: batch.glJournalEntryId, ...totals };
  }
  if (batch.status !== "APPROVED") {
    throw new ConflictError(
      `Batch must be APPROVED before it can be posted; current status is ${batch.status}.`,
    );
  }

  // FPP-9B (2026-09-22) — CORRECTION batches may only post after their
  // paired REVERSAL has already been POSTED. This preserves the accounting
  // chain: Original → Reversal → Correction. Posting the correction before
  // the reversal would leave "Original + Correction" — an incoherent state.
  if (batch.transactionType === "CORRECTION") {
    const { assertCorrectionCanPost } = await import("./correction");
    await assertCorrectionCanPost(batch.id);
  }

  // Payroll two-person governance (2026-09-13, superseding 3F §25):
  // the SUBMITTER cannot approve their own payroll (that check remains
  // in approvePayrollBatch), but the APPROVER is free to also post it.
  // Once a distinct Controller has approved a specific immutable
  // calculationVersion, requiring a third human to execute the
  // accounting posting adds no accounting-control value. The
  // separation Spectre enforces is between preparation/submission and
  // independent approval; posting sits with the Controller who
  // already validated the payroll.

  // FPP-9A (2026-09-22) — REVERSAL branch. A batch of
  // transactionType="REVERSAL" is posted by deriving its journal as
  // the exact inverse of the ORIGINAL batch's journal (debit ↔
  // credit swap on each line, same account + department). This
  // sidesteps the readiness + resolver pipeline — the original was
  // already ready when it posted, and the resolver would need to
  // handle negative amounts, which is unnecessarily complex. The
  // resulting journal balances by construction (sum of debits =
  // sum of credits, because the original journal balanced).
  if (batch.transactionType === "REVERSAL") {
    if (!batch.reversesPayrollBatchId) {
      throw new ConflictError("Reversal batch is missing reversesPayrollBatchId — cannot post.");
    }
    const original = await prisma.payrollBatch.findUnique({
      where: { id: batch.reversesPayrollBatchId },
      select: { id: true, clubId: true, status: true, glJournalEntryId: true },
    });
    if (!original) throw new ConflictError("Reversal target batch not found.");
    if (original.clubId !== batch.clubId) throw new ConflictError("Reversal target batch belongs to a different Club.");
    if (original.status !== "POSTED" || !original.glJournalEntryId) {
      throw new ConflictError(`Cannot post reversal — original batch ${original.id} is ${original.status} without a journal.`);
    }
    const originalLines = await prisma.journalEntryLine.findMany({
      where: { journalEntryId: original.glJournalEntryId },
      include: {
        account: { select: { id: true, accountNumber: true } },
        department: { select: { id: true, code: true } },
      },
      orderBy: { lineNumber: "asc" },
    });
    if (originalLines.length === 0) {
      throw new ConflictError("Original journal has no lines to reverse.");
    }
    // Build the reversal `lines[]` — swap debit ↔ credit on each line.
    const label = `Payroll REVERSAL ${batch.payGroup.code} ${batch.payPeriod.periodStart.toISOString().slice(0, 10)} → ${batch.payPeriod.payDate.toISOString().slice(0, 10)}`;
    const lines: Array<{
      accountNumber: string;
      debit?: string;
      credit?: string;
      description: string;
      lineNumber: number;
      departmentCode?: string | null;
    }> = originalLines.map((l, idx) => {
      const entry: {
        accountNumber: string;
        debit?: string;
        credit?: string;
        description: string;
        lineNumber: number;
        departmentCode?: string | null;
      } = {
        lineNumber: idx + 1,
        accountNumber: l.account.accountNumber,
        description: `Reversal of "${l.description}" (batch ${original.id.slice(-8)})`,
      };
      // Swap sides.
      if (l.debit != null && !new Prisma.Decimal(l.debit).isZero()) {
        entry.credit = new Prisma.Decimal(l.debit).toFixed(2);
      }
      if (l.credit != null && !new Prisma.Decimal(l.credit).isZero()) {
        entry.debit = new Prisma.Decimal(l.credit).toFixed(2);
      }
      if (l.department?.code) entry.departmentCode = l.department.code;
      return entry;
    });
    // Atomic post — same shape as the STANDARD path below.
    const now = new Date();
    const txResult = await prisma.$transaction(async (tx) => {
      const acquired = await tx.payrollBatch.updateMany({
        where: { id: batch.id, status: "APPROVED", glJournalEntryId: null },
        data: { status: "POSTED", postedAt: now, postedByUserId: principal.id },
      });
      if (acquired.count === 0) {
        const current = await tx.payrollBatch.findUnique({ where: { id: batch.id } });
        if (current?.status === "POSTED" && current.glJournalEntryId) {
          return { batch: current, journalEntryId: current.glJournalEntryId, existing: true as const };
        }
        throw new ConflictError(
          `Concurrent post race on reversal: batch is ${current?.status ?? "unknown"} without a journal — retry.`,
        );
      }
      const entry = await createPostedFromAdapter(
        principal, batch.clubId,
        {
          entryDate: batch.payPeriod.payDate.toISOString(),
          description: `${label} — reverses batch ${original.id.slice(-8)} (JE ${original.glJournalEntryId?.slice(-8)})`,
          memo: `Auto-generated reversal from PayrollBatch ${batch.id} — reverses ${original.id}`,
          lines,
        },
        {
          source: "PAYROLL" as JournalSource,
          sourceEntityType: PAYROLL_ENTITY,
          sourceEntityId: batch.id,
        },
        tx,
      );
      const linked = await tx.payrollBatch.update({
        where: { id: batch.id },
        data: { glJournalEntryId: entry.id },
      });
      return { batch: linked, journalEntryId: entry.id, existing: false as const };
    }, { timeout: 30_000, maxWait: 10_000 });

    const posted = txResult.batch;
    const reversalEntry = { id: txResult.journalEntryId };
    // Close both Work Intake items (Final approval + Ready to Post) if open.
    try {
      const { resolveFinalApprovalItem: resolveFinal, resolveReadyToPostItem } = await import("./controller-work-intake");
      await resolveFinal(batch.clubId, batch.id, principal.id,
        `Payroll reversal posted — new journal ${reversalEntry.id} reverses ${original.glJournalEntryId}.`);
      await resolveReadyToPostItem(batch.clubId, batch.id, principal.id,
        `Payroll reversal posted — new journal ${reversalEntry.id} reverses ${original.glJournalEntryId}.`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[payroll reversal post] WI resolution failed", err);
    }
    const totals = await totalsForResponse(batch.clubId, reversalEntry.id);
    await audit(principal, {
      clubId: batch.clubId,
      action: "payroll.reversal.post",
      entityType: PAYROLL_ENTITY,
      entityId: batch.id,
      before: { status: "APPROVED" },
      after: {
        status: "POSTED",
        postedAt: now,
        journalEntryId: reversalEntry.id,
        reversesPayrollBatchId: original.id,
        reversesJournalEntryId: original.glJournalEntryId,
        totalDebits: totals.totalDebits,
        totalCredits: totals.totalCredits,
      },
    });
    return { batch: posted, journalEntryId: reversalEntry.id, ...totals };
  }

  // Payroll-3C-6 (2026-09-05) — component-aware GL readiness check.
  // Runs BEFORE any journal drafting so component-carrying batches
  // fail loudly (with actionable blocker codes) instead of silently
  // omitting expense / liability lines. Basic batches with zero
  // component snapshots pass through when the global profile is set.
  const { evaluatePayrollGlReadiness } = await import("./gl-readiness");
  const readiness = await evaluatePayrollGlReadiness(principal, batch.clubId, batch.id);
  if (!readiness.ready) {
    const summary = readiness.blockers.slice(0, 6).map((b) => b.code).join(", ");
    throw new ConflictError(
      `Payroll GL readiness failed (${readiness.blockers.length} blocker${readiness.blockers.length === 1 ? "" : "s"}: ${summary}). ` +
      `Resolve tenant Payroll accounting configuration + component GL mapping before posting.`,
    );
  }

  // Phase 3 (2026-09-15) — load resolver inputs through the shared
  // input assembler so preview + posting see identical facts +
  // per-department overrides. See src/lib/payroll/payroll-gl-resolver.ts.
  const inputs = await loadPayrollGlInputs(batch.clubId, batch.id);
  const profile = inputs.profile;
  if (!profile) {
    throw new ConflictError(
      "This Club has no PayrollGlAccountingProfile configured. Payroll cannot post to the GL until account mapping is in place.",
    );
  }
  if (inputs.employees.length === 0) {
    throw new ConflictError("Cannot post an empty batch — no employees calculated.");
  }

  const label = `Payroll ${batch.payGroup.code} ${batch.payPeriod.periodStart.toISOString().slice(0, 10)} → ${batch.payPeriod.payDate.toISOString().slice(0, 10)}`;
  const resolved = resolvePayrollJournal({
    label,
    profile,
    employees: inputs.employees,
    components: inputs.components,
  });
  if (!resolved.balanced) {
    throw new ConflictError(
      `Payroll GL draft does not balance (D=${resolved.totalDebits.toFixed(2)}, C=${resolved.totalCredits.toFixed(2)}, Δ=${resolved.totalDebits.minus(resolved.totalCredits).toFixed(2)}). ` +
      `Statutory column math must reconcile before posting.`,
    );
  }

  // Resolve account IDs to accountNumber + department IDs to
  // department code so the canonical journal adapter can accept the
  // draft. `departmentCode` is the adapter's schema key; the adapter
  // resolves it back to a Department.id and persists on
  // JournalEntryLine.departmentId.
  const uniqueAccountIds = Array.from(new Set(resolved.lines.map((l) => l.accountId)));
  const uniqueDeptIds = Array.from(new Set(
    resolved.lines.map((l) => l.departmentId).filter((v): v is string => v != null),
  ));
  const [acctRows, deptRows] = await Promise.all([
    prisma.account.findMany({
      where: { id: { in: uniqueAccountIds } },
      select: { id: true, accountNumber: true },
    }),
    uniqueDeptIds.length > 0
      ? prisma.department.findMany({
          where: { id: { in: uniqueDeptIds }, clubId: batch.clubId },
          select: { id: true, code: true },
        })
      : Promise.resolve([]),
  ]);
  const acctNumberById = new Map(acctRows.map((a) => [a.id, a.accountNumber]));
  const deptCodeById = new Map(deptRows.map((d) => [d.id, d.code]));
  const num = (id: string): string => {
    const n = acctNumberById.get(id);
    if (!n) throw new ConflictError(`Payroll GL references missing account ${id}.`);
    return n;
  };
  const deptCode = (id: string | null): string | null => {
    if (id == null) return null;
    const c = deptCodeById.get(id);
    if (!c) throw new ConflictError(`Payroll GL references missing department ${id}.`);
    return c;
  };
  const lines: Array<{
    accountNumber: string;
    debit?: string;
    credit?: string;
    description: string;
    lineNumber: number;
    departmentCode?: string | null;
  }> = resolved.lines.map((l, idx) => {
    const entry: {
      accountNumber: string;
      debit?: string;
      credit?: string;
      description: string;
      lineNumber: number;
      departmentCode?: string | null;
    } = {
      lineNumber: idx + 1,
      accountNumber: num(l.accountId),
      description: l.description,
    };
    if (l.debit != null)  entry.debit  = l.debit.toFixed(2);
    if (l.credit != null) entry.credit = l.credit.toFixed(2);
    const code = deptCode(l.departmentId);
    if (code) entry.departmentCode = code;
    return entry;
  });

  // Payroll-3C-6B (2026-09-05) — one transaction for the whole post.
  //
  // Prior (buggy) sequence: createPostedFromAdapter ran its OWN
  // transaction, then the batch was updated in a SECOND transaction.
  // Two concurrent posts could both succeed at JE creation and only
  // one at the batch update, leaving an orphan JournalEntry from the
  // losing caller.
  //
  // New sequence — everything inside `prisma.$transaction`:
  //   1. Acquire exclusive post right via `updateMany({where: status
  //      APPROVED + glJournalEntryId null, data: postedAt/By})`. If
  //      count = 0, another actor already won — return the existing
  //      journal idempotently OR throw for wrong-state.
  //   2. Create the JournalEntry + lines inside this same tx by
  //      passing the tx client to createPostedFromAdapter.
  //   3. Link the batch → JE via a second update.
  //
  // If ANY step throws, the transaction rolls back → no JournalEntry,
  // no partial state. Concurrent losers see the winner's batch already
  // flipped and return idempotently.
  const now = new Date();
  const txResult = await prisma.$transaction(async (tx) => {
    // Payroll-3C-6B — see the wrapping `.transaction(..., { timeout })`
    // options below. Bumped from Prisma's 5s default because the audit
    // + assertPostingAllowed calls upstream of the JE write can push
    // the total transaction window past 5s on slower CI SQLite.
    // 1. Atomic acquisition.
    const acquired = await tx.payrollBatch.updateMany({
      where: {
        id: batch.id,
        status: "APPROVED",
        glJournalEntryId: null,
      },
      data: {
        status: "POSTED",
        postedAt: now,
        postedByUserId: principal.id,
      },
    });
    if (acquired.count === 0) {
      // Someone else won inside our transaction window. Re-read the
      // canonical journal — this is the idempotent-success path.
      const current = await tx.payrollBatch.findUnique({ where: { id: batch.id } });
      if (current?.status === "POSTED" && current.glJournalEntryId) {
        return { batch: current, journalEntryId: current.glJournalEntryId, existing: true as const };
      }
      throw new ConflictError(
        `Concurrent post race: batch is ${current?.status ?? "unknown"} without a journal — retry.`,
      );
    }
    // 2. Create JE + lines inside THIS tx. If it throws, the batch
    //    acquisition rolls back too.
    const entry = await createPostedFromAdapter(
      principal, batch.clubId,
      {
        entryDate: batch.payPeriod.payDate.toISOString(),
        description: `${label} — Payroll batch ${batch.id.slice(-8)}`,
        memo: `Auto-generated from PayrollBatch ${batch.id}`,
        lines,
      },
      {
        source: "PAYROLL" as JournalSource,
        sourceEntityType: PAYROLL_ENTITY,
        sourceEntityId: batch.id,
      },
      tx,
    );
    // Payroll-3C-6B — test-only fault-injection hook. Vitest fault
    // tests set this env var to prove the transaction rolls back the
    // JournalEntry created above when a later step throws. Never
    // set in production (env is unset).
    if (process.env.SPECTRE_PAYROLL_FAULT_INJECT === "AFTER_JE_CREATE") {
      throw new Error("Injected fault at glJournalEntryId link step");
    }
    // 3. Link the batch to the newly-created JE.
    const linked = await tx.payrollBatch.update({
      where: { id: batch.id },
      data: { glJournalEntryId: entry.id },
    });
    return { batch: linked, journalEntryId: entry.id, existing: false as const };
  }, { timeout: 30_000, maxWait: 10_000 });
  const posted = txResult.batch;
  const entry = { id: txResult.journalEntryId };

  // Close the Controller's Final-Approval Work Intake item, if still open.
  try {
    await resolveFinalApprovalItem(batch.clubId, batch.id, principal.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[payroll post] resolveFinalApprovalItem failed", err);
  }

  // Payroll 3F (2026-09-13) — resolve the Payroll Admin's
  // PAYROLL_READY_TO_POST card. Non-fatal on failure.
  try {
    const { resolveReadyToPostItem } = await import("./controller-work-intake");
    await resolveReadyToPostItem(batch.clubId, batch.id, principal.id,
      `Payroll posted — journal ${entry.id}, batch ${batch.id} at calculationVersion ${batch.calculationVersion}.`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[payroll post] resolveReadyToPostItem failed", err);
  }

  await audit(principal, {
    clubId: batch.clubId,
    action: "payroll.batch.post",
    entityType: PAYROLL_ENTITY,
    entityId: batch.id,
    before: { status: batch.status },
    after: {
      status: "POSTED",
      postedAt: now,
      journalEntryId: entry.id,
      totalDebits: resolved.totalDebits.toFixed(2),
      totalCredits: resolved.totalCredits.toFixed(2),
    },
  });

  return {
    batch: posted,
    journalEntryId: entry.id,
    totalDebits: resolved.totalDebits.toFixed(2),
    totalCredits: resolved.totalCredits.toFixed(2),
  };
}

async function totalsForResponse(clubId: string, journalEntryId: string) {
  const entry = await prisma.journalEntry.findUnique({
    where: { id: journalEntryId }, select: { totalDebits: true, totalCredits: true },
  });
  return {
    totalDebits: (entry?.totalDebits ?? new Prisma.Decimal(0)).toFixed(2),
    totalCredits: (entry?.totalCredits ?? new Prisma.Decimal(0)).toFixed(2),
  };
}
