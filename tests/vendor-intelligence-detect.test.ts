// Sprint 3 Checkpoint 15F (2026-07-24) — Duplicate detection tests.

import { describe, expect, it } from "vitest";
import { detectDuplicate, findDuplicatePairsInBatch, type VendorForDetection } from "@/lib/vendor-intelligence/duplicate-detect";
import { recommendCanonical, type CanonicalCandidate } from "@/lib/vendor-intelligence/canonical";

function makeVendor(overrides: Partial<VendorForDetection["vendor"]> & { id: string; legalName: string }, ctx: Partial<Omit<VendorForDetection, "vendor">> = {}): VendorForDetection {
  return {
    vendor: {
      id: overrides.id,
      legalName: overrides.legalName,
      operatingName: overrides.operatingName ?? null,
      taxRegistrationNumber: overrides.taxRegistrationNumber ?? null,
      email: overrides.email ?? null,
      website: overrides.website ?? null,
      phone: overrides.phone ?? null,
      address1: overrides.address1 ?? null,
      postalCode: overrides.postalCode ?? null,
      defaultExpenseAccountId: overrides.defaultExpenseAccountId ?? null,
      status: overrides.status ?? "ACTIVE",
    },
    contacts: ctx.contacts ?? [],
    historicalInvoiceReferences: ctx.historicalInvoiceReferences ?? [],
    hasBanking: ctx.hasBanking ?? false,
    activeBankingAccountLast4: ctx.activeBankingAccountLast4 ?? null,
  };
}

describe("detectDuplicate — CONFIRMED_DUPLICATE (2 strong signals)", () => {
  it("tax number + website domain both match", () => {
    const a = makeVendor({ id: "a", legalName: "Northside Inc.", taxRegistrationNumber: "123456789RT0001", website: "https://northside.com" });
    const b = makeVendor({ id: "b", legalName: "Northside Ltd.", taxRegistrationNumber: "123 456 789 RT 0001", website: "www.northside.com" });
    const det = detectDuplicate(a, b);
    expect(det.state).toBe("CONFIRMED_DUPLICATE");
    expect(det.matchSignals.map((m) => m.ruleKey)).toEqual(expect.arrayContaining(["match.tax_number_exact", "match.website_domain_exact"]));
  });
});

describe("detectDuplicate — LIKELY_DUPLICATE (1 strong + 1 supporting)", () => {
  it("tax number match + email domain match (SUPPORTING)", () => {
    const a = makeVendor({ id: "a", legalName: "Northside", taxRegistrationNumber: "123456789RT0001", email: "b@northside.com" });
    const b = makeVendor({ id: "b", legalName: "Northside Corp", taxRegistrationNumber: "123456789RT0001", email: "billing@northside.com" });
    const det = detectDuplicate(a, b);
    expect(det.state).toBe("LIKELY_DUPLICATE");
  });
});

describe("detectDuplicate — POSSIBLE_DUPLICATE (supporting-only)", () => {
  it("only legal name normalised match", () => {
    const a = makeVendor({ id: "a", legalName: "Premium Foods Co." });
    const b = makeVendor({ id: "b", legalName: "Premium Foods Co" });
    const det = detectDuplicate(a, b);
    expect(det.state).toBe("POSSIBLE_DUPLICATE");
  });
});

describe("detectDuplicate — CONFLICT_REQUIRES_REVIEW", () => {
  it("tax numbers DIFFER + legal names differ → blocking conflict", () => {
    const a = makeVendor({ id: "a", legalName: "Northside Inc.", taxRegistrationNumber: "111111111RT0001", operatingName: "Northside" });
    const b = makeVendor({ id: "b", legalName: "Southside Inc.", taxRegistrationNumber: "222222222RT0001", operatingName: "Southside" });
    const det = detectDuplicate(a, b);
    expect(det.state).toBe("CONFLICT_REQUIRES_REVIEW");
    expect(det.conflictSignals.map((c) => c.ruleKey)).toContain("conflict.tax_number_differs");
  });
  it("banking DIFFERS blocks merge even if other signals match", () => {
    const a = makeVendor({ id: "a", legalName: "Northside", email: "b@northside.com" }, { hasBanking: true, activeBankingAccountLast4: "1234" });
    const b = makeVendor({ id: "b", legalName: "Northside", email: "b@northside.com" }, { hasBanking: true, activeBankingAccountLast4: "5678" });
    const det = detectDuplicate(a, b);
    expect(det.state).toBe("CONFLICT_REQUIRES_REVIEW");
    expect(det.conflictSignals.map((c) => c.ruleKey)).toContain("conflict.banking_differs");
  });
});

describe("detectDuplicate — DISTINCT_VENDOR", () => {
  it("no matching signals at all", () => {
    const a = makeVendor({ id: "a", legalName: "Alpha Co", email: "a@alpha.com" });
    const b = makeVendor({ id: "b", legalName: "Bravo LLC", email: "b@bravo.com" });
    const det = detectDuplicate(a, b);
    expect(det.state).toBe("DISTINCT_VENDOR");
  });
  it("same vendor id returns DISTINCT with explanation", () => {
    const a = makeVendor({ id: "a", legalName: "X" });
    const det = detectDuplicate(a, a);
    expect(det.state).toBe("DISTINCT_VENDOR");
    expect(det.explanation).toMatch(/itself/);
  });
});

describe("findDuplicatePairsInBatch", () => {
  it("only returns non-DISTINCT pairs and never repeats (i,j) with (j,i)", () => {
    const vendors = [
      makeVendor({ id: "1", legalName: "Northside Inc.", taxRegistrationNumber: "111RT0001", website: "https://northside.com" }),
      makeVendor({ id: "2", legalName: "Northside Ltd", taxRegistrationNumber: "111RT0001", website: "northside.com" }),
      makeVendor({ id: "3", legalName: "Different Company" }),
    ];
    const pairs = findDuplicatePairsInBatch(vendors);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].detection.state).toBe("CONFIRMED_DUPLICATE");
    expect(pairs[0].a).toBe("1");
    expect(pairs[0].b).toBe("2");
  });
});

describe("recommendCanonical", () => {
  const base = { status: "ACTIVE", createdAt: new Date("2020-01-01"), hasVerifiedBanking: false, hasTaxNumber: false, hasEmail: false, contactCount: 0, hasDefaultExpenseAccount: false, hasDefaultDepartment: false, invoiceCount: 0, paymentCount: 0, documentCount: 0 };

  it("returns RECOMMENDED with clear winner when scores differ ≥ 3", () => {
    const cands: CanonicalCandidate[] = [
      { ...base, id: "richer",  legalName: "R", invoiceCount: 10, hasVerifiedBanking: true, hasTaxNumber: true, hasEmail: true },
      { ...base, id: "sparser", legalName: "S", createdAt: new Date("2022-01-01") },
    ];
    const rec = recommendCanonical(cands);
    expect(rec.state).toBe("RECOMMENDED");
    expect(rec.recommendedVendorId).toBe("richer");
  });
  it("returns AMBIGUOUS when candidates tied", () => {
    const cands: CanonicalCandidate[] = [
      { ...base, id: "x", legalName: "X" },
      { ...base, id: "y", legalName: "Y" },
    ];
    const rec = recommendCanonical(cands);
    expect(rec.state).toBe("AMBIGUOUS");
    expect(rec.recommendedVendorId).toBeNull();
  });
  it("returns RECOMMENDED for a lone candidate trivially", () => {
    const rec = recommendCanonical([{ ...base, id: "only", legalName: "Only" }]);
    expect(rec.state).toBe("RECOMMENDED");
    expect(rec.recommendedVendorId).toBe("only");
  });
});
