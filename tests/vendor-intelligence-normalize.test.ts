// Sprint 3 Checkpoint 15F (2026-07-24) — Pure-function tests for
// vendor normalization. No Prisma. Deterministic.

import { describe, expect, it } from "vitest";
import {
  normaliseVendorName,
  normaliseTaxNumber,
  normalisePhone,
  normalisePostalCode,
  normaliseAddressLine,
  normaliseEmail,
  domainFromEmail,
  isConsumerDomain,
  normaliseWebsiteDomain,
  fingerprintVendor,
} from "@/lib/vendor-intelligence/normalize";

describe("normaliseVendorName", () => {
  it("strips corporate suffixes + punctuation + collapses whitespace", () => {
    expect(normaliseVendorName("Northside  Course Maintenance, Inc.")).toBe("northside course maintenance");
    expect(normaliseVendorName("Premium Foods Co.")).toBe("premium foods");
    expect(normaliseVendorName("Tetra Insurance Brokers Ltd")).toBe("tetra insurance brokers");
  });
  it("collapses & → and", () => {
    expect(normaliseVendorName("Smith & Jones Corp.")).toBe("smith and jones");
  });
  it("returns empty for null/undefined", () => {
    expect(normaliseVendorName(null)).toBe("");
    expect(normaliseVendorName(undefined)).toBe("");
  });
});

describe("normaliseTaxNumber", () => {
  it("strips whitespace and hyphens, uppercases", () => {
    expect(normaliseTaxNumber("123 456 789 RT 0001")).toBe("123456789RT0001");
    expect(normaliseTaxNumber("12-3456789")).toBe("123456789");
    expect(normaliseTaxNumber("123-456-789")).toBe("123456789");
  });
  it("empty on null", () => {
    expect(normaliseTaxNumber(null)).toBe("");
  });
});

describe("normalisePhone", () => {
  it("collapses to digits + drops leading 1 for NANP", () => {
    expect(normalisePhone("+1 (403) 555-1234")).toBe("4035551234");
    expect(normalisePhone("403.555.1234")).toBe("4035551234");
    expect(normalisePhone("1-403-555-1234")).toBe("4035551234");
  });
  it("preserves country code for non-NANP", () => {
    expect(normalisePhone("+44 20 7946 0958")).toBe("442079460958");
  });
});

describe("normalisePostalCode", () => {
  it("Canadian: space-separated uppercase", () => {
    expect(normalisePostalCode("k1a0a6")).toBe("K1A 0A6");
    expect(normalisePostalCode("K1A 0A6")).toBe("K1A 0A6");
    expect(normalisePostalCode("k1a-0a6")).toBe("K1A 0A6");
  });
  it("US ZIP: strips ZIP+4 extension", () => {
    expect(normalisePostalCode("90210-1234")).toBe("90210");
  });
});

describe("normaliseAddressLine", () => {
  it("expands street-type abbreviations", () => {
    expect(normaliseAddressLine("123 Main St")).toBe("123 MAIN STREET");
    expect(normaliseAddressLine("456 Fairway Blvd.")).toBe("456 FAIRWAY BOULEVARD");
    expect(normaliseAddressLine("789 King Ave Suite 100")).toBe("789 KING AVENUE SUITE 100");
  });
});

describe("normaliseEmail + domainFromEmail + isConsumerDomain", () => {
  it("normalises email to trimmed lowercase", () => {
    expect(normaliseEmail(" Billing@Vendor.COM ")).toBe("billing@vendor.com");
  });
  it("extracts domain", () => {
    expect(domainFromEmail("BILLING@Vendor.COM")).toBe("vendor.com");
    expect(domainFromEmail(null)).toBe("");
  });
  it("recognises consumer domains", () => {
    expect(isConsumerDomain("gmail.com")).toBe(true);
    expect(isConsumerDomain("VENDOR.COM")).toBe(false);
  });
});

describe("normaliseWebsiteDomain", () => {
  it("strips scheme + www + path", () => {
    expect(normaliseWebsiteDomain("https://www.Vendor.com/about")).toBe("vendor.com");
    expect(normaliseWebsiteDomain("http://Vendor.com")).toBe("vendor.com");
    expect(normaliseWebsiteDomain("Vendor.COM")).toBe("vendor.com");
  });
});

describe("fingerprintVendor — one-call composite", () => {
  it("returns a stable object for the same input", () => {
    const a = fingerprintVendor({
      legalName: "Northside Course Maintenance, Inc.",
      operatingName: "Northside",
      taxRegistrationNumber: "123 456 789 RT 0001",
      email: "Billing@Northside.COM",
      website: "https://www.northside.com",
      phone: "+1 (403) 555-1234",
      postalCode: "T2N 1N4",
      address1: "1234 Fairway Dr.",
    });
    expect(a.legalNameNorm).toBe("northside course maintenance");
    expect(a.taxNumberNorm).toBe("123456789RT0001");
    expect(a.emailDomain).toBe("northside.com");
    expect(a.websiteDomain).toBe("northside.com");
    expect(a.phoneNorm).toBe("4035551234");
    expect(a.postalCodeNorm).toBe("T2N 1N4");
    expect(a.addressLine1Norm).toBe("1234 FAIRWAY DRIVE");
  });
});
