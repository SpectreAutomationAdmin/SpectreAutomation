// TB-RESET-1c — Authoritative reporting-balance resolver.
//
// Sits ABOVE two primitives:
//
//   1. `accountBalances(clubId, {asOf})` — the operational ledger,
//      derived live from POSTED JournalEntry / JournalEntryLine.
//      Preserved unchanged; still the authoritative source for the
//      COA screen, drilldowns, and any date without an imported
//      external snapshot.
//
//   2. `ReportingLedgerSnapshot` + `ReportingLedgerBatch` — the
//      authoritative external reporting ledger. Populated by imports
//      from an accounting system of record (Jonas Club Management).
//
// PRECEDENCE (TB-RESET-1c brief §2):
//   • If a COMMITTED `entityKind="trial-balance"` snapshot exists for
//     the club at the EXACT `asOf` calendar date → return snapshot,
//     source = "AUTHORITATIVE_SNAPSHOT".
//   • Otherwise → return `accountBalances(...)`, source = "OPERATIONAL_LEDGER".
//
// The founder rule "exact period-end snapshot means exact period-end
// authority" is enforced: this resolver DOES NOT interpolate to the
// nearest-prior snapshot. `PrismaReportingLedger.getTrialBalance()`
// uses `asOf: { lte }` for the Monthly Reporting Package's own
// convenience — that method is unchanged, and this resolver is
// deliberately stricter for controller-grade reporting.
//
// Draft / preview / rolled-back / failed snapshots MUST NOT override:
//   • Filter `batchState = "committed"` on every read.
//   • Snapshots written under a pending `ReportingLedgerBatch`
//     inherit `batchState="pending"` and are invisible here until
//     the batch is committed (`commitImportBatch()` promotes both).
//
// DUPLICATE AMBIGUITY (brief §12.6):
//   • Multiple committed snapshots for the same (clubId,"trial-
//     balance", asOf) resolve deterministically via `capturedAt desc,
//     createdAt desc` — the latest-wins semantics already documented
//     on `ReportingLedgerSnapshot`.
//
// TENANT ISOLATION:
//   • Every query filters on `clubId`. No code path returns a snapshot
//     from another tenant. Verified in tests.

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { accountBalances, type AccountBalance, type BalanceFilter } from "./balance";
import { toMoney, ZERO } from "./decimal";
import type { AccountType, NormalBalance } from "./types";
import type { TrialBalanceLine, LedgerAccount } from "@/lib/reporting/ledger/contracts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReportingBalanceSource = "AUTHORITATIVE_SNAPSHOT" | "OPERATIONAL_LEDGER";

export type ReportingBalanceRow = {
  /** Spectre `Account.id` when the snapshot row maps cleanly to the
   *  preserved COA; null when the snapshot references an unknown
   *  account (surfaced for controller review, never silently
   *  auto-created). */
  accountId: string | null;
  accountNumber: string;
  accountName: string;
  /** Null when a snapshot row didn't resolve to a Spectre Account. */
  accountType: AccountType | null;
  normalBalance: NormalBalance | null;
  debitTotal: Prisma.Decimal;
  creditTotal: Prisma.Decimal;
  /** `debit - credit`. */
  signedBalance: Prisma.Decimal;
  /** `signedBalance` re-signed against `normalBalance`; positive
   *  means the account is on its normal side. */
  naturalBalance: Prisma.Decimal;
  fundApplicability: string | null;
  fsGroupKey: string | null;
};

export type ReportingBalancesProvenance = {
  snapshotId: string;
  sourceSystem: string;
  sourceFile: string | null;
  capturedAt: Date;
  importedAt: Date;
  dataSource: string;
  batchState: string;
  importBatchId: string | null;
  reportingPeriod: string | null;
  fiscalYearLabel: string | null;
  totalDebitsFromPayload: string;
  totalCreditsFromPayload: string;
  isBalancedFromPayload: boolean;
  /** Snapshot rows that couldn't resolve to a Spectre `Account.id`.
   *  Empty when every payload row mapped cleanly; non-empty is a
   *  hard flag for controller review — the resolver preserves the
   *  balance in the returned rows (accountId=null) but never
   *  auto-creates COA rows. */
  unresolvedAccountCodes: string[];
};

export type ReportingBalancesResult = {
  clubId: string;
  asOf: Date;
  source: ReportingBalanceSource;
  rows: ReportingBalanceRow[];
  totalDebit: Prisma.Decimal;
  totalCredit: Prisma.Decimal;
  isBalanced: boolean;
  /** Populated only when `source === "AUTHORITATIVE_SNAPSHOT"`. */
  provenance: ReportingBalancesProvenance | null;
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** Same-day UTC bounds for the exact-asOf filter. Snapshots are
 *  written with the calendar-day intent — a caller who passes an
 *  intra-day timestamp should still match a snapshot whose asOf is
 *  midnight of the same day, provided the calendar date matches. */
function sameDayRange(asOf: Date): { gte: Date; lte: Date } {
  const d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const gte = d;
  const lte = new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { gte, lte };
}

export async function reportingBalances(
  clubId: string,
  filter: { asOf: Date; departmentId?: string; fundId?: string; costCenterId?: string } = { asOf: new Date() },
): Promise<ReportingBalancesResult> {
  // Departmental / fund / cost-centre filters are operational-ledger
  // only — authoritative snapshots represent tenant-wide period-end
  // totals and (in DIM-2) are not yet re-shredded per dimension at
  // read time. When the caller requests a slice, the operational
  // ledger is the only valid source.
  const isSlicedRead =
    filter.departmentId != null || filter.fundId != null || filter.costCenterId != null;

  if (!isSlicedRead) {
    const snapshot = await findExactCommittedTbSnapshot(clubId, filter.asOf);
    if (snapshot) {
      return await normalizeSnapshotToBalances(clubId, filter.asOf, snapshot);
    }
  }

  const balances = await accountBalances(clubId, filter);
  return operationalLedgerResult(clubId, filter.asOf, balances);
}

/** Convenience: was the resolver's answer for this asOf sourced from
 *  the authoritative external ledger? Cheap probe — used by admin
 *  headers to render "Source: Jonas Trial Balance / As of …". */
export async function isAuthoritativeAsOf(clubId: string, asOf: Date): Promise<boolean> {
  const s = await findExactCommittedTbSnapshot(clubId, asOf);
  return s !== null;
}

// ---------------------------------------------------------------------------
// Internal — snapshot lookup + normalisation
// ---------------------------------------------------------------------------

async function findExactCommittedTbSnapshot(clubId: string, asOf: Date) {
  const range = sameDayRange(asOf);
  return prisma.reportingLedgerSnapshot.findFirst({
    where: {
      clubId,
      entityKind: "trial-balance",
      batchState: "committed",
      asOf: { gte: range.gte, lte: range.lte },
    },
    orderBy: [{ capturedAt: "desc" }, { createdAt: "desc" }],
  });
}

async function normalizeSnapshotToBalances(
  clubId: string,
  asOf: Date,
  snapshot: { snapshotId: string; sourceSystem: string; sourceFile: string | null; capturedAt: Date; importedAt: Date; dataSource: string; batchState: string; importBatchId: string | null; reportingPeriod: string | null; fiscalYearLabel: string | null; payloadJson: string },
  dimensionFilter?: {
    /** Department CODE (not id) to keep. Dropped when null/undefined. */
    departmentCode?: string | null;
    /** Fund KEY to keep. Dropped when null/undefined. */
    fundKey?: string | null;
  },
): Promise<ReportingBalancesResult> {
  // Payload is the entity-specific TrialBalanceSnapshot serialized as
  // JSON. Rehydrate just the fields we need; we don't need to
  // reconstruct Date objects for lines/totals because they're pure
  // numeric.
  const payload = JSON.parse(snapshot.payloadJson) as {
    lines?: TrialBalanceLine[];
    accounts?: LedgerAccount[];
    totalDebits?: number;
    totalCredits?: number;
    isBalanced?: boolean;
  };
  const allLines = payload.lines ?? [];
  const payloadAccounts = payload.accounts ?? [];
  // TB-HIST-2b (2026-10-01) §2 — dimensional filtering at the snapshot
  // read. Dept filter: keep only lines whose stored `department` CODE
  // matches (case-insensitive). Fund filter: keep only lines whose
  // stored `fund` KEY matches. Both filters apply BEFORE per-account
  // aggregation so a Dept-filtered Income Statement correctly excludes
  // other departments' balances on multi-dept accounts.
  const payloadLines = allLines.filter((l) => {
    if (dimensionFilter?.departmentCode) {
      const want = dimensionFilter.departmentCode.toUpperCase();
      const have = (l.department ?? "").toUpperCase();
      if (have !== want) return false;
    }
    if (dimensionFilter?.fundKey) {
      const want = dimensionFilter.fundKey.toUpperCase();
      const have = (l.fund ?? "").toUpperCase();
      if (have !== want) return false;
    }
    return true;
  });

  // Resolve each accountCode → Spectre Account. Account numbers are
  // STRINGS end-to-end. If any code doesn't resolve, we surface it in
  // `provenance.unresolvedAccountCodes` and set that row's accountId
  // to null — never auto-create a COA row.
  const codes = Array.from(new Set(payloadLines.map((l) => l.accountCode)));
  const accounts = codes.length
    ? await prisma.account.findMany({
        where: { clubId, accountNumber: { in: codes } },
        include: { fsGroup: true },
      })
    : [];
  const accountByCode = new Map(accounts.map((a) => [a.accountNumber, a]));

  const payloadAccountByCode = new Map(payloadAccounts.map((a) => [a.accountCode, a]));

  const rows: ReportingBalanceRow[] = [];
  const unresolved: string[] = [];
  let totalDebit = ZERO;
  let totalCredit = ZERO;

  for (const line of payloadLines) {
    const acct = accountByCode.get(line.accountCode) ?? null;
    const payloadAcct = payloadAccountByCode.get(line.accountCode) ?? null;
    if (!acct) unresolved.push(line.accountCode);
    const debit = toMoney(line.debit);
    const credit = toMoney(line.credit);
    const signed = debit.minus(credit);
    const normal = (acct?.normalBalance ?? null) as NormalBalance | null;
    const natural = normal === "DEBIT" ? signed : normal === "CREDIT" ? signed.negated() : signed;
    rows.push({
      accountId: acct?.id ?? null,
      accountNumber: line.accountCode,
      accountName: acct?.name ?? payloadAcct?.accountName ?? line.accountCode,
      accountType: (acct?.type ?? null) as AccountType | null,
      normalBalance: normal,
      debitTotal: debit,
      creditTotal: credit,
      signedBalance: signed,
      naturalBalance: natural,
      fundApplicability: (acct as unknown as { fundApplicability?: string | null })?.fundApplicability ?? null,
      fsGroupKey: acct?.fsGroup?.key ?? null,
    });

    // Trial-balance total convention: DR when signed >= 0, CR when signed < 0.
    if (signed.gte(0)) totalDebit = totalDebit.plus(signed);
    else totalCredit = totalCredit.plus(signed.negated());
  }

  const debitCents = totalDebit.toDecimalPlaces(2);
  const creditCents = totalCredit.toDecimalPlaces(2);
  const isBalanced = debitCents.minus(creditCents).abs().lte(toMoney("0.01"));

  return {
    clubId,
    asOf,
    source: "AUTHORITATIVE_SNAPSHOT",
    rows,
    totalDebit,
    totalCredit,
    isBalanced,
    provenance: {
      snapshotId: snapshot.snapshotId,
      sourceSystem: snapshot.sourceSystem,
      sourceFile: snapshot.sourceFile,
      capturedAt: snapshot.capturedAt,
      importedAt: snapshot.importedAt,
      dataSource: snapshot.dataSource,
      batchState: snapshot.batchState,
      importBatchId: snapshot.importBatchId,
      reportingPeriod: snapshot.reportingPeriod,
      fiscalYearLabel: snapshot.fiscalYearLabel,
      totalDebitsFromPayload: String(payload.totalDebits ?? 0),
      totalCreditsFromPayload: String(payload.totalCredits ?? 0),
      isBalancedFromPayload: Boolean(payload.isBalanced),
      unresolvedAccountCodes: unresolved,
    },
  };
}

function operationalLedgerResult(clubId: string, asOf: Date, balances: AccountBalance[]): ReportingBalancesResult {
  let totalDebit = ZERO;
  let totalCredit = ZERO;
  const rows: ReportingBalanceRow[] = balances.map((b) => {
    if (b.signedBalance.gte(0)) totalDebit = totalDebit.plus(b.signedBalance);
    else totalCredit = totalCredit.plus(b.signedBalance.negated());
    return {
      accountId: b.accountId,
      accountNumber: b.accountNumber,
      accountName: b.accountName,
      accountType: b.accountType,
      normalBalance: b.normalBalance,
      debitTotal: b.debitTotal,
      creditTotal: b.creditTotal,
      signedBalance: b.signedBalance,
      naturalBalance: b.naturalBalance,
      fundApplicability: b.fundApplicability,
      fsGroupKey: b.fsGroupKey,
    };
  });
  const debitCents = totalDebit.toDecimalPlaces(2);
  const creditCents = totalCredit.toDecimalPlaces(2);
  const isBalanced = debitCents.minus(creditCents).abs().lte(toMoney("0.01"));
  return {
    clubId,
    asOf,
    source: "OPERATIONAL_LEDGER",
    rows,
    totalDebit,
    totalCredit,
    isBalanced,
    provenance: null,
  };
}

// ---------------------------------------------------------------------------
// Adapter — legacy `AccountBalance[]` shape for existing consumers.
//
// `reports.ts::trialBalance / balanceSheet / incomeStatement` all
// consume `AccountBalance[]` from `accountBalances()`. Rather than
// rewrite every downstream file, we expose an adapter that returns
// the same shape plus the reporting source metadata. This keeps
// this slice small and reversible.
// ---------------------------------------------------------------------------

export type ReportingAccountBalancesResult = {
  balances: AccountBalance[];
  source: ReportingBalanceSource;
  provenance: ReportingBalancesProvenance | null;
};

/** Same input shape as `accountBalances(clubId, filter)` but routes
 *  through the exact-asOf snapshot precedence rule when the filter
 *  is a plain asOf read (no departmental slice).
 *
 *  TB-HIST-2 (2026-10-01) — fiscal-YTD slice snapshot support. When the
 *  filter carries `{ from, to }` AND the snapshot at exact `to` carries
 *  a `periodStart` byte-equal to `from`, we trust the snapshot's own
 *  period window and return the snapshot's YTD balances. P&L lines in
 *  a Jonas-style TB snapshot ARE fiscal-YTD by construction, so a
 *  fiscal-YTD slice read is identical to reading the snapshot directly.
 *  This is what makes Finance → Income Statement + Balance Sheet
 *  current-year earnings snapshot-aware without rewiring every caller.
 */
export async function reportingAccountBalances(
  clubId: string,
  filter: BalanceFilter = {},
): Promise<ReportingAccountBalancesResult> {
  const asOf = filter.asOf ?? filter.to ?? new Date();
  // TB-HIST-2b (2026-10-01) §2 — Department / Fund filters now stay
  // on the snapshot path (dimensional reads). The costCenter filter
  // still forces the operational-ledger path because snapshots don't
  // carry a cost-center dimension yet.
  const hasAsOfOnly =
    filter.asOf != null &&
    filter.from == null &&
    filter.to == null &&
    filter.costCenterId == null;
  const hasYtdSliceShape =
    filter.from != null &&
    filter.to != null &&
    filter.asOf == null &&
    filter.costCenterId == null;

  // Resolve Department.id → code and Fund.id → key for the snapshot
  // filter (snapshots carry CODES, not IDs). Returns null for an id
  // that doesn't resolve — the caller then falls through to the JEL
  // path because the snapshot cannot answer the query.
  async function resolveDimensionFilter(): Promise<
    | { departmentCode: string | null; fundKey: string | null; resolved: true }
    | { resolved: false }
  > {
    let departmentCode: string | null = null;
    let fundKey: string | null = null;
    if (filter.departmentId) {
      const d = await prisma.department.findUnique({ where: { id: filter.departmentId }, select: { code: true } });
      if (!d) return { resolved: false };
      departmentCode = d.code;
    }
    if (filter.fundId) {
      const f = await prisma.fund.findUnique({ where: { id: filter.fundId }, select: { key: true } });
      if (!f) return { resolved: false };
      fundKey = f.key;
    }
    return { departmentCode, fundKey, resolved: true };
  }

  if (hasAsOfOnly) {
    const dim = await resolveDimensionFilter();
    if (!dim.resolved) {
      const balances = await accountBalances(clubId, filter);
      return { balances, source: "OPERATIONAL_LEDGER", provenance: null };
    }
    const snapshot = await findExactCommittedTbSnapshot(clubId, asOf);
    if (snapshot) {
      const result = await normalizeSnapshotToBalances(clubId, asOf, snapshot, {
        departmentCode: dim.departmentCode,
        fundKey: dim.fundKey,
      });
      const balances: AccountBalance[] = result.rows
        .filter((r) => r.accountId != null && r.accountType != null && r.normalBalance != null)
        .map((r) => ({
          accountId: r.accountId as string,
          accountNumber: r.accountNumber,
          accountName: r.accountName,
          accountType: r.accountType as AccountType,
          normalBalance: r.normalBalance as NormalBalance,
          debitTotal: r.debitTotal,
          creditTotal: r.creditTotal,
          signedBalance: r.signedBalance,
          naturalBalance: r.naturalBalance,
          fundApplicability: r.fundApplicability,
          fsGroupKey: r.fsGroupKey,
        }));
      return { balances, source: "AUTHORITATIVE_SNAPSHOT", provenance: result.provenance };
    }
  }

  // TB-HIST-2 YTD-slice path. Jonas snapshots carry both `asOf` (BS
  // date) and `periodStart`/`periodEnd` (activity window). When the
  // request's `from` matches the snapshot's `periodStart` AND `to`
  // matches `asOf` within the same calendar day, the snapshot IS the
  // YTD figure the caller wants. We can serve the P&L YTD and the
  // ending BS from the same snapshot payload.
  if (hasYtdSliceShape) {
    const dim = await resolveDimensionFilter();
    if (!dim.resolved) {
      const balances = await accountBalances(clubId, filter);
      return { balances, source: "OPERATIONAL_LEDGER", provenance: null };
    }
    const snapshot = await findExactCommittedTbSnapshot(clubId, filter.to as Date);
    if (snapshot) {
      // Snapshot's periodStart lives on the ReportingLedgerSnapshot
      // row (not inside payloadJson), so grab it from the record.
      const periodStart = snapshot.periodStart;
      if (periodStart !== null && sameDay(periodStart, filter.from as Date)) {
        const result = await normalizeSnapshotToBalances(clubId, filter.to as Date, snapshot, {
          departmentCode: dim.departmentCode,
          fundKey: dim.fundKey,
        });
        const balances: AccountBalance[] = result.rows
          .filter((r) => r.accountId != null && r.accountType != null && r.normalBalance != null)
          .map((r) => ({
            accountId: r.accountId as string,
            accountNumber: r.accountNumber,
            accountName: r.accountName,
            accountType: r.accountType as AccountType,
            normalBalance: r.normalBalance as NormalBalance,
            debitTotal: r.debitTotal,
            creditTotal: r.creditTotal,
            signedBalance: r.signedBalance,
            naturalBalance: r.naturalBalance,
            fundApplicability: r.fundApplicability,
            fsGroupKey: r.fsGroupKey,
          }));
        return { balances, source: "AUTHORITATIVE_SNAPSHOT", provenance: result.provenance };
      }
    }
  }

  const balances = await accountBalances(clubId, filter);
  return { balances, source: "OPERATIONAL_LEDGER", provenance: null };
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}
