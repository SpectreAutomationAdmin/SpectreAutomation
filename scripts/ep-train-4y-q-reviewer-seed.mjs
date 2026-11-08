// EP-TRAIN-4Y-Q §6 — seed a disposable TRAINING_AI_REVIEWER user on
// staging so the acceptance Playwright can drive attestation +
// revalidate + approve + reject + promote end-to-end without
// granting reviewer permission to the founder account.
//
// Idempotent: a prior run's user is reused if its email + club
// membership still exist. The password is ALWAYS regenerated on each
// run and printed to stdout for the Playwright spec to capture.
//
// Cleanup: run `scripts/ep-train-4y-q-reviewer-cleanup.mjs` to drop
// the membership (preserving audit history of actions the reviewer
// took on real drafts).
//
// Usage on staging:
//   flyctl ssh console -a spectre-staging -C \
//     "sh -c 'cat > /tmp/seed.mjs && node /tmp/seed.mjs'" \
//     < scripts/ep-train-4y-q-reviewer-seed.mjs

import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
import { randomBytes } from "node:crypto";
import bcrypt from "/app/node_modules/bcryptjs/index.js";

const prisma = new PrismaClient();
const CLUB_ID = "cmrvdeny7000144372ktmmg9c"; // Coulee Ridge staging tenant
const REVIEWER_EMAIL = "4yq-reviewer@spectre.test";

async function main() {
  // Ensure the TRAINING_AI_REVIEWER role exists in the catalog.
  const role = await prisma.role.findUnique({ where: { key: "TRAINING_AI_REVIEWER" } });
  if (!role) {
    throw new Error("TRAINING_AI_REVIEWER role not found — sync-rbac.ts must have run during the deploy.");
  }

  // Password: 32-char hex (ample for Playwright + no login UX).
  const password = randomBytes(16).toString("hex");
  const passwordHash = await bcrypt.hash(password, 10);

  // Upsert the user (idempotent).
  let user = await prisma.user.findFirst({ where: { email: REVIEWER_EMAIL } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: REVIEWER_EMAIL,
        name: "EP-TRAIN-4Y-Q Reviewer",
        passwordHash,
      },
    });
  } else {
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
  }

  // Grant TRAINING_AI_REVIEWER role on the staging club (idempotent).
  const existingMembership = await prisma.userClubRole.findFirst({
    where: {
      userId: user.id,
      clubId: CLUB_ID,
      roleKey: "TRAINING_AI_REVIEWER",
    },
    select: { id: true },
  });
  if (!existingMembership) {
    await prisma.userClubRole.create({
      data: {
        userId: user.id,
        clubId: CLUB_ID,
        roleKey: "TRAINING_AI_REVIEWER",
      },
    });
  }

  console.log("SEED_RESULT:" + JSON.stringify({
    ok: true,
    email: REVIEWER_EMAIL,
    password,
    userId: user.id,
    clubId: CLUB_ID,
    roleKey: "TRAINING_AI_REVIEWER",
  }));
}

main()
  .catch((err) => { console.error("FATAL:", err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
