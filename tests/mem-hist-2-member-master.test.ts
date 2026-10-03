// MEM-HIST-2 §27 (2026-10-03) — pure-code acceptance tests.
//
// Covers the parser + semantics + bill-to resolution + no-PII +
// commit-service shape + migration presence. DB-touching tests
// (actual commit idempotency, Prisma upserts) land on staging via
// the API — this file stays pure.
//
// SYNTHETIC IDENTITIES ONLY. No real Silver Springs names.

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseJonasMemberMasterRowValues,
  resolveBillToOutcomes,
} from "../src/lib/imports/member-master/jonas-parser";
import {
  interpretSourceStatus,
  isShareholderFromSourceStatus,
  SHAREHOLDER_SOURCE_STATUSES,
} from "../src/lib/imports/member-master/jonas-semantics";

const REPO = path.resolve(__dirname, "..");
const SCHEMA_SQLITE = path.join(REPO, "prisma/schema.prisma");
const SCHEMA_PG = path.join(REPO, "prisma-postgres/schema.prisma");
const MIGRATION_SQLITE = path.join(REPO, "prisma/migrations/20261003_mem_hist_2_member_master/migration.sql");
const MIGRATION_PG = path.join(REPO, "prisma-postgres/migrations/20261003_mem_hist_2_member_master/migration.sql");
const PARSER = path.join(REPO, "src/lib/imports/member-master/jonas-parser.ts");
const COMMIT = path.join(REPO, "src/lib/imports/member-master/commit-service.ts");

// Synthetic fixture mirroring the Jan 31 workbook's column shape.
const HEADERS = [
  "Status", "Member #", "Last Name", "First Name", "Membership Description",
  "Category#1", "Category#1 Description", "Category#2", "Sex",
  "Joined", "Resigned", "Golf Classification",
  "Member # to Bill", "Minimum Billing", "BillBackUp",
];
const BANNER = Array(15).fill("Coulee Ridge Golf & Country Club");
const SYNTHETIC_ROWS: unknown[][] = [
  BANNER, [], [], // banner + 2 blanks before header (mirrors real layout)
  HEADERS,
  // Row 1 — shareholder, bills self, with alphabetic suffix in NO ONE
  // (just a plain 4-digit number).
  ["S/HOLDER", "0073", "Smith", "Alex",      "Shareholder",            "SHARE",  "Shareholder",            null, "M", new Date("2000-01-15"), "N/A", "SHOLDER", "0073", null, null],
  // Row 2 — spouse, bills through 0073 (RESOLVED)
  ["SPOUSE",   "0073A", "Smith", "Blair",   "Spouse - Female",         "SPOUSE", "Spouse",                 null, "F", new Date("2000-01-15"), "N/A", null, "0073", null, null],
  // Row 3 — resigned
  ["RESIGNED", "0100", "Lee", "Casey",       "Shareholder",            "SHARE",  "Shareholder",            null, "F", new Date("1998-06-01"), new Date("2024-11-30"), "SHOLDER", "0100", null, null],
  // Row 4 — leading-zero + alphabetic suffix, bills via "9999" (UNRESOLVED)
  ["SOCIAL",   "0110B", "Doe", "Dylan",      "Social - Public",        "SOCIAL", "Social",                 null, "F", new Date("2020-04-02"), "N/A", null, "9999", null, null],
  // Row 5 — MISC A/R (UNKNOWN interpretation)
  ["MISC A/R", "4000X", "N/A",     "N/A",    null,                     "AR",    null,                     null, null, "N/A", "N/A", null, "4000X", null, null],
  // Row 6 — WAIT LIST → APPLICANT
  ["WAIT LIST", "5000", "Wu", "Elliot",      "Waitlist - Non Golfer",  "WAIT",  null,                     null, "M", "N/A", "N/A", null, "5000", null, null],
];

const SOURCE_HASH = "test-hash-12345";
const SOURCE_DATE = new Date("2026-10-03T00:00:00Z");

// --------------------------------------------------------------
// IDENTITY — Member # preservation
// --------------------------------------------------------------
describe("MEM-HIST-2 §27 — IDENTITY: Member # preservation", () => {
  it("Member # strings preserve leading zeros + alphabetic suffixes", () => {
    const result = parseJonasMemberMasterRowValues({
      rows: SYNTHETIC_ROWS, sourceFileHash: SOURCE_HASH,
      sourceFileName: "test.xlsx", sourceEffectiveDate: SOURCE_DATE,
    });
    const nos = result.rows.map((r) => r.memberNumber);
    expect(nos).toContain("0073");
    expect(nos).toContain("0073A");
    expect(nos).toContain("0100");
    expect(nos).toContain("0110B");
    expect(nos).toContain("4000X");
    // No numeric coercion.
    for (const n of nos) expect(typeof n).toBe("string");
  });

  it("parser never calls parseInt/Number on Member # cells", () => {
    const src = readFileSync(PARSER, "utf8");
    // The extractIdString helper documents the contract. Grep guard:
    // no Number(cell) or parseInt(cell) in the parser.
    expect(src).not.toMatch(/Number\(cell\)/);
    expect(src).not.toMatch(/parseInt\(cell/);
  });
});

// --------------------------------------------------------------
// PROFILE — First/Last Name rendered + synthetic names preserved
// --------------------------------------------------------------
describe("MEM-HIST-2 §27 — PROFILE: name fields preserved", () => {
  it("First Name + Last Name are extracted verbatim (never hashed, never serialized to CR-NNNN)", () => {
    const result = parseJonasMemberMasterRowValues({
      rows: SYNTHETIC_ROWS, sourceFileHash: SOURCE_HASH,
      sourceFileName: "test.xlsx", sourceEffectiveDate: SOURCE_DATE,
    });
    const alex = result.rows.find((r) => r.memberNumber === "0073");
    expect(alex?.firstName).toBe("Alex");
    expect(alex?.lastName).toBe("Smith");
    // No row should carry a "CR-NNNN" or "Member NNNN" display name.
    for (const r of result.rows) {
      expect(r.firstName).not.toMatch(/^CR-/);
      expect(r.firstName).not.toMatch(/^Member \d{4}$/);
    }
  });
});

// --------------------------------------------------------------
// BILLING — Member # to Bill resolution
// --------------------------------------------------------------
describe("MEM-HIST-2 §27 — BILLING: bill-to resolution", () => {
  it("SELF bill (bill-to == member #)", () => {
    const result = parseJonasMemberMasterRowValues({
      rows: SYNTHETIC_ROWS, sourceFileHash: SOURCE_HASH,
      sourceFileName: "test.xlsx", sourceEffectiveDate: SOURCE_DATE,
    });
    const selves = result.billToOutcomes.filter((o) => o.outcome === "SELF").map((o) => o.memberNumber);
    expect(selves).toContain("0073");
    expect(selves).toContain("0100");
  });

  it("RESOLVED bill (bill-to is another Member # in the file)", () => {
    const result = parseJonasMemberMasterRowValues({
      rows: SYNTHETIC_ROWS, sourceFileHash: SOURCE_HASH,
      sourceFileName: "test.xlsx", sourceEffectiveDate: SOURCE_DATE,
    });
    const resolved = result.billToOutcomes.filter((o) => o.outcome === "RESOLVED").map((o) => o.memberNumber);
    expect(resolved).toContain("0073A");
  });

  it("UNRESOLVED bill (bill-to not found in file)", () => {
    const result = parseJonasMemberMasterRowValues({
      rows: SYNTHETIC_ROWS, sourceFileHash: SOURCE_HASH,
      sourceFileName: "test.xlsx", sourceEffectiveDate: SOURCE_DATE,
    });
    const unresolved = result.billToOutcomes.filter((o) => o.outcome === "UNRESOLVED").map((o) => o.memberNumber);
    expect(unresolved).toContain("0110B");
  });

  it("child/spouse Member is NOT collapsed into bill-to Member", () => {
    const result = parseJonasMemberMasterRowValues({
      rows: SYNTHETIC_ROWS, sourceFileHash: SOURCE_HASH,
      sourceFileName: "test.xlsx", sourceEffectiveDate: SOURCE_DATE,
    });
    // 0073 and 0073A are DISTINCT rows after parsing.
    const members = result.rows.map((r) => r.memberNumber);
    expect(members).toContain("0073");
    expect(members).toContain("0073A");
    const uniq = new Set(members);
    expect(uniq.size).toBe(members.length);
  });
});

// --------------------------------------------------------------
// MEMBERSHIP — classification + shareholder derivation
// --------------------------------------------------------------
describe("MEM-HIST-2 §27 — MEMBERSHIP: deterministic classification", () => {
  it("S/HOLDER → ACTIVE + isShareholder true", () => {
    expect(interpretSourceStatus("S/HOLDER")).toBe("ACTIVE");
    expect(isShareholderFromSourceStatus("S/HOLDER")).toBe(true);
  });

  it("RESIGNED → RESIGNED", () => {
    expect(interpretSourceStatus("RESIGNED")).toBe("RESIGNED");
    expect(isShareholderFromSourceStatus("RESIGNED")).toBe(false);
  });

  it("SPOUSE / JUNIOR / SOCIAL → ACTIVE but not shareholder", () => {
    for (const s of ["SPOUSE", "JUNIOR", "SOCIAL", "INTER.", "STAFF", "LEGACY"]) {
      expect(interpretSourceStatus(s)).toBe("ACTIVE");
      expect(isShareholderFromSourceStatus(s)).toBe(false);
    }
  });

  it("WAIT LIST → APPLICANT", () => {
    expect(interpretSourceStatus("WAIT LIST")).toBe("APPLICANT");
  });

  it("MISC A/R → UNKNOWN (not guessed)", () => {
    expect(interpretSourceStatus("MISC A/R")).toBe("UNKNOWN");
  });

  it("unseen source status → UNKNOWN (never guessed from label)", () => {
    expect(interpretSourceStatus("SOME_UNSEEN_VALUE")).toBe("UNKNOWN");
    expect(interpretSourceStatus("FOUNDING_MEMBER")).toBe("UNKNOWN");
  });

  it("SHAREHOLDER_SOURCE_STATUSES is explicit (deterministic set)", () => {
    expect(SHAREHOLDER_SOURCE_STATUSES.has("S/HOLDER")).toBe(true);
    expect(SHAREHOLDER_SOURCE_STATUSES.has("INTER.")).toBe(false);
    expect(SHAREHOLDER_SOURCE_STATUSES.has("MISC A/R")).toBe(false);
  });
});

// --------------------------------------------------------------
// DATES — N/A + blank handling
// --------------------------------------------------------------
describe("MEM-HIST-2 §27 — DATES: N/A never fabricated", () => {
  it("Joined 'N/A' → null (never a fabricated date)", () => {
    const result = parseJonasMemberMasterRowValues({
      rows: SYNTHETIC_ROWS, sourceFileHash: SOURCE_HASH,
      sourceFileName: "test.xlsx", sourceEffectiveDate: SOURCE_DATE,
    });
    const miscAr = result.rows.find((r) => r.memberNumber === "4000X");
    expect(miscAr?.joinedDate).toBeNull();
    expect(miscAr?.resignedDate).toBeNull();
  });

  it("Resigned Excel date → Date object", () => {
    const result = parseJonasMemberMasterRowValues({
      rows: SYNTHETIC_ROWS, sourceFileHash: SOURCE_HASH,
      sourceFileName: "test.xlsx", sourceEffectiveDate: SOURCE_DATE,
    });
    const casey = result.rows.find((r) => r.memberNumber === "0100");
    expect(casey?.resignedDate).toBeInstanceOf(Date);
  });
});

// --------------------------------------------------------------
// PRIVACY — no PII fields in schema or imported shape
// --------------------------------------------------------------
describe("MEM-HIST-2 §27 — PRIVACY: no PII in source contract", () => {
  it("JonasMemberMasterRow carries no email / phone / address / DOB fields", () => {
    const parserSrc = readFileSync(PARSER, "utf8");
    // The exported row type declaration must NOT include these fields.
    const typeBlock = parserSrc.match(/export type JonasMemberMasterRow\s*=\s*\{[\s\S]*?\n\};/)?.[0] ?? "";
    expect(typeBlock).not.toMatch(/\bemail\b/i);
    expect(typeBlock).not.toMatch(/\bphone\b/i);
    expect(typeBlock).not.toMatch(/\baddress\b/i);
    expect(typeBlock).not.toMatch(/\bpostal\b/i);
    expect(typeBlock).not.toMatch(/\bzip\b/i);
    expect(typeBlock).not.toMatch(/\bdateOfBirth\b/i);
    expect(typeBlock).not.toMatch(/\bdob\b/i);
    expect(typeBlock).not.toMatch(/\bbirth\b/i);
    expect(typeBlock).not.toMatch(/\bemergencyContact\b/i);
    expect(typeBlock).not.toMatch(/\bcreditCard\b/i);
    expect(typeBlock).not.toMatch(/\bbankAccount\b/i);
  });

  it("commit service writes synthetic names + null email (MEM-HIST-2A: no placeholder email)", () => {
    const src = readFileSync(COMMIT, "utf8");
    // MEM-HIST-2A §2 — commit service NEVER writes a placeholder
    // email. Member.email is now nullable; the import passes null.
    expect(src).not.toMatch(/@placeholder\.invalid/);
    // Guard against anyone wiring a real address field later.
    const createData = src.match(/prisma\.member\.create\(\{[\s\S]*?\}\)/)?.[0] ?? "";
    expect(createData).not.toMatch(/\baddressLine1:/);
    expect(createData).not.toMatch(/\bdateOfBirth:/);
    expect(createData).not.toMatch(/\bphone:/);
    expect(createData).toMatch(/email:\s*null/);
  });

  it(".gitignore blocks the real workbook filename pattern", () => {
    const gi = readFileSync(path.join(REPO, ".gitignore"), "utf8");
    expect(gi).toMatch(/Membership\*Master\*\.xlsx/);
    expect(gi).toMatch(/Membership Master - Sanitized for Spectre\.xlsx/);
  });
});

// --------------------------------------------------------------
// IMPORT — preview/commit action split + idempotency key
// --------------------------------------------------------------
describe("MEM-HIST-2 §27 — IMPORT: preview is pure; idempotency key defined", () => {
  it("parseJonasMemberMasterRowValues is a pure function (no Prisma)", () => {
    const src = readFileSync(PARSER, "utf8");
    expect(src).not.toMatch(/from\s+"@\/lib\/prisma"/);
    expect(src).not.toMatch(/prisma\.\w+/);
  });

  it("commit service uses the (clubId, sourceSystem, sourceFileHash, sourceEffectiveDate) idempotency key", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/clubId_sourceSystem_sourceFileHash_sourceEffectiveDate/);
  });

  it("commit service refuses re-upload of identical COMMITTED workbook", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/already committed/);
    expect(src).toMatch(/Refusing to commit/);
  });

  it("commit service refuses to commit on duplicate Member #", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/duplicate Member #/i);
  });
});

// --------------------------------------------------------------
// REPORTING — October source does not pollute January
// --------------------------------------------------------------
describe("MEM-HIST-2 §27 — REPORTING: October source does not pollute January", () => {
  it("MembershipHistoryEntry effectiveFrom equals sourceEffectiveDate (not NOW)", () => {
    const src = readFileSync(COMMIT, "utf8");
    // The resume-safe refactor splits the create behind an existence
    // check. Grep looser for the key invariant:
    //   `effectiveFrom: parsed.sourceEffectiveDate`
    // appears inside a `prisma.membershipHistoryEntry.create` call.
    expect(src).toMatch(/membershipHistoryEntry\.create[\s\S]{0,1000}effectiveFrom:\s*parsed\.sourceEffectiveDate/);
  });

  it("resolver's as-of filter uses half-open window (lte effectiveFrom + gt effectiveTo)", () => {
    const resolverSrc = readFileSync(
      path.join(REPO, "src/lib/reporting/membership-history-resolver.ts"),
      "utf8",
    );
    expect(resolverSrc).toMatch(/effectiveFrom:\s*\{\s*lte:\s*opts\.asOf/);
    expect(resolverSrc).toMatch(/effectiveTo:\s*null|effectiveTo:\s*\{\s*gt:\s*opts\.asOf/);
  });

  it("resolver returns SOURCE_NOT_LOADED when no entry covers the asOf", () => {
    const resolverSrc = readFileSync(
      path.join(REPO, "src/lib/reporting/membership-history-resolver.ts"),
      "utf8",
    );
    expect(resolverSrc).toMatch(/availability:\s*"SOURCE_NOT_LOADED"/);
    expect(resolverSrc).toMatch(/predates the loaded source/);
  });
});

// --------------------------------------------------------------
// PORTAL — zero User creation; existing contract preserved
// --------------------------------------------------------------
describe("MEM-HIST-2 §27 — PORTAL: zero side effects", () => {
  it("commit service never creates a User or MemberPortalInvite", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).not.toMatch(/prisma\.user\.create/);
    expect(src).not.toMatch(/prisma\.memberPortalInvite\.(create|upsert)/);
  });

  it("commit service never writes passwordHash or credentials", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).not.toMatch(/passwordHash/);
    expect(src).not.toMatch(/mfaSecret/);
  });
});

// --------------------------------------------------------------
// ACCOUNTING — no mutations
// --------------------------------------------------------------
describe("MEM-HIST-2 §27 — ACCOUNTING: no mutations", () => {
  it("commit service writes only to Member + MemberExternalIdentity + MembershipHistoryEntry + MemberBillingRelationship + MemberMasterImportBatch", () => {
    const src = readFileSync(COMMIT, "utf8");
    // Prohibited writes.
    expect(src).not.toMatch(/prisma\.account\.create/);
    expect(src).not.toMatch(/prisma\.journalEntry\.(create|update)/);
    expect(src).not.toMatch(/prisma\.reportingLedgerBatch\.(create|update)/);
    expect(src).not.toMatch(/prisma\.reportingLedgerSnapshot\.(create|update)/);
    expect(src).not.toMatch(/prisma\.department\.(create|update)/);
    expect(src).not.toMatch(/prisma\.fund\.(create|update)/);
    expect(src).not.toMatch(/prisma\.coa/);
    expect(src).not.toMatch(/prisma\.charge\.(create|update)/);
    expect(src).not.toMatch(/prisma\.payment\.(create|update)/);
    expect(src).not.toMatch(/prisma\.statement\.(create|update)/);
    expect(src).not.toMatch(/prisma\.memberAccount\.(create|update)/);
  });
});

// --------------------------------------------------------------
// SCHEMA + migration present (both files)
// --------------------------------------------------------------
describe("MEM-HIST-2 §27 — SCHEMA: 4 new models + migrations present", () => {
  it("SQLite schema declares the four new models", () => {
    const schema = readFileSync(SCHEMA_SQLITE, "utf8");
    expect(schema).toMatch(/^model MemberExternalIdentity\b/m);
    expect(schema).toMatch(/^model MemberMasterImportBatch\b/m);
    expect(schema).toMatch(/^model MembershipHistoryEntry\b/m);
    expect(schema).toMatch(/^model MemberBillingRelationship\b/m);
  });

  it("Postgres schema declares the same four models", () => {
    const schema = readFileSync(SCHEMA_PG, "utf8");
    expect(schema).toMatch(/^model MemberExternalIdentity\b/m);
    expect(schema).toMatch(/^model MemberMasterImportBatch\b/m);
    expect(schema).toMatch(/^model MembershipHistoryEntry\b/m);
    expect(schema).toMatch(/^model MemberBillingRelationship\b/m);
  });

  it("both migrations exist and are non-empty", () => {
    expect(existsSync(MIGRATION_SQLITE)).toBe(true);
    expect(existsSync(MIGRATION_PG)).toBe(true);
    expect(statSync(MIGRATION_SQLITE).size).toBeGreaterThan(500);
    expect(statSync(MIGRATION_PG).size).toBeGreaterThan(500);
  });

  it("MemberExternalIdentity uniqueness: (clubId, sourceSystem, externalIdentifier)", () => {
    const mig = readFileSync(MIGRATION_PG, "utf8");
    expect(mig).toMatch(/CREATE UNIQUE INDEX "MemberExternalIdentity_tenant_source_key"[\s\S]{0,200}clubId[\s\S]{0,200}sourceSystem[\s\S]{0,200}externalIdentifier/);
  });

  it("MemberMasterImportBatch idempotency: (clubId, sourceSystem, sourceFileHash, sourceEffectiveDate)", () => {
    const mig = readFileSync(MIGRATION_PG, "utf8");
    expect(mig).toMatch(/CREATE UNIQUE INDEX "MemberMasterImportBatch_idempotency"[\s\S]{0,300}sourceFileHash[\s\S]{0,100}sourceEffectiveDate/);
  });
});

// --------------------------------------------------------------
// INVALID row surfaces (not silently a Member)
// --------------------------------------------------------------
describe("MEM-HIST-2 §27 — IMPORT: invalid rows cannot silently become Members", () => {
  it("row missing Member # → invalidRows (not rows)", () => {
    const rows = [
      BANNER, HEADERS,
      ["S/HOLDER", "", "Smith", "Alex", "Shareholder", "SHARE", "Shareholder", null, "M", "N/A", "N/A", null, "", null, null],
    ];
    const r = parseJonasMemberMasterRowValues({
      rows, sourceFileHash: SOURCE_HASH, sourceFileName: "x.xlsx", sourceEffectiveDate: SOURCE_DATE,
    });
    expect(r.rows).toHaveLength(0);
    expect(r.invalidRows[0]?.reason).toMatch(/Missing Member #/);
  });

  it("row missing Status → invalidRows (not rows)", () => {
    const rows = [
      BANNER, HEADERS,
      ["", "0073", "Smith", "Alex", "Shareholder", "SHARE", "Shareholder", null, "M", "N/A", "N/A", null, "0073", null, null],
    ];
    const r = parseJonasMemberMasterRowValues({
      rows, sourceFileHash: SOURCE_HASH, sourceFileName: "x.xlsx", sourceEffectiveDate: SOURCE_DATE,
    });
    expect(r.rows).toHaveLength(0);
    expect(r.invalidRows[0]?.reason).toMatch(/Missing Status/);
  });
});

// --------------------------------------------------------------
// Bill-to resolver (unit test for the pure helper)
// --------------------------------------------------------------
describe("MEM-HIST-2 §27 — resolveBillToOutcomes is pure + deterministic", () => {
  it("classifies each row's bill-to against the parsed universe", () => {
    const r = parseJonasMemberMasterRowValues({
      rows: SYNTHETIC_ROWS, sourceFileHash: SOURCE_HASH,
      sourceFileName: "x.xlsx", sourceEffectiveDate: SOURCE_DATE,
    });
    const outcomes = resolveBillToOutcomes(r.rows, 0);
    const bySelf = outcomes.filter((o) => o.outcome === "SELF").length;
    const byResolved = outcomes.filter((o) => o.outcome === "RESOLVED").length;
    const byUnresolved = outcomes.filter((o) => o.outcome === "UNRESOLVED").length;
    expect(bySelf + byResolved + byUnresolved).toBe(r.rows.length);
    expect(byUnresolved).toBeGreaterThan(0); // 0110B's bill-to "9999" is unresolved
    expect(byResolved).toBeGreaterThan(0);   // 0073A → 0073
  });
});
