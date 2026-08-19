// HR-1H (2026-08-16): generic audit-layer defense-in-depth.
//
// Canonical HR services in src/lib/hr/** never pass plaintext SIN /
// bank / tax field names to audit() — that discipline is already
// verified by tests/hr/cross-cutting/audit-plaintext-leak-sweep.test.ts
// and each per-slice audit test. This file separately verifies the
// SECOND LINE OF DEFENSE: if a future contributor mistakenly hands
// the generic audit() call a raw sensitive payload, the audit-layer's
// SENSITIVE_KEYS set redacts it before persistence.
//
// This is NOT permission to start passing plaintext through the audit
// service — the invariant remains: canonical services pre-redact.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac, principalFor, makeUser, makeClub } from "../../util/db";

async function latestAuditRow(action: string) {
  return prisma.auditLog.findFirst({
    where: { action },
    orderBy: { createdAt: "desc" },
  });
}

function bodyText(row: { beforeJson: string | null; afterJson: string | null; metaJson: string | null } | null) {
  if (!row) return "";
  return `${row.beforeJson ?? ""}\n${row.afterJson ?? ""}\n${row.metaJson ?? ""}`;
}

describe("HR-1H generic audit-layer redaction (defense-in-depth)", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("redacts HR plaintext field names passed directly to audit()", async () => {
    const club = await makeClub("A");
    await makeUser({ email: "admin@example.com", role: "CLUB_ADMIN", clubId: club.id });
    const p = await principalFor("admin@example.com");

    const PLAINTEXT_SIN = "123456789";
    const PLAINTEXT_INSTITUTION = "003";
    const PLAINTEXT_TRANSIT = "12345";
    const PLAINTEXT_ACCOUNT = "9876543210";
    const PLAINTEXT_FEDERAL = "15705.00";
    const PLAINTEXT_PROVINCIAL = "12399.00";
    const PLAINTEXT_ADDITIONAL = "50.00";

    await audit(p, {
      action: "hr._probe.contributor_mistake.update",
      entityType: "HRProbe",
      clubId: club.id,
      before: null,
      after: {
        sin: PLAINTEXT_SIN,
        institutionNumber: PLAINTEXT_INSTITUTION,
        transitNumber: PLAINTEXT_TRANSIT,
        accountNumber: PLAINTEXT_ACCOUNT,
        federalClaim: PLAINTEXT_FEDERAL,
        provincialClaim: PLAINTEXT_PROVINCIAL,
        additionalDeductions: PLAINTEXT_ADDITIONAL,
        additionalDeduction: PLAINTEXT_ADDITIONAL,
        holderName: "River Sensitive",
        employeeName: "River Sensitive",
      },
    });

    const row = await latestAuditRow("hr._probe.contributor_mistake.update");
    expect(row).toBeTruthy();
    const text = bodyText(row);
    // Every plaintext value must be absent — replaced by "[redacted]".
    expect(text).not.toContain(PLAINTEXT_SIN);
    expect(text).not.toContain(PLAINTEXT_INSTITUTION);
    expect(text).not.toContain(PLAINTEXT_TRANSIT);
    expect(text).not.toContain(PLAINTEXT_ACCOUNT);
    expect(text).not.toContain(PLAINTEXT_FEDERAL);
    expect(text).not.toContain(PLAINTEXT_PROVINCIAL);
    expect(text).not.toContain(PLAINTEXT_ADDITIONAL);
    expect(text).toContain("[redacted]");
    // Non-sensitive fields remain visible for operational readability.
    expect(text).toContain("River Sensitive");
  });

  it("redacts *SecretRef ciphertext blob field names (noise + key-rotation hygiene)", async () => {
    const club = await makeClub("A");
    await makeUser({ email: "admin@example.com", role: "CLUB_ADMIN", clubId: club.id });
    const p = await principalFor("admin@example.com");

    const FAKE_SIN_CIPHER = "enc:local:v1:AAAA_should_never_land_in_audit";
    const FAKE_INSTITUTION_CIPHER = "enc:local:v1:BBBB";
    const FAKE_TRANSIT_CIPHER = "enc:local:v1:CCCC";
    const FAKE_ACCOUNT_CIPHER = "enc:local:v1:DDDD";
    const FAKE_FEDERAL_CIPHER = "enc:local:v1:EEEE";
    const FAKE_PROVINCIAL_CIPHER = "enc:local:v1:FFFF";
    const FAKE_ADDITIONAL_CIPHER = "enc:local:v1:GGGG";
    const FAKE_ADDITIONAL_ALT_CIPHER = "enc:local:v1:HHHH";

    await audit(p, {
      action: "hr._probe.ciphertext_mistake.update",
      entityType: "HRProbe",
      clubId: club.id,
      after: {
        sinSecretRef: FAKE_SIN_CIPHER,
        institutionSecretRef: FAKE_INSTITUTION_CIPHER,
        transitSecretRef: FAKE_TRANSIT_CIPHER,
        accountSecretRef: FAKE_ACCOUNT_CIPHER,
        federalClaimSecretRef: FAKE_FEDERAL_CIPHER,
        provincialClaimSecretRef: FAKE_PROVINCIAL_CIPHER,
        additionalDeductionSecretRef: FAKE_ADDITIONAL_CIPHER,
        additionalDeductionsSecretRef: FAKE_ADDITIONAL_ALT_CIPHER,
        status: "PENDING_PENNY_TEST",
      },
    });

    const row = await latestAuditRow("hr._probe.ciphertext_mistake.update");
    expect(row).toBeTruthy();
    const text = bodyText(row);
    expect(text).not.toContain(FAKE_SIN_CIPHER);
    expect(text).not.toContain(FAKE_INSTITUTION_CIPHER);
    expect(text).not.toContain(FAKE_TRANSIT_CIPHER);
    expect(text).not.toContain(FAKE_ACCOUNT_CIPHER);
    expect(text).not.toContain(FAKE_FEDERAL_CIPHER);
    expect(text).not.toContain(FAKE_PROVINCIAL_CIPHER);
    expect(text).not.toContain(FAKE_ADDITIONAL_CIPHER);
    expect(text).not.toContain(FAKE_ADDITIONAL_ALT_CIPHER);
    // Non-sensitive operational metadata still visible.
    expect(text).toContain("PENDING_PENNY_TEST");
  });

  it("does not over-redact operational metadata (accountLastFour, holderName, status stay visible)", async () => {
    const club = await makeClub("A");
    await makeUser({ email: "admin@example.com", role: "CLUB_ADMIN", clubId: club.id });
    const p = await principalFor("admin@example.com");

    await audit(p, {
      action: "hr._probe.operational_metadata.update",
      entityType: "HRProbe",
      clubId: club.id,
      after: {
        accountLastFour: "7890",
        sinLastThree: "789",
        holderName: "River Payroll",
        status: "VERIFIED",
        activatedAt: new Date("2026-08-16T12:00:00Z").toISOString(),
        employmentType: "FULL_TIME",
      },
    });

    const row = await latestAuditRow("hr._probe.operational_metadata.update");
    const text = bodyText(row);
    expect(text).toContain("7890");
    expect(text).toContain("789");
    expect(text).toContain("River Payroll");
    expect(text).toContain("VERIFIED");
    expect(text).toContain("FULL_TIME");
  });

  it("pre-HR sensitive keys (password, mfaSecret, cvv) still redact — regression check", async () => {
    const club = await makeClub("A");
    await makeUser({ email: "admin@example.com", role: "CLUB_ADMIN", clubId: club.id });
    const p = await principalFor("admin@example.com");

    await audit(p, {
      action: "_probe.pre_hr_sensitive.update",
      entityType: "Probe",
      clubId: club.id,
      after: {
        password: "SuperSecret!",
        passwordHash: "$2b$10$xxxxxxxxxxxxxxxxxxxx",
        mfaSecret: "OTPAUTH:base32secret",
        cvv: "421",
        cardNumber: "4111111111111111",
        username: "carla",
      },
    });

    const row = await latestAuditRow("_probe.pre_hr_sensitive.update");
    const text = bodyText(row);
    expect(text).not.toContain("SuperSecret!");
    expect(text).not.toContain("$2b$10$xxxxxxxxxxxxxxxxxxxx");
    expect(text).not.toContain("OTPAUTH:base32secret");
    expect(text).not.toContain("421");
    expect(text).not.toContain("4111111111111111");
    expect(text).toContain("carla");
  });
});
