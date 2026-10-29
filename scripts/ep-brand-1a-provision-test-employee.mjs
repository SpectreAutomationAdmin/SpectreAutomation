// EP-BRAND-1A (2026-10-29) -- short-TTL synthetic test employee for
// authenticated Employee Portal visual-parity screenshots.
//
// Follows the M4-INT-C synthetic-identity precedent: idempotent
// create, bcrypt(rounds=4) credential, 60-minute expiration marker
// in `lastName`, teardown script restores the baseline.
//
// Login path required state:
//   - Employee.status = "ACTIVE"
//   - Employee.employeeLifecycle = "ACTIVE"
//   - Employee.personalEmail = <known test email>
//   - EmployeePortalCredential.passwordHash present
//   - personalEmail must NOT collide with existing employees
//     (verifyPortalPasswordByEmail returns ambiguous_across_clubs)

import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const prisma = new PrismaClient();

const SIXTY_MIN_MS = 60 * 60 * 1000;
const PERSONAL_EMAIL = "epb1a-test@spectre.test";
const EMPLOYEE_NUMBER_PREFIX = "EPB1A-";
const FIRST_NAME = "EPB1A";

async function main() {
  const bcryptModule = await import("bcryptjs");
  const bcrypt = bcryptModule.default ?? bcryptModule;

  const windowStart = new Date();
  const windowExpire = new Date(windowStart.getTime() + SIXTY_MIN_MS);
  const expiresMarker = windowExpire.toISOString();

  // Pick a staging club.  Any ACTIVE club will work; prefer Coulee
  // Ridge because that's where the real employees live and the hostname
  // scope matches.
  const club = await prisma.club.findFirst({
    where: { name: { contains: "Coulee" } },
    select: { id: true, name: true },
  });
  if (!club) throw new Error("No Coulee Ridge club on staging; cannot provision test employee.");

  // Idempotent reuse: if a prior EPB1A row exists on this club, reset
  // its password instead of creating a duplicate.
  let employee = await prisma.employee.findFirst({
    where: { clubId: club.id, personalEmail: PERSONAL_EMAIL },
    select: { id: true },
  });

  const password = "EPB1A!" + randomBytes(24).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 4);

  if (employee) {
    await prisma.employee.update({
      where: { id: employee.id },
      data: {
        status: "ACTIVE",
        employeeLifecycle: "ACTIVE",
        firstName: FIRST_NAME,
        lastName: `TestEmployee (expires ${expiresMarker})`,
      },
    });
    await prisma.employeePortalCredential.upsert({
      where: { employeeId: employee.id },
      update: {
        passwordHash,
        passwordUpdatedAt: new Date(),
        failedAttemptCount: 0,
        lockedUntil: null,
      },
      create: {
        clubId: club.id,
        employeeId: employee.id,
        passwordHash,
      },
    });
  } else {
    // employeeNumber must be unique per club -- use a timestamp suffix.
    const employeeNumber = `${EMPLOYEE_NUMBER_PREFIX}${Date.now().toString().slice(-8)}`;
    const created = await prisma.employee.create({
      data: {
        clubId: club.id,
        employeeNumber,
        firstName: FIRST_NAME,
        lastName: `TestEmployee (expires ${expiresMarker})`,
        personalEmail: PERSONAL_EMAIL,
        status: "ACTIVE",
        employeeLifecycle: "ACTIVE",
        activatedAt: new Date(),
      },
      select: { id: true },
    });
    employee = created;
    await prisma.employeePortalCredential.create({
      data: {
        clubId: club.id,
        employeeId: created.id,
        passwordHash,
      },
    });
  }

  const envelope = {
    sliceId: "ep-brand-1a",
    createdAt: windowStart.toISOString(),
    expiresAt: windowExpire.toISOString(),
    windowMinutes: 60,
    clubId: club.id,
    clubName: club.name,
    employee: {
      employeeIdTail: employee.id.slice(-6),
      personalEmail: PERSONAL_EMAIL,
      password,
    },
  };
  writeFileSync("/tmp/ep-brand-1a-creds.json", JSON.stringify(envelope, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({
    ok: true,
    sliceId: "ep-brand-1a",
    createdAt: windowStart.toISOString(),
    expiresAt: windowExpire.toISOString(),
    clubName: club.name,
    employeeIdTail: employee.id.slice(-6),
    personalEmail: PERSONAL_EMAIL,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error("provision failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
