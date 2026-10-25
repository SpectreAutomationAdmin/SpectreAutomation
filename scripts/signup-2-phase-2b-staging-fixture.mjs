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

async function main() {
  const action = process.argv[2];
  if (action === "create") {
    await createFixture();
  } else if (action === "destroy") {
    await destroyFixture();
  } else {
    console.error("Usage: node scripts/signup-2-phase-2b-staging-fixture.mjs {create|destroy}");
    process.exit(2);
  }
}

main()
  .catch((err) => {
    console.error("[signup-2-phase-2b-staging-fixture]", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
