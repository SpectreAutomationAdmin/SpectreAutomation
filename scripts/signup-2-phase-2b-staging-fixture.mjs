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

async function listSuperAdmins() {
  // Phase 2D helper -- discover authorised SUPER_ADMIN accounts via
  // the application's own permission system per founder decision 8.
  // Checks both the deprecated User.role column AND UserClubRole
  // with clubId=null so no platform-admin configuration is missed.
  // Prints masked emails only.
  const platformRoleRows = await prisma.userClubRole.findMany({
    where: { clubId: null },
    select: {
      userId: true,
      roleKey: true,
      user: { select: { email: true, name: true } },
    },
  });
  const byRole = {};
  for (const r of platformRoleRows) {
    byRole[r.roleKey] = byRole[r.roleKey] || [];
    byRole[r.roleKey].push({
      userIdTail: r.userId.slice(-6),
      emailMasked: r.user?.email ? maskEmailAt(r.user.email) : null,
      nameInitial: r.user?.name ? r.user.name.slice(0, 1) + "." : null,
    });
  }
  // Fallback: scan User.role for admin-like strings (SUPER_ADMIN,
  // SPECTRE_ADMIN, PLATFORM_ADMIN).  The deprecated column is still
  // the live source of truth on the founder's own user row.
  const adminUsers = await prisma.user.findMany({
    where: {
      OR: [
        { role: "SUPER_ADMIN" },
        { role: "SPECTRE_ADMIN" },
        { role: "PLATFORM_ADMIN" },
      ],
    },
    select: { id: true, email: true, name: true, role: true, status: true },
  });
  const userRoleSummary = adminUsers.map((u) => ({
    userIdTail: u.id.slice(-6),
    emailMasked: u.email ? maskEmailAt(u.email) : null,
    nameInitial: u.name ? u.name.slice(0, 1) + "." : null,
    role: u.role,
    status: u.status,
  }));
  console.log(JSON.stringify({
    userClubRoleAtClubNull: { byRole, totalCount: platformRoleRows.length },
    userRoleColumn: { admins: userRoleSummary, totalCount: adminUsers.length },
  }));
}

function maskEmailAt(email) {
  const at = email.indexOf("@");
  if (at < 2) return "***";
  return email.slice(0, 2) + "***@" + email.slice(at + 1);
}

// ---------------------------------------------------------------
// SIGNUP-2 Phase 2D (2026-10-25) fixture extensions.
//
// Creates three synthetic SUPER_ADMIN operator identities + one
// HOLD_FOR_REVIEW SignupRegistration (bypassing the Phase 2B flag
// gate by writing the attestation + standing check directly) so
// the Playwright acceptance can exercise the three-operator
// separation-of-duties workflow.
//
// Isolation per founder §5:  the three operators are deterministic
// synthetic identities (NOT real admin accounts).  Teardown removes
// them without touching anything else.
// ---------------------------------------------------------------
const PHASE_2D_FIXTURE_PREFIX = "signup-2d-fixture-";
const PHASE_2D_TRIO = [
  { role: "standing-operator",  email: `${PHASE_2D_FIXTURE_PREFIX}standing@spectre.test`,  name: "Phase2D Standing Operator"  },
  { role: "authority-operator", email: `${PHASE_2D_FIXTURE_PREFIX}authority@spectre.test`, name: "Phase2D Authority Operator" },
  { role: "release-operator",   email: `${PHASE_2D_FIXTURE_PREFIX}release@spectre.test`,   name: "Phase2D Release Operator"   },
];
const PHASE_2D_REGISTRATION_OID = "00000000-2d2d-2d2d-2d2d-000000000000";

async function phase2dSetup() {
  const bcryptModule = await import("bcryptjs");
  const bcrypt = bcryptModule.default ?? bcryptModule;
  const password = `Phase2D-Fixture-Password-${Date.now()}`;
  const passwordHash = await bcrypt.hash(password, 4); // low rounds for test fixture only

  // Destroy any prior Phase 2D fixtures first.
  await phase2dTeardown({ silent: true });

  // Create the three operator users with SUPER_ADMIN role at
  // clubId=null (platform scope).  Each gets the SAME password so
  // Playwright can log in via a single `password` return value.
  const operators = [];
  for (const spec of PHASE_2D_TRIO) {
    const u = await prisma.user.create({
      data: {
        email: spec.email,
        name: spec.name,
        role: "SUPER_ADMIN",
        passwordHash,
        status: "ACTIVE",
      },
    });
    await prisma.userClubRole.create({
      data: {
        userId: u.id,
        clubId: null,
        roleKey: "SUPER_ADMIN",
      },
    });
    operators.push({ role: spec.role, userId: u.id, email: u.email });
  }

  // Create a HOLD_FOR_REVIEW SignupRegistration + attestation +
  // standing check.  Phase 2B's attestation gate is bypassed by
  // writing directly (the fixture is operator-side only; no
  // applicant interaction).
  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7);
  const token = `${PHASE_2D_FIXTURE_PREFIX}token-${randomBytes(12).toString("base64url")}`;
  const tokenHash = hashToken(token);
  const legalName = "Phase 2D Acceptance Fixture Club";

  const reg = await prisma.signupRegistration.create({
    data: {
      resumeTokenHash: tokenHash,
      legalName,
      legalNameNormalized: legalName.toLowerCase(),
      country: "CA",
      provinceState: "AB",
      addressLine1: "1 Phase2D Lane",
      city: "Fixtureville",
      postalCode: "T0A 0A0",
      adminEmail: `${PHASE_2D_FIXTURE_PREFIX}applicant@spectre.test`,
      adminMicrosoftOid: PHASE_2D_REGISTRATION_OID,
      adminMicrosoftTenantId: "00000000-2d2d-ffff-2d2d-000000000000",
      adminDisplayName: "Phase 2D Applicant",
      adminGivenName: "Phase2D",
      adminSurname: "Applicant",
      adminPosition: "General Manager",
      adminVerifiedAt: now,
      step: "AUTHORITY_ACCEPTED",
      status: "DRAFT",
      ownershipVerificationState: "AUTOMATED_PASSED",
      startedByIp: "127.0.0.1",
      startedUserAgent: "SIGNUP-2 Phase 2D Fixture",
      expiresAt: expires,
      verificationVerdict: "HOLD_FOR_REVIEW",
      verificationDecidedAt: now,
      verificationHoldCategory: "ENTITY_VERIFICATION",
      signingAuthoritySignal: "NONE",
    },
  });

  await prisma.subscriptionAuthorisationAttestation.create({
    data: {
      signupRegistrationId: reg.id,
      clubId: null,
      signatoryFullName: "Phase 2D Fixture Signatory",
      signatoryTitle: "General Manager",
      clubLegalName: legalName,
      attestationTextHash: "ff".repeat(32),
      attestationTextLength: 500,
      termsVersionSha256: "ee".repeat(32),
      termsVersionLabel: "ToS-dev-fixture-2026-10-25",
      acceptedAt: now,
      acceptedIp: "127.0.0.1",
      acceptedUserAgent: "SIGNUP-2 Phase 2D Fixture",
      acceptedByMicrosoftOid: PHASE_2D_REGISTRATION_OID,
      acceptedByMicrosoftTid: "00000000-2d2d-ffff-2d2d-000000000000",
    },
  });

  await prisma.entityStandingCheck.create({
    data: {
      signupRegistrationId: reg.id,
      clubId: null,
      jurisdiction: "CA-AB",
      standing: "MANUAL_REVIEW_REQUIRED",
      officerMatch: null,
      registryPayloadJson: JSON.stringify({ schema: "phase-2c.v1", standing: "MANUAL_REVIEW_REQUIRED", evidenceSource: "stub:manual-review:CA-AB" }),
      fetchedAt: now,
    },
  });

  console.log(JSON.stringify({
    registration: {
      id: reg.id,
      legalName: reg.legalName,
      state: "HOLD_FOR_REVIEW:ENTITY_VERIFICATION",
    },
    operators,
    password, // one-time fixture password; same for all three
    queueUrl: `${BASE_URL}/app/admin/signup-ops`,
    reviewUrl: `${BASE_URL}/app/admin/signup-ops/registration/${reg.id}`,
  }));
}

async function phase2dTeardown({ silent = false } = {}) {
  // Remove the fixture registration (and its cascading rows).
  const regs = await prisma.signupRegistration.findMany({
    where: { adminMicrosoftOid: PHASE_2D_REGISTRATION_OID },
    select: { id: true },
  });
  const regIds = regs.map((r) => r.id);
  if (regIds.length) {
    await prisma.operatorVerificationRecord.deleteMany({ where: { signupRegistrationId: { in: regIds } } });
    await prisma.subscriptionAuthorisationAttestation.deleteMany({ where: { signupRegistrationId: { in: regIds } } });
    await prisma.entityStandingCheck.deleteMany({ where: { signupRegistrationId: { in: regIds } } });
    await prisma.signupRecoveryLink.deleteMany({ where: { registrationId: { in: regIds } } });
    await prisma.signupOAuthTransaction.deleteMany({ where: { registrationId: { in: regIds } } });
    await prisma.signupRegistration.deleteMany({ where: { id: { in: regIds } } });
  }
  // Remove the three operator identities.
  const emails = PHASE_2D_TRIO.map((s) => s.email);
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.userClubRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (!silent) {
    console.log(JSON.stringify({
      destroyedRegistrations: regIds.length,
      destroyedOperators: userIds.length,
    }));
  }
}

// ---------------------------------------------------------------
// SIGNUP-2 Phase 2F (2026-10-26) staging-acceptance follow-up.
//
// phase2f-seed <scenario>  -- seeds a complete MOCK-BACKED chain so
// the Playwright spec can exercise the sweep endpoint against
// deterministic input:
//
//   happy-mock       -- all 9 gates pass against mock evidence
//                        (requires testOnly=1 at sweep time).
//   reverse-pre-auth -- same shape; cycle.reversedAt is set.
//                        Sweep refuses with G2_REVERSED.
//   reverse-post-auth-- same shape; sweep authorises; then the
//                        fixture flips reversedAt; Playwright
//                        calls invalidateActivationAuthorisation
//                        and asserts the job's invalidatedAt is set.
//   tos-mismatch     -- attestation.termsVersionSha256 is set to
//                        a non-matching value.  Sweep refuses
//                        with G7_TOS_MISMATCH.
//
// Every scenario uses a distinct Microsoft oid so the Playwright
// can address rows independently.  Teardown is idempotent.
// ---------------------------------------------------------------

const PHASE_2F_FIXTURE_PREFIX = "signup-2f-fixture-";
const PHASE_2F_SCENARIOS = {
  "happy-mock": { oid: "00000000-2f2f-happy-2f2f-000000000000", reversed: false, tosMismatch: false },
  "reverse-pre-auth": { oid: "00000000-2f2f-rpre-2f2f-000000000000", reversed: true, tosMismatch: false },
  "reverse-post-auth": { oid: "00000000-2f2f-rpost-2f2f-000000000000", reversed: false, tosMismatch: false },
  "tos-mismatch": { oid: "00000000-2f2f-tosmm-2f2f-000000000000", oidTail: "tosmm", reversed: false, tosMismatch: true },
};

async function phase2fSeed(scenario) {
  const spec = PHASE_2F_SCENARIOS[scenario];
  if (!spec) {
    console.error(`[phase2f-seed] unknown scenario: ${scenario}`);
    process.exit(2);
  }

  // Clean prior state for this scenario first (idempotent).
  await phase2fTeardownScenario(scenario, { silent: true });

  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7);
  const legalName = `Phase 2F Acceptance Fixture Club (${scenario})`;

  const reg = await prisma.signupRegistration.create({
    data: {
      resumeTokenHash: hashToken(generateFixtureToken() + scenario),
      legalName,
      legalNameNormalized: legalName.toLowerCase(),
      country: "CA",
      provinceState: "AB",
      addressLine1: "1 Phase 2F Lane",
      city: "Fixtureville",
      postalCode: "T0A 0A0",
      adminEmail: `${PHASE_2F_FIXTURE_PREFIX}${scenario}-applicant@spectre.test`,
      adminMicrosoftOid: spec.oid,
      adminMicrosoftTenantId: "00000000-2f2f-ffff-2f2f-000000000000",
      adminDisplayName: `Phase 2F Fixture ${scenario}`,
      adminGivenName: "Phase2F",
      adminSurname: scenario,
      adminPosition: "General Manager",
      adminVerifiedAt: now,
      step: "AUTHORITY_ACCEPTED",
      status: "DRAFT",
      ownershipVerificationState: "AUTOMATED_PASSED",
      startedByIp: "127.0.0.1",
      startedUserAgent: "SIGNUP-2 Phase 2F Fixture",
      expiresAt: expires,
      verificationVerdict: "MANUAL_RELEASE",
      verificationDecidedAt: now,
      verificationHoldCategory: null,
      signingAuthoritySignal: "OPERATOR_RELEASE",
    },
  });

  // Phase 2B attestation.  Tos SHA matches dev fixture by default;
  // tos-mismatch scenario deliberately uses the wrong SHA.
  const devFixtureSha = await (async () => {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { createHash } = await import("node:crypto");
      const p = path.resolve(process.cwd(), "docs", "legal", "terms-of-service-fixture-dev.md");
      if (fs.existsSync(p)) {
        const body = fs.readFileSync(p, "utf8");
        return createHash("sha256").update(body, "utf8").digest("hex");
      }
    } catch {}
    return "ee".repeat(32);
  })();
  const attestationTosSha = spec.tosMismatch ? "ff".repeat(32) : devFixtureSha;

  await prisma.subscriptionAuthorisationAttestation.create({
    data: {
      signupRegistrationId: reg.id,
      clubId: null,
      signatoryFullName: `Phase 2F Fixture Signatory ${scenario}`,
      signatoryTitle: "General Manager",
      clubLegalName: legalName,
      attestationTextHash: "aa".repeat(32),
      attestationTextLength: 500,
      termsVersionSha256: attestationTosSha,
      termsVersionLabel: "ToS-dev-fixture-2026-10-25",
      acceptedAt: now,
      acceptedIp: "127.0.0.1",
      acceptedUserAgent: "SIGNUP-2 Phase 2F Fixture",
      acceptedByMicrosoftOid: spec.oid,
      acceptedByMicrosoftTid: "00000000-2f2f-ffff-2f2f-000000000000",
    },
  });

  // Phase 2D RELEASE record (three operator records: standing /
  // authority / release -- the Phase 2F gate only reads the RELEASE
  // row, so this is the minimum needed).
  const releaseOperatorId = `fixture-op-release-${scenario}`;
  const releaseRecord = await prisma.operatorVerificationRecord.create({
    data: {
      signupRegistrationId: reg.id,
      concept: "RELEASE",
      finding: "AUTHORISED",
      operatorUserId: releaseOperatorId,
      verifiedAt: now,
      reason: `Phase 2F fixture release (${scenario})`,
    },
  });

  // Phase 2E mandate.
  await prisma.subscriptionPaymentMandate.create({
    data: {
      signupRegistrationId: reg.id,
      stripeMandateId: `mandate_mock_${scenario}_${reg.id.slice(-6)}`,
      stripePaymentMethodId: `pm_mock_${scenario}_${reg.id.slice(-6)}`,
      mandateType: "ACSS_DEBIT",
      mandateVariant: "INTERVAL",
      transactionType: "BUSINESS",
      acceptedAt: now,
      mandateTextHash: "bb".repeat(32),
      mandateTextLength: 500,
    },
  });

  // Create a staging-fixture Club row so the BillingCycle FK is
  // satisfied.  Same pattern as Phase 2D's synthetic SUPER_ADMIN
  // User rows: well-known fixture artefact + torn down after the
  // acceptance window.  NOT a real tenant -- `stagingDataMode =
  // "SYNTHETIC_DEMO"` marks it + the slug prefix `signup-2f-fixture-`
  // keeps teardown scoped.  A Phase 2G real tenant would re-use
  // the registration-id → Club shell mapping and this fixture row
  // would never collide (fixture Clubs are destroyed before any
  // Phase 2G run).
  const fixtureClubSlug = `signup-2f-fixture-${scenario}-${reg.id.slice(-8)}`.toLowerCase();
  const fixtureClub = await prisma.club.create({
    data: {
      slug: fixtureClubSlug,
      name: `Phase 2F Fixture Club (${scenario})`,
      region: "AB",
      salesTaxRegion: "GST",
      foundedYear: 2026,
      timezone: "America/Edmonton",
      stagingDataMode: "SYNTHETIC_DEMO",
    },
  });

  // Phase 2E BillingCycle in ACTIVATION_READY (mock-backed; the
  // Phase 2F sweep + authoriseActivation will re-fetch via the
  // mock adapter which always returns status="available").
  await prisma.billingCycle.create({
    data: {
      clubId: fixtureClub.id,
      periodLabel: `signup-2f-fixture-${scenario}-${reg.id.slice(-8)}`,
      startDate: now,
      endDate: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      totalDue: 38000.00,
      totalPaid: 38000.00,
      status: "OPEN",
      subscriptionStatus: "ACTIVATION_READY",
      source: "STRIPE_ACSS",
      stripePaymentIntentId: `pi_mock_${scenario}_${reg.id.slice(-6)}`,
      stripeChargeId: `ch_mock_${scenario}_${reg.id.slice(-6)}`,
      stripeBalanceTransactionId: `btxn_mock_${scenario}_${reg.id.slice(-6)}`,
      expectedDebitDate: now,
      settlementConfirmedAt: now,
      releasedByOperatorRecordId: releaseRecord.id,
      ...(spec.reversed ? { reversedAt: now, reversalReason: "fixture-pre-reverse" } : {}),
    },
  });

  console.log(JSON.stringify({
    scenario,
    registrationId: reg.id,
    adminMicrosoftOid: spec.oid,
    legalName,
    releaseRecordId: releaseRecord.id,
  }));
}

async function phase2fTeardownScenario(scenario, { silent = false } = {}) {
  const spec = PHASE_2F_SCENARIOS[scenario];
  if (!spec) {
    if (!silent) console.log(JSON.stringify({ destroyed: 0 }));
    return;
  }
  const regs = await prisma.signupRegistration.findMany({
    where: { adminMicrosoftOid: spec.oid },
    select: { id: true },
  });
  const ids = regs.map((r) => r.id);
  // Find all Phase 2F fixture Clubs for this scenario (slug prefix).
  const fixtureClubs = await prisma.club.findMany({
    where: { slug: { startsWith: `signup-2f-fixture-${scenario}-` } },
    select: { id: true },
  });
  const clubIds = fixtureClubs.map((c) => c.id);

  if (ids.length === 0 && clubIds.length === 0) {
    if (!silent) console.log(JSON.stringify({ destroyed: 0 }));
    return;
  }

  // Clean dependent rows first.  BillingCycle rows reference the
  // fixture Clubs; TenantProvisioningJob rows reference the cycles.
  if (clubIds.length) {
    await prisma.tenantProvisioningJob.deleteMany({
      where: { billingCycle: { clubId: { in: clubIds } } },
    });
    await prisma.paymentReconciliationEntry.deleteMany({ where: { clubId: { in: clubIds } } });
    await prisma.operatorInboxEntry.deleteMany({ where: { clubId: { in: clubIds } } });
    await prisma.billingCycle.deleteMany({ where: { clubId: { in: clubIds } } });
  }
  if (ids.length) {
    await prisma.subscriptionPaymentMandate.deleteMany({ where: { signupRegistrationId: { in: ids } } });
    await prisma.operatorVerificationRecord.deleteMany({ where: { signupRegistrationId: { in: ids } } });
    await prisma.subscriptionAuthorisationAttestation.deleteMany({ where: { signupRegistrationId: { in: ids } } });
    await prisma.entityStandingCheck.deleteMany({ where: { signupRegistrationId: { in: ids } } });
    await prisma.signupRecoveryLink.deleteMany({ where: { registrationId: { in: ids } } });
    await prisma.signupOAuthTransaction.deleteMany({ where: { registrationId: { in: ids } } });
    await prisma.signupRegistration.deleteMany({ where: { id: { in: ids } } });
  }
  if (clubIds.length) {
    await prisma.club.deleteMany({ where: { id: { in: clubIds } } });
  }
  if (!silent) console.log(JSON.stringify({ destroyed: ids.length, destroyedClubs: clubIds.length }));
}

async function phase2fTeardownAll() {
  let total = 0;
  for (const key of Object.keys(PHASE_2F_SCENARIOS)) {
    await phase2fTeardownScenario(key, { silent: true });
    total++;
  }
  console.log(JSON.stringify({ scenariosDestroyed: total }));
}

async function phase2fReverse(scenario) {
  const spec = PHASE_2F_SCENARIOS[scenario];
  if (!spec) {
    console.error(`[phase2f-reverse] unknown scenario: ${scenario}`);
    process.exit(2);
  }
  const fixtureClubs = await prisma.club.findMany({
    where: { slug: { startsWith: `signup-2f-fixture-${scenario}-` } },
    select: { id: true },
  });
  const clubIds = fixtureClubs.map((c) => c.id);
  const now = new Date();
  const result = await prisma.billingCycle.updateMany({
    where: { clubId: { in: clubIds }, reversedAt: null },
    data: { reversedAt: now, reversalReason: "fixture-post-reverse", subscriptionStatus: "REVERSED" },
  });
  console.log(JSON.stringify({ reversed: result.count }));
}

async function phase2fInspectJob(scenario) {
  const spec = PHASE_2F_SCENARIOS[scenario];
  if (!spec) {
    console.error(`[phase2f-inspect] unknown scenario: ${scenario}`);
    process.exit(2);
  }
  const fixtureClubs = await prisma.club.findMany({
    where: { slug: { startsWith: `signup-2f-fixture-${scenario}-` } },
    select: { id: true },
  });
  const clubIds = fixtureClubs.map((c) => c.id);
  const job = await prisma.tenantProvisioningJob.findFirst({
    where: { billingCycle: { clubId: { in: clubIds } } },
    select: {
      id: true,
      state: true,
      authorisationEvidenceSource: true,
      authorisationExpiresAt: true,
      invalidatedAt: true,
      invalidatedReason: true,
      cancelledAt: true,
      cancelReason: true,
    },
  });
  console.log(JSON.stringify({ job }));
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
  } else if (action === "super-admin-list") {
    await listSuperAdmins();
  } else if (action === "phase2d-setup") {
    await phase2dSetup();
  } else if (action === "phase2d-teardown") {
    await phase2dTeardown();
  } else if (action === "phase2f-seed") {
    const scenario = process.argv[3];
    if (!scenario) {
      console.error("Usage: ... phase2f-seed <happy-mock|reverse-pre-auth|reverse-post-auth|tos-mismatch>");
      process.exit(2);
    }
    await phase2fSeed(scenario);
  } else if (action === "phase2f-teardown") {
    const scenario = process.argv[3];
    if (scenario) {
      await phase2fTeardownScenario(scenario);
    } else {
      await phase2fTeardownAll();
    }
  } else if (action === "phase2f-reverse") {
    const scenario = process.argv[3];
    if (!scenario) {
      console.error("Usage: ... phase2f-reverse <scenario>");
      process.exit(2);
    }
    await phase2fReverse(scenario);
  } else if (action === "phase2f-inspect") {
    const scenario = process.argv[3];
    if (!scenario) {
      console.error("Usage: ... phase2f-inspect <scenario>");
      process.exit(2);
    }
    await phase2fInspectJob(scenario);
  } else {
    console.error("Usage: node scripts/signup-2-phase-2b-staging-fixture.mjs {create|destroy|verify|phase2c-create|phase2c-destroy|phase2c-verdict|super-admin-list|phase2d-setup|phase2d-teardown}");
    process.exit(2);
  }
}

main()
  .catch((err) => {
    console.error("[signup-2-phase-2b-staging-fixture]", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
