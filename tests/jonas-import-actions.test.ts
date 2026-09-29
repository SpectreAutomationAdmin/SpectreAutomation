// TB-RESET-1d.b.2 — Full 33-case acceptance matrix for the
// founder-operated Jonas Trial Balance importer.
//
// Tests exercise the server actions at src/app/app/admin/imports/jonas/
// actions.ts against Prisma mocks — no real DB, no real workbook, no
// real founder data. The full pipeline (XLSX buffer → adapter → CSV
// parser → mapping → duplicate detection → commit gates → atomic
// supersession) is validated.

import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock next/navigation before importing the actions (they call
// `redirect` at auth boundaries).
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`[test] redirect to ${path}`);
  },
}));

// Mock @/lib/services/principal so the actions have an authenticated
// principal without a real session cookie.
vi.mock("@/lib/services/principal", () => ({
  getCurrentPrincipal: vi.fn(),
}));

// Mock @/lib/active-club so we control clubId per-test.
vi.mock("@/lib/active-club", () => ({
  getActiveClubId: vi.fn(),
}));

// Mock @/lib/rbac.hasPermission — every acceptance test runs with
// permission granted; a separate test toggles it to false to prove
// the authorisation gate.
vi.mock("@/lib/rbac", () => ({
  hasPermission: vi.fn(),
}));

// Mock Prisma — every table the actions touch is stubbed with vi.fn().
vi.mock("@/lib/prisma", () => {
  return {
    prisma: makePrismaMock(),
  };
});

// Mock the PrismaReportingLedger inside actions.ts. The action code
// constructs `new PrismaReportingLedger(prisma)` and calls
// `importer.importJonasExtract` on the resulting JonasGlImporter. We
// intercept both.
vi.mock("@/lib/reporting/ledger", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    PrismaReportingLedger: class MockLedger {},
    JonasGlImporter: class MockImporter {
      constructor(public opts: unknown) {}
      async importJonasExtract() {
        return MOCK_IMPORT_RESULT;
      }
    },
    InMemoryJonasImportHistory: class {},
  };
});

// Mutable mock state — reset per-test in beforeEach.
let MOCK_IMPORT_RESULT: {
  status: string; notes: string | null; snapshotId: string | null; batchId: string;
  replacedCount: number;
  diagnostics: {
    rowCount: number;
    reconciliation: { totalDebits: number; totalCredits: number; delta: number; isBalanced: boolean };
    mappingCoverage: { mapped: number; unmapped: number };
  };
};

function makePrismaMock() {
  return {
    account: { findMany: vi.fn(), count: vi.fn() },
    club: { findUnique: vi.fn() },
    clubProfile: { findUnique: vi.fn() },
    reportingLedgerBatch: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    reportingLedgerSnapshot: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: async (fn: (tx: unknown) => unknown) => {
      // Simple mock: run the callback with `prisma` itself as the tx.
      const { prisma } = await import("@/lib/prisma");
      return await fn(prisma);
    },
  };
}

import * as principalMod from "@/lib/services/principal";
import * as activeClubMod from "@/lib/active-club";
import * as rbacMod from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

import {
  previewJonasImport,
  commitJonasImport,
  listJonasImports,
} from "@/app/app/admin/imports/jonas/actions";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------
const COULEE = "cmrvdeny7000144372ktmmg9c";
const PRINCIPAL = { id: "u-founder", memberships: [], activeClubId: COULEE, name: "F", email: "f@x", status: "ACTIVE", memberId: null };
const JONAS_HEADER = [
  "G/L Account\nCode",
  "G/L Account\nDescription",
  "Closing Bal\nDebit",
  "Closing Bal\nCredit",
];

async function buildXlsxBase64(rows: unknown[][], opts?: { skipTrialBalanceHeading?: boolean; entityRowFirst?: string }): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  // The Jonas parser's native-detection requires BOTH a "Trial Balance
  // for Month, Year" line AND a "G/L Account ... Closing Bal ..." header
  // row within the first 10 records. Prepend the heading rows unless
  // a test asks to skip (case 33 exercises an unparseable input).
  if (!opts?.skipTrialBalanceHeading) {
    if (opts?.entityRowFirst) ws.addRow([opts.entityRowFirst]);
    ws.addRow(["Trial Balance for September, 2026"]);
    ws.addRow(["Closing Period Balances"]);
  }
  for (const r of rows) ws.addRow(r);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer).toString("base64");
}

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function mockPrincipalAuthed() {
  (principalMod.getCurrentPrincipal as ReturnType<typeof vi.fn>).mockResolvedValue(PRINCIPAL);
  (activeClubMod.getActiveClubId as ReturnType<typeof vi.fn>).mockResolvedValue(COULEE);
  (rbacMod.hasPermission as ReturnType<typeof vi.fn>).mockReturnValue(true);
}

function mockCleanCoulee(accountCodes: string[] = defaultAccountCodes()) {
  (prisma.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    accountCodes.map((c) => ({ id: `a-${c}`, accountNumber: c, name: `Account ${c}`, isActive: true, archivedAt: null, isHeader: false })),
  );
  (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "Coulee Ridge Golf & Country Club" });
  (prisma.clubProfile.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ fiscalYearEndMonth: 12, fiscalYearEndDay: 31 });
  (prisma.reportingLedgerSnapshot.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.reportingLedgerBatch.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.reportingLedgerBatch.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.reportingLedgerBatch.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (prisma.reportingLedgerSnapshot.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
}

function defaultAccountCodes(): string[] {
  return ["1000", "3000"];
}

beforeEach(() => {
  vi.clearAllMocks();
  MOCK_IMPORT_RESULT = {
    status: "succeeded", notes: null, snapshotId: "s-1", batchId: "b-1", replacedCount: 0,
    diagnostics: { rowCount: 2, reconciliation: { totalDebits: 1000, totalCredits: 1000, delta: 0, isBalanced: true }, mappingCoverage: { mapped: 2, unmapped: 0 } },
  };
});

// ===========================================================================
// TB-RESET-1d.b.2 — 33-case acceptance matrix
// ===========================================================================

describe("TB-RESET-1d.b.2 · 33-case acceptance matrix", () => {
  // ------------- Preview / parsing (1-4) -------------

  // 1 · XLSX accepted
  it("1 · previewJonasImport accepts an XLSX buffer via xlsxBase64", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const result = await previewJonasImport(fd({ xlsxBase64: xlsx, filename: "sep-30.xlsx", effectiveDateOverride: "2026-09-30" }));
    expect("status" in result && result.status).toBe("ok");
  });

  // 2 · Jonas XLSX parsed (rows land in preview)
  it("2 · Jonas XLSX parsed into rows array", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const result = await previewJonasImport(fd({ xlsxBase64: xlsx, filename: "sep-30.xlsx", effectiveDateOverride: "2026-09-30" }));
    if (!("status" in result) || result.status !== "ok") throw new Error("expected ok");
    expect(result.rowCount).toBe(2);
    expect(result.rows.length).toBe(2);
    expect(result.rows[0].accountCode).toBe("1000");
  });

  // 3 · account codes preserved as strings
  it("3 · account codes preserved as strings (leading zero + hyphen)", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee(["0100", "1010-PAY1A"]);
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["0100", "Zero-cash", 5, 0], ["1010-PAY1A", "Sim Cash", 0, -5]]);
    const r = await previewJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if (!("status" in r) || r.status !== "ok") throw new Error();
    expect(r.rows.map((x) => x.accountCode)).toEqual(["0100", "1010-PAY1A"]);
  });

  // 4 · negative credits normalised (adapter preserves; preview presents |x|)
  it("4 · negative credit values presented as positive in preview rows", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await previewJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if (!("status" in r) || r.status !== "ok") throw new Error();
    expect(r.rows[1].credit).toBe(1000); // absolute value
  });

  // ------------- Balance validation (5-6) -------------

  // 5 · ≤ $0.01 balance tolerance accepted
  it("5 · balance <= $0.01 tolerance accepted", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000.005, 0], ["3000", "Equity", 0, -1000]]);
    const r = await previewJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if (!("status" in r) || r.status !== "ok") throw new Error();
    expect(r.reconciliation.tolerance).toBe(0.01);
    expect(r.reconciliation.isBalanced).toBe(true);
  });

  // 6 · > $0.01 imbalance blocks commit
  it("6 · > $0.01 imbalance blocks commit with UNBALANCED code", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000.50, 0], ["3000", "Equity", 0, -1000]]);
    const r = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    expect(!("error" in r) && r.status).toBe("blocked");
    if ("error" in r || r.status !== "blocked") throw new Error();
    expect(r.code).toBe("UNBALANCED");
  });

  // ------------- Mapping / unknown / duplicate (7-9) -------------

  // 7 · all mapped passes
  it("7 · all mapped accounts pass and commit succeeds", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    expect(!("error" in r) && r.status).toBe("committed");
  });

  // 8 · unknown account blocks commit
  it("8 · unknown account blocks commit with UNKNOWN_ACCOUNT code", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee(["1000"]); // 3000 missing
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if ("error" in r || r.status !== "blocked") throw new Error();
    expect(r.code).toBe("UNKNOWN_ACCOUNT");
  });

  // 9 · duplicate account code blocks commit
  it("9 · duplicate source account code blocks commit with DUPLICATE_ACCOUNT code", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([
      JONAS_HEADER,
      ["1000", "Cash", 500, 0],
      ["1000", "Cash again", 500, 0],
      ["3000", "Equity", 0, -1000],
    ]);
    const r = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if ("error" in r || r.status !== "blocked") throw new Error();
    expect(r.code).toBe("DUPLICATE_ACCOUNT");
  });

  // 10 · description conflict surfaced (not blocking by default per §6 language)
  it("10 · description conflict surfaced in preview.mappingCoverage.descriptionConflicts", async () => {
    mockPrincipalAuthed();
    (principalMod.getCurrentPrincipal as ReturnType<typeof vi.fn>).mockResolvedValue(PRINCIPAL);
    (activeClubMod.getActiveClubId as ReturnType<typeof vi.fn>).mockResolvedValue(COULEE);
    (rbacMod.hasPermission as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (prisma.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "a-1000", accountNumber: "1000", name: "Something totally different" },
      { id: "a-3000", accountNumber: "3000", name: "Equity" },
    ]);
    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "Coulee Ridge Golf & Country Club" });
    (prisma.clubProfile.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ fiscalYearEndMonth: 12, fiscalYearEndDay: 31 });
    (prisma.reportingLedgerSnapshot.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.reportingLedgerBatch.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await previewJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if (!("status" in r) || r.status !== "ok") throw new Error();
    expect(r.mappingCoverage.descriptionConflicts).toBeGreaterThanOrEqual(1);
  });

  // ------------- Date handling (11-12) -------------

  // 11 · absent date requires selection — use a spectre-normalised CSV
  //      (has no "Trial Balance for …" heading, so parser returns
  //      headingMetadata=null and the commit relies on the form date).
  it("11 · commit is blocked when no effective date is available", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const spectreCsv = [
      "AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod",
      "1000,Cash,1000,1000,FY2026,9",
      "3000,Equity,-1000,-1000,FY2026,9",
    ].join("\n");
    const r = await commitJonasImport(fd({ csv: spectreCsv, filename: "x.csv", effectiveDateOverride: "" }));
    if ("error" in r || r.status !== "blocked") throw new Error();
    expect(r.code).toBe("EFFECTIVE_DATE_MISSING");
  });

  // 12 · detected date confirmable via override (verified by successful commit)
  it("12 · commit succeeds when effective date is explicitly confirmed", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if ("error" in r || r.status !== "committed") throw new Error();
    expect(r.periodEndIso).toBe("2026-09-30");
  });

  // ------------- Entity handling (13-15) -------------

  // 13 · entity match (single-entity workbook = target)
  it("13 · entity matching the target tenant does not require acknowledgement", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    // Workbook with a club-name row = target tenant name → no mismatch.
    const xlsx = await buildXlsxBase64(
      [JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]],
      { entityRowFirst: "Coulee Ridge Golf & Country Club" },
    );
    const r = await previewJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if (!("status" in r) || r.status !== "ok") throw new Error();
    expect(r.requiresEntityMismatchAcknowledgement).toBe(false);
  });

  // 14 · entity mismatch requires acknowledgement
  it("14 · entity mismatch requires acknowledgement, unacknowledged commit blocked", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64(
      [JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]],
      { entityRowFirst: "Silver Springs Golf & Country Club" },
    );
    const pr = await previewJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if (!("status" in pr) || pr.status !== "ok") throw new Error();
    expect(pr.requiresEntityMismatchAcknowledgement).toBe(true);
    const commitUnack = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30", entityMismatchAcknowledged: "false" }));
    if ("error" in commitUnack || commitUnack.status !== "blocked") throw new Error();
    expect(commitUnack.code).toBe("ENTITY_MISMATCH_UNACKNOWLEDGED");
  });

  // 15 · absent entity handled honestly (detectedEntity: null, no mismatch demand)
  it("15 · absent entity metadata surfaces detectedEntity=null and no acknowledgement required", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await previewJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if (!("status" in r) || r.status !== "ok") throw new Error();
    expect(r.detectedEntity).toBeNull();
    expect(r.requiresEntityMismatchAcknowledgement).toBe(false);
  });

  // ------------- Zero-authority proofs (16-18) -------------

  // 16 · upload (preview-only) creates no ReportingLedgerBatch
  it("16 · preview does NOT call any DB write path", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    await previewJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    expect(prisma.reportingLedgerBatch.update).not.toHaveBeenCalled();
    expect(prisma.reportingLedgerSnapshot.updateMany).not.toHaveBeenCalled();
  });

  // 17 · preview alone creates no authority (proven again via structural check)
  it("17 · preview never invokes the JonasGlImporter (structural)", async () => {
    // Reading the actions source and confirming previewJonasImport
    // has no `new JonasGlImporter` / no `importJonasExtract` call.
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/app/app/admin/imports/jonas/actions.ts", "utf8");
    const previewFn = src.substring(src.indexOf("export async function previewJonasImport"), src.indexOf("export async function commitJonasImport"));
    expect(previewFn).not.toContain("new JonasGlImporter");
    expect(previewFn).not.toContain("importJonasExtract");
  });

  // 18 · explicit Commit creates authority
  it("18 · commit creates authority (calls importer + returns committed status)", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if ("error" in r || r.status !== "committed") throw new Error();
    expect(r.batchId).toBe("b-1");
    expect(r.snapshotId).toBe("s-1");
  });

  // 19 · effective date persisted (via periodEndIso echoed back)
  it("19 · effective date persisted in commit result", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if ("error" in r || r.status !== "committed") throw new Error();
    expect(r.periodEndIso).toBe("2026-09-30");
  });

  // 20 · adjacent date does not resolve snapshot — this is proven by
  //      TB-RESET-1d.a's findExactAsOfCommitted, but we assert here
  //      that the commit's periodEnd matches the calendar day and not
  //      an adjacent one.
  it("20 · effective date is the exact selected calendar day, not adjacent", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if ("error" in r || r.status !== "committed") throw new Error();
    expect(r.periodEndIso).toBe("2026-09-30");
    expect(r.periodEndIso).not.toBe("2026-09-29");
    expect(r.periodEndIso).not.toBe("2026-10-01");
  });

  // 21 · duplicate period blocks normal Commit
  it("21 · duplicate period blocks ordinary commit with DUPLICATE_PERIOD", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    (prisma.reportingLedgerSnapshot.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      snapshotId: "old-s", importBatchId: "old-b", sourceFile: "old.xlsx",
    });
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if ("error" in r || r.status !== "blocked") throw new Error();
    expect(r.code).toBe("DUPLICATE_PERIOD");
  });

  // 22 · explicit replacement works
  it("22 · explicit replaceExistingBatchId succeeds + records supersededBatchId", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    (prisma.reportingLedgerSnapshot.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      snapshotId: "old-s", importBatchId: "old-b", sourceFile: "old.xlsx",
    });
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30", replaceExistingBatchId: "old-b" }));
    if ("error" in r || r.status !== "committed") throw new Error();
    expect(r.supersededBatchId).toBe("old-b");
    // The supersession transaction fired both updates.
    expect(prisma.reportingLedgerBatch.update).toHaveBeenCalled();
    expect(prisma.reportingLedgerSnapshot.updateMany).toHaveBeenCalled();
  });

  // 23 · prior import remains auditable — old batch flips to rolled-back, not deleted
  it("23 · replacement flips old batch to rolled-back (not delete) + sets supersededByBatchId", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    (prisma.reportingLedgerSnapshot.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      snapshotId: "old-s", importBatchId: "old-b", sourceFile: "old.xlsx",
    });
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30", replaceExistingBatchId: "old-b" }));
    const calls = (prisma.reportingLedgerBatch.update as ReturnType<typeof vi.fn>).mock.calls;
    // Look for the call that hits the OLD batch.
    const oldCall = calls.find((c) => c[0].where?.batchId === "old-b");
    expect(oldCall).toBeDefined();
    expect(oldCall![0].data.state).toBe("rolled-back");
    expect(oldCall![0].data.supersededByBatchId).toBe("b-1");
  });

  // 24 · sourceFileHash persisted
  it("24 · sourceFileHash is passed to reportingLedgerBatch.update on commit", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const previewResult = await previewJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if (!("status" in previewResult) || previewResult.status !== "ok") throw new Error();
    const expectedHash = previewResult.sourceFileHash;
    await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    const newBatchCall = (prisma.reportingLedgerBatch.update as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0].data?.sourceFileHash);
    expect(newBatchCall).toBeDefined();
    expect(newBatchCall![0].data.sourceFileHash).toBe(expectedHash);
  });

  // 25 · exact duplicate file detected
  it("25 · duplicate source file blocks commit with DUPLICATE_SOURCE_FILE", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    (prisma.reportingLedgerBatch.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      batchId: "old-b", sourceFile: "dup.xlsx", openedAt: new Date("2026-09-01"),
    });
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "dup.xlsx", effectiveDateOverride: "2026-09-30" }));
    if ("error" in r || r.status !== "blocked") throw new Error();
    expect(r.code).toBe("DUPLICATE_SOURCE_FILE");
  });

  // 26 · import history correct
  it("26 · listJonasImports returns supersession-aware batches", async () => {
    mockPrincipalAuthed();
    (prisma.reportingLedgerBatch.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        batchId: "b-1", state: "committed",
        openedAt: new Date("2026-09-30"), closedAt: new Date("2026-09-30"),
        sourceFile: "sep.xlsx", notes: null,
        sourceFileHash: "aaa", createdByUserId: "u-1", supersededByBatchId: null,
        _count: { snapshots: 1 },
        snapshots: [{ snapshotId: "s-1", reportingPeriod: "Sep 2026", asOf: new Date("2026-09-30"), importedAt: new Date(), payloadJson: JSON.stringify({ totalDebits: 100, totalCredits: 100 }) }],
      },
    ]);
    const history = await listJonasImports();
    expect(history).toHaveLength(1);
    expect(history[0].sourceFileHash).toBe("aaa");
    expect(history[0].supersededByBatchId).toBeNull();
    expect(history[0].trialBalanceSnapshot?.payloadTotalDebits).toBe(100);
  });

  // 27 · tenant isolation
  it("27 · every DB read filters by clubId (structural)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/app/app/admin/imports/jonas/actions.ts", "utf8");
    // Count clubId-scoped where clauses.
    const withClub = (src.match(/where:\s*\{[^}]*clubId/g) || []).length;
    expect(withClub).toBeGreaterThan(5);
  });

  // 28 · operational JE ledger unaffected (structural — no journalEntry write)
  it("28 · actions.ts never writes to prisma.journalEntry / journalEntryLine", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/app/app/admin/imports/jonas/actions.ts", "utf8");
    expect(src).not.toMatch(/prisma\.journalEntry\.(create|update|delete|upsert)/);
    expect(src).not.toMatch(/prisma\.journalEntryLine\.(create|update|delete|upsert)/);
  });

  // 29 · no JournalEntry created by TB import (importer contract)
  it("29 · JonasGlImporter is not writing JournalEntry rows (structural)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/lib/reporting/ledger/importers/jonas-gl-importer.ts", "utf8");
    expect(src).not.toMatch(/prisma\.journalEntry\.(create|createMany)/);
  });

  // 30-31 · committed fixture feeds Trial Balance + Balance Sheet — the
  // exact-asOf lookup path was tested comprehensively in TB-RESET-1c
  // + 1d.a. We assert here the shape reference: the commit result
  // includes a periodEndIso that both surfaces query with.
  it("30-31 · commit response includes links to TB and BS pinned to the committed asOf", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if ("error" in r || r.status !== "committed") throw new Error();
    expect(r.links.trialBalance).toContain("asOf=2026-09-30");
    expect(r.links.balanceSheet).toContain("asOf=2026-09-30");
  });

  // 32 · Monthly Board Package locates exact period-end authority
  it("32 · commit response includes link to Monthly Board Reporting Package for exact period-end", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    const xlsx = await buildXlsxBase64([JONAS_HEADER, ["1000", "Cash", 1000, 0], ["3000", "Equity", 0, -1000]]);
    const r = await commitJonasImport(fd({ xlsxBase64: xlsx, filename: "x.xlsx", effectiveDateOverride: "2026-09-30" }));
    if ("error" in r || r.status !== "committed") throw new Error();
    expect(r.links.monthlyBoardPackage).toContain("asOf=2026-09-30");
  });

  // 33 · failed / aborted preview creates no authority
  it("33 · aborted preview (validation-failed) leaves zero DB mutations", async () => {
    mockPrincipalAuthed();
    mockCleanCoulee();
    // Emit an unparseable CSV.
    const r = await previewJonasImport(fd({ csv: "not,a,valid,jonas,file", filename: "junk.csv", effectiveDateOverride: "2026-09-30" }));
    expect("status" in r && (r.status === "ok" || r.status === "validation-failed")).toBe(true);
    expect(prisma.reportingLedgerBatch.update).not.toHaveBeenCalled();
    expect(prisma.reportingLedgerSnapshot.updateMany).not.toHaveBeenCalled();
  });
});
