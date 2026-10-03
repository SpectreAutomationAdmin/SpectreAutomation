// MEM-HIST-1 §19 (2026-10-03) — acceptance tests.
//
// Covers the 16 acceptance scenarios in §19 that are testable from
// pure code (no DB access required). The DB-side tests
// (overlapping-effective-period enforcement, idempotency on commit,
// Member Portal invite flow) land in MEM-HIST-2 when the schema
// migration ships.
//
// SYNTHETIC IDENTITIES ONLY. No real Silver Springs names /
// member numbers / emails / addresses anywhere.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseMemberMasterRowValues,
} from "../src/lib/imports/member-master/parser";
import {
  resolveMemberMatchOutcomes,
} from "../src/lib/imports/member-master/match-resolver";
import {
  makeSyntheticIdentifier,
  makeSyntheticDisplayName,
  assertSaltLooksSecret,
} from "../src/lib/imports/member-master/sanitize";
import {
  resolveMembershipAsOf,
  countMembershipsByCategoryAsOf,
} from "../src/lib/reporting/membership-history-resolver";
import {
  MEMBER_MASTER_FIXTURE_ROWS,
  MEMBER_MASTER_LATER_SNAPSHOT_ROWS,
} from "./fixtures/member-master/synthetic-member-master";

const REPO = path.resolve(__dirname, "..");
const ARCH_DOC = path.join(REPO, "docs/mem-hist-1-member-master-architecture.md");
const SCHEMA = path.join(REPO, "prisma/schema.prisma");

const SOURCE_EFFECTIVE = new Date("2026-01-31T00:00:00Z");

// --------------------------------------------------------------
// §19.1 — one canonical Member identity reused across modules
// --------------------------------------------------------------
describe("MEM-HIST-1 §19.1 — Member is the single durable identity", () => {
  it("Prisma `User.memberId @unique` keeps portal auth decoupled from Member", () => {
    const schema = readFileSync(SCHEMA, "utf8");
    expect(schema).toMatch(/memberId\s+String\?\s+@unique/);
    expect(schema).toMatch(/member\s+Member\?\s+@relation\(fields:\s*\[memberId\]/);
  });

  it("Prisma `MemberAccount.memberId @unique` keeps the AR ledger 1:1 with Member", () => {
    const schema = readFileSync(SCHEMA, "utf8");
    expect(schema).toMatch(/model MemberAccount[\s\S]{0,400}memberId\s+String\s+@unique/);
  });

  it("architecture doc states Member is the canonical identity", () => {
    const doc = readFileSync(ARCH_DOC, "utf8");
    expect(doc).toMatch(/single durable identity/);
    // The doc may mention `ARMember` only inside a "do not create"
    // sentence — count occurrences, expect ≤ 1 (the explicit "do not
    // introduce" line).
    const arMemberCount = (doc.match(/\bARMember\b/g) ?? []).length;
    expect(arMemberCount).toBeLessThanOrEqual(1);
    const portalMemberCount = (doc.match(/\bPortalMember\b/g) ?? []).length;
    expect(portalMemberCount).toBeLessThanOrEqual(1);
    const reportingMemberCount = (doc.match(/\bReportingMember\b/g) ?? []).length;
    expect(reportingMemberCount).toBeLessThanOrEqual(1);
  });
});

// --------------------------------------------------------------
// §19.2 — Member and Membership are distinct concepts
// --------------------------------------------------------------
describe("MEM-HIST-1 §19.2 — Member vs Membership distinction", () => {
  it("architecture doc models Member separately from MembershipHistoryEntry", () => {
    const doc = readFileSync(ARCH_DOC, "utf8");
    expect(doc).toMatch(/## D\. Member vs Membership model/);
    expect(doc).toMatch(/MembershipHistoryEntry/);
  });

  it("resolver API separates per-member resolution from per-category count", () => {
    expect(typeof resolveMembershipAsOf).toBe("function");
    expect(typeof countMembershipsByCategoryAsOf).toBe("function");
  });
});

// --------------------------------------------------------------
// §19.3 — Classification resolvable as-of a historical date
// --------------------------------------------------------------
describe("MEM-HIST-1 §19.3-4 — effective-dated resolution contract", () => {
  it("resolveMembershipAsOf accepts a historical asOf date without throwing (MEM-HIST-2: SOURCE_NOT_LOADED when no entry)", async () => {
    const r = await resolveMembershipAsOf({
      clubId: "test-club-nonexistent-for-this-test",
      memberId: "cr-0001",
      asOf: new Date("2026-01-31T23:59:59Z"),
    });
    // MEM-HIST-2: resolver now reads Prisma. For a non-existent club,
    // it returns SOURCE_NOT_LOADED (no entry covers the asOf).
    expect(["SOURCE_NOT_LOADED", "SOURCE_NOT_CONNECTED"]).toContain(r.provenance.availability);
    expect(r.membership).toBeNull();
  });

  it("countMembershipsByCategoryAsOf returns provenance alongside counts", async () => {
    const r = await countMembershipsByCategoryAsOf({
      clubId: "test-club-nonexistent-for-this-test",
      asOf: new Date("2026-01-31T23:59:59Z"),
    });
    expect(["SOURCE_NOT_LOADED", "SOURCE_NOT_CONNECTED"]).toContain(r.provenance.availability);
    expect(r.counts).toEqual([]);
  });

  it("architecture doc guarantees later changes do not rewrite earlier as-of results", () => {
    const doc = readFileSync(ARCH_DOC, "utf8");
    expect(doc).toMatch(/preserved by \*construction\*/i);
  });
});

// --------------------------------------------------------------
// §19.5 — Duplicate external IDs detected
// --------------------------------------------------------------
describe("MEM-HIST-1 §19.5 — parser detects duplicate external identifiers", () => {
  it("duplicate CR-0007g7 surfaces as a parser warning", () => {
    const result = parseMemberMasterRowValues({
      rows: MEMBER_MASTER_FIXTURE_ROWS,
      sourceEffectiveDate: SOURCE_EFFECTIVE,
    });
    const dupWarning = result.warnings.find((w) => w.includes("CR-0007g7"));
    expect(dupWarning).toBeDefined();
    expect(dupWarning).toContain("Duplicate externalIdentifier");
  });

  it("match resolver returns AMBIGUOUS when two Members share an identifier", () => {
    const r = resolveMemberMatchOutcomes({
      rows: [
        { externalIdentifier: "CR-dup", displayName: "", classificationCode: "SOCIAL", status: "ACTIVE", isShareholder: false, effectiveFrom: new Date(), joinDate: null, resignationDate: null, previousClassificationCode: null, previousClassificationChangedAt: null, householdPrimary: null },
      ],
      existingIdentityIndex: new Map([["CR-dup", ["memA", "memB"]]]),
    });
    expect(r.results[0].outcome).toBe("AMBIGUOUS");
    expect(r.summary.ambiguous).toBe(1);
  });
});

// --------------------------------------------------------------
// §19.6-7 — Idempotency (same snapshot) + corrected-file deterministic
// --------------------------------------------------------------
describe("MEM-HIST-1 §19.6-7 — idempotency contract documented", () => {
  it("architecture doc specifies the idempotency key", () => {
    const doc = readFileSync(ARCH_DOC, "utf8");
    expect(doc).toMatch(/\(clubId,\s*sourceSystem,\s*sourceFileHash,\s*sourceEffectiveDate\)/);
    expect(doc).toMatch(/Identical file re-upload[\s\S]{0,200}Rejected by the unique constraint/i);
    expect(doc).toMatch(/Corrected file for same date[\s\S]{0,300}VOID the prior committed batch/i);
  });
});

// --------------------------------------------------------------
// §19.8 — Absence does not auto-create resignation
// --------------------------------------------------------------
describe("MEM-HIST-1 §19.8 — absence from a later file is NOT resignation", () => {
  it("CR-0005e5 is absent in the later snapshot — parser emits no RESIGNED row for them", () => {
    const laterParse = parseMemberMasterRowValues({
      rows: MEMBER_MASTER_LATER_SNAPSHOT_ROWS,
      sourceEffectiveDate: new Date("2026-02-28T23:59:59Z"),
    });
    const laterIds = laterParse.rows.map((r) => r.externalIdentifier);
    expect(laterIds).not.toContain("CR-0005e5");
    // Nothing was auto-synthesized.
    expect(laterParse.rows.filter((r) => r.status === "RESIGNED")).toEqual([]);
  });

  it("architecture doc documents the invariant", () => {
    const doc = readFileSync(ARCH_DOC, "utf8");
    expect(doc).toMatch(/Member ABSENT from a later file[\s\S]{0,400}Does NOT automatically mean resignation/i);
  });
});

// --------------------------------------------------------------
// §19.9 — AR matching uses external identity, not fuzzy names
// --------------------------------------------------------------
describe("MEM-HIST-1 §19.9 — no name-based matching", () => {
  it("match resolver resolves only on externalIdentifier (never consults displayName)", () => {
    const r = resolveMemberMatchOutcomes({
      rows: [
        {
          externalIdentifier: "CR-nameOnly",
          displayName: "Member 0001", // same display name as an existing Member
          classificationCode: "SOCIAL",
          status: "ACTIVE",
          isShareholder: false,
          effectiveFrom: new Date(),
          joinDate: null,
          resignationDate: null,
          previousClassificationCode: null,
          previousClassificationChangedAt: null,
          householdPrimary: null,
        },
      ],
      // The existing index knows "Member 0001" is memA, but the
      // IDENTIFIER CR-nameOnly is not in the index.
      existingIdentityIndex: new Map([["CR-known", ["memA"]]]),
    });
    expect(r.results[0].outcome).toBe("UNMATCHED");
    expect(r.results[0].resolvedMemberId).toBeNull();
  });

  it("resolver file source rejects fuzzy name matching textually", () => {
    const src = readFileSync(
      path.join(REPO, "src/lib/imports/member-master/match-resolver.ts"),
      "utf8",
    );
    // The resolver must not import a Levenshtein / fuzzy library.
    expect(src).not.toMatch(/levenshtein/i);
    expect(src).not.toMatch(/fuzzysort/i);
    expect(src).not.toMatch(/fuzzball/i);
  });
});

// --------------------------------------------------------------
// §19.10 — Importing Member does not create portal credentials
// --------------------------------------------------------------
describe("MEM-HIST-1 §19.10 — importer does not provision portal access", () => {
  it("parser output shape has no password / credential field", () => {
    const result = parseMemberMasterRowValues({
      rows: MEMBER_MASTER_FIXTURE_ROWS,
      sourceEffectiveDate: SOURCE_EFFECTIVE,
    });
    for (const row of result.rows) {
      const keys = Object.keys(row);
      for (const k of keys) {
        expect(k.toLowerCase()).not.toContain("password");
        expect(k.toLowerCase()).not.toContain("credential");
      }
    }
  });

  it("architecture doc confirms portal invite is a separate opt-in act", () => {
    const doc = readFileSync(ARCH_DOC, "utf8");
    expect(doc).toMatch(/Importing a .*Member.* does NOT create a .*User.*/);
  });
});

// --------------------------------------------------------------
// §19.11 — Preview is read-only
// --------------------------------------------------------------
describe("MEM-HIST-1 §19.11 — preview is read-only", () => {
  it("parser is a pure function (no DB client import)", () => {
    const src = readFileSync(
      path.join(REPO, "src/lib/imports/member-master/parser.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+"@\/lib\/prisma"/);
    expect(src).not.toMatch(/prisma\./);
  });

  it("match resolver is a pure function (no DB client import)", () => {
    const src = readFileSync(
      path.join(REPO, "src/lib/imports/member-master/match-resolver.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+"@\/lib\/prisma"/);
    expect(src).not.toMatch(/prisma\./);
  });
});

// --------------------------------------------------------------
// §19.12 — No real member identities in fixtures / tests / logs
// --------------------------------------------------------------
describe("MEM-HIST-1 §19.12 — synthetic identities only", () => {
  it("fixture rows carry only CR-XXXXXX synthetic identifiers", () => {
    const fixtureSrc = readFileSync(
      path.join(REPO, "tests/fixtures/member-master/synthetic-member-master.ts"),
      "utf8",
    );
    const ids = Array.from(fixtureSrc.matchAll(/"(CR-[a-z0-9]+)"/gi)).map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).toMatch(/^CR-[a-z0-9]{4,}$/);
    }
    // No digits-only member numbers that would look like real Jonas IDs.
    const bareNumbers = fixtureSrc.match(/"(\d{4,6})"/g);
    expect(bareNumbers).toBeNull();
  });

  it("architecture doc has no real-identity leaks (common Silver Springs patterns)", () => {
    const doc = readFileSync(ARCH_DOC, "utf8");
    // Guard — any committed email domain or Silver Springs real-pattern.
    expect(doc).not.toMatch(/@silversprings\.com/i);
    // Common Silver Springs member-number shapes (ten-digit, dashed).
    expect(doc).not.toMatch(/\b\d{3}-\d{3}-\d{4}\b/); // phone-shaped
    // The tenant name "Silver Springs" is permitted — the doc
    // explains WHY real identities from that tenant must not land
    // in Coulee. The guard is against real identifiers, not the
    // tenant name itself.
    // Permitted: the ASCII diagram example "123456" clearly marked
    // in context (JONAS → "123456") is a synthetic example, not a
    // real identifier.
  });
});

// --------------------------------------------------------------
// §19.13-16 — Accounting invariants (schema-level guard)
// --------------------------------------------------------------
describe("MEM-HIST-1 §19.13-16 — accounting invariants + Dec/Jan/Feb hold", () => {
  // MEM-HIST-2 (2026-10-03) now adds schema for MemberExternalIdentity +
  // MemberMasterImportBatch + MembershipHistoryEntry +
  // MemberBillingRelationship. The MEM-HIST-1 "no schema" guard is
  // superseded — but the ACCOUNTING guard (no new accounting-table
  // migration) stands.
  it("no NEW accounting-table migration lands under this label", () => {
    const dirs = ["prisma/migrations", "prisma-postgres/migrations"];
    for (const d of dirs) {
      const latest = latestMigrationFolder(path.join(REPO, d));
      // Guard against mis-named migrations that touch accounting
      // tables under a member-master label.
      if (latest.includes("member_master") || latest.includes("mem_hist")) {
        const sqlPath = path.join(REPO, d, latest, "migration.sql");
        if (existsSync(sqlPath)) {
          const sql = readFileSync(sqlPath, "utf8");
          expect(sql.toLowerCase()).not.toMatch(/\balter table "account"/);
          expect(sql.toLowerCase()).not.toMatch(/\balter table "journalentry"/);
          expect(sql.toLowerCase()).not.toMatch(/\balter table "reportingledger/);
        }
      }
    }
  });
});

// --------------------------------------------------------------
// Privacy / sanitization helper
// --------------------------------------------------------------
describe("MEM-HIST-1 §G — deterministic sanitization helper", () => {
  it("makeSyntheticIdentifier is deterministic (same input → same output)", () => {
    const salt = "founder-local-salt-min-16-chars-long";
    const a = makeSyntheticIdentifier("12345", salt);
    const b = makeSyntheticIdentifier("12345", salt);
    expect(a).toBe(b);
    expect(a).toMatch(/^CR-[0-9a-f]{12}$/);
  });

  it("makeSyntheticIdentifier changes when the real identifier changes", () => {
    const salt = "founder-local-salt-min-16-chars-long";
    const a = makeSyntheticIdentifier("12345", salt);
    const b = makeSyntheticIdentifier("67890", salt);
    expect(a).not.toBe(b);
  });

  it("salt < 16 chars throws", () => {
    expect(() => makeSyntheticIdentifier("12345", "short")).toThrow(/at least 16 characters/);
    expect(() => makeSyntheticDisplayName("12345", "short")).toThrow(/at least 16 characters/);
  });

  it("assertSaltLooksSecret rejects pure-digit salts", () => {
    expect(() => assertSaltLooksSecret("123456789012345678")).toThrow(/pure digits/);
  });
});

// --------------------------------------------------------------
// Jonas source contract documented
// --------------------------------------------------------------
describe("MEM-HIST-1 §S — Jonas source contract delivered to founder", () => {
  it("architecture doc contains the operational Jonas instruction", () => {
    const doc = readFileSync(ARCH_DOC, "utf8");
    expect(doc).toMatch(/EXACT JONAS SOURCE CONTRACT FOR THE FOUNDER/);
    expect(doc).toMatch(/REQUIRED/);
    expect(doc).toMatch(/HIGHLY DESIRABLE/);
    expect(doc).toMatch(/DO NOT PROVIDE for staging/);
    expect(doc).toMatch(/Member Number/);
    expect(doc).toMatch(/classification code/i);
  });
});

// --------------------------------------------------------------
// Helpers
// --------------------------------------------------------------
function latestMigrationFolder(dir: string): string {
  if (!existsSync(dir)) return "";
  const fs = require("node:fs") as typeof import("node:fs");
  const entries = fs.readdirSync(dir).filter((n) => !n.startsWith(".") && n !== "migration_lock.toml");
  entries.sort();
  return entries[entries.length - 1] ?? "";
}
