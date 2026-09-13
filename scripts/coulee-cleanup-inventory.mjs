// READ-ONLY inventory of Coulee Ridge staging state for fixture-cleanup planning.
// Prints a single JSON blob to stdout. No mutation. No deletion.
// Usage: node scripts/coulee-cleanup-inventory.mjs
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const COULEE = "cmrvdeny7000144372ktmmg9c";

const out = {};

async function main() {
  out.employees = await p.employee.findMany({
    where: { clubId: COULEE },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      status: true,
      employeeLifecycle: true,
      userId: true,
      memberId: true,
      createdAt: true,
      positionId: true,
      departmentId: true,
      compensationType: true,
      payRate: true,
      hireDate: true,
      employmentType: true,
      createdByUserId: true,
    },
  });

  out.users = await p.user.findMany({
    where: { clubId: COULEE },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      createdAt: true,
    },
  });

  out.payrollClubConfig = await p.payrollClubConfig.findUnique({
    where: { clubId: COULEE },
  });

  out.payGroups = await p.payrollPayGroup.findMany({
    where: { clubId: COULEE },
    select: {
      id: true,
      name: true,
      code: true,
      payFrequency: true,
      active: true,
      createdAt: true,
    },
  });

  out.payPeriods = await p.payrollPayPeriod.findMany({
    where: { clubId: COULEE },
    orderBy: { periodStart: "asc" },
    select: {
      id: true,
      payGroupId: true,
      periodStart: true,
      periodEnd: true,
      payDate: true,
      status: true,
      createdAt: true,
    },
  });

  out.payrollBatches = await p.payrollBatch.findMany({
    where: { clubId: COULEE },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      payGroupId: true,
      payPeriodId: true,
      sequence: true,
      status: true,
      calculationVersion: true,
      calculatedAt: true,
      submittedByUserId: true,
      approvedByUserId: true,
      postedByUserId: true,
      postedAt: true,
      glJournalEntryId: true,
      createdAt: true,
    },
  });

  out.payrollBatchEmployeesCount = await p.payrollBatchEmployee.count({
    where: { clubId: COULEE },
  });

  out.workIntakeItemsCount = await p.workIntakeItem.count({
    where: { clubId: COULEE },
  });

  out.workIntakeItemsByStatus = await p.workIntakeItem.groupBy({
    by: ["status"],
    where: { clubId: COULEE },
    _count: { _all: true },
  });

  out.workIntakeOrigins = await p.workIntakeOrigin.findMany({
    where: { clubId: COULEE },
    select: {
      id: true,
      kind: true,
      referenceId: true,
      role: true,
      workIntakeItemId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  out.glAccountingProfile = await p.payrollGlAccountingProfile.findUnique({
    where: { clubId: COULEE },
  });

  out.payrollGlAccounts = await p.account.findMany({
    where: {
      clubId: COULEE,
      OR: [
        { accountNumber: { startsWith: "5100" } },
        { accountNumber: { startsWith: "5110" } },
        { accountNumber: { startsWith: "5120" } },
        { accountNumber: { startsWith: "2100" } },
        { accountNumber: { startsWith: "2110" } },
        { accountNumber: { startsWith: "2120" } },
        { accountNumber: { startsWith: "2130" } },
        { accountNumber: { startsWith: "2140" } },
      ],
    },
    select: { id: true, accountNumber: true, name: true, type: true, isActive: true },
  });

  out.journalEntriesFromPayroll = await p.journalEntry.findMany({
    where: {
      clubId: COULEE,
      payrollBatchGL: { some: {} },
    },
    select: {
      id: true,
      description: true,
      createdAt: true,
      payrollBatchGL: { select: { id: true, status: true, sequence: true } },
    },
  });

  const empIds = out.employees.map((e) => e.id);
  out.recurringComponentsCount = await p.employeeRecurringPayrollComponent.count({
    where: { employeeId: { in: empIds } },
  });
  out.compensationRowsCount = await p.employeeCompensation.count({
    where: { employeeId: { in: empIds } },
  });
  out.bankAccountsCount = await p.employeeBankAccount.count({
    where: { employeeId: { in: empIds } },
  });
  out.sensitiveIdentityCount = await p.employeeSensitiveIdentity.count({
    where: { employeeId: { in: empIds } },
  });
  out.availabilityWeeksCount = await p.employeeAvailabilityWeek.count({
    where: { employeeId: { in: empIds } },
  });
  out.shiftAssignmentsCount = await p.shiftAssignment.count({
    where: { employeeId: { in: empIds } },
  });
  out.timesheetsCount = await p.payrollTimesheet.count({
    where: { employeeId: { in: empIds } },
  });
  out.onboardingSessionsCount = await p.employeeOnboardingSession.count({
    where: { employeeId: { in: empIds } },
  });
  out.payGroupMembersCount = await p.payrollPayGroupMember.count({
    where: { clubId: COULEE },
  });

  console.log(JSON.stringify(out, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
