// Sprint 3 · Checkpoint 15P-3 (2026-07-27) — normalizer unit tests.
//
// Every normalizer MUST be symmetric (same function on both sides
// of the comparison) and MUST treat null / undefined / "" / whitespace
// identically as blank. Payment terms preserve numeric 0 as a real
// value.

import { describe, expect, it } from "vitest";
import {
  isBlank,
  normalizeName,
  normalizeEmail,
  emailDomain,
  normalizePhoneDigits,
  normalizePostalCode,
  normalizeTaxRegistrationNumber,
  normalizeWebsiteHost,
  normalizeProvinceState,
  normalizeCountry,
  normalizeAddressLine,
  normalizeCity,
  normalizePaymentTermsDays,
} from "@/lib/vendor-matching/normalize";

describe("15P-3 · isBlank", () => {
  it("null / undefined / '' / whitespace are blank", () => {
    for (const v of [null, undefined, "", "   ", "\t\n"]) expect(isBlank(v)).toBe(true);
  });
  it("non-blank strings are NOT blank", () => {
    expect(isBlank("x")).toBe(false);
    expect(isBlank(" a ")).toBe(false);
  });
  it("the number 0 is NOT blank", () => {
    expect(isBlank(0)).toBe(false);
  });
});

describe("15P-3 · normalizeName", () => {
  it("collapses case + whitespace + drops org suffixes", () => {
    expect(normalizeName("Microsoft Corporation")).toBe("microsoft");
    expect(normalizeName("microsoft   corp.")).toBe("microsoft");
    expect(normalizeName("Microsoft Inc")).toBe("microsoft");
    expect(normalizeName("MICROSOFT, LLC")).toBe("microsoft");
    expect(normalizeName("Cisco Systems Inc.")).toBe("cisco systems");
  });
  it("treats & and 'and' equivalently", () => {
    expect(normalizeName("Ben & Jerry's")).toBe(normalizeName("Ben and Jerry's"));
  });
  it("returns null on blank input", () => {
    for (const v of [null, undefined, "", "   "]) expect(normalizeName(v)).toBeNull();
  });
  it("does NOT drop meaningful common words", () => {
    // "the" and "of" stay — they change organizational identity.
    expect(normalizeName("The Home Depot")).toBe("the home depot");
    expect(normalizeName("Bank of Montreal")).toBe("bank of montreal");
  });
});

describe("15P-3 · normalizeEmail + emailDomain", () => {
  it("lowercase + trim", () => {
    expect(normalizeEmail("  Admin@Microsoft.COM ")).toBe("admin@microsoft.com");
  });
  it("returns null on blank", () => {
    for (const v of [null, undefined, "", "   "]) expect(normalizeEmail(v)).toBeNull();
  });
  it("emailDomain extracts + lowercases + strips www", () => {
    expect(emailDomain("Admin@Microsoft.COM")).toBe("microsoft.com");
    expect(emailDomain("someone@www.foo.com")).toBe("foo.com");
    expect(emailDomain("not-an-email")).toBeNull();
    expect(emailDomain(null)).toBeNull();
  });
});

describe("15P-3 · normalizePhoneDigits", () => {
  it("collapses formatting to bare digits", () => {
    expect(normalizePhoneDigits("+1 (800) 865-9408")).toBe("8008659408");
    expect(normalizePhoneDigits("1-800-865-9408")).toBe("8008659408");
    expect(normalizePhoneDigits("(800) 865-9408")).toBe("8008659408");
    expect(normalizePhoneDigits("800.865.9408")).toBe("8008659408");
    expect(normalizePhoneDigits("8008659408")).toBe("8008659408");
  });
  it("drops leading 1 country code for NA 11-digit", () => {
    expect(normalizePhoneDigits("15551234567")).toBe("5551234567");
  });
  it("returns null on blank / too-short", () => {
    for (const v of [null, undefined, "", "   ", "123"]) expect(normalizePhoneDigits(v)).toBeNull();
  });
  it("international numbers preserved verbatim", () => {
    expect(normalizePhoneDigits("+44 20 7946 0958")).toBe("442079460958");
  });
});

describe("15P-3 · normalizePostalCode", () => {
  it("Canadian postal — space + case insensitive", () => {
    expect(normalizePostalCode("T2T 0Z7")).toBe("T2T0Z7");
    expect(normalizePostalCode("t2t 0z7")).toBe("T2T0Z7");
    expect(normalizePostalCode("t2t0z7")).toBe("T2T0Z7");
  });
  it("US ZIP + ZIP+4", () => {
    expect(normalizePostalCode("98052")).toBe("98052");
    expect(normalizePostalCode("98052-6399")).toBe("98052-6399");
  });
  it("returns null on blank", () => {
    for (const v of [null, undefined, "", "   "]) expect(normalizePostalCode(v)).toBeNull();
  });
});

describe("15P-3 · normalizeTaxRegistrationNumber", () => {
  it("strips whitespace + punctuation, uppercases", () => {
    expect(normalizeTaxRegistrationNumber("135625069RT0001")).toBe("135625069RT0001");
    expect(normalizeTaxRegistrationNumber("135625069 RT 0001")).toBe("135625069RT0001");
    expect(normalizeTaxRegistrationNumber("135-625-069 RT-0001")).toBe("135625069RT0001");
    expect(normalizeTaxRegistrationNumber("135625069rt0001")).toBe("135625069RT0001");
  });
  it("returns null on blank", () => {
    for (const v of [null, undefined, "", "   "]) expect(normalizeTaxRegistrationNumber(v)).toBeNull();
  });
});

describe("15P-3 · normalizeWebsiteHost", () => {
  it("strips scheme, www, path, port", () => {
    expect(normalizeWebsiteHost("https://www.example.com/foo")).toBe("example.com");
    expect(normalizeWebsiteHost("http://Example.COM/")).toBe("example.com");
    expect(normalizeWebsiteHost("example.com")).toBe("example.com");
    expect(normalizeWebsiteHost("www.example.com:8080")).toBe("example.com");
    expect(normalizeWebsiteHost("https://aka.ms/Office365Billing")).toBe("aka.ms");
  });
  it("returns null on blank", () => {
    for (const v of [null, undefined, "", "   "]) expect(normalizeWebsiteHost(v)).toBeNull();
  });
});

describe("15P-3 · normalizeProvinceState", () => {
  it("US state names → 2-letter code", () => {
    expect(normalizeProvinceState("Washington")).toBe("WA");
    expect(normalizeProvinceState("washington")).toBe("WA");
    expect(normalizeProvinceState("WA")).toBe("WA");
    expect(normalizeProvinceState("wa")).toBe("WA");
  });
  it("Canadian province names → 2-letter code", () => {
    expect(normalizeProvinceState("Alberta")).toBe("AB");
    expect(normalizeProvinceState("ab")).toBe("AB");
    expect(normalizeProvinceState("Ontario")).toBe("ON");
  });
  it("returns null on blank", () => {
    for (const v of [null, undefined, "", "   "]) expect(normalizeProvinceState(v)).toBeNull();
  });
});

describe("15P-3 · normalizeCountry", () => {
  it("aliases → ISO-2 code", () => {
    expect(normalizeCountry("United States")).toBe("US");
    expect(normalizeCountry("USA")).toBe("US");
    expect(normalizeCountry("u.s.a.")).toBe("US");
    expect(normalizeCountry("Canada")).toBe("CA");
    expect(normalizeCountry("CA")).toBe("CA");
    expect(normalizeCountry("United Kingdom")).toBe("GB");
    expect(normalizeCountry("UK")).toBe("GB");
  });
  it("returns null on blank", () => {
    for (const v of [null, undefined, "", "   "]) expect(normalizeCountry(v)).toBeNull();
  });
});

describe("15P-3 · normalizeAddressLine + normalizeCity", () => {
  it("case-fold + collapse whitespace + strip trailing punctuation", () => {
    expect(normalizeAddressLine("One Microsoft Way")).toBe("one microsoft way");
    expect(normalizeAddressLine("  One Microsoft Way, ")).toBe("one microsoft way");
    expect(normalizeCity("Redmond")).toBe("redmond");
  });
  it("does NOT rewrite Street↔St (aggressive equivalence risk)", () => {
    // Two vendors typing "Street" vs "St" should compare as
    // `differed`, not silently equal. Operator overrides by editing.
    expect(normalizeAddressLine("100 Main Street") === normalizeAddressLine("100 Main St")).toBe(false);
  });
  it("returns null on blank", () => {
    for (const v of [null, undefined, "", "   "]) expect(normalizeAddressLine(v)).toBeNull();
  });
});

describe("15P-3 · normalizePaymentTermsDays", () => {
  it("preserves 0 as a real value (due-on-receipt / auto-pay)", () => {
    expect(normalizePaymentTermsDays(0)).toBe(0);
  });
  it("passes through valid non-negative ints", () => {
    expect(normalizePaymentTermsDays(30)).toBe(30);
    expect(normalizePaymentTermsDays(365)).toBe(365);
  });
  it("returns null for null / undefined", () => {
    expect(normalizePaymentTermsDays(null)).toBeNull();
    expect(normalizePaymentTermsDays(undefined)).toBeNull();
  });
  it("returns null for negatives / NaN / Infinity", () => {
    expect(normalizePaymentTermsDays(-5)).toBeNull();
    expect(normalizePaymentTermsDays(NaN)).toBeNull();
    expect(normalizePaymentTermsDays(Infinity)).toBeNull();
  });
});
