// Chart of Accounts service.
//
// All COA mutations go through here so accounts get correct normalBalance
// derivation, tenant scoping, and audit logging. The default golf-club COA
// shipped in DEFAULT_COA is the starting template — see seedDefaultChartOfAccounts.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { ACCOUNT_TYPES, normalBalanceFor, type AccountType, FS_STATEMENTS } from "./types";
import { normaliseAccountName } from "../imports";
import {
  assertFundApplicability,
  defaultFundApplicabilityStringForAccount,
  parseFundApplicability,
  serializeFundApplicability,
} from "./fund-applicability";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
export const createAccountSchema = z.object({
  accountNumber: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  type: z.enum(ACCOUNT_TYPES),
  categoryKey: z.string().trim().max(80).optional().nullable(),
  parentAccountNumber: z.string().trim().max(40).optional().nullable(),
  isHeader: z.boolean().default(false),
  allowManualPosting: z.boolean().default(true),
  isControlAccount: z.boolean().default(false),
  isBankAccount: z.boolean().default(false),
  isCashAccount: z.boolean().default(false),
  isTaxRelevant: z.boolean().default(false),
  fsGroupKey: z.string().trim().max(80).optional().nullable(),
  defaultDepartmentCode: z.string().trim().max(40).optional().nullable(),
  sortOrder: z.number().int().optional(),
  // Founder rule 2026-07-02 v15.0 — Fund Applicability.
  // Accepted forms:
  //   • `null` / `undefined` — service layer will DERIVE from FS
  //     Group for P&L accounts; leaves BS-side accounts null.
  //   • `string[]` — canonical token array (`["OPERATING","CAPITAL"]`).
  //   • `string`   — legacy CSV form (`"OPERATING,CAPITAL"`).
  // Validation ensures every token is a known FundKey; empty
  // strings normalise to null. Storage on `Account` is the
  // canonical CSV form.
  fundApplicability: z
    .union([z.string(), z.array(z.string())])
    // Validate BEFORE canonicalising so unknown tokens surface as
    // a real error rather than being silently dropped. Assert
    // works on both the string and the array form.
    .superRefine((v, ctx) => {
      const raw = Array.isArray(v) ? v.join(",") : v;
      try { assertFundApplicability(raw); }
      catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err instanceof Error ? err.message : "Unknown fund key",
        });
      }
    })
    // Canonicalise the caller's input to the CSV form the DB
    // stores (empty set → null). Unknown tokens have already
    // been rejected above.
    .transform((v) => {
      if (Array.isArray(v)) return serializeFundApplicability(parseFundApplicability(v.join(",")));
      return serializeFundApplicability(parseFundApplicability(v));
    })
    .optional()
    .nullable(),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

// ---------------------------------------------------------------------------
// Account CRUD
// ---------------------------------------------------------------------------
export type AccountCreateResult = {
  account: Awaited<ReturnType<typeof prisma.account.create>>;
  warnings: string[];
};

export async function createAccount(
  principal: Principal,
  clubId: string,
  raw: unknown,
): Promise<AccountCreateResult> {
  requirePermission(principal, clubId, "coa:write");
  const parsed = createAccountSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);

  // Founder rule 2026-06-30 v13 — duplicate-NUMBER is a HARD
  // error on the public create path. (The internal upsert path
  // is used by template seeders that legitimately upsert by key
  // — that path is not behind a permission check, so callers
  // can't reach it from the UI.)
  const existingByNum = await prisma.account.findFirst({
    where: { clubId, accountNumber: parsed.data.accountNumber },
  });
  if (existingByNum) {
    throw new ConflictError(
      `Account number ${parsed.data.accountNumber} is already used by ${existingByNum.name}. Account numbers must be unique within a club.`,
    );
  }

  // Duplicate-NAME is a SOFT warning, mirroring the v12 import-
  // side logic so manual + import paths agree.
  const warnings: string[] = [];
  const nameKey = normaliseAccountName(parsed.data.name);
  if (nameKey) {
    const others = await prisma.account.findMany({
      where: { clubId, isActive: true },
      select: { name: true, accountNumber: true },
    });
    const collision = others.find(
      (o) => normaliseAccountName(o.name) === nameKey && o.accountNumber !== parsed.data.accountNumber,
    );
    if (collision) {
      warnings.push(
        `An active account named '${parsed.data.name}' already exists (${collision.accountNumber}). Confirm these are intentionally separate accounts.`,
      );
    }
  }

  const account = await upsertAccountInternal(clubId, parsed.data, principal);
  return { account, warnings };
}

// Used by both createAccount and seedDefaultChartOfAccounts so the template
// path uses the exact same logic the admin UI would. Accepts the loose
// COAAccountDef shape (flags optional) — re-parses via Zod to apply defaults.
export async function upsertAccountInternal(
  clubId: string,
  rawData: unknown,
  principal: Principal | null
) {
  const re = createAccountSchema.safeParse(rawData);
  if (!re.success) throw zerr(re.error);
  const data = re.data;
  const dup = await prisma.account.findFirst({ where: { clubId, accountNumber: data.accountNumber } });
  let categoryId: string | null = null;
  if (data.categoryKey) {
    const cat = await prisma.accountCategory.findFirst({ where: { clubId, key: data.categoryKey } });
    if (!cat) throw new ConflictError(`Unknown account category: ${data.categoryKey}`);
    categoryId = cat.id;
  }
  let fsGroupId: string | null = null;
  if (data.fsGroupKey) {
    const g = await prisma.financialStatementGroup.findFirst({ where: { clubId, key: data.fsGroupKey } });
    if (!g) throw new ConflictError(`Unknown FS group: ${data.fsGroupKey}`);
    fsGroupId = g.id;
  }
  let parentAccountId: string | null = null;
  if (data.parentAccountNumber) {
    const p = await prisma.account.findFirst({ where: { clubId, accountNumber: data.parentAccountNumber } });
    if (!p) throw new ConflictError(`Unknown parent account: ${data.parentAccountNumber}`);
    if (p.type !== data.type) throw new ConflictError(`Parent account type ${p.type} does not match ${data.type}`);
    parentAccountId = p.id;
  }
  let defaultDepartmentId: string | null = null;
  if (data.defaultDepartmentCode) {
    const d = await prisma.department.findFirst({ where: { clubId, code: data.defaultDepartmentCode } });
    if (!d) throw new ConflictError(`Unknown department: ${data.defaultDepartmentCode}`);
    defaultDepartmentId = d.id;
  }

  const normalBalance = normalBalanceFor(data.type as AccountType);
  // Founder rule 2026-07-02 v15.0/v15.1 — Fund Applicability rules:
  //   • Only P&L accounts (REVENUE/EXPENSE) carry a fund tag.
  //   • Balance-sheet accounts REJECT any explicit fund value —
  //     that's an operator error, not a silent overwrite.
  //   • For a caller-provided value on a P&L account we use it
  //     verbatim (Zod already canonicalised the tokens).
  //   • When absent on a P&L account we derive from FS Group.
  //   • Non-P&L accounts always store null regardless of input.
  const isPL = data.type === "REVENUE" || data.type === "EXPENSE";
  if (!isPL && data.fundApplicability != null && String(data.fundApplicability).length > 0) {
    throw new ConflictError(
      `Fund Applicability applies only to Profit & Loss accounts. ${data.type} accounts must not carry a fund tag.`,
    );
  }
  const fundApplicability = !isPL
    ? null
    : data.fundApplicability !== undefined && data.fundApplicability !== null
      ? data.fundApplicability
      : defaultFundApplicabilityStringForAccount(
          data.type as AccountType,
          data.fsGroupKey ?? null,
        );
  const fields = {
    clubId,
    accountNumber: data.accountNumber,
    name: data.name,
    description: data.description ?? null,
    type: data.type,
    normalBalance,
    categoryId,
    fsGroupId,
    parentAccountId,
    defaultDepartmentId,
    isHeader: data.isHeader,
    allowManualPosting: data.allowManualPosting && !data.isHeader, // header => never postable
    isControlAccount: data.isControlAccount,
    isBankAccount: data.isBankAccount,
    isCashAccount: data.isCashAccount || data.isBankAccount,
    isTaxRelevant: data.isTaxRelevant,
    sortOrder: data.sortOrder ?? 0,
    fundApplicability,
  };

  const account = dup
    ? await prisma.account.update({ where: { id: dup.id }, data: fields })
    : await prisma.account.create({ data: fields });

  if (principal) {
    await audit(principal, {
      action: dup ? "coa.account.update" : "coa.account.create",
      entityType: "Account",
      entityId: account.id,
      clubId,
      before: dup ?? null,
      after: account,
    });
  }
  return account;
}

export async function archiveAccount(principal: Principal, accountId: string) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  assertTenantOwned(account, principal);
  requirePermission(principal, account.clubId, "coa:write");

  // Refuse if there's any posted activity. The audit trail requires that
  // accounts with history stay queryable; we mark inactive instead.
  const lineCount = await prisma.journalEntryLine.count({ where: { accountId } });
  const data = lineCount > 0
    ? { isActive: false, archivedAt: new Date() }
    : { isActive: false, archivedAt: new Date() };

  const updated = await prisma.account.update({ where: { id: accountId }, data });
  await audit(principal, {
    action: "coa.account.archive",
    entityType: "Account",
    entityId: accountId,
    clubId: account.clubId,
    before: { isActive: account.isActive },
    after: { isActive: false, hadActivity: lineCount > 0 },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// updateAccount — Founder rule 2026-06-30 v13.
// ---------------------------------------------------------------------------
// Production-grade post-import maintenance: clubs edit accounts after
// CSV import without needing to re-import. Reuses the same Zod schema +
// FK lookups as createAccount so manual + imported accounts follow ONE
// validation path (no parallel business logic). Cycle detection guards
// parent reassignment; duplicate-name warnings come from the shared v12
// `normaliseAccountName` helper. Type changes are blocked when posted
// journal lines exist — the normal balance derivation would otherwise
// silently flip the sign on every prior entry.
export const updateAccountSchema = createAccountSchema.partial().extend({
  // Active toggle — used by the UI "reactivate" affordance. Archive
  // goes through archiveAccount() (separate audit action); this is
  // the inverse path only.
  isActive: z.boolean().optional(),
});
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export type AccountUpdateResult = {
  account: Awaited<ReturnType<typeof prisma.account.update>>;
  warnings: string[];
};

export async function updateAccount(
  principal: Principal,
  accountId: string,
  raw: unknown,
): Promise<AccountUpdateResult> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  assertTenantOwned(account, principal);
  requirePermission(principal, account.clubId, "coa:write");

  const parsed = updateAccountSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const data = parsed.data;
  const clubId = account.clubId;
  const warnings: string[] = [];

  // 1. Unique account number — only check when the number changes.
  if (data.accountNumber && data.accountNumber !== account.accountNumber) {
    const collision = await prisma.account.findFirst({
      where: { clubId, accountNumber: data.accountNumber, NOT: { id: accountId } },
    });
    if (collision) {
      throw new ConflictError(
        `Account number ${data.accountNumber} is already used by ${collision.name}. Account numbers must be unique within a club.`,
      );
    }
  }

  // 2. Duplicate-name warning (NOT an error — clubs may legitimately
  //    have similar names across departments). Reuses the v12
  //    normalisation so manual + import paths agree.
  if (data.name && normaliseAccountName(data.name) !== normaliseAccountName(account.name)) {
    const nameKey = normaliseAccountName(data.name);
    const others = await prisma.account.findMany({
      where: { clubId, isActive: true, NOT: { id: accountId } },
      select: { name: true },
    });
    const collision = others.some((o) => normaliseAccountName(o.name) === nameKey);
    if (collision) {
      warnings.push(
        `An active account named '${data.name}' already exists. Confirm these are intentionally separate accounts.`,
      );
    }
  }

  // 3. FS group + Category FK resolution (same as create path).
  let categoryId: string | null | undefined;
  if (data.categoryKey !== undefined) {
    if (data.categoryKey === null || data.categoryKey === "") categoryId = null;
    else {
      const cat = await prisma.accountCategory.findFirst({ where: { clubId, key: data.categoryKey } });
      if (!cat) throw new ConflictError(`Unknown account category: ${data.categoryKey}`);
      categoryId = cat.id;
    }
  }
  let fsGroupId: string | null | undefined;
  if (data.fsGroupKey !== undefined) {
    if (data.fsGroupKey === null || data.fsGroupKey === "") fsGroupId = null;
    else {
      const g = await prisma.financialStatementGroup.findFirst({ where: { clubId, key: data.fsGroupKey } });
      if (!g) throw new ConflictError(`Unknown FS group: ${data.fsGroupKey}`);
      fsGroupId = g.id;
    }
  }
  let defaultDepartmentId: string | null | undefined;
  if (data.defaultDepartmentCode !== undefined) {
    if (data.defaultDepartmentCode === null || data.defaultDepartmentCode === "") defaultDepartmentId = null;
    else {
      const d = await prisma.department.findFirst({ where: { clubId, code: data.defaultDepartmentCode } });
      if (!d) throw new ConflictError(`Unknown department: ${data.defaultDepartmentCode}`);
      defaultDepartmentId = d.id;
    }
  }

  // 4. Parent resolution + cycle detection.
  let parentAccountId: string | null | undefined;
  if (data.parentAccountNumber !== undefined) {
    if (data.parentAccountNumber === null || data.parentAccountNumber === "") {
      parentAccountId = null;
    } else {
      const p = await prisma.account.findFirst({ where: { clubId, accountNumber: data.parentAccountNumber } });
      if (!p) throw new ConflictError(`Unknown parent account: ${data.parentAccountNumber}`);
      if (p.id === accountId) throw new ConflictError("An account cannot be its own parent.");
      // Resolve effective type — if the caller changed type on this
      // same update, validate against the NEW type. Otherwise the
      // existing type.
      const effectiveType = data.type ?? account.type;
      if (p.type !== effectiveType) {
        throw new ConflictError(`Parent account type ${p.type} does not match ${effectiveType}.`);
      }
      // Walk the proposed parent's ancestor chain. If accountId
      // appears, assigning it would create a cycle.
      let cursor: { id: string; parentAccountId: string | null } | null = p;
      const seen = new Set<string>();
      while (cursor && cursor.parentAccountId) {
        if (cursor.parentAccountId === accountId) {
          throw new ConflictError(
            "Assigning this parent would create a circular parent-child relationship.",
          );
        }
        if (seen.has(cursor.parentAccountId)) break; // safety: pre-existing cycle, don't infinite-loop
        seen.add(cursor.parentAccountId);
        cursor = await prisma.account.findUnique({
          where: { id: cursor.parentAccountId },
          select: { id: true, parentAccountId: true },
        });
      }
      parentAccountId = p.id;
    }
  }

  // 5. Type change safety — block when posted journal lines exist
  //    (would silently flip the sign on every prior entry).
  if (data.type && data.type !== account.type) {
    const lineCount = await prisma.journalEntryLine.count({ where: { accountId } });
    if (lineCount > 0) {
      throw new ConflictError(
        `Cannot change account type: ${lineCount} posted journal line${lineCount === 1 ? "" : "s"} would have inconsistent normal balance. Archive this account and create a new one if a different type is needed.`,
      );
    }
  }

  // 6. Build patch + normalBalance derivation.
  const fields: Record<string, unknown> = {};
  if (data.accountNumber !== undefined) fields.accountNumber = data.accountNumber;
  if (data.name !== undefined) fields.name = data.name;
  if (data.description !== undefined) fields.description = data.description ?? null;
  if (data.type !== undefined) {
    fields.type = data.type;
    fields.normalBalance = normalBalanceFor(data.type as AccountType);
  }
  if (categoryId !== undefined) fields.categoryId = categoryId;
  if (fsGroupId !== undefined) fields.fsGroupId = fsGroupId;
  if (parentAccountId !== undefined) fields.parentAccountId = parentAccountId;
  if (defaultDepartmentId !== undefined) fields.defaultDepartmentId = defaultDepartmentId;
  if (data.isHeader !== undefined) fields.isHeader = data.isHeader;
  if (data.allowManualPosting !== undefined) {
    fields.allowManualPosting = data.allowManualPosting && !(data.isHeader ?? account.isHeader);
  }
  if (data.isControlAccount !== undefined) fields.isControlAccount = data.isControlAccount;
  if (data.isBankAccount !== undefined) {
    fields.isBankAccount = data.isBankAccount;
    if (data.isBankAccount) fields.isCashAccount = true;
  }
  if (data.isCashAccount !== undefined && data.isBankAccount === undefined) {
    fields.isCashAccount = data.isCashAccount;
  }
  if (data.isTaxRelevant !== undefined) fields.isTaxRelevant = data.isTaxRelevant;
  if (data.sortOrder !== undefined) fields.sortOrder = data.sortOrder;
  // Founder rule 2026-07-02 v15.1 — Fund Applicability edit path.
  // The Zod schema already canonicalised the payload; here we
  // just write the resolved value (including explicit `null` to
  // clear the field). The service NEVER derives a default from
  // the FS Group during update — the founder principle is that
  // manual edits always take precedence. Balance-sheet accounts
  // REJECT any non-null fund tag (same rule as the create path).
  if (data.fundApplicability !== undefined) {
    const effectiveType = data.type ?? account.type;
    const isPL = effectiveType === "REVENUE" || effectiveType === "EXPENSE";
    if (!isPL && data.fundApplicability != null && String(data.fundApplicability).length > 0) {
      throw new ConflictError(
        `Fund Applicability applies only to Profit & Loss accounts. ${effectiveType} accounts must not carry a fund tag.`,
      );
    }
    fields.fundApplicability = isPL ? (data.fundApplicability ?? null) : null;
  }
  if (data.isActive !== undefined) {
    fields.isActive = data.isActive;
    // Reactivating clears archivedAt; deactivating sets it.
    fields.archivedAt = data.isActive ? null : new Date();
  }

  const updated = await prisma.account.update({ where: { id: accountId }, data: fields });
  await audit(principal, {
    action: "coa.account.update",
    entityType: "Account",
    entityId: accountId,
    clubId,
    before: account,
    after: updated,
  });
  return { account: updated, warnings };
}

// ---------------------------------------------------------------------------
// Safe-delete dependency scan + hard delete.
// ---------------------------------------------------------------------------
// 24+ cross-references can pin an Account. The scan reports every
// blocker so the UI can show the operator EXACTLY why archive is
// the safer path. Each blocker carries a kind, count, and a copy
// string the modal renders as a bullet point.
export type DeletionBlocker = { kind: string; count: number; message: string };
export type DeletionSafety = {
  canDelete: boolean;
  blockers: DeletionBlocker[];
};

export async function checkAccountDeletionSafety(
  principal: Principal,
  accountId: string,
): Promise<DeletionSafety> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  assertTenantOwned(account, principal);
  requirePermission(principal, account.clubId, "coa:write");
  const clubId = account.clubId;
  const blockers: DeletionBlocker[] = [];

  // Run every count in parallel — they're independent reads.
  const [
    journalLines, apInvoiceLines, vendors, budgetLines, forecastLines,
    invCat1, invCat2, invCat3, invCat4,
    invItem1, invItem2, invItem3,
    eventCats, peRev, peDef, lessonRev, lessonExp,
    assetCat1, assetCat2, assetCat3,
    posLines, tournaments, taxRec, taxPay, paymentBank,
    children, openingLines, profile,
  ] = await Promise.all([
    prisma.journalEntryLine.count({ where: { accountId } }),
    prisma.aPInvoiceLine.count({ where: { expenseAccountId: accountId } }),
    prisma.vendor.count({ where: { defaultExpenseAccountId: accountId } }),
    prisma.budgetLine.count({ where: { accountId } }),
    prisma.forecastLine.count({ where: { accountId } }),
    prisma.inventoryCategory.count({ where: { inventoryAccountId: accountId } }),
    prisma.inventoryCategory.count({ where: { cogsAccountId: accountId } }),
    prisma.inventoryCategory.count({ where: { revenueAccountId: accountId } }),
    prisma.inventoryCategory.count({ where: { adjustmentExpenseAccountId: accountId } }),
    prisma.inventoryItem.count({ where: { inventoryAccountId: accountId } }),
    prisma.inventoryItem.count({ where: { cogsAccountId: accountId } }),
    prisma.inventoryItem.count({ where: { revenueAccountId: accountId } }),
    prisma.eventCategory.count({ where: { defaultRevenueAccountId: accountId } }),
    prisma.privateEventBooking.count({ where: { revenueAccountId: accountId } }),
    prisma.privateEventBooking.count({ where: { deferredRevenueAccountId: accountId } }),
    prisma.lessonType.count({ where: { revenueAccountId: accountId } }),
    prisma.lessonType.count({ where: { instructorExpenseAccountId: accountId } }),
    prisma.assetCategory.count({ where: { assetAccountId: accountId } }),
    prisma.assetCategory.count({ where: { accumulatedDepreciationAccountId: accountId } }),
    prisma.assetCategory.count({ where: { depreciationExpenseAccountId: accountId } }),
    prisma.pOSSaleLine.count({ where: { revenueAccountId: accountId } }),
    prisma.tournament.count({ where: { revenueAccountId: accountId } }),
    prisma.taxCode.count({ where: { recoverableAccountId: accountId } }),
    prisma.taxCode.count({ where: { payableAccountId: accountId } }),
    prisma.paymentBatch.count({ where: { bankAccountId: accountId } }),
    prisma.account.count({ where: { parentAccountId: accountId } }),
    // OpeningBalanceLine is not a separate model in the current
    // schema — opening balances flow through ImportBatch +
    // JournalEntries (already counted via journal_lines above).
    Promise.resolve(0),
    prisma.clubProfile.findUnique({ where: { clubId } }),
  ]);

  const add = (kind: string, count: number, message: string) => {
    if (count > 0) blockers.push({ kind, count, message });
  };
  add("journal_lines", journalLines, `${journalLines} posted journal line${journalLines === 1 ? "" : "s"}`);
  add("ap_invoice_lines", apInvoiceLines, `${apInvoiceLines} A/P invoice line${apInvoiceLines === 1 ? "" : "s"}`);
  add("vendors", vendors, `${vendors} vendor${vendors === 1 ? "" : "s"} using this as default expense account`);
  add("budget_lines", budgetLines, `${budgetLines} budget line${budgetLines === 1 ? "" : "s"}`);
  add("forecast_lines", forecastLines, `${forecastLines} forecast line${forecastLines === 1 ? "" : "s"}`);
  add("inventory_category_inventory", invCat1, `${invCat1} inventory categor${invCat1 === 1 ? "y" : "ies"} (inventory acct)`);
  add("inventory_category_cogs", invCat2, `${invCat2} inventory categor${invCat2 === 1 ? "y" : "ies"} (COGS acct)`);
  add("inventory_category_revenue", invCat3, `${invCat3} inventory categor${invCat3 === 1 ? "y" : "ies"} (revenue acct)`);
  add("inventory_category_adjustment", invCat4, `${invCat4} inventory categor${invCat4 === 1 ? "y" : "ies"} (adjustment acct)`);
  add("inventory_item_inventory", invItem1, `${invItem1} inventory item${invItem1 === 1 ? "" : "s"} (inventory acct)`);
  add("inventory_item_cogs", invItem2, `${invItem2} inventory item${invItem2 === 1 ? "" : "s"} (COGS acct)`);
  add("inventory_item_revenue", invItem3, `${invItem3} inventory item${invItem3 === 1 ? "" : "s"} (revenue acct)`);
  add("event_categories", eventCats, `${eventCats} event categor${eventCats === 1 ? "y" : "ies"}`);
  add("private_event_revenue", peRev, `${peRev} private event booking${peRev === 1 ? "" : "s"} (revenue)`);
  add("private_event_deferred", peDef, `${peDef} private event booking${peDef === 1 ? "" : "s"} (deferred revenue)`);
  add("lesson_type_revenue", lessonRev, `${lessonRev} lesson type${lessonRev === 1 ? "" : "s"} (revenue)`);
  add("lesson_type_expense", lessonExp, `${lessonExp} lesson type${lessonExp === 1 ? "" : "s"} (expense)`);
  add("asset_category_asset", assetCat1, `${assetCat1} asset categor${assetCat1 === 1 ? "y" : "ies"} (asset acct)`);
  add("asset_category_accum_depr", assetCat2, `${assetCat2} asset categor${assetCat2 === 1 ? "y" : "ies"} (accum. depr. acct)`);
  add("asset_category_depr_expense", assetCat3, `${assetCat3} asset categor${assetCat3 === 1 ? "y" : "ies"} (depr. expense acct)`);
  add("pos_sale_lines", posLines, `${posLines} POS sale line${posLines === 1 ? "" : "s"}`);
  add("tournaments", tournaments, `${tournaments} tournament${tournaments === 1 ? "" : "s"}`);
  add("tax_recoverable", taxRec, `${taxRec} tax code${taxRec === 1 ? "" : "s"} (recoverable acct)`);
  add("tax_payable", taxPay, `${taxPay} tax code${taxPay === 1 ? "" : "s"} (payable acct)`);
  add("payment_batch_bank", paymentBank, `${paymentBank} payment batch${paymentBank === 1 ? "" : "es"} (bank acct)`);
  add("child_accounts", children, `${children} child account${children === 1 ? "" : "s"}`);
  add("opening_balance_lines", openingLines, `${openingLines} opening balance line${openingLines === 1 ? "" : "s"}`);

  // ClubProfile control-account references — 8 fields. Each carries
  // a distinct workflow significance, so report them individually.
  if (profile) {
    const p = profile as unknown as Record<string, string | null | undefined>;
    const profileFields: Array<[string, string]> = [
      ["defaultArAccountId", "default A/R account"],
      ["defaultApAccountId", "default A/P account"],
      ["defaultRetainedEarningsAccountId", "default retained-earnings account"],
      ["defaultCurrentYearEarningsAccountId", "default current-year-earnings account"],
      ["defaultOperatingBankAccountId", "default operating bank account"],
      ["defaultReserveBankAccountId", "default reserve bank account"],
      ["defaultMemberReceivablesAccountId", "default member-receivables account"],
      ["defaultSalesTaxPayableAccountId", "default sales tax payable account"],
    ];
    for (const [field, label] of profileFields) {
      if (p[field] === accountId) {
        blockers.push({ kind: `control_${field}`, count: 1, message: `Used as ${label}` });
      }
    }
  }

  return { canDelete: blockers.length === 0, blockers };
}

export async function deleteAccount(principal: Principal, accountId: string) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  assertTenantOwned(account, principal);
  requirePermission(principal, account.clubId, "coa:write");

  const safety = await checkAccountDeletionSafety(principal, accountId);
  if (!safety.canDelete) {
    throw new ConflictError(
      `Cannot delete account ${account.accountNumber} (${account.name}). ${safety.blockers.length} blocker${safety.blockers.length === 1 ? "" : "s"}: ${safety.blockers.map((b) => b.message).join("; ")}. Archive instead.`,
    );
  }

  await prisma.account.delete({ where: { id: accountId } });
  await audit(principal, {
    action: "coa.account.delete",
    entityType: "Account",
    entityId: accountId,
    clubId: account.clubId,
    before: account,
    after: null,
  });
  return { deleted: true, accountNumber: account.accountNumber };
}

// ---------------------------------------------------------------------------
// Category & FS group seeders (used by templates and admin UI alike)
// ---------------------------------------------------------------------------
export async function upsertCategory(clubId: string, c: { key: string; name: string; type: AccountType; sortOrder?: number }) {
  return prisma.accountCategory.upsert({
    where: { clubId_key: { clubId, key: c.key } },
    update: { name: c.name, type: c.type, sortOrder: c.sortOrder ?? 0 },
    create: { clubId, key: c.key, name: c.name, type: c.type, sortOrder: c.sortOrder ?? 0 },
  });
}

export async function upsertFsGroup(
  clubId: string,
  g: { key: string; name: string; statement: (typeof FS_STATEMENTS)[number]; cashFlowSection?: string | null; parentKey?: string | null; sortOrder?: number }
) {
  let parentGroupId: string | null = null;
  if (g.parentKey) {
    const p = await prisma.financialStatementGroup.findFirst({ where: { clubId, key: g.parentKey } });
    if (!p) throw new ConflictError(`Unknown parent FS group: ${g.parentKey}`);
    parentGroupId = p.id;
  }
  return prisma.financialStatementGroup.upsert({
    where: { clubId_key: { clubId, key: g.key } },
    update: { name: g.name, statement: g.statement, cashFlowSection: g.cashFlowSection ?? null, parentGroupId, sortOrder: g.sortOrder ?? 0 },
    create: {
      clubId, key: g.key, name: g.name, statement: g.statement,
      cashFlowSection: g.cashFlowSection ?? null, parentGroupId, sortOrder: g.sortOrder ?? 0,
    },
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function listAccounts(principal: Principal, clubId: string, opts?: { includeArchived?: boolean }) {
  return prisma.account.findMany({
    where: {
      ...tenantWhere(principal, clubId),
      ...(opts?.includeArchived ? {} : { isActive: true }),
    },
    include: { parent: true, category: true, fsGroup: true, defaultDepartment: true },
    orderBy: [{ accountNumber: "asc" }],
  });
}

export async function getAccountByNumber(clubId: string, accountNumber: string) {
  const account = await prisma.account.findFirst({ where: { clubId, accountNumber } });
  if (!account) throw new NotFoundError("Account", accountNumber);
  return account;
}

/**
 * Founder rule 2026-07-19: align this club's accounting
 * taxonomy with Spectre's permanent canonical framework. The
 * helper:
 *
 *   1. Upserts every canonical Category from
 *      `DEFAULT_CATEGORIES` and every canonical FS Group from
 *      `DEFAULT_FS_GROUPS`.
 *   2. Walks every Account on this club whose Category or FS
 *      Group key is in the legacy maps and re-points it to the
 *      canonical equivalent.
 *   3. Deletes the legacy Category + FS Group rows once no
 *      Account references them.
 *
 * Idempotent. Tenant-scoped. Returns counts so the caller (a
 * one-shot script or a controlled re-sync) can report the
 * impact.
 */
export async function syncCanonicalAccountingTaxonomy(clubId: string): Promise<{
  categoriesUpserted: number;
  fsGroupsUpserted: number;
  accountsRetargeted: number;
  legacyFsGroupsRemoved: number;
  legacyCategoriesRemoved: number;
}> {
  const {
    DEFAULT_CATEGORIES,
    DEFAULT_FS_GROUPS,
    LEGACY_FS_GROUP_MIGRATION,
    LEGACY_CATEGORY_MIGRATION,
    RETIRED_FS_GROUP_KEYS,
  } = await import("./coa-template");

  let categoriesUpserted = 0;
  for (const c of DEFAULT_CATEGORIES) {
    await upsertCategory(clubId, c);
    categoriesUpserted++;
  }
  let fsGroupsUpserted = 0;
  for (const g of DEFAULT_FS_GROUPS) {
    await upsertFsGroup(clubId, g);
    fsGroupsUpserted++;
  }

  // Build key→id maps for both axes so the per-account update
  // can resolve targets in one shot.
  const categoryRows = await prisma.accountCategory.findMany({ where: { clubId } });
  const categoryIdByKey = new Map(categoryRows.map((c) => [c.key, c.id] as const));
  const fsGroupRows = await prisma.financialStatementGroup.findMany({ where: { clubId } });
  const fsGroupIdByKey = new Map(fsGroupRows.map((g) => [g.key, g.id] as const));

  // Walk accounts: any whose current fsGroup key is in
  // LEGACY_FS_GROUP_MIGRATION OR whose category key is in
  // LEGACY_CATEGORY_MIGRATION gets re-targeted in one update.
  // We fetch only the rows that might need an update via the
  // legacy-key list — the rest are already on canonical keys.
  const legacyFsKeys = Object.keys(LEGACY_FS_GROUP_MIGRATION);
  const legacyCatKeys = Object.keys(LEGACY_CATEGORY_MIGRATION);
  const candidates = await prisma.account.findMany({
    where: {
      clubId,
      OR: [
        { fsGroup: { key: { in: legacyFsKeys } } },
        { category: { key: { in: legacyCatKeys } } },
      ],
    },
    include: { fsGroup: true, category: true },
  });

  let accountsRetargeted = 0;
  for (const a of candidates) {
    const data: { fsGroupId?: string; categoryId?: string } = {};

    // FS Group remap (and capture the recommended new category).
    if (a.fsGroup && legacyFsKeys.includes(a.fsGroup.key)) {
      const map = LEGACY_FS_GROUP_MIGRATION[a.fsGroup.key];
      const newFsId = fsGroupIdByKey.get(map.newFsGroupKey);
      const newCatId = categoryIdByKey.get(map.newCategoryKey);
      if (newFsId) data.fsGroupId = newFsId;
      if (newCatId) data.categoryId = newCatId;
    } else if (a.category && legacyCatKeys.includes(a.category.key)) {
      // No FS group remap, but the category itself is legacy.
      const newCatKey = LEGACY_CATEGORY_MIGRATION[a.category.key];
      const newCatId = categoryIdByKey.get(newCatKey);
      if (newCatId) data.categoryId = newCatId;
    }

    if (data.fsGroupId == null && data.categoryId == null) continue;
    // Skip when the resolved ids match what's already on the row
    // — this keeps the migration truly count-idempotent on rerun
    // (the self-mapping entries like BS_OTHER_ASSETS → BS_OTHER_ASSETS
    // are deliberate so the Category re-anchors on first run, but
    // once they're aligned we don't need to write again).
    if (
      (data.fsGroupId == null || data.fsGroupId === a.fsGroupId) &&
      (data.categoryId == null || data.categoryId === a.categoryId)
    ) {
      continue;
    }
    await prisma.account.update({ where: { id: a.id }, data });
    accountsRetargeted++;
  }

  // Soft GC: drop legacy FS Group + Category rows that no
  // Account still references. (Other tables that point at FS
  // Group / Category — none today — would block this; the
  // try/catch ensures we don't hard-fail the migration if a
  // future schema adds such a reference.)
  let legacyFsGroupsRemoved = 0;
  for (const key of RETIRED_FS_GROUP_KEYS) {
    try {
      const result = await prisma.financialStatementGroup.deleteMany({
        where: { clubId, key },
      });
      legacyFsGroupsRemoved += result.count;
    } catch {
      // Referenced by something else — leave it; the canonical
      // upsert kept the canonical entries in place anyway.
    }
  }
  let legacyCategoriesRemoved = 0;
  for (const key of legacyCatKeys) {
    try {
      const result = await prisma.accountCategory.deleteMany({
        where: { clubId, key },
      });
      legacyCategoriesRemoved += result.count;
    } catch {
      // Same fallback.
    }
  }

  return {
    categoriesUpserted,
    fsGroupsUpserted,
    accountsRetargeted,
    legacyFsGroupsRemoved,
    legacyCategoriesRemoved,
  };
}

/**
 * @deprecated 2026-07-19 — superseded by
 * `syncCanonicalAccountingTaxonomy`. The prior helper only
 * touched three FS Group rows; the canonical sync handles the
 * full taxonomy. Kept as a thin alias so the existing
 * `scripts/sync-fs-group-taxonomy.ts` keeps working until the
 * one-shot is no longer needed.
 */
export async function syncFsGroupTaxonomy(clubId: string): Promise<{
  renamedOther: boolean;
  addedIncomeTax: boolean;
  addedPropertyTax: boolean;
}> {
  const before = await prisma.financialStatementGroup.findMany({
    where: { clubId, key: { in: ["IS_OPEX_OTHER", "IS_OPEX_INCOME_TAX", "IS_OPEX_PROPERTY_TAX"] } },
    select: { key: true, name: true },
  });
  const beforeMap = new Map(before.map((g) => [g.key, g] as const));
  const existingOther = beforeMap.get("IS_OPEX_OTHER");
  const renamedOther =
    existingOther != null && existingOther.name !== "Other Expenses";
  const addedIncomeTax = !beforeMap.has("IS_OPEX_INCOME_TAX");
  const addedPropertyTax = !beforeMap.has("IS_OPEX_PROPERTY_TAX");

  // Upsert with the latest template values. Sort orders match
  // DEFAULT_FS_GROUPS so the dropdown sequence matches.
  await upsertFsGroup(clubId, {
    key: "IS_OPEX_INCOME_TAX",
    name: "Income Tax Expense",
    statement: "INCOME_STATEMENT",
    sortOrder: 50,
  });
  await upsertFsGroup(clubId, {
    key: "IS_OPEX_PROPERTY_TAX",
    name: "Property Tax Expense",
    statement: "INCOME_STATEMENT",
    sortOrder: 51,
  });
  await upsertFsGroup(clubId, {
    key: "IS_OPEX_OTHER",
    name: "Other Expenses",
    statement: "INCOME_STATEMENT",
    sortOrder: 52,
  });
  return { renamedOther, addedIncomeTax, addedPropertyTax };
}

/**
 * Founder spec 2026-07-08: the legacy isHeader concept is gone.
 * This helper converts every legacy "header" row on a club's COA
 * into a normal posting account. It is idempotent — safe to run
 * repeatedly. Returns the number of rows converted so callers can
 * report on the cleanup.
 *
 * What changes per converted row:
 *   • isHeader            : true → false
 *   • allowManualPosting  : false → true (re-enabling posting)
 *
 * What does NOT change:
 *   • Account row itself — never deleted, FK references survive.
 *   • Children pointing at the (now-former) header via
 *     `parentAccountId` — left intact so historical hierarchy
 *     still resolves.
 *   • Any non-header account on the COA.
 */
export async function clearLegacyHeaderFlags(clubId: string): Promise<number> {
  const result = await prisma.account.updateMany({
    where: { clubId, isHeader: true },
    data: { isHeader: false, allowManualPosting: true },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
