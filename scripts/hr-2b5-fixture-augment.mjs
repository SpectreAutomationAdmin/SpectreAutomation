// HR-2B.5 Playwright acceptance — companion fixture augmenter.
//
// Runs AFTER `scripts/hr-2b2-fixture-invitation.mjs` and adds:
//   * an initial EmployeeCompensation row (HOURLY or SALARY,
//     effective on the fixture's expectedStartDate)
//   * wipes any prior HR-2B.5 portal credential + password-reset rows
//     so the portal-password step starts blank
//   * wipes prior HR-2B.4 emergency contact + credentials so the
//     post-payroll flow starts blank
//   * clears any prior tour completion + resets employee lifecycle to
//     PRE_HIRE so the fixture is reusable across runs
//
// Idempotent. Reads the fixture JSON produced by the HR-2B.2 script
// and writes an augmented `test-results/hr-2b5-fixture.json`.
//
// Usage:
//   node scripts/hr-2b2-fixture-invitation.mjs --email hr-2b5@spectre.test
//   node scripts/hr-2b5-fixture-augment.mjs --cadence HOURLY --rate 22.50
//   node scripts/hr-2b5-fixture-augment.mjs --cadence SALARY --rate 72000

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const DB_ABS = path.resolve(REPO_ROOT, "prisma", "dev.db");
if (!fs.existsSync(DB_ABS)) {
  process.stderr.write(`[hr-2b5-fixture] SQLite dev DB missing at ${DB_ABS}\n`);
  process.exit(2);
}
process.env.DATABASE_URL = `file:${DB_ABS.replace(/\\/g, "/")}`;

function parseArgs(argv) {
  const out = { cadence: "HOURLY", rate: "22.50", fixture: null, stage: "employment" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cadence") out.cadence = argv[++i];
    else if (a.startsWith("--cadence=")) out.cadence = a.slice(10);
    else if (a === "--rate") out.rate = argv[++i];
    else if (a.startsWith("--rate=")) out.rate = a.slice(7);
    else if (a === "--fixture") out.fixture = argv[++i];
    else if (a.startsWith("--fixture=")) out.fixture = a.slice(10);
    else if (a === "--stage") out.stage = argv[++i];
    else if (a.startsWith("--stage=")) out.stage = a.slice(8);
  }
  return out;
}

const { cadence, rate, fixture: fixturePath, stage } = parseArgs(process.argv.slice(2));

if (cadence !== "HOURLY" && cadence !== "SALARY") {
  process.stderr.write(`[hr-2b5-fixture] --cadence must be HOURLY or SALARY (got ${cadence})\n`);
  process.exit(2);
}
// stage: "employment" (default — invitation only, no acks) or
// "portal-password" (About You + Payroll + Emergency + Documents
// completed so the resolver drops us at /portal-password).
if (!["employment", "portal-password"].includes(stage)) {
  process.stderr.write(`[hr-2b5-fixture] --stage must be employment or portal-password (got ${stage})\n`);
  process.exit(2);
}

const inputPath = fixturePath ?? path.resolve(REPO_ROOT, "test-results", "hr-2b2-fixture.json");
if (!fs.existsSync(inputPath)) {
  process.stderr.write(`[hr-2b5-fixture] input fixture missing at ${inputPath}\n`);
  process.stderr.write("[hr-2b5-fixture] run hr-2b2-fixture-invitation.mjs first\n");
  process.exit(2);
}

const base = JSON.parse(fs.readFileSync(inputPath, "utf8"));

const prisma = new PrismaClient();

async function main() {
  const { clubId, employeeId, expectedStartDate } = base;
  if (!clubId || !employeeId) {
    process.stderr.write("[hr-2b5-fixture] fixture missing clubId or employeeId\n");
    process.exit(2);
  }

  // Wipe HR-2B.5 portal artefacts so the flow re-runs cleanly.
  await prisma.employeePortalPasswordReset.deleteMany({ where: { employeeId } });
  await prisma.employeePortalCredential.deleteMany({ where: { employeeId } });
  await prisma.employee.update({
    where: { id: employeeId },
    data: { portalTourCompletedAt: null, employeeLifecycle: "PRE_HIRE" },
  });

  // Wipe HR-2B.4 emergency + credentials so the pre-portal-password
  // stages are also blank on re-run.
  await prisma.employeeEmergencyContact.deleteMany({ where: { employeeId } });
  await prisma.employeeCredential.deleteMany({ where: { employeeId } });

  // Wipe every prior compensation row so we can insert a fresh
  // effective-dated open row.
  await prisma.employeeCompensation.deleteMany({ where: { employeeId } });

  const effectiveFrom = expectedStartDate ? new Date(expectedStartDate) : new Date();
  const comp = await prisma.employeeCompensation.create({
    data: {
      clubId,
      employeeId,
      effectiveFrom,
      effectiveTo: null,
      cadence,
      rate,
      currency: "CAD",
      notes: "HR-2B.5 acceptance fixture",
    },
  });

  // Legacy shadow-write — the canonical service (changeCompensation)
  // does this in the same transaction. Because this is a fixture
  // bootstrap that bypasses the service (same discipline as
  // hr-2b2-fixture-invitation.mjs bypassing RBAC), we do it here.
  await prisma.employee.update({
    where: { id: employeeId },
    data: { payRate: rate, compensationType: cadence },
  });

  if (stage === "portal-password") {
    // Advance the fixture past About You / Payroll / Emergency /
    // Documents so the canonical continuation resolver drops the
    // employee straight at /portal-password on invitation redemption.
    // Uses direct Prisma writes (same discipline as the invitation
    // script — this is a test bootstrap, not production).
    const sessionId = base.sessionId;
    // Session → IN_PROGRESS. The token-landing action only stamps
    // the cookie; the real INVITED→IN_PROGRESS transition fires on
    // the first About-You save action. Since we bypass About You
    // by seeding acks directly, we transition here so downstream
    // steps see a resumable in-progress session.
    await prisma.employeeOnboardingSession.update({
      where: { id: sessionId },
      data: { state: "IN_PROGRESS" },
    });
    await prisma.employeeOnboardingStateTransition.create({
      data: {
        clubId, employeeId, sessionId,
        fromState: "INVITED",
        toState: "IN_PROGRESS",
        actorSource: "SYSTEM",
        actorEmployeeId: employeeId,
        reason: "hr-2b5 fixture augment",
      },
    });
    await prisma.employee.update({
      where: { id: employeeId },
      data: {
        onboardingState: "IN_PROGRESS",
        preferredName: "Alex",
        personalEmail: base.employeePersonalEmail ?? "hr-2b5-portal@spectre.test",
        mobilePhone: "(403) 555-0170",
      },
    });
    // Acknowledgements — every About You step + both TD1 attestations.
    const now = new Date();
    for (const kind of [
      "about_you_name_confirmation",
      "about_you_contact_confirmation",
      "employment_confirmation",
      "td1_federal_attestation",
      "td1_provincial_attestation",
    ]) {
      await prisma.employeeOnboardingAcknowledgement.upsert({
        where: { sessionId_kind: { sessionId, kind } },
        create: { clubId, sessionId, employeeId, kind, actorEmployeeId: employeeId, acknowledgedAt: now },
        update: { acknowledgedAt: now },
      });
    }
    // Profile photo — placeholder EmployeeDocument row.
    const photo = await prisma.employeeDocument.create({
      data: {
        clubId,
        employeeId,
        category: "profile_photo",
        sensitivity: "STANDARD",
        storageKey: `fixture/photo/${employeeId}.png`,
        contentSha256: "0".repeat(64),
        sizeBytes: 1,
        mimeType: "image/png",
        displayName: "photo.png",
        uploadedByUserId: null,
      },
    });
    await prisma.employee.update({
      where: { id: employeeId },
      data: { profilePhotoDocumentId: photo.id },
    });
    // SIN — canonical row (masked-only downstream). The KMS secretRef
    // is a placeholder identifier; the fixture never reads back
    // plaintext, and the acceptance flow only surfaces the masked
    // "XXX XXX 286".
    await prisma.employeeSensitiveIdentity.upsert({
      where: { employeeId },
      create: {
        clubId, employeeId,
        sinLastThree: "286",
        sinSecretRef: "fixture:hr-2b5-sin",
        issuingCountry: "CA",
      },
      update: {},
    });
    // Bank account — VERIFIED so continuation resolver treats banking
    // as complete.
    const existingBank = await prisma.employeeBankAccount.findFirst({ where: { employeeId } });
    if (!existingBank) {
      await prisma.employeeBankAccount.create({
        data: {
          clubId, employeeId,
          holderName: "Alex Fixture",
          institutionSecretRef: "fixture:hr-2b5-inst",
          transitSecretRef: "fixture:hr-2b5-transit",
          accountSecretRef: "fixture:hr-2b5-acct",
          accountLastFour: "7890",
          status: "VERIFIED",
        },
      });
    }
    // Tax profile — no @unique on employeeId (effective-dated). Guard
    // against re-runs by wiping first.
    await prisma.employeeTaxProfile.deleteMany({ where: { employeeId } });
    await prisma.employeeTaxProfile.create({
      data: {
        clubId, employeeId,
        province: "AB",
        td1FormVersion: "TD1-2026",
        effectiveFrom,
        federalClaimSecretRef: "fixture:hr-2b5-fed",
        provincialClaimSecretRef: "fixture:hr-2b5-prov",
      },
    });
    // Emergency contact — same pattern.
    await prisma.employeeEmergencyContact.deleteMany({ where: { employeeId } });
    await prisma.employeeEmergencyContact.create({
      data: {
        clubId, employeeId,
        name: "Emergency Kin",
        relation: "Sibling",
        phone: "(403) 555-0199",
        email: null,
        isPrimary: true,
      },
    });
  }

  const augmented = {
    ...base,
    hr2b5: {
      compensationId: comp.id,
      cadence,
      rate,
      currency: "CAD",
      effectiveFrom: effectiveFrom.toISOString(),
      stage,
    },
  };
  const outPath = path.resolve(REPO_ROOT, "test-results", "hr-2b5-fixture.json");
  fs.writeFileSync(outPath, JSON.stringify(augmented, null, 2) + "\n", "utf8");
  process.stderr.write(`[hr-2b5-fixture] wrote ${outPath} (${cadence} ${rate}, stage=${stage})\n`);
  process.stdout.write(JSON.stringify({ ok: true, cadence, rate, stage }) + "\n");
}

main()
  .catch((err) => {
    process.stderr.write(`[hr-2b5-fixture] ERROR: ${err?.stack ?? err}\n`);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
