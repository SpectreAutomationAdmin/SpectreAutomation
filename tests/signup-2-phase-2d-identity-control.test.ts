// SIGNUP-2 Phase 2D identity-control correction (2026-10-26).
//
// Verifies the self-approval comparator's amended normalisation per
// founder §3 of the Phase 2E planning authorisation:
//
//   "Where available, use stable authenticated identity as the
//    primary self-approval comparison, with normalized email
//    equality as an additional safeguard."
//
// Operators do not carry Microsoft `oid` on the User row today;
// email remains the only shared identifier.  The correction
// aggressively normalises both emails before comparing.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normaliseEmailForComparison } from "@/lib/signup/operator-verification";

const ROOT = process.cwd();
const SERVICE = readFileSync(join(ROOT, "src/lib/signup/operator-verification.ts"), "utf8");

describe("SIGNUP-2 Phase 2D · email normaliser (self-approval comparator)", () => {
  it("lowercases + trims", () => {
    expect(normaliseEmailForComparison("  Foo@Club.COM  ")).toBe("foo@club.com");
  });

  it("strips plus-tag", () => {
    expect(normaliseEmailForComparison("foo+ops@club.com")).toBe("foo@club.com");
    expect(normaliseEmailForComparison("Foo+Any.Thing+MULTIPLE@club.com")).toBe("foo@club.com");
  });

  it("returns null for null / empty / undefined", () => {
    expect(normaliseEmailForComparison(null)).toBeNull();
    expect(normaliseEmailForComparison(undefined)).toBeNull();
    expect(normaliseEmailForComparison("")).toBeNull();
    expect(normaliseEmailForComparison("   ")).toBeNull();
  });

  it("accepts non-email strings as-is (no @ sign)", () => {
    // Defensive fall-through: a malformed value is compared raw so
    // the comparator never widens a match it didn't deserve.
    expect(normaliseEmailForComparison("no-at-sign")).toBe("no-at-sign");
  });

  it("preserves the domain portion verbatim (no plus-tag stripping on domain side)", () => {
    expect(normaliseEmailForComparison("foo@sub.plus+tag.com")).toBe("foo@sub.plus+tag.com");
  });

  it("foo+ops@club.com and foo@club.com normalise equal (plus-tag bypass defeated)", () => {
    expect(normaliseEmailForComparison("foo+ops@club.com")).toBe(normaliseEmailForComparison("foo@club.com"));
  });

  it("case-only differences normalise equal", () => {
    expect(normaliseEmailForComparison("Foo@Club.COM")).toBe(normaliseEmailForComparison("foo@club.com"));
  });

  it("distinct mailboxes DO NOT normalise equal", () => {
    expect(normaliseEmailForComparison("alice@club.com")).not.toBe(normaliseEmailForComparison("bob@club.com"));
    expect(normaliseEmailForComparison("alice@a.com")).not.toBe(normaliseEmailForComparison("alice@b.com"));
  });
});

describe("SIGNUP-2 Phase 2D · service uses the normaliser in assertNotApplicant", () => {
  it("assertNotApplicant calls normaliseEmailForComparison on BOTH sides", () => {
    const block = SERVICE.match(/function assertNotApplicant[\s\S]+?^}/m);
    expect(block, "assertNotApplicant not found").not.toBeNull();
    expect(block![0]).toMatch(/normaliseEmailForComparison\(principal\.email\)/);
    expect(block![0]).toMatch(/normaliseEmailForComparison\(reg\.adminEmail\)/);
  });

  it("refuses when the registration has no admin email on file (incomplete registration)", () => {
    expect(SERVICE).toMatch(/Registration has no admin email on file/);
  });

  it("refuses when the operator session has no email (defensive)", () => {
    expect(SERVICE).toMatch(/Operator session has no email/);
  });

  it("still does NOT rely on Microsoft tenant-ID inequality (founder §3A preserved)", () => {
    // Documentation references to tenant-ID equality are permitted
    // (the comment explicitly explains what we DON'T do); what we
    // forbid is any COMPARISON against tenantId.
    const block = SERVICE.match(/function assertNotApplicant[\s\S]+?^}/m)!;
    expect(block[0]).not.toMatch(/tenantId\s*(?:===|!==|==|!=)/);
    expect(block[0]).not.toMatch(/adminMicrosoftTenantId\s*(?:===|!==|==|!=)/);
  });

  it("documents the forward-looking Microsoft-OID comparator path for Phase 2H", () => {
    expect(SERVICE).toMatch(/Phase-2H slice/);
    expect(SERVICE).toMatch(/microsoftOid/);
  });
});
