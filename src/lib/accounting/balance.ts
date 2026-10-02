// GL balance + activity engine.
//
// All balance reads come through here. Posted entries only. Voided entries
// are by definition unposted, so they don't appear; reversed entries are
// POSTED but the contra is also POSTED, so they net naturally.

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { sumMoney, toMoney, ZERO } from "./decimal";
import type { AccountType, NormalBalance } from "./types";

export type BalanceFilter = {
  asOf?: Date;
  from?: Date;
  to?: Date;
  departmentId?: string;
  // DIM-2 (2026-09-29) — line-level Fund filter.
  fundId?: string;
  costCenterId?: string;
};

export type AccountBalance = {
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: AccountType;
  normalBalance: NormalBalance;
  debitTotal: Prisma.Decimal;
  creditTotal: Prisma.Decimal;
  signedBalance: Prisma.Decimal; // debit - credit
  // "Natural" balance: positive when this is a normal-side balance.
  naturalBalance: Prisma.Decimal;
  // TB-HIST-7 (2026-10-01) — dimensional provenance preserved alongside
  // the natural-account balance. Populated when the balance comes from
  // the dimensional ReportingLedgerSnapshot payload (one entry per
  // (account, department, fund) tuple); null for operational-ledger
  // reads. Consumers that need a drill-down build a map keyed on
  // accountId; the consolidated reports read only the aggregated row
  // and ignore this list.
  dimensional?: ReadonlyArray<{
    department: string | null;
    fund: string | null;
    debit: Prisma.Decimal;
    credit: Prisma.Decimal;
    signedBalance: Prisma.Decimal;
    naturalBalance: Prisma.Decimal;
  }>;
  // Founder rule 2026-07-02 v15.4 — Fund Applicability + FS Group
  // travel with every account balance so the live Income
  // Statement synthesiser can partition Revenue / Expense into
  // Operating vs Capital totals without a second Prisma round-
  // trip. Nullable on both sides: `fundApplicability` is null for
  // balance-sheet accounts (P&L concept only) and legacy P&L rows
  // that predate the field; `fsGroupKey` is null for accounts
  // without an FS Group assigned. Reporting layers that don't
  // care can ignore these fields.
  fundApplicability: string | null;
  fsGroupKey: string | null;
};

// Founder rule 2026-07-01 v14.9 — a club is "past demo" the moment
// it has any COMMITTED authoritative accounting evidence. From that
// point on, Finance reports MUST exclude JournalEntry rows tagged
// `source: "DEMO"` — those are seeded demo entries planted by
// prisma/seed.ts to make a fresh dev club look populated. Real user
// activity uses "MANUAL", "AP", "IMPORT", etc.; only demo entries
// carry "DEMO".
//
// TB-HIST-2 (2026-10-01) — the recognised evidence shapes are now:
//   1. Legacy `ImportBatch(domain=OPENING_TRIAL_BALANCE)` COMMITTED
//      (writes JournalEntries into the GL).
//   2. Modern `ReportingLedgerBatch` committed with a persisted
//      authoritative `ReportingLedgerSnapshot(entityKind="trial-balance")`
//      (the Jonas-UI path — writes only to the reporting ledger).
// Either path is treated as real accounting data.
export async function hasCommittedRealTrialBalance(clubId: string): Promise<boolean> {
  const live = await prisma.importBatch.findFirst({
    where: {
      clubId,
      domain: "OPENING_TRIAL_BALANCE",
      status: "COMMITTED",
      supersededAt: null,
      voidedAt: null,
    },
    select: { id: true },
  });
  if (live !== null) return true;
  // TB-HIST-2 — also recognise a committed authoritative Jonas-UI
  // trial-balance snapshot as real accounting data. We check for a
  // committed, non-superseded ReportingLedgerBatch; its presence
  // guarantees at least one trial-balance snapshot exists.
  const jonas = await prisma.reportingLedgerBatch.findFirst({
    where: {
      clubId,
      state: "committed",
      supersededByBatchId: null,
    },
    select: { batchId: true },
  });
  return jonas !== null;
}

/** TB-HIST-2 (2026-10-01) alias — the broader semantic the function
 *  now carries. New call sites should prefer this name. */
export const hasCommittedRealAccountingData = hasCommittedRealTrialBalance;

/**
 * TB-HIST-2b (2026-10-01) — is this the Silver Springs demo tenant?
 *
 * Identified by its stable slug "silver-springs" (set in prisma/seed.ts).
 * Any OTHER tenant is a real (non-demo) tenant, and Silver Springs
 * demo fixture values MUST NOT appear in that tenant's reporting
 * surfaces. See `getMonthlyReportingPackage` for the redactor that
 * enforces this at the package level.
 */
export async function isDemoTenant(clubId: string): Promise<boolean> {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { slug: true },
  });
  return club?.slug === "silver-springs";
}

export async function accountBalances(clubId: string, filter: BalanceFilter = {}): Promise<AccountBalance[]> {
  // v14.9 — check once per report render whether demo entries
  // should be filtered. `hasCommittedRealTrialBalance` is a
  // single indexed lookup on ImportBatch, so the extra query is
  // cheap even for zero-activity clubs.
  const excludeDemo = await hasCommittedRealTrialBalance(clubId);
  const where: Prisma.JournalEntryLineWhereInput = {
    clubId,
    entry: {
      status: "POSTED",
      ...(excludeDemo ? { source: { not: "DEMO" } } : {}),
      ...(filter.asOf ? { entryDate: { lte: filter.asOf } } : {}),
      ...(filter.from || filter.to
        ? { entryDate: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
        : {}),
    },
    ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
    ...(filter.costCenterId ? { costCenterId: filter.costCenterId } : {}),
    // DIM-2 (2026-09-29) — line-level Fund filter. When absent the
    // report is consolidated (all funds); when supplied it filters
    // JournalEntryLine.fundId, keeping semantics symmetric with
    // the departmentId filter.
    ...(filter.fundId ? { fundId: filter.fundId } : {}),
  };

  // Aggregate per account.
  const grouped = await prisma.journalEntryLine.groupBy({
    by: ["accountId"],
    where,
    _sum: { debit: true, credit: true },
  });

  // Resolve account metadata in one round-trip. v15.4 — the
  // `include: { fsGroup: true }` hop lets us thread the FS Group
  // key through to `AccountBalance` so downstream Income
  // Statement synthesis can identify depreciation / fund
  // classification without a second query.
  const accountIds = grouped.map((g) => g.accountId);
  const accounts = accountIds.length
    ? await prisma.account.findMany({
        where: { id: { in: accountIds } },
        include: { fsGroup: true },
      })
    : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));

  // Include accounts that have zero activity in the requested window — useful
  // for Trial Balance which traditionally shows every active account.
  const allAccounts = await prisma.account.findMany({
    where: { clubId, isHeader: false, isActive: true },
    include: { fsGroup: true },
    orderBy: { accountNumber: "asc" },
  });

  const out: AccountBalance[] = [];
  const seen = new Set<string>();
  for (const g of grouped) {
    const account = byId.get(g.accountId);
    if (!account) continue;
    if (account.isHeader) continue;
    seen.add(account.id);
    const debit = toMoney(g._sum.debit as unknown as Prisma.Decimal | null);
    const credit = toMoney(g._sum.credit as unknown as Prisma.Decimal | null);
    out.push(buildBalance(account, debit, credit));
  }
  // Pad with zero-activity active accounts.
  for (const a of allAccounts) {
    if (seen.has(a.id)) continue;
    out.push(buildBalance(a, ZERO, ZERO));
  }
  out.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
  return out;
}

function buildBalance(
  account: {
    id: string;
    accountNumber: string;
    name: string;
    type: string;
    normalBalance: string;
    // Founder rule 2026-07-02 v15.4 — Fund Applicability + FS
    // Group tag every balance. `fundApplicability` is a plain
    // column; `fsGroup` is an optional relation include, so we
    // accept the shape `{ key } | null` from `findMany({include})`.
    fundApplicability?: string | null;
    fsGroup?: { key: string } | null;
  },
  debit: Prisma.Decimal,
  credit: Prisma.Decimal,
): AccountBalance {
  const signed = debit.minus(credit);
  const natural = account.normalBalance === "DEBIT" ? signed : signed.negated();
  return {
    accountId: account.id,
    accountNumber: account.accountNumber,
    accountName: account.name,
    accountType: account.type as AccountType,
    normalBalance: account.normalBalance as NormalBalance,
    debitTotal: debit,
    creditTotal: credit,
    signedBalance: signed,
    naturalBalance: natural,
    fundApplicability: account.fundApplicability ?? null,
    fsGroupKey: account.fsGroup?.key ?? null,
  };
}

// Account activity — line-by-line drilldown with running balance.
export async function accountActivity(
  clubId: string,
  accountId: string,
  filter: BalanceFilter = {}
) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || account.clubId !== clubId) throw new Error("Account not found");

  // v14.9 — same DEMO exclusion as accountBalances so the
  // per-account drilldown page also hides seeded activity once
  // the club has committed a real Trial Balance.
  const excludeDemo = await hasCommittedRealTrialBalance(clubId);
  const demoWhere = excludeDemo ? { source: { not: "DEMO" } } : {};

  // Opening balance: posted activity strictly before the window.
  const openingFilter: Prisma.JournalEntryLineWhereInput = {
    clubId,
    accountId,
    entry: {
      status: "POSTED",
      ...demoWhere,
      ...(filter.from ? { entryDate: { lt: filter.from } } : { entryDate: { lt: new Date(0) } }),
    },
    ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
  };
  const opening = await prisma.journalEntryLine.aggregate({ where: openingFilter, _sum: { debit: true, credit: true } });
  const openingDebit = toMoney(opening._sum.debit as unknown as Prisma.Decimal | null);
  const openingCredit = toMoney(opening._sum.credit as unknown as Prisma.Decimal | null);
  const openingSigned = openingDebit.minus(openingCredit);

  const rows = await prisma.journalEntryLine.findMany({
    where: {
      clubId,
      accountId,
      entry: {
        status: "POSTED",
        ...demoWhere,
        ...(filter.from || filter.to
          ? { entryDate: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      },
      ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
    },
    include: { entry: true, department: true },
    orderBy: [{ entry: { entryDate: "asc" } }, { lineNumber: "asc" }],
  });

  let running = openingSigned;
  const activity = rows.map((r) => {
    running = running.plus(toMoney(r.debit as unknown as Prisma.Decimal)).minus(toMoney(r.credit as unknown as Prisma.Decimal));
    return {
      lineId: r.id,
      entryId: r.entry.id,
      entryNumber: r.entry.entryNumber,
      entryDate: r.entry.entryDate,
      description: r.description ?? r.entry.description,
      department: r.department?.name ?? null,
      debit: toMoney(r.debit as unknown as Prisma.Decimal),
      credit: toMoney(r.credit as unknown as Prisma.Decimal),
      runningSigned: running,
    };
  });
  const closingSigned = running;

  return {
    account,
    openingDebit, openingCredit, openingSigned,
    closingSigned,
    naturalClosing: account.normalBalance === "DEBIT" ? closingSigned : closingSigned.negated(),
    totalDebit: sumMoney(activity.map((a) => a.debit)),
    totalCredit: sumMoney(activity.map((a) => a.credit)),
    activity,
  };
}

// ---------------------------------------------------------------------------
// TB-HIST-7 (2026-10-01) — presentation-time dimensional consolidation.
//
// The historical `ReportingLedgerSnapshot` persists one payload line per
// (Account × Department × Fund) tuple — the authoritative dimensional
// grain required for departmental / fund reporting. When
// `reportingAccountBalances` lifts those lines into AccountBalance rows,
// a natural account that spans N departments / funds becomes N
// AccountBalance entries with the same `accountId`. Rendering those as
// separate rows in a CONSOLIDATED Trial Balance / Balance Sheet / Income
// Statement produces duplicate-looking lines like
//   "6104 Consultant & Professional Services ... $12,000.00"
//   "6104 Consultant & Professional Services ... $4,500.00"
// which is correct underlying data but poor consolidated-statement
// presentation.
//
// `consolidateAccountBalances` collapses the array to one row per
// natural account. The returned row preserves the dimensional source
// detail under `.dimensional[]` so a future drill-down UI can expand
// the aggregate without an extra round-trip to the resolver.
//
// Netting semantics (TB-HIST-7 §3):
//   • debitTotal/creditTotal are summed across the dimensional lines
//     (gross dimensional debit/credit — unchanged from the operational-
//     ledger convention).
//   • signedBalance / naturalBalance are summed across the lines, so
//     offsetting dimensional entries (dept A +247,875.94, dept B
//     −247,875.94) correctly net to zero at the account level.
//   • The CALLER renders debit/credit per account using the classic
//     "net on the natural side" rule: debit = max(0, signedBalance),
//     credit = max(0, −signedBalance). The displayed totals are the
//     consolidated per-account net values, NOT the pre-consolidation
//     gross sums. This is the §8 distinction the directive calls out.
//
// Pure function. No Prisma. Deterministic ordering (input order is
// preserved; two lines of the same account merge at the first line's
// position).
export function consolidateAccountBalances(
  balances: ReadonlyArray<AccountBalance>,
): AccountBalance[] {
  const byAccount = new Map<string, {
    first: AccountBalance;
    position: number;
    debitTotal: Prisma.Decimal;
    creditTotal: Prisma.Decimal;
    signedBalance: Prisma.Decimal;
    naturalBalance: Prisma.Decimal;
    dimensional: Array<NonNullable<AccountBalance["dimensional"]>[number]>;
  }>();
  balances.forEach((b, idx) => {
    const key = b.accountId;
    // If the input row already carries its own dimensional seed
    // (TB-HIST-7 — populated by the snapshot resolver with the
    // actual (department, fund) tuple), carry those entries forward;
    // otherwise synthesise a single-entry with null dimensions so a
    // caller can still iterate `.dimensional[]` safely.
    const incomingDim = b.dimensional && b.dimensional.length > 0
      ? b.dimensional.map((d) => ({ ...d }))
      : [{
          department: null, fund: null,
          debit: b.debitTotal, credit: b.creditTotal,
          signedBalance: b.signedBalance, naturalBalance: b.naturalBalance,
        }];
    const existing = byAccount.get(key);
    if (!existing) {
      byAccount.set(key, {
        first: b,
        position: idx,
        debitTotal: b.debitTotal,
        creditTotal: b.creditTotal,
        signedBalance: b.signedBalance,
        naturalBalance: b.naturalBalance,
        dimensional: incomingDim,
      });
    } else {
      existing.debitTotal = existing.debitTotal.plus(b.debitTotal);
      existing.creditTotal = existing.creditTotal.plus(b.creditTotal);
      existing.signedBalance = existing.signedBalance.plus(b.signedBalance);
      existing.naturalBalance = existing.naturalBalance.plus(b.naturalBalance);
      for (const d of incomingDim) existing.dimensional.push(d);
    }
  });
  return Array.from(byAccount.values())
    .sort((a, b) => a.position - b.position)
    .map((entry) => ({
      accountId: entry.first.accountId,
      accountNumber: entry.first.accountNumber,
      accountName: entry.first.accountName,
      accountType: entry.first.accountType,
      normalBalance: entry.first.normalBalance,
      debitTotal: entry.debitTotal,
      creditTotal: entry.creditTotal,
      signedBalance: entry.signedBalance,
      naturalBalance: entry.naturalBalance,
      fundApplicability: entry.first.fundApplicability,
      fsGroupKey: entry.first.fsGroupKey,
      dimensional: entry.dimensional,
    }));
}
