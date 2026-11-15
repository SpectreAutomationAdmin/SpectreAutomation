// EP-TRAIN-4Y-BF — deactivate the automated-test principal on STAGING and
// cut off every session it has.
//
// Founder instruction: the robot account exists only for the duration of
// an acceptance run. After the run:
//   - status → DISABLED. Sessions here are stateless cookies that are
//     re-validated against the user row on EVERY request (the session
//     loader refuses any user that is not ACTIVE), so this ends all of
//     its sessions immediately, on every device;
//   - its role grants are removed (no club access even if re-enabled);
//   - its password hash is replaced with an unusable value (the stored
//     password stops working);
//   - any trusted-device / MFA / recovery records are removed.
// The user row itself is kept so the audit trail of the test run still
// resolves to a named account. Courses it created stay non-billable.
//
// Idempotent. Refuses to touch any account other than the fixed
// synthetic one.
//
//   B64=$(base64 -w0 scripts/ep-train-4y-bf-deactivate-test-principal.mjs)
//   flyctl ssh console -a spectre-staging -C "sh -c 'echo $B64 | base64 -d > /app/d.mjs \
//     && cd /app && CONFIRM=write node d.mjs; rm -f d.mjs'"

import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";

const USER_ID = "e2e-training-test-principal-01";
const EMAIL = "e2e-training-test@example.test";

const prisma = new PrismaClient();

async function main() {
  const write = process.env.CONFIRM === "write";
  if (!/staging/i.test(process.env.FLY_APP_NAME ?? "")) {
    throw new Error(`Refusing to run outside staging (FLY_APP_NAME=${process.env.FLY_APP_NAME ?? "unset"}).`);
  }
  const user = await prisma.user.findUnique({
    where: { id: USER_ID },
    select: { id: true, email: true, status: true, clubId: true, clubRoles: { select: { id: true, clubId: true, roleKey: true } } },
  });
  if (!user) {
    console.log("NOTHING_TO_DO", JSON.stringify({ userId: USER_ID, exists: false }));
    return;
  }
  if (user.email !== EMAIL) throw new Error("The fixed test id belongs to a different account. Not touching it.");

  console.log("BEFORE", JSON.stringify({ status: user.status, grants: user.clubRoles.map((r) => `${r.roleKey}@${r.clubId}`), write }));
  if (!write) {
    console.log("Dry run. Set CONFIRM=write to apply.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.userClubRole.deleteMany({ where: { userId: USER_ID } });
    await tx.trustedDevice.deleteMany({ where: { userId: USER_ID } });
    await tx.recoveryCode.deleteMany({ where: { userId: USER_ID } });
    await tx.mfaFactor.deleteMany({ where: { userId: USER_ID } });
    await tx.user.update({
      where: { id: USER_ID },
      data: {
        status: "DISABLED",
        // Not a bcrypt hash: no password can ever match it.
        passwordHash: `disabled:${randomBytes(24).toString("hex")}`,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    await tx.auditLog.create({
      data: {
        clubId: user.clubId,
        userId: null,
        action: "hr.training.test_principal.deactivate",
        entityType: "User",
        entityId: USER_ID,
        afterJson: JSON.stringify({
          status: "DISABLED",
          grantsRemoved: user.clubRoles.length,
          sessions: "revoked (non-ACTIVE users are refused on every request)",
        }),
      },
    });
  });

  const after = await prisma.user.findUnique({
    where: { id: USER_ID },
    select: { status: true, clubRoles: { select: { id: true } } },
  });
  console.log("AFTER", JSON.stringify({ status: after?.status, grants: after?.clubRoles.length ?? 0 }));
}

main()
  .catch((err) => {
    console.error("FAILED", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
