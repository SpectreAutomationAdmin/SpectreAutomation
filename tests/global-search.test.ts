// Phase 4R rev-4 (2026-08-15) — Global search domain-logic contract.
//
// Deterministic local fixture (no reliance on staging Microsoft
// data). Verifies:
//   • min-query-length short-circuit
//   • tenant scoping (clubId isolates results)
//   • vendor matching (legalName / operatingName / vendorNumber)
//   • invoice matching (invoiceNumber / vendorReference / vendor name)
//   • ranking (exact > prefix > substring)
//   • recency boost on invoices (two most recent Microsoft invoices
//     land in the top slots of the group)
//   • canonical destination URLs
//   • per-group result cap

import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { runGlobalSearch } from "@/lib/search/global-search";

const suiteToken = "gs-" + Math.random().toString(36).slice(2, 10);
let CLUB_A: string;
let CLUB_B: string;
let VENDOR_MSFT: string;
let VENDOR_MSFT_OTHER_CLUB: string;
let INV_A_ID: string;
let INV_B_ID: string;
let INV_C_ID: string;

beforeAll(async () => {
  const clubA = await prisma.club.create({
    data: { slug: `${suiteToken}-a`, name: "GS Test Club A" }, select: { id: true },
  });
  const clubB = await prisma.club.create({
    data: { slug: `${suiteToken}-b`, name: "GS Test Club B" }, select: { id: true },
  });
  CLUB_A = clubA.id; CLUB_B = clubB.id;

  const msft = await prisma.vendor.create({
    data: {
      clubId: CLUB_A, vendorNumber: "V-0001",
      legalName: "Microsoft Corporation", operatingName: null, status: "APPROVED",
    }, select: { id: true },
  });
  VENDOR_MSFT = msft.id;

  // A different-club Microsoft vendor — should NEVER surface for CLUB_A queries.
  const other = await prisma.vendor.create({
    data: {
      clubId: CLUB_B, vendorNumber: "V-9999",
      legalName: "Microsoft Corporation", operatingName: null, status: "APPROVED",
    }, select: { id: true },
  });
  VENDOR_MSFT_OTHER_CLUB = other.id;

  // Non-matching vendor (ranking + noise control).
  await prisma.vendor.create({
    data: {
      clubId: CLUB_A, vendorNumber: "V-0002",
      legalName: "Cloud Reseller Partners Inc.", operatingName: null, status: "APPROVED",
    }, select: { id: true },
  });

  // Three Microsoft invoices on CLUB_A. Recency ranking must promote
  // the two most recent to the top of the invoice group.
  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const invA = await prisma.aPInvoice.create({
    data: {
      clubId: CLUB_A, vendorId: VENDOR_MSFT,
      invoiceNumber: "AP-2026-000001", vendorReference: "E0701097E3",
      invoiceDate: daysAgo(1),
      subtotal: "29.80", taxTotal: "1.49", total: "31.29",
      currency: "CAD", status: "POSTED",
    }, select: { id: true },
  });
  INV_A_ID = invA.id;
  const invB = await prisma.aPInvoice.create({
    data: {
      clubId: CLUB_A, vendorId: VENDOR_MSFT,
      invoiceNumber: "AP-2025-011888", vendorReference: "E0611099A1",
      invoiceDate: daysAgo(28),
      subtotal: "31.19", taxTotal: "1.56", total: "32.75",
      currency: "CAD", status: "POSTED",
    }, select: { id: true },
  });
  INV_B_ID = invB.id;
  const invC = await prisma.aPInvoice.create({
    data: {
      clubId: CLUB_A, vendorId: VENDOR_MSFT,
      invoiceNumber: "AP-2024-002211", vendorReference: "D0509004B0",
      invoiceDate: daysAgo(365),
      subtotal: "30.00", taxTotal: "1.50", total: "31.50",
      currency: "CAD", status: "POSTED",
    }, select: { id: true },
  });
  INV_C_ID = invC.id;

  // Invoice on the OTHER club — must not surface for CLUB_A queries.
  await prisma.aPInvoice.create({
    data: {
      clubId: CLUB_B, vendorId: VENDOR_MSFT_OTHER_CLUB,
      invoiceNumber: "AP-2026-B0001", vendorReference: "OTHER-ONLY",
      invoiceDate: now,
      subtotal: "999.99", taxTotal: "50.00", total: "1049.99",
      currency: "CAD", status: "POSTED",
    },
  });
});

describe("runGlobalSearch — min length / query hygiene", () => {
  it("empty query returns no results", async () => {
    const r = await runGlobalSearch({ prisma, clubId: CLUB_A, query: "" });
    expect(r.vendors).toEqual([]);
    expect(r.invoices).toEqual([]);
  });
  it("one-character query returns no results (min length 2)", async () => {
    const r = await runGlobalSearch({ prisma, clubId: CLUB_A, query: "M" });
    expect(r.vendors).toEqual([]);
    expect(r.invoices).toEqual([]);
  });
  it("whitespace-only query returns no results", async () => {
    const r = await runGlobalSearch({ prisma, clubId: CLUB_A, query: "   " });
    expect(r.vendors).toEqual([]);
    expect(r.invoices).toEqual([]);
  });
});

describe("runGlobalSearch — tenant scoping", () => {
  it("CLUB_A 'Microsoft' returns ONLY CLUB_A vendors + invoices", async () => {
    const r = await runGlobalSearch({ prisma, clubId: CLUB_A, query: "Microsoft" });
    // vendors
    const vendorIds = r.vendors.map((v) => v.id);
    expect(vendorIds).toContain(VENDOR_MSFT);
    expect(vendorIds).not.toContain(VENDOR_MSFT_OTHER_CLUB);
    // invoices
    for (const inv of r.invoices) {
      // OTHER-ONLY must never appear on CLUB_A
      expect(inv.secondaryLabel).not.toMatch(/AP-2026-B0001/);
      expect(inv.secondaryLabel).not.toMatch(/OTHER-ONLY/);
    }
  });
  it("CLUB_B 'Microsoft' returns ONLY CLUB_B vendors + invoices", async () => {
    const r = await runGlobalSearch({ prisma, clubId: CLUB_B, query: "Microsoft" });
    const vendorIds = r.vendors.map((v) => v.id);
    expect(vendorIds).toContain(VENDOR_MSFT_OTHER_CLUB);
    expect(vendorIds).not.toContain(VENDOR_MSFT);
    // The CLUB_A invoices must never appear.
    for (const inv of r.invoices) {
      expect(inv.href).not.toMatch(new RegExp(INV_A_ID));
      expect(inv.href).not.toMatch(new RegExp(INV_B_ID));
      expect(inv.href).not.toMatch(new RegExp(INV_C_ID));
    }
  });
});

describe("runGlobalSearch — vendor matching + destination URLs", () => {
  it("legalName exact match ranks Microsoft first", async () => {
    const r = await runGlobalSearch({ prisma, clubId: CLUB_A, query: "Microsoft Corporation" });
    expect(r.vendors[0]?.id).toBe(VENDOR_MSFT);
    expect(r.vendors[0]?.href).toBe(`/app/admin/ap/vendors/${VENDOR_MSFT}/timeline`);
    expect(r.vendors[0]?.entityType).toBe("VENDOR");
  });
  it("legalName prefix match returns Microsoft", async () => {
    const r = await runGlobalSearch({ prisma, clubId: CLUB_A, query: "Microsoft" });
    expect(r.vendors[0]?.id).toBe(VENDOR_MSFT);
  });
  it("vendorNumber match returns the vendor", async () => {
    const r = await runGlobalSearch({ prisma, clubId: CLUB_A, query: "V-0001" });
    const found = r.vendors.find((v) => v.id === VENDOR_MSFT);
    expect(found).toBeTruthy();
  });
});

describe("runGlobalSearch — invoice matching + recency ranking", () => {
  it("'Microsoft' surfaces the two most recent invoices in top slots", async () => {
    const r = await runGlobalSearch({ prisma, clubId: CLUB_A, query: "Microsoft" });
    // The two most recent invoices are INV_A (yesterday) and INV_B (28d ago).
    // INV_C (365d) should follow them or be excluded by the cap; here we
    // assert the top-two ordering explicitly.
    expect(r.invoices.length).toBeGreaterThanOrEqual(2);
    expect(r.invoices[0]?.id).toBe(INV_A_ID);
    expect(r.invoices[1]?.id).toBe(INV_B_ID);
    // Destination URL is canonical.
    expect(r.invoices[0]?.href).toBe(`/app/admin/ap/invoices/${INV_A_ID}`);
    // Secondary label contains the AP invoice number + total + status.
    expect(r.invoices[0]?.secondaryLabel).toContain("AP-2026-000001");
    expect(r.invoices[0]?.secondaryLabel).toContain("$31.29 CAD");
    expect(r.invoices[0]?.secondaryLabel).toContain("Posted");
  });
  it("vendorReference match works", async () => {
    const r = await runGlobalSearch({ prisma, clubId: CLUB_A, query: "E0701097E3" });
    expect(r.invoices[0]?.id).toBe(INV_A_ID);
  });
  it("APInvoice number match works", async () => {
    const r = await runGlobalSearch({ prisma, clubId: CLUB_A, query: "AP-2026-000001" });
    expect(r.invoices[0]?.id).toBe(INV_A_ID);
  });
});

describe("runGlobalSearch — result cap", () => {
  it("limitPerGroup caps results", async () => {
    const r = await runGlobalSearch({ prisma, clubId: CLUB_A, query: "Microsoft", limitPerGroup: 1 });
    expect(r.vendors.length).toBeLessThanOrEqual(1);
    expect(r.invoices.length).toBeLessThanOrEqual(1);
    expect(r.invoices[0]?.id).toBe(INV_A_ID);
  });
});
