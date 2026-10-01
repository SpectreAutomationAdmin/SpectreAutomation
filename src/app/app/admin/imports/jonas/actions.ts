// Jonas GL import — server actions for the /app/admin/imports/jonas route.
//
// TB-RESET-1d.b.2 (2026-09-29) — final founder-operated importer.
// Three server-action endpoints + one read helper:
//
//   • previewJonasImport   — accepts XLSX or CSV, parses, runs mapping
//                            + reconciliation + duplicate detection,
//                            returns a rich preview WITHOUT writing
//                            anything to the ledger.
//
//   • commitJonasImport    — creates a ReportingLedgerBatch (pending)
//                            + writes a TrialBalanceSnapshot + commits
//                            atomically. Persists sourceFileHash and
//                            createdByUserId. Enforces all commit
//                            gates server-side. Supports explicit
//                            replaceExistingBatchId for the atomic
//                            supersession flow.
//
//   • listJonasImports     — returns the audit history for the active
//                            club, including supersession state.
//
// Tenancy: every action resolves clubId server-side. Authorization
// requires "settings:write". Every uploaded byte is parsed server-side —
// the client's parsed values are never trusted.

"use server";

import { randomUUID } from "node:crypto";

import { redirect } from "next/navigation";

import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getCurrentPrincipal } from "@/lib/services/principal";
import {
  DEFAULT_JONAS_ACCOUNT_MAPPING,
  JonasGlImporter,
  InMemoryJonasImportHistory,
  mapJonasAccount,
  parseJonasGlCsv,
  PrismaReportingLedger,
  type JonasImporterResult,
} from "@/lib/reporting/ledger";
import {
  computeFiscalLabels,
  computeFiscalYearStart,
  DEFAULT_FISCAL_YEAR_END,
  lastDayOfMonthUtc,
} from "@/lib/reporting/ledger/importers/jonas-fiscal-period";
import type { JonasHeadingMetadata } from "@/lib/reporting/ledger/importers/jonas-gl-csv";
import { tallyJonasReconciliation } from "@/lib/reporting/ledger/importers/jonas-reconciliation";
import {
  computeCsvSourceHash,
  parseJonasXlsxBuffer,
} from "@/lib/reporting/ledger/importers/jonas-xlsx-adapter";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Balance tolerance — $0.01 per TB-RESET-1d.b.2 §6.
// ---------------------------------------------------------------------------
const BALANCE_TOLERANCE = 0.01;

// ---------------------------------------------------------------------------
// Public preview / commit shapes
// ---------------------------------------------------------------------------

export type JonasImportPreviewRow = {
  lineNumber: number;
  accountCode: string;
  jonasDescription: string;
  spectreAccountName: string | null;
  spectreAccountId: string | null;
  debit: number;
  credit: number;
  // TB-HIST-2 (2026-10-01) — dimensional preview fields. `department`
  // is the raw Jonas department code (empty string normalised to null);
  // `departmentStatus` reports whether it resolves to a tenant
  // Department record, is missing against a REQUIRED-policy account,
  // or is unused. `fund` is the account-level mapped fund.
  department: string | null;
  departmentStatus: "ok" | "missing-required" | "unknown-dept" | "n/a";
  fund: string | null;
  mappingStatus: "mapped" | "unmapped" | "description-conflict" | "duplicate";
};

export type JonasImportPreview =
  | {
      status: "ok";
      /** Total source rows encountered. */
      rowCount: number;
      warnings: ReadonlyArray<{ lineNumber: number; column: string | null; message: string }>;
      /** Full per-row preview — every source account row appears here.
       *  Founder rule §4: show ALL rows, not merely exceptions. */
      rows: ReadonlyArray<JonasImportPreviewRow>;
      mappingCoverage: {
        mapped: number;
        unmapped: number;
        descriptionConflicts: number;
        duplicates: number;
      };
      reconciliation: {
        totalDebits: number;
        totalCredits: number;
        delta: number;
        isBalanced: boolean;
        tolerance: number;
      };
      /** Committed snapshot present at the same effective date? Drives
       *  the duplicate-period gate. */
      existingSnapshotForPeriod: {
        batchId: string;
        snapshotId: string;
        capturedAt: string;
        reportingPeriod: string | null;
        sourceFile: string | null;
        sourceFileHash: string | null;
      } | null;
      /** Committed batch that already imported this exact file for this
       *  tenant? Drives the duplicate-file gate. */
      duplicateSourceFileBatch: {
        batchId: string;
        openedAt: string;
        closedAt: string | null;
        sourceFile: string | null;
        asOf: string | null;
      } | null;
      inferredDates:
        | {
            periodStartIso: string;
            periodEndIso: string;
            fiscalYearLabel: string;
            fiscalPeriodSequence: number;
            summaryLabel: string;
          }
        | null;
      /** Full resolved effective date (may be inferred OR founder-selected). */
      resolvedDates:
        | {
            periodStartIso: string;
            periodEndIso: string;
            fiscalYearLabel: string;
            fiscalPeriodSequence: number;
          }
        | null;
      detectedEntity: string | null;
      hasJonasHeading: boolean;
      sourceFileHash: string;
      sourceFilename: string;
      targetTenantName: string;
      requiresEntityMismatchAcknowledgement: boolean;
      /** True when the caller has not yet supplied an effective date
       *  (heading absent AND founder hasn't chosen one on the form). */
      requiresEffectiveDateSelection: boolean;
    }
  | {
      status: "validation-failed";
      fileErrors: ReadonlyArray<{ kind: string; message: string }>;
      rowErrors: ReadonlyArray<{ lineNumber: number; column: string | null; message: string }>;
    };

export type JonasImportCommitResult =
  | {
      status: "committed";
      batchId: string;
      snapshotId: string;
      supersededBatchId: string | null;
      rowCount: number;
      totalDebits: number;
      totalCredits: number;
      delta: number;
      periodEndIso: string;
      reportingPeriod: string | null;
      committedAt: string;
      committedByUserId: string;
      sourceFile: string;
      sourceFileHash: string;
      links: {
        trialBalance: string;
        balanceSheet: string;
        monthlyBoardPackage: string;
      };
    }
  | {
      status: "blocked";
      reason: string;
      code:
        | "PARSE_FAILED"
        | "EFFECTIVE_DATE_MISSING"
        | "UNBALANCED"
        | "UNKNOWN_ACCOUNT"
        | "DUPLICATE_ACCOUNT"
        | "DUPLICATE_SOURCE_FILE"
        | "DUPLICATE_PERIOD"
        | "ENTITY_MISMATCH_UNACKNOWLEDGED"
        | "REPLACE_TARGET_INVALID"
        // TB-HIST-2 (2026-10-01) — dimensional validation gates.
        | "UNKNOWN_DEPARTMENT"
        | "MISSING_REQUIRED_DEPARTMENT";
      details?: unknown;
    }
  | { error: string };

export type JonasImportHistoryEntryView = {
  batchId: string;
  state: string;
  openedAt: string;
  closedAt: string | null;
  sourceFile: string | null;
  sourceFileHash: string | null;
  createdByUserId: string | null;
  supersededByBatchId: string | null;
  snapshotCount: number;
  trialBalanceSnapshot: {
    snapshotId: string;
    reportingPeriod: string | null;
    asOf: string | null;
    importedAt: string;
    payloadTotalDebits: number | null;
    payloadTotalCredits: number | null;
  } | null;
};

// ---------------------------------------------------------------------------
// Input decoding
// ---------------------------------------------------------------------------

type ParsedInput = {
  /** Effective CSV text — either the pasted CSV or the XLSX adapter's output. */
  csv: string;
  /** The uploaded filename. */
  filename: string;
  /** SHA-256 of the original uploaded bytes (workbook OR pasted CSV). */
  sourceFileHash: string;
  /** Entity detected by the XLSX adapter — null for pasted CSV. */
  detectedEntity: string | null;
  hasJonasHeading: boolean;
  /** Founder-selected effective date override (YYYY-MM-DD) — takes
   *  precedence over any inferred date when supplied. */
  effectiveDateOverride: string | null;
  /** Entity mismatch acknowledgement — commit refuses without it when
   *  a detected entity differs from the target tenant. */
  entityMismatchAcknowledged: boolean;
  /** Explicit replacement authority — commit refuses to replace an
   *  existing authoritative snapshot without this. */
  replaceExistingBatchId: string | null;
};

async function decodeInput(raw: FormData): Promise<ParsedInput | { error: string }> {
  const xlsxBase64 = String(raw.get("xlsxBase64") ?? "");
  const csvRaw = String(raw.get("csv") ?? "");
  const filename = String(raw.get("filename") ?? "import.csv");
  const effectiveDateOverride = String(raw.get("effectiveDateOverride") ?? "").trim() || null;
  const entityMismatchAcknowledged = String(raw.get("entityMismatchAcknowledged") ?? "") === "true";
  const replaceExistingBatchId = String(raw.get("replaceExistingBatchId") ?? "").trim() || null;

  if (xlsxBase64) {
    try {
      const buf = Buffer.from(xlsxBase64, "base64");
      if (buf.length === 0) return { error: "Uploaded file is empty." };
      const result = await parseJonasXlsxBuffer(buf);
      return {
        csv: result.csv,
        filename,
        sourceFileHash: result.sourceFileHash,
        detectedEntity: result.detectedEntity,
        hasJonasHeading: result.hasJonasHeading,
        effectiveDateOverride,
        entityMismatchAcknowledged,
        replaceExistingBatchId,
      };
    } catch (err) {
      return { error: `Failed to parse XLSX: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (!csvRaw.trim()) return { error: "Upload an XLSX file or paste CSV." };
  return {
    csv: csvRaw,
    filename,
    sourceFileHash: computeCsvSourceHash(csvRaw),
    detectedEntity: null,
    hasJonasHeading: false,
    effectiveDateOverride,
    entityMismatchAcknowledged,
    replaceExistingBatchId,
  };
}

// ---------------------------------------------------------------------------
// Date resolution
// ---------------------------------------------------------------------------

type DateResolution =
  | {
      periodStart: Date;
      periodEnd: Date;
      fiscalYearLabel: string;
      fiscalPeriodSequence: number;
      inferred: boolean;
    }
  | null;

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toEndOfDayUtc(yyyyMmDd: string): Date | null {
  const [y, m, d] = yyyyMmDd.split("-").map((s) => Number.parseInt(s, 10));
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59));
}

async function resolveDates(args: {
  clubId: string;
  headingMetadata: JonasHeadingMetadata | null;
  overrideIso: string | null;
}): Promise<DateResolution> {
  // Founder-selected override wins over any heading — the Controller
  // must always be able to correct a mis-detected date.
  const overrideDate = args.overrideIso ? toEndOfDayUtc(args.overrideIso) : null;
  const periodEnd = overrideDate ?? args.headingMetadata?.periodEndDate ?? null;
  if (!periodEnd) return null;

  const profile = await prisma.clubProfile.findUnique({
    where: { clubId: args.clubId },
    select: { fiscalYearEndMonth: true, fiscalYearEndDay: true },
  });
  const fyEndMonth = profile?.fiscalYearEndMonth ?? DEFAULT_FISCAL_YEAR_END.month;
  const fyEndDay = profile?.fiscalYearEndDay ?? DEFAULT_FISCAL_YEAR_END.day;
  const periodStart = computeFiscalYearStart(periodEnd, fyEndMonth, fyEndDay);
  const labels = computeFiscalLabels(periodEnd, fyEndMonth, fyEndDay);

  // Snap the resolved periodEnd to true last-day-of-month for the
  // month the caller specified. Ensures a manual selection of the
  // 15th still gets bumped to the correct month-end asOf key.
  const endMonthEnd = lastDayOfMonthUtc(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() + 1);
  return {
    periodStart,
    periodEnd: endMonthEnd,
    fiscalYearLabel: `FY${labels.fiscalYearNum}`,
    fiscalPeriodSequence: labels.fiscalPeriodNum,
    inferred: !args.overrideIso && args.headingMetadata != null,
  };
}

// ---------------------------------------------------------------------------
// previewJonasImport
// ---------------------------------------------------------------------------

export async function previewJonasImport(
  input: FormData,
): Promise<JonasImportPreview | { error: string }> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "settings:write")) redirect("/app/admin");

  const decoded = await decodeInput(input);
  if ("error" in decoded) return decoded;

  const parseResult = parseJonasGlCsv(decoded.csv);
  if (!parseResult.ok) {
    return {
      status: "validation-failed",
      fileErrors: parseResult.fileErrors.map((e) => ({ kind: e.kind, message: e.message })),
      rowErrors: parseResult.rowErrors.map((e) => ({
        lineNumber: e.lineNumber, column: e.column, message: e.message,
      })),
    };
  }

  // ------------- Per-row COA mapping + description conflict + duplicate detection -------------
  const mapping = DEFAULT_JONAS_ACCOUNT_MAPPING;
  const rows: JonasImportPreviewRow[] = [];
  let mappedCount = 0;
  let unmappedCount = 0;
  let descriptionConflicts = 0;
  // TB-HIST-2 (2026-10-01) — dimensional duplicate detection. The row
  // identity for a historical TB snapshot is (accountCode, department,
  // fund). Two rows that share only accountCode but differ on
  // department are legitimate (e.g. 6098/F&B and 6098/Admin — one
  // natural account, two departmental allocations). Only an exact
  // (code, dept, fund) duplicate is rejected.
  const seenKeys = new Set<string>();
  const duplicateKeys = new Set<string>();

  // Preload every ACTIVE Spectre account for the club.
  const spectreAccounts = await prisma.account.findMany({
    where: { clubId, isActive: true, archivedAt: null, isHeader: false },
    select: {
      id: true,
      accountNumber: true,
      name: true,
      // TB-HIST-2 — expose policy so the preview can flag
      // missing-required and classify unknown-department.
      departmentPolicy: true,
    },
  });
  const spectreByCode = new Map(spectreAccounts.map((a) => [a.accountNumber, a]));
  // Preload Department codes to validate per-row department tags.
  const departments = await prisma.department.findMany({
    where: { clubId },
    select: { code: true },
  });
  const tenantDepartmentCodes = new Set(departments.map((d) => d.code.trim().toUpperCase()));

  for (const r of parseResult.rows) {
    const code = r.accountNumber;
    const rawDept = r.department && r.department.trim().length > 0 ? r.department.trim() : null;
    // Dimensional dup-key — case-insensitive on department.
    const dimKey = `${code}\u0000${rawDept ? rawDept.toUpperCase() : ""}`;
    const isDup = seenKeys.has(dimKey);
    if (isDup) duplicateKeys.add(dimKey);
    seenKeys.add(dimKey);

    const spectre = spectreByCode.get(code) ?? null;
    const jonasCategory = mapJonasAccount(
      {
        accountNumber: code,
        accountDescription: r.accountDescription,
        jonasAccountType: r.jonasAccountType,
      },
      mapping,
    );

    let status: JonasImportPreviewRow["mappingStatus"];
    if (isDup) {
      status = "duplicate";
    } else if (!spectre) {
      status = "unmapped";
      unmappedCount++;
    } else if (
      spectre.name.trim().toLowerCase() !== r.accountDescription.trim().toLowerCase() &&
      !descriptionsMatchNormalised(spectre.name, r.accountDescription)
    ) {
      status = "description-conflict";
      descriptionConflicts++;
      mappedCount++;
    } else {
      status = "mapped";
      mappedCount++;
    }
    void jonasCategory;

    // TB-HIST-2 — classify the row's Department against the tenant
    // catalog + the account's departmentPolicy.
    let departmentStatus: JonasImportPreviewRow["departmentStatus"];
    if (!spectre) {
      departmentStatus = "n/a";
    } else if (spectre.departmentPolicy === "NOT_APPLICABLE") {
      departmentStatus = "n/a";
    } else if (rawDept === null) {
      departmentStatus = spectre.departmentPolicy === "REQUIRED" ? "missing-required" : "n/a";
    } else if (!tenantDepartmentCodes.has(rawDept.toUpperCase())) {
      departmentStatus = "unknown-dept";
    } else {
      departmentStatus = "ok";
    }

    rows.push({
      lineNumber: r.lineNumber,
      accountCode: code,
      jonasDescription: r.accountDescription,
      spectreAccountName: spectre?.name ?? null,
      spectreAccountId: spectre?.id ?? null,
      debit: r.debit ?? 0,
      credit: Math.abs(r.credit ?? 0),
      department: rawDept,
      departmentStatus,
      fund: jonasCategory?.fund ?? null,
      mappingStatus: status,
    });
  }
  // Legacy identifier for the mappingCoverage summary — stays the
  // count of DIMENSIONAL duplicates.
  const duplicateCodes = duplicateKeys;

  // ------------- Reconciliation -------------
  const reconciliation = tallyJonasReconciliation(parseResult.rows, mapping);
  const isBalanced = Math.abs(reconciliation.delta) <= BALANCE_TOLERANCE;

  // ------------- Effective-date resolution -------------
  const dateResolution = await resolveDates({
    clubId,
    headingMetadata: parseResult.headingMetadata,
    overrideIso: decoded.effectiveDateOverride,
  });

  let inferredDates: Extract<JonasImportPreview, { status: "ok" }>["inferredDates"] = null;
  let resolvedDates: Extract<JonasImportPreview, { status: "ok" }>["resolvedDates"] = null;
  if (dateResolution) {
    resolvedDates = {
      periodStartIso: isoDate(dateResolution.periodStart),
      periodEndIso: isoDate(dateResolution.periodEnd),
      fiscalYearLabel: dateResolution.fiscalYearLabel,
      fiscalPeriodSequence: dateResolution.fiscalPeriodSequence,
    };
    if (dateResolution.inferred && parseResult.headingMetadata) {
      const md = parseResult.headingMetadata;
      const fyStartLabel = `${MONTH_SHORT[dateResolution.periodStart.getUTCMonth()]} ${dateResolution.periodStart.getUTCDate()} ${dateResolution.periodStart.getUTCFullYear()}`;
      const fyEndLabel = `${MONTH_SHORT[dateResolution.periodEnd.getUTCMonth()]} ${dateResolution.periodEnd.getUTCDate()} ${dateResolution.periodEnd.getUTCFullYear()}`;
      inferredDates = {
        periodStartIso: isoDate(dateResolution.periodStart),
        periodEndIso: isoDate(dateResolution.periodEnd),
        fiscalYearLabel: dateResolution.fiscalYearLabel,
        fiscalPeriodSequence: dateResolution.fiscalPeriodSequence,
        summaryLabel: `${MONTH_SHORT[md.calendarMonth - 1]} ${md.calendarYear} · period ${md.fiscalPeriod} of ${dateResolution.fiscalYearLabel} · ${fyStartLabel} – ${fyEndLabel}`,
      };
    }
  }

  // ------------- Duplicate-period detection (exact-asOf, committed only) -------------
  let existingSnapshotForPeriod: Extract<JonasImportPreview, { status: "ok" }>["existingSnapshotForPeriod"] = null;
  if (dateResolution) {
    const existing = await prisma.reportingLedgerSnapshot.findFirst({
      where: {
        clubId,
        entityKind: "trial-balance",
        batchState: "committed",
        asOf: dateResolution.periodEnd,
      },
      orderBy: [{ capturedAt: "desc" }],
      select: {
        snapshotId: true,
        capturedAt: true,
        reportingPeriod: true,
        sourceFile: true,
        importBatchId: true,
      },
    });
    if (existing) {
      let sourceFileHash: string | null = null;
      if (existing.importBatchId) {
        const batch = await prisma.reportingLedgerBatch.findUnique({
          where: { batchId: existing.importBatchId },
          select: { sourceFileHash: true },
        });
        sourceFileHash = batch?.sourceFileHash ?? null;
      }
      existingSnapshotForPeriod = {
        batchId: existing.importBatchId ?? "",
        snapshotId: existing.snapshotId,
        capturedAt: existing.capturedAt.toISOString(),
        reportingPeriod: existing.reportingPeriod,
        sourceFile: existing.sourceFile,
        sourceFileHash,
      };
    }
  }

  // ------------- Duplicate-source-file detection -------------
  const dupFileBatch = await prisma.reportingLedgerBatch.findFirst({
    where: {
      clubId,
      sourceSystem: "jonas-gl",
      state: "committed",
      sourceFileHash: decoded.sourceFileHash,
    },
    orderBy: [{ openedAt: "desc" }],
    select: {
      batchId: true,
      openedAt: true,
      closedAt: true,
      sourceFile: true,
      snapshots: {
        where: { entityKind: "trial-balance" },
        orderBy: { capturedAt: "desc" },
        take: 1,
        select: { asOf: true },
      },
    },
  });
  const duplicateSourceFileBatch = dupFileBatch
    ? {
        batchId: dupFileBatch.batchId,
        openedAt: dupFileBatch.openedAt.toISOString(),
        closedAt: dupFileBatch.closedAt?.toISOString() ?? null,
        sourceFile: dupFileBatch.sourceFile,
        asOf: dupFileBatch.snapshots[0]?.asOf?.toISOString() ?? null,
      }
    : null;

  // ------------- Entity handling -------------
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { name: true },
  });
  const targetTenantName = club?.name ?? "";
  const requiresEntityMismatchAcknowledgement =
    !!decoded.detectedEntity &&
    !!targetTenantName &&
    decoded.detectedEntity.trim().toLowerCase() !== targetTenantName.trim().toLowerCase();

  const requiresEffectiveDateSelection = dateResolution == null;

  return {
    status: "ok",
    rowCount: parseResult.rows.length,
    warnings: parseResult.warnings.map((w) => ({
      lineNumber: w.lineNumber, column: w.column, message: w.message,
    })),
    rows,
    mappingCoverage: {
      mapped: mappedCount,
      unmapped: unmappedCount,
      descriptionConflicts,
      duplicates: duplicateCodes.size,
    },
    reconciliation: {
      totalDebits: reconciliation.totalDebits,
      totalCredits: reconciliation.totalCredits,
      delta: reconciliation.delta,
      isBalanced,
      tolerance: BALANCE_TOLERANCE,
    },
    existingSnapshotForPeriod,
    duplicateSourceFileBatch,
    inferredDates,
    resolvedDates,
    detectedEntity: decoded.detectedEntity,
    hasJonasHeading: decoded.hasJonasHeading,
    sourceFileHash: decoded.sourceFileHash,
    sourceFilename: decoded.filename,
    targetTenantName,
    requiresEntityMismatchAcknowledgement,
    requiresEffectiveDateSelection,
  };
}

// ---------------------------------------------------------------------------
// commitJonasImport — atomic supersession-aware commit
// ---------------------------------------------------------------------------

export async function commitJonasImport(
  input: FormData,
): Promise<JonasImportCommitResult> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "settings:write")) redirect("/app/admin");

  const decoded = await decodeInput(input);
  if ("error" in decoded) return { error: decoded.error };

  const parseResult = parseJonasGlCsv(decoded.csv);
  if (!parseResult.ok) {
    return {
      status: "blocked",
      code: "PARSE_FAILED",
      reason: "Source file could not be parsed.",
      details: { fileErrors: parseResult.fileErrors, rowErrors: parseResult.rowErrors },
    };
  }

  // Effective-date gate
  const dateResolution = await resolveDates({
    clubId,
    headingMetadata: parseResult.headingMetadata,
    overrideIso: decoded.effectiveDateOverride,
  });
  if (!dateResolution) {
    return {
      status: "blocked",
      code: "EFFECTIVE_DATE_MISSING",
      reason: "Effective date is required. The uploaded file does not carry a reliable date — select it explicitly.",
    };
  }

  // Balance gate ($0.01)
  const mapping = DEFAULT_JONAS_ACCOUNT_MAPPING;
  const reconciliation = tallyJonasReconciliation(parseResult.rows, mapping);
  if (Math.abs(reconciliation.delta) > BALANCE_TOLERANCE) {
    return {
      status: "blocked",
      code: "UNBALANCED",
      reason: `Trial Balance differs by $${Math.abs(reconciliation.delta).toFixed(2)}. Tolerance is $${BALANCE_TOLERANCE.toFixed(2)}.`,
      details: {
        totalDebits: reconciliation.totalDebits,
        totalCredits: reconciliation.totalCredits,
        delta: reconciliation.delta,
        tolerance: BALANCE_TOLERANCE,
      },
    };
  }

  // COA mapping / duplicate-key gates — dimensional per TB-HIST-2 §6.
  const spectreAccountsForCommit = await prisma.account.findMany({
    where: { clubId, isActive: true, archivedAt: null, isHeader: false },
    select: { accountNumber: true, departmentPolicy: true },
  });
  const spectreCodes = new Set(spectreAccountsForCommit.map((a) => a.accountNumber));
  const spectrePolicyByCode = new Map(
    spectreAccountsForCommit.map((a) => [a.accountNumber, a.departmentPolicy as string]),
  );
  const commitDepartments = await prisma.department.findMany({
    where: { clubId },
    select: { code: true },
  });
  const commitTenantDeptCodes = new Set(commitDepartments.map((d) => d.code.trim().toUpperCase()));

  const seenCommitKeys = new Set<string>();
  const duplicateCommitKeys: string[] = [];
  const unknownCodes = new Set<string>();
  const unknownDepartments = new Set<string>();
  const missingRequiredDept: string[] = [];

  for (const r of parseResult.rows) {
    if (!spectreCodes.has(r.accountNumber)) unknownCodes.add(r.accountNumber);
    const rawDept = r.department && r.department.trim().length > 0 ? r.department.trim() : null;
    const dimKey = `${r.accountNumber}\u0000${rawDept ? rawDept.toUpperCase() : ""}`;
    if (seenCommitKeys.has(dimKey)) {
      duplicateCommitKeys.push(rawDept ? `${r.accountNumber}/${rawDept}` : r.accountNumber);
    }
    seenCommitKeys.add(dimKey);

    const policy = spectrePolicyByCode.get(r.accountNumber);
    if (rawDept && !commitTenantDeptCodes.has(rawDept.toUpperCase())) {
      unknownDepartments.add(rawDept);
    }
    if (policy === "REQUIRED" && rawDept === null) {
      missingRequiredDept.push(r.accountNumber);
    }
  }

  if (unknownCodes.size > 0) {
    return {
      status: "blocked",
      code: "UNKNOWN_ACCOUNT",
      reason: `${unknownCodes.size} source account(s) do not resolve to the Spectre Chart of Accounts. Resolve or update the COA before importing.`,
      details: { unknown: Array.from(unknownCodes) },
    };
  }
  if (duplicateCommitKeys.length > 0) {
    return {
      status: "blocked",
      code: "DUPLICATE_ACCOUNT",
      reason:
        `${duplicateCommitKeys.length} duplicate (account, department) key(s) in the source file. ` +
        `Each (account, department) combination must appear at most once per snapshot.`,
      details: { duplicates: duplicateCommitKeys },
    };
  }
  if (unknownDepartments.size > 0) {
    return {
      status: "blocked",
      code: "UNKNOWN_DEPARTMENT",
      reason:
        `${unknownDepartments.size} unknown Department code(s) in the source file. ` +
        `Add the Department to the club before importing or correct the source.`,
      details: { unknown: Array.from(unknownDepartments) },
    };
  }
  if (missingRequiredDept.length > 0) {
    return {
      status: "blocked",
      code: "MISSING_REQUIRED_DEPARTMENT",
      reason:
        `${missingRequiredDept.length} source row(s) target an account whose departmentPolicy is REQUIRED but ` +
        `carry no Department tag. Add a Department column to each row or revise the account's policy.`,
      details: { accounts: missingRequiredDept },
    };
  }

  // Entity-mismatch gate
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { name: true },
  });
  const targetTenantName = club?.name ?? "";
  const requiresAck =
    !!decoded.detectedEntity &&
    !!targetTenantName &&
    decoded.detectedEntity.trim().toLowerCase() !== targetTenantName.trim().toLowerCase();
  if (requiresAck && !decoded.entityMismatchAcknowledged) {
    return {
      status: "blocked",
      code: "ENTITY_MISMATCH_UNACKNOWLEDGED",
      reason: `Source workbook identifies "${decoded.detectedEntity}" but the target tenant is "${targetTenantName}". Acknowledge the mismatch before committing.`,
    };
  }

  // Duplicate-source-file gate
  const dupFile = await prisma.reportingLedgerBatch.findFirst({
    where: {
      clubId,
      sourceSystem: "jonas-gl",
      state: "committed",
      sourceFileHash: decoded.sourceFileHash,
    },
    select: { batchId: true, sourceFile: true, openedAt: true },
  });
  if (dupFile) {
    return {
      status: "blocked",
      code: "DUPLICATE_SOURCE_FILE",
      reason: `An identical source file was already committed on ${dupFile.openedAt.toISOString().slice(0, 10)} (batch ${dupFile.batchId}). Uploading the same file twice is not permitted.`,
      details: dupFile,
    };
  }

  // Duplicate-period gate — refuse without explicit replaceExistingBatchId
  const existingSnapshot = await prisma.reportingLedgerSnapshot.findFirst({
    where: {
      clubId,
      entityKind: "trial-balance",
      batchState: "committed",
      asOf: dateResolution.periodEnd,
    },
    select: { snapshotId: true, importBatchId: true, sourceFile: true },
  });
  if (existingSnapshot && !decoded.replaceExistingBatchId) {
    return {
      status: "blocked",
      code: "DUPLICATE_PERIOD",
      reason: `An authoritative Trial Balance already exists for ${isoDate(dateResolution.periodEnd)}. Use the Replace Existing Trial Balance workflow to supersede it.`,
      details: {
        existingSnapshotId: existingSnapshot.snapshotId,
        existingBatchId: existingSnapshot.importBatchId,
        existingSourceFile: existingSnapshot.sourceFile,
      },
    };
  }
  if (decoded.replaceExistingBatchId) {
    if (!existingSnapshot || existingSnapshot.importBatchId !== decoded.replaceExistingBatchId) {
      return {
        status: "blocked",
        code: "REPLACE_TARGET_INVALID",
        reason: "Replacement target does not match the existing authoritative batch. Refresh the preview and retry.",
      };
    }
  }

  // ---------- Commit path ----------
  const now = new Date();
  const ledger = new PrismaReportingLedger(prisma);
  const importer = new JonasGlImporter({
    writer: ledger,
    history: new InMemoryJonasImportHistory(),
  });

  let result: JonasImporterResult;
  try {
    result = await importer.importJonasExtract({
      clubId,
      extract: {
        csv: decoded.csv,
        filename: decoded.filename,
        periodStart: dateResolution.periodStart,
        periodEnd: dateResolution.periodEnd,
        fiscalYearLabel: dateResolution.fiscalYearLabel,
        fiscalPeriodSequence: dateResolution.fiscalPeriodSequence,
      },
      notes:
        `Jonas GL import via admin UI (${decoded.filename})` +
        (dateResolution.inferred ? " · dates inferred from CSV heading" : " · effective date confirmed by controller") +
        (decoded.replaceExistingBatchId ? ` · replaces batch ${decoded.replaceExistingBatchId}` : ""),
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unknown import error" };
  }

  // Post-hoc updates: persist sourceFileHash + createdByUserId on the
  // batch the importer just wrote (the importer's own API doesn't
  // expose these fields yet). Also atomically supersede the old batch
  // when this is a replacement commit — same transaction as the
  // sourceFileHash / createdByUserId update so no observable state
  // shows two authoritative snapshots.
  const supersededBatchId = decoded.replaceExistingBatchId ?? null;
  await prisma.$transaction(async (tx) => {
    await tx.reportingLedgerBatch.update({
      where: { batchId: result.batchId },
      data: {
        sourceFileHash: decoded.sourceFileHash,
        createdByUserId: principal.id,
      },
    });
    if (supersededBatchId) {
      // Flip the OLD batch to rolled-back + point it at the NEW one.
      await tx.reportingLedgerBatch.update({
        where: { batchId: supersededBatchId },
        data: {
          state: "rolled-back",
          closedAt: now,
          supersededByBatchId: result.batchId,
        },
      });
      await tx.reportingLedgerSnapshot.updateMany({
        where: { importBatchId: supersededBatchId, batchState: "committed" },
        data: { batchState: "rolled-back" },
      });
    }
  });

  const periodEndIso = isoDate(dateResolution.periodEnd);
  return {
    status: "committed",
    batchId: result.batchId,
    snapshotId: result.snapshotId ?? "",
    supersededBatchId,
    rowCount: result.diagnostics.rowCount,
    totalDebits: result.diagnostics.reconciliation.totalDebits,
    totalCredits: result.diagnostics.reconciliation.totalCredits,
    delta: result.diagnostics.reconciliation.delta,
    periodEndIso,
    reportingPeriod: null,
    committedAt: now.toISOString(),
    committedByUserId: principal.id,
    sourceFile: decoded.filename,
    sourceFileHash: decoded.sourceFileHash,
    links: {
      trialBalance: `/app/admin/reports/trial-balance?asOf=${periodEndIso}`,
      balanceSheet: `/app/admin/reports/balance-sheet?asOf=${periodEndIso}`,
      monthlyBoardPackage: `/app/admin/reporting/monthly?asOf=${periodEndIso}`,
    },
  };
}

// ---------------------------------------------------------------------------
// listJonasImports — history with supersession state
// ---------------------------------------------------------------------------

export async function listJonasImports(): Promise<JonasImportHistoryEntryView[]> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "settings:write")) redirect("/app/admin");

  const batches = await prisma.reportingLedgerBatch.findMany({
    where: { clubId, sourceSystem: "jonas-gl" },
    orderBy: [{ openedAt: "desc" }],
    take: 100,
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
          payloadJson: true,
        },
      },
      _count: { select: { snapshots: true } },
    },
  });

  return batches.map((b) => {
    const snap = b.snapshots[0];
    let totalDebits: number | null = null;
    let totalCredits: number | null = null;
    if (snap?.payloadJson) {
      try {
        const p = JSON.parse(snap.payloadJson) as { totalDebits?: number; totalCredits?: number };
        totalDebits = typeof p.totalDebits === "number" ? p.totalDebits : null;
        totalCredits = typeof p.totalCredits === "number" ? p.totalCredits : null;
      } catch { /* ignore */ }
    }
    return {
      batchId: b.batchId,
      state: b.state,
      openedAt: b.openedAt.toISOString(),
      closedAt: b.closedAt?.toISOString() ?? null,
      sourceFile: b.sourceFile,
      sourceFileHash: b.sourceFileHash,
      createdByUserId: b.createdByUserId,
      supersededByBatchId: b.supersededByBatchId,
      snapshotCount: b._count.snapshots,
      trialBalanceSnapshot: snap
        ? {
            snapshotId: snap.snapshotId,
            reportingPeriod: snap.reportingPeriod,
            asOf: snap.asOf?.toISOString() ?? null,
            importedAt: snap.importedAt.toISOString(),
            payloadTotalDebits: totalDebits,
            payloadTotalCredits: totalCredits,
          }
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Description-normalisation match (whitespace/case-insensitive plus
// permissive punctuation collapse). Kept simple by design — the
// founder brief allows a mismatch when "existing approved reconciliation
// rules" permit it, and the Jonas mapping layer already handles the
// tricky abbreviation cases. This function catches the trivial
// "same text, different case/whitespace" case that shouldn't be
// flagged.
// ---------------------------------------------------------------------------
function descriptionsMatchNormalised(a: string, b: string): boolean {
  const normalise = (s: string): string =>
    s
      .trim()
      .toLowerCase()
      .replace(/[\s,;.]+/g, " ")
      .replace(/[^a-z0-9 ]/g, "")
      .trim();
  return normalise(a) === normalise(b);
}
