// Phase 13C — Accounting opening balance setup.
//
// State machine:
//   DRAFT  → editable; balances must net to zero before posting.
//   POSTED → opening JournalEntry was created; balance lines are now
//            reflected in the GL. Edits create reversals only.
//   LOCKED → period is closed for the opening year; no further edits.
//
// Implementation rules:
//   - Debits == Credits enforced before POST.
//   - Subledger reconciliation: if arSubledger is supplied, sum(member balances)
//     must equal the debit on the AR control account; same for AP.
//   - The opening JournalEntry is marked source="OPENING_BALANCE" so it's
//     unambiguous in the GL.
//   - LOCK can only be set after POST; LOCK is one-way (controller override
//     required to unlock — not implemented here, deliberately).

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { isSuperAdmin, requirePermission, type Principal } from "../rbac";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPostingAllowed } from "../posting-guard";

type BalanceLine = { accountId: string; debit: number; credit: number; description?: string };
type Subledger = { entityId: string; balance: number };

function ensureController(principal: Principal, clubId: string) {
  if (isSuperAdmin(principal)) return;
  // Only CONTROLLER / CLUB_ADMIN should drive opening balances.
  requirePermission(principal, clubId, "gl:post");
}

function dec(n: number): Prisma.Decimal { return new Prisma.Decimal(n.toFixed(2)); }

// ---------------------------------------------------------------------------
// Create / update draft
// ---------------------------------------------------------------------------
export const setSchema = z.object({
  clubId: z.string(),
  label: z.string().min(1).max(160),
  fiscalYearId: z.string().optional(),
  balanceLines: z.array(z.object({
    accountId: z.string(),
    debit: z.number().min(0).default(0),
    credit: z.number().min(0).default(0),
    description: z.string().max(200).optional(),
  })).min(1),
  arSubledger: z.array(z.object({ entityId: z.string(), balance: z.number() })).optional(),
  apSubledger: z.array(z.object({ entityId: z.string(), balance: z.number() })).optional(),
});

export async function upsertSet(principal: Principal, raw: unknown) {
  const parsed = setSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  ensureController(principal, parsed.data.clubId);
  const totals = parsed.data.balanceLines.reduce((acc, l) => ({ d: acc.d + l.debit, c: acc.c + l.credit }), { d: 0, c: 0 });

  const set = await prisma.openingBalanceSet.upsert({
    where: { clubId_label: { clubId: parsed.data.clubId, label: parsed.data.label } },
    create: {
      clubId: parsed.data.clubId, label: parsed.data.label,
      fiscalYearId: parsed.data.fiscalYearId ?? null,
      balanceJson: JSON.stringify(parsed.data.balanceLines),
      arSubledgerJson: parsed.data.arSubledger ? JSON.stringify(parsed.data.arSubledger) : null,
      apSubledgerJson: parsed.data.apSubledger ? JSON.stringify(parsed.data.apSubledger) : null,
      totalDebits: dec(totals.d), totalCredits: dec(totals.c),
      createdByUserId: principal.id,
    },
    update: {
      balanceJson: JSON.stringify(parsed.data.balanceLines),
      arSubledgerJson: parsed.data.arSubledger ? JSON.stringify(parsed.data.arSubledger) : null,
      apSubledgerJson: parsed.data.apSubledger ? JSON.stringify(parsed.data.apSubledger) : null,
      totalDebits: dec(totals.d), totalCredits: dec(totals.c),
      fiscalYearId: parsed.data.fiscalYearId ?? null,
    },
  });
  if (set.status === "POSTED" || set.status === "LOCKED") {
    throw new ConflictError("Cannot edit an opening balance set after POST. Reverse and re-create.");
  }
  await audit(principal, { action: "opening_balance.upsert", entityType: "OpeningBalanceSet", entityId: set.id, clubId: parsed.data.clubId, after: { totalDebits: totals.d, totalCredits: totals.c } });
  return set;
}

// ---------------------------------------------------------------------------
// Validation: balances + subledger reconciliation
// ---------------------------------------------------------------------------
export async function validateSet(setId: string) {
  const set = await prisma.openingBalanceSet.findUnique({ where: { id: setId } });
  if (!set) throw new NotFoundError("OpeningBalanceSet", setId);
  const lines: BalanceLine[] = JSON.parse(set.balanceJson);
  const errors: Array<{ code: string; message: string }> = [];
  const totalD = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const totalC = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  const diff = Math.abs(totalD - totalC);
  if (diff > 0.005) errors.push({ code: "UNBALANCED", message: `Debits (${totalD.toFixed(2)}) ≠ Credits (${totalC.toFixed(2)})` });

  // Subledger reconciliation.
  if (set.arSubledgerJson) {
    const ar: Subledger[] = JSON.parse(set.arSubledgerJson);
    const subTotal = ar.reduce((s, r) => s + r.balance, 0);
    // Find AR control account: any line where the account is flagged as control + type ASSET.
    const arControlLines = await prisma.account.findMany({
      where: { clubId: set.clubId, isControlAccount: true, type: "ASSET" },
    });
    const controlIds = new Set(arControlLines.map((a) => a.id));
    const arBalance = lines.filter((l) => controlIds.has(l.accountId)).reduce((s, l) => s + (l.debit - l.credit), 0);
    if (Math.abs(subTotal - arBalance) > 0.005) {
      errors.push({ code: "AR_RECON", message: `AR subledger (${subTotal.toFixed(2)}) does not reconcile to AR control (${arBalance.toFixed(2)})` });
    }
  }
  if (set.apSubledgerJson) {
    const ap: Subledger[] = JSON.parse(set.apSubledgerJson);
    const subTotal = ap.reduce((s, r) => s + r.balance, 0);
    const apControlLines = await prisma.account.findMany({
      where: { clubId: set.clubId, isControlAccount: true, type: "LIABILITY" },
    });
    const controlIds = new Set(apControlLines.map((a) => a.id));
    const apBalance = lines.filter((l) => controlIds.has(l.accountId)).reduce((s, l) => s + (l.credit - l.debit), 0);
    if (Math.abs(subTotal - apBalance) > 0.005) {
      errors.push({ code: "AP_RECON", message: `AP subledger (${subTotal.toFixed(2)}) does not reconcile to AP control (${apBalance.toFixed(2)})` });
    }
  }
  return { ok: errors.length === 0, errors, totalDebits: totalD, totalCredits: totalC };
}

// ---------------------------------------------------------------------------
// Post — write the opening journal entry
// ---------------------------------------------------------------------------
export async function postSet(principal: Principal, setId: string, periodId: string) {
  const set = await prisma.openingBalanceSet.findUnique({ where: { id: setId } });
  if (!set) throw new NotFoundError("OpeningBalanceSet", setId);
  ensureController(principal, set.clubId);
  await assertPostingAllowed(principal, set.clubId, "opening_balance.post", "OpeningBalanceSet", setId);
  if (set.status !== "DRAFT") throw new ConflictError(`Cannot post a set in status ${set.status}`);
  const result = await validateSet(setId);
  if (!result.ok) throw new ConflictError(`Opening balances invalid: ${result.errors.map((e) => e.message).join("; ")}`);
  const lines: BalanceLine[] = JSON.parse(set.balanceJson);
  const period = await prisma.fiscalPeriod.findUnique({ where: { id: periodId } });
  if (!period || period.clubId !== set.clubId) throw new NotFoundError("FiscalPeriod", periodId);
  if (period.status === "LOCKED" || period.status === "CLOSED") throw new ConflictError(`Period is ${period.status}; cannot post opening balances`);

  const entryNumber = `OB-${Date.now().toString(36).toUpperCase()}`;
  const journal = await prisma.$transaction(async (tx) => {
    const je = await tx.journalEntry.create({
      data: {
        clubId: set.clubId, entryNumber, entryDate: period.startDate,
        periodId, description: `Opening balances — ${set.label}`,
        source: "OPENING_BALANCE", status: "POSTED",
        postedAt: new Date(), postedByUserId: principal.id,
        totalDebits: dec(result.totalDebits), totalCredits: dec(result.totalCredits),
        createdByUserId: principal.id,
      },
    });
    let lineNumber = 1;
    for (const l of lines) {
      if ((l.debit ?? 0) === 0 && (l.credit ?? 0) === 0) continue;
      await tx.journalEntryLine.create({
        data: {
          clubId: set.clubId, journalEntryId: je.id, lineNumber: lineNumber++,
          accountId: l.accountId,
          debit: dec(l.debit ?? 0), credit: dec(l.credit ?? 0),
          description: l.description ?? "Opening balance",
        },
      });
    }
    await tx.openingBalanceSet.update({
      where: { id: set.id },
      data: { status: "POSTED", journalEntryId: je.id, postedAt: new Date(), postedByUserId: principal.id },
    });
    return je;
  });
  await audit(principal, { action: "opening_balance.post", entityType: "OpeningBalanceSet", entityId: set.id, clubId: set.clubId, after: { journalEntryId: journal.id } });
  return journal;
}

// ---------------------------------------------------------------------------
// Lock — one-way. After this, edits require a reversal + re-post.
// ---------------------------------------------------------------------------
export async function lockSet(principal: Principal, setId: string) {
  const set = await prisma.openingBalanceSet.findUnique({ where: { id: setId } });
  if (!set) throw new NotFoundError("OpeningBalanceSet", setId);
  ensureController(principal, set.clubId);
  if (set.status !== "POSTED") throw new ConflictError("Only POSTED sets can be locked");
  const updated = await prisma.openingBalanceSet.update({
    where: { id: set.id },
    data: { status: "LOCKED", lockedAt: new Date(), lockedByUserId: principal.id },
  });
  await audit(principal, { action: "opening_balance.lock", entityType: "OpeningBalanceSet", entityId: set.id, clubId: set.clubId });
  return updated;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------
export async function listSets(principal: Principal, clubId: string) {
  ensureController(principal, clubId);
  return prisma.openingBalanceSet.findMany({ where: { clubId }, orderBy: { createdAt: "desc" } });
}

export async function getSet(principal: Principal, setId: string) {
  const set = await prisma.openingBalanceSet.findUnique({ where: { id: setId } });
  if (!set) throw new NotFoundError("OpeningBalanceSet", setId);
  ensureController(principal, set.clubId);
  return set;
}

// ---------------------------------------------------------------------------
// Phase 14E — Subledger upload helpers.
//
// Each helper accepts CSV-parsed rows, normalizes them into a Subledger[]
// array, persists it on the set, and re-runs validation so the UI can show
// a reconciliation difference immediately.
// ---------------------------------------------------------------------------
export const subledgerUploadSchema = z.object({
  setId: z.string(),
  kind: z.enum(["AR", "AP"]),
  rows: z.array(z.object({
    entityRef: z.string().min(1),  // memberNumber for AR; vendorNumber/legalName for AP
    balance: z.number(),
    note: z.string().optional(),
  })).min(1).max(20000),
});

export async function uploadSubledger(principal: Principal, raw: unknown) {
  const parsed = subledgerUploadSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const set = await prisma.openingBalanceSet.findUnique({ where: { id: parsed.data.setId } });
  if (!set) throw new NotFoundError("OpeningBalanceSet", parsed.data.setId);
  ensureController(principal, set.clubId);
  if (set.status !== "DRAFT") throw new ConflictError(`Cannot edit subledger on a ${set.status} set`);

  // Resolve refs to entity ids so the persisted JSON is stable across renames.
  const resolved: Array<{ entityId: string; balance: number }> = [];
  const errors: Array<{ entityRef: string; message: string }> = [];
  if (parsed.data.kind === "AR") {
    for (const row of parsed.data.rows) {
      const member = await prisma.member.findFirst({ where: { clubId: set.clubId, memberNumber: row.entityRef } });
      if (!member) { errors.push({ entityRef: row.entityRef, message: `Member ${row.entityRef} not found` }); continue; }
      resolved.push({ entityId: member.id, balance: row.balance });
    }
  } else {
    for (const row of parsed.data.rows) {
      const vendor = await prisma.vendor.findFirst({
        where: { clubId: set.clubId, OR: [{ vendorNumber: row.entityRef }, { legalName: row.entityRef }] },
      });
      if (!vendor) { errors.push({ entityRef: row.entityRef, message: `Vendor ${row.entityRef} not found` }); continue; }
      resolved.push({ entityId: vendor.id, balance: row.balance });
    }
  }

  const field = parsed.data.kind === "AR" ? "arSubledgerJson" : "apSubledgerJson";
  await prisma.openingBalanceSet.update({
    where: { id: set.id },
    data: { [field]: JSON.stringify(resolved) },
  });
  await audit(principal, {
    action: parsed.data.kind === "AR" ? "opening_balance.subledger.ar" : "opening_balance.subledger.ap",
    entityType: "OpeningBalanceSet",
    entityId: set.id,
    clubId: set.clubId,
    after: { rows: resolved.length, errors: errors.length },
  });
  const reconciliation = await validateSet(set.id);
  return { resolved, errors, reconciliation };
}

// Convenience inspection for the UI.
export async function subledgerSummary(principal: Principal, setId: string) {
  const set = await prisma.openingBalanceSet.findUnique({ where: { id: setId } });
  if (!set) throw new NotFoundError("OpeningBalanceSet", setId);
  ensureController(principal, set.clubId);
  const ar = set.arSubledgerJson ? (JSON.parse(set.arSubledgerJson) as Subledger[]) : [];
  const ap = set.apSubledgerJson ? (JSON.parse(set.apSubledgerJson) as Subledger[]) : [];
  return {
    ar: { count: ar.length, total: ar.reduce((s, r) => s + r.balance, 0) },
    ap: { count: ap.length, total: ap.reduce((s, r) => s + r.balance, 0) },
    validation: await validateSet(set.id),
  };
}
