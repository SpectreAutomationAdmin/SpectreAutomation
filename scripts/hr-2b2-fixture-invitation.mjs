// HR-2B.2 Playwright acceptance — local fixture invitation generator.
//
// Idempotent, dev-only script that primes the SQLite dev DB with the
// minimum set of rows required for the employee-facing onboarding
// flow at http://localhost:3000/hr/onboarding/<token>:
//
//   Club  ->  Department  ->  EmployeePosition
//         ->  Staff-issuer User (for FK on invitation.issuedByUserId
//                                and session.initiatedByUserId)
//         ->  Employee (identified by --email, upserted)
//         ->  EmployeeOnboardingSession(state=INVITED)
//         ->  EmployeeOnboardingInvitation(fresh raw token)
//
// The RAW token is a base64url string derived from crypto.randomBytes
// (matching src/lib/hr/invitations.ts::generateRawToken), and only the
// SHA-256 hash is persisted; the plaintext is written ONLY to the
// git-ignored `test-results/hr-2b2-fixture.json` file plus stderr for
// operator visibility. This mirrors production invariants — the token
// is never logged to stdout.
//
// Usage:
//   node scripts/hr-2b2-fixture-invitation.mjs --email hr-2b2-fixture@spectre.test
//
// Re-running with the same --email:
//   * reuses the same Club / Employee (upsert)
//   * deletes any prior sessions / invitations / corrections /
//     acknowledgements / responses / state-transitions for that
//     employee — plus every EmployeeDocument row (profile_photo,
//     void_cheque, direct_deposit_form) and every HR-2B.3 sensitive
//     payroll row (EmployeeSensitiveIdentity, EmployeeBankAccount,
//     EmployeeTaxProfile)
//   * writes a FRESH invitation with a new raw token
//   * overwrites test-results/hr-2b2-fixture.json
//
// This is deliberately NOT a service-layer path. It bypasses RBAC /
// posting-guard / audit because it is a test-fixture bootstrap for
// SQLite dev only — not a production surface. Never call from
// production code.

import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Pin the SQLite path so this script is CWD-independent. Prisma's SQLite
// driver accepts `file:C:/.../dev.db` on Windows and `file:/.../dev.db`
// on POSIX.
const DB_ABS = path.resolve(REPO_ROOT, "prisma", "dev.db");
if (!fs.existsSync(DB_ABS)) {
  process.stderr.write(
    `[hr-2b2-fixture] SQLite dev DB not found at ${DB_ABS}. ` +
      `Run 'npm run db:reset' or 'npm run db:push' first.\n`,
  );
  process.exit(2);
}
process.env.DATABASE_URL = `file:${DB_ABS.replace(/\\/g, "/")}`;

// ---------------------------------------------------------------------------
// Arg parsing (tiny — one flag).
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { email: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email") {
      out.email = argv[++i];
    } else if (a.startsWith("--email=")) {
      out.email = a.slice("--email=".length);
    }
  }
  return out;
}

const { email: RAW_EMAIL } = parseArgs(process.argv.slice(2));
if (!RAW_EMAIL || !RAW_EMAIL.includes("@")) {
  process.stderr.write(
    "[hr-2b2-fixture] usage: node scripts/hr-2b2-fixture-invitation.mjs --email <employee-personal-email>\n",
  );
  process.exit(2);
}
const EMAIL = RAW_EMAIL.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
function hashToken(rawToken) {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function generateRawToken() {
  // Matches src/lib/hr/invitations.ts::generateRawToken (32 bytes, base64url).
  return randomBytes(32).toString("base64url");
}

function shortHash(input) {
  return createHash("sha1").update(input).digest("hex").slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
const prisma = new PrismaClient();

async function upsertClub() {
  const slug = "hr-2b2-fixture";
  const name = "Riverside Country Club (HR-2B.2 Fixture)";
  return prisma.club.upsert({
    where: { slug },
    update: {},
    create: {
      slug,
      name,
      region: "Test",
      salesTaxRegion: "GST",
      foundedYear: 2000,
      timezone: "America/Edmonton",
      // Fixture Club — mark as synthetic dev tenant so it never
      // appears mixed with founder-review data.
      stagingDataMode: "SYNTHETIC_DEMO",
    },
  });
}

async function upsertDepartment(clubId) {
  return prisma.department.upsert({
    where: { clubId_code: { clubId, code: "GOLF_OPS" } },
    update: {},
    create: {
      clubId,
      code: "GOLF_OPS",
      name: "Golf Operations",
      sortOrder: 10,
    },
  });
}

async function upsertPosition(clubId) {
  return prisma.employeePosition.upsert({
    where: { clubId_code: { clubId, code: "ASSIST_PRO" } },
    update: {},
    create: {
      clubId,
      code: "ASSIST_PRO",
      name: "Assistant Professional",
      defaultPayRate: 22,
    },
  });
}

async function upsertStaffIssuer(clubId) {
  // Fixed staff-issuer identity — deterministic so re-runs don't spawn
  // new user rows.
  const email = "hr-2b2-fixture-issuer@spectre.test";
  // Not a login credential — the field is required but this user
  // never signs in. A short bcrypt-like placeholder-safe value is
  // sufficient for the FK requirement.
  const passwordHash =
    "$2a$04$dummyDummyDummyDummyDummyDummyDummyDummyDummyDummyDummyDu";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      name: "HR-2B.2 Fixture Issuer",
      role: "CLUB_ADMIN",
      passwordHash,
      clubId,
      status: "ACTIVE",
    },
  });
}

async function upsertEmployee({ clubId, departmentId, positionId, email }) {
  // Deterministic employee number derived from the fixture email so
  // that the (clubId, employeeNumber) unique constraint holds across
  // re-runs.
  const employeeNumber = `FIX-HR2B2-${shortHash(email).toUpperCase()}`;
  const expectedStartDate = new Date();
  expectedStartDate.setUTCHours(0, 0, 0, 0);
  expectedStartDate.setUTCDate(expectedStartDate.getUTCDate() + 21);

  const existing = await prisma.employee.findFirst({
    where: { clubId, employeeNumber },
    select: { id: true, profilePhotoDocumentId: true },
  });
  if (existing) {
    // Reset employee-mutable fields so the flow starts clean each run.
    // Null out the profile-photo FK first so we can safely delete the
    // linked EmployeeDocument row.
    if (existing.profilePhotoDocumentId) {
      await prisma.employee.update({
        where: { id: existing.id },
        data: { profilePhotoDocumentId: null },
      });
    }
    // Wipe every EmployeeDocument row belonging to this fixture employee
    // — HR-2B.3 added banking supporting documents (void_cheque /
    // direct_deposit_form) which must also start clean per re-run.
    await prisma.employeeDocument.deleteMany({
      where: { employeeId: existing.id },
    });
    await prisma.employee.update({
      where: { id: existing.id },
      data: {
        firstName: "Alex",
        lastName: "Fixture",
        middleName: null,
        preferredName: null,
        personalEmail: email,
        mobilePhone: null,
        departmentId,
        positionId,
        expectedStartDate,
        employmentType: "FULL_TIME",
        employeeLifecycle: "PRE_HIRE",
        onboardingState: "INVITED",
        payrollReadiness: "NOT_READY",
        status: "ACTIVE",
      },
    });
    return prisma.employee.findUniqueOrThrow({ where: { id: existing.id } });
  }
  return prisma.employee.create({
    data: {
      clubId,
      employeeNumber,
      firstName: "Alex",
      lastName: "Fixture",
      personalEmail: email,
      departmentId,
      positionId,
      expectedStartDate,
      employmentType: "FULL_TIME",
      employeeLifecycle: "PRE_HIRE",
      onboardingState: "INVITED",
      payrollReadiness: "NOT_READY",
      status: "ACTIVE",
      compensationType: "HOURLY",
      payRate: 22,
    },
  });
}

async function resetEmployeeOnboardingState(employeeId) {
  // Wipe every non-terminal fixture the flow will write. Cascade from
  // session takes care of corrections/acknowledgements/responses when
  // the session row is deleted, but we also wipe standalone rows for
  // safety in case FK cascades ever change.
  await prisma.employeeOnboardingCorrection.deleteMany({ where: { employeeId } });
  await prisma.employeeOnboardingAcknowledgement.deleteMany({ where: { employeeId } });
  await prisma.employeeOnboardingResponse.deleteMany({
    where: { session: { employeeId } },
  });
  await prisma.employeeOnboardingStateTransition.deleteMany({ where: { employeeId } });
  await prisma.employeeOnboardingSession.deleteMany({ where: { employeeId } });
  await prisma.employeeOnboardingInvitation.deleteMany({ where: { employeeId } });
  // HR-2B.3 (2026-08-19) — sensitive payroll rows the employee-side
  // /hr/onboarding/payroll flow persists. Wipe so re-runs against the
  // same fixture email always land on a blank SIN / banking / TD1
  // start-state, matching About-you fixtures already wiped above.
  await prisma.employeeSensitiveIdentity.deleteMany({ where: { employeeId } });
  await prisma.employeeBankAccount.deleteMany({ where: { employeeId } });
  await prisma.employeeTaxProfile.deleteMany({ where: { employeeId } });
}

async function createInvitedSession({ clubId, employeeId, initiatedByUserId }) {
  return prisma.employeeOnboardingSession.create({
    data: {
      clubId,
      employeeId,
      initiatedByUserId,
      state: "INVITED",
    },
  });
}

async function createFreshInvitation({ clubId, employeeId, issuedByUserId }) {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const invitation = await prisma.employeeOnboardingInvitation.create({
    data: {
      clubId,
      employeeId,
      tokenHash,
      expiresAt,
      issuedByUserId,
    },
  });
  return { invitation, rawToken };
}

async function main() {
  const club = await upsertClub();
  const department = await upsertDepartment(club.id);
  const position = await upsertPosition(club.id);
  const issuer = await upsertStaffIssuer(club.id);
  const employee = await upsertEmployee({
    clubId: club.id,
    departmentId: department.id,
    positionId: position.id,
    email: EMAIL,
  });
  await resetEmployeeOnboardingState(employee.id);
  const session = await createInvitedSession({
    clubId: club.id,
    employeeId: employee.id,
    initiatedByUserId: issuer.id,
  });
  const { invitation, rawToken } = await createFreshInvitation({
    clubId: club.id,
    employeeId: employee.id,
    issuedByUserId: issuer.id,
  });

  const outDir = path.resolve(REPO_ROOT, "test-results");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.resolve(outDir, "hr-2b2-fixture.json");

  const payload = {
    generatedAt: new Date().toISOString(),
    clubId: club.id,
    clubName: club.name,
    employeeId: employee.id,
    employeeFirstName: employee.firstName,
    employeeLastName: employee.lastName,
    employeePreferredName: employee.preferredName,
    departmentId: department.id,
    departmentName: department.name,
    positionId: position.id,
    positionName: position.name,
    employmentType: employee.employmentType,
    expectedStartDate: employee.expectedStartDate
      ? employee.expectedStartDate.toISOString()
      : null,
    sessionId: session.id,
    invitationId: invitation.id,
    rawToken,
    expiresAt: invitation.expiresAt.toISOString(),
    redemptionUrl: `http://localhost:3000/hr/onboarding/${rawToken}`,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");

  process.stderr.write(
    `[hr-2b2-fixture] wrote ${outPath}\n` +
      `[hr-2b2-fixture] redemption URL (stderr only): ${payload.redemptionUrl}\n`,
  );
  // stdout carries a stable JSON summary with the token REDACTED so
  // callers can machine-consume the identifiers without leaking the
  // credential.
  const redacted = { ...payload, rawToken: "REDACTED", redemptionUrl: "REDACTED" };
  process.stdout.write(JSON.stringify(redacted) + "\n");
}

main()
  .catch((err) => {
    process.stderr.write(`[hr-2b2-fixture] ERROR: ${err?.stack ?? err}\n`);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
