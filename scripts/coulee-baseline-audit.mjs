// READ-ONLY audit for zero-employee reset:
//  1. Prove Super-Admin User (cturcato@spectreautomation.com) is distinct
//     from any Chris employee-portal identity.
//  2. Enumerate every FK dependency Chris/Lise employees carry.
//  3. Check whether c.s.turcato@gmail.com / lisewashere@live.com are reusable.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const COULEE = "cmrvdeny7000144372ktmmg9c";
const CHRIS_EMP = "cmt113ppt002jjj78mnmx5cwu";
const LISE_EMP = "cmt80kivp001913sjl6p7csre";
const SUPER_ADMIN_EMAIL = "cturcato@spectreautomation.com";
const CHRIS_PORTAL_EMAIL = "c.s.turcato@gmail.com";
const LISE_PORTAL_EMAIL = "lisewashere@live.com";

const out = {};

async function main() {
  // 1. Super admin User + all its Coulee-facing memberships
  out.superAdmin = await p.user.findUnique({
    where: { email: SUPER_ADMIN_EMAIL },
    include: {
      clubRoles: { select: { id: true, clubId: true, roleKey: true } },
      employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
    },
  });

  // 2. Any User rows with the portal emails
  out.chrisPortalEmailUser = await p.user.findFirst({
    where: { email: CHRIS_PORTAL_EMAIL },
    select: { id: true, email: true, name: true, role: true, clubId: true, memberId: true },
  });
  out.lisePortalEmailUser = await p.user.findFirst({
    where: { email: LISE_PORTAL_EMAIL },
    select: { id: true, email: true, name: true, role: true, clubId: true, memberId: true },
  });

  // 3. Chris + Lise employee full detail
  out.chrisEmployee = await p.employee.findUnique({
    where: { id: CHRIS_EMP },
    select: {
      id: true, firstName: true, lastName: true, employeeNumber: true,
      email: true, personalEmail: true, userId: true, memberId: true,
      status: true, employeeLifecycle: true, positionId: true, departmentId: true,
      compensationType: true, payRate: true, hireDate: true,
      onboardingState: true, payrollReadiness: true,
    },
  });
  out.liseEmployee = await p.employee.findUnique({
    where: { id: LISE_EMP },
    select: {
      id: true, firstName: true, lastName: true, employeeNumber: true,
      email: true, personalEmail: true, userId: true, memberId: true,
      status: true, employeeLifecycle: true, positionId: true, departmentId: true,
      compensationType: true, payRate: true, hireDate: true,
      onboardingState: true, payrollReadiness: true,
    },
  });

  // 4. Portal credentials
  out.chrisPortalCred = await p.employeePortalCredential.findFirst({
    where: { employeeId: CHRIS_EMP },
  });
  out.lisePortalCred = await p.employeePortalCredential.findFirst({
    where: { employeeId: LISE_EMP },
  });

  // 5. Emails on any onboarding invitation
  out.chrisInvitations = await p.employeeOnboardingInvitation.findMany({
    where: { employeeId: CHRIS_EMP },
    select: { id: true, createdAt: true },
  });
  out.liseInvitations = await p.employeeOnboardingInvitation.findMany({
    where: { employeeId: LISE_EMP },
    select: { id: true, createdAt: true },
  });

  // 6. Are those email values used by any *other* Employee row?
  out.otherEmployeesWithChrisEmail = await p.employee.count({
    where: { OR: [{ email: CHRIS_PORTAL_EMAIL }, { personalEmail: CHRIS_PORTAL_EMAIL }], id: { not: CHRIS_EMP } },
  });
  out.otherEmployeesWithLiseEmail = await p.employee.count({
    where: { OR: [{ email: LISE_PORTAL_EMAIL }, { personalEmail: LISE_PORTAL_EMAIL }], id: { not: LISE_EMP } },
  });

  // 7. FK dependency scan — every counter for Chris and Lise
  const counts = {};
  const empIds = [CHRIS_EMP, LISE_EMP];
  const models = [
    "employeeCompensation", "employeeBankAccount", "employeeSensitiveIdentity", "employeeTaxProfile",
    "employeeAllowance", "employeeRecurringPayrollComponent",
    "employeeCredential", "employeeEmergencyContact", "employeeDocument",
    "employeeOnboardingInvitation", "employeeOnboardingAcknowledgement", "employeeOnboardingCorrection",
    "employeeOnboardingSession", "employeePortalCredential", "employeePortalPasswordReset",
    "employeeAvailabilityWeek", "employeeAvailabilityProfile",
    "employeeEmploymentAssignment", "employmentPeriod",
    "employeeCppElection", "employeeCppDisability",
    "trainingAssignment", "trainingProgress", "trainingAttempt", "trainingCompletion",
    "shiftAssignment", "claimedShiftOpportunity",
    "payrollTimesheet", "payrollApprovedTimeEntry", "payrollTimeAdjustment", "timeClockCorrectionRequest",
    "payrollPayGroupMember", "payrollOpeningBalance",
    "payrollBatchEmployee", "payrollBatchEarning", "payrollBatchDeduction", "payrollBatchException",
    "payrollBatchAllowanceSnapshot", "payrollBatchComponentSnapshot",
  ];
  for (const m of models) {
    try {
      counts[m] = await p[m].count({ where: { employeeId: { in: empIds } } });
    } catch (e) {
      counts[m] = `?err:${e.message.split("\n")[0].slice(0, 80)}`;
    }
  }
  out.dependencyCounts = counts;

  // 8. Batch participation specifically on the immutable POSTED batch
  out.chrisOnPostedBatch = await p.payrollBatchEmployee.count({
    where: { employeeId: CHRIS_EMP, batchId: "cmtzxy7f30006rm2s31rcv8rp" },
  });
  out.liseOnPostedBatch = await p.payrollBatchEmployee.count({
    where: { employeeId: LISE_EMP, batchId: "cmtzxy7f30006rm2s31rcv8rp" },
  });

  // 9. Payroll audit trail — do Chris/Lise appear in any journal-linked audit?
  out.auditsMentioningChris = await p.auditLog.count({
    where: {
      OR: [
        { entityType: "Employee", entityId: CHRIS_EMP },
        { userId: null, afterJson: { path: ["employeeId"], equals: CHRIS_EMP } },
      ],
    },
  }).catch(() => "?err");

  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
