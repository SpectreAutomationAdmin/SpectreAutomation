// Reporting Ledger — Prisma row ↔ LedgerSnapshot (de)hydration.
//
// SQLite (and Postgres jsonb-as-text) round-trip JSON via string
// columns. JSON has no Date type — every Date in a snapshot becomes
// an ISO-8601 string on the way out and must be re-hydrated to a
// real `Date` instance on the way back in.
//
// These helpers walk the known date paths of every snapshot variant
// (TB / BS / IS / Budget / PriorYear / AR / Payroll / CapitalProject)
// and convert in both directions. Pure — no Prisma imports here so
// the helpers can be unit-tested in isolation.

import type {
  ArAgingSnapshot,
  BalanceSheetSnapshot,
  BudgetSnapshot,
  CapitalProjectSnapshot,
  IncomeStatementSnapshot,
  LedgerSnapshot,
  PayrollSnapshot,
  PriorYearSnapshot,
  TrialBalanceSnapshot,
} from "@/lib/reporting/ledger/contracts";

// ---------------------------------------------------------------------------
// Dehydrate — LedgerSnapshot → JSON-safe object
// ---------------------------------------------------------------------------

/**
 * Convert a LedgerSnapshot into a JSON-safe object. `JSON.stringify`
 * on a `Date` produces an ISO string by default, so we rely on that
 * for the actual serialization — `dehydrate` is the explicit step
 * for any caller that wants to round-trip without `JSON.stringify`.
 */
export function dehydrateSnapshot(snapshot: LedgerSnapshot): string {
  // JSON.stringify handles Date → ISO automatically.
  return JSON.stringify(snapshot);
}

// ---------------------------------------------------------------------------
// Rehydrate — JSON-parsed object → LedgerSnapshot (with real Dates)
// ---------------------------------------------------------------------------

/**
 * Parse the JSON payload string and re-hydrate every known date
 * field for the given entity kind. Throws if the payload is missing
 * required date fields for that kind.
 */
export function rehydrateSnapshot(payloadJson: string): LedgerSnapshot {
  const raw = JSON.parse(payloadJson) as Record<string, unknown>;
  // Common metadata dates.
  raw.capturedAt = parseDate(raw.capturedAt, "capturedAt");
  switch (raw.entityKind) {
    case "trial-balance":
      return rehydrateTrialBalance(raw);
    case "balance-sheet":
      return rehydrateBalanceSheet(raw);
    case "income-statement":
      return rehydrateIncomeStatement(raw);
    case "budget":
      return rehydrateBudget(raw);
    case "prior-year":
      return rehydratePriorYear(raw);
    case "ar-aging":
      return rehydrateArAging(raw);
    case "payroll":
      return rehydratePayroll(raw);
    case "capital-project":
      return rehydrateCapitalProject(raw);
    default:
      throw new Error(
        `rehydrateSnapshot: unknown entityKind '${String(raw.entityKind)}'`,
      );
  }
}

function rehydrateTrialBalance(raw: Record<string, unknown>): TrialBalanceSnapshot {
  raw.asOf = parseDate(raw.asOf, "asOf");
  raw.periodStart = parseDate(raw.periodStart, "periodStart");
  raw.periodEnd = parseDate(raw.periodEnd, "periodEnd");
  return raw as unknown as TrialBalanceSnapshot;
}

function rehydrateBalanceSheet(raw: Record<string, unknown>): BalanceSheetSnapshot {
  raw.asOf = parseDate(raw.asOf, "asOf");
  return raw as unknown as BalanceSheetSnapshot;
}

function rehydrateIncomeStatement(raw: Record<string, unknown>): IncomeStatementSnapshot {
  raw.periodStart = parseDate(raw.periodStart, "periodStart");
  raw.periodEnd = parseDate(raw.periodEnd, "periodEnd");
  return raw as unknown as IncomeStatementSnapshot;
}

function rehydrateBudget(raw: Record<string, unknown>): BudgetSnapshot {
  raw.startDate = parseDate(raw.startDate, "startDate");
  raw.endDate = parseDate(raw.endDate, "endDate");
  if (raw.approvalDate !== null && raw.approvalDate !== undefined) {
    raw.approvalDate = parseDate(raw.approvalDate, "approvalDate");
  }
  return raw as unknown as BudgetSnapshot;
}

function rehydratePriorYear(raw: Record<string, unknown>): PriorYearSnapshot {
  raw.periodStart = parseDate(raw.periodStart, "periodStart");
  raw.periodEnd = parseDate(raw.periodEnd, "periodEnd");
  // Nested IS + BS need their own date rehydration.
  const is = raw.incomeStatement as Record<string, unknown> | undefined;
  if (is) {
    is.periodStart = parseDate(is.periodStart, "incomeStatement.periodStart");
    is.periodEnd = parseDate(is.periodEnd, "incomeStatement.periodEnd");
  }
  const bs = raw.balanceSheetAtYearEnd as Record<string, unknown> | undefined;
  if (bs) {
    bs.asOf = parseDate(bs.asOf, "balanceSheetAtYearEnd.asOf");
  }
  return raw as unknown as PriorYearSnapshot;
}

function rehydrateArAging(raw: Record<string, unknown>): ArAgingSnapshot {
  raw.asOf = parseDate(raw.asOf, "asOf");
  return raw as unknown as ArAgingSnapshot;
}

function rehydratePayroll(raw: Record<string, unknown>): PayrollSnapshot {
  raw.periodStart = parseDate(raw.periodStart, "periodStart");
  raw.periodEnd = parseDate(raw.periodEnd, "periodEnd");
  return raw as unknown as PayrollSnapshot;
}

function rehydrateCapitalProject(
  raw: Record<string, unknown>,
): CapitalProjectSnapshot {
  raw.asOf = parseDate(raw.asOf, "asOf");
  // Per-project estimatedCompletion may be a date or null.
  const projects = raw.projects as Array<Record<string, unknown>> | undefined;
  if (projects) {
    for (const p of projects) {
      if (p.estimatedCompletion !== null && p.estimatedCompletion !== undefined) {
        p.estimatedCompletion = parseDate(p.estimatedCompletion, "estimatedCompletion");
      }
    }
  }
  return raw as unknown as CapitalProjectSnapshot;
}

// ---------------------------------------------------------------------------
// Period key derivation — pure helpers used by the writer to populate
// the indexed columns on each row.
// ---------------------------------------------------------------------------

/**
 * Pull out the period keys for the indexed columns on the snapshot
 * row. Different entity kinds populate different fields.
 */
export function extractPeriodKeys(snapshot: LedgerSnapshot): {
  asOf: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  fiscalYearLabel: string | null;
  reportingPeriod: string | null;
} {
  switch (snapshot.entityKind) {
    case "trial-balance":
      return {
        asOf: snapshot.asOf,
        periodStart: snapshot.periodStart,
        periodEnd: snapshot.periodEnd,
        fiscalYearLabel: snapshot.fiscalYearLabel,
        reportingPeriod: `${snapshot.fiscalYearLabel} P${snapshot.fiscalPeriodSequence}`,
      };
    case "balance-sheet":
      return {
        asOf: snapshot.asOf,
        periodStart: null,
        periodEnd: null,
        fiscalYearLabel: snapshot.fiscalYearLabel,
        reportingPeriod: formatAsOfLabel(snapshot.asOf, snapshot.fiscalYearLabel),
      };
    case "income-statement":
      return {
        asOf: null,
        periodStart: snapshot.periodStart,
        periodEnd: snapshot.periodEnd,
        fiscalYearLabel: snapshot.fiscalYearLabel,
        reportingPeriod: `${snapshot.fiscalYearLabel} P${snapshot.fiscalPeriodSequence}`,
      };
    case "budget":
      return {
        asOf: null,
        periodStart: snapshot.startDate,
        periodEnd: snapshot.endDate,
        fiscalYearLabel: snapshot.fiscalYearLabel,
        reportingPeriod: `${snapshot.fiscalYearLabel} v${snapshot.version}`,
      };
    case "prior-year":
      return {
        asOf: null,
        periodStart: snapshot.periodStart,
        periodEnd: snapshot.periodEnd,
        fiscalYearLabel: snapshot.fiscalYearLabel,
        reportingPeriod: snapshot.fiscalYearLabel,
      };
    case "ar-aging":
      return {
        asOf: snapshot.asOf,
        periodStart: null,
        periodEnd: null,
        fiscalYearLabel: null,
        reportingPeriod: formatAsOfLabel(snapshot.asOf, null),
      };
    case "payroll":
      return {
        asOf: null,
        periodStart: snapshot.periodStart,
        periodEnd: snapshot.periodEnd,
        fiscalYearLabel: snapshot.fiscalYearLabel,
        reportingPeriod: `${snapshot.fiscalYearLabel} P${snapshot.fiscalPeriodSequence}`,
      };
    case "capital-project":
      return {
        asOf: snapshot.asOf,
        periodStart: null,
        periodEnd: null,
        fiscalYearLabel: snapshot.fiscalYearLabel,
        reportingPeriod: formatAsOfLabel(snapshot.asOf, snapshot.fiscalYearLabel),
      };
  }
}

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatAsOfLabel(asOf: Date, fiscalYearLabel: string | null): string {
  const m = MONTH_SHORT[asOf.getUTCMonth()];
  const y = asOf.getUTCFullYear();
  const stem = `${m} ${y}`;
  return fiscalYearLabel ? `${stem} (${fiscalYearLabel})` : stem;
}

// ---------------------------------------------------------------------------
// Internal — strict date parsing
// ---------------------------------------------------------------------------

function parseDate(value: unknown, field: string): Date {
  if (value instanceof Date) return value;
  if (typeof value !== "string") {
    throw new Error(
      `rehydrateSnapshot: expected ISO string for '${field}', got ${typeof value}`,
    );
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`rehydrateSnapshot: invalid date string for '${field}': '${value}'`);
  }
  return d;
}
