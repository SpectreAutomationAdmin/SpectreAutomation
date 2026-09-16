// Payroll Admin Slice 3F (2026-09-13) — payroll journal preview.
//
// Reuses the SAME statutory + component aggregation and the SAME
// account-mapping resolution logic that `postPayrollBatch` uses at
// commit time — extracted here as a PURE READ-SIDE function. The
// preview and the actual post are guaranteed to produce the same
// journal lines because they consume the identical persisted
// PayrollBatchEmployee + PayrollBatchComponentSnapshot rows and the
// same `PayrollGlAccountingProfile`.
//
// Refuses under the same conditions as post: readiness blockers,
// missing profile, empty batch, wrong lifecycle status.
//
// This service NEVER writes. It never opens a transaction. It is
// safe to call from the Payroll Admin's Post confirmation UI.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError, NotFoundError } from "../errors";
import { assertTenantOwned } from "../services/tenant";
import { resolvePayrollJournal } from "./payroll-gl-resolver";
import { loadPayrollGlInputs } from "./payroll-gl-inputs";

const PAYROLL_ENTITY = "PayrollBatch";

export interface PayrollJournalPreviewLine {
  lineNumber: number;
  accountNumber: string;
  accountName: string;
  // Phase 3 follow-up (2026-09-16) — department dimension on the
  // line. Null for centralized liability lines. Renders as an
  // additional column so the Controller can see per-department
  // attribution at a glance before posting.
  departmentCode: string | null;
  departmentName: string | null;
  debit: string | null;
  credit: string | null;
  description: string;
}

export interface PayrollJournalPreviewResult {
  batchId: string;
  status: string;
  calculationVersion: number;
  approvedAt: string | null;
  approvedByUserId: string | null;
  submittedByUserId: string | null;
  payDate: string | null;
  entryDate: string;
  memo: string;
  description: string;
  lines: PayrollJournalPreviewLine[];
  totalDebits: string;
  totalCredits: string;
  balanced: boolean;
  differenceCents: number;
  readinessBlockers: Array<{ code: string; message: string }>;
}

/** Build a canonical journal preview for a payroll batch. Refuses
 *  when readiness gates fail; those failures are the same ones that
 *  would refuse a real Post. */
export async function previewPayrollJournal(
  principal: Principal,
  clubId: string,
  batchId: string,
): Promise<PayrollJournalPreviewResult> {
  requirePermission(principal, clubId, "payroll:read");

  const batch = await prisma.payrollBatch.findFirst({
    where: { id: batchId, clubId },
    include: { payGroup: true, payPeriod: true },
  });
  if (!batch) throw new NotFoundError(PAYROLL_ENTITY, batchId);
  assertTenantOwned(batch, principal);
  if (batch.status !== "APPROVED" && batch.status !== "POSTED") {
    throw new ConflictError(
      `Payroll journal preview requires APPROVED (or POSTED) batch; current status is ${batch.status}.`,
    );
  }

  // GL readiness check — reuse the exact same validator the real Post
  // uses.
  const { evaluatePayrollGlReadiness } = await import("./gl-readiness");
  const readiness = await evaluatePayrollGlReadiness(principal, clubId, batchId);

  // Phase 3 (2026-09-15) — load resolver inputs through the shared
  // input assembler so preview + posting see identical facts.
  const inputs = await loadPayrollGlInputs(clubId, batchId);
  const profile = inputs.profile;
  if (!profile) {
    return {
      batchId, status: batch.status,
      calculationVersion: batch.calculationVersion,
      approvedAt: batch.approvedAt?.toISOString() ?? null,
      approvedByUserId: batch.approvedByUserId ?? null,
      submittedByUserId: batch.submittedByUserId ?? null,
      payDate: batch.payPeriod.payDate.toISOString() ?? null,
      entryDate: batch.payPeriod.payDate.toISOString(),
      memo: "",
      description: "",
      lines: [],
      totalDebits: "0.00", totalCredits: "0.00",
      balanced: true, differenceCents: 0,
      readinessBlockers: [{
        code: "PAYROLL_GL_PROFILE_MISSING",
        message: "This Club has no PayrollGlAccountingProfile configured.",
      }],
    };
  }
  if (!readiness.ready) {
    return {
      batchId, status: batch.status,
      calculationVersion: batch.calculationVersion,
      approvedAt: batch.approvedAt?.toISOString() ?? null,
      approvedByUserId: batch.approvedByUserId ?? null,
      submittedByUserId: batch.submittedByUserId ?? null,
      payDate: batch.payPeriod.payDate.toISOString() ?? null,
      entryDate: batch.payPeriod.payDate.toISOString(),
      memo: "",
      description: "",
      lines: [],
      totalDebits: "0.00", totalCredits: "0.00",
      balanced: true, differenceCents: 0,
      readinessBlockers: readiness.blockers.map((b) => ({
        code: b.code,
        message: (b as { message?: string }).message ?? `Readiness blocker: ${b.code}`,
      })),
    };
  }

  const label = `Payroll ${batch.payGroup.code} ${batch.payPeriod.periodStart.toISOString().slice(0, 10)} → ${batch.payPeriod.payDate.toISOString().slice(0, 10)}`;

  // Phase 3 follow-up (2026-09-16) — resolve journal through the
  // shared resolver. Emits one line per (accountId, departmentId)
  // pair; the department dimension is populated on
  // JournalEntryLine.departmentId at post time.
  const resolved = resolvePayrollJournal({
    label,
    profile,
    employees: inputs.employees,
    components: inputs.components,
  });

  const uniqueAccountIds = Array.from(new Set(resolved.lines.map((l) => l.accountId)));
  const uniqueDeptIds = Array.from(new Set(
    resolved.lines.map((l) => l.departmentId).filter((v): v is string => v != null),
  ));
  const [acctRows, deptRows] = await Promise.all([
    prisma.account.findMany({
      where: { id: { in: uniqueAccountIds } },
      select: { id: true, accountNumber: true, name: true },
    }),
    uniqueDeptIds.length > 0
      ? prisma.department.findMany({
          where: { id: { in: uniqueDeptIds }, clubId },
          select: { id: true, code: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const acctById = new Map(acctRows.map((a) => [a.id, a]));
  const deptById = new Map(deptRows.map((d) => [d.id, d]));
  const num  = (id: string): string => acctById.get(id)?.accountNumber ?? `?${id}`;
  const name = (id: string): string => acctById.get(id)?.name ?? "(unknown)";

  const lines: PayrollJournalPreviewLine[] = resolved.lines.map((l, idx) => ({
    lineNumber: idx + 1,
    accountNumber: num(l.accountId),
    accountName: name(l.accountId),
    departmentCode: l.departmentId ? (deptById.get(l.departmentId)?.code ?? null) : null,
    departmentName: l.departmentId ? (deptById.get(l.departmentId)?.name ?? null) : null,
    debit: l.debit != null ? l.debit.toFixed(2) : null,
    credit: l.credit != null ? l.credit.toFixed(2) : null,
    description: l.description,
  }));

  const debitTotal  = resolved.totalDebits;
  const creditTotal = resolved.totalCredits;
  const diffCents = Math.round(Number(debitTotal.minus(creditTotal).toFixed(2)) * 100);

  return {
    batchId, status: batch.status,
    calculationVersion: batch.calculationVersion,
    approvedAt: batch.approvedAt?.toISOString() ?? null,
    approvedByUserId: batch.approvedByUserId ?? null,
    submittedByUserId: batch.submittedByUserId ?? null,
    payDate: batch.payPeriod.payDate.toISOString(),
    entryDate: batch.payPeriod.payDate.toISOString(),
    memo: `Auto-generated from PayrollBatch ${batch.id}`,
    description: `${label} — Payroll batch ${batch.id.slice(-8)}`,
    lines,
    totalDebits: debitTotal.toFixed(2),
    totalCredits: creditTotal.toFixed(2),
    balanced: diffCents === 0,
    differenceCents: diffCents,
    readinessBlockers: [],
  };
}
