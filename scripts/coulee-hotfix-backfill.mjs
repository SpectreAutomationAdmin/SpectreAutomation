// Hotfix backfill (2026-09-13):
//   1. Create a canonical Employee record for Chris (first-user link).
//   2. Link Chris's UserClubProfile.employeeId → Chris Employee.
//   3. Ensure Marc Maldiney's Employee.orgPositionId points at the
//      canonical "Payroll Administrator" Position (if missing).
//   4. Ensure every existing Coulee Employee with a legacy positionId
//      also has orgPositionId populated by a name-match against
//      OrganizationalPosition. Non-destructive.
//
// Idempotent — safe to re-run.

import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const COULEE = "cmrvdeny7000144372ktmmg9c";
const CHRIS_USER = "cmrvdenz700034437agp7gqs5";

async function main() {
  console.log("== Coulee hotfix backfill ==");

  // 1. Ensure Chris Employee exists + is linked to his UserClubProfile.
  const chrisProfile = await p.userClubProfile.findFirstOrThrow({
    where: { clubId: COULEE, userId: CHRIS_USER },
    select: { id: true, employeeId: true, positionId: true, departmentId: true },
  });
  const admin = await p.department.findFirstOrThrow({
    where: { clubId: COULEE, code: "ADMIN" }, select: { id: true },
  }).catch(async () => {
    return p.department.findFirstOrThrow({
      where: { clubId: COULEE, name: { contains: "Administration" } }, select: { id: true },
    });
  });
  const controllerPos = await p.organizationalPosition.findFirstOrThrow({
    where: { clubId: COULEE, code: "CONTROLLER" }, select: { id: true },
  });

  // Post-v389 provenance hotfix (2026-09-13): first-user Employee data must
  // come from the same-human User row, NEVER from a hardcoded string or a
  // similarly-named historical Employee. Chris's Employee.personalEmail
  // now derives from Chris's User.email (`cturcato@spectreautomation.com`),
  // which is the founder-authorised identity for the first-user Employee.
  const chrisUser = await p.user.findUniqueOrThrow({
    where: { id: CHRIS_USER },
    select: { email: true, name: true },
  });
  const derivedPersonalEmail = chrisUser.email?.trim().toLowerCase() ?? null;

  let chrisEmp;
  if (chrisProfile.employeeId) {
    chrisEmp = await p.employee.findUniqueOrThrow({
      where: { id: chrisProfile.employeeId },
      select: { id: true, orgPositionId: true, departmentId: true, employeeLifecycle: true, personalEmail: true },
    });
    console.log(`Chris Employee already linked: ${chrisEmp.id}`);
  } else {
    // Find existing Chris Employee by firstName+lastName within THIS
    // tenant. We never match by email against unrelated historical rows.
    chrisEmp = await p.employee.findFirst({
      where: {
        clubId: COULEE,
        firstName: "Chris", lastName: "Turcato",
      },
      select: { id: true, orgPositionId: true, departmentId: true, employeeLifecycle: true, personalEmail: true },
    });
    if (!chrisEmp) {
      // Create a clean canonical first-user Employee. Allocator is
      // MAX-of-numeric-suffix + 1 — matches src/lib/hr/employees.ts
      // nextEmployeeNumber. Gap-safe after any prior deletion.
      const rows = await p.employee.findMany({
        where: { clubId: COULEE, employeeNumber: { startsWith: "E-" } },
        select: { employeeNumber: true },
      });
      let max = 0;
      for (const r of rows) {
        const m = /^E-(\d+)$/.exec(r.employeeNumber ?? "");
        if (m) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n) && n > max) max = n;
        }
      }
      const employeeNumber = `E-${(max + 1).toString().padStart(5, "0")}`;
      chrisEmp = await p.employee.create({
        data: {
          clubId: COULEE,
          employeeNumber,
          firstName: "Chris", lastName: "Turcato",
          // Derived from the same-human User row — never a hardcoded
          // literal. If User.email is missing, personalEmail stays null
          // (per founder rule: "if a value is unknown, leave it null").
          personalEmail: derivedPersonalEmail,
          orgPositionId: controllerPos.id,
          departmentId: admin.id,
          employmentType: "FULL_TIME",
          employeeLifecycle: "ACTIVE",
          onboardingState: "APPROVED",
          payrollReadiness: "NOT_READY",
          compensationType: "SALARY",
          status: "ACTIVE",
        },
        select: { id: true, orgPositionId: true, departmentId: true, employeeLifecycle: true, personalEmail: true },
      });
      console.log(`Chris Employee created: ${chrisEmp.id} (personalEmail=${derivedPersonalEmail ?? "(null)"})`);
    } else {
      console.log(`Chris Employee found (unlinked): ${chrisEmp.id}`);
    }
    // Link Chris's UserClubProfile → Employee.
    await p.userClubProfile.update({
      where: { id: chrisProfile.id },
      data: { employeeId: chrisEmp.id },
    });
    console.log("Chris UserClubProfile.employeeId linked.");
  }

  // Post-v389 provenance hotfix (2026-09-13): correct any prior Chris
  // Employee row whose personalEmail was set to the hardcoded
  // "c.s.turcato@gmail.com" string. The authorised value is the same-human
  // User.email (`cturcato@spectreautomation.com`). Only rewrites if
  // (a) the current value differs, AND (b) a derivedPersonalEmail exists.
  if (
    derivedPersonalEmail &&
    chrisEmp.personalEmail !== derivedPersonalEmail
  ) {
    await p.employee.update({
      where: { id: chrisEmp.id },
      data: { personalEmail: derivedPersonalEmail },
    });
    console.log(
      `Chris Employee.personalEmail corrected: ${chrisEmp.personalEmail ?? "(null)"} → ${derivedPersonalEmail}`,
    );
    chrisEmp.personalEmail = derivedPersonalEmail;
  }

  // 2. Backfill Chris's canonical position/department if the row exists
  //    but is missing them.
  if (!chrisEmp.orgPositionId) {
    await p.employee.update({
      where: { id: chrisEmp.id },
      data: { orgPositionId: controllerPos.id },
    });
    console.log("Chris orgPositionId set to Controller / CFO.");
  }
  if (!chrisEmp.departmentId) {
    await p.employee.update({
      where: { id: chrisEmp.id },
      data: { departmentId: admin.id },
    });
    console.log("Chris departmentId set to Administration.");
  }

  // 3. Backfill orgPositionId for any existing Employee (Marc etc.) by
  //    matching legacy Employee.position.name → OrganizationalPosition.name
  //    (case-insensitive), only when orgPositionId is currently null.
  const orphaned = await p.employee.findMany({
    where: { clubId: COULEE, orgPositionId: null, NOT: { positionId: null } },
    include: { position: { select: { name: true } } },
  });
  console.log(`Employees needing orgPosition backfill: ${orphaned.length}`);
  const orgPositions = await p.organizationalPosition.findMany({
    where: { clubId: COULEE }, select: { id: true, name: true },
  });
  const orgByLowerName = new Map(orgPositions.map((op) => [op.name.toLowerCase(), op.id]));
  let backfilled = 0;
  for (const e of orphaned) {
    if (!e.position?.name) continue;
    const hit = orgByLowerName.get(e.position.name.toLowerCase());
    if (!hit) {
      console.log(`  no canonical Position match for "${e.position.name}" (employee ${e.id})`);
      continue;
    }
    await p.employee.update({ where: { id: e.id }, data: { orgPositionId: hit } });
    console.log(`  linked ${e.firstName} ${e.lastName} → ${e.position.name}`);
    backfilled++;
  }
  console.log(`orgPosition backfill complete: ${backfilled} rows`);

  // 4. Marc special-case: name-match "Marc Maldiney" and pin to
  //    Payroll Administrator if he has no canonical position yet.
  const marc = await p.employee.findFirst({
    where: { clubId: COULEE, firstName: "Marc" },
    select: { id: true, firstName: true, lastName: true, orgPositionId: true },
  });
  if (marc && !marc.orgPositionId) {
    const payrollAdminPos = await p.organizationalPosition.findFirst({
      where: { clubId: COULEE, code: "PAYROLL_ADMINISTRATOR" },
      select: { id: true },
    });
    if (payrollAdminPos) {
      await p.employee.update({
        where: { id: marc.id },
        data: { orgPositionId: payrollAdminPos.id },
      });
      console.log(`Marc ${marc.lastName} → Payroll Administrator (canonical)`);
    }
  } else if (marc) {
    console.log(`Marc ${marc.lastName} already has orgPositionId`);
  }

  const finalEmpCount = await p.employee.count({
    where: { clubId: COULEE, employeeLifecycle: { in: ["ACTIVE", "PRE_HIRE", "LEAVE"] } },
  });
  console.log(`\nCoulee active/pre-hire employees: ${finalEmpCount}`);
  console.log("== hotfix backfill complete ==");
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); }).finally(() => p.$disconnect());
