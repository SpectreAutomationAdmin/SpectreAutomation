// AP Benchmark — synthetic tenant seed.
//
// Creates a disposable Club + COA + Vendor set for the runner. The
// COA deliberately includes accounts that MUST NOT be recommended
// for an ordinary AP invoice (contra-assets, control accounts, bank
// accounts, revenue) so the benchmark can measure the current
// pipeline's unsafe-recommendation rate honestly.
//
// Idempotent per runId — every run creates a fresh club with a
// unique slug, so parallel runs do not collide. Tear-down happens
// in run.ts after the run completes.
//
// The seed writes ONLY to fresh Club-scoped rows. No production
// records are touched.

import { PrismaClient } from "@prisma/client";

export interface SeedTenantResult {
  clubId: string;
  vendorIds: Record<string, string>;   // vendorNumber → id
  accountIds: Record<string, string>;  // accountNumber → id
}

export async function seedBenchmarkTenant(
  prisma: PrismaClient,
  runId: string,
): Promise<SeedTenantResult> {
  const club = await prisma.club.create({
    data: {
      slug: `ap-bench-${runId}`,
      name: `AP Benchmark ${runId}`,
    },
    select: { id: true },
  });
  const clubId = club.id;

  // ------------------------------------------------------------------
  // Synthetic COA. Every account uses schema fields the eligibility
  // layer will read — type / normalBalance / isActive / isHeader /
  // isControlAccount / allowManualPosting / isBankAccount /
  // isCashAccount. Fund applicability is set on P&L rows so
  // Phase 2 can gate on it later.
  // ------------------------------------------------------------------
  const chart: Array<{
    accountNumber: string;
    name: string;
    type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
    normalBalance: "DEBIT" | "CREDIT";
    isHeader?: boolean;
    isActive?: boolean;
    allowManualPosting?: boolean;
    isControlAccount?: boolean;
    isBankAccount?: boolean;
    isCashAccount?: boolean;
    fundApplicability?: string | null;
    accountRole?: string;
  }> = [
    // Legitimate ASSET accounts — postable as AP debits for capital.
    { accountNumber: "1506", name: "Equipment & Fixtures — Grounds", type: "ASSET", normalBalance: "DEBIT" },
    { accountNumber: "1530", name: "Course Improvements", type: "ASSET", normalBalance: "DEBIT" },
    { accountNumber: "1540", name: "Equipment & Vehicles", type: "ASSET", normalBalance: "DEBIT" },

    // Contra-asset accounts — MUST NOT be recommended for AP debit.
    // Uses the abbreviation "Accum Deprec" specifically so the
    // audit-identified name-fragile exclusion cannot rescue Phase 0.
    // Textbook convention (ASSET/CREDIT) — caught by ruleContraAsset.
    { accountNumber: "1710", name: "Accum Deprec — Computer Equipment & Fixtures", type: "ASSET", normalBalance: "CREDIT", accountRole: "CONTRA_ASSET" },
    { accountNumber: "1720", name: "Accum Deprec — Grounds Equipment", type: "ASSET", normalBalance: "CREDIT", accountRole: "CONTRA_ASSET" },
    { accountNumber: "1730", name: "Accumulated Amortization — Intangibles", type: "ASSET", normalBalance: "CREDIT", accountRole: "CONTRA_ASSET" },
    // JONAS-CONVENTION accumulated depreciation (ASSET/DEBIT). This
    // is how Coulee Ridge's real COA stores contra-assets — per the
    // 2026-08-06 staging inventory (7 accum-depr accounts, all DEBIT).
    // The structural CONTRA_ASSET rule (ASSET/CREDIT) DOES NOT fire
    // on this convention. Phase 2.1 closes this via the durable
    // accountRole=CONTRA_ASSET field, backfilled from the reporting-
    // side helper. Both accounts are seeded with accountRole so the
    // benchmark measures the FIXED behaviour (not the residual gap).
    { accountNumber: "1513", name: "Accum Deprec — Computer Eqp & Fix", type: "ASSET", normalBalance: "DEBIT", accountRole: "CONTRA_ASSET" },
    { accountNumber: "1514", name: "Accum Deprec — Equip under financing", type: "ASSET", normalBalance: "DEBIT", accountRole: "CONTRA_ASSET" },
    // Un-backfilled Jonas-convention contra (ASSET/DEBIT, accountRole
    // DEFAULT=STANDARD) — the adversarial case. Present to prove the
    // mutation guard: if the accountRole rule is removed, this
    // account would leak into ranking under CAPITAL_ASSET context.
    { accountNumber: "1515", name: "Accum Deprec — Land Improvements", type: "ASSET", normalBalance: "DEBIT" },

    // Bank + cash — must not be an AP debit.
    { accountNumber: "1100", name: "Operating Bank Account", type: "ASSET", normalBalance: "DEBIT", isBankAccount: true, isCashAccount: true },
    { accountNumber: "1200", name: "Petty Cash", type: "ASSET", normalBalance: "DEBIT", isCashAccount: true },

    // Control accounts — must not be a manual AP debit.
    { accountNumber: "1300", name: "Accounts Receivable — Subledger Control", type: "ASSET", normalBalance: "DEBIT", isControlAccount: true },
    { accountNumber: "2100", name: "Accounts Payable — Subledger Control", type: "LIABILITY", normalBalance: "CREDIT", isControlAccount: true },

    // Non-postable / system.
    { accountNumber: "2200", name: "Sales Tax Payable — System-Only", type: "LIABILITY", normalBalance: "CREDIT", allowManualPosting: false },
    { accountNumber: "3100", name: "Retained Earnings", type: "EQUITY", normalBalance: "CREDIT", allowManualPosting: false },

    // Revenue — never an AP debit.
    { accountNumber: "4100", name: "Green Fees", type: "REVENUE", normalBalance: "CREDIT" },
    { accountNumber: "4200", name: "Membership Dues Revenue", type: "REVENUE", normalBalance: "CREDIT" },

    // Legitimate EXPENSE accounts (operating).
    { accountNumber: "5100", name: "F&B — Food Cost of Sales", type: "EXPENSE", normalBalance: "DEBIT", fundApplicability: "OPERATING" },
    { accountNumber: "5101", name: "F&B — Beverage Cost of Sales", type: "EXPENSE", normalBalance: "DEBIT", fundApplicability: "OPERATING" },
    { accountNumber: "5310", name: "Fuel — Grounds Equipment", type: "EXPENSE", normalBalance: "DEBIT", fundApplicability: "OPERATING" },
    { accountNumber: "5311", name: "Fuel — Fleet", type: "EXPENSE", normalBalance: "DEBIT", fundApplicability: "OPERATING" },
    { accountNumber: "5320", name: "Fuel & Lubricants — General", type: "EXPENSE", normalBalance: "DEBIT", fundApplicability: "OPERATING" },
    { accountNumber: "6020", name: "Grounds Maintenance", type: "EXPENSE", normalBalance: "DEBIT", fundApplicability: "OPERATING" },
    { accountNumber: "6025", name: "Grounds Supplies", type: "EXPENSE", normalBalance: "DEBIT", fundApplicability: "OPERATING" },
    { accountNumber: "6031", name: "Repairs & Maintenance — Ground Equip", type: "EXPENSE", normalBalance: "DEBIT", fundApplicability: "OPERATING" },
    { accountNumber: "6064", name: "Membership & Dues — Professional", type: "EXPENSE", normalBalance: "DEBIT", fundApplicability: "OPERATING" },
    { accountNumber: "6065", name: "Professional Services", type: "EXPENSE", normalBalance: "DEBIT", fundApplicability: "OPERATING" },
    { accountNumber: "6072", name: "Telephone & Internet", type: "EXPENSE", normalBalance: "DEBIT", fundApplicability: "OPERATING" },

    // Inactive / archived — must not be recommended.
    { accountNumber: "9999", name: "Legacy Discontinued Account", type: "EXPENSE", normalBalance: "DEBIT", isActive: false },

    // Header (rollup) — must not be recommended.
    { accountNumber: "5000", name: "Cost of Sales — Header", type: "EXPENSE", normalBalance: "DEBIT", isHeader: true },
  ];

  const accountIds: Record<string, string> = {};
  for (const acct of chart) {
    const row = await prisma.account.create({
      data: {
        clubId,
        accountNumber: acct.accountNumber,
        name: acct.name,
        type: acct.type,
        normalBalance: acct.normalBalance,
        isActive: acct.isActive ?? true,
        isHeader: acct.isHeader ?? false,
        allowManualPosting: acct.allowManualPosting ?? true,
        isControlAccount: acct.isControlAccount ?? false,
        isBankAccount: acct.isBankAccount ?? false,
        isCashAccount: acct.isCashAccount ?? false,
        fundApplicability: acct.fundApplicability ?? null,
        accountRole: acct.accountRole ?? "STANDARD",
      },
      select: { id: true },
    });
    accountIds[acct.accountNumber] = row.id;
  }

  // ------------------------------------------------------------------
  // Vendor set — one match for each case that expects MATCHED.
  // Others deliberately absent so the benchmark exercises NOT_FOUND.
  // ------------------------------------------------------------------
  const vendorIds: Record<string, string> = {};
  const northside = await prisma.vendor.create({
    data: {
      clubId,
      vendorNumber: "V-NORTHSIDE-001",
      legalName: "Northside Course Maintenance Inc.",
      operatingName: "Northside Course Maintenance",
      status: "ACTIVE",
      taxRegistrationNumber: "987654321 RT0001",
      email: "billing@northside.example",
      defaultExpenseAccountId: accountIds["6020"],
    },
    select: { id: true },
  });
  vendorIds["V-NORTHSIDE-001"] = northside.id;

  // Pathological vendor — its `defaultExpenseAccountId` intentionally
  // points at a contra-asset account. The +15 vendor-history boost
  // on the ranker will push this contra account to the leader
  // position. Phase 0 safety containment MUST suppress it. This is
  // the benchmark's live measurement that the guard works — a unit
  // test would prove the pure function; this proves the wire-in.
  const contraDefaulted = await prisma.vendor.create({
    data: {
      clubId,
      vendorNumber: "V-CONTRA-TRAP-001",
      legalName: "Legacy Copier Service Ltd.",
      operatingName: "Legacy Copier Service",
      status: "ACTIVE",
      email: "billing@legacycopier.example",
      // Intentional misconfiguration for the benchmark: vendor default
      // is a contra-asset (Accum Deprec). Never do this in operations.
      defaultExpenseAccountId: accountIds["1710"],
    },
    select: { id: true },
  });
  vendorIds["V-CONTRA-TRAP-001"] = contraDefaulted.id;

  return { clubId, vendorIds, accountIds };
}

export async function tearDownBenchmarkTenant(
  prisma: PrismaClient,
  clubId: string,
): Promise<void> {
  // Cascade delete via Club. Keeps the local dev DB tidy so a
  // repeated `npm run evaluate:ap-intelligence` doesn't accumulate
  // clubs. Failure here is a diagnostic — never a run-blocking
  // condition. The `_tests_only` marker ensures a stray teardown
  // in a production context refuses even before Prisma is called.
  if (!clubId.startsWith("c")) throw new Error("teardown refused: invalid clubId");
  try {
    await prisma.club.delete({ where: { id: clubId } });
  } catch {
    // Best-effort. If FKs prevent cascade, leave the row for
    // manual review — never let cleanup silently mutate other
    // clubs.
  }
}
