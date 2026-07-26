// Sprint 3 Checkpoint 15F (2026-07-24) — Vendor merge integration
// test. Uses the SQLite dev DB. Verifies transactional merge behaviour,
// invoice repointing, alias creation, cross-club isolation, and
// preservation guarantees.

import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { simulateMerge } from "@/lib/vendor-intelligence/simulate";
import { executeMerge } from "@/lib/vendor-intelligence/consolidate";
import { resolveAnyAlias } from "@/lib/vendor-intelligence/resolve";
import { detectDuplicate } from "@/lib/vendor-intelligence/duplicate-detect";
import { VendorIntelligenceError } from "@/lib/vendor-intelligence/types";

const suiteToken = "c15f-" + Math.random().toString(36).slice(2, 10);
let CLUB: string;
let OTHER_CLUB: string;
let VENDOR_A: string; // canonical (winner)
let VENDOR_B: string; // loser
let ACCOUNT_ID: string;
let USER_ID: string;

beforeAll(async () => {
  const club = await prisma.club.create({
    data: { slug: `${suiteToken}-club`, name: "C15F Test" },
    select: { id: true },
  });
  CLUB = club.id;
  const other = await prisma.club.create({
    data: { slug: `${suiteToken}-other`, name: "C15F Other" },
    select: { id: true },
  });
  OTHER_CLUB = other.id;
  const acc = await prisma.account.create({
    data: {
      clubId: CLUB, accountNumber: "6020-C15F", name: "Grounds Maintenance",
      type: "EXPENSE", normalBalance: "DEBIT", isActive: true, allowManualPosting: true, sortOrder: 620,
    },
    select: { id: true },
  });
  ACCOUNT_ID = acc.id;
  const user = await prisma.user.create({
    data: {
      email: `${suiteToken}@fixture.local`, name: "Test", status: "ACTIVE",
      clubId: CLUB, role: "SUPER_ADMIN",
      passwordHash: "$2a$10$fake.hash",
    },
    select: { id: true },
  });
  USER_ID = user.id;

  // Winner — "richer" vendor (has verified banking, tax number, invoices).
  const vendorA = await prisma.vendor.create({
    data: {
      clubId: CLUB, vendorNumber: "V-C15F-A", legalName: "Northside Course Maintenance Inc.",
      operatingName: "Northside", status: "ACTIVE",
      taxRegistrationNumber: "123456789 RT 0001",
      email: "billing@northside.example",
      website: "https://northside.example",
      defaultExpenseAccountId: ACCOUNT_ID,
    },
    select: { id: true },
  });
  VENDOR_A = vendorA.id;
  await prisma.vendorContact.create({
    data: { clubId: CLUB, vendorId: VENDOR_A, name: "Alice", email: "alice@northside.example", isPrimary: true },
  });
  await prisma.vendorBankingProfile.create({
    data: { clubId: CLUB, vendorId: VENDOR_A, type: "EFT", accountLastFour: "1234", status: "VERIFIED", isActive: true },
  });
  await prisma.aPInvoice.create({
    data: {
      clubId: CLUB, invoiceNumber: `APINV-${suiteToken}-A1`, vendorId: VENDOR_A,
      vendorReference: "INV-A-001", invoiceDate: new Date("2026-06-01"),
      subtotal: "500.00", taxTotal: "25.00", total: "525.00", currency: "CAD", status: "DRAFT",
    },
  });

  // Loser — same tax number + website (CONFIRMED duplicate), fewer records.
  const vendorB = await prisma.vendor.create({
    data: {
      clubId: CLUB, vendorNumber: "V-C15F-B", legalName: "Northside Course Maintenance Ltd.",
      operatingName: "Northside", status: "ACTIVE",
      taxRegistrationNumber: "123-456-789 RT0001",
      website: "www.northside.example",
    },
    select: { id: true },
  });
  VENDOR_B = vendorB.id;
  await prisma.aPInvoice.create({
    data: {
      clubId: CLUB, invoiceNumber: `APINV-${suiteToken}-B1`, vendorId: VENDOR_B,
      vendorReference: "INV-B-001", invoiceDate: new Date("2026-06-15"),
      subtotal: "1000.00", taxTotal: "50.00", total: "1050.00", currency: "CAD", status: "DRAFT",
    },
  });
});

describe("simulateMerge — preview only, zero writes", () => {
  it("returns counts + collisions + aliases without writing", async () => {
    const beforeInvoicesA = await prisma.aPInvoice.count({ where: { clubId: CLUB, vendorId: VENDOR_A } });
    const beforeInvoicesB = await prisma.aPInvoice.count({ where: { clubId: CLUB, vendorId: VENDOR_B } });
    const sim = await simulateMerge({ clubId: CLUB, winnerVendorId: VENDOR_A, loserVendorId: VENDOR_B });
    expect(sim.counts.invoices).toBe(beforeInvoicesB);
    expect(sim.aliasesToCreate.map((a) => a.aliasKind)).toEqual(
      expect.arrayContaining(["LEGAL_NAME", "TAX_NUMBER", "JONAS_VENDOR_CODE"]),
    );
    // Simulate must not have moved anything.
    const afterInvoicesA = await prisma.aPInvoice.count({ where: { clubId: CLUB, vendorId: VENDOR_A } });
    const afterInvoicesB = await prisma.aPInvoice.count({ where: { clubId: CLUB, vendorId: VENDOR_B } });
    expect(afterInvoicesA).toBe(beforeInvoicesA);
    expect(afterInvoicesB).toBe(beforeInvoicesB);
  });
});

describe("executeMerge — transactional, immutable, tenant-safe", () => {
  it("moves loser's invoices onto winner, marks loser MERGED, writes VendorMergeRecord", async () => {
    const result = await executeMerge({
      clubId: CLUB,
      winnerVendorId: VENDOR_A,
      loserVendorId: VENDOR_B,
      reason: "Confirmed duplicate — tax number match + website match",
      initiatedByUserId: USER_ID,
      approvedByUserId: USER_ID,
    });
    expect(result.mergeRecordId).toBeTruthy();
    expect(result.movedCounts.invoices).toBe(1);

    // Winner now has 2 invoices; loser has 0.
    const winnerInv = await prisma.aPInvoice.count({ where: { clubId: CLUB, vendorId: VENDOR_A } });
    const loserInv = await prisma.aPInvoice.count({ where: { clubId: CLUB, vendorId: VENDOR_B } });
    expect(winnerInv).toBe(2);
    expect(loserInv).toBe(0);

    // Loser is marked MERGED with mutated identity so uniqueness stays intact.
    const loser = await prisma.vendor.findUnique({ where: { id: VENDOR_B } });
    expect(loser?.status).toBe("MERGED");
    expect(loser?.legalName).toMatch(/^MERGED:/);
    expect(loser?.vendorNumber).toMatch(/^MERGED:/);

    // Aliases created and resolvable.
    const aliases = await prisma.vendorAlias.findMany({ where: { clubId: CLUB, canonicalVendorId: VENDOR_A } });
    const aliasKinds = aliases.map((a) => a.aliasKind);
    expect(aliasKinds).toEqual(expect.arrayContaining(["LEGAL_NAME", "TAX_NUMBER", "JONAS_VENDOR_CODE"]));

    // Merge record has the full simulation JSON.
    const rec = await prisma.vendorMergeRecord.findUnique({ where: { id: result.mergeRecordId } });
    expect(rec?.status).toBe("COMMITTED");
    expect(rec?.simulationJson.length).toBeGreaterThan(50);
    expect(rec?.createdAliasesCount).toBeGreaterThan(0);
  });

  it("refuses to merge a second time on the same loser (already MERGED)", async () => {
    await expect(
      executeMerge({
        clubId: CLUB,
        winnerVendorId: VENDOR_A,
        loserVendorId: VENDOR_B,
        reason: "duplicate call",
      }),
    ).rejects.toBeInstanceOf(VendorIntelligenceError);
  });
});

describe("resolveAnyAlias — future imports find the canonical", () => {
  it("resolves the loser's tax number to the winner", async () => {
    const hit = await resolveAnyAlias({ clubId: CLUB, taxNumber: "123-456-789 RT0001" });
    expect(hit).not.toBeNull();
    expect(hit?.canonicalVendorId).toBe(VENDOR_A);
    expect(hit?.aliasKind).toBe("TAX_NUMBER");
  });
  it("resolves the loser's legal name (normalised)", async () => {
    const hit = await resolveAnyAlias({ clubId: CLUB, legalName: "Northside Course Maintenance Ltd." });
    expect(hit).not.toBeNull();
    expect(hit?.canonicalVendorId).toBe(VENDOR_A);
    expect(hit?.aliasKind).toBe("LEGAL_NAME");
  });
  it("cross-club — resolver does NOT return canonical from another club", async () => {
    const hit = await resolveAnyAlias({ clubId: OTHER_CLUB, taxNumber: "123-456-789 RT0001" });
    expect(hit).toBeNull();
  });
});

describe("preservation guarantees", () => {
  it("APInvoices previously on the loser retain their invoiceNumber + amounts", async () => {
    const moved = await prisma.aPInvoice.findFirst({
      where: { clubId: CLUB, invoiceNumber: `APINV-${suiteToken}-B1` },
    });
    expect(moved).not.toBeNull();
    expect(moved?.vendorId).toBe(VENDOR_A);
    expect(moved?.total.toString()).toBe("1050");
    expect(moved?.vendorReference).toBe("INV-B-001");
  });
});

describe("cross-club isolation — cannot merge across clubs", () => {
  it("simulateMerge refuses when winner + loser are in different clubs", async () => {
    const otherVendor = await prisma.vendor.create({
      data: {
        clubId: OTHER_CLUB, vendorNumber: "V-OTHER", legalName: "Other Vendor",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    await expect(
      simulateMerge({ clubId: CLUB, winnerVendorId: VENDOR_A, loserVendorId: otherVendor.id }),
    ).rejects.toBeInstanceOf(VendorIntelligenceError);
  });
});
