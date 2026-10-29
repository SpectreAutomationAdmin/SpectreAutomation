// EP-BRAND-1A (2026-10-29) -- teardown of the short-TTL synthetic
// test employee + credential provisioned by
// scripts/ep-brand-1a-provision-test-employee.mjs.
//
// Idempotent.  Deletes only the synthetic row (personalEmail
// 'epb1a-test@spectre.test').  Preserves all other employees.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const PERSONAL_EMAIL = "epb1a-test@spectre.test";

async function main() {
  const employees = await prisma.employee.findMany({
    where: { personalEmail: PERSONAL_EMAIL },
    select: { id: true, firstName: true, lastName: true, clubId: true },
  });
  const employeeIds = employees.map((e) => e.id);

  // 1. Remove portal credentials.
  const credDelete = await prisma.employeePortalCredential.deleteMany({
    where: { employeeId: { in: employeeIds } },
  });

  // 2. Remove the Employee rows.
  const empDelete = await prisma.employee.deleteMany({
    where: { id: { in: employeeIds } },
  });

  // 3. Re-enumerate to confirm clean state.
  const remainingSynthetic = await prisma.employee.findMany({
    where: { personalEmail: PERSONAL_EMAIL },
    select: { id: true },
  });

  console.log(JSON.stringify({
    ok: true,
    sliceId: "ep-brand-1a",
    teardownAt: new Date().toISOString(),
    identified: employees.map((e) => ({
      employeeIdTail: e.id.slice(-6),
      clubIdTail: e.clubId.slice(-6),
      firstName: e.firstName,
      lastName: e.lastName,
    })),
    deletedPortalCredentials: credDelete.count,
    deletedEmployees: empDelete.count,
    remainingSyntheticEmployees: remainingSynthetic.length,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error("teardown failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
