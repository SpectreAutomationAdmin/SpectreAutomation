// SIGNUP-2 Phase 2B (2026-10-25) -- Staging-only test fixture harness.
//
// Founder decision 5:
//   "Isolated staging-only fixtures.  Prefer deterministic setup +
//    teardown over a persistent publicly accessible debug endpoint."
//
// This script implements that preference.  It runs INSIDE the
// `spectre-staging` container via `flyctl ssh console` (same pattern
// as scripts/hr-2b5-staging-fixture.mjs) and:
//
//   `create`  -- seeds a verified SignupRegistration in state
//                READY_FOR_AUTHORITY_ATTESTATION with a canned
//                Microsoft identity.  Prints the resume URL as the
//                FIRST line of stdout as JSON:
//                  {"resumeUrl":"...","registrationId":"...","token":"..."}
//
//   `destroy` -- deletes the fixture SignupRegistration + any attestations
//                attached to it.  Idempotent.  Prints {"destroyed":N}
//                where N is the number of registrations deleted.
//
// Hard-coded guard:  The fixture resume token's SHA-256 lives in a
// FIXED PREFIX ("sig2b-fixture-") that no production registration
// will ever use.  Destroy only ever matches that prefix.
//
// No production tenants are modified.  No ClubSubscription row is
// created (the fixture SignupRegistration has no Club shell; Phase
// 2G is responsible for that).
//
// Usage (from inside the staging container):
//
//   node scripts/signup-2-phase-2b-staging-fixture.mjs create
//   node scripts/signup-2-phase-2b-staging-fixture.mjs destroy

import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";

const prisma = new PrismaClient();
const BASE_URL = process.env.STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

// Deterministic fixture identifier.  The resume token has this
// prefix so destroy can scope by it without any risk of touching a
// real registration.
const FIXTURE_LEGAL_NAME = "SIGNUP-2 Phase 2B Staging Fixture Club";
const FIXTURE_ADMIN_EMAIL = "signup-2-phase-2b-fixture-admin@spectre.test";
const FIXTURE_ADMIN_OID = "00000000-2b2b-2b2b-2b2b-000000000000";
const FIXTURE_ADMIN_TID = "00000000-2b2b-ffff-2b2b-000000000000";

function hashToken(raw) {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function generateFixtureToken() {
  // Keep the "sig2b-fixture-" prefix in the RAW token so logs stay
  // self-describing; the hash is still random.
  return `sig2b-fixture-${randomBytes(24).toString("base64url")}`;
}

async function createFixture() {
  // Destroy first so re-runs land on a blank slate.
  await destroyFixture({ silent: true });

  const rawToken = generateFixtureToken();
  const tokenHash = hashToken(rawToken);
  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7);

  const reg = await prisma.signupRegistration.create({
    data: {
      resumeTokenHash: tokenHash,
      legalName: FIXTURE_LEGAL_NAME,
      legalNameNormalized: FIXTURE_LEGAL_NAME.toLowerCase().replace(/\s+/g, " ").trim(),
      operatingName: null,
      operatingNameNormalized: null,
      country: "CA",
      provinceState: "AB",
      addressLine1: "1 Fixture Lane",
      city: "Fixtureville",
      postalCode: "T0A 0A0",
      websiteUrl: null,
      adminEmail: FIXTURE_ADMIN_EMAIL,
      adminMicrosoftOid: FIXTURE_ADMIN_OID,
      adminMicrosoftTenantId: FIXTURE_ADMIN_TID,
      adminDisplayName: "SIGNUP-2 Phase 2B Fixture Admin",
      adminGivenName: "Phase2B",
      adminSurname: "FixtureAdmin",
      adminPosition: "General Manager",
      adminVerifiedAt: now,
      step: "READY_FOR_AUTHORITY_ATTESTATION",
      status: "DRAFT",
      ownershipVerificationState: "AUTOMATED_PASSED",
      ownershipAutomatedCheckJson: null,
      ownershipNote: null,
      startedByIp: "127.0.0.1",
      startedUserAgent: "SIGNUP-2 Phase 2B Fixture",
      expiresAt: expires,
    },
  });

  const resumeUrl = `${BASE_URL}/signup/t/${encodeURIComponent(rawToken)}/status`;
  const authorityUrl = `${BASE_URL}/signup/t/${encodeURIComponent(rawToken)}/authority`;

  // Emit JSON as the FIRST line.
  console.log(JSON.stringify({
    resumeUrl,
    authorityUrl,
    registrationId: reg.id,
    token: rawToken,
    adminMicrosoftOid: FIXTURE_ADMIN_OID,
    adminMicrosoftTid: FIXTURE_ADMIN_TID,
  }));
}

async function destroyFixture({ silent = false } = {}) {
  // Match by the DETERMINISTIC adminMicrosoftOid, not by the random
  // token hash -- the token hash is per-create, but the oid is a
  // fixed well-known fixture identifier.
  const regs = await prisma.signupRegistration.findMany({
    where: { adminMicrosoftOid: FIXTURE_ADMIN_OID },
    select: { id: true },
  });

  if (regs.length === 0) {
    if (!silent) console.log(JSON.stringify({ destroyed: 0 }));
    return;
  }

  // Delete any attached attestations first; model doesn't CASCADE.
  const regIds = regs.map((r) => r.id);
  await prisma.subscriptionAuthorisationAttestation.deleteMany({
    where: { signupRegistrationId: { in: regIds } },
  });
  // Delete recovery links + oauth transactions (CASCADE on registration
  // delete per schema, but belt + suspenders).
  await prisma.signupRecoveryLink.deleteMany({
    where: { registrationId: { in: regIds } },
  });
  await prisma.signupOAuthTransaction.deleteMany({
    where: { registrationId: { in: regIds } },
  });
  const result = await prisma.signupRegistration.deleteMany({
    where: { id: { in: regIds } },
  });

  if (!silent) console.log(JSON.stringify({ destroyed: result.count }));
}

async function verifyFixture() {
  // Count attestations attached to the fixture oid.  Used by the
  // Playwright acceptance to prove the fail-closed gate never
  // persisted a row.
  const attestations = await prisma.subscriptionAuthorisationAttestation.count({
    where: { acceptedByMicrosoftOid: FIXTURE_ADMIN_OID },
  });
  const registrations = await prisma.signupRegistration.count({
    where: { adminMicrosoftOid: FIXTURE_ADMIN_OID },
  });
  console.log(JSON.stringify({ attestations, registrations }));
}

async function verifyVerdictFor(adminOid) {
  // SIGNUP-2 Phase 2C acceptance helper.  Reads the verdict column
  // written by the pipeline so the staging Playwright acceptance
  // can assert what the pipeline persisted without hitting a
  // read-protected admin endpoint.
  const reg = await prisma.signupRegistration.findFirst({
    where: { adminMicrosoftOid: adminOid },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      step: true,
      status: true,
      verificationVerdict: true,
      verificationHoldCategory: true,
      signingAuthoritySignal: true,
      verificationDecidedAt: true,
    },
  });
  console.log(JSON.stringify({ reg }));
}

async function createPhase2cFixture(scenario) {
  // Scenario selector drives the legalName (which the fixture
  // adapter in src/lib/signup/entity-registry/adapters/fixture.ts
  // reads) + the ownershipVerificationState the pipeline reads.
  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7);
  const token = generateFixtureToken();
  const tokenHash = hashToken(token);
  // Each scenario gets a distinct oid so parallel scenarios can
  // coexist on the same staging DB.
  const oidTail = scenario.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12).padEnd(12, "0");
  const oid = `${oidTail}-2b2b-2b2b-2b2b-2c0000000000`;
  let legalName;
  let ownership;
  switch (scenario) {
    case "pass-via-fixture":
      // Fixture adapter would normally return ACTIVE+MATCHED, but
      // Phase 2C's isLive=false on the fixture means PASS_AUTOMATED
      // is unreachable via staging acceptance -- the result is a
      // HOLD:ENTITY_VERIFICATION ("standing-not-from-live-adapter").
      // This scenario documents that invariant.
      legalName = "FIXTURE:ACTIVE+MATCHED Phase 2C Acceptance Pass Club";
      ownership = "AUTOMATED_PASSED";
      break;
    case "hold":
      legalName = "FIXTURE:MANUAL_REVIEW_REQUIRED Phase 2C Hold Club";
      ownership = "AUTOMATED_PASSED";
      break;
    case "reject":
      legalName = "FIXTURE:NOT_ACTIVE Phase 2C Reject Club";
      ownership = "AUTOMATED_PASSED";
      break;
    default:
      throw new Error(`unknown scenario: ${scenario}`);
  }

  // Destroy prior for this specific oid before create (idempotent).
  const prior = await prisma.signupRegistration.findMany({
    where: { adminMicrosoftOid: oid },
    select: { id: true },
  });
  if (prior.length) {
    const ids = prior.map((r) => r.id);
    await prisma.subscriptionAuthorisationAttestation.deleteMany({ where: { signupRegistrationId: { in: ids } } });
    await prisma.entityStandingCheck.deleteMany({ where: { signupRegistrationId: { in: ids } } });
    await prisma.signupRecoveryLink.deleteMany({ where: { registrationId: { in: ids } } });
    await prisma.signupOAuthTransaction.deleteMany({ where: { registrationId: { in: ids } } });
    await prisma.signupRegistration.deleteMany({ where: { id: { in: ids } } });
  }

  const reg = await prisma.signupRegistration.create({
    data: {
      resumeTokenHash: tokenHash,
      legalName,
      legalNameNormalized: legalName.toLowerCase(),
      operatingName: null,
      operatingNameNormalized: null,
      country: "CA",
      provinceState: "AB",
      addressLine1: "1 Fixture Lane",
      city: "Fixtureville",
      postalCode: "T0A 0A0",
      websiteUrl: null,
      adminEmail: `signup-2-phase-2c-${scenario}@spectre.test`,
      adminMicrosoftOid: oid,
      adminMicrosoftTenantId: "00000000-2c2c-ffff-2c2c-000000000000",
      adminDisplayName: `Phase 2C ${scenario}`,
      adminGivenName: "Phase2C",
      adminSurname: scenario,
      adminPosition: "General Manager",
      adminVerifiedAt: now,
      step: "READY_FOR_AUTHORITY_ATTESTATION",
      status: "DRAFT",
      ownershipVerificationState: ownership,
      startedByIp: "127.0.0.1",
      startedUserAgent: "SIGNUP-2 Phase 2C Fixture",
      expiresAt: expires,
    },
  });

  const authorityUrl = `${BASE_URL}/signup/t/${encodeURIComponent(token)}/authority`;
  console.log(JSON.stringify({
    scenario,
    authorityUrl,
    registrationId: reg.id,
    token,
    adminMicrosoftOid: oid,
    legalName,
  }));
}

async function destroyPhase2cFixtures() {
  const regs = await prisma.signupRegistration.findMany({
    where: { adminMicrosoftOid: { endsWith: "-2c0000000000" } },
    select: { id: true, adminMicrosoftOid: true },
  });
  if (regs.length === 0) {
    console.log(JSON.stringify({ destroyed: 0 }));
    return;
  }
  const ids = regs.map((r) => r.id);
  await prisma.subscriptionAuthorisationAttestation.deleteMany({ where: { signupRegistrationId: { in: ids } } });
  await prisma.entityStandingCheck.deleteMany({ where: { signupRegistrationId: { in: ids } } });
  await prisma.signupRecoveryLink.deleteMany({ where: { registrationId: { in: ids } } });
  await prisma.signupOAuthTransaction.deleteMany({ where: { registrationId: { in: ids } } });
  const result = await prisma.signupRegistration.deleteMany({ where: { id: { in: ids } } });
  console.log(JSON.stringify({ destroyed: result.count }));
}

async function main() {
  const action = process.argv[2];
  if (action === "create") {
    await createFixture();
  } else if (action === "destroy") {
    await destroyFixture();
  } else if (action === "verify") {
    await verifyFixture();
  } else if (action === "phase2c-create") {
    const scenario = process.argv[3];
    if (!scenario) {
      console.error("Usage: ... phase2c-create <pass-via-fixture|hold|reject>");
      process.exit(2);
    }
    await createPhase2cFixture(scenario);
  } else if (action === "phase2c-destroy") {
    await destroyPhase2cFixtures();
  } else if (action === "phase2c-verdict") {
    const oid = process.argv[3];
    if (!oid) {
      console.error("Usage: ... phase2c-verdict <adminMicrosoftOid>");
      process.exit(2);
    }
    await verifyVerdictFor(oid);
  } else {
    console.error("Usage: node scripts/signup-2-phase-2b-staging-fixture.mjs {create|destroy|verify|phase2c-create|phase2c-destroy|phase2c-verdict}");
    process.exit(2);
  }
}

main()
  .catch((err) => {
    console.error("[signup-2-phase-2b-staging-fixture]", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
