// Inventory & Pro Shop service.
//
// Core operations:
//   - createItem / updateItem / archiveItem
//   - postReceiving       — DR Inventory / CR Goods Received Not Invoiced (2050)
//   - postAdjustment      — DR/CR Inventory <-> Inventory Adjustment expense
//   - postSale            — DR COGS / CR Inventory (revenue-side handled by AR)
//   - postCount           — variance posts as adjustment
//   - postTransfer        — moves quantity between locations; cost-neutral
//
// Inventory valuation: weighted-average cost. Item.averageCost is the source
// of truth and is recomputed on every cost-affecting transaction.

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere, assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { toMoney, sumMoney, ZERO } from "../accounting/decimal";
import { createPostedFromAdapter } from "../accounting/journal";
import { findPeriodForDate } from "../accounting/periods";
import { assertPostingAllowed } from "../posting-guard";

// ----------------------------------------------------------------------------
// Helpers — resolving accounts (item override > category default).
// ----------------------------------------------------------------------------
type ResolvedItemAccounts = {
  inventoryAccountNumber: string | null;
  cogsAccountNumber: string | null;
  revenueAccountNumber: string | null;
  adjustmentExpenseAccountNumber: string | null;
};

async function resolveItemAccounts(itemId: string): Promise<ResolvedItemAccounts & { clubId: string }> {
  const item = await prisma.inventoryItem.findUnique({
    where: { id: itemId },
    include: {
      inventoryAccount: true,
      cogsAccount: true,
      revenueAccount: true,
      category: { include: { inventoryAccount: true, cogsAccount: true, revenueAccount: true, adjustmentExpenseAccount: true } },
    },
  });
  if (!item) throw new NotFoundError("InventoryItem", itemId);
  return {
    clubId: item.clubId,
    inventoryAccountNumber:
      item.inventoryAccount?.accountNumber ?? item.category?.inventoryAccount?.accountNumber ?? null,
    cogsAccountNumber:
      item.cogsAccount?.accountNumber ?? item.category?.cogsAccount?.accountNumber ?? null,
    revenueAccountNumber:
      item.revenueAccount?.accountNumber ?? item.category?.revenueAccount?.accountNumber ?? null,
    adjustmentExpenseAccountNumber:
      item.category?.adjustmentExpenseAccount?.accountNumber ?? null,
  };
}

// ----------------------------------------------------------------------------
// Item CRUD
// ----------------------------------------------------------------------------
export const itemCreateSchema = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  brand: z.string().trim().max(120).optional().nullable(),
  kind: z.enum(["STANDARD", "SERVICE"]).default("STANDARD"),
  categoryKey: z.string().trim().optional().nullable(),
  preferredVendorId: z.string().optional().nullable(),
  defaultLocationCode: z.string().trim().optional().nullable(),
  unitOfMeasure: z.string().trim().max(20).default("EA"),
  defaultCost: z.number().nonnegative().default(0),
  retailPrice: z.number().nonnegative().default(0),
  reorderPoint: z.number().nonnegative().default(0),
  reorderQty: z.number().nonnegative().default(0),
  taxCodeKey: z.string().trim().optional().nullable(),
  isEcommerce: z.boolean().default(false),
});

export async function createItem(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "inventory:write");
  const parsed = itemCreateSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const category = d.categoryKey
    ? await prisma.inventoryCategory.findFirst({ where: { clubId, key: d.categoryKey } })
    : null;
  if (d.categoryKey && !category) throw new ConflictError(`Unknown category ${d.categoryKey}`);
  const defaultLocation = d.defaultLocationCode
    ? await prisma.inventoryLocation.findFirst({ where: { clubId, code: d.defaultLocationCode } })
    : null;

  const item = await prisma.inventoryItem.create({
    data: {
      clubId,
      sku: d.sku,
      name: d.name,
      description: d.description ?? null,
      brand: d.brand ?? null,
      kind: d.kind,
      categoryId: category?.id ?? null,
      preferredVendorId: d.preferredVendorId ?? null,
      defaultLocationId: defaultLocation?.id ?? null,
      unitOfMeasure: d.unitOfMeasure,
      defaultCost: d.defaultCost,
      retailPrice: d.retailPrice,
      averageCost: d.defaultCost,
      reorderPoint: d.reorderPoint,
      reorderQty: d.reorderQty,
      taxCodeKey: d.taxCodeKey ?? null,
      isEcommerce: d.isEcommerce,
    },
  });
  await audit(principal, { action: "inventory.item.create", entityType: "InventoryItem", entityId: item.id, clubId, after: { sku: item.sku, name: item.name } });
  return item;
}

// ----------------------------------------------------------------------------
// Receiving — posts inventory transactions + GL entry.
// ----------------------------------------------------------------------------
export const receivingCreateSchema = z.object({
  vendorId: z.string().optional().nullable(),
  locationCode: z.string().optional().nullable(),
  receivedDate: z.string().or(z.date()).optional(),
  lines: z.array(z.object({
    itemId: z.string(),
    quantity: z.number().positive(),
    unitCost: z.number().nonnegative(),
  })).min(1),
});

async function nextReceivingNumber(clubId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.inventoryReceiving.count({ where: { clubId, createdAt: { gte: new Date(year, 0, 1) } } });
  return `RCV-${year}-${(count + 1).toString().padStart(5, "0")}`;
}

// Create + post a receiving. The "posting" creates the inventory transactions,
// updates item quantities and weighted-average cost, and writes a GL JE:
//    DR Inventory (per item)
//    CR Goods Received Not Invoiced (2050)
export async function postReceiving(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "inventory:receive");
  await assertPostingAllowed(principal, clubId, "inventory.receive");
  const parsed = receivingCreateSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const receivedDate = d.receivedDate ? new Date(d.receivedDate) : new Date();
  const location = d.locationCode
    ? await prisma.inventoryLocation.findFirst({ where: { clubId, code: d.locationCode } })
    : null;

  // Resolve all items + their accounts in one pass; bail on missing inventory account.
  const itemIds = Array.from(new Set(d.lines.map((l) => l.itemId)));
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: itemIds }, clubId },
    include: {
      inventoryAccount: true,
      category: { include: { inventoryAccount: true } },
    },
  });
  if (items.length !== itemIds.length) {
    throw new ConflictError("One or more items not found or belong to another club");
  }
  const itemMap = new Map(items.map((i) => [i.id, i]));

  // GL adapter lines: aggregate inventory DRs by account number.
  type AdapterLine = { accountNumber: string; departmentCode?: string | null; description?: string | null; debit?: string; credit?: string };
  const drByAccount = new Map<string, number>();
  let totalCost = 0;

  for (const l of d.lines) {
    const item = itemMap.get(l.itemId)!;
    const invAccount = item.inventoryAccount?.accountNumber ?? item.category?.inventoryAccount?.accountNumber;
    if (!invAccount) throw new ConflictError(`Item ${item.sku} has no inventory account (item or category)`);
    const total = Math.round(l.quantity * l.unitCost * 100) / 100;
    totalCost = Math.round((totalCost + total) * 100) / 100;
    drByAccount.set(invAccount, (drByAccount.get(invAccount) ?? 0) + total);
  }

  const receivingNumber = await nextReceivingNumber(clubId);

  // Build adapter lines.
  const adapterLines: AdapterLine[] = [];
  for (const [accountNumber, amount] of drByAccount.entries()) {
    adapterLines.push({ accountNumber, description: `Inventory receipt ${receivingNumber}`, debit: amount.toFixed(2) });
  }
  adapterLines.push({ accountNumber: "2050", description: `Receiving ${receivingNumber}`, credit: totalCost.toFixed(2) });

  // Confirm period exists.
  const period = await findPeriodForDate(clubId, receivedDate);
  if (!period) throw new ConflictError(`No fiscal period for ${receivedDate.toISOString().slice(0, 10)}`);

  // Persist + post in transaction.
  const result = await prisma.$transaction(async (tx) => {
    const receiving = await tx.inventoryReceiving.create({
      data: {
        clubId,
        receivingNumber,
        vendorId: d.vendorId ?? null,
        locationId: location?.id ?? null,
        receivedDate,
        status: "DRAFT",
        totalReceivedCost: totalCost,
        createdByUserId: principal.id,
      },
    });
    for (const [i, l] of d.lines.entries()) {
      const item = itemMap.get(l.itemId)!;
      const lineTotal = Math.round(l.quantity * l.unitCost * 100) / 100;
      await tx.inventoryReceivingLine.create({
        data: {
          clubId, receivingId: receiving.id, itemId: l.itemId,
          quantity: l.quantity, unitCost: l.unitCost, totalCost: lineTotal,
        },
      });
      // Weighted-average cost recompute.
      const onHand = Number(item.quantityOnHand.toString());
      const oldAvg = Number(item.averageCost.toString());
      const newOnHand = onHand + l.quantity;
      const newAverage = newOnHand > 0
        ? Math.round(((onHand * oldAvg) + (l.quantity * l.unitCost)) / newOnHand * 10000) / 10000
        : l.unitCost;
      await tx.inventoryItem.update({
        where: { id: l.itemId },
        data: {
          quantityOnHand: newOnHand,
          averageCost: newAverage,
        },
      });
      await tx.inventoryTransaction.create({
        data: {
          clubId, itemId: l.itemId, locationId: location?.id ?? null,
          kind: "RECEIPT",
          quantity: l.quantity, unitCost: l.unitCost, totalCost: lineTotal,
          averageCostAfter: newAverage, quantityAfter: newOnHand,
          transactionDate: receivedDate,
          sourceType: "InventoryReceiving", sourceId: receiving.id,
          notes: `Line ${i + 1}`,
          createdByUserId: principal.id,
        },
      });
    }
    return receiving;
  });

  const journal = await createPostedFromAdapter(
    principal, clubId,
    { entryDate: receivedDate, description: `Inventory receiving ${receivingNumber}`, lines: adapterLines },
    { source: "RECURRING", sourceEntityType: "InventoryReceiving", sourceEntityId: result.id },
  );
  const posted = await prisma.inventoryReceiving.update({
    where: { id: result.id },
    data: { status: "POSTED", postedAt: new Date(), postedByUserId: principal.id, postedJournalEntryId: journal.id },
  });
  await audit(principal, { action: "inventory.receiving.post", entityType: "InventoryReceiving", entityId: result.id, clubId, after: { receivingNumber, totalCost, journalEntryId: journal.id } });
  return posted;
}

// ----------------------------------------------------------------------------
// Adjustments — DR/CR Inventory <-> Inventory Adjustment expense.
// ----------------------------------------------------------------------------
export const adjustmentSchema = z.object({
  itemId: z.string(),
  quantityChange: z.number(), // signed
  reasonCode: z.enum(["SHRINKAGE", "DAMAGE", "RECOUNT", "WRITE_OFF", "OTHER"]),
  notes: z.string().trim().max(500).optional().nullable(),
});

export async function postAdjustment(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "inventory:adjust");
  await assertPostingAllowed(principal, clubId, "inventory.adjust");
  const parsed = adjustmentSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const item = await prisma.inventoryItem.findUnique({ where: { id: d.itemId }, include: { inventoryAccount: true, category: { include: { inventoryAccount: true, adjustmentExpenseAccount: true } } } });
  if (!item) throw new NotFoundError("InventoryItem", d.itemId);
  if (item.clubId !== clubId) throw new ConflictError("Item belongs to another club");

  const invAccount = item.inventoryAccount?.accountNumber ?? item.category?.inventoryAccount?.accountNumber;
  const adjAccount = item.category?.adjustmentExpenseAccount?.accountNumber;
  if (!invAccount) throw new ConflictError("Item has no inventory account");
  if (!adjAccount) throw new ConflictError("Item category has no adjustment-expense account");
  if (d.quantityChange === 0) throw new ValidationError([{ path: "quantityChange", message: "Must be non-zero" }]);

  const unitCost = Number(item.averageCost.toString());
  const totalCost = Math.round(Math.abs(d.quantityChange) * unitCost * 100) / 100;

  // Adjustment row.
  const adj = await prisma.inventoryAdjustment.create({
    data: {
      clubId, itemId: d.itemId,
      locationId: item.defaultLocationId,
      quantityChange: d.quantityChange,
      unitCost,
      reasonCode: d.reasonCode,
      notes: d.notes ?? null,
      postedAt: new Date(),
      postedByUserId: principal.id,
    },
  });

  // Update item quantity + transaction.
  const newQty = Number(item.quantityOnHand.toString()) + d.quantityChange;
  await prisma.inventoryItem.update({
    where: { id: item.id },
    data: { quantityOnHand: newQty },
  });
  await prisma.inventoryTransaction.create({
    data: {
      clubId, itemId: item.id, locationId: item.defaultLocationId,
      kind: "ADJUSTMENT",
      quantity: d.quantityChange,
      unitCost,
      totalCost: d.quantityChange * unitCost,
      averageCostAfter: unitCost,
      quantityAfter: newQty,
      sourceType: "InventoryAdjustment", sourceId: adj.id,
      notes: d.notes,
      createdByUserId: principal.id,
    },
  });

  // GL: positive adjustment → DR Inventory / CR Adjustment expense
  //     negative adjustment → DR Adjustment expense / CR Inventory
  const journal = await createPostedFromAdapter(
    principal, clubId,
    {
      entryDate: new Date(),
      description: `Inventory adjustment · ${item.sku} · ${d.reasonCode}`,
      lines: d.quantityChange > 0
        ? [
            { accountNumber: invAccount, debit: totalCost.toFixed(2), description: d.notes ?? null },
            { accountNumber: adjAccount, credit: totalCost.toFixed(2), description: d.notes ?? null },
          ]
        : [
            { accountNumber: adjAccount, debit: totalCost.toFixed(2), description: d.notes ?? null },
            { accountNumber: invAccount, credit: totalCost.toFixed(2), description: d.notes ?? null },
          ],
    },
    { source: "RECURRING", sourceEntityType: "InventoryAdjustment", sourceEntityId: adj.id },
  );

  await audit(principal, { action: "inventory.adjustment.post", entityType: "InventoryAdjustment", entityId: adj.id, clubId, after: { itemId: item.id, quantityChange: d.quantityChange, reasonCode: d.reasonCode, totalCost, journalEntryId: journal.id } });
  return { adjustment: adj, journal };
}

// ----------------------------------------------------------------------------
// Sale (operational-side hook). Called by AR when a Charge of category=PRO_SHOP
// or FOOD_BEVERAGE includes an inventory item — currently the AR layer doesn't
// link line items to inventory. This helper is exposed for direct calls and
// for the Phase 7 POS adapter.
// ----------------------------------------------------------------------------
export async function postSale(
  principal: Principal,
  clubId: string,
  args: { itemId: string; quantity: number; sourceType: string; sourceId: string; transactionDate?: Date }
) {
  requirePermission(principal, clubId, "inventory:write");
  await assertPostingAllowed(principal, clubId, "inventory.sale", "InventoryItem", args.itemId);
  const item = await prisma.inventoryItem.findUnique({ where: { id: args.itemId }, include: { inventoryAccount: true, category: { include: { inventoryAccount: true, cogsAccount: true } } } });
  if (!item || item.clubId !== clubId) throw new NotFoundError("InventoryItem", args.itemId);
  if (item.kind === "SERVICE") {
    return; // no inventory movement for service items
  }
  const invAccount = item.inventoryAccount?.accountNumber ?? item.category?.inventoryAccount?.accountNumber;
  const cogsAccount = item.category?.cogsAccount?.accountNumber;
  if (!invAccount || !cogsAccount) {
    throw new ConflictError(`Item ${item.sku} missing inventory/COGS account configuration`);
  }
  const unitCost = Number(item.averageCost.toString());
  const totalCost = Math.round(args.quantity * unitCost * 100) / 100;
  const txDate = args.transactionDate ?? new Date();
  const newQty = Number(item.quantityOnHand.toString()) - args.quantity;

  await prisma.inventoryItem.update({
    where: { id: item.id },
    data: { quantityOnHand: newQty },
  });
  const txn = await prisma.inventoryTransaction.create({
    data: {
      clubId, itemId: item.id, locationId: item.defaultLocationId,
      kind: "SALE",
      quantity: -args.quantity, unitCost,
      totalCost: -totalCost,
      averageCostAfter: unitCost, quantityAfter: newQty,
      transactionDate: txDate,
      sourceType: args.sourceType, sourceId: args.sourceId,
      createdByUserId: principal.id,
    },
  });
  const journal = await createPostedFromAdapter(
    principal, clubId,
    {
      entryDate: txDate,
      description: `Inventory sale · ${item.sku}`,
      lines: [
        { accountNumber: cogsAccount, debit: totalCost.toFixed(2), description: item.name },
        { accountNumber: invAccount, credit: totalCost.toFixed(2), description: item.name },
      ],
    },
    { source: "RECURRING", sourceEntityType: "InventorySale", sourceEntityId: txn.id },
  );
  await prisma.inventoryTransaction.update({ where: { id: txn.id }, data: { postedJournalEntryId: journal.id } });
}

// ----------------------------------------------------------------------------
// Reads — listing, valuation, low-stock.
// ----------------------------------------------------------------------------
export async function listItems(principal: Principal, clubId: string) {
  return prisma.inventoryItem.findMany({
    where: { ...tenantWhere(principal, clubId), isActive: true },
    include: { category: true, preferredVendor: true, defaultLocation: true },
    orderBy: { sku: "asc" },
  });
}

export async function lowStockItems(clubId: string) {
  const items = await prisma.inventoryItem.findMany({
    where: { clubId, isActive: true },
    include: { category: true },
  });
  return items.filter((i) => Number(i.quantityOnHand.toString()) <= Number(i.reorderPoint.toString()));
}

export async function totalInventoryValuation(clubId: string): Promise<Prisma.Decimal> {
  const items = await prisma.inventoryItem.findMany({ where: { clubId, isActive: true } });
  return sumMoney(items.map((i) => toMoney(i.quantityOnHand).mul(toMoney(i.averageCost))));
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
// Re-export ZERO to keep this module self-sufficient for callers.
export { ZERO };
