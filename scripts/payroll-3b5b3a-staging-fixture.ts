// Payroll-3B-5B-3A (2026-09-01) — synthetic staging acceptance fixture.
//
// Deterministic, idempotent, tenant-scoped. Never creates duplicate
// batches on repeated runs. Uses synthetic employees with obvious
// non-real names ("Avery Sample", "Jordan Test", etc.). No real
// SIN, banking, or TD1 information.
//
// Usage (staging):
//   npx tsx scripts/payroll-3b5b3a-staging-fixture.ts <clubId>
//
// Prerequisites on the target club:
//   • PayrollClubConfig exists with province=AB
//   • payrollAdminUserId + controllerUserId set (or they will be
//     assigned to synthetic users the script creates)
//   • CA/AB 2026 statutory packages installed (from
//     scripts/seed-payroll-statutory-ca-ab-2026.ts)

import { PrismaClient } from "@prisma/client";
import { preparePayrollBatch } from "../src/lib/payroll/batch-preparation";
import { orchestratePayrollReviewHandoff } from "../src/lib/payroll/orchestration";
import { calculatePayrollBatch } from "../src/lib/payroll/calculation-execute";
import { upsertPayrollClubConfig } from "../src/lib/payroll/club-config";
import type { Principal } from "../src/lib/rbac";
import type { RoleKey } from "../src/lib/permissions";

const prisma = new PrismaClient();
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

const FIXTURE_TAG = "payroll-3b5b3a-staging-fixture";
const PAY_GROUP_CODE = "FDR-BW";
const PAY_GROUP_NAME = "Founder Review · Biweekly";

// Deterministic pay date used for the seeded batch. Picking Mar 14
// (H1) so the calculator resolves the H1 CA/AB 2026 package.
const TARGET_PAY_DATE = utc(2026, 3, 14);

interface EmployeeSpec {
  key:  string;
  first: string;
  last:  string;
  cadence: "SALARY" | "HOURLY";
  rate:  string;
  approvedHours?: string;
  td1: {
    federalClaim: string;
    provincialClaim: string;
    claimZeroFederal?: boolean;
    additionalFederalTaxAmount?: string;
    additionalProvincialTaxAmount?: string;
  };
  allowance?: { type: string; amount: string; frequency: string; taxable: boolean; pensionable: boolean; insurable: boolean; };
  ytdOpening?: {
    priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER" | "PRIOR_EMPLOYER";
    values: Record<string, string>;
  };
  bankingVerified: boolean;   // false → banking warning
}

const EMPLOYEES: EmployeeSpec[] = [
  // §25.A — regular hourly, full-period, banking verified.
  { key: "AVERY",  first: "Avery",  last: "Sample",   cadence: "HOURLY",  rate: "25.00", approvedHours: "80",
    td1: { federalClaim: "16452", provincialClaim: "22769" }, bankingVerified: true },
  // §25.B — salaried, full-period.
  { key: "JORDAN", first: "Jordan", last: "Test",     cadence: "SALARY",  rate: "52000",
    td1: { federalClaim: "16452", provincialClaim: "22769" }, bankingVerified: true },
  // §25.C — custom TD1 claims (Scenario 2 shape).
  { key: "MORGAN", first: "Morgan", last: "Demo",     cadence: "SALARY",  rate: "52000",
    td1: { federalClaim: "20000", provincialClaim: "26000" }, bankingVerified: true },
  // §25.D — federal claim-zero (Scenario 4 shape).
  { key: "TAYLOR", first: "Taylor", last: "Fixture",  cadence: "SALARY",  rate: "52000",
    td1: { federalClaim: "0", provincialClaim: "22769", claimZeroFederal: true }, bankingVerified: true },
  // §25.E — allowance with independent statutory classification.
  { key: "RILEY",  first: "Riley",  last: "Synthetic",cadence: "SALARY",  rate: "52000",
    td1: { federalClaim: "16452", provincialClaim: "22769" }, bankingVerified: true,
    allowance: { type: "CELL_PHONE", amount: "50.00", frequency: "PER_PAY_PERIOD", taxable: true, pensionable: false, insurable: false } },
  // §25.F — same-employer YTD near CPP2 threshold (crossing YMPE).
  { key: "SAM",    first: "Sam",    last: "Prior",    cadence: "SALARY",  rate: "104000",   // $4000 biweekly
    td1: { federalClaim: "16452", provincialClaim: "22769" }, bankingVerified: true,
    ytdOpening: { priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER",
      values: { ytdGrossEarnings: "72000", ytdTaxableEarnings: "72000", ytdPensionableEarnings: "72000", ytdInsurableEarnings: "68900",
                ytdCppEE_Base: "3600", ytdCppEE_FirstAdd: "720", ytdCppEE: "4320",
                ytdCpp2EE: "0", ytdEiEE: "1123.07",
                ytdFederalTax: "0", ytdProvincialTax: "0",
                ytdCppER_Base: "3600", ytdCppER_FirstAdd: "720", ytdCppER: "4320", ytdCpp2ER: "0", ytdEiER: "1572.30" } } },
  // §25.G — banking-not-verified WARNING.
  { key: "QUINN",  first: "Quinn",  last: "Warning",  cadence: "SALARY",  rate: "52000",
    td1: { federalClaim: "16452", provincialClaim: "22769" }, bankingVerified: false },
];

async function ensureUser(email: string, name: string, role: RoleKey, clubId: string): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const link = await prisma.userClubRole.findFirst({ where: { userId: existing.id, clubId } });
    if (!link) await prisma.userClubRole.create({ data: { userId: existing.id, clubId, roleKey: role } });
    return existing.id;
  }
  const created = await prisma.user.create({
    data: { email, name, role: role as unknown as string, passwordHash: "!disabled", status: "ACTIVE" },
  });
  await prisma.userClubRole.create({ data: { userId: created.id, clubId, roleKey: role } });
  return created.id;
}

async function ensureEmployee(clubId: string, spec: EmployeeSpec): Promise<string> {
  const number = `${FIXTURE_TAG}:${spec.key}`;
  const existing = await prisma.employee.findFirst({ where: { clubId, employeeNumber: number } });
  if (existing) return existing.id;
  const emp = await prisma.employee.create({
    data: {
      clubId, firstName: spec.first, lastName: spec.last,
      email: `${spec.key.toLowerCase()}@fixture.spectre.test`,
      hireDate: utc(2026, 1, 1), dateOfBirth: utc(1990, 5, 12),
      status: "ACTIVE", employeeNumber: number,
    },
  });
  const assn = await prisma.employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId: emp.id, role: "PRIMARY",
      employmentType: "FULL_TIME", effectiveFrom: utc(2026, 1, 1),
    },
  });
  await prisma.employeeCompensation.create({
    data: {
      clubId, employeeId: emp.id, assignmentId: assn.id,
      cadence: spec.cadence, rate: spec.rate, currency: "CAD",
      effectiveFrom: utc(2026, 1, 1),
    },
  });
  if (spec.bankingVerified) {
    await prisma.employeeBankAccount.create({
      data: {
        clubId, employeeId: emp.id,
        institutionSecretRef: "fixture:not-a-secret",
        transitSecretRef: "fixture:not-a-secret",
        accountSecretRef: "fixture:not-a-secret",
        holderName: `${spec.first} ${spec.last}`,
        bankFingerprint: `fp-${spec.key}`,
        status: "VERIFIED", activatedAt: utc(2026, 1, 1),
      },
    });
  }
  await prisma.employeeTaxProfile.create({
    data: {
      clubId, employeeId: emp.id,
      province: "AB", td1FormVersion: "2026-01", effectiveFrom: utc(2026, 1, 1),
      federalClaimSecretRef:    spec.td1.federalClaim,
      provincialClaimSecretRef: spec.td1.provincialClaim,
      claimZeroFederal:            spec.td1.claimZeroFederal            ?? false,
      claimZeroProvincial:         false,
      totalIncomeLessThanClaim:    false,
      additionalFederalTaxAmount:  spec.td1.additionalFederalTaxAmount  ?? "0",
      additionalProvincialTaxAmount: spec.td1.additionalProvincialTaxAmount ?? "0",
    },
  });
  if (spec.allowance) {
    await prisma.employeeAllowance.create({
      data: {
        clubId, employeeId: emp.id, assignmentId: assn.id,
        allowanceType: spec.allowance.type, amount: spec.allowance.amount, frequency: spec.allowance.frequency,
        taxable: spec.allowance.taxable, pensionable: spec.allowance.pensionable, insurable: spec.allowance.insurable,
        effectiveFrom: utc(2026, 1, 1),
      },
    });
  }
  return emp.id;
}

async function ensurePayGroup(clubId: string): Promise<string> {
  const existing = await prisma.payrollPayGroup.findFirst({ where: { clubId, code: PAY_GROUP_CODE } });
  if (existing) return existing.id;
  const pg = await prisma.payrollPayGroup.create({
    data: {
      clubId, code: PAY_GROUP_CODE, name: PAY_GROUP_NAME,
      payFrequency: "BIWEEKLY", payDateOffsetDays: 0,
      calendarAnchorDate: utc(2026, 1, 4),
    },
  });
  return pg.id;
}

async function ensureFullYearBiweeklyCalendar(clubId: string, pgId: string): Promise<string> {
  // 26 biweekly periods for 2026. Pay date = period end. Idempotent.
  const yearStart = utc(2026, 1, 4);
  let targetId: string | null = null;
  for (let seq = 1; seq <= 26; seq++) {
    const start = new Date(yearStart.getTime() + (seq - 1) * 14 * 86400_000);
    const end   = new Date(start.getTime() + 13 * 86400_000);
    const pDate = end;
    const existing = await prisma.payrollPayPeriod.findFirst({
      where: { clubId, payGroupId: pgId, taxYear: 2026, sequenceInYear: seq },
    });
    const row = existing ?? await prisma.payrollPayPeriod.create({
      data: {
        clubId, payGroupId: pgId, sequenceInYear: seq, taxYear: 2026,
        periodStart: start, periodEnd: end, payDate: pDate,
      },
    });
    if (Math.abs(pDate.getTime() - TARGET_PAY_DATE.getTime()) < 86400_000) targetId = row.id;
  }
  if (!targetId) throw new Error("Target pay period not found in seeded calendar");
  return targetId;
}

async function main() {
  const clubId = process.argv[2];
  if (!clubId) throw new Error("usage: npx tsx scripts/payroll-3b5b3a-staging-fixture.ts <clubId>");
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { id: true, name: true } });
  if (!club) throw new Error(`club not found: ${clubId}`);
  console.log(`Fixture target: ${club.name} (${club.id})`);

  // Fixture-owned Payroll Admin + Controller. Both marked ACTIVE
  // and role-linked to the club. Never use real staff.
  const paId = await ensureUser("fixture.pa@spectre.test", "Fixture Payroll Admin", "PAYROLL_ADMIN", clubId);
  const ctlId = await ensureUser("fixture.controller@spectre.test", "Fixture Controller", "CONTROLLER", clubId);

  // Resolve an authorized principal to run the fixture. Prefer a
  // SUPER_ADMIN (platform-scoped); otherwise fall back to a
  // CLUB_ADMIN on the target club (CLUB_ADMIN holds payroll:run +
  // payroll:config:write which are the two permissions we need).
  let authUser = await prisma.user.findFirst({
    where: { role: "SUPER_ADMIN" }, include: { clubRoles: true },
  });
  if (!authUser) {
    const clubAdminLink = await prisma.userClubRole.findFirst({
      where: { clubId, roleKey: "CLUB_ADMIN" },
      include: { user: { include: { clubRoles: true } } },
    });
    if (!clubAdminLink) {
      throw new Error(`no SUPER_ADMIN and no CLUB_ADMIN on club ${clubId}; cannot run fixture`);
    }
    authUser = clubAdminLink.user;
  }
  const principal: Principal = {
    id: authUser.id, name: authUser.name, email: authUser.email,
    status: authUser.status,
    memberships: authUser.clubRoles.map((r) => ({ clubId: r.clubId, roleKey: r.roleKey as RoleKey })),
    activeClubId: null, memberId: null,
  };

  await upsertPayrollClubConfig(principal, clubId, {
    provinceOfEmployment: "AB", payrollAdminUserId: paId, controllerUserId: ctlId,
  });

  const pgId = await ensurePayGroup(clubId);
  const payPeriodId = await ensureFullYearBiweeklyCalendar(clubId, pgId);

  for (const spec of EMPLOYEES) {
    const empId = await ensureEmployee(clubId, spec);
    const memberExists = await prisma.payrollPayGroupMember.findFirst({
      where: { clubId, payGroupId: pgId, employeeId: empId },
    });
    if (!memberExists) {
      await prisma.payrollPayGroupMember.create({
        data: { clubId, payGroupId: pgId, employeeId: empId, effectiveFrom: utc(2026, 1, 1) },
      });
    }
    if (spec.ytdOpening) {
      const already = await prisma.payrollOpeningBalance.findFirst({
        where: { clubId, employeeId: empId, taxYear: 2026, status: "ACTIVE" },
      });
      if (!already) {
        const draft = await prisma.payrollOpeningBalance.create({
          data: {
            clubId, employeeId: empId, taxYear: 2026,
            status: "ACTIVE", throughPayDate: utc(2026, 3, 1),
            activatedAt: new Date(), activatedByUserId: principal.id,
            importSource: "MANUAL",
            priorPayrollKind: spec.ytdOpening.priorPayrollKind,
            ...spec.ytdOpening.values,
          } as any,
        });
        console.log(`  opening balance for ${spec.key} (${draft.id})`);
      }
    }
  }

  // Prepare and CALCULATE the batch. Idempotent — reruns produce
  // the same result and rewind the same PAYROLL_FINAL_APPROVAL card.
  const active = await prisma.payrollBatch.findFirst({
    where: { clubId, payPeriodId, status: { not: "VOIDED" } },
  });
  let batchId: string;
  if (active) {
    batchId = active.id;
    console.log(`  reusing existing batch ${batchId} (${active.status})`);
  } else {
    const prepared = await preparePayrollBatch(principal, clubId, payPeriodId);
    batchId = prepared.batchId;
    console.log(`  prepared new batch ${batchId} (${prepared.status})`);
  }
  await orchestratePayrollReviewHandoff(principal, clubId, payPeriodId, batchId);

  // Attach SALARY earning rows for every employee if not already
  // present. Idempotent.
  const bes = await prisma.payrollBatchEmployee.findMany({ where: { batchId } });
  for (const be of bes) {
    const spec = EMPLOYEES.find((s) => s.first === "Avery" ? be.employeeId : true);
    const emp = await prisma.employee.findUnique({ where: { id: be.employeeId } });
    if (!emp) continue;
    const matchingSpec = EMPLOYEES.find((s) => emp.employeeNumber === `${FIXTURE_TAG}:${s.key}`);
    if (!matchingSpec) continue;
    const hasRow = await prisma.payrollBatchEarning.findFirst({
      where: { batchId, batchEmployeeId: be.id, earningType: "SALARY" },
    });
    if (hasRow) continue;
    if (matchingSpec.cadence === "SALARY") {
      const perPeriod = (Number(matchingSpec.rate) / 26).toFixed(2);
      await prisma.payrollBatchEarning.create({
        data: {
          clubId, batchId, batchEmployeeId: be.id, employeeId: be.employeeId,
          earningType: "SALARY", quantity: "1", rate: perPeriod, rateSource: "MANUAL",
        },
      });
    } else {
      // HOURLY: attach one REGULAR row using approvedHoursSnapshot × rate.
      const hours = matchingSpec.approvedHours ?? "80";
      await prisma.payrollBatchEarning.create({
        data: {
          clubId, batchId, batchEmployeeId: be.id, employeeId: be.employeeId,
          earningType: "REGULAR", quantity: hours, rate: matchingSpec.rate, rateSource: "MANUAL",
        },
      });
    }
  }
  // Also: update approvedHoursSnapshot for the hourly employee so
  // readiness reports valid hours for the row-detail view.
  const hourlyEmp = EMPLOYEES.find((s) => s.cadence === "HOURLY");
  if (hourlyEmp) {
    const empRow = await prisma.employee.findFirst({ where: { clubId, employeeNumber: `${FIXTURE_TAG}:${hourlyEmp.key}` } });
    if (empRow) {
      await prisma.payrollBatchEmployee.updateMany({
        where: { batchId, employeeId: empRow.id },
        data: { approvedHoursSnapshot: hourlyEmp.approvedHours ?? "80" },
      });
    }
  }

  const r = await calculatePayrollBatch(principal, clubId, batchId);
  console.log(`  calculated batch ${batchId}: persisted=${r.persisted} lifecycle=${r.lifecycleStatus} version=${r.calculationVersion}`);
  console.log(`  review URL: /app/admin/payroll/batches/${batchId}`);
  console.log(`  process URL: /app/admin/payroll/process?batchId=${batchId}&payPeriodId=${payPeriodId}`);
  console.log("Fixture complete.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
