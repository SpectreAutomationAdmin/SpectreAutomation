// EP-TRAIN-4Y-BF §1 — provision the dedicated automated-test principal
// for Safety & Training on STAGING.
//
// Automated browser tests must never run as a real person's account:
// everything this account touches is processed as NON-BILLABLE by the
// server (see src/lib/hr/training/generation/test-execution-identity.ts),
// and that only works if nobody real ever uses it.
//
// What it does (idempotent):
//   - upserts ONE synthetic user with a fixed id, so the id can be
//     listed in TRAINING_TEST_PRINCIPAL_USER_IDS in the staging config;
//   - grants it CLUB_ADMIN on ONE club (the club that owns
//     ANCHOR_COURSE_ID) — the only club role that can create a course
//     and upload a video, i.e. exactly what a club manager is;
//   - sets its password from a bcrypt HASH supplied by the caller. The
//     plaintext is generated on the operator's machine and never leaves
//     it.
//
// It refuses to run against an existing user that is not this
// synthetic account.
//
// Run on staging (from the repo root), never on production:
//   B64=$(base64 -w0 scripts/ep-train-4y-bf-provision-test-principal.mjs)
//   flyctl ssh console -a spectre-staging -C "sh -c 'echo $B64 | base64 -d > /app/p.mjs \
//     && cd /app && ANCHOR_COURSE_ID=... PASSWORD_HASH_B64=... CONFIRM=write node p.mjs; rm -f p.mjs'"

import { PrismaClient } from "@prisma/client";

const USER_ID = "e2e-training-test-principal-01";
const EMAIL = "e2e-training-test@example.test";
const NAME = "E2E Test Account (automated - do not use)";
const ROLE = "CLUB_ADMIN";

const prisma = new PrismaClient();

async function main() {
  const anchorCourseId = process.env.ANCHOR_COURSE_ID ?? "";
  const hashB64 = process.env.PASSWORD_HASH_B64 ?? "";
  const write = process.env.CONFIRM === "write";
  if (!anchorCourseId) throw new Error("ANCHOR_COURSE_ID is required.");
  const passwordHash = Buffer.from(hashB64, "base64").toString("utf8");
  if (!/^\$2[aby]\$\d{2}\$.{53}$/.test(passwordHash)) {
    throw new Error("PASSWORD_HASH_B64 must be the base64 of a bcrypt hash.");
  }
  if (/prod/i.test(process.env.FLY_APP_NAME ?? "") || !/staging/i.test(process.env.FLY_APP_NAME ?? "")) {
    throw new Error(`Refusing to run outside staging (FLY_APP_NAME=${process.env.FLY_APP_NAME ?? "unset"}).`);
  }

  const course = await prisma.trainingCourse.findUnique({
    where: { id: anchorCourseId },
    select: { clubId: true },
  });
  if (!course) throw new Error("Anchor course not found.");
  const clubId = course.clubId;

  const role = await prisma.role.findUnique({ where: { key: ROLE }, select: { key: true } });
  if (!role) throw new Error(`Role ${ROLE} is not registered.`);

  const byId = await prisma.user.findUnique({ where: { id: USER_ID }, select: { id: true, email: true } });
  const byEmail = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (byEmail && byEmail.id !== USER_ID) {
    throw new Error("A different user already owns the test e-mail address. Not touching it.");
  }
  if (byId && byId.email !== EMAIL) {
    throw new Error("The fixed test id belongs to a different account. Not touching it.");
  }

  console.log("PLAN", JSON.stringify({ userId: USER_ID, email: EMAIL, clubId, role: ROLE, exists: !!byId, write }));
  if (!write) {
    console.log("Dry run. Set CONFIRM=write to apply.");
    return;
  }

  await prisma.user.upsert({
    where: { id: USER_ID },
    create: {
      id: USER_ID,
      name: NAME,
      email: EMAIL,
      // Legacy column; the authoritative grant is the UserClubRole row.
      role: "STAFF",
      status: "ACTIVE",
      clubId,
      passwordHash,
      emailVerifiedAt: new Date(),
    },
    update: { name: NAME, status: "ACTIVE", clubId, passwordHash, failedLoginCount: 0, lockedUntil: null },
  });
  const grant = await prisma.userClubRole.findFirst({
    where: { userId: USER_ID, clubId, roleKey: ROLE },
    select: { id: true },
  });
  if (!grant) await prisma.userClubRole.create({ data: { userId: USER_ID, clubId, roleKey: ROLE } });
  const strays = await prisma.userClubRole.findMany({
    where: { userId: USER_ID, NOT: { clubId, roleKey: ROLE } },
    select: { id: true, clubId: true, roleKey: true },
  });
  await prisma.auditLog.create({
    data: {
      clubId,
      userId: null,
      action: "hr.training.test_principal.provision",
      entityType: "User",
      entityId: USER_ID,
      afterJson: JSON.stringify({ email: EMAIL, role: ROLE, purpose: "automated Safety & Training tests (non-billable)" }),
    },
  });
  console.log("DONE", JSON.stringify({ userId: USER_ID, clubId, role: ROLE, otherGrants: strays }));
}

main()
  .catch((err) => {
    console.error("FAILED", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
