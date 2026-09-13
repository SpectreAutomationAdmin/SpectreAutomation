// COULEE RIDGE FIXTURE CLEANUP — DESTRUCTIVE.
// See founder directive at 2026-09-13.
// A pg_dump backup MUST exist before this runs. This script does not check.
//
// Executed post-backup for staging DB only.

import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const COULEE = "cmrvdeny7000144372ktmmg9c";
const CHRIS_EMP = "cmt113ppt002jjj78mnmx5cwu";
const LISE_EMP = "cmt80kivp001913sjl6p7csre";
const CHRIS_USER = "cmrvdenz700034437agp7gqs5";
const FIXTURE_CONTROLLER = "cmtjc2s9d0003gnjuhbfyo6i2"; // fixture.controller@spectre.test — retained per §S(ii)
const FIXTURE_PA_OLD = "cmtjc2rya0000gnju11alm8s9"; // fixture.pa@spectre.test — delete after PayrollClubConfig repointed
const POSTED_BATCH = "cmtzxy7f30006rm2s31rcv8rp";
const POSTED_PERIOD = "cmtyk1ai50003u3p22ngypan4"; // retained; 3D-ACCEPT is renamed LEGACY-3F-POSTED
const POSTED_JOURNAL = "cmtzye888002brm2sjsgh6hc1";
const GL_PROFILE = "cmtzxwg1c000k9r8kg5wmyv3x";

const FIXTURE_EMPS = [
  "cmt9jx6fd0001gpbs3dwyg8xd", // Playwright
  "cmtjc2xz8001tgnjuq0oalc59", // Avery
  "cmtjc2yw10025gnjuk4ht5wj0", // Jordan
  "cmtjc2zdf002hgnju0scyz9kd", // Morgan
  "cmtjc2zux002tgnjulrcn7edv", // Taylor
  "cmtjc30kl0035gnjuvmo4jnmu", // Riley Synth
  "cmtjc316c003jgnjux7c2dwxe", // Sam Prior
  "cmtjc31wf003xgnjue6ur15nh", // Quinn
  "cmtrkm7uy0007mdc9gnu0crtt", // Riley PE
  "cmtrkm7z0000bmdc9shwycp1k", // Casey PE
  "cmtrkm82b000fmdc9354vegtd", // Devon PE
  "cmtxqzk3i0001dlrrsw2nppj5", // Grounds Manager Fixture
  "cmtxqzk5f0003dlrroevdzc42", // Riley Reconcile
  "cmtyk1aop0007u3p26plokjin", // Sam Salary
];

const FIXTURE_COULEE_USERS = [
  "cmtp9qfuw0001rcqlqr53rcjs", // taylor.hourly@fixture
  "cmtp9qg3f0005rcqlfbli9ful", // grounds.manager@fixture
  "cmtp9qg500007rcqlc81txj8y", // events.manager@fixture
];

const FIXTURE_GL_ACCOUNTS = [
  "cmtzxwfs600049r8kmunsnpxz", // 5100
  "cmtzxwftn00069r8k1apumu2x", // 5110
  "cmtzxwfv800089r8k2crlo3g8", // 5120
  "cmtzxwfw4000a9r8k6xop4gfn", // 2100
  "cmtzxwfx1000c9r8kglnki4yf", // 2110
  "cmtzxwfxz000e9r8k0wqlx53f", // 2120
  "cmtzxwfyx000g9r8kv0x8xtnu", // 2130
  "cmtzxwfzr000i9r8kg1qursw8", // 2140
];

const FIXTURE_PAY_GROUPS = {
  DELETE: ["cmty1q8yy0001wia6yqxvvyfa"], // 3C-ACCEPT
  RENAME_LEGACY: "cmtyk1agk0001u3p25ebcfp9m", // 3D-ACCEPT → LEGACY-3F-POSTED
  KEEP_ACTIVE: "cmtjc2u2b000bgnjudym510so", // FDR-BW
};

// From inventory §K
const FIXTURE_WI_ITEMS = [
  "cmtjclgqp0016eaif4o6q1mtk", // PAYROLL_REVIEW RESOLVED
  "cmtjclnpd001veaifn3amczmp", // PAYROLL_FINAL_APPROVAL OPEN
  "cmtw8oerg001w4oa3o6m0rks4", // SHIFT_REASSIGNMENT_NOTIFICATION OPEN
  "cmtxr1b4c000jqj4q236918zj", // PAYROLL_TIMESHEET_APPROVAL RESOLVED (Events)
  "cmtxr1c2i0017qj4qxdkin4xf", // PAYROLL_TIMESHEET_APPROVAL RESOLVED (Course & Grounds)
  "cmtylh0m90017ekh2nh9m3jja", // PAYROLL_FINAL_APPROVAL OPEN
  "cmtymum8r001cl7lzett5st9r", // PAYROLL_FINAL_APPROVAL RESOLVED
  "cmtz7uimg001cipljow97o9tw", // PAYROLL_FINAL_APPROVAL RESOLVED
  // Retain the POSTED batch's WI cards (already RESOLVED):
  //   cmtzxye3h001crm2sbgy35q3b (PAYROLL_FINAL_APPROVAL for POSTED)
  //   cmtzyc25b001urm2sxsvm9hi9 (PAYROLL_READY_TO_POST for POSTED)
];

async function step(name, fn) {
  process.stdout.write(`\n== ${name} ==\n`);
  const t = Date.now();
  const r = await fn();
  process.stdout.write(`   ok (${Date.now() - t}ms)${r !== undefined ? " " + JSON.stringify(r) : ""}\n`);
  return r;
}

async function main() {
  // Sanity: verify Chris/Lise IDs still resolve
  const chris = await p.employee.findUnique({
    where: { id: CHRIS_EMP },
    select: { firstName: true, lastName: true },
  });
  const lise = await p.employee.findUnique({
    where: { id: LISE_EMP },
    select: { firstName: true, lastName: true },
  });
  if (!chris || chris.firstName !== "Chris" || chris.lastName !== "Turcato") {
    throw new Error("Chris identity check failed");
  }
  if (!lise || lise.firstName !== "Lise" || lise.lastName !== "Montsion") {
    throw new Error("Lise identity check failed");
  }
  process.stdout.write(`Chris ✓ Lise ✓\n`);

  const fixtureBatches = await p.payrollBatch.findMany({
    where: { clubId: COULEE, id: { not: POSTED_BATCH } },
    select: { id: true },
  });
  const FIXTURE_BATCH_IDS = fixtureBatches.map((b) => b.id);
  process.stdout.write(`Fixture batches to delete: ${FIXTURE_BATCH_IDS.length}\n`);

  // ---------- PHASE 1 — Work Intake fixture cards ----------
  await step("Phase 1 — WI origins for fixture payroll cards", async () => {
    const r = await p.workIntakeOrigin.deleteMany({
      where: { workIntakeItemId: { in: FIXTURE_WI_ITEMS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 1 — WI activity for fixture payroll cards", async () => {
    const r = await p.workIntakeActivity.deleteMany({
      where: { workIntakeItemId: { in: FIXTURE_WI_ITEMS } },
    });
    return { deleted: r.count };
  });
  // Reads may exist
  try {
    await step("Phase 1 — WI reads for fixture payroll cards", async () => {
      const r = await p.workIntakeItemRead.deleteMany({
        where: { workIntakeItemId: { in: FIXTURE_WI_ITEMS } },
      });
      return { deleted: r.count };
    });
  } catch (e) {
    process.stdout.write(`   (skipped: ${e.message.split("\n")[0]})\n`);
  }
  await step("Phase 1 — WI items", async () => {
    const r = await p.workIntakeItem.deleteMany({
      where: { id: { in: FIXTURE_WI_ITEMS } },
    });
    return { deleted: r.count };
  });

  // ---------- PHASE 2 — Batch children ----------
  await step("Phase 2 — PayrollBatchReviewAttestation (fixture batches)", async () => {
    const r = await p.payrollBatchReviewAttestation.deleteMany({
      where: { batchId: { in: FIXTURE_BATCH_IDS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 2 — PayrollBatchException", async () => {
    const r = await p.payrollBatchException.deleteMany({
      where: { batchId: { in: FIXTURE_BATCH_IDS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 2 — PayrollBatchEarning", async () => {
    const r = await p.payrollBatchEarning.deleteMany({
      where: { batchId: { in: FIXTURE_BATCH_IDS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 2 — PayrollBatchDeduction", async () => {
    const r = await p.payrollBatchDeduction.deleteMany({
      where: { batchId: { in: FIXTURE_BATCH_IDS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 2 — PayrollBatchAllowanceSnapshot", async () => {
    const r = await p.payrollBatchAllowanceSnapshot.deleteMany({
      where: { batchId: { in: FIXTURE_BATCH_IDS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 2 — PayrollBatchComponentSnapshot", async () => {
    const r = await p.payrollBatchComponentSnapshot.deleteMany({
      where: { batchId: { in: FIXTURE_BATCH_IDS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 2 — PayrollBatchEmployee (fixture batches)", async () => {
    const r = await p.payrollBatchEmployee.deleteMany({
      where: { batchId: { in: FIXTURE_BATCH_IDS } },
    });
    return { deleted: r.count };
  });

  // ---------- PHASE 3 — Fixture batches ----------
  await step("Phase 3 — PayrollBatch (non-POSTED)", async () => {
    const r = await p.payrollBatch.deleteMany({
      where: { id: { in: FIXTURE_BATCH_IDS } },
    });
    return { deleted: r.count };
  });

  // ---------- PHASE 4 — Department time approvals + scope states ----------
  await step("Phase 4 — PayrollDepartmentTimeApproval (fixture pay groups)", async () => {
    const r = await p.payrollDepartmentTimeApproval.deleteMany({
      where: {
        payPeriod: {
          payGroupId: { in: [FIXTURE_PAY_GROUPS.RENAME_LEGACY, ...FIXTURE_PAY_GROUPS.DELETE, FIXTURE_PAY_GROUPS.KEEP_ACTIVE] },
        },
      },
    });
    return { deleted: r.count };
  });
  await step("Phase 4 — PayrollDepartmentTimeScopeState (fixture pay groups)", async () => {
    const r = await p.payrollDepartmentTimeScopeState.deleteMany({
      where: {
        payPeriod: {
          payGroupId: { in: [FIXTURE_PAY_GROUPS.RENAME_LEGACY, ...FIXTURE_PAY_GROUPS.DELETE, FIXTURE_PAY_GROUPS.KEEP_ACTIVE] },
        },
      },
    });
    return { deleted: r.count };
  });

  // ---------- PHASE 5 — Fixture employee dependent records ----------
  // NOTE: Chris/Lise sensitive-identity/bank/compensation are excluded by employeeId filter.
  await step("Phase 5 — Timesheet entries + clock events (fixture employees)", async () => {
    const entries = await p.payrollTimesheetEntry.findMany({
      where: { timesheet: { employeeId: { in: FIXTURE_EMPS } } },
      select: { id: true },
    });
    const entryIds = entries.map((e) => e.id);
    if (entryIds.length) {
      await p.payrollTimesheetEntryClockEvent.deleteMany({
        where: { timesheetEntryId: { in: entryIds } },
      });
    }
    const r = await p.payrollTimesheetEntry.deleteMany({
      where: { id: { in: entryIds } },
    });
    return { deletedEntries: r.count, clockEvents: entryIds.length };
  });
  await step("Phase 5 — PayrollTimesheet (fixture employees)", async () => {
    const r = await p.payrollTimesheet.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 5 — TimeClockCorrectionRequest", async () => {
    const r = await p.timeClockCorrectionRequest.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 5 — PayrollApprovedTimeEntry", async () => {
    const r = await p.payrollApprovedTimeEntry.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 5 — PayrollTimeAdjustment", async () => {
    const r = await p.payrollTimeAdjustment.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 5 — EmployeeAvailabilityRule + Profile + Week", async () => {
    const profiles = await p.employeeAvailabilityProfile.findMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
      select: { id: true },
    });
    for (const prof of profiles) {
      await p.employeeAvailabilityRule.deleteMany({ where: { availabilityProfileId: prof.id } });
    }
    await p.employeeAvailabilityProfile.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    const r = await p.employeeAvailabilityWeek.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { profileCount: profiles.length, weeksDeleted: r.count };
  });
  await step("Phase 5 — ShiftOpportunity children of fixture-employee ShiftAssignments", async () => {
    const asgIds = (await p.shiftAssignment.findMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
      select: { id: true },
    })).map((a) => a.id);
    if (!asgIds.length) return { deleted: 0 };
    let claimed = 0;
    let offered = 0;
    try {
      const opps = await p.shiftOpportunity.findMany({
        where: { offeredByAssignmentId: { in: asgIds } },
        select: { id: true },
      });
      const oppIds = opps.map((o) => o.id);
      if (oppIds.length) {
        try { claimed = (await p.claimedShiftOpportunity.deleteMany({ where: { opportunityId: { in: oppIds } } })).count; } catch {}
        try { await p.offeredShiftOpportunity.deleteMany({ where: { opportunityId: { in: oppIds } } }); } catch {}
      }
      const r = await p.shiftOpportunity.deleteMany({ where: { id: { in: oppIds } } });
      offered = r.count;
    } catch (e) {
      return { skipped: true, reason: e.message.split("\n")[0] };
    }
    return { opportunitiesDeleted: offered, claimed };
  });
  await step("Phase 5 — ShiftAssignment (fixture employees)", async () => {
    const r = await p.shiftAssignment.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { deleted: r.count };
  });
  try {
    await step("Phase 5 — OfferedShiftOpportunity + Claimed", async () => {
      // Older tables may or may not exist
      let claimed = 0;
      let offered = 0;
      try { claimed = (await p.claimedShiftOpportunity.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } })).count; } catch {}
      try { offered = (await p.offeredShiftOpportunity.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } })).count; } catch {}
      return { claimed, offered };
    });
  } catch {}
  await step("Phase 5 — PayrollPayGroupMember (fixture employees)", async () => {
    const r = await p.payrollPayGroupMember.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 5 — EmployeeRecurringPayrollComponent", async () => {
    const r = await p.employeeRecurringPayrollComponent.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 5 — EmployeeAllowance", async () => {
    const r = await p.employeeAllowance.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 5 — EmployeeBankAccount (fixture-owned only)", async () => {
    const r = await p.employeeBankAccount.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 5 — EmployeeCompensation (fixture-owned only)", async () => {
    const r = await p.employeeCompensation.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 5 — EmployeeSensitiveIdentity (guard: Chris/Lise excluded)", async () => {
    const rows = await p.employeeSensitiveIdentity.findMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
      select: { id: true, employeeId: true },
    });
    if (rows.some((r) => r.employeeId === CHRIS_EMP || r.employeeId === LISE_EMP)) {
      throw new Error("SAFETY: sensitive-identity delete would hit Chris/Lise. Aborting.");
    }
    const r = await p.employeeSensitiveIdentity.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 5 — EmployeeTaxProfile", async () => {
    const r = await p.employeeTaxProfile.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 5 — EmployeeCppElection / CppDisability", async () => {
    const c = await p.employeeCppElection.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    const d = await p.employeeCppDisability.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { elections: c.count, disabilities: d.count };
  });
  await step("Phase 5 — EmployeeCredential + EmergencyContact + Document", async () => {
    const cr = await p.employeeCredential.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } });
    const em = await p.employeeEmergencyContact.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } });
    const doc = await p.employeeDocument.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } });
    return { credentials: cr.count, emergency: em.count, documents: doc.count };
  });
  await step("Phase 5 — Onboarding chain (fixture employees)", async () => {
    const invs = await p.employeeOnboardingInvitation.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    const acks = await p.employeeOnboardingAcknowledgement.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    const corrs = await p.employeeOnboardingCorrection.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    const sessions = await p.employeeOnboardingSession.findMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
      select: { id: true },
    });
    if (sessions.length) {
      const sids = sessions.map((s) => s.id);
      try { await p.employeeOnboardingResponse.deleteMany({ where: { sessionId: { in: sids } } }); } catch {}
      try { await p.employeeOnboardingStateTransition.deleteMany({ where: { sessionId: { in: sids } } }); } catch {}
    }
    const sess = await p.employeeOnboardingSession.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return {
      invitations: invs.count,
      acknowledgements: acks.count,
      corrections: corrs.count,
      sessions: sess.count,
    };
  });
  await step("Phase 5 — Portal credentials + password resets", async () => {
    const resets = await p.employeePortalPasswordReset.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    const creds = await p.employeePortalCredential.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { resets: resets.count, creds: creds.count };
  });
  await step("Phase 5 — Training assignments/progress/attempts/completions", async () => {
    // Fetch attempt IDs (question responses reference them)
    const attempts = await p.trainingAttempt.findMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
      select: { id: true },
    });
    const aids = attempts.map((a) => a.id);
    if (aids.length) {
      try { await p.trainingQuestionResponse.deleteMany({ where: { attemptId: { in: aids } } }); } catch {}
    }
    // Completions reference attempts via FK RESTRICT — delete completions first.
    const c = await p.trainingCompletion.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } });
    const a = await p.trainingAttempt.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } });
    const pr = await p.trainingProgress.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } });
    const asg = await p.trainingAssignment.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } });
    return { attempts: a.count, progress: pr.count, completions: c.count, assignments: asg.count };
  });
  await step("Phase 5 — EmployeeEmploymentAssignment + EmploymentPeriod", async () => {
    const asg = await p.employeeEmploymentAssignment.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    const per = await p.employmentPeriod.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { assignments: asg.count, periods: per.count };
  });
  try {
    await step("Phase 5 — HomeNotificationDismissal + UserClubProfile", async () => {
      let hn = 0, ucp = 0;
      try { hn = (await p.homeNotificationDismissal.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } })).count; } catch {}
      try { ucp = (await p.userClubProfile.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } })).count; } catch {}
      return { hn, ucp };
    });
  } catch {}

  await step("Phase 5 — PayrollOpeningBalance + Component (fixture employees)", async () => {
    const balances = await p.payrollOpeningBalance.findMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
      select: { id: true },
    });
    const bids = balances.map((b) => b.id);
    let comps = 0;
    if (bids.length) {
      try {
        comps = (await p.payrollOpeningBalanceComponent.deleteMany({
          where: { openingBalanceId: { in: bids } },
        })).count;
      } catch (e) {
        // Field name might be different
        try {
          comps = (await p.payrollOpeningBalanceComponent.deleteMany({
            where: { balanceId: { in: bids } },
          })).count;
        } catch {}
      }
    }
    const b = await p.payrollOpeningBalance.deleteMany({
      where: { employeeId: { in: FIXTURE_EMPS } },
    });
    return { balances: b.count, components: comps };
  });

  await step("Phase 5 — TimeClockEvent (fixture employees)", async () => {
    try {
      const r = await p.timeClockEvent.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } });
      return { deleted: r.count };
    } catch (e) {
      return { skipped: true, reason: e.message.split("\n")[0] };
    }
  });
  await step("Phase 5 — TimeEvent / EmployeeTimeEvent (any variant)", async () => {
    let r = 0;
    try { r += (await p.employeeTimeEvent.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } })).count; } catch {}
    try { r += (await p.timeEvent.deleteMany({ where: { employeeId: { in: FIXTURE_EMPS } } })).count; } catch {}
    return { deleted: r };
  });

  // Clear Employee.userId FKs BEFORE deleting the users
  await step("Phase 5 — Null out Employee.userId for fixture users", async () => {
    const r = await p.employee.updateMany({
      where: { userId: { in: FIXTURE_COULEE_USERS } },
      data: { userId: null },
    });
    return { updated: r.count };
  });

  // The POSTED batch retains PayrollBatchEmployee rows for Riley Reconcile
  // + Sam Salary. Those are snapshots — they don't affect the JournalEntry
  // which is already balanced and immutable. Delete them so the fixture
  // employees can be removed.
  await step("Phase 5.5 — POSTED batch fixture participation (snapshots only)", async () => {
    const be = await p.payrollBatchEmployee.findMany({
      where: { batchId: POSTED_BATCH, employeeId: { in: FIXTURE_EMPS } },
      select: { id: true },
    });
    const beIds = be.map((b) => b.id);
    let earn = 0, ded = 0, exc = 0, allw = 0, comp = 0;
    if (beIds.length) {
      try { earn = (await p.payrollBatchEarning.deleteMany({ where: { batchEmployeeId: { in: beIds } } })).count; } catch {}
      try { ded = (await p.payrollBatchDeduction.deleteMany({ where: { batchEmployeeId: { in: beIds } } })).count; } catch {}
      try { exc = (await p.payrollBatchException.deleteMany({ where: { batchEmployeeId: { in: beIds } } })).count; } catch {}
      try { allw = (await p.payrollBatchAllowanceSnapshot.deleteMany({ where: { batchEmployeeId: { in: beIds } } })).count; } catch {}
      try { comp = (await p.payrollBatchComponentSnapshot.deleteMany({ where: { batchEmployeeId: { in: beIds } } })).count; } catch {}
    }
    // Also handle the alt schema where earning/deduction reference employeeId directly on the POSTED batch
    try {
      earn += (await p.payrollBatchEarning.deleteMany({
        where: { batchId: POSTED_BATCH, employeeId: { in: FIXTURE_EMPS } },
      })).count;
    } catch {}
    try {
      ded += (await p.payrollBatchDeduction.deleteMany({
        where: { batchId: POSTED_BATCH, employeeId: { in: FIXTURE_EMPS } },
      })).count;
    } catch {}
    try {
      exc += (await p.payrollBatchException.deleteMany({
        where: { batchId: POSTED_BATCH, employeeId: { in: FIXTURE_EMPS } },
      })).count;
    } catch {}
    try {
      allw += (await p.payrollBatchAllowanceSnapshot.deleteMany({
        where: { batchId: POSTED_BATCH, employeeId: { in: FIXTURE_EMPS } },
      })).count;
    } catch {}
    try {
      comp += (await p.payrollBatchComponentSnapshot.deleteMany({
        where: { batchId: POSTED_BATCH, employeeId: { in: FIXTURE_EMPS } },
      })).count;
    } catch {}
    const r = await p.payrollBatchEmployee.deleteMany({
      where: { batchId: POSTED_BATCH, employeeId: { in: FIXTURE_EMPS } },
    });
    return { batchEmployees: r.count, earnings: earn, deductions: ded, exceptions: exc, allowances: allw, components: comp };
  });

  // ---------- PHASE 6 — Delete fixture Employees ----------
  await step("Phase 6 — Employee (14 fixture rows)", async () => {
    const r = await p.employee.deleteMany({
      where: { id: { in: FIXTURE_EMPS } },
    });
    return { deleted: r.count };
  });

  // ---------- PHASE 7 — Pay periods on fixture groups (keep POSTED period only) ----------
  await step("Phase 7 — PayrollPayPeriod (drop 3C-ACCEPT + all 3D-ACCEPT except POSTED period)", async () => {
    const r = await p.payrollPayPeriod.deleteMany({
      where: {
        clubId: COULEE,
        payGroupId: { in: [FIXTURE_PAY_GROUPS.RENAME_LEGACY, ...FIXTURE_PAY_GROUPS.DELETE] },
        id: { not: POSTED_PERIOD },
      },
    });
    return { deleted: r.count };
  });

  // ---------- PHASE 8 — Fixture pay group cleanup ----------
  await step("Phase 8 — Delete 3C-ACCEPT pay group", async () => {
    const r = await p.payrollPayGroup.deleteMany({
      where: { id: { in: FIXTURE_PAY_GROUPS.DELETE } },
    });
    return { deleted: r.count };
  });
  await step("Phase 8 — Rename 3D-ACCEPT → LEGACY-3F-POSTED, active=false", async () => {
    const r = await p.payrollPayGroup.update({
      where: { id: FIXTURE_PAY_GROUPS.RENAME_LEGACY },
      data: {
        code: "LEGACY-3F-POSTED",
        name: "Legacy 3F Posted Batch (archived, immutable)",
        active: false,
      },
    });
    return { id: r.id, code: r.code, active: r.active };
  });

  // ---------- PHASE 9 — Isolate fixture GL accounts (rename + deactivate; keep FK integrity) ----------
  await step("Phase 9 — Rename + deactivate 8 fixture GL accounts", async () => {
    let updates = 0;
    for (const id of FIXTURE_GL_ACCOUNTS) {
      const acct = await p.account.findUnique({ where: { id }, select: { name: true, accountNumber: true } });
      if (!acct) continue;
      const newName = acct.name.includes("LEGACY-3F") ? acct.name : `LEGACY-3F · ${acct.name}`;
      await p.account.update({
        where: { id },
        data: { name: newName, isActive: false },
      });
      updates++;
    }
    return { updated: updates };
  });

  // ---------- PHASE 10 — Fixture user cleanup ----------
  await step("Phase 10 — Clear DepartmentResponsibility rows for fixture users", async () => {
    try {
      const r = await p.departmentResponsibility.deleteMany({
        where: { userId: { in: FIXTURE_COULEE_USERS } },
      });
      return { deleted: r.count };
    } catch (e) {
      return { skipped: true, reason: e.message.split("\n")[0] };
    }
  });
  await step("Phase 10 — Null Department.managerUserId for fixture users", async () => {
    try {
      const r = await p.department.updateMany({
        where: { managerUserId: { in: FIXTURE_COULEE_USERS } },
        data: { managerUserId: null },
      });
      return { updated: r.count };
    } catch (e) {
      return { skipped: true, reason: e.message.split("\n")[0] };
    }
  });
  await step("Phase 10 — Delete UserClubRole for fixture Coulee users", async () => {
    const r = await p.userClubRole.deleteMany({
      where: { userId: { in: FIXTURE_COULEE_USERS } },
    });
    return { deleted: r.count };
  });
  await step("Phase 10 — Delete fixture Coulee users (taylor.hourly, grounds.manager, events.manager)", async () => {
    const r = await p.user.deleteMany({
      where: { id: { in: FIXTURE_COULEE_USERS } },
    });
    return { deleted: r.count };
  });

  // ---------- PHASE 11 — Normalize PayrollClubConfig ----------
  await step("Phase 11 — PayrollClubConfig: Chris as PA, fixture.controller as Controller, enabled=true, glProfile=null", async () => {
    const r = await p.payrollClubConfig.update({
      where: { clubId: COULEE },
      data: {
        payrollAdminUserId: CHRIS_USER,
        controllerUserId: FIXTURE_CONTROLLER,
        glAccountingProfileId: null,
        enabled: true,
      },
    });
    return {
      enabled: r.enabled,
      payrollAdminUserId: r.payrollAdminUserId,
      controllerUserId: r.controllerUserId,
      glAccountingProfileId: r.glAccountingProfileId,
    };
  });

  // ---------- PHASE 12 — Delete fixture.pa@spectre.test (old, no FKs remain) ----------
  await step("Phase 12 — Delete fixture.pa@spectre.test (safe after PayrollClubConfig repoint)", async () => {
    // Verify no residual FK dependencies
    const submits = await p.payrollBatch.count({ where: { submittedByUserId: FIXTURE_PA_OLD } });
    const approves = await p.payrollBatch.count({ where: { approvedByUserId: FIXTURE_PA_OLD } });
    const posts = await p.payrollBatch.count({ where: { postedByUserId: FIXTURE_PA_OLD } });
    if (submits + approves + posts > 0) {
      return { skipped: true, submits, approves, posts };
    }
    await p.userClubRole.deleteMany({ where: { userId: FIXTURE_PA_OLD } });
    const r = await p.user.deleteMany({ where: { id: FIXTURE_PA_OLD } });
    return { deleted: r.count };
  });

  process.stdout.write("\n== CLEANUP COMPLETE ==\n");
}

main()
  .catch((e) => {
    console.error("FATAL:", e.message);
    console.error(e.stack);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
