// Capital assets + depreciation engine.
//
// Asset acquisition is driven by AP — when an AP invoice line has
// `isCapital:true`, the controller can promote it into a CapitalAsset record
// via `createFromAPLine`. The AP→GL adapter has already DR'd the asset
// account when the line was posted, so the asset row is "informational" for
// the asset register and drives depreciation going forward.
//
// Depreciation (monthly):
//   DR Depreciation Expense (category default e.g. 6900)
//   CR Accumulated Depreciation (category default e.g. 1545)
// Idempotent on (assetId, periodLabel).
//
// Disposal:
//   DR Cash / AR for proceeds (default 1010)
//   DR Accumulated Depreciation (full accumulated amount)
//   CR Asset cost account (full acquisition cost)
//   DR/CR Gain or Loss on Disposal (4900 / 6500 default)

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere, assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { toMoney } from "../accounting/decimal";
import { createPostedFromAdapter } from "../accounting/journal";
import { findPeriodForDate } from "../accounting/periods";

async function nextAssetNumber(clubId: string): Promise<string> {
  const count = await prisma.capitalAsset.count({ where: { clubId } });
  return `FA-${(count + 1).toString().padStart(5, "0")}`;
}

export const assetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  categoryKey: z.string().optional().nullable(),
  locationCode: z.string().optional().nullable(),
  departmentCode: z.string().optional().nullable(),
  acquisitionDate: z.string().or(z.date()),
  acquisitionCost: z.number().positive(),
  residualValue: z.number().nonnegative().default(0),
  usefulLifeMonths: z.number().int().positive().default(60),
  depreciationMethod: z.enum(["STRAIGHT_LINE", "DECLINING_BALANCE"]).default("STRAIGHT_LINE"),
  decliningBalanceRate: z.number().min(0).max(1).optional().nullable(),
  sourceApInvoiceId: z.string().optional().nullable(),
});

export async function createAsset(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "assets:manage");
  const parsed = assetSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const category = d.categoryKey ? await prisma.assetCategory.findFirst({ where: { clubId, key: d.categoryKey } }) : null;
  if (d.categoryKey && !category) throw new ConflictError(`Unknown asset category ${d.categoryKey}`);
  const location = d.locationCode ? await prisma.assetLocation.findFirst({ where: { clubId, code: d.locationCode } }) : null;
  const department = d.departmentCode ? await prisma.department.findFirst({ where: { clubId, code: d.departmentCode } }) : null;
  const asset = await prisma.capitalAsset.create({
    data: {
      clubId,
      assetNumber: await nextAssetNumber(clubId),
      name: d.name,
      description: d.description ?? null,
      categoryId: category?.id ?? null,
      locationId: location?.id ?? null,
      departmentId: department?.id ?? null,
      acquisitionDate: new Date(d.acquisitionDate),
      acquisitionCost: d.acquisitionCost,
      residualValue: d.residualValue,
      usefulLifeMonths: d.usefulLifeMonths ?? category?.defaultUsefulLifeMonths ?? 60,
      depreciationMethod: d.depreciationMethod ?? category?.defaultMethod ?? "STRAIGHT_LINE",
      decliningBalanceRate: d.decliningBalanceRate ?? (category?.defaultDecliningBalanceRate ? Number(category.defaultDecliningBalanceRate.toString()) : null),
      netBookValue: d.acquisitionCost,
      sourceApInvoiceId: d.sourceApInvoiceId ?? null,
      createdByUserId: principal.id,
    },
  });
  await audit(principal, { action: "asset.create", entityType: "CapitalAsset", entityId: asset.id, clubId, after: { assetNumber: asset.assetNumber, name: asset.name, cost: d.acquisitionCost } });
  return asset;
}

// Compute the monthly depreciation amount for a single asset.
export function monthlyDepreciation(asset: {
  acquisitionCost: Prisma.Decimal | number;
  residualValue: Prisma.Decimal | number;
  usefulLifeMonths: number;
  depreciationMethod: string;
  decliningBalanceRate: Prisma.Decimal | number | null;
  accumulatedDepreciation: Prisma.Decimal | number;
}): number {
  const cost = Number(asset.acquisitionCost.toString());
  const residual = Number(asset.residualValue.toString());
  const accumulated = Number(asset.accumulatedDepreciation.toString());
  if (asset.depreciationMethod === "DECLINING_BALANCE" && asset.decliningBalanceRate) {
    const rate = Number(asset.decliningBalanceRate.toString());
    const nbv = Math.max(0, cost - accumulated);
    const annual = nbv * rate;
    return Math.round((annual / 12) * 100) / 100;
  }
  // STRAIGHT_LINE
  const depreciable = Math.max(0, cost - residual);
  const monthly = asset.usefulLifeMonths > 0 ? depreciable / asset.usefulLifeMonths : 0;
  return Math.round(monthly * 100) / 100;
}

// Run depreciation for one period. Idempotent on (asset, periodLabel).
export async function runDepreciation(principal: Principal, clubId: string, periodLabel: string) {
  requirePermission(principal, clubId, "assets:depreciate");
  // Resolve the period.
  const period = await prisma.fiscalPeriod.findFirst({ where: { clubId, label: periodLabel } });
  if (!period) throw new ConflictError(`Unknown period ${periodLabel}`);
  const periodEnd = period.endDate;

  const assets = await prisma.capitalAsset.findMany({
    where: { clubId, status: "ACTIVE" },
    include: { category: { include: { assetAccount: true, accumulatedDepreciationAccount: true, depreciationExpenseAccount: true } } },
  });

  let posted = 0;
  for (const a of assets) {
    // Skip if already depreciated for this period.
    const existing = await prisma.assetDepreciationEntry.findUnique({
      where: { assetId_periodLabel: { assetId: a.id, periodLabel } },
    });
    if (existing) continue;

    const amount = monthlyDepreciation(a);
    if (amount <= 0) continue;

    // Cap depreciation at remaining NBV.
    const remaining = Math.max(0, Number(a.acquisitionCost.toString()) - Number(a.accumulatedDepreciation.toString()) - Number(a.residualValue.toString()));
    const cappedAmount = Math.min(amount, remaining);
    if (cappedAmount <= 0) {
      await prisma.capitalAsset.update({ where: { id: a.id }, data: { status: "FULLY_DEPRECIATED" } });
      continue;
    }
    const newAccumulated = Math.round((Number(a.accumulatedDepreciation.toString()) + cappedAmount) * 100) / 100;
    const newNBV = Math.round((Number(a.acquisitionCost.toString()) - newAccumulated) * 100) / 100;

    const expenseAccount = a.category?.depreciationExpenseAccount?.accountNumber ?? "6900";
    const accumulatedAccount = a.category?.accumulatedDepreciationAccount?.accountNumber ?? "1545";

    const journal = await createPostedFromAdapter(
      principal, clubId,
      {
        entryDate: periodEnd,
        description: `Depreciation · ${a.assetNumber} · ${periodLabel}`,
        lines: [
          { accountNumber: expenseAccount, debit: cappedAmount.toFixed(2), description: `Monthly depreciation ${a.name}` },
          { accountNumber: accumulatedAccount, credit: cappedAmount.toFixed(2), description: `Accumulated depreciation ${a.name}` },
        ],
      },
      { source: "RECURRING", sourceEntityType: "AssetDepreciation", sourceEntityId: `${a.id}:${periodLabel}` }
    );
    await prisma.assetDepreciationEntry.create({
      data: {
        clubId, assetId: a.id, periodLabel, periodEnd, amount: cappedAmount, accumulatedAfter: newAccumulated,
        postedJournalEntryId: journal.id, postedByUserId: principal.id,
      },
    });
    await prisma.capitalAsset.update({
      where: { id: a.id },
      data: {
        accumulatedDepreciation: newAccumulated,
        netBookValue: newNBV,
        status: newNBV <= Number(a.residualValue.toString()) + 0.005 ? "FULLY_DEPRECIATED" : "ACTIVE",
      },
    });
    posted++;
  }
  await audit(principal, { action: "asset.depreciation.run", entityType: "FiscalPeriod", entityId: period.id, clubId, after: { periodLabel, assetsPosted: posted } });
  return { posted };
}

// Disposal — books proceeds and the corresponding gain/loss.
export const disposalSchema = z.object({
  disposalDate: z.string().or(z.date()),
  method: z.enum(["SALE", "SCRAP", "DONATION"]).default("SALE"),
  proceeds: z.number().nonnegative().default(0),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export async function disposeAsset(principal: Principal, assetId: string, raw: unknown) {
  const asset = await prisma.capitalAsset.findUnique({
    where: { id: assetId },
    include: { category: { include: { assetAccount: true, accumulatedDepreciationAccount: true } } },
  });
  assertTenantOwned(asset, principal);
  requirePermission(principal, asset.clubId, "assets:dispose");
  if (asset.status === "DISPOSED") throw new ConflictError("Asset already disposed");

  const parsed = disposalSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const disposalDate = new Date(d.disposalDate);
  const cost = Number(asset.acquisitionCost.toString());
  const accumulated = Number(asset.accumulatedDepreciation.toString());
  const bookValue = Math.round((cost - accumulated) * 100) / 100;
  const proceeds = d.proceeds;
  const gainLoss = Math.round((proceeds - bookValue) * 100) / 100;

  const assetAccount = asset.category?.assetAccount?.accountNumber ?? "1540";
  const accumulatedAccount = asset.category?.accumulatedDepreciationAccount?.accountNumber ?? "1545";

  type Line = { accountNumber: string; debit?: string; credit?: string; description?: string | null };
  const lines: Line[] = [];
  if (proceeds > 0) lines.push({ accountNumber: "1010", debit: proceeds.toFixed(2), description: `Disposal proceeds for ${asset.assetNumber}` });
  if (accumulated > 0) lines.push({ accountNumber: accumulatedAccount, debit: accumulated.toFixed(2), description: "Reverse accumulated depreciation" });
  lines.push({ accountNumber: assetAccount, credit: cost.toFixed(2), description: `Remove asset ${asset.assetNumber}` });
  // Gain or loss
  if (gainLoss > 0) {
    lines.push({ accountNumber: "4900", credit: gainLoss.toFixed(2), description: "Gain on disposal" });
  } else if (gainLoss < 0) {
    lines.push({ accountNumber: "6500", debit: Math.abs(gainLoss).toFixed(2), description: "Loss on disposal" });
  }

  if (!(await findPeriodForDate(asset.clubId, disposalDate))) {
    throw new ConflictError("No fiscal period for disposal date");
  }

  const journal = await createPostedFromAdapter(
    principal, asset.clubId,
    { entryDate: disposalDate, description: `Asset disposal · ${asset.assetNumber}`, lines },
    { source: "RECURRING", sourceEntityType: "AssetDisposal", sourceEntityId: asset.id }
  );
  const disposal = await prisma.assetDisposal.create({
    data: {
      clubId: asset.clubId, assetId: asset.id, disposalDate, method: d.method,
      proceeds, bookValueAtDisposal: bookValue, gainLoss,
      notes: d.notes ?? null,
      postedJournalEntryId: journal.id, postedByUserId: principal.id,
    },
  });
  await prisma.capitalAsset.update({ where: { id: asset.id }, data: { status: "DISPOSED", netBookValue: 0 } });
  await audit(principal, { action: "asset.dispose", entityType: "CapitalAsset", entityId: asset.id, clubId: asset.clubId, after: { proceeds, gainLoss, journalEntryId: journal.id } });
  return disposal;
}

export async function listAssets(principal: Principal, clubId: string) {
  return prisma.capitalAsset.findMany({
    where: tenantWhere(principal, clubId),
    include: { category: true, department: true, location: true },
    orderBy: { assetNumber: "asc" },
  });
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
void toMoney;
