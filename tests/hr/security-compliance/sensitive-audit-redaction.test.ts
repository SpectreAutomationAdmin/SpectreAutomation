// HR-1 security-compliance slice — cross-cut audit redaction.
//
// The generic audit serializer's SENSITIVE_KEYS set covers only
// `passwordHash`, `password`, `mfaSecret`, `cardNumber`, `cvv`,
// `accountNumber`, `ssn`, `sin`. It does NOT cover
// `institutionNumber`, `transitNumber`, `federalClaim`,
// `provincialClaim`, `additionalDeductions`, or the raw plaintext
// digits themselves.
//
// Therefore the HR services MUST pre-redact — by only threading the
// masked helper / last-N suffix into audit before/after/meta. This
// suite scans the persisted AuditLog rows after each reveal / write
// operation and asserts the plaintext never appears.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { upsertSin, revealSin } from "@/lib/hr/sensitive-identity";
import { upsertBankAccount, revealBankAccount, activateBankAccount } from "@/lib/hr/bank-account";
import { upsertTaxProfile, revealTaxProfile } from "@/lib/hr/tax-profile";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "./_helpers";

const PLAINTEXT_SIN = "987654321";
const INSTITUTION = "003";
const TRANSIT = "12345";
const ACCOUNT = "9876543210";
const FEDERAL = "16000.00";
const PROVINCIAL = "13000.00";
const ADDITIONAL = "75.00";

function stringifyAllHrAudit(): Promise<string> {
  return prisma.auditLog
    .findMany({
      where: { action: { startsWith: "hr." } },
      orderBy: { createdAt: "desc" },
    })
    .then((rows) =>
      rows
        .map((r) => `${r.action}|${r.beforeJson ?? ""}|${r.afterJson ?? ""}|${r.metaJson ?? ""}`)
        .join("\n"),
    );
}

describe("HR audit redaction — plaintext never in AuditLog", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("SIN write + reveal do not leak plaintext SIN into any audit column", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    await upsertSin(payrollAdmin, employee.id, PLAINTEXT_SIN);
    await revealSin(payrollAdmin, employee.id);
    const text = await stringifyAllHrAudit();
    expect(text.includes(PLAINTEXT_SIN)).toBe(false);
    // The full 9-digit string must never appear — including in any
    // subset (test the middle 6 digits also).
    expect(text.includes("87654321")).toBe(false);
  });

  it("Bank write + activate + reveal do not leak plaintext institution/transit/account", async () => {
    const { employee, payrollAdmin, clubAdmin } = await makeHrFixture();
    await upsertBankAccount(payrollAdmin, employee.id, {
      institutionNumber: INSTITUTION,
      transitNumber: TRANSIT,
      accountNumber: ACCOUNT,
      holderName: "River Sensitive",
    });
    await activateBankAccount(clubAdmin, employee.id);
    await revealBankAccount(payrollAdmin, employee.id);
    const text = await stringifyAllHrAudit();
    // The transit number and full account must not appear anywhere.
    expect(text.includes(TRANSIT)).toBe(false);
    expect(text.includes(ACCOUNT)).toBe(false);
    // Institution number is short (3 digits) — verify by full-string
    // match on the field name, not the digit substring (which could
    // trivially appear inside timestamps).
    expect(text.includes(`"institutionNumber"`)).toBe(false);
    expect(text.includes(`"transitNumber"`)).toBe(false);
    expect(text.includes(`"accountNumber"`)).toBe(false);
  });

  it("Tax write + reveal do not leak plaintext claim amounts into any audit column", async () => {
    const { employee, payrollAdmin } = await makeHrFixture();
    const row = await upsertTaxProfile(payrollAdmin, employee.id, {
      province: "ON",
      td1FormVersion: "2026-01",
      effectiveFrom: new Date("2026-01-01"),
      federalClaim: FEDERAL,
      provincialClaim: PROVINCIAL,
      additionalDeductions: ADDITIONAL,
    });
    await revealTaxProfile(payrollAdmin, row.id);
    const text = await stringifyAllHrAudit();
    expect(text.includes(FEDERAL)).toBe(false);
    expect(text.includes(PROVINCIAL)).toBe(false);
    expect(text.includes(ADDITIONAL)).toBe(false);
    // Also check the field names never appear as audit payload keys.
    expect(text.includes(`"federalClaim"`)).toBe(false);
    expect(text.includes(`"provincialClaim"`)).toBe(false);
    expect(text.includes(`"additionalDeductions"`)).toBe(false);
  });
});
