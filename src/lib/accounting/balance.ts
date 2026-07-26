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
// it has any COMMITTED Opening Trial Balance batch that isn't
// superseded or voided. From that point on, Finance reports MUST
// exclude JournalEntry rows tagged `source: "DEMO"` — those are
// seeded demo entries planted by prisma/seed.ts to make a fresh
// dev club look populated. Real user activity uses "MANUAL",
// "AP", "IMPORT", etc.; only demo entries carry "DEMO".
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
  return live !== null;
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
