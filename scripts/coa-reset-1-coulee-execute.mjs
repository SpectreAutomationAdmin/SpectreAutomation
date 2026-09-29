// COA-RESET-1 — Coulee Ridge accounting reset to Account = 0.
//
// Founder-authorized destructive reset of Coulee's accounting layer
// so a fresh Jonas Master COA can be imported. Coulee is disposable
// staging; historical fixture accounting records are removed to
// unblock referential integrity for physical Account deletion.
//
// FIXUP 3 (2026-09-29) — comprehensive preflight + newly-covered FKs:
//   * Embedded pg_constraint walk classifies EVERY RESTRICT / NO ACTION
//     incoming FK for the tables this reset touches, and ABORTS before
//     any destructive write if an unhandled live-row FK is found. This
//     replaces the earlier reactive one-FK-at-a-time discovery loop.
//   * PayrollBatch self-references (correctsPayrollBatchId,
//     pairedReversalBatchId, reversesPayrollBatchId) are explicitly
//     nullified on Coulee rows before payrollBatch.deleteMany. This is
//     acceptable ONLY because the Coulee payroll history being removed
//     is disposable fixture history — do NOT generalize.
//   * PayrollOpeningBalanceComponent (NOACT on PayrollComponent) is
//     now deleted before PayrollComponent.
//   * BudgetLine + ForecastLine (RESTRICT on Account) — 0 Coulee rows
//     today but included so the reset is correct by FK graph, not
//     accidentally correct by fixture population.
//   * FingerprintMismatchEvent (RESTRICT on PayrollBatch) — 0 Coulee
//     rows today, same rationale.
//   * PayrollZeroHoursAcknowledgement (CASCADE on PayrollBatch) —
//     0 Coulee rows today, explicit for auditability.
//
// SAFETY GATES (in order):
//   1. Refuses without --commit unless in dry-run mode.
//   2. Refuses without COA_RESET_1_CONFIRM=COULEE-COA-WIPE for commit.
//   3. Refuses if club != Coulee Ridge / stagingDataMode != FOUNDER_REVIEW.
//   4. EMBEDDED PREFLIGHT — walks pg_constraint for the destructive
//      target set and classifies every RESTRICT / NO ACTION incoming
//      FK as A / B / C / D. Any unhandled dependency with live rows
//      aborts the reset before any write.
//   5. Prints a manifest of every deletion/nullification before executing.
//
// FK PREFLIGHT CLASSIFICATIONS (see KNOWN_HANDLING below):
//   A. EXPLICITLY DELETED BEFORE TARGET
//   B. EXPLICITLY NULLIFIED / CLEARED BEFORE TARGET
//   C. SELF-REFERENCE EXPLICITLY BROKEN
//   D. ZERO LIVE COULEE ROWS, BUT STRUCTURALLY ACCOUNTED FOR
//   (CASCADE dependencies are reported as db-handled, not classified.)
//
// PRESERVE (never touched):
//   Club, User, UserClubRole, ClubProfile (structure), ClubFeatures,
//   Employee, HR/onboarding rows, Vendor (structure only), Member*,
//   Department, AccountCategory, FinancialStatementGroup,
//   WorkIntakeItem + related work-intake surface,
//   ReportingLedgerBatch/Snapshot (already 0 rows on Coulee).

import { PrismaClient } from "@prisma/client";
import {
  TARGET_TABLES,
  buildPreflightReport,
  formatPreflightReport,
} from "./lib/coa-reset-1-preflight.mjs";

const COULEE = "cmrvdeny7000144372ktmmg9c";
const CONFIRM_TOKEN = "COULEE-COA-WIPE";

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--commit");
const PREFLIGHT_ONLY = args.includes("--preflight-only");
const CONFIRM = process.env.COA_RESET_1_CONFIRM ?? "";

function log(...a) { process.stdout.write(a.join(" ") + "\n"); }
function assert(cond, msg) { if (!cond) throw new Error("SAFETY: " + msg); }

// TARGET_TABLES + KNOWN_HANDLING are defined in the shared lib
// (./lib/coa-reset-1-preflight.mjs) so tests can exercise the
// classifier without loading Prisma / hitting a database.

// ---------------------------------------------------------------------------
// preflight — pg_constraint walk. Read-only. Fetches the raw FK graph for
// TARGET_TABLES, attaches JOIN-based Coulee-scoped live-row counts, then
// hands the rows to the pure `buildPreflightReport()` classifier.
// ---------------------------------------------------------------------------
async function preflight(prisma) {
  const targets = Array.from(TARGET_TABLES);
  const rawRows = await prisma.$queryRawUnsafe(`
    SELECT
      con.conname                                          AS constraint_name,
      src_tbl.relname                                      AS source_table,
      (array_agg(src_col.attname ORDER BY u.ord))[1]        AS source_col,
      tgt_tbl.relname                                      AS target_table,
      (array_agg(tgt_col.attname ORDER BY u.ord))[1]        AS target_col,
      CASE con.confdeltype
        WHEN 'a' THEN 'NO ACTION'
        WHEN 'r' THEN 'RESTRICT'
        WHEN 'c' THEN 'CASCADE'
        WHEN 'n' THEN 'SET NULL'
        WHEN 'd' THEN 'SET DEFAULT'
      END                                                  AS on_delete
    FROM pg_constraint con
    JOIN pg_class src_tbl  ON src_tbl.oid = con.conrelid
    JOIN pg_class tgt_tbl  ON tgt_tbl.oid = con.confrelid
    JOIN LATERAL unnest(con.conkey)  WITH ORDINALITY AS u(k, ord)   ON TRUE
    JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS f(fk, ord2) ON f.ord2 = u.ord
    JOIN pg_attribute src_col ON src_col.attrelid = con.conrelid  AND src_col.attnum = u.k
    JOIN pg_attribute tgt_col ON tgt_col.attrelid = con.confrelid AND tgt_col.attnum = f.fk
    WHERE con.contype = 'f'
      AND tgt_tbl.relname = ANY($1::text[])
    GROUP BY con.conname, src_tbl.relname, tgt_tbl.relname, con.confdeltype
    ORDER BY tgt_tbl.relname, src_tbl.relname, con.conname
  `, targets);

  // Attach Coulee-scoped live counts via JOIN through the FK. This proves
  // tenant ownership through the parent relationship rather than trusting
  // child.clubId (per founder Point 5).
  for (const r of rawRows) {
    if (r.on_delete !== "RESTRICT" && r.on_delete !== "NO ACTION") continue;
    try {
      const c = await prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::int AS n
        FROM "${r.source_table}" src
        JOIN "${r.target_table}" tgt ON src."${r.source_col}" = tgt."${r.target_col}"
        WHERE tgt."clubId" = $1
          AND src."${r.source_col}" IS NOT NULL
      `, COULEE);
      r.live_rows = c[0]?.n ?? 0;
      r.scope = "join";
    } catch (e) {
      // Target lacks clubId — cannot prove scope. Report unfiltered count.
      const c = await prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::int AS n
        FROM "${r.source_table}" src
        WHERE src."${r.source_col}" IS NOT NULL
      `);
      r.live_rows = c[0]?.n ?? 0;
      r.scope = "unfiltered";
    }
  }

  return buildPreflightReport(rawRows);
}

function printPreflightReport(report) {
  log("");
  log(formatPreflightReport(report));
}

async function main() {
  const p = new PrismaClient();
  try {
    log("");
    log("======================================================================");
    log("COA-RESET-1 — Coulee Ridge accounting reset to Account = 0");
    log("======================================================================");
    log("Mode:              ", DRY_RUN ? "DRY-RUN (no writes)" : "COMMIT");
    log("Preflight-only:    ", PREFLIGHT_ONLY ? "yes" : "no");
    log("Confirm token env: ", CONFIRM ? "provided" : "MISSING");
    log("Tenant guard:      ", COULEE);
    log("");

    if (!DRY_RUN) assert(CONFIRM === CONFIRM_TOKEN, `COA_RESET_1_CONFIRM must equal "${CONFIRM_TOKEN}" for a COMMIT run.`);

    const club = await p.club.findUnique({
      where: { id: COULEE },
      select: { id: true, name: true, stagingDataMode: true },
    });
    assert(club, `Club ${COULEE} not found.`);
    assert(club.name === "Coulee Ridge Golf & Country Club", `Club name mismatch: ${club.name}`);
    assert(club.stagingDataMode === "FOUNDER_REVIEW", `Refusing: stagingDataMode=${club.stagingDataMode} (must be FOUNDER_REVIEW)`);
    log("Tenant verified:   ", club.name, "(", club.stagingDataMode, ")");

    // ---------- PREFLIGHT ----------
    const report = await preflight(p);
    printPreflightReport(report);
    if (!report.ok) {
      log("");
      log("== COA-RESET-1 REFUSED — preflight failed, zero mutation performed ==");
      process.exit(2);
    }

    if (PREFLIGHT_ONLY) {
      log("");
      log("== --preflight-only mode: exiting without further work ==");
      return;
    }

    // ---------- MANIFEST ----------
    const w = { clubId: COULEE };
    const before = {
      account: await p.account.count({ where: w }),
      accountActive: await p.account.count({ where: { ...w, isActive: true } }),
      accountInactive: await p.account.count({ where: { ...w, isActive: false } }),
      accountDepartment: await p.accountDepartment.count({ where: w }),
      journalEntry: await p.journalEntry.count({ where: w }),
      journalEntryLine: await p.journalEntryLine.count({ where: w }),
      journalAttachment: await p.journalAttachment.count({ where: w }),
      apInvoiceLine: await p.aPInvoiceLine.count({ where: w }),
      apInvoice: await p.aPInvoice.count({ where: w }),
      vendorPayment: await p.vendorPayment.count({ where: w }),
      paymentBatchItem: await p.paymentBatchItem.count({ where: w }),
      paymentBatch: await p.paymentBatch.count({ where: w }),
      paymentEvent: await p.paymentEvent.count({ where: w }),
      paymentDestinationSnapshot: await p.paymentDestinationSnapshot.count({ where: w }),
      paymentInstruction: await p.paymentInstruction.count({ where: w }),
      paymentRun: await p.paymentRun.count({ where: w }),
      payrollBatch: await p.payrollBatch.count({ where: w }),
      payrollBatchSelfRefNonNull: await p.payrollBatch.count({
        where: {
          clubId: COULEE,
          OR: [
            { correctsPayrollBatchId: { not: null } },
            { pairedReversalBatchId: { not: null } },
            { reversesPayrollBatchId: { not: null } },
          ],
        },
      }),
      payrollComponent: await p.payrollComponent.count({ where: w }),
      payrollOpeningBalanceComponent: await p.payrollOpeningBalanceComponent.count({ where: w }),
      payrollGlAccountingProfile: await p.payrollGlAccountingProfile.count({ where: w }),
      bankAccount: await p.bankAccount.count({ where: w }),
      budgetLine: await p.budgetLine.count({ where: w }),
      forecastLine: await p.forecastLine.count({ where: w }),
      fingerprintMismatchEvent: await p.fingerprintMismatchEvent.count({ where: w }),
      payrollZeroHoursAcknowledgement: await p.payrollZeroHoursAcknowledgement.count({ where: w }),
      vendor: await p.vendor.count({ where: w }),
      taxCode: await p.taxCode.count({ where: w }),
      importBatchCoa: await p.importBatch.count({ where: { ...w, domain: "COA" } }),
      // Preserved (informational only):
      user: await p.user.count(),
      employee: await p.employee.count({ where: w }),
      accountCategory: await p.accountCategory.count({ where: w }),
      financialStatementGroup: await p.financialStatementGroup.count({ where: w }),
      department: await p.department.count({ where: w }),
      workIntakeItem: await p.workIntakeItem.count({ where: w }),
    };
    log("");
    log("BEFORE — Coulee accounting counts:");
    for (const [k, v] of Object.entries(before)) log("  " + k.padEnd(38) + " " + v);
    log("");

    if (DRY_RUN) {
      log("== DRY-RUN COMPLETE — no writes performed ==");
      log("To commit, re-run with:");
      log("  COA_RESET_1_CONFIRM=" + CONFIRM_TOKEN + "  node scripts/coa-reset-1-coulee-execute.mjs --commit");
      return;
    }

    // ---------- COMMIT PHASE ----------
    log("== COMMIT PHASE — begin transaction ==");
    const before_ts = Date.now();

    const runIfExists = async (tx, name, fn) => {
      try { const r = await fn(); log("     " + name.padEnd(50) + " →", r?.count ?? "ok"); }
      catch (e) { log("     (" + name + " skipped: " + (e?.message ?? String(e)).split("\n")[0] + ")"); }
    };

    await p.$transaction(async (tx) => {
      // A. Nullify parent-config pointer to payroll GL profile.
      await tx.payrollClubConfig.updateMany({
        where: { clubId: COULEE, glAccountingProfileId: { not: null } },
        data: { glAccountingProfileId: null },
      });
      log("  A. payrollClubConfig.glAccountingProfileId cleared");

      // B0. Schema-shaped early deletes (RESTRICT-into-target, zero rows on
      //     Coulee today; kept explicit so future fixture population cannot
      //     silently re-introduce a blocker).
      await runIfExists(tx, "fingerprintMismatchEvent.deleteMany (Coulee)",
        () => tx.fingerprintMismatchEvent.deleteMany({ where: w }));
      await runIfExists(tx, "budgetLine.deleteMany (Coulee)",
        () => tx.budgetLine.deleteMany({ where: w }));
      await runIfExists(tx, "forecastLine.deleteMany (Coulee)",
        () => tx.forecastLine.deleteMany({ where: w }));

      // B1. PayrollBatch self-reference nullify — Coulee-scoped only, and
      //     ONLY because Coulee payroll history is disposable fixture. Do
      //     NOT generalize into product payroll deletion.
      const srCorrects = await tx.payrollBatch.updateMany({
        where: { clubId: COULEE, correctsPayrollBatchId: { not: null } },
        data:  { correctsPayrollBatchId: null },
      });
      const srPaired = await tx.payrollBatch.updateMany({
        where: { clubId: COULEE, pairedReversalBatchId: { not: null } },
        data:  { pairedReversalBatchId: null },
      });
      const srReverses = await tx.payrollBatch.updateMany({
        where: { clubId: COULEE, reversesPayrollBatchId: { not: null } },
        data:  { reversesPayrollBatchId: null },
      });
      log("  B1. payrollBatch self-refs cleared        → corrects=" + srCorrects.count
          + " paired=" + srPaired.count + " reverses=" + srReverses.count);

      // B2. PayrollBatch children → PayrollBatch.
      await runIfExists(tx, "payrollBatchEarning.deleteMany",              () => tx.payrollBatchEarning.deleteMany({ where: w }));
      await runIfExists(tx, "payrollBatchDeduction.deleteMany",            () => tx.payrollBatchDeduction.deleteMany({ where: w }));
      await runIfExists(tx, "payrollBatchException.deleteMany",            () => tx.payrollBatchException.deleteMany({ where: w }));
      await runIfExists(tx, "payrollBatchAllowanceSnapshot.deleteMany",    () => tx.payrollBatchAllowanceSnapshot.deleteMany({ where: w }));
      await runIfExists(tx, "payrollBatchComponentSnapshot.deleteMany",    () => tx.payrollBatchComponentSnapshot.deleteMany({ where: w }));
      await runIfExists(tx, "payrollBatchReviewAttestation.deleteMany",    () => tx.payrollBatchReviewAttestation.deleteMany({ where: w }));
      await runIfExists(tx, "payrollBatchEmployee.deleteMany (schema-shaped, CASCADE fallback)",
        () => tx.payrollBatchEmployee.deleteMany({ where: w }));
      await runIfExists(tx, "payrollZeroHoursAcknowledgement.deleteMany (schema-shaped)",
        () => tx.payrollZeroHoursAcknowledgement.deleteMany({ where: w }));
      const payBatchDel = await tx.payrollBatch.deleteMany({ where: w });
      log("  B. payrollBatch.deleteMany                →", payBatchDel.count);

      // C. Payments children → PaymentRun (releases settlementJournalId FK).
      const peDel = await tx.paymentEvent.deleteMany({ where: w });
      log("  C. paymentEvent.deleteMany                →", peDel.count);
      const piDel = await tx.paymentInstruction.deleteMany({ where: w });
      log("     paymentInstruction.deleteMany           →", piDel.count);
      const pdsDel = await tx.paymentDestinationSnapshot.deleteMany({ where: w });
      log("     paymentDestinationSnapshot.deleteMany   →", pdsDel.count);
      const pbiDel = await tx.paymentBatchItem.deleteMany({ where: w });
      log("     paymentBatchItem.deleteMany             →", pbiDel.count);
      const pbDel = await tx.paymentBatch.deleteMany({ where: w });
      log("     paymentBatch.deleteMany                 →", pbDel.count);
      const prDel = await tx.paymentRun.deleteMany({ where: w });
      log("     paymentRun.deleteMany                   →", prDel.count);

      // D. AP invoice side.
      const apLineDel = await tx.aPInvoiceLine.deleteMany({ where: w });
      log("  D. aPInvoiceLine.deleteMany               →", apLineDel.count);
      const vpDel = await tx.vendorPayment.deleteMany({ where: w });
      log("     vendorPayment.deleteMany                →", vpDel.count);
      const apDel = await tx.aPInvoice.deleteMany({ where: w });
      log("     aPInvoice.deleteMany                    →", apDel.count);

      // E. Additional JE-referencing tables — defensive deletes.
      await runIfExists(tx, "posSale.deleteMany",                    () => tx.pOSSale.deleteMany({ where: w }));
      await runIfExists(tx, "inventoryTransaction.deleteMany",       () => tx.inventoryTransaction.deleteMany({ where: w }));
      await runIfExists(tx, "inventoryReceiving.deleteMany",         () => tx.inventoryReceiving.deleteMany({ where: w }));
      await runIfExists(tx, "privateEventDeposit.deleteMany",        () => tx.privateEventDeposit.deleteMany({ where: w }));
      await runIfExists(tx, "lessonBooking.deleteMany",              () => tx.lessonBooking.deleteMany({ where: w }));
      await runIfExists(tx, "assetDepreciationEntry.deleteMany",     () => tx.assetDepreciationEntry.deleteMany({ where: w }));
      await runIfExists(tx, "assetDisposal.deleteMany",              () => tx.assetDisposal.deleteMany({ where: w }));
      await runIfExists(tx, "capitalAsset.deleteMany",               () => tx.capitalAsset.deleteMany({ where: w }));
      await runIfExists(tx, "payrollRun.deleteMany",                 () => tx.payrollRun.deleteMany({ where: w }));

      // F. JournalEntry now safe (cascades JournalEntryLine + JournalAttachment).
      const jeDeleted = await tx.journalEntry.deleteMany({ where: w });
      log("  F. journalEntry.deleteMany                →", jeDeleted.count);

      // G-1. PayrollOpeningBalanceComponent (NOACT on PayrollComponent).
      await runIfExists(tx, "payrollOpeningBalanceComponent.deleteMany (Coulee)",
        () => tx.payrollOpeningBalanceComponent.deleteMany({ where: w }));

      // G. PayrollComponent dependents (Restrict/NoAction) BEFORE PayrollComponent.
      await runIfExists(tx, "employeeBenefitPlanEnrolment.deleteMany",     () => tx.employeeBenefitPlanEnrolment.deleteMany({ where: w }));
      await runIfExists(tx, "payrollBenefitPlan.deleteMany",               () => tx.payrollBenefitPlan.deleteMany({ where: w }));
      await runIfExists(tx, "payrollScheduledOneTimeEarning.deleteMany",   () => tx.payrollScheduledOneTimeEarning.deleteMany({ where: w }));
      await runIfExists(tx, "employeeRecurringPayrollComponent.deleteMany",() => tx.employeeRecurringPayrollComponent.deleteMany({ where: w }));
      const pcDel = await tx.payrollComponent.deleteMany({ where: w });
      log("  G. payrollComponent.deleteMany            →", pcDel.count);
      const pgpDel = await tx.payrollGlAccountingProfile.deleteMany({ where: w });
      log("     payrollGlAccountingProfile.deleteMany   →", pgpDel.count);

      // H. BankAccount — removes glAccountId FK.
      const baDel = await tx.bankAccount.deleteMany({ where: w });
      log("  H. bankAccount.deleteMany                 →", baDel.count);

      // I. Nullify soft/optional Account references on preserved entities.
      const venNull = await tx.vendor.updateMany({
        where: { clubId: COULEE, defaultExpenseAccountId: { not: null } },
        data: { defaultExpenseAccountId: null },
      });
      log("  I. vendor.defaultExpenseAccountId cleared →", venNull.count);
      await runIfExists(tx, "taxCode.recoverableAccountId cleared", async () => {
        return tx.taxCode.updateMany({ where: { clubId: COULEE, recoverableAccountId: { not: null } }, data: { recoverableAccountId: null } });
      });
      await runIfExists(tx, "taxCode.payableAccountId cleared", async () => {
        return tx.taxCode.updateMany({ where: { clubId: COULEE, payableAccountId: { not: null } }, data: { payableAccountId: null } });
      });
      const cpNull = await tx.clubProfile.updateMany({
        where: { clubId: COULEE },
        data: {
          defaultArAccountId: null,
          defaultApAccountId: null,
          defaultRetainedEarningsAccountId: null,
          defaultCurrentYearEarningsAccountId: null,
          defaultOperatingBankAccountId: null,
          defaultReserveBankAccountId: null,
          defaultMemberReceivablesAccountId: null,
          defaultSalesTaxPayableAccountId: null,
        },
      });
      log("     clubProfile default* cleared           →", cpNull.count);

      // J. AccountDepartment M2M.
      const adDel = await tx.accountDepartment.deleteMany({ where: w });
      log("  J. accountDepartment.deleteMany           →", adDel.count);

      // K. Account (FINALLY clear of FKs).
      const acctDel = await tx.account.deleteMany({ where: w });
      log("  K. account.deleteMany                     →", acctDel.count);

      // L. Prior COA ImportBatch — archive (do not delete).
      const ibArchived = await tx.importBatch.updateMany({
        where: { clubId: COULEE, domain: "COA", status: { not: "ARCHIVED" } },
        data: { status: "ARCHIVED" },
      });
      log("  L. importBatch(COA) archived              →", ibArchived.count);
    }, { timeout: 180000, maxWait: 30000 });

    const elapsed = Date.now() - before_ts;
    log("");
    log("== COMMIT PHASE — transaction committed in " + elapsed + "ms ==");

    // ---------- POST ----------
    const after = {
      account: await p.account.count({ where: w }),
      journalEntry: await p.journalEntry.count({ where: w }),
      journalEntryLine: await p.journalEntryLine.count({ where: w }),
      apInvoice: await p.aPInvoice.count({ where: w }),
      paymentInstruction: await p.paymentInstruction.count({ where: w }),
      paymentRun: await p.paymentRun.count({ where: w }),
      payrollBatch: await p.payrollBatch.count({ where: w }),
      payrollComponent: await p.payrollComponent.count({ where: w }),
      payrollGlAccountingProfile: await p.payrollGlAccountingProfile.count({ where: w }),
      payrollOpeningBalanceComponent: await p.payrollOpeningBalanceComponent.count({ where: w }),
      bankAccount: await p.bankAccount.count({ where: w }),
      budgetLine: await p.budgetLine.count({ where: w }),
      forecastLine: await p.forecastLine.count({ where: w }),
      fingerprintMismatchEvent: await p.fingerprintMismatchEvent.count({ where: w }),
      accountCategory: await p.accountCategory.count({ where: w }),
      financialStatementGroup: await p.financialStatementGroup.count({ where: w }),
      department: await p.department.count({ where: w }),
      importBatchCoaActive: await p.importBatch.count({ where: { ...w, domain: "COA", status: { not: "ARCHIVED" } } }),
      user: await p.user.count(),
      employee: await p.employee.count({ where: w }),
      workIntakeItem: await p.workIntakeItem.count({ where: w }),
    };
    log("");
    log("AFTER — Coulee state:");
    for (const [k, v] of Object.entries(after)) log("  " + k.padEnd(36) + " " + v);
    log("");

    const invariants = [
      ["account = 0", after.account === 0],
      ["journalEntry = 0", after.journalEntry === 0],
      ["journalEntryLine = 0", after.journalEntryLine === 0],
      ["bankAccount = 0", after.bankAccount === 0],
      ["payrollGlAccountingProfile = 0", after.payrollGlAccountingProfile === 0],
      ["payrollOpeningBalanceComponent = 0", after.payrollOpeningBalanceComponent === 0],
      ["budgetLine = 0", after.budgetLine === 0],
      ["forecastLine = 0", after.forecastLine === 0],
      ["fingerprintMismatchEvent = 0", after.fingerprintMismatchEvent === 0],
      ["accountCategory preserved (> 0)", after.accountCategory > 0],
      ["financialStatementGroup preserved (> 0)", after.financialStatementGroup > 0],
      ["department preserved (> 0)", after.department > 0],
      ["user preserved (unchanged)", after.user === before.user],
      ["employee preserved (unchanged)", after.employee === before.employee],
      ["workIntakeItem preserved (unchanged)", after.workIntakeItem === before.workIntakeItem],
      ["importBatchCoa retired (no active)", after.importBatchCoaActive === 0],
    ];
    let allPass = true;
    for (const [label, pass] of invariants) {
      log("  " + (pass ? "PASS" : "FAIL") + "  " + label);
      if (!pass) allPass = false;
    }
    log("");
    log(allPass ? "== COA-RESET-1 EXECUTION PASS ==" : "== COA-RESET-1 EXECUTION FAIL ==");
  } finally {
    await p.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write("FATAL: " + (err?.message ?? String(err)) + "\n");
  if (err?.stack) process.stderr.write(err.stack + "\n");
  process.exit(1);
});
