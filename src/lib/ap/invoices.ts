// AP invoice service.
//
// Lifecycle:
//   DRAFT → PENDING_APPROVAL → APPROVED → POSTED → PARTIALLY_PAID → PAID
//                                              \→ VOIDED  (post-only; via reverse)
//                                              \→ DISPUTED
//
// Validation enforces:
//   - vendor exists and is not BLOCKED
//   - sum(line.amount) === subtotal
//   - sum(line.taxAmount) === taxTotal
//   - subtotal + taxTotal === total
//   - non-zero positive total
//   - vendorReference (when present) is unique per vendor (duplicate detect)
//
// Posting goes through the GL adapter (see ap-events.ts).

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { tenantWhere, assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { toMoney, sumMoney, isNegative, ZERO } from "../accounting/decimal";
import { submitForApproval, getRequestForEntity, isApproved } from "./approvals";
import { postInvoiceToGl, postInvoiceReversalToGl } from "./ap-events";
import { detectInvoiceExceptions } from "./exceptions";
import { assertPostingAllowed } from "../posting-guard";

const lineSchema = z.object({
  expenseAccountNumber: z.string().trim().min(1).max(40),
  departmentCode: z.string().trim().max(40).optional().nullable(),
  costCenterCode: z.string().trim().max(40).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
  quantity: z.union([z.number(), z.string()]).optional(),
  unitCost: z.union([z.number(), z.string()]).optional(),
  amount: z.union([z.number(), z.string()]),
  taxCodeKey: z.string().trim().max(40).optional().nullable(),
  taxAmount: z.union([z.number(), z.string()]).default(0),
  isCapital: z.boolean().default(false),
  isInventory: z.boolean().default(false),
});

export const invoiceCreateSchema = z.object({
  vendorId: z.string().min(1),
  vendorReference: z.string().trim().max(80).optional().nullable(),
  invoiceDate: z.string().or(z.date()),
  dueDate: z.string().or(z.date()).optional().nullable(),
  terms: z.string().trim().max(80).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
  departmentCode: z.string().trim().max(40).optional().nullable(),
  currency: z.string().trim().max(8).default("CAD"),
  lines: z.array(lineSchema).min(1),
  captureId: z.string().optional().nullable(),
});
export type InvoiceCreateInput = z.infer<typeof invoiceCreateSchema>;

async function nextInvoiceNumber(clubId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.aPInvoice.count({
    where: { clubId, createdAt: { gte: new Date(year, 0, 1) } },
  });
  return `APINV-${year}-${(count + 1).toString().padStart(6, "0")}`;
}

// Resolve line metadata (accounts, departments, tax codes) and compute totals
// using Decimal math. Returns a normalized internal payload + totals.
export async function validateAndResolveInvoice(clubId: string, input: InvoiceCreateInput) {
  // Resolve dimensions in batch.
  const lineAccountNumbers = Array.from(new Set(input.lines.map((l) => l.expenseAccountNumber)));
  const accounts = await prisma.account.findMany({
    where: { clubId, accountNumber: { in: lineAccountNumbers } },
  });
  const accountByNumber = new Map(accounts.map((a) => [a.accountNumber, a]));

  const deptCodes = Array.from(new Set([
    ...(input.departmentCode ? [input.departmentCode] : []),
    ...input.lines.map((l) => l.departmentCode).filter((x): x is string => !!x),
  ]));
  const departments = deptCodes.length
    ? await prisma.department.findMany({ where: { clubId, code: { in: deptCodes } } })
    : [];
  const deptByCode = new Map(departments.map((d) => [d.code, d]));

  const ccCodes = Array.from(new Set(input.lines.map((l) => l.costCenterCode).filter((x): x is string => !!x)));
  const ccs = ccCodes.length ? await prisma.costCenter.findMany({ where: { clubId, code: { in: ccCodes } } }) : [];
  const ccByCode = new Map(ccs.map((c) => [c.code, c]));

  const taxCodeKeys = Array.from(new Set(input.lines.map((l) => l.taxCodeKey).filter((x): x is string => !!x)));
  const taxCodes = taxCodeKeys.length
    ? await prisma.taxCode.findMany({ where: { clubId, key: { in: taxCodeKeys } } })
    : [];
  const taxByKey = new Map(taxCodes.map((t) => [t.key, t]));

  const issues: Array<{ path: string; message: string }> = [];
  const resolvedLines: Array<{
    lineNumber: number;
    accountId: string;
    departmentId: string | null;
    costCenterId: string | null;
    description: string | null;
    quantity: Prisma.Decimal | null;
    unitCost: Prisma.Decimal | null;
    amount: Prisma.Decimal;
    taxCodeId: string | null;
    taxAmount: Prisma.Decimal;
    isCapital: boolean;
    isInventory: boolean;
  }> = [];

  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    const account = accountByNumber.get(l.expenseAccountNumber);
    if (!account) {
      issues.push({ path: `lines.${i}.expenseAccountNumber`, message: `Unknown account ${l.expenseAccountNumber}` });
      continue;
    }
    if (account.isHeader) {
      issues.push({ path: `lines.${i}.expenseAccountNumber`, message: `Cannot post to header account ${l.expenseAccountNumber}` });
    }
    if (!account.isActive) {
      issues.push({ path: `lines.${i}.expenseAccountNumber`, message: `Account ${l.expenseAccountNumber} is inactive` });
    }
    let departmentId: string | null = null;
    if (l.departmentCode) {
      const d = deptByCode.get(l.departmentCode);
      if (!d) issues.push({ path: `lines.${i}.departmentCode`, message: `Unknown department ${l.departmentCode}` });
      else departmentId = d.id;
    } else if (account.defaultDepartmentId) {
      departmentId = account.defaultDepartmentId;
    }
    let costCenterId: string | null = null;
    if (l.costCenterCode) {
      const c = ccByCode.get(l.costCenterCode);
      if (!c) issues.push({ path: `lines.${i}.costCenterCode`, message: `Unknown cost center ${l.costCenterCode}` });
      else costCenterId = c.id;
    }
    let taxCodeId: string | null = null;
    if (l.taxCodeKey) {
      const tc = taxByKey.get(l.taxCodeKey);
      if (!tc) issues.push({ path: `lines.${i}.taxCodeKey`, message: `Unknown tax code ${l.taxCodeKey}` });
      else taxCodeId = tc.id;
    }
    const amount = toMoney(l.amount);
    const taxAmount = toMoney(l.taxAmount);
    if (isNegative(amount)) issues.push({ path: `lines.${i}.amount`, message: "Must be non-negative" });
    if (isNegative(taxAmount)) issues.push({ path: `lines.${i}.taxAmount`, message: "Must be non-negative" });

    resolvedLines.push({
      lineNumber: i + 1,
      accountId: account?.id ?? "",
      departmentId,
      costCenterId,
      description: l.description ?? null,
      quantity: l.quantity == null ? null : toMoney(l.quantity),
      unitCost: l.unitCost == null ? null : toMoney(l.unitCost),
      amount,
      taxCodeId,
      taxAmount,
      isCapital: l.isCapital,
      isInventory: l.isInventory,
    });
  }

  if (issues.length) throw new ValidationError(issues, "AP invoice validation failed");

  const subtotal = sumMoney(resolvedLines.map((l) => l.amount));
  const taxTotal = sumMoney(resolvedLines.map((l) => l.taxAmount));
  const total = subtotal.plus(taxTotal);
  if (total.lte(ZERO)) {
    throw new ValidationError([{ path: "lines", message: "Invoice total must be positive" }]);
  }

  // Resolve invoice-level department.
  const invoiceDepartmentId = input.departmentCode
    ? (deptByCode.get(input.departmentCode)?.id ?? null)
    : null;
  if (input.departmentCode && !invoiceDepartmentId) {
    throw new ValidationError([{ path: "departmentCode", message: `Unknown department ${input.departmentCode}` }]);
  }

  return { resolvedLines, subtotal, taxTotal, total, invoiceDepartmentId };
}

export async function createDraft(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "ap:invoice:create");
  const parsed = invoiceCreateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const input = parsed.data;

  const vendor = await prisma.vendor.findUnique({ where: { id: input.vendorId } });
  assertTenantOwned(vendor, principal);
  if (vendor.status === "BLOCKED") throw new ConflictError("Vendor is BLOCKED");

  const invoiceDate = new Date(input.invoiceDate);
  const dueDate = input.dueDate ? new Date(input.dueDate) : new Date(invoiceDate.getTime() + vendor.paymentTermsDays * 86400000);

  // Duplicate detection: same vendor + vendorReference?
  if (input.vendorReference) {
    const dup = await prisma.aPInvoice.findFirst({
      where: { clubId, vendorId: input.vendorId, vendorReference: input.vendorReference },
    });
    if (dup) throw new ConflictError(`Invoice ${input.vendorReference} already exists for this vendor (${dup.invoiceNumber})`);
  }

  const { resolvedLines, subtotal, taxTotal, total, invoiceDepartmentId } = await validateAndResolveInvoice(clubId, input);

  const invoiceNumber = await nextInvoiceNumber(clubId);
  const created = await prisma.$transaction(async (tx) => {
    const inv = await tx.aPInvoice.create({
      data: {
        clubId,
        invoiceNumber,
        vendorReference: input.vendorReference ?? null,
        vendorId: input.vendorId,
        invoiceDate,
        dueDate,
        terms: input.terms ?? null,
        description: input.description ?? null,
        departmentId: invoiceDepartmentId,
        subtotal,
        taxTotal,
        total,
        currency: input.currency,
        status: "DRAFT",
        captureId: input.captureId ?? null,
        createdByUserId: principal.id,
      },
    });
    await tx.aPInvoiceLine.createMany({
      data: resolvedLines.map((l) => ({
        clubId,
        invoiceId: inv.id,
        lineNumber: l.lineNumber,
        expenseAccountId: l.accountId,
        departmentId: l.departmentId,
        costCenterId: l.costCenterId,
        description: l.description,
        quantity: l.quantity,
        unitCost: l.unitCost,
        amount: l.amount,
        taxCodeId: l.taxCodeId,
        taxAmount: l.taxAmount,
        isCapital: l.isCapital,
        isInventory: l.isInventory,
      })),
    });
    return inv;
  });
  await audit(principal, {
    action: "ap.invoice.create",
    entityType: "APInvoice", entityId: created.id, clubId,
    after: { invoiceNumber: created.invoiceNumber, total: total.toString(), vendorId: input.vendorId },
  });

  // Run exception detection — non-blocking.
  await detectInvoiceExceptions(principal, clubId, created.id).catch(() => { /* logged inside */ });

  // If we converted from a capture, mark that capture as CONVERTED.
  if (input.captureId) {
    await prisma.receiptCapture.update({
      where: { id: input.captureId },
      data: { status: "CONVERTED", convertedAt: new Date() },
    });
  }

  return created;
}

export async function submitInvoiceForApproval(principal: Principal, invoiceId: string) {
  const inv = await prisma.aPInvoice.findUnique({ where: { id: invoiceId }, include: { vendor: true } });
  assertTenantOwned(inv, principal);
  requirePermission(principal, inv.clubId, "ap:invoice:create");
  if (inv.status !== "DRAFT") throw new ConflictError(`Invoice is ${inv.status}`);
  if (inv.vendor.status === "BLOCKED") throw new ConflictError("Vendor is BLOCKED — cannot submit");

  await submitForApproval(principal, inv.clubId, "AP_INVOICE", invoiceId, Number(inv.total.toString()));
  const updated = await prisma.aPInvoice.update({
    where: { id: invoiceId },
    data: { status: "PENDING_APPROVAL" },
  });
  await audit(principal, {
    action: "ap.invoice.submit",
    entityType: "APInvoice", entityId: invoiceId, clubId: inv.clubId,
    before: { status: "DRAFT" }, after: { status: "PENDING_APPROVAL" },
  });
  return updated;
}

// Mark APPROVED once the request reaches APPROVED. Idempotent.
export async function finalizeApprovalState(principal: Principal, invoiceId: string) {
  const inv = await prisma.aPInvoice.findUnique({ where: { id: invoiceId } });
  assertTenantOwned(inv, principal);
  if (inv.status !== "PENDING_APPROVAL") return inv;
  const req = await getRequestForEntity(inv.clubId, "AP_INVOICE", invoiceId);
  if (!isApproved(req)) return inv;
  const updated = await prisma.aPInvoice.update({
    where: { id: invoiceId },
    data: { status: "APPROVED" },
  });
  await audit(principal, {
    action: "ap.invoice.approved",
    entityType: "APInvoice", entityId: invoiceId, clubId: inv.clubId,
    after: { status: "APPROVED" },
  });
  return updated;
}

// Post to GL. Caller must hold ap:invoice:post. Requires APPROVED state
// unless the principal holds ap:exception:override.
export async function postInvoice(principal: Principal, invoiceId: string) {
  const inv = await prisma.aPInvoice.findUnique({
    where: { id: invoiceId },
    include: { lines: { include: { expenseAccount: true, taxCode: { include: { recoverableAccount: true } } } }, vendor: true },
  });
  assertTenantOwned(inv, principal);
  requirePermission(principal, inv.clubId, "ap:invoice:post");
  await assertPostingAllowed(principal, inv.clubId, "ap.invoice.post", "APInvoice", invoiceId);
  if (inv.status === "POSTED" || inv.status === "PARTIALLY_PAID" || inv.status === "PAID") {
    return inv;
  }
  if (inv.vendor.status === "BLOCKED") throw new ConflictError("Vendor is BLOCKED");
  // Refuse if a pending approval request exists and it's not APPROVED.
  if (inv.status === "PENDING_APPROVAL") {
    const req = await getRequestForEntity(inv.clubId, "AP_INVOICE", invoiceId);
    if (!isApproved(req)) {
      if (!hasPermission(principal, inv.clubId, "ap:exception:override")) {
        throw new ConflictError("Invoice is awaiting approval");
      }
    } else {
      await finalizeApprovalState(principal, invoiceId);
    }
  } else if (inv.status === "DRAFT" && !hasPermission(principal, inv.clubId, "ap:exception:override")) {
    throw new ConflictError("Invoice has not been submitted for approval");
  }

  const journal = await postInvoiceToGl(principal, invoiceId);
  const updated = await prisma.aPInvoice.update({
    where: { id: invoiceId },
    data: {
      status: "POSTED",
      postedAt: new Date(),
      postedByUserId: principal.id,
      postedJournalEntryId: journal.id,
    },
  });
  await audit(principal, {
    action: "ap.invoice.post",
    entityType: "APInvoice", entityId: invoiceId, clubId: inv.clubId,
    before: { status: inv.status }, after: { status: "POSTED", journalEntryId: journal.id },
  });
  return updated;
}

export async function reverseInvoice(principal: Principal, invoiceId: string, reason: string) {
  const inv = await prisma.aPInvoice.findUnique({ where: { id: invoiceId } });
  assertTenantOwned(inv, principal);
  requirePermission(principal, inv.clubId, "ap:invoice:void");
  await assertPostingAllowed(principal, inv.clubId, "ap.invoice.reverse", "APInvoice", invoiceId);
  if (inv.status !== "POSTED" && inv.status !== "PARTIALLY_PAID") {
    throw new ConflictError(`Cannot reverse from status ${inv.status}`);
  }
  if (!inv.postedJournalEntryId) throw new ConflictError("Invoice has no posted journal entry to reverse");
  // If payments exist against this invoice, refuse — payments must be voided first.
  const payments = await prisma.vendorPayment.count({
    where: { invoiceId, status: "PROCESSED" },
  });
  if (payments > 0) throw new ConflictError("Void payments against this invoice before reversing");

  const reversingJE = await postInvoiceReversalToGl(principal, invoiceId, reason);
  const updated = await prisma.aPInvoice.update({
    where: { id: invoiceId },
    data: {
      status: "VOIDED",
      voidedAt: new Date(),
      voidedByUserId: principal.id,
      voidReason: reason,
      reversingJournalEntryId: reversingJE.id,
    },
  });
  await audit(principal, {
    action: "ap.invoice.reverse",
    entityType: "APInvoice", entityId: invoiceId, clubId: inv.clubId,
    before: { status: inv.status }, after: { status: "VOIDED", reversingJE: reversingJE.id },
    meta: { reason },
  });
  return updated;
}

export async function disputeInvoice(principal: Principal, invoiceId: string, note: string) {
  const inv = await prisma.aPInvoice.findUnique({ where: { id: invoiceId } });
  assertTenantOwned(inv, principal);
  requirePermission(principal, inv.clubId, "ap:invoice:edit");
  const updated = await prisma.aPInvoice.update({
    where: { id: invoiceId },
    data: { status: "DISPUTED", notes: (inv.notes ? inv.notes + "\n\n" : "") + `[dispute] ${note}` },
  });
  await audit(principal, {
    action: "ap.invoice.dispute",
    entityType: "APInvoice", entityId: invoiceId, clubId: inv.clubId,
    before: { status: inv.status }, after: { status: "DISPUTED" }, meta: { note },
  });
  return updated;
}

// ---------- Reads ----------
export async function listInvoices(principal: Principal, clubId: string, opts?: { status?: string; vendorId?: string }) {
  if (!hasPermission(principal, clubId, "ap:invoice:view")) return [];
  return prisma.aPInvoice.findMany({
    where: {
      ...tenantWhere(principal, clubId),
      ...(opts?.status ? { status: opts.status } : {}),
      ...(opts?.vendorId ? { vendorId: opts.vendorId } : {}),
    },
    include: { vendor: true },
    orderBy: { invoiceDate: "desc" },
    take: 200,
  });
}

export async function getInvoice(principal: Principal, invoiceId: string) {
  const inv = await prisma.aPInvoice.findUnique({
    where: { id: invoiceId },
    include: {
      vendor: true,
      department: true,
      lines: { include: { expenseAccount: true, department: true, costCenter: true, taxCode: true }, orderBy: { lineNumber: "asc" } },
      attachments: true,
      payments: true,
      postedJournalEntry: true,
      reversingJournalEntry: true,
      capture: true,
    },
  });
  if (!inv) throw new NotFoundError("APInvoice", invoiceId);
  assertTenantOwned(inv, principal);
  if (!hasPermission(principal, inv.clubId, "ap:invoice:view")) throw new NotFoundError("APInvoice", invoiceId);
  return inv;
}
