// Phase 7E/F/G — POS module foundation + inventory/AR integration.
//
// A POSSale is the canonical record of a point-of-sale transaction. The flow:
//   1. createSale() — creates a DRAFT sale with lines, taxes, discounts.
//   2. completeSale() — finalizes the sale, posts:
//        - inventory deduction + COGS JE (DR COGS / CR Inventory) for each
//          INVENTORY-kind line (calls inventory.postSale per line)
//        - if chargeMode is MEMBER_ACCOUNT: an AR Charge per revenue account
//          + revenue JE through the existing AR flow
//        - other charge modes (CASH, CARD, GIFT_CARD): a single revenue JE
//          (DR cash 1010 / CR revenue per line)
//   3. refundSale() — creates a contra POSSale linked via refundOfSaleId and
//      reverses inventory + AR posting.
//
// Idempotency: external POS integrations supply a (provider, externalReference)
// pair; we use the @@unique on POSSale to reject duplicates.

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { createPostedFromAdapter } from "../accounting/journal";
import { findPeriodForDate } from "../accounting/periods";
import { postSale as postInventorySale } from "../ops/inventory";
import { recomputeAccount } from "../services/ar";
import { assertPostingAllowed } from "../posting-guard";

const DEFAULT_AR_CONTROL = "1110"; // Member AR control
const DEFAULT_CASH = "1010";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
export const saleLineSchema = z.object({
  kind: z.enum(["INVENTORY", "SERVICE", "LESSON", "EVENT", "FEE", "OTHER"]).default("OTHER"),
  itemSku: z.string().optional().nullable(),
  // POSMenuItem the line came from — used by menu-driven surfaces
  // (lounge, dining) to route chits, drive popularity reports, and
  // resolve future per-item modifiers. `itemSku` is the InventoryItem
  // SKU for stock-tracked goods; `menuItemId` is the menu-driven
  // alternative. They're not mutually exclusive but won't both be set
  // in practice today.
  menuItemId: z.string().optional().nullable(),
  description: z.string().trim().min(1).max(200),
  quantity: z.number().positive().default(1),
  unitPrice: z.number().nonnegative(),
  taxAmount: z.number().nonnegative().default(0),
  discountAmount: z.number().nonnegative().default(0),
  revenueAccountNumber: z.string().optional().nullable(),
});

export const createSaleSchema = z.object({
  locationCode: z.string().trim().min(1),
  terminalCode: z.string().trim().optional().nullable(),
  sessionId: z.string().optional().nullable(),
  memberId: z.string().optional().nullable(),
  guestName: z.string().trim().max(200).optional().nullable(),
  departmentCode: z.string().optional().nullable(),
  chargeMode: z.enum(["CASH", "CARD", "MEMBER_ACCOUNT", "GIFT_CARD", "QR_PAY", "OTHER"]).default("MEMBER_ACCOUNT"),
  // Dining mode flows through to the kitchen/bar chits so prep plates
  // the food correctly (ceramic vs. takeaway container).
  diningMode: z.enum(["STAY", "TO_GO"]).default("STAY"),
  saleDate: z.string().or(z.date()).optional(),
  lines: z.array(saleLineSchema).min(1),
  taxLines: z.array(z.object({
    label: z.string(),
    rate: z.number().nonnegative().default(0),
    amount: z.number().nonnegative(),
    taxCodeKey: z.string().optional().nullable(),
  })).default([]),
  discounts: z.array(z.object({
    label: z.string(),
    kind: z.enum(["PERCENT", "AMOUNT", "COMP"]).default("AMOUNT"),
    value: z.number().nonnegative().default(0),
    amount: z.number().nonnegative(),
  })).default([]),
  payments: z.array(z.object({
    method: z.enum(["CASH", "CARD", "MEMBER_ACCOUNT", "GIFT_CARD", "QR_PAY", "OTHER"]),
    amount: z.number().nonnegative(),
    tipAmount: z.number().nonnegative().default(0),
    externalReference: z.string().optional().nullable(),
    processorToken: z.string().optional().nullable(),
  })).default([]),
  providerKey: z.string().optional().nullable(),
  externalReference: z.string().optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Sale creation
// ---------------------------------------------------------------------------
async function nextSaleNumber(clubId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.pOSSale.count({ where: { clubId, createdAt: { gte: new Date(year, 0, 1) } } });
  return `POS-${year}-${String(count + 1).padStart(6, "0")}`;
}

export async function createSale(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "inventory:write"); // POS write reuses inventory:write
  const parsed = createSaleSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;

  const location = await prisma.pOSLocation.findFirst({ where: { clubId, code: d.locationCode } });
  if (!location) throw new ConflictError(`Unknown POS location: ${d.locationCode}`);
  const terminal = d.terminalCode ? await prisma.pOSTerminal.findFirst({ where: { clubId, code: d.terminalCode } }) : null;
  const department = d.departmentCode ? await prisma.department.findFirst({ where: { clubId, code: d.departmentCode } }) : null;
  const provider = d.providerKey ? await prisma.pOSIntegrationProvider.findFirst({ where: { clubId, key: d.providerKey } }) : null;

  // Duplicate prevention via @@unique(clubId, providerId, externalReference).
  if (provider && d.externalReference) {
    const existing = await prisma.pOSSale.findFirst({
      where: { clubId, providerId: provider.id, externalReference: d.externalReference },
    });
    if (existing) {
      return existing; // idempotent: return the existing sale rather than throwing
    }
  }

  // Resolve member.
  let member = null;
  if (d.memberId) {
    member = await prisma.member.findUnique({ where: { id: d.memberId }, include: { account: true } });
    if (!member || member.clubId !== clubId) throw new ConflictError("Member not found at this club");
    if (d.chargeMode === "MEMBER_ACCOUNT" && !member.account) throw new ConflictError("Member has no AR account");
    // Access-status gate. CHARGE_ACCOUNT_SUSPENDED and FULL_SUSPENSION
    // both block charging to the member's account — the back-office
    // suspended them because they're past due, fraud-flagged, or
    // similar. Other payment methods (cash, card, QR pay) are still
    // allowed; the bar can serve them, the member just can't tab it.
    if (d.chargeMode === "MEMBER_ACCOUNT" && (
      member.accessStatus === "CHARGE_ACCOUNT_SUSPENDED" ||
      member.accessStatus === "FULL_SUSPENSION"
    )) {
      throw new ConflictError(`${member.firstName} ${member.lastName}'s charge account is suspended. Use another payment method.`);
    }
  } else if (d.chargeMode === "MEMBER_ACCOUNT") {
    throw new ConflictError("Member account charge requires memberId");
  }

  // Resolve inventory items.
  const itemsBySku = new Map<string, { id: string; averageCost: Prisma.Decimal; kind: string; clubId: string }>();
  for (const l of d.lines) {
    if (l.kind === "INVENTORY" && l.itemSku) {
      const item = await prisma.inventoryItem.findFirst({ where: { clubId, sku: l.itemSku } });
      if (!item) throw new ConflictError(`Unknown inventory item: ${l.itemSku}`);
      itemsBySku.set(l.itemSku, { id: item.id, averageCost: item.averageCost, kind: item.kind, clubId: item.clubId });
    }
  }

  // Compute totals.
  const subtotal = round2(d.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0));
  const taxTotal = round2(d.taxLines.reduce((s, t) => s + t.amount, 0));
  const discountTotal = round2(d.discounts.reduce((s, x) => s + x.amount, 0));
  const gratuityTotal = round2(d.payments.reduce((s, p) => s + (p.tipAmount ?? 0), 0));
  const grandTotal = round2(subtotal + taxTotal + gratuityTotal - discountTotal);

  // Verify payments sum to grandTotal (with small tolerance).
  const paymentSum = round2(d.payments.reduce((s, p) => s + p.amount + p.tipAmount, 0));
  if (d.payments.length > 0 && Math.abs(paymentSum - grandTotal) > 0.01) {
    throw new ConflictError(`Payments (${paymentSum}) do not sum to grand total (${grandTotal})`);
  }

  const saleNumber = await nextSaleNumber(clubId);
  const saleDate = d.saleDate ? new Date(d.saleDate) : new Date();

  const sale = await prisma.pOSSale.create({
    data: {
      clubId, saleNumber,
      locationId: location.id, terminalId: terminal?.id ?? null,
      sessionId: d.sessionId ?? null,
      memberId: d.memberId ?? null,
      guestName: d.guestName ?? null,
      departmentId: department?.id ?? null,
      chargeMode: d.chargeMode,
      diningMode: d.diningMode,
      subtotal, taxTotal, discountTotal, gratuityTotal, grandTotal,
      status: "DRAFT", saleDate,
      providerId: provider?.id ?? null,
      externalReference: d.externalReference ?? null,
      notes: d.notes ?? null,
      createdByUserId: principal.id,
    },
  });

  // Create lines.
  for (const l of d.lines) {
    const item = l.itemSku ? itemsBySku.get(l.itemSku) : null;
    const lineSubtotal = round2(l.quantity * l.unitPrice);
    const lineTotal = round2(lineSubtotal + l.taxAmount - l.discountAmount);
    const revenueAccount = l.revenueAccountNumber
      ? await prisma.account.findFirst({ where: { clubId, accountNumber: l.revenueAccountNumber } })
      : null;
    await prisma.pOSSaleLine.create({
      data: {
        clubId, saleId: sale.id,
        kind: l.kind,
        itemId: item?.id ?? null,
        menuItemId: l.menuItemId ?? null,
        description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
        unitCost: item ? Number(item.averageCost.toString()) : 0,
        lineSubtotal, taxAmount: l.taxAmount, discountAmount: l.discountAmount, lineTotal,
        revenueAccountId: revenueAccount?.id ?? null,
      },
    });
  }
  for (const t of d.taxLines) {
    await prisma.pOSTaxLine.create({
      data: { clubId, saleId: sale.id, kind: "TAX", label: t.label, rate: t.rate, amount: t.amount, taxCodeKey: t.taxCodeKey ?? null },
    });
  }
  for (const x of d.discounts) {
    await prisma.pOSDiscount.create({
      data: { clubId, saleId: sale.id, kind: x.kind, label: x.label, value: x.value, amount: x.amount },
    });
  }
  for (const p of d.payments) {
    await prisma.pOSPayment.create({
      data: {
        clubId, saleId: sale.id, method: p.method, amount: p.amount, tipAmount: p.tipAmount ?? 0,
        externalReference: p.externalReference ?? null, processorToken: p.processorToken ?? null,
        status: "CAPTURED",
      },
    });
  }

  await audit(principal, { action: "pos.sale.create", entityType: "POSSale", entityId: sale.id, clubId, after: { saleNumber, grandTotal } });
  return sale;
}

// ---------------------------------------------------------------------------
// Completion: posts inventory + AR + GL.
// ---------------------------------------------------------------------------
export async function completeSale(principal: Principal, saleId: string) {
  const sale = await prisma.pOSSale.findUnique({
    where: { id: saleId },
    include: {
      lines: { include: { item: true, revenueAccount: true } },
      member: { include: { account: true } },
      location: true,
      department: true,
    },
  });
  if (!sale) throw new NotFoundError("POSSale", saleId);
  assertTenantOwned(sale, principal);
  requirePermission(principal, sale.clubId, "inventory:write");
  await assertPostingAllowed(principal, sale.clubId, "pos.sale.complete", "POSSale", saleId);
  if (sale.status !== "DRAFT") throw new ConflictError(`Sale is ${sale.status}`);

  const period = await findPeriodForDate(sale.clubId, sale.saleDate);
  if (!period) throw new ConflictError(`No fiscal period for ${sale.saleDate.toISOString().slice(0, 10)}`);

  // 1. Inventory deduction + COGS posting per inventory line.
  for (const line of sale.lines) {
    if (line.kind !== "INVENTORY" || !line.item) continue;
    if (line.item.kind === "SERVICE") continue; // service items skip inventory deduction
    await postInventorySale(principal, sale.clubId, {
      itemId: line.item.id,
      quantity: Number(line.quantity.toString()),
      sourceType: "POSSale",
      sourceId: sale.id,
      transactionDate: sale.saleDate,
    });
    // Tag the line with its inventory transaction so we can audit.
    const tx = await prisma.inventoryTransaction.findFirst({
      where: { clubId: sale.clubId, sourceType: "POSSale", sourceId: sale.id, itemId: line.item.id },
      orderBy: { createdAt: "desc" },
    });
    if (tx) await prisma.pOSSaleLine.update({ where: { id: line.id }, data: { inventoryTransactionId: tx.id } });
  }

  // 2. Revenue side. Two paths:
  //    MEMBER_ACCOUNT → DR Member AR / CR Revenue lines (+ CR Tax payable rows aggregate)
  //    CASH/CARD/GIFT_CARD/OTHER → DR Cash 1010 / CR Revenue lines
  // We aggregate by revenue account for compactness.
  const revenueByAccount = new Map<string, number>();
  for (const line of sale.lines) {
    const acctNum = line.revenueAccount?.accountNumber ?? defaultRevenueForKind(line.kind);
    if (!acctNum) continue;
    revenueByAccount.set(acctNum, (revenueByAccount.get(acctNum) ?? 0) + Number(line.lineSubtotal.toString()) - Number(line.discountAmount.toString()));
  }
  const taxTotal = Number(sale.taxTotal.toString());
  const gratuityTotal = Number(sale.gratuityTotal.toString());
  const debitTotal = round2(Number(sale.grandTotal.toString()));

  type Line = { accountNumber: string; debit?: string; credit?: string; description?: string | null; memberId?: string };
  const lines: Line[] = [];

  // Debit side: AR or Cash.
  if (sale.chargeMode === "MEMBER_ACCOUNT") {
    if (!sale.member?.account) throw new ConflictError("Member has no AR account");
    lines.push({ accountNumber: DEFAULT_AR_CONTROL, debit: debitTotal.toFixed(2), description: `POS ${sale.saleNumber} member charge`, memberId: sale.memberId ?? undefined });
  } else {
    lines.push({ accountNumber: DEFAULT_CASH, debit: debitTotal.toFixed(2), description: `POS ${sale.saleNumber} ${sale.chargeMode}` });
  }

  // Credit side: revenue lines.
  for (const [account, amount] of revenueByAccount.entries()) {
    if (round2(amount) <= 0) continue;
    lines.push({ accountNumber: account, credit: round2(amount).toFixed(2), description: `POS ${sale.saleNumber} revenue` });
  }
  // Tax credit (aggregate to 2110 GST Payable).
  if (taxTotal > 0) {
    lines.push({ accountNumber: "2110", credit: taxTotal.toFixed(2), description: `POS ${sale.saleNumber} sales tax` });
  }
  // Gratuity credit (accrued tips liability 2030 since payroll already credits it).
  if (gratuityTotal > 0) {
    lines.push({ accountNumber: "2030", credit: gratuityTotal.toFixed(2), description: `POS ${sale.saleNumber} gratuity payable` });
  }

  const journal = await createPostedFromAdapter(
    principal, sale.clubId,
    { entryDate: sale.saleDate, description: `POS sale ${sale.saleNumber}`, lines },
    { source: "RECURRING", sourceEntityType: "POSSale", sourceEntityId: sale.id },
  );

  // 3. AR Charge linkage if MEMBER_ACCOUNT.
  let arChargeId: string | null = null;
  if (sale.chargeMode === "MEMBER_ACCOUNT" && sale.memberId && sale.member?.account) {
    const charge = await prisma.charge.create({
      data: {
        clubId: sale.clubId,
        memberId: sale.memberId,
        accountId: sale.member.account.id,
        description: `POS ${sale.saleNumber} — ${sale.location.name}`,
        category: kindToChargeCategory(sale.lines[0]?.kind ?? "OTHER"),
        amount: debitTotal,
        transactionDate: sale.saleDate,
        dueDate: sale.saleDate,
        status: "POSTED",
        postedByUserId: principal.id,
      },
    });
    arChargeId = charge.id;
    await recomputeAccount(sale.memberId);
  }

  const updated = await prisma.pOSSale.update({
    where: { id: sale.id },
    data: { status: "COMPLETED", postedJournalEntryId: journal.id, arChargeId },
  });
  await audit(principal, {
    action: "pos.sale.complete", entityType: "POSSale", entityId: sale.id, clubId: sale.clubId,
    after: { saleNumber: sale.saleNumber, journalEntryId: journal.id, arChargeId },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Refund — creates a contra POSSale with negative-amount lines and reverses
// inventory + AR.
// ---------------------------------------------------------------------------
export async function refundSale(principal: Principal, saleId: string, args: { reason?: string }) {
  const original = await prisma.pOSSale.findUnique({
    where: { id: saleId },
    include: { lines: { include: { item: true, revenueAccount: true } }, member: { include: { account: true } }, location: true },
  });
  if (!original) throw new NotFoundError("POSSale", saleId);
  assertTenantOwned(original, principal);
  requirePermission(principal, original.clubId, "inventory:write");
  await assertPostingAllowed(principal, original.clubId, "pos.sale.refund", "POSSale", saleId);
  if (original.status !== "COMPLETED") throw new ConflictError("Only COMPLETED sales can be refunded");
  if (original.refundOfSaleId) throw new ConflictError("Cannot refund a refund");

  const period = await findPeriodForDate(original.clubId, new Date());
  if (!period) throw new ConflictError("No fiscal period for today");

  const refundNumber = await nextSaleNumber(original.clubId);
  const refund = await prisma.pOSSale.create({
    data: {
      clubId: original.clubId,
      saleNumber: refundNumber,
      locationId: original.locationId, terminalId: original.terminalId,
      memberId: original.memberId, departmentId: original.departmentId,
      chargeMode: original.chargeMode,
      subtotal: original.subtotal.negated(),
      taxTotal: original.taxTotal.negated(),
      discountTotal: original.discountTotal.negated(),
      gratuityTotal: original.gratuityTotal.negated(),
      grandTotal: original.grandTotal.negated(),
      status: "REFUNDED", saleDate: new Date(),
      refundOfSaleId: original.id,
      notes: args.reason ?? null,
      createdByUserId: principal.id,
    },
  });

  // 1. Reverse inventory: add quantity back via positive inventory transaction
  //    (kind=RETURN) for each inventory line.
  for (const line of original.lines) {
    if (line.kind !== "INVENTORY" || !line.item) continue;
    if (line.item.kind === "SERVICE") continue;
    const item = await prisma.inventoryItem.findUnique({ where: { id: line.item.id } });
    if (!item) continue;
    const onHand = Number(item.quantityOnHand.toString());
    const qty = Number(line.quantity.toString());
    const newOnHand = onHand + qty;
    await prisma.inventoryItem.update({ where: { id: item.id }, data: { quantityOnHand: newOnHand } });
    await prisma.inventoryTransaction.create({
      data: {
        clubId: original.clubId, itemId: item.id, locationId: item.defaultLocationId,
        kind: "RETURN", quantity: qty, unitCost: Number(line.unitCost.toString()),
        totalCost: round2(qty * Number(line.unitCost.toString())),
        averageCostAfter: Number(item.averageCost.toString()), quantityAfter: newOnHand,
        sourceType: "POSSale", sourceId: refund.id,
        notes: `Refund of ${original.saleNumber}`,
        createdByUserId: principal.id,
      },
    });
  }

  // 2. Reverse the GL JE.
  const debitTotal = Math.abs(Number(original.grandTotal.toString()));
  type Line = { accountNumber: string; debit?: string; credit?: string; description?: string | null; memberId?: string };
  const lines: Line[] = [];
  // Mirror: credit cash/AR, debit revenue/tax/tips.
  if (original.chargeMode === "MEMBER_ACCOUNT") {
    lines.push({ accountNumber: DEFAULT_AR_CONTROL, credit: debitTotal.toFixed(2), description: `POS ${refundNumber} refund` });
  } else {
    lines.push({ accountNumber: DEFAULT_CASH, credit: debitTotal.toFixed(2), description: `POS ${refundNumber} refund` });
  }
  for (const line of original.lines) {
    const acctNum = line.revenueAccount?.accountNumber ?? defaultRevenueForKind(line.kind);
    if (!acctNum) continue;
    const amount = round2(Number(line.lineSubtotal.toString()) - Number(line.discountAmount.toString()));
    if (amount <= 0) continue;
    lines.push({ accountNumber: acctNum, debit: amount.toFixed(2), description: `Refund ${refundNumber}` });
  }
  const taxTotal = Number(original.taxTotal.toString());
  if (taxTotal > 0) lines.push({ accountNumber: "2110", debit: taxTotal.toFixed(2), description: "Reverse sales tax" });
  const grat = Number(original.gratuityTotal.toString());
  if (grat > 0) lines.push({ accountNumber: "2030", debit: grat.toFixed(2), description: "Reverse gratuity" });

  const journal = await createPostedFromAdapter(
    principal, original.clubId,
    { entryDate: new Date(), description: `POS refund ${refundNumber}`, lines },
    { source: "RECURRING", sourceEntityType: "POSSale", sourceEntityId: refund.id },
  );

  // 3. AR reversal — create a reversing Charge.
  let reversalChargeId: string | null = null;
  if (original.chargeMode === "MEMBER_ACCOUNT" && original.memberId && original.member?.account) {
    const reversal = await prisma.charge.create({
      data: {
        clubId: original.clubId, memberId: original.memberId, accountId: original.member.account.id,
        description: `Refund of POS ${original.saleNumber}`,
        category: "OTHER", amount: -debitTotal, transactionDate: new Date(), dueDate: new Date(),
        status: "POSTED", postedByUserId: principal.id,
        reversesId: original.arChargeId ?? null,
      },
    });
    reversalChargeId = reversal.id;
    await recomputeAccount(original.memberId);
  }

  const updatedRefund = await prisma.pOSSale.update({
    where: { id: refund.id },
    data: { status: "REFUNDED", postedJournalEntryId: journal.id, arChargeId: reversalChargeId },
  });
  await prisma.pOSSale.update({ where: { id: original.id }, data: { status: "REFUNDED" } });
  await audit(principal, {
    action: "pos.sale.refund", entityType: "POSSale", entityId: original.id, clubId: original.clubId,
    after: { refundOf: original.saleNumber, refundSale: refundNumber, reversalChargeId, journalEntryId: journal.id },
  });
  return updatedRefund;
}

// ---------------------------------------------------------------------------
// Voiding a DRAFT sale (before completion)
// ---------------------------------------------------------------------------
export async function voidSale(principal: Principal, saleId: string, reason: string) {
  const sale = await prisma.pOSSale.findUnique({ where: { id: saleId } });
  if (!sale) throw new NotFoundError("POSSale", saleId);
  assertTenantOwned(sale, principal);
  requirePermission(principal, sale.clubId, "inventory:write");
  await assertPostingAllowed(principal, sale.clubId, "pos.sale.void", "POSSale", saleId);
  if (sale.status !== "DRAFT") throw new ConflictError("Only DRAFT sales can be voided");
  const updated = await prisma.pOSSale.update({ where: { id: saleId }, data: { status: "VOIDED", notes: reason } });
  await audit(principal, { action: "pos.sale.void", entityType: "POSSale", entityId: saleId, clubId: sale.clubId, after: { status: "VOIDED" } });
  return updated;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function listSales(principal: Principal, clubId: string, opts?: { status?: string }) {
  requirePermission(principal, clubId, "inventory:read");
  return prisma.pOSSale.findMany({
    where: { ...tenantWhere(principal, clubId), ...(opts?.status ? { status: opts.status } : {}) },
    orderBy: { saleDate: "desc" }, take: 100,
    include: { location: true, member: true, lines: true },
  });
}

export async function getSale(principal: Principal, saleId: string) {
  const sale = await prisma.pOSSale.findUnique({
    where: { id: saleId },
    include: { lines: { include: { item: true, revenueAccount: true } }, taxLines: true, discounts: true, payments: true, location: true, member: true, terminal: true },
  });
  if (!sale) throw new NotFoundError("POSSale", saleId);
  assertTenantOwned(sale, principal);
  requirePermission(principal, sale.clubId, "inventory:read");
  return sale;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function round2(n: number): number { return Math.round(n * 100) / 100; }

function defaultRevenueForKind(kind: string): string | null {
  switch (kind) {
    case "INVENTORY": return "4300"; // Pro Shop default — clubs override via line.revenueAccountNumber
    case "LESSON": return "4400";
    case "EVENT": return "4500";
    case "SERVICE": return "4100";
    case "FEE": return "4900";
    default: return "4900";
  }
}

function kindToChargeCategory(kind: string): string {
  switch (kind) {
    case "INVENTORY": return "PRO_SHOP";
    case "SERVICE": return "FOOD_BEVERAGE";
    case "LESSON": return "OTHER";
    case "EVENT": return "EVENTS";
    default: return "OTHER";
  }
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
