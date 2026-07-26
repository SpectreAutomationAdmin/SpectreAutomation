// Jonas GL import — server actions for the /app/admin/imports/jonas route.
//
// Two server-action endpoints + one read helper:
//
//   • previewJonasImport — parses CSV, runs the account mapping, runs
//     the reconciliation check, returns a JSON preview WITHOUT writing
//     anything to the ledger. Safe to call repeatedly while the
//     operator iterates on inputs.
//
//   • commitJonasImport — runs the full JonasGlImporter against the
//     PrismaReportingLedger. Writes a TrialBalanceSnapshot row inside
//     a committed import batch. Returns the JonasImporterResult so the
//     client can render the success summary.
//
//   • listJonasImports — returns the audit history (every Jonas batch
//     this club has ever opened) for the history rail on the page.
//
// Tenancy: every action resolves clubId from the authenticated session
// and the active-club resolver. The client never passes clubId.
// Authorization: every action requires the "settings:write" permission
// on the active club. Unauthorized callers are redirected to /app/admin.

"use server";

import { redirect } from "next/navigation";

import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getCurrentPrincipal } from "@/lib/services/principal";
import {
  DEFAULT_JONAS_ACCOUNT_MAPPING,
  InMemoryJonasImportHistory,
  JonasGlImporter,
  mapJonasAccount,
  parseJonasGlCsv,
  PrismaReportingLedger,
  type JonasImporterResult,
} from "@/lib/reporting/ledger";
import {
  computeFiscalLabels,
  computeFiscalYearStart,
  DEFAULT_FISCAL_YEAR_END,
} from "@/lib/reporting/ledger/importers/jonas-fiscal-period";
import type { JonasHeadingMetadata } from "@/lib/reporting/ledger/importers/jonas-gl-csv";
import { tallyJonasReconciliation } from "@/lib/reporting/ledger/importers/jonas-reconciliation";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Shapes the client component consumes
// ---------------------------------------------------------------------------

export type JonasImportPreview =
  | {
      status: "ok";
      rowCount: number;
      warnings: ReadonlyArray<{ lineNumber: number; column: string | null; message: string }>;
      mappingCoverage: { mapped: number; unmapped: number };
      unmappedAccounts: ReadonlyArray<{
        lineNumber: number;
        accountNumber: string;
        accountDescription: string;
      }>;
      reconciliation: {
        totalDebits: number;
        totalCredits: number;
        delta: number;
        isBalanced: boolean;
      };
      /** True when a committed TrialBalanceSnapshot already exists for
       *  this club at the requested periodEnd. Drives the duplicate-
       *  import warning. */
      existingSnapshotForPeriod: {
        snapshotId: string;
        capturedAt: string;
        reportingPeriod: string | null;
        sourceFile: string | null;
      } | null;
      /** Set when the source CSV was a Jonas-native trial-balance
       *  export. Includes the dates derived from the heading +
       *  club fiscal year end. The client form auto-populates +
       *  disables the date inputs when this is present; the commit
       *  action ignores any form-supplied dates and uses these
       *  values instead. */
      inferredDates: {
        periodStartIso: string;   // YYYY-MM-DD
        periodEndIso: string;     // YYYY-MM-DD
        fiscalYearLabel: string;  // e.g. "FY2026"
        fiscalPeriodSequence: number; // 1..12
        /** Human-readable summary, e.g. "Apr 2026 (period 4 of FY2026,
         *  Jan 1 2026 – Apr 30 2026)". Surfaced inline in the form. */
        summaryLabel: string;
      } | null;
    }
  | {
      status: "validation-failed";
      fileErrors: ReadonlyArray<{ kind: string; message: string }>;
      rowErrors: ReadonlyArray<{ lineNumber: number; column: string | null; message: string }>;
    };

export type JonasImportCommitResult = {
  status: JonasImporterResult["status"];
  notes: string | null;
  snapshotId: string | null;
  batchId: string;
  rowCount: number;
  replacedCount: number;
  reconciliation: {
    totalDebits: number;
    totalCredits: number;
    delta: number;
    isBalanced: boolean;
  };
  mappingCoverage: {
    mapped: number;
    unmapped: number;
  };
};

export type JonasImportHistoryEntryView = {
  batchId: string;
  state: string;
  openedAt: string;
  closedAt: string | null;
  sourceFile: string | null;
  notes: string | null;
  snapshotCount: number;
  trialBalanceSnapshot: {
    snapshotId: string;
    reportingPeriod: string | null;
    asOf: string | null;
    importedAt: string;
  } | null;
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

type RawInput = {
  csv: string;
  filename: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;   // YYYY-MM-DD
  fiscalYearLabel: string;
  fiscalPeriodSequence: number;
};

function parseInput(raw: FormData | RawInput): RawInput | { error: string } {
  if (raw instanceof FormData) {
    const csv = String(raw.get("csv") ?? "");
    const filename = String(raw.get("filename") ?? "import.csv");
    const periodStart = String(raw.get("periodStart") ?? "");
    const periodEnd = String(raw.get("periodEnd") ?? "");
    const fiscalYearLabel = String(raw.get("fiscalYearLabel") ?? "");
    const fpsRaw = String(raw.get("fiscalPeriodSequence") ?? "");
    const fiscalPeriodSequence = fpsRaw ? Number.parseInt(fpsRaw, 10) : 0;
    if (!csv.trim()) return { error: "CSV is required." };
    // Date + fiscal fields are NOT enforced at this layer — server
    // logic decides whether they're required (Jonas-native files
    // infer them; spectre-normalised files still require them).
    return { csv, filename, periodStart, periodEnd, fiscalYearLabel, fiscalPeriodSequence };
  }
  return raw;
}

/**
 * Resolve the effective period dates + fiscal labels for an import.
 * When the CSV is Jonas-native, ALL four values come from the
 * parser's `headingMetadata` + the club's fiscal-year-end policy.
 * When the CSV is spectre-normalised (no heading), the operator
 * must supply them via the form.
 *
 * Returns `{ error }` when the spectre-normalised path is missing
 * required form fields.
 */
async function resolveImportDates(args: {
  clubId: string;
  parsedHeadingMetadata: JonasHeadingMetadata | null;
  formInput: RawInput;
}): Promise<
  | {
      periodStart: Date;
      periodEnd: Date;
      fiscalYearLabel: string;
      fiscalPeriodSequence: number;
      inferred: boolean;
    }
  | { error: string }
> {
  if (args.parsedHeadingMetadata) {
    // Jonas-native — derive everything server-side. Fiscal-year-end
    // policy lives on ClubProfile (which has a 1:1 to Club by
    // clubId). Falls back to the Dec 31 default when the profile
    // hasn't been completed.
    const profile = await prisma.clubProfile.findUnique({
      where: { clubId: args.clubId },
      select: { fiscalYearEndMonth: true, fiscalYearEndDay: true },
    });
    const fyEndMonth = profile?.fiscalYearEndMonth ?? DEFAULT_FISCAL_YEAR_END.month;
    const fyEndDay = profile?.fiscalYearEndDay ?? DEFAULT_FISCAL_YEAR_END.day;
    const periodEnd = args.parsedHeadingMetadata.periodEndDate;
    const periodStart = computeFiscalYearStart(periodEnd, fyEndMonth, fyEndDay);
    // Derive the FISCAL year + fiscal period from the FY-end policy
    // rather than treating the heading's calendar values as fiscal
    // values. For off-calendar FYs the two differ (e.g. FY end
    // Jun 30 + statement May 31 → fiscal period 11, not 5).
    const labels = computeFiscalLabels(periodEnd, fyEndMonth, fyEndDay);
    return {
      periodStart,
      periodEnd,
      fiscalYearLabel: `FY${labels.fiscalYearNum}`,
      fiscalPeriodSequence: labels.fiscalPeriodNum,
      inferred: true,
    };
  }

  // Spectre-normalised path — operator-supplied dates required.
  const { periodStart, periodEnd, fiscalYearLabel, fiscalPeriodSequence } =
    args.formInput;
  if (!periodStart) return { error: "Period start date is required." };
  if (!periodEnd) return { error: "Period end date is required." };
  if (!fiscalYearLabel.trim()) {
    return { error: "Fiscal year label is required (e.g. FY2026)." };
  }
  if (!Number.isFinite(fiscalPeriodSequence) || fiscalPeriodSequence < 1) {
    return { error: "Fiscal period sequence must be a positive integer (1-12)." };
  }
  return {
    periodStart: toDate(periodStart, false),
    periodEnd: toDate(periodEnd, true),
    fiscalYearLabel,
    fiscalPeriodSequence,
    inferred: false,
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const MONTH_SHORT_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function toDate(yyyyMmDd: string, endOfDay = false): Date {
  // Treat input as UTC midnight (or end-of-day) to avoid local-tz drift.
  const [y, m, d] = yyyyMmDd.split("-").map((s) => Number.parseInt(s, 10));
  if (!y || !m || !d) throw new Error(`invalid date '${yyyyMmDd}'`);
  return endOfDay
    ? new Date(Date.UTC(y, m - 1, d, 23, 59, 59))
    : new Date(Date.UTC(y, m - 1, d));
}

// ---------------------------------------------------------------------------
// previewJonasImport
// ---------------------------------------------------------------------------

export async function previewJonasImport(
  input: FormData | RawInput,
): Promise<JonasImportPreview | { error: string }> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "settings:write")) redirect("/app/admin");

  const parsed = parseInput(input);
  if ("error" in parsed) return parsed;

  // 1. Parse + validate CSV (pure helper from the ledger module).
  const parseResult = parseJonasGlCsv(parsed.csv);
  if (!parseResult.ok) {
    return {
      status: "validation-failed",
      fileErrors: parseResult.fileErrors.map((e) => ({
        kind: e.kind,
        message: e.message,
      })),
      rowErrors: parseResult.rowErrors.map((e) => ({
        lineNumber: e.lineNumber,
        column: e.column,
        message: e.message,
      })),
    };
  }

  // 2. Account mapping coverage.
  //    Mapping coverage is INDEPENDENT of reconciliation — a row may
  //    be unmapped (no category) yet still contribute correct
  //    debit/credit totals.
  const mapping = DEFAULT_JONAS_ACCOUNT_MAPPING;
  let mappedCount = 0;
  const unmapped: Array<{
    lineNumber: number;
    accountNumber: string;
    accountDescription: string;
  }> = [];
  for (const row of parseResult.rows) {
    const mappedAccount = mapJonasAccount(
      {
        accountNumber: row.accountNumber,
        accountDescription: row.accountDescription,
        jonasAccountType: row.jonasAccountType,
      },
      mapping,
    );
    if (mappedAccount) {
      mappedCount++;
    } else {
      unmapped.push({
        lineNumber: row.lineNumber,
        accountNumber: row.accountNumber,
        accountDescription: row.accountDescription,
      });
    }
  }

  // 2b. Reconciliation — sums raw Debit/Credit columns when present
  //     (Jonas-native + any spectre CSV that ships explicit splits);
  //     falls back to YTD + natural-side derivation only when neither
  //     column is present on the row. See
  //     `src/lib/reporting/ledger/importers/jonas-reconciliation.ts`
  //     for the full rule.
  const reconciliation = tallyJonasReconciliation(parseResult.rows, mapping);
  const totalDebits = reconciliation.totalDebits;
  const totalCredits = reconciliation.totalCredits;
  const delta = reconciliation.delta;

  // 3. Resolve the effective period dates + fiscal labels. Jonas-
  //    native files derive everything from the heading + club FY-end
  //    policy; spectre-normalised files use the form values.
  const dateResolution = await resolveImportDates({
    clubId,
    parsedHeadingMetadata: parseResult.headingMetadata,
    formInput: parsed,
  });
  // Preview is permissive — if the form is still partially filled
  // for a non-Jonas-native CSV the operator hasn't completed the
  // input yet. Surface a soft inferredDates=null + skip the
  // duplicate-period check rather than erroring out.
  let inferredDates: Extract<JonasImportPreview, { status: "ok" }>["inferredDates"] = null;
  let periodEndDate: Date | null = null;
  if (!("error" in dateResolution)) {
    periodEndDate = dateResolution.periodEnd;
    if (dateResolution.inferred) {
      const md = parseResult.headingMetadata!;
      const fyStartLabel = `${MONTH_SHORT_LABELS[dateResolution.periodStart.getUTCMonth()]} ${dateResolution.periodStart.getUTCDate()} ${dateResolution.periodStart.getUTCFullYear()}`;
      const fyEndLabel = `${MONTH_SHORT_LABELS[periodEndDate.getUTCMonth()]} ${periodEndDate.getUTCDate()} ${periodEndDate.getUTCFullYear()}`;
      inferredDates = {
        periodStartIso: isoDate(dateResolution.periodStart),
        periodEndIso: isoDate(periodEndDate),
        fiscalYearLabel: dateResolution.fiscalYearLabel,
        fiscalPeriodSequence: dateResolution.fiscalPeriodSequence,
        summaryLabel: `${MONTH_SHORT_LABELS[md.calendarMonth - 1]} ${md.calendarYear} · period ${md.fiscalPeriod} of ${dateResolution.fiscalYearLabel} · ${fyStartLabel} – ${fyEndLabel}`,
      };
    }
  }

  // Duplicate-period check uses the resolved periodEnd when
  // available; otherwise skip (we'll surface in the commit path).
  const existing = periodEndDate
    ? await prisma.reportingLedgerSnapshot.findFirst({
        where: {
          clubId,
          entityKind: "trial-balance",
          batchState: "committed",
          asOf: periodEndDate,
        },
        orderBy: { capturedAt: "desc" },
        select: {
          snapshotId: true,
          capturedAt: true,
          reportingPeriod: true,
          sourceFile: true,
        },
      })
    : null;

  return {
    status: "ok",
    rowCount: parseResult.rows.length,
    warnings: parseResult.warnings.map((w) => ({
      lineNumber: w.lineNumber,
      column: w.column,
      message: w.message,
    })),
    mappingCoverage: {
      mapped: mappedCount,
      unmapped: unmapped.length,
    },
    unmappedAccounts: unmapped,
    reconciliation: {
      totalDebits,
      totalCredits,
      delta,
      isBalanced: Math.abs(delta) < 1,
    },
    existingSnapshotForPeriod: existing
      ? {
          snapshotId: existing.snapshotId,
          capturedAt: existing.capturedAt.toISOString(),
          reportingPeriod: existing.reportingPeriod,
          sourceFile: existing.sourceFile,
        }
      : null,
    inferredDates,
  };
}

// ---------------------------------------------------------------------------
// commitJonasImport
// ---------------------------------------------------------------------------

export async function commitJonasImport(
  input: FormData | RawInput,
): Promise<JonasImportCommitResult | { error: string }> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "settings:write")) redirect("/app/admin");

  const parsed = parseInput(input);
  if ("error" in parsed) return parsed;

  // Re-parse the CSV once on the server to recover the heading
  // metadata. The importer parses internally too, but we need the
  // metadata BEFORE the importer runs so we can supply the
  // inferred period dates as inputs. This is safe — the parser is
  // pure and fast.
  const preflightParse = parseJonasGlCsv(parsed.csv);
  const headingMetadata = preflightParse.ok ? preflightParse.headingMetadata : null;

  const dateResolution = await resolveImportDates({
    clubId,
    parsedHeadingMetadata: headingMetadata,
    formInput: parsed,
  });
  if ("error" in dateResolution) return dateResolution;

  const ledger = new PrismaReportingLedger(prisma);
  const importer = new JonasGlImporter({
    writer: ledger,
    history: new InMemoryJonasImportHistory(), // fresh per-request — DB is the source of truth
  });

  let result: JonasImporterResult;
  try {
    result = await importer.importJonasExtract({
      clubId,
      extract: {
        csv: parsed.csv,
        filename: parsed.filename,
        // Inferred when CSV is Jonas-native (form values ignored
        // by `resolveImportDates`); form values when spectre-
        // normalised.
        periodStart: dateResolution.periodStart,
        periodEnd: dateResolution.periodEnd,
        fiscalYearLabel: dateResolution.fiscalYearLabel,
        fiscalPeriodSequence: dateResolution.fiscalPeriodSequence,
      },
      notes:
        `Jonas GL import via admin UI (${parsed.filename})` +
        (dateResolution.inferred ? " · dates inferred from CSV heading" : ""),
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Unknown import error",
    };
  }

  return {
    status: result.status,
    notes: result.notes,
    snapshotId: result.snapshotId,
    batchId: result.batchId,
    rowCount: result.diagnostics.rowCount,
    replacedCount: result.replacedCount,
    reconciliation: result.diagnostics.reconciliation,
    mappingCoverage: {
      mapped: result.diagnostics.mappingCoverage.mapped,
      unmapped: result.diagnostics.mappingCoverage.unmapped,
    },
  };
}

// ---------------------------------------------------------------------------
// listJonasImports — audit history for the active club
// ---------------------------------------------------------------------------

export async function listJonasImports(): Promise<JonasImportHistoryEntryView[]> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "settings:write")) redirect("/app/admin");

  const batches = await prisma.reportingLedgerBatch.findMany({
    where: { clubId, sourceSystem: "jonas-gl" },
    orderBy: { openedAt: "desc" },
    take: 50,
    include: {
      snapshots: {
        where: { entityKind: "trial-balance" },
        orderBy: { capturedAt: "desc" },
        take: 1,
        select: {
          snapshotId: true,
          reportingPeriod: true,
          asOf: true,
          importedAt: true,
        },
      },
      _count: { select: { snapshots: true } },
    },
  });

  return batches.map((b) => ({
    batchId: b.batchId,
    state: b.state,
    openedAt: b.openedAt.toISOString(),
    closedAt: b.closedAt?.toISOString() ?? null,
    sourceFile: b.sourceFile,
    notes: b.notes,
    snapshotCount: b._count.snapshots,
    trialBalanceSnapshot: b.snapshots[0]
      ? {
          snapshotId: b.snapshots[0].snapshotId,
          reportingPeriod: b.snapshots[0].reportingPeriod,
          asOf: b.snapshots[0].asOf?.toISOString() ?? null,
          importedAt: b.snapshots[0].importedAt.toISOString(),
        }
      : null,
  }));
}
