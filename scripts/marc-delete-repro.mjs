// Reproduce Marc's delete failure by attempting the same $transaction
// the deleteEmployee service performs. Reports which FK fires.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const MARC_ID = "cmu0e39fe000993bhbv6nmfh5";

async function main() {
  console.log("== Marc dependency inventory ==");
  const models = [
    "employeeOnboardingCorrection", "employeeOnboardingAcknowledgement",
    "employeeOnboardingSession", "employeeOnboardingInvitation",
    "employeeSensitiveIdentity", "employeeBankAccount", "employeeTaxProfile",
    "employeeEmergencyContact", "employeeCredential", "employeeDocument",
    "employeeCompensation", "employeeEmploymentAssignment", "employeeAllowance",
    "employeePortalPasswordReset", "employeePortalCredential",
    "employeeHomeNotificationDismissal", "employeeAvailabilityWeek",
    "employmentPeriod",
    "employeeAvailabilityProfile", "employeeAvailabilityRule",
    "employeeRecurringPayrollComponent", "employeeCppElection", "employeeCppDisability",
    "employeeOnboardingStateTransition", "employeeOnboardingResponse",
    "employeeOnboardingQuestion",
    "trainingAssignment", "trainingProgress", "trainingAttempt", "trainingCompletion", "trainingQuestionResponse",
    "shiftAssignment", "claimedShiftOpportunity",
    "payrollTimesheet", "payrollApprovedTimeEntry", "payrollTimeAdjustment", "timeClockCorrectionRequest",
    "timeClockEvent", "payrollPayGroupMember", "payrollOpeningBalance",
    "payrollBatchEmployee", "payrollBatchEarning", "payrollBatchDeduction",
    "payrollBatchException", "payrollBatchAllowanceSnapshot", "payrollBatchComponentSnapshot",
    "userClubProfile",
  ];
  const counts = {};
  for (const m of models) {
    try {
      const filter = m === "userClubProfile"
        ? { employeeId: MARC_ID }
        : m === "employeeOnboardingResponse"
          ? { session: { employeeId: MARC_ID } }
          : { employeeId: MARC_ID };
      counts[m] = await p[m].count({ where: filter });
    } catch (e) {
      counts[m] = `?err: ${e.message.split("\n")[0].slice(0, 100)}`;
    }
  }
  const nonzero = Object.fromEntries(Object.entries(counts).filter(([, v]) => v && v !== 0));
  console.log("nonzero deps:", JSON.stringify(nonzero, null, 2));

  console.log("\n== Reproducing deleteEmployee transaction (rollback at end) ==");
  try {
    await p.$transaction(async (tx) => {
      await tx.employeeOnboardingCorrection.deleteMany({ where: { employeeId: MARC_ID } });
      await tx.employeeOnboardingAcknowledgement.deleteMany({ where: { employeeId: MARC_ID } });
      await tx.employeeOnboardingResponse.deleteMany({ where: { session: { employeeId: MARC_ID } } });
      await tx.employeeOnboardingInvitation.deleteMany({ where: { employeeId: MARC_ID } });
      await tx.employeeOnboardingSession.deleteMany({ where: { employeeId: MARC_ID } });
      await tx.employeeSensitiveIdentity.deleteMany({ where: { employeeId: MARC_ID } });
      await tx.employeeBankAccount.deleteMany({ where: { employeeId: MARC_ID } });
      await tx.employeeTaxProfile.deleteMany({ where: { employeeId: MARC_ID } });
      await tx.employeeEmergencyContact.deleteMany({ where: { employeeId: MARC_ID } });
      await tx.employeeCredential.deleteMany({ where: { employeeId: MARC_ID } });
      await tx.employeeDocument.deleteMany({ where: { employeeId: MARC_ID } });
      try { await tx.employeeCompensation.deleteMany({ where: { employeeId: MARC_ID } }); } catch {}
      for (const child of [
        "employeeEmploymentAssignment", "employeeAllowance", "employeePortalPasswordReset",
        "employeePortalCredential", "employeeHomeNotificationDismissal", "employeeAvailabilityWeek",
      ]) {
        try { await tx[child].deleteMany({ where: { employeeId: MARC_ID } }); } catch {}
      }
      await tx.employmentPeriod.deleteMany({ where: { employeeId: MARC_ID } });
      await tx.employee.delete({ where: { id: MARC_ID } });
      // Force rollback so we don't actually delete Marc during repro.
      throw new Error("__ROLLBACK__");
    });
  } catch (e) {
    if (e.message === "__ROLLBACK__") {
      console.log("REPRO RESULT: full deletion path succeeded (rolled back deliberately). No FK issue.");
    } else {
      console.log("REPRO RESULT: transaction FAILED with the following error before Employee.delete:");
      console.log("  message:", e.message);
      console.log("  code:", e.code);
      if (e.meta) console.log("  meta:", JSON.stringify(e.meta));
    }
  }
}
main().catch((e) => { console.error("SCRIPT-FATAL:", e); process.exit(1); }).finally(() => p.$disconnect());
