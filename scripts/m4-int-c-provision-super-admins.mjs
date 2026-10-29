// SIGNUP-2 M4-INT-C (2026-10-29) — Option C synthetic SUPER_ADMIN
// provisioner for the authorized 2-hour acceptance window.
//
// Creates (or re-creates) TWO staging-only platform SUPER_ADMIN
// identities per founder M4-INT-C §1-§2:
//
//   Operator A: platform-admin-m4intc-a@spectreautomation.com
//   Operator B: platform-admin-m4intc-b@spectreautomation.com
//
// Follows the Phase 2D fixture precedent exactly (prisma.user.create
// + prisma.userClubRole.create with clubId=null, roleKey=SUPER_ADMIN).
// Uses bcrypt(rounds=4) because this is a time-boxed TEST fixture;
// does not weaken the production password policy.
//
// Credential handling:
//   - Generates ONE strong unique password per operator at provision time.
//   - Writes the resulting credentials to a JSON file at
//     /tmp/m4-int-c-creds.json inside the Fly container.  The Fly SSH
//     caller reads that file over the ssh channel + writes it to the
//     local .env.playwright.local.
//   - Does NOT echo passwords in container stdout beyond that file.
//
// Expiration:
//   - Both user rows carry an explicit expiration marker in `name`
//     (e.g. "M4 Acceptance Operator A - expires 2026-10-29T13:45:00Z")
//     so teardown + enumeration both see when they should disappear.

import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const prisma = new PrismaClient();

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

const OPS = [
  {
    key: "A",
    email: "platform-admin-m4intc-a@spectreautomation.com",
    baseName: "M4 Acceptance Operator A",
  },
  {
    key: "B",
    email: "platform-admin-m4intc-b@spectreautomation.com",
    baseName: "M4 Acceptance Operator B",
  },
];

function randomPassword() {
  // 24 raw bytes -> 32-char base64url, then prepend a marker so
  // visual inspection confirms the strength shape.
  return "M4intc!" + randomBytes(24).toString("base64url");
}

async function main() {
  const bcryptModule = await import("bcryptjs");
  const bcrypt = bcryptModule.default ?? bcryptModule;

  const windowStart = new Date();
  const windowExpire = new Date(windowStart.getTime() + TWO_HOURS_MS);

  const results = [];

  for (const op of OPS) {
    // Idempotent re-provision: if an identity exists for this email,
    // reuse it (do NOT delete + recreate -- that would churn the user
    // id + any orphaned sessions).  Reset password only.
    let user = await prisma.user.findUnique({
      where: { email: op.email },
      select: { id: true, email: true, name: true, role: true, status: true },
    });

    const password = randomPassword();
    const passwordHash = await bcrypt.hash(password, 4);
    const expiresMarker = windowExpire.toISOString();
    const fullName = `${op.baseName} - expires ${expiresMarker}`;

    if (user) {
      // Reuse existing synthetic row -- rotate password + refresh name.
      await prisma.user.update({
        where: { id: user.id },
        data: {
          name: fullName,
          role: "SUPER_ADMIN",
          passwordHash,
          status: "ACTIVE",
        },
      });
      // Ensure the UserClubRole platform grant exists.
      const existingRole = await prisma.userClubRole.findFirst({
        where: { userId: user.id, clubId: null, roleKey: "SUPER_ADMIN" },
        select: { id: true },
      });
      if (!existingRole) {
        await prisma.userClubRole.create({
          data: { userId: user.id, clubId: null, roleKey: "SUPER_ADMIN" },
        });
      }
    } else {
      user = await prisma.user.create({
        data: {
          email: op.email,
          name: fullName,
          role: "SUPER_ADMIN",
          passwordHash,
          status: "ACTIVE",
        },
      });
      await prisma.userClubRole.create({
        data: { userId: user.id, clubId: null, roleKey: "SUPER_ADMIN" },
      });
    }

    results.push({
      key: op.key,
      email: op.email,
      userIdTail: user.id.slice(-6),
      password,
      expires: expiresMarker,
    });
  }

  const envelope = {
    sliceId: "m4-int-c",
    createdAt: windowStart.toISOString(),
    expiresAt: windowExpire.toISOString(),
    windowMinutes: 120,
    operators: results,
  };

  // Write to /tmp/m4-int-c-creds.json inside the container.  The
  // caller shuttles this out via SSH and writes it to
  // .env.playwright.local.  Chmod 600 so other processes cannot read.
  writeFileSync("/tmp/m4-int-c-creds.json", JSON.stringify(envelope, null, 2), { mode: 0o600 });

  console.log(JSON.stringify({
    ok: true,
    sliceId: "m4-int-c",
    createdAt: windowStart.toISOString(),
    expiresAt: windowExpire.toISOString(),
    operators: results.map((r) => ({
      key: r.key, email: r.email, userIdTail: r.userIdTail, expires: r.expires,
    })),
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
