// Post-cleanup verification against founder §21 assertions.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const COULEE = "cmrvdeny7000144372ktmmg9c";
const CHRIS_EMP = "cmt113ppt002jjj78mnmx5cwu";
const LISE_EMP = "cmt80kivp001913sjl6p7csre";
const CHRIS_USER = "cmrvdenz700034437agp7gqs5";
const FIXTURE_CONTROLLER = "cmtjc2s9d0003gnjuhbfyo6i2";
const POSTED_BATCH = "cmtzxy7f30006rm2s31rcv8rp";
const POSTED_JOURNAL = "cmtzye888002brm2sjsgh6hc1";

const out = {};
async function main() {
  // A. Visible employee population
  out.employees = await p.employee.findMany({
    where: { clubId: COULEE },
    select: { id: true, firstName: true, lastName: true, status: true, employeeLifecycle: true },
    orderBy: { createdAt: "asc" },
  });

  // B. Coulee-scoped users
  out.users = await p.user.findMany({
    where: { clubId: COULEE },
    select: { id: true, email: true, name: true, role: true, status: true },
  });

  // C. Chris's roles
  out.chrisRoles = await p.userClubRole.findMany({
    where: { userId: CHRIS_USER, clubId: COULEE },
    select: { id: true, roleKey: true, createdAt: true },
  });

  // D. PayrollClubConfig
  out.payrollClubConfig = await p.payrollClubConfig.findUnique({
    where: { clubId: COULEE },
    select: {
      enabled: true,
      country: true,
      provinceOfEmployment: true,
      defaultPayFrequency: true,
      defaultPaymentMethod: true,
      payrollAdminUserId: true,
      controllerUserId: true,
      glAccountingProfileId: true,
    },
  });

  // E. Pay groups
  out.payGroups = await p.payrollPayGroup.findMany({
    where: { clubId: COULEE },
    orderBy: { createdAt: "asc" },
    select: { id: true, code: true, name: true, active: true, payFrequency: true },
  });

  // F. Pay-group members for FDR-BW
  const fdrBw = out.payGroups.find((g) => g.code === "FDR-BW");
  out.fdrBwMembers = fdrBw
    ? await p.payrollPayGroupMember.findMany({
        where: { payGroupId: fdrBw.id },
        select: { employeeId: true, effectiveFrom: true, effectiveTo: true },
      })
    : [];

  // G. FDR-BW period count
  out.fdrBwPeriodCount = fdrBw
    ? await p.payrollPayPeriod.count({ where: { payGroupId: fdrBw.id } })
    : 0;

  // H. Batches remaining
  out.batchStatuses = await p.payrollBatch.groupBy({
    by: ["status"],
    where: { clubId: COULEE },
    _count: { _all: true },
  });

  // I. POSTED batch integrity
  out.postedBatch = await p.payrollBatch.findUnique({
    where: { id: POSTED_BATCH },
    select: {
      id: true,
      status: true,
      postedByUserId: true,
      postedAt: true,
      glJournalEntryId: true,
    },
  });

  // J. POSTED journal integrity
  out.postedJournal = await p.journalEntry.findUnique({
    where: { id: POSTED_JOURNAL },
    include: {
      lines: {
        select: { accountId: true, debit: true, credit: true },
      },
    },
  });
  if (out.postedJournal) {
    const lines = out.postedJournal.lines;
    const td = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
    const tc = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
    out.postedJournal = {
      id: out.postedJournal.id,
      lineCount: lines.length,
      totalDebit: td,
      totalCredit: tc,
      balanced: Math.abs(td - tc) < 0.01,
    };
  }

  // K. Fixture GL accounts renamed
  out.legacyGlAccounts = await p.account.findMany({
    where: { clubId: COULEE, name: { startsWith: "LEGACY-3F" } },
    select: { id: true, accountNumber: true, name: true, isActive: true },
  });

  // L. Work Intake surfaces
  out.wiCounts = await p.workIntakeItem.groupBy({
    by: ["status"],
    where: { clubId: COULEE },
    _count: { _all: true },
  });

  // M. Payroll fixture WI still present
  out.payrollWiRemaining = await p.workIntakeItem.count({
    where: {
      clubId: COULEE,
      origins: { some: { kind: { startsWith: "PAYROLL_" } } },
    },
  });

  // N. Fiscal year/period integrity
  out.fiscalYearCount = await p.fiscalYear.count({ where: { clubId: COULEE } });
  out.fiscalPeriodCount = await p.fiscalPeriod.count({ where: { clubId: COULEE } });

  // O. Retained non-Coulee-scoped acceptance principals
  out.retainedAcceptancePrincipals = await p.user.findMany({
    where: {
      OR: [
        { email: "fixture.controller@spectre.test" },
        { email: "fixture.controller.3e@spectre.test" },
        { email: "fixture.payroll-admin.3e@spectre.test" },
        { email: "fixture.poster.3f@spectre.test" },
      ],
    },
    select: { id: true, email: true, role: true, status: true, clubId: true },
  });

  // P. Chris + Lise compensation preserved
  out.chrisCompensation = await p.employeeCompensation.findFirst({
    where: { employeeId: CHRIS_EMP },
    select: { id: true },
  });
  out.liseCompensation = await p.employeeCompensation.findFirst({
    where: { employeeId: LISE_EMP },
    select: { id: true },
  });

  // Q. Sensitive identity for Chris/Lise
  out.chrisSensitiveIdentity = await p.employeeSensitiveIdentity.findFirst({
    where: { employeeId: CHRIS_EMP },
    select: { id: true, employeeId: true },
  });
  out.liseSensitiveIdentity = await p.employeeSensitiveIdentity.findFirst({
    where: { employeeId: LISE_EMP },
    select: { id: true, employeeId: true },
  });

  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
