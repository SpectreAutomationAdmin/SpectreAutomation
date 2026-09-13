// COULEE RIDGE ZERO-EMPLOYEE RESET — DESTRUCTIVE.
// Deletes Chris + Lise legacy Employee records and all owned dependents.
// PRESERVES: super-admin User cturcato@spectreautomation.com and its
// UserClubRoles. Fixture history (POSTED batch + journal + LEGACY-3F
// accounts) is left untouched.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const COULEE = "cmrvdeny7000144372ktmmg9c";
const CHRIS_EMP = "cmt113ppt002jjj78mnmx5cwu";
const LISE_EMP = "cmt80kivp001913sjl6p7csre";
const EMPS = [CHRIS_EMP, LISE_EMP];
const SUPER_ADMIN_USER = "cmrvdenz700034437agp7gqs5";
const SUPER_ADMIN_EMAIL = "cturcato@spectreautomation.com";
const POSTED_BATCH = "cmtzxy7f30006rm2s31rcv8rp";
const CHRIS_PORTAL_EMAIL = "c.s.turcato@gmail.com";
const LISE_PORTAL_EMAIL = "lisewashere@live.com";

async function step(name, fn) {
  process.stdout.write(`\n== ${name} ==\n`);
  const t = Date.now();
  const r = await fn();
  process.stdout.write(`   ok (${Date.now() - t}ms)${r !== undefined ? " " + JSON.stringify(r) : ""}\n`);
  return r;
}

async function main() {
  // Safety: prove super-admin exists and is a different row than any employee
  const superAdmin = await p.user.findUnique({
    where: { id: SUPER_ADMIN_USER },
    select: { id: true, email: true, employee: { select: { id: true } } },
  });
  if (!superAdmin) throw new Error("SAFETY: super-admin User not found; refusing to run.");
  if (superAdmin.email !== SUPER_ADMIN_EMAIL) {
    throw new Error(`SAFETY: super-admin email mismatch (found ${superAdmin.email}); refusing to run.`);
  }
  if (superAdmin.employee) {
    throw new Error(`SAFETY: super-admin User is linked to Employee ${superAdmin.employee.id}; refusing to run.`);
  }
  process.stdout.write(`SUPER ADMIN VERIFIED: ${superAdmin.email} (id=${superAdmin.id}) has no Employee link.\n`);

  // Any DRAFT/PREPARED batches on FDR-BW that reference these employees
  const activeBatches = await p.payrollBatch.findMany({
    where: {
      clubId: COULEE,
      id: { not: POSTED_BATCH },
      status: { in: ["DRAFT", "PREPARED", "CALCULATED", "SUBMITTED_FOR_APPROVAL", "APPROVED", "RETURNED_FOR_CORRECTION"] },
    },
    select: { id: true, status: true, payGroupId: true },
  });
  const ACTIVE_BATCH_IDS = activeBatches.map((b) => b.id);
  process.stdout.write(`Non-POSTED batches to delete: ${ACTIVE_BATCH_IDS.length}\n`);

  // ---------- PHASE 1 — Any non-POSTED batch children ----------
  await step("Phase 1 — WI cards on non-POSTED batches", async () => {
    if (!ACTIVE_BATCH_IDS.length) return { deleted: 0 };
    // Batch review + final-approval WI cards reference batchId via WorkIntakeOrigin.referenceId
    const origins = await p.workIntakeOrigin.findMany({
      where: {
        clubId: COULEE,
        referenceId: { in: ACTIVE_BATCH_IDS },
        kind: { startsWith: "PAYROLL_" },
      },
      select: { id: true, workIntakeItemId: true },
    });
    const wiIds = [...new Set(origins.map((o) => o.workIntakeItemId))];
    let activityDel = 0, originDel = 0, itemDel = 0;
    try { await p.workIntakeItemRead.deleteMany({ where: { workIntakeItemId: { in: wiIds } } }); } catch {}
    activityDel = (await p.workIntakeActivity.deleteMany({ where: { workIntakeItemId: { in: wiIds } } })).count;
    originDel = (await p.workIntakeOrigin.deleteMany({ where: { id: { in: origins.map((o) => o.id) } } })).count;
    itemDel = (await p.workIntakeItem.deleteMany({ where: { id: { in: wiIds } } })).count;
    return { origins: originDel, activity: activityDel, items: itemDel };
  });
  await step("Phase 1 — PayrollBatchReviewAttestation (non-POSTED)", async () => {
    if (!ACTIVE_BATCH_IDS.length) return { deleted: 0 };
    const r = await p.payrollBatchReviewAttestation.deleteMany({ where: { batchId: { in: ACTIVE_BATCH_IDS } } });
    return { deleted: r.count };
  });
  await step("Phase 1 — PayrollBatch children (earnings/deductions/exceptions/snapshots)", async () => {
    if (!ACTIVE_BATCH_IDS.length) return { deleted: 0 };
    const e = await p.payrollBatchEarning.deleteMany({ where: { batchId: { in: ACTIVE_BATCH_IDS } } });
    const d = await p.payrollBatchDeduction.deleteMany({ where: { batchId: { in: ACTIVE_BATCH_IDS } } });
    const x = await p.payrollBatchException.deleteMany({ where: { batchId: { in: ACTIVE_BATCH_IDS } } });
    const a = await p.payrollBatchAllowanceSnapshot.deleteMany({ where: { batchId: { in: ACTIVE_BATCH_IDS } } });
    const c = await p.payrollBatchComponentSnapshot.deleteMany({ where: { batchId: { in: ACTIVE_BATCH_IDS } } });
    const be = await p.payrollBatchEmployee.deleteMany({ where: { batchId: { in: ACTIVE_BATCH_IDS } } });
    return { earnings: e.count, deductions: d.count, exceptions: x.count, allowances: a.count, components: c.count, batchEmployees: be.count };
  });
  await step("Phase 1 — Non-POSTED batches", async () => {
    if (!ACTIVE_BATCH_IDS.length) return { deleted: 0 };
    const r = await p.payrollBatch.deleteMany({ where: { id: { in: ACTIVE_BATCH_IDS } } });
    return { deleted: r.count };
  });

  // ---------- PHASE 2 — POSTED-batch fixture snapshots for Chris/Lise (belt-and-braces) ----------
  await step("Phase 2 — POSTED batch snapshots for Chris/Lise (if any)", async () => {
    const be = await p.payrollBatchEmployee.findMany({
      where: { batchId: POSTED_BATCH, employeeId: { in: EMPS } },
      select: { id: true },
    });
    const beIds = be.map((b) => b.id);
    if (!beIds.length) return { batchEmployees: 0 };
    try { await p.payrollBatchEarning.deleteMany({ where: { batchEmployeeId: { in: beIds } } }); } catch {}
    try { await p.payrollBatchDeduction.deleteMany({ where: { batchEmployeeId: { in: beIds } } }); } catch {}
    try { await p.payrollBatchException.deleteMany({ where: { batchEmployeeId: { in: beIds } } }); } catch {}
    try { await p.payrollBatchAllowanceSnapshot.deleteMany({ where: { batchEmployeeId: { in: beIds } } }); } catch {}
    try { await p.payrollBatchComponentSnapshot.deleteMany({ where: { batchEmployeeId: { in: beIds } } }); } catch {}
    try { await p.payrollBatchEarning.deleteMany({ where: { batchId: POSTED_BATCH, employeeId: { in: EMPS } } }); } catch {}
    try { await p.payrollBatchDeduction.deleteMany({ where: { batchId: POSTED_BATCH, employeeId: { in: EMPS } } }); } catch {}
    try { await p.payrollBatchException.deleteMany({ where: { batchId: POSTED_BATCH, employeeId: { in: EMPS } } }); } catch {}
    const r = await p.payrollBatchEmployee.deleteMany({
      where: { batchId: POSTED_BATCH, employeeId: { in: EMPS } },
    });
    return { batchEmployees: r.count };
  });

  // ---------- PHASE 3 — Employee-owned records ----------
  await step("Phase 3 — Portal password resets + credentials", async () => {
    const r1 = await p.employeePortalPasswordReset.deleteMany({ where: { employeeId: { in: EMPS } } });
    const r2 = await p.employeePortalCredential.deleteMany({ where: { employeeId: { in: EMPS } } });
    return { resets: r1.count, credentials: r2.count };
  });
  await step("Phase 3 — Onboarding chain", async () => {
    const invs = await p.employeeOnboardingInvitation.deleteMany({ where: { employeeId: { in: EMPS } } });
    const acks = await p.employeeOnboardingAcknowledgement.deleteMany({ where: { employeeId: { in: EMPS } } });
    const corrs = await p.employeeOnboardingCorrection.deleteMany({ where: { employeeId: { in: EMPS } } });
    const sessions = await p.employeeOnboardingSession.findMany({
      where: { employeeId: { in: EMPS } },
      select: { id: true },
    });
    if (sessions.length) {
      const sids = sessions.map((s) => s.id);
      try { await p.employeeOnboardingResponse.deleteMany({ where: { sessionId: { in: sids } } }); } catch {}
      try { await p.employeeOnboardingStateTransition.deleteMany({ where: { sessionId: { in: sids } } }); } catch {}
    }
    const s = await p.employeeOnboardingSession.deleteMany({ where: { employeeId: { in: EMPS } } });
    return { invitations: invs.count, acknowledgements: acks.count, corrections: corrs.count, sessions: s.count };
  });
  await step("Phase 3 — Training (completions before attempts)", async () => {
    const c = await p.trainingCompletion.deleteMany({ where: { employeeId: { in: EMPS } } });
    const attempts = await p.trainingAttempt.findMany({
      where: { employeeId: { in: EMPS } },
      select: { id: true },
    });
    const aids = attempts.map((a) => a.id);
    if (aids.length) {
      try { await p.trainingQuestionResponse.deleteMany({ where: { attemptId: { in: aids } } }); } catch {}
    }
    const a = await p.trainingAttempt.deleteMany({ where: { employeeId: { in: EMPS } } });
    const pr = await p.trainingProgress.deleteMany({ where: { employeeId: { in: EMPS } } });
    const asg = await p.trainingAssignment.deleteMany({ where: { employeeId: { in: EMPS } } });
    return { completions: c.count, attempts: a.count, progress: pr.count, assignments: asg.count };
  });
  await step("Phase 3 — Employment assignments + periods", async () => {
    const asg = await p.employeeEmploymentAssignment.deleteMany({ where: { employeeId: { in: EMPS } } });
    const per = await p.employmentPeriod.deleteMany({ where: { employeeId: { in: EMPS } } });
    return { assignments: asg.count, periods: per.count };
  });
  await step("Phase 3 — Compensation / Bank / SensitiveIdentity / TaxProfile", async () => {
    const c = await p.employeeCompensation.deleteMany({ where: { employeeId: { in: EMPS } } });
    const b = await p.employeeBankAccount.deleteMany({ where: { employeeId: { in: EMPS } } });
    const si = await p.employeeSensitiveIdentity.deleteMany({ where: { employeeId: { in: EMPS } } });
    const tp = await p.employeeTaxProfile.deleteMany({ where: { employeeId: { in: EMPS } } });
    return { compensation: c.count, bank: b.count, sensitiveIdentity: si.count, tax: tp.count };
  });
  await step("Phase 3 — Credentials / Emergency / Documents / Allowances / Recurring / CPP", async () => {
    const cr = await p.employeeCredential.deleteMany({ where: { employeeId: { in: EMPS } } });
    const em = await p.employeeEmergencyContact.deleteMany({ where: { employeeId: { in: EMPS } } });
    const doc = await p.employeeDocument.deleteMany({ where: { employeeId: { in: EMPS } } });
    const al = await p.employeeAllowance.deleteMany({ where: { employeeId: { in: EMPS } } });
    const rc = await p.employeeRecurringPayrollComponent.deleteMany({ where: { employeeId: { in: EMPS } } });
    const cpp = await p.employeeCppElection.deleteMany({ where: { employeeId: { in: EMPS } } });
    const cppD = await p.employeeCppDisability.deleteMany({ where: { employeeId: { in: EMPS } } });
    return { credentials: cr.count, emergency: em.count, documents: doc.count, allowances: al.count, recurring: rc.count, cppElections: cpp.count, cppDisabilities: cppD.count };
  });
  await step("Phase 3 — Scheduling / time-clock / opportunity chain", async () => {
    const asgIds = (await p.shiftAssignment.findMany({
      where: { employeeId: { in: EMPS } },
      select: { id: true },
    })).map((a) => a.id);
    let opps = 0;
    if (asgIds.length) {
      try {
        const oIds = (await p.shiftOpportunity.findMany({
          where: { offeredByAssignmentId: { in: asgIds } },
          select: { id: true },
        })).map((o) => o.id);
        if (oIds.length) {
          try { await p.claimedShiftOpportunity.deleteMany({ where: { opportunityId: { in: oIds } } }); } catch {}
          try { await p.offeredShiftOpportunity.deleteMany({ where: { opportunityId: { in: oIds } } }); } catch {}
        }
        opps = (await p.shiftOpportunity.deleteMany({ where: { id: { in: oIds } } })).count;
      } catch {}
    }
    const s = await p.shiftAssignment.deleteMany({ where: { employeeId: { in: EMPS } } });
    // Timesheet entries + clock events
    const entries = await p.payrollTimesheetEntry.findMany({
      where: { timesheet: { employeeId: { in: EMPS } } },
      select: { id: true },
    });
    const entryIds = entries.map((e) => e.id);
    if (entryIds.length) {
      try { await p.payrollTimesheetEntryClockEvent.deleteMany({ where: { timesheetEntryId: { in: entryIds } } }); } catch {}
    }
    const te = await p.payrollTimesheetEntry.deleteMany({ where: { id: { in: entryIds } } });
    const ts = await p.payrollTimesheet.deleteMany({ where: { employeeId: { in: EMPS } } });
    const pate = await p.payrollApprovedTimeEntry.deleteMany({ where: { employeeId: { in: EMPS } } });
    const pta = await p.payrollTimeAdjustment.deleteMany({ where: { employeeId: { in: EMPS } } });
    const tccr = await p.timeClockCorrectionRequest.deleteMany({ where: { employeeId: { in: EMPS } } });
    try { await p.timeClockEvent.deleteMany({ where: { employeeId: { in: EMPS } } }); } catch {}
    // Availability
    const profiles = await p.employeeAvailabilityProfile.findMany({
      where: { employeeId: { in: EMPS } },
      select: { id: true },
    });
    for (const prof of profiles) {
      await p.employeeAvailabilityRule.deleteMany({ where: { availabilityProfileId: prof.id } });
    }
    await p.employeeAvailabilityProfile.deleteMany({ where: { employeeId: { in: EMPS } } });
    const aw = await p.employeeAvailabilityWeek.deleteMany({ where: { employeeId: { in: EMPS } } });
    return {
      shifts: s.count, opportunities: opps, timesheets: ts.count, timesheetEntries: te.count,
      approvedTime: pate.count, timeAdjustments: pta.count, corrections: tccr.count,
      availabilityWeeks: aw.count,
    };
  });
  await step("Phase 3 — PayrollPayGroupMember", async () => {
    const r = await p.payrollPayGroupMember.deleteMany({ where: { employeeId: { in: EMPS } } });
    return { deleted: r.count };
  });
  await step("Phase 3 — PayrollOpeningBalance + components", async () => {
    const balances = await p.payrollOpeningBalance.findMany({
      where: { employeeId: { in: EMPS } },
      select: { id: true },
    });
    if (balances.length) {
      try { await p.payrollOpeningBalanceComponent.deleteMany({ where: { openingBalanceId: { in: balances.map((b) => b.id) } } }); } catch {}
    }
    const r = await p.payrollOpeningBalance.deleteMany({ where: { employeeId: { in: EMPS } } });
    return { balances: r.count };
  });
  try {
    await step("Phase 3 — HomeNotificationDismissal + UserClubProfile", async () => {
      let hn = 0, ucp = 0;
      try { hn = (await p.employeeHomeNotificationDismissal.deleteMany({ where: { employeeId: { in: EMPS } } })).count; } catch {}
      try { hn += (await p.homeNotificationDismissal.deleteMany({ where: { employeeId: { in: EMPS } } })).count; } catch {}
      try { ucp = (await p.userClubProfile.deleteMany({ where: { employeeId: { in: EMPS } } })).count; } catch {}
      return { hn, ucp };
    });
  } catch {}

  // ---------- PHASE 4 — Delete Employee rows ----------
  await step("Phase 4 — Employee (Chris + Lise)", async () => {
    const r = await p.employee.deleteMany({ where: { id: { in: EMPS } } });
    return { deleted: r.count };
  });

  // ---------- PHASE 5 — Post-delete assertions ----------
  const finalCount = await p.employee.count({ where: { clubId: COULEE } });
  const finalActiveCount = await p.employee.count({ where: { clubId: COULEE, employeeLifecycle: "ACTIVE" } });
  process.stdout.write(`\n== POST-DELETE ==\n`);
  process.stdout.write(`Coulee employees remaining: ${finalCount} (active: ${finalActiveCount})\n`);
  const chrisEmailAvail = (await p.employee.count({ where: { OR: [{ email: CHRIS_PORTAL_EMAIL }, { personalEmail: CHRIS_PORTAL_EMAIL }] } })) === 0;
  const chrisEmailUserAvail = (await p.user.count({ where: { email: CHRIS_PORTAL_EMAIL } })) === 0;
  const liseEmailAvail = (await p.employee.count({ where: { OR: [{ email: LISE_PORTAL_EMAIL }, { personalEmail: LISE_PORTAL_EMAIL }] } })) === 0;
  const liseEmailUserAvail = (await p.user.count({ where: { email: LISE_PORTAL_EMAIL } })) === 0;
  process.stdout.write(`Chris email (${CHRIS_PORTAL_EMAIL}) reusable: employee=${chrisEmailAvail} user=${chrisEmailUserAvail}\n`);
  process.stdout.write(`Lise  email (${LISE_PORTAL_EMAIL}) reusable: employee=${liseEmailAvail} user=${liseEmailUserAvail}\n`);
  const superAdminStill = await p.user.findUnique({
    where: { id: SUPER_ADMIN_USER },
    select: { id: true, email: true, status: true, clubRoles: { select: { roleKey: true } } },
  });
  process.stdout.write(`Super Admin still present: ${JSON.stringify(superAdminStill)}\n`);

  process.stdout.write("\n== ZERO-BASELINE RESET COMPLETE ==\n");
}

main()
  .catch((e) => {
    console.error("FATAL:", e.message);
    console.error(e.stack);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
