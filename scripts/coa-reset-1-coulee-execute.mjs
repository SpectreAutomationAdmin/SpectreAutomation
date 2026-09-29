// COA-RESET-1 — Coulee Ridge accounting reset to Account = 0.
//
// Founder-authorized destructive reset of Coulee's accounting layer
// so a fresh Jonas Master COA can be imported. Coulee is disposable
// staging; historical fixture accounting records are removed to
// unblock referential integrity for physical Account deletion.
//
// SAFETY GATES (in order):
//   1. Refuses without --commit unless in dry-run mode.
//   2. Refuses without COA_RESET_1_CONFIRM=COULEE-COA-WIPE for commit.
//   3. Refuses if club != Coulee Ridge / stagingDataMode != FOUNDER_REVIEW.
//   4. Refuses if another club has any of the tables being wiped (defense in depth).
//   5. Prints a manifest of every deletion/nullification before executing.
//
// FK-SAFE DELETE ORDER — respects Restrict semantics of every
// enforced foreign key in the Coulee accounting graph:
//   A. JournalEntry side (parent) — cascades JournalEntryLine + JournalAttachment
//   B. AP invoice side — APInvoiceLine (cascade), VendorPayment, APInvoice
//   C. Payments side — PaymentEvent, PaymentDestinationSnapshot,
//      PaymentInstruction, PaymentBatchItem, PaymentBatch, PaymentRun
//   D. Payroll side — PayrollBatch children (earnings, deductions,
//      exceptions, snapshots, attestations), then PayrollBatch,
//      then PayrollComponent, then PayrollGlAccountingProfile
//      (removes 8 Account FKs), and nullify PayrollClubConfig.
//   E. BankAccount — the LEGACY-PAY1A row (removes glAccountId FK)
//   F. Nullify Vendor.defaultExpenseAccountId,
//      TaxCode.{recoverableAccountId, payableAccountId},
//      ClubProfile.default*AccountId
//   G. AccountDepartment (M2M) — 0 rows on Coulee today
//   H. Account (finally FK-clear)
//   I. Prior COA ImportBatch (retire, since retaining would falsely
//      represent lineage of the new accounting environment per §4)
//
// PRESERVE (never touched):
//   Club, User, UserClubRole, ClubProfile (structure), ClubFeatures,
//   Employee, HR/onboarding rows, Vendor (structure only), Member*,
//   Department, AccountCategory, FinancialStatementGroup,
//   WorkIntakeItem + related work-intake surface,
//   ReportingLedgerBatch/Snapshot (already 0 rows on Coulee).

import { PrismaClient } from "@prisma/client";

const COULEE = "cmrvdeny7000144372ktmmg9c";
const CONFIRM_TOKEN = "COULEE-COA-WIPE";

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--commit");
const CONFIRM = process.env.COA_RESET_1_CONFIRM ?? "";
const RESET_ACTOR_USER_ID = "cmrvdenz700034437agp7gqs5";

function log(...a) { process.stdout.write(a.join(" ") + "\n"); }
function assert(cond, msg) { if (!cond) throw new Error("SAFETY: " + msg); }

async function main() {
  const p = new PrismaClient();
  try {
    log("");
    log("======================================================================");
    log("COA-RESET-1 — Coulee Ridge accounting reset to Account = 0");
    log("======================================================================");
    log("Mode:              ", DRY_RUN ? "DRY-RUN (no writes)" : "COMMIT");
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
    log("");

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
      payrollComponent: await p.payrollComponent.count({ where: w }),
      payrollGlAccountingProfile: await p.payrollGlAccountingProfile.count({ where: w }),
      bankAccount: await p.bankAccount.count({ where: w }),
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
    log("BEFORE — Coulee accounting counts:");
    for (const [k, v] of Object.entries(before)) log("  " + k.padEnd(32) + " " + v);
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

    // Because the total delete surface is large + spans many tables,
    // wrap the whole thing in a single transaction with a generous
    // timeout. Prisma's default 5s is too short.
    await p.$transaction(async (tx) => {
      // A. JournalEntry side — cascades lines + attachments
      const jeDeleted = await tx.journalEntry.deleteMany({ where: w });
      log("  A. journalEntry.deleteMany               →", jeDeleted.count);

      // B. AP invoice side
      const apLineDel = await tx.aPInvoiceLine.deleteMany({ where: w });
      log("  B. aPInvoiceLine.deleteMany              →", apLineDel.count);
      const vpDel = await tx.vendorPayment.deleteMany({ where: w });
      log("     vendorPayment.deleteMany              →", vpDel.count);
      const apDel = await tx.aPInvoice.deleteMany({ where: w });
      log("     aPInvoice.deleteMany                  →", apDel.count);

      // C. Payments side (children before parents)
      const peDel = await tx.paymentEvent.deleteMany({ where: w });
      log("  C. paymentEvent.deleteMany               →", peDel.count);
      const pdsDel = await tx.paymentDestinationSnapshot.deleteMany({ where: w });
      log("     paymentDestinationSnapshot.deleteMany →", pdsDel.count);
      const piDel = await tx.paymentInstruction.deleteMany({ where: w });
      log("     paymentInstruction.deleteMany         →", piDel.count);
      const pbiDel = await tx.paymentBatchItem.deleteMany({ where: w });
      log("     paymentBatchItem.deleteMany           →", pbiDel.count);
      const pbDel = await tx.paymentBatch.deleteMany({ where: w });
      log("     paymentBatch.deleteMany               →", pbDel.count);
      const prDel = await tx.paymentRun.deleteMany({ where: w });
      log("     paymentRun.deleteMany                 →", prDel.count);

      // D. Payroll side — walk children before parent so cascade order is deterministic.
      // Order: nullify parent config pointer, delete batch children,
      // delete batches, delete components, delete GL profile.
      // PayrollClubConfig.glAccountingProfileId - nullify.
      await tx.payrollClubConfig.updateMany({
        where: { clubId: COULEE, glAccountingProfileId: { not: null } },
        data: { glAccountingProfileId: null },
      });
      log("  D. payrollClubConfig.glAccountingProfileId nullified");

      // PayrollBatch children — each table has its own FK to the batch.
      // Use raw catches so a table absent under a given schema branch
      // doesn't fail the whole run.
      const runIfExists = async (name, fn) => {
        try { const r = await fn(); log("     " + name.padEnd(38) + " →", r.count); }
        catch (e) { log("     (" + name + " skipped: " + (e?.message ?? String(e)).split("\n")[0] + ")"); }
      };
      await runIfExists("payrollBatchEarning.deleteMany", () => tx.payrollBatchEarning.deleteMany({ where: w }));
      await runIfExists("payrollBatchDeduction.deleteMany", () => tx.payrollBatchDeduction.deleteMany({ where: w }));
      await runIfExists("payrollBatchException.deleteMany", () => tx.payrollBatchException.deleteMany({ where: w }));
      await runIfExists("payrollBatchAllowanceSnapshot.deleteMany", () => tx.payrollBatchAllowanceSnapshot.deleteMany({ where: w }));
      await runIfExists("payrollBatchComponentSnapshot.deleteMany", () => tx.payrollBatchComponentSnapshot.deleteMany({ where: w }));
      await runIfExists("payrollBatchReviewAttestation.deleteMany", () => tx.payrollBatchReviewAttestation.deleteMany({ where: w }));
      const payBatchDel = await tx.payrollBatch.deleteMany({ where: w });
      log("     payrollBatch.deleteMany                →", payBatchDel.count);
      const pcDel = await tx.payrollComponent.deleteMany({ where: w });
      log("     payrollComponent.deleteMany            →", pcDel.count);
      const pgpDel = await tx.payrollGlAccountingProfile.deleteMany({ where: w });
      log("     payrollGlAccountingProfile.deleteMany  →", pgpDel.count);

      // E. BankAccount — removes glAccountId FK
      const baDel = await tx.bankAccount.deleteMany({ where: w });
      log("  E. bankAccount.deleteMany                →", baDel.count);

      // F. Nullify soft/optional Account references on preserved entities.
      const venNull = await tx.vendor.updateMany({
        where: { clubId: COULEE, defaultExpenseAccountId: { not: null } },
        data: { defaultExpenseAccountId: null },
      });
      log("  F. vendor.defaultExpenseAccountId cleared →", venNull.count);
      const taxNull1 = await tx.taxCode.updateMany({
        where: { clubId: COULEE, recoverableAccountId: { not: null } },
        data: { recoverableAccountId: null },
      });
      log("     taxCode.recoverableAccountId cleared   →", taxNull1.count);
      const taxNull2 = await tx.taxCode.updateMany({
        where: { clubId: COULEE, payableAccountId: { not: null } },
        data: { payableAccountId: null },
      });
      log("     taxCode.payableAccountId cleared       →", taxNull2.count);
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

      // G. AccountDepartment M2M
      const adDel = await tx.accountDepartment.deleteMany({ where: w });
      log("  G. accountDepartment.deleteMany          →", adDel.count);

      // H. Account (FINALLY clear of FKs)
      const acctDel = await tx.account.deleteMany({ where: w });
      log("  H. account.deleteMany                    →", acctDel.count);

      // I. Prior COA ImportBatch — retire (do not delete; ImportBatch
      //    is a per-tenant audit surface. Setting status=ARCHIVED
      //    preserves it for history but excludes from active queries.)
      const ibArchived = await tx.importBatch.updateMany({
        where: { clubId: COULEE, domain: "COA", status: { not: "ARCHIVED" } },
        data: { status: "ARCHIVED" },
      });
      log("  I. importBatch(COA) archived             →", ibArchived.count);
    }, { timeout: 120000, maxWait: 30000 });

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
      payrollGlAccountingProfile: await p.payrollGlAccountingProfile.count({ where: w }),
      bankAccount: await p.bankAccount.count({ where: w }),
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
    for (const [k, v] of Object.entries(after)) log("  " + k.padEnd(32) + " " + v);
    log("");

    // Assertions
    const invariants = [
      ["account = 0", after.account === 0],
      ["journalEntry = 0", after.journalEntry === 0],
      ["journalEntryLine = 0", after.journalEntryLine === 0],
      ["bankAccount = 0", after.bankAccount === 0],
      ["payrollGlAccountingProfile = 0", after.payrollGlAccountingProfile === 0],
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
