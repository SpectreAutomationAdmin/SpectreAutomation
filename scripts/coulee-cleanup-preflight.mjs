// READ-ONLY preflight before destructive cleanup.
// 1. Which employees own the 2 EmployeeSensitiveIdentity rows?
// 2. Which employees own the 8 EmployeeBankAccount rows?
// 3. Which employees own the 12 EmployeeCompensation rows?
// 4. Full FDR-BW pay-period coverage
// 5. Employee-employment-assignment status for Chris/Lise
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const COULEE = "cmrvdeny7000144372ktmmg9c";
const CHRIS = "cmt113ppt002jjj78mnmx5cwu";
const LISE = "cmt80kivp001913sjl6p7csre";
const FDR_BW = "cmtjc2u2b000bgnjudym510so";

const out = {};
async function main() {
  const empIds = await p.employee
    .findMany({ where: { clubId: COULEE }, select: { id: true, firstName: true, lastName: true } });
  const empMap = Object.fromEntries(empIds.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

  out.sensitiveIdentityOwners = (
    await p.employeeSensitiveIdentity.findMany({
      where: { employeeId: { in: empIds.map((e) => e.id) } },
      select: { id: true, employeeId: true },
    })
  ).map((r) => ({ id: r.id, employeeId: r.employeeId, name: empMap[r.employeeId] }));

  out.bankAccountOwners = (
    await p.employeeBankAccount.findMany({
      where: { employeeId: { in: empIds.map((e) => e.id) } },
      select: { id: true, employeeId: true },
    })
  ).map((r) => ({ id: r.id, employeeId: r.employeeId, name: empMap[r.employeeId] }));

  out.compensationOwners = (
    await p.employeeCompensation.findMany({
      where: { employeeId: { in: empIds.map((e) => e.id) } },
      select: { id: true, employeeId: true },
    })
  ).map((r) => ({ id: r.id, employeeId: r.employeeId, name: empMap[r.employeeId] }));

  out.fdrBwPeriods = await p.payrollPayPeriod.findMany({
    where: { payGroupId: FDR_BW },
    orderBy: { periodStart: "asc" },
    select: {
      id: true,
      taxYear: true,
      sequenceInYear: true,
      periodStart: true,
      periodEnd: true,
      payDate: true,
      status: true,
    },
  });

  out.fdrBwPayGroup = await p.payrollPayGroup.findUnique({
    where: { id: FDR_BW },
    select: {
      id: true,
      code: true,
      name: true,
      payFrequency: true,
      active: true,
      calendarAnchorDate: true,
      payDateOffsetDays: true,
    },
  });

  const chris = await p.user.findFirst({
    where: { email: "cturcato@spectreautomation.com" },
    include: {
      clubRoles: {
        select: { id: true, clubId: true, roleKey: true, createdAt: true },
      },
    },
  });
  out.chrisUser = chris
    ? {
        id: chris.id,
        email: chris.email,
        name: chris.name,
        role: chris.role,
        status: chris.status,
        clubId: chris.clubId,
        clubRoles: chris.clubRoles,
      }
    : null;

  const chrisEmpAssignments = await p.employmentAssignment
    ?.findMany?.({
      where: { employeeId: CHRIS },
      select: { id: true, positionId: true, effectiveFrom: true, effectiveTo: true },
    })
    ?.catch(() => null);
  out.chrisEmpAssignments = chrisEmpAssignments;

  const liseEmpAssignments = await p.employmentAssignment
    ?.findMany?.({
      where: { employeeId: LISE },
      select: { id: true, positionId: true, effectiveFrom: true, effectiveTo: true },
    })
    ?.catch(() => null);
  out.liseEmpAssignments = liseEmpAssignments;

  // Employee counts by lifecycle to sanity-check
  out.employeeLifecycleCounts = await p.employee.groupBy({
    by: ["employeeLifecycle"],
    where: { clubId: COULEE },
    _count: { _all: true },
  });

  // Time approvals + Attestations tied to fixture batches specifically
  out.deptTimeApprovalsForFdrBwPeriods = await p.payrollDepartmentTimeApproval.count({
    where: { payPeriod: { payGroupId: FDR_BW } },
  });

  console.log(JSON.stringify(out, null, 2));
}
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
