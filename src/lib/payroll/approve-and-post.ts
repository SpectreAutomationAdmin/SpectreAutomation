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
import { componentRequiresExpense, componentRequiresLiability } from "./gl-readiness";

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
// Approve — CALCULATED → APPROVED.
//
// Segregation-of-duties (§30): the approver's principal.id must not
// match the batch's preparedByUserId. A single user MAY still
// prepare and approve if RBAC lets them (small-club convenience),
// but we surface a distinct audit event so it's visible on the
// batch history.
// ---------------------------------------------------------------------
export async function approvePayrollBatch(
  principal: Principal,
  batchId: string,
): Promise<Awaited<ReturnType<typeof prisma.payrollBatch.findUnique>>> {
  const batch = await loadBatchOrThrow(principal, batchId);
  requirePermission(principal, batch.clubId, "payroll:approve");
  await assertPostingAllowed(principal, batch.clubId, "payroll.batch.approve", PAYROLL_ENTITY, batchId);

  if (batch.status === "APPROVED" || batch.status === "POSTED") {
    // Idempotent — already at or past target.
    if (batch.approvedByUserId === principal.id) return batch;
    throw new ConflictError(`Batch is already ${batch.status.toLowerCase()}.`);
  }
  if (batch.status !== "CALCULATED" && batch.status !== "SUBMITTED_FOR_APPROVAL") {
    throw new ConflictError(
      `Batch must be CALCULATED before it can be approved; current status is ${batch.status}.`,
    );
  }

  const now = new Date();
  const updated = await prisma.payrollBatch.update({
    where: { id: batch.id },
    data: {
      status: "APPROVED",
      approvedAt: now,
      approvedByUserId: principal.id,
    },
  });

  const sameActor = batch.preparedByUserId && batch.preparedByUserId === principal.id;
  await audit(principal, {
    clubId: batch.clubId,
    action: sameActor ? "payroll.batch.approve.same-actor" : "payroll.batch.approve",
    entityType: PAYROLL_ENTITY,
    entityId: batch.id,
    before: { status: batch.status },
    after: {
      status: "APPROVED",
      approvedAt: now,
      preparedByUserId: batch.preparedByUserId,
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

  // Resolve the GL profile.
  const config = await prisma.payrollClubConfig.findUnique({
    where: { clubId: batch.clubId },
    include: { glAccountingProfile: true },
  });
  const profile = config?.glAccountingProfile;
  if (!profile) {
    throw new ConflictError(
      "This Club has no PayrollGlAccountingProfile configured. Payroll cannot post to the GL until account mapping is in place.",
    );
  }
  // Payroll-3C-6 — account resolution moved BELOW the component
  // aggregation so the same lookup batch covers global + component
  // accounts in one query. See below.

  // Aggregate per-employee statutory columns.
  const emps = await prisma.payrollBatchEmployee.findMany({
    where: { batchId: batch.id },
    select: {
      id: true, employeeId: true,
      grossPay: true, netPay: true,
      deductionCppEeCombined: true, deductionCpp2Ee: true,
      deductionEiEe: true,
      deductionFederalTax: true, deductionProvincialTax: true,
      employerCppCombined: true, employerCpp2: true,
      employerEi: true,
    },
  });
  if (emps.length === 0) {
    throw new ConflictError("Cannot post an empty batch — no employees calculated.");
  }
  const gross      = sumDec(emps, "grossPay");
  const netPay     = sumDec(emps, "netPay");
  const eeCpp      = sumDec(emps, "deductionCppEeCombined").plus(sumDec(emps, "deductionCpp2Ee"));
  const eeEi       = sumDec(emps, "deductionEiEe");
  const fedTax     = sumDec(emps, "deductionFederalTax");
  const provTax    = sumDec(emps, "deductionProvincialTax");
  const erCpp      = sumDec(emps, "employerCppCombined").plus(sumDec(emps, "employerCpp2"));
  const erEi       = sumDec(emps, "employerEi");
  const cppPayable = eeCpp.plus(erCpp);
  const eiPayable  = eeEi.plus(erEi);

  // Payroll-3C-6 — component snapshots. Aggregated by
  // (accountId × direction) so RRSP EE + RRSP ER credit ONE line
  // when they share a liability account (§28), employer benefit
  // expenses roll up to fewer lines, etc. Component contribution
  // to gross is deducted from the residual salary-expense line so
  // cash allowances aren't double-posted (§9 / §84).
  const snaps = await prisma.payrollBatchComponentSnapshot.findMany({
    where: { batchId: batch.id },
    select: {
      componentCode: true, displayName: true,
      side: true, cashEffect: true, category: true, provenance: true,
      resolvedAmount: true,
      expenseAccountIdSnapshot: true, liabilityAccountIdSnapshot: true,
    },
  });

  // Aggregation buckets keyed by accountId with a running total +
  // source-composition list for the journal description.
  interface Bucket { total: Prisma.Decimal; sources: string[] }
  const debitBuckets  = new Map<string, Bucket>();
  const creditBuckets = new Map<string, Bucket>();
  const addBucket = (m: Map<string, Bucket>, acctId: string, amt: Prisma.Decimal, src: string) => {
    const b = m.get(acctId);
    if (b) {
      b.total = b.total.plus(amt);
      if (!b.sources.includes(src)) b.sources.push(src);
    } else {
      m.set(acctId, { total: amt, sources: [src] });
    }
  };

  // Total cash amount that components have already contributed to
  // `grossPay`. Deducted from the residual salary-expense debit so
  // Cell Phone / one-time bonus don't post twice (once via their
  // own expense account and once via the salary account).
  let componentCashInGross = new Prisma.Decimal(0);

  for (const s of snaps) {
    if (s.resolvedAmount == null || (s.resolvedAmount as Prisma.Decimal).isZero()) continue;
    const amt = s.resolvedAmount as Prisma.Decimal;
    const src = `${s.displayName} (${s.componentCode})`;
    const requiresExpense   = componentRequiresExpense(s);
    const requiresLiability = componentRequiresLiability(s);

    if (requiresExpense && s.expenseAccountIdSnapshot) {
      addBucket(debitBuckets, s.expenseAccountIdSnapshot, amt, src);
    }
    if (requiresLiability && s.liabilityAccountIdSnapshot) {
      addBucket(creditBuckets, s.liabilityAccountIdSnapshot, amt, src);
    }

    // Cash-effect components (Cell Phone, one-time cash bonus,
    // reimbursement) increase gross already; remember to subtract
    // from residual salary expense.
    if (s.side === "EMPLOYEE" && s.cashEffect === "INCREASES_NET_PAY") {
      componentCashInGross = componentCashInGross.plus(amt);
    }
  }

  // Residual salary expense = grossPay - Σ (cash-effect component amounts).
  // This is the base-salary / hourly-earnings piece that has no
  // component snapshot.
  const residualSalaryExpense = gross.minus(componentCashInGross);

  // Now resolve every account id we'll reference (global + component)
  // to accountNumber for the journal adapter's schema.
  const componentAcctIds = new Set<string>();
  for (const id of debitBuckets.keys())  componentAcctIds.add(id);
  for (const id of creditBuckets.keys()) componentAcctIds.add(id);
  const accountIds = [
    profile.salaryExpenseAccountId, profile.employerCppExpenseAccountId, profile.employerEiExpenseAccountId,
    profile.netPayPayableAccountId, profile.cppPayableAccountId, profile.eiPayableAccountId,
    profile.federalTaxPayableAccountId, profile.provincialTaxPayableAccountId,
    ...componentAcctIds,
  ];
  const acctRows = await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, accountNumber: true },
  });
  const acctNumberById = new Map(acctRows.map((a) => [a.id, a.accountNumber]));
  const num = (id: string): string => {
    const n = acctNumberById.get(id);
    if (!n) throw new ConflictError(`Payroll GL references missing account ${id}.`);
    return n;
  };

  // Draft the journal.
  const lines: Array<{ accountNumber: string; debit?: string; credit?: string; description: string; lineNumber: number }> = [];
  let ln = 1;
  const addDebit  = (accountId: string, amount: Prisma.Decimal, description: string) => {
    if (amount.isZero()) return;
    lines.push({ lineNumber: ln++, accountNumber: num(accountId), debit: amount.toFixed(2), description });
  };
  const addCredit = (accountId: string, amount: Prisma.Decimal, description: string) => {
    if (amount.isZero()) return;
    lines.push({ lineNumber: ln++, accountNumber: num(accountId), credit: amount.toFixed(2), description });
  };
  const label = `Payroll ${batch.payGroup.code} ${batch.payPeriod.periodStart.toISOString().slice(0, 10)} → ${batch.payPeriod.payDate.toISOString().slice(0, 10)}`;

  // Statutory / global lines (always present)
  addDebit(profile.salaryExpenseAccountId,       residualSalaryExpense, `${label} — regular salary expense`);
  addDebit(profile.employerCppExpenseAccountId,  erCpp,   `${label} — employer CPP expense`);
  addDebit(profile.employerEiExpenseAccountId,   erEi,    `${label} — employer EI expense`);

  // Component debit aggregation (cash allowances + employer benefits)
  for (const [acctId, b] of debitBuckets) {
    const sources = b.sources.length <= 3 ? b.sources.join(" + ") : `${b.sources.length} components`;
    addDebit(acctId, b.total, `${label} — ${sources}`);
  }
  // Component credit aggregation (employee deductions + employer benefit payables)
  for (const [acctId, b] of creditBuckets) {
    const sources = b.sources.length <= 3 ? b.sources.join(" + ") : `${b.sources.length} components`;
    addCredit(acctId, b.total, `${label} — ${sources} payable`);
  }

  addCredit(profile.netPayPayableAccountId,      netPay,  `${label} — net pay payable`);
  addCredit(profile.cppPayableAccountId,         cppPayable, `${label} — CPP payable (ee + er)`);
  addCredit(profile.eiPayableAccountId,          eiPayable,  `${label} — EI payable (ee + er)`);
  addCredit(profile.federalTaxPayableAccountId,  fedTax,  `${label} — federal income tax payable`);
  addCredit(profile.provincialTaxPayableAccountId, provTax, `${label} — provincial income tax payable`);

  // Balance check BEFORE we call the GL — catch drift early with a
  // clear error rather than tripping the accounting layer's own guard.
  const debitTotal  = lines.reduce((s, l) => s.plus(l.debit ?? "0"), new Prisma.Decimal(0));
  const creditTotal = lines.reduce((s, l) => s.plus(l.credit ?? "0"), new Prisma.Decimal(0));
  if (!debitTotal.equals(creditTotal)) {
    throw new ConflictError(
      `Payroll GL draft does not balance (D=${debitTotal.toFixed(2)}, C=${creditTotal.toFixed(2)}, Δ=${debitTotal.minus(creditTotal).toFixed(2)}). ` +
      `Statutory column math must reconcile before posting.`,
    );
  }

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
      totalDebits: debitTotal.toFixed(2),
      totalCredits: creditTotal.toFixed(2),
    },
  });

  return {
    batch: posted,
    journalEntryId: entry.id,
    totalDebits: debitTotal.toFixed(2),
    totalCredits: creditTotal.toFixed(2),
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
