// READ-ONLY probe of users referenced by Coulee fixtures but not owned by Coulee.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const COULEE = "cmrvdeny7000144372ktmmg9c";

const referencedUserIds = [
  "cmtjc2rya0000gnju11alm8s9", // payrollClubConfig.payrollAdminUserId (post-restore)
  "cmtjc2s9d0003gnjuhbfyo6i2", // payrollClubConfig.controllerUserId (post-restore)
  "cmtyosvk000001ozuzxhh1y3i", // 3E PA fixture
  "cmtyosvmx00031ozu4x00vhve", // 3E Controller fixture
  "cmtzxwfjw00009r8kvnr8rno5", // 3F poster fixture
];

const out = {};
async function main() {
  out.referencedUsers = await p.user.findMany({
    where: { id: { in: referencedUserIds } },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      clubId: true,
      createdAt: true,
    },
  });

  // Any user with an email containing 'fixture' / '3e' / '3f' / 'spectre.test'
  out.fixtureLikeUsers = await p.user.findMany({
    where: {
      OR: [
        { email: { contains: "fixture" } },
        { email: { contains: "spectre.test" } },
        { email: { contains: ".3e@" } },
        { email: { contains: ".3f@" } },
      ],
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      clubId: true,
      createdAt: true,
    },
  });

  // FiscalYear / FiscalPeriod for Coulee (3F fixture created some)
  out.fiscalYears = await p.fiscalYear.findMany({
    where: { clubId: COULEE },
    select: { id: true, startDate: true, endDate: true, status: true },
    orderBy: { startDate: "asc" },
  });
  out.fiscalPeriods = await p.fiscalPeriod.findMany({
    where: { clubId: COULEE },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      status: true,
      fiscalYearId: true,
    },
    orderBy: { startDate: "asc" },
  });

  // Pay group members - which fixture employees are still in pay groups?
  out.payGroupMembers = await p.payrollPayGroupMember.findMany({
    where: { clubId: COULEE },
    select: {
      id: true,
      payGroupId: true,
      employeeId: true,
      effectiveFrom: true,
      effectiveTo: true,
    },
    orderBy: { effectiveFrom: "asc" },
  });

  // WorkIntake items owned/resolved by non-Coulee users
  out.payrollWorkIntakeItems = await p.workIntakeItem.findMany({
    where: {
      clubId: COULEE,
      OR: [
        { origins: { some: { kind: { startsWith: "PAYROLL_" } } } },
        { origins: { some: { kind: "SHIFT_REASSIGNMENT_NOTIFICATION" } } },
      ],
    },
    select: {
      id: true,
      status: true,
      displaySubject: true,
      resolvedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // Documents linked to any fixture employee?
  const empIds = [
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
  out.fixtureEmpDocumentCount = await p.employeeDocument.count({
    where: { employeeId: { in: empIds } },
  });
  out.fixtureEmpBatchLinesCount = await p.payrollBatchEmployee.count({
    where: { employeeId: { in: empIds } },
  });
  out.fixtureEmpAvailabilityProfileCount = await p.employeeAvailabilityProfile.count({
    where: { employeeId: { in: empIds } },
  });

  // Payroll Batch attestations tied to fixture batches
  out.payrollBatchAttestationsCount = await p.payrollBatchReviewAttestation.count({
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
