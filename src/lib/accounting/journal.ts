// Journal entry engine.
//
// Lifecycle:
//   1. createDraft(...)  -> status=DRAFT  (validation runs, but no GL impact)
//   2. approve(...)      -> status=APPROVED  (optional gate; SoD-friendly)
//   3. post(...)         -> status=POSTED   (becomes part of the GL)
//   4. void(...)         -> status=VOIDED   (pre-post only; refuse if posted)
//   5. reverse(...)      -> creates a contra JE; original -> REVERSED
//
// Validation is centralized in `validateEntry`. Posting is centralized in
// `post`. There is no other path to flip status to POSTED.
//
// Important: posted rows are immutable. There is no `update` for posted
// journals or lines. To correct a mistake: reverse + repost.

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { toMoney, sumMoney, isZero, isNegative, isPositive } from "./decimal";
import { resolvePostingPeriod } from "./periods";
import type { JournalSource } from "./types";
import { assertPostingAllowed } from "../posting-guard";
import { DEPARTMENT_CODE_ALIASES } from "./coa-template";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
export const journalLineSchema = z
  .object({
    accountNumber: z.string().trim().min(1).max(40),
    departmentCode: z.string().trim().max(40).optional().nullable(),
    costCenterCode: z.string().trim().max(40).optional().nullable(),
    debit: z.union([z.number(), z.string()]).optional(),
    credit: z.union([z.number(), z.string()]).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    memberId: z.string().optional().nullable(),
  })
  .refine(
    (l) => {
      // Exactly one of debit/credit is non-zero, and both are non-negative.
      const d = toMoney(l.debit);
      const c = toMoney(l.credit);
      if (isNegative(d) || isNegative(c)) return false;
      if (isPositive(d) && isPositive(c)) return false;
      if (isZero(d) && isZero(c)) return false;
      return true;
    },
    { message: "Each line must have exactly one positive debit or credit" }
  );

export const createJournalSchema = z.object({
  entryDate: z.string().or(z.date()),
  description: z.string().trim().min(1).max(500),
  memo: z.string().trim().max(4000).optional().nullable(),
  source: z.string().optional(),
  sourceEntityType: z.string().optional().nullable(),
  sourceEntityId: z.string().optional().nullable(),
  batchId: z.string().optional().nullable(),
  isAutoReversing: z.boolean().default(false),
  reverseOnDate: z.string().or(z.date()).optional().nullable(),
  lines: z.array(journalLineSchema).min(2),
});
export type CreateJournalInput = z.infer<typeof createJournalSchema>;

// ---------------------------------------------------------------------------
// Validation engine
// ---------------------------------------------------------------------------
export type ResolvedLine = {
  accountId: string;
  departmentId: string | null;
  costCenterId: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  description: string | null;
  memberId: string | null;
  lineNumber: number;
};

export type ValidatedJournal = {
  entryDate: Date;
  description: string;
  memo: string | null;
  source: JournalSource;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  batchId: string | null;
  isAutoReversing: boolean;
  reverseOnDate: Date | null;
  lines: ResolvedLine[];
  totalDebits: Prisma.Decimal;
  totalCredits: Prisma.Decimal;
};

export async function validateEntry(
  clubId: string,
  raw: unknown,
  opts?: { allowControlAccounts?: boolean }
): Promise<ValidatedJournal> {
  const parsed = createJournalSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const input = parsed.data;
  const entryDate = new Date(input.entryDate);
  if (Number.isNaN(entryDate.getTime())) {
    throw new ValidationError([{ path: "entryDate", message: "Invalid date" }]);
  }

  // Resolve accounts & dimensions in one query.
  const numbers = Array.from(new Set(input.lines.map((l) => l.accountNumber)));
  const accounts = await prisma.account.findMany({ where: { clubId, accountNumber: { in: numbers } } });
  const accountByNumber = new Map(accounts.map((a) => [a.accountNumber, a]));

  // Backward-compatibility for historical imports: retired department
  // codes (e.g. "FB", "COURSE", "GOLF") resolve through
  // DEPARTMENT_CODE_ALIASES to their canonical successors
  // ("F&B", "GROUNDS", "PROSHOP"). Historical journal entries and
  // batch imports carrying the old codes must still post cleanly.
  const rawDeptCodes = Array.from(new Set(input.lines.map((l) => l.departmentCode).filter((x): x is string => !!x)));
  const resolveDeptCode = (code: string): string => DEPARTMENT_CODE_ALIASES[code] ?? code;
  const canonicalDeptCodes = Array.from(new Set(rawDeptCodes.map(resolveDeptCode)));
  const departments = canonicalDeptCodes.length ? await prisma.department.findMany({ where: { clubId, code: { in: canonicalDeptCodes } } }) : [];
  const deptByCanonicalCode = new Map(departments.map((d) => [d.code, d]));

  const ccCodes = Array.from(new Set(input.lines.map((l) => l.costCenterCode).filter((x): x is string => !!x)));
  const ccs = ccCodes.length ? await prisma.costCenter.findMany({ where: { clubId, code: { in: ccCodes } } }) : [];
  const ccByCode = new Map(ccs.map((c) => [c.code, c]));

  const lines: ResolvedLine[] = [];
  const issues: Array<{ path: string; message: string }> = [];

  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    const account = accountByNumber.get(l.accountNumber);
    if (!account) {
      issues.push({ path: `lines.${i}.accountNumber`, message: `Unknown account ${l.accountNumber}` });
      continue;
    }
    if (account.isHeader) {
      issues.push({ path: `lines.${i}.accountNumber`, message: `Cannot post to header account ${l.accountNumber}` });
    }
    if (!account.isActive) {
      issues.push({ path: `lines.${i}.accountNumber`, message: `Account ${l.accountNumber} is inactive` });
    }
    if (!opts?.allowControlAccounts && account.allowManualPosting === false) {
      issues.push({ path: `lines.${i}.accountNumber`, message: `Account ${l.accountNumber} does not allow manual posting (use AR/AP adapter)` });
    }
    let departmentId: string | null = null;
    if (l.departmentCode) {
      const canonical = resolveDeptCode(l.departmentCode);
      const d = deptByCanonicalCode.get(canonical);
      if (!d) {
        // Report the caller's original code in the error so the
        // failing import can be traced, but include the resolved
        // canonical in the message when they differ.
        const suffix = canonical !== l.departmentCode ? ` (resolved to ${canonical})` : "";
        issues.push({ path: `lines.${i}.departmentCode`, message: `Unknown department ${l.departmentCode}${suffix}` });
      } else {
        departmentId = d.id;
      }
    } else if (account.defaultDepartmentId) {
      departmentId = account.defaultDepartmentId;
    }
    let costCenterId: string | null = null;
    if (l.costCenterCode) {
      const c = ccByCode.get(l.costCenterCode);
      if (!c) issues.push({ path: `lines.${i}.costCenterCode`, message: `Unknown cost center ${l.costCenterCode}` });
      else costCenterId = c.id;
    }
    lines.push({
      accountId: account?.id ?? "",
      departmentId,
      costCenterId,
      debit: toMoney(l.debit),
      credit: toMoney(l.credit),
      description: l.description ?? null,
      memberId: l.memberId ?? null,
      lineNumber: i + 1,
    });
  }

  if (issues.length) throw new ValidationError(issues, "Journal entry validation failed");

  const totalDebits = sumMoney(lines.map((l) => l.debit));
  const totalCredits = sumMoney(lines.map((l) => l.credit));
  if (!totalDebits.equals(totalCredits)) {
    throw new ValidationError(
      [{ path: "lines", message: `Out of balance: debits ${totalDebits.toString()} vs credits ${totalCredits.toString()}` }],
      "Journal entry is not balanced"
    );
  }
  if (totalDebits.isZero()) {
    throw new ValidationError([{ path: "lines", message: "Journal entry total is zero" }]);
  }

  return {
    entryDate,
    description: input.description,
    memo: input.memo ?? null,
    source: (input.source ?? "MANUAL") as JournalSource,
    sourceEntityType: input.sourceEntityType ?? null,
    sourceEntityId: input.sourceEntityId ?? null,
    batchId: input.batchId ?? null,
    isAutoReversing: input.isAutoReversing,
    reverseOnDate: input.reverseOnDate ? new Date(input.reverseOnDate) : null,
    lines,
    totalDebits,
    totalCredits,
  };
}

// ---------------------------------------------------------------------------
// Create draft
// ---------------------------------------------------------------------------
export async function createDraft(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "gl:post");
  const v = await validateEntry(clubId, raw);
  // We don't require an open period for DRAFT; validation happens at post time.
  // But we DO require a period to exist (so date errors surface early).
  const entryNumber = await nextEntryNumber(clubId);
  const periodForLookup = await resolvePostingPeriodForDraft(clubId, v.entryDate);

  const entry = await prisma.$transaction(async (tx) => {
    const entry = await tx.journalEntry.create({
      data: {
        clubId,
        entryNumber,
        batchId: v.batchId,
        entryDate: v.entryDate,
        periodId: periodForLookup.id,
        description: v.description,
        memo: v.memo,
        source: v.source,
        sourceEntityType: v.sourceEntityType,
        sourceEntityId: v.sourceEntityId,
        isAutoReversing: v.isAutoReversing,
        reverseOnDate: v.reverseOnDate,
        totalDebits: v.totalDebits,
        totalCredits: v.totalCredits,
        status: "DRAFT",
        createdByUserId: principal.id,
      },
    });
    await tx.journalEntryLine.createMany({
      data: v.lines.map((l) => ({
        clubId,
        journalEntryId: entry.id,
        lineNumber: l.lineNumber,
        accountId: l.accountId,
        departmentId: l.departmentId,
        costCenterId: l.costCenterId,
        debit: l.debit,
        credit: l.credit,
        description: l.description,
        memberId: l.memberId,
      })),
    });
    return entry;
  });

  await audit(principal, {
    action: "gl.journal.draft",
    entityType: "JournalEntry",
    entityId: entry.id,
    clubId,
    after: { entryNumber: entry.entryNumber, totalDebits: v.totalDebits.toString(), source: v.source },
  });
  return entry;
}

// Same as resolvePostingPeriod but allows locked periods at draft creation —
// only post-time should hard-block the lock.
async function resolvePostingPeriodForDraft(clubId: string, when: Date) {
  const period = await prisma.fiscalPeriod.findFirst({
    where: { clubId, startDate: { lte: when }, endDate: { gte: when } },
  });
  if (!period) throw new ConflictError(`No fiscal period covers ${when.toISOString().slice(0, 10)}`);
  return period;
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------
export async function approve(principal: Principal, journalId: string) {
  const entry = await prisma.journalEntry.findUnique({ where: { id: journalId } });
  assertTenantOwned(entry, principal);
  requirePermission(principal, entry.clubId, "gl:post");
  if (entry.status !== "DRAFT") throw new ConflictError(`Cannot approve from ${entry.status}`);
  const updated = await prisma.journalEntry.update({
    where: { id: journalId },
    data: { status: "APPROVED", approvedAt: new Date(), approvedByUserId: principal.id },
  });
  await audit(principal, {
    action: "gl.journal.approve", entityType: "JournalEntry", entityId: journalId,
    clubId: entry.clubId, before: { status: entry.status }, after: { status: "APPROVED" },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Post — the only way to flip a JE to POSTED.
// ---------------------------------------------------------------------------
export async function post(principal: Principal, journalId: string, opts?: { allowSoftLockOverride?: boolean }) {
  const entry = await prisma.journalEntry.findUnique({
    where: { id: journalId },
    include: { lines: true },
  });
  assertTenantOwned(entry, principal);
  requirePermission(principal, entry.clubId, "gl:post");
  await assertPostingAllowed(principal, entry.clubId, "gl.journal.post", "JournalEntry", journalId);
  if (entry.status === "POSTED") return entry;
  if (entry.status !== "DRAFT" && entry.status !== "APPROVED") {
    throw new ConflictError(`Cannot post from ${entry.status}`);
  }

  // Re-verify balance defensively. Posted rows must be balanced even if a
  // line was mutated before approval — which is forbidden but cheap to check.
  const debits = sumMoney(entry.lines.map((l) => l.debit as unknown as Prisma.Decimal));
  const credits = sumMoney(entry.lines.map((l) => l.credit as unknown as Prisma.Decimal));
  if (!debits.equals(credits)) {
    throw new ConflictError(`Journal ${entry.entryNumber} no longer balanced; cannot post`);
  }

  // Period gate.
  await resolvePostingPeriod(principal, entry.clubId, entry.entryDate, { allowSoftLockOverride: opts?.allowSoftLockOverride });

  const updated = await prisma.journalEntry.update({
    where: { id: journalId },
    data: { status: "POSTED", postedAt: new Date(), postedByUserId: principal.id, totalDebits: debits, totalCredits: credits },
  });
  await audit(principal, {
    action: "gl.journal.post",
    entityType: "JournalEntry", entityId: journalId, clubId: entry.clubId,
    before: { status: entry.status }, after: { status: "POSTED", totalDebits: debits.toString() },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Void (pre-post only)
// ---------------------------------------------------------------------------
export async function voidDraft(principal: Principal, journalId: string, reason: string) {
  const entry = await prisma.journalEntry.findUnique({ where: { id: journalId } });
  assertTenantOwned(entry, principal);
  requirePermission(principal, entry.clubId, "gl:post");
  await assertPostingAllowed(principal, entry.clubId, "gl.journal.void", "JournalEntry", journalId);
  if (entry.status === "POSTED") {
    throw new ConflictError("Posted entries cannot be voided. Use reverse instead.");
  }
  if (entry.status === "VOIDED" || entry.status === "REVERSED") {
    throw new ConflictError(`Entry is already ${entry.status}`);
  }
  const updated = await prisma.journalEntry.update({
    where: { id: journalId },
    data: { status: "VOIDED", voidedAt: new Date(), voidedByUserId: principal.id, voidReason: reason },
  });
  await audit(principal, {
    action: "gl.journal.void",
    entityType: "JournalEntry", entityId: journalId, clubId: entry.clubId,
    before: { status: entry.status }, after: { status: "VOIDED" }, meta: { reason },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Reverse (post-only)
// ---------------------------------------------------------------------------
export async function reverse(principal: Principal, journalId: string, opts: { reverseDate?: Date; reason: string }) {
  const entry = await prisma.journalEntry.findUnique({
    where: { id: journalId },
    include: { lines: { include: { account: true } } },
  });
  assertTenantOwned(entry, principal);
  requirePermission(principal, entry.clubId, "gl:reverse");
  await assertPostingAllowed(principal, entry.clubId, "gl.journal.reverse", "JournalEntry", journalId);
  if (entry.status !== "POSTED") throw new ConflictError(`Only POSTED entries can be reversed (was ${entry.status})`);
  if (entry.reversesId) throw new ConflictError("Refusing to reverse a reversing entry");

  const reverseDate = opts.reverseDate ?? new Date();
  const period = await resolvePostingPeriod(principal, entry.clubId, reverseDate, { allowSoftLockOverride: true });

  const contraEntryNumber = await nextEntryNumber(entry.clubId);
  const contra = await prisma.$transaction(async (tx) => {
    const contra = await tx.journalEntry.create({
      data: {
        clubId: entry.clubId,
        entryNumber: contraEntryNumber,
        entryDate: reverseDate,
        periodId: period.id,
        description: `Reversal of ${entry.entryNumber}: ${entry.description}`,
        memo: opts.reason,
        source: "SYSTEM_REVERSAL",
        sourceEntityType: "JournalEntry",
        sourceEntityId: entry.id,
        reversesId: entry.id,
        status: "POSTED",
        totalDebits: entry.totalCredits, // swap
        totalCredits: entry.totalDebits,
        postedAt: new Date(),
        postedByUserId: principal.id,
        createdByUserId: principal.id,
      },
    });
    await tx.journalEntryLine.createMany({
      data: entry.lines.map((l) => ({
        clubId: entry.clubId,
        journalEntryId: contra.id,
        lineNumber: l.lineNumber,
        accountId: l.accountId,
        departmentId: l.departmentId,
        costCenterId: l.costCenterId,
        debit: l.credit, // swap
        credit: l.debit,
        description: l.description ? `Reversal: ${l.description}` : null,
        memberId: l.memberId,
      })),
    });
    // The original entry stays POSTED — both rows hit the books and net to
    // zero. The "this entry was reversed" semantic is encoded by the contra
    // entry's `reversesId` (and Prisma's reverse relation, available on the
    // original as `reversedBy`). Excluding the original from balances would
    // double-count the reversal.
    return contra;
  });

  await audit(principal, {
    action: "gl.journal.reverse",
    entityType: "JournalEntry", entityId: entry.id, clubId: entry.clubId,
    before: { status: "POSTED" }, after: { status: "POSTED", reversedByContraId: contra.id },
    meta: { reason: opts.reason },
  });
  return contra;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function listJournals(principal: Principal, clubId: string, opts?: { status?: string; from?: Date; to?: Date; limit?: number }) {
  return prisma.journalEntry.findMany({
    where: {
      ...tenantWhere(principal, clubId),
      ...(opts?.status ? { status: opts.status } : {}),
      ...(opts?.from || opts?.to
        ? { entryDate: { ...(opts?.from ? { gte: opts.from } : {}), ...(opts?.to ? { lte: opts.to } : {}) } }
        : {}),
    },
    orderBy: { entryDate: "desc" },
    take: opts?.limit ?? 100,
    include: { period: true },
  });
}

export async function getJournal(principal: Principal, journalId: string) {
  const entry = await prisma.journalEntry.findUnique({
    where: { id: journalId },
    include: {
      lines: { include: { account: true, department: true, costCenter: true }, orderBy: { lineNumber: "asc" } },
      period: true,
      reverses: true,
      reversedBy: true,
      attachments: true,
    },
  });
  if (!entry) throw new NotFoundError("JournalEntry", journalId);
  if (!hasPermission(principal, entry.clubId, "gl:read")) throw new NotFoundError("JournalEntry", journalId);
  assertTenantOwned(entry, principal);
  return entry;
}

// ---------------------------------------------------------------------------
// Adapter helper — create a POSTED entry in one transaction.
// Used by AR/AP/payroll system adapters. Bypasses the manual-posting
// restriction on control accounts and posts through soft-locked periods.
// ---------------------------------------------------------------------------
export async function createPostedFromAdapter(
  principal: Principal,
  clubId: string,
  raw: unknown,
  meta: { source: JournalSource; sourceEntityType: string; sourceEntityId: string }
) {
  await assertPostingAllowed(principal, clubId, `gl.adapter.${meta.source}`, meta.sourceEntityType, meta.sourceEntityId);
  const v = await validateEntry(clubId, raw, { allowControlAccounts: true });
  const period = await resolvePostingPeriod(principal, clubId, v.entryDate, { allowSoftLockOverride: true });
  const entry = await prisma.$transaction(async (tx) => {
    const entryNumber = await nextEntryNumberTx(tx, clubId);
    const e = await tx.journalEntry.create({
      data: {
        clubId,
        entryNumber,
        entryDate: v.entryDate,
        periodId: period.id,
        description: v.description,
        memo: v.memo,
        source: meta.source,
        sourceEntityType: meta.sourceEntityType,
        sourceEntityId: meta.sourceEntityId,
        totalDebits: v.totalDebits,
        totalCredits: v.totalCredits,
        status: "POSTED",
        postedAt: new Date(),
        postedByUserId: principal.id,
        createdByUserId: principal.id,
      },
    });
    await tx.journalEntryLine.createMany({
      data: v.lines.map((l) => ({
        clubId,
        journalEntryId: e.id,
        lineNumber: l.lineNumber,
        accountId: l.accountId,
        departmentId: l.departmentId,
        costCenterId: l.costCenterId,
        debit: l.debit,
        credit: l.credit,
        description: l.description,
        memberId: l.memberId,
      })),
    });
    return e;
  });
  await audit(principal, {
    action: `gl.adapter.${meta.source.toLowerCase()}`,
    entityType: "JournalEntry", entityId: entry.id, clubId,
    meta: { entryNumber: entry.entryNumber, sourceEntityType: meta.sourceEntityType, sourceEntityId: meta.sourceEntityId, total: v.totalDebits.toString() },
  });
  return entry;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function nextEntryNumber(clubId: string): Promise<string> {
  return nextEntryNumberTx(prisma, clubId);
}
export type AnyTx = Prisma.TransactionClient | typeof prisma;
export async function nextEntryNumberTx(tx: AnyTx, clubId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await tx.journalEntry.count({
    where: { clubId, createdAt: { gte: new Date(year, 0, 1) } },
  });
  return `JE-${year}-${(count + 1).toString().padStart(6, "0")}`;
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
