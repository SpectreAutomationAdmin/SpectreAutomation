// Sprint 3 · Checkpoint 15J — capital-asset predictor rules.
//
// The 2026-07-27 audit of the Coulee Ridge 237-row COA import
// surfaced a false-positive "fully mapped" state: obvious capital
// assets (Equipment & Fixtures, Construction in Progress, Capital
// Improvements, Equipment under financing) were falling through to
// the 1xxx bracket default (CURRENT_ASSETS / BS_OTHER_ASSETS) with
// only "medium" confidence.
//
// This test locks the fix — every one of the founder-observed
// capital-asset naming patterns must land on the correct FS Group
// via the "name-keyword" source with "high" confidence, and must
// preserve the founder's decoupling of category from FS Group
// (CAPITAL_ASSETS category with BS_CIP or BS_CAPITAL_ASSETS FS
// Group — never CURRENT_ASSETS / BS_OTHER_ASSETS).
//
// Also locks the false-positive guards: `capital assessment` (a
// revenue line), `capital lease` (a liability), `capital
// contributions` (deferred equity/liability), `capital reserve`
// (equity), and expense-side `equipment rental` / `vehicle fuel`
// / `computer supplies` / `building repairs` MUST NOT match the
// capital-asset rule.

import { describe, it, expect } from "vitest";
import { predictCoaRow } from "@/lib/imports/coa-predictor";

describe("15J — Construction in Progress (CIP) recognition", () => {
  const CIP_CASES = [
    { number: "1501", name: "Construction in Progress - Teeboxes" },
    { number: "1502", name: "Construction in Progress - Irrigation" },
    // Founder-observed Jonas shorthand — "-ion" dropped for column
    // width. The predictor must treat "Construct in Progress"
    // identically to "Construction in Progress".
    { number: "1501", name: "Construct in Progress - Teeboxes" },
    { number: "1502", name: "Construct in Progress - Irrigation" },
    { number: "1520", name: "CIP - Clubhouse Renovation" },
    { number: "1521", name: "WIP - Course Redesign" },
    { number: "1522", name: "Work in Progress - Cart Path" },
    { number: "1523", name: "Capital Work in Progress" },
  ];
  for (const c of CIP_CASES) {
    it(`"${c.name}" → BS_CIP (Capital Assets)`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("ASSET");
      expect(p.categoryKey).toBe("CAPITAL_ASSETS");
      expect(p.fsGroupKey).toBe("BS_CIP");
      expect(p.confidence).toBe("high");
      // Source is name-keyword when the original text already
      // contains the trigger phrase; abbreviation-normalized only
      // when the expansion table did the work.
      expect(["name-keyword", "abbreviation-normalized"]).toContain(p.source);
    });
  }
});

describe("15J — Capital Improvements + specific capital-asset naming", () => {
  const CAP_CASES = [
    { number: "1503", name: "Capital Improvements" },
    { number: "1504", name: "Buildings - Clubhouse" },
    { number: "1505", name: "Equipment & Fixtures - Clubhouse" },
    { number: "1506", name: "Equipment & Fixtures - Grounds" },
    { number: "1507", name: "Equipment & Fixtures - Computers" },
    { number: "1508", name: "Equipment under financing" },
    { number: "1530", name: "Furniture & Fixtures" },
    { number: "1531", name: "Furn & Fixtures - Clubhouse" },
    { number: "1532", name: "Leasehold Improvements" },
    { number: "1533", name: "Computer Equipment" },
    { number: "1534", name: "Vehicles" },
    { number: "1535", name: "Equipment and Furniture" },
    { number: "1500", name: "Land" },
    { number: "1560", name: "Machinery" },
    { number: "1570", name: "Property & Equipment" },
  ];
  for (const c of CAP_CASES) {
    it(`"${c.name}" → BS_CAPITAL_ASSETS (Capital Assets)`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("ASSET");
      expect(p.categoryKey).toBe("CAPITAL_ASSETS");
      expect(p.fsGroupKey).toBe("BS_CAPITAL_ASSETS");
      expect(p.confidence).toBe("high");
      expect(["name-keyword", "abbreviation-normalized"]).toContain(p.source);
    });
  }
});

describe("15J — Accumulated Depreciation stays in Capital Assets (contra)", () => {
  const ACCUM_CASES = [
    { number: "1509", name: "Accum Deprec - Capital Improvements" },
    { number: "1510", name: "Accum Deprec - Clubhouse" },
    { number: "1511", name: "Accum Deprec - Clubhouse Eqp & Fix" },
    { number: "1512", name: "Accum Deprec - Grounds Eqp & Fix" },
    { number: "1513", name: "Accum Deprec - Computer Eqp & Fix" },
    { number: "1514", name: "Accum Deprec - Equip under financin" },
    { number: "1515", name: "Accumulated Depreciation - Equipment" },
    { number: "1516", name: "Accumulated Depreciation" },
  ];
  for (const c of ACCUM_CASES) {
    it(`"${c.name}" → BS_CAPITAL_ASSETS (contra-asset)`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      expect(p.type).toBe("ASSET"); // contra-asset remains an ASSET type
      expect(p.categoryKey).toBe("CAPITAL_ASSETS");
      expect(p.fsGroupKey).toBe("BS_CAPITAL_ASSETS");
      expect(p.confidence).toBe("high");
    });
  }
});

describe("15J — False-positive guards: 'capital'-containing phrases MUST NOT hit BS_CAPITAL_ASSETS", () => {
  it("Capital Assessment (revenue) stays on IS_CAPITAL_ASSESSMENTS", () => {
    const p = predictCoaRow({ number: "4020", name: "Capital Assessment - Members" });
    expect(p.type).toBe("REVENUE");
    expect(p.fsGroupKey).toBe("IS_CAPITAL_ASSESSMENTS");
  });
  it("Special Assessment (revenue) also routes to IS_CAPITAL_ASSESSMENTS", () => {
    const p = predictCoaRow({ number: "4021", name: "Special Assessment" });
    expect(p.type).toBe("REVENUE");
    expect(p.fsGroupKey).toBe("IS_CAPITAL_ASSESSMENTS");
  });
  it("Capital Lease Liability (liability) stays on BS_LEASE_LIABILITIES", () => {
    const p = predictCoaRow({ number: "2307", name: "Capital Lease - TD Golf Carts" });
    expect(p.type).toBe("LIABILITY");
    expect(p.fsGroupKey).toBe("BS_LEASE_LIABILITIES");
  });
  it("Deferred Capital Contributions (liability) stays on BS_DEFERRED_CAPITAL_CONTRIBUTIONS", () => {
    const p = predictCoaRow({ number: "2305", name: "Deferred capital contributions" });
    expect(p.type).toBe("LIABILITY");
    expect(p.fsGroupKey).toBe("BS_DEFERRED_CAPITAL_CONTRIBUTIONS");
  });
  it("Capital Reserve (equity) stays on BS_CAPITAL_RESERVE", () => {
    const p = predictCoaRow({ number: "3400", name: "Capital Reserve Fund" });
    expect(p.type).toBe("EQUITY");
    expect(p.fsGroupKey).toBe("BS_CAPITAL_RESERVE");
  });
});

describe("15J — Expense-side rules retain precedence over the new asset language", () => {
  it("Equipment Rental (expense) stays on IS_VEHICLE_EQUIPMENT — asset rule must NOT hijack", () => {
    const p = predictCoaRow({ number: "6100", name: "Equipment Rental" });
    expect(p.type).toBe("EXPENSE");
    expect(p.fsGroupKey).toBe("IS_VEHICLE_EQUIPMENT");
  });
  it("Vehicle Fuel (expense) stays on IS_VEHICLE_EQUIPMENT", () => {
    const p = predictCoaRow({ number: "6025", name: "Vehicle Fuel" });
    expect(p.type).toBe("EXPENSE");
    expect(p.fsGroupKey).toBe("IS_VEHICLE_EQUIPMENT");
  });
  it("Building Repairs (expense) stays on IS_REPAIRS_MAINTENANCE — 'building' word alone doesn't trigger BS_CAPITAL_ASSETS", () => {
    const p = predictCoaRow({ number: "6030", name: "Building Repairs" });
    expect(p.type).toBe("EXPENSE");
    expect(p.fsGroupKey).toBe("IS_REPAIRS_MAINTENANCE");
  });
  it("Computer Supplies (expense) doesn't hit capital-asset rule (bracket keeps it in EXPENSE)", () => {
    const p = predictCoaRow({ number: "6065", name: "Computer Supplies" });
    expect(p.type).toBe("EXPENSE");
    // Computer + supplies → IT_SOFTWARE via `computer` token in the
    // IT rule (bare token, expense bracket).
    expect(p.fsGroupKey).toBe("IS_IT_SOFTWARE");
  });
  it("Depreciation Expense stays on IS_DEPRECIATION (expense)", () => {
    const p = predictCoaRow({ number: "9901", name: "Depreciation" });
    expect(p.type).toBe("EXPENSE");
    expect(p.fsGroupKey).toBe("IS_DEPRECIATION");
  });
});

describe("15J — No capital-asset naming may fall to CURRENT_ASSETS / BS_OTHER_ASSETS (the founder's Coulee Ridge assertion)", () => {
  // Every one of the founder's named accounts is asserted against
  // the primary condition — regardless of confidence, the specific
  // problem behaviour (Current Assets / Other Assets fallback) must
  // be gone.
  const CANONICAL_LIST = [
    { number: "1501", name: "Construction in Progress - Teeboxes" },
    { number: "1501", name: "Construct in Progress - Teeboxes" },
    { number: "1502", name: "Construction in Progress - Irrigation" },
    { number: "1502", name: "Construct in Progress - Irrigation" },
    { number: "1503", name: "Capital Improvements" },
    { number: "1505", name: "Equipment & Fixtures - Clubhouse" },
    { number: "1506", name: "Equipment & Fixtures - Grounds" },
    { number: "1507", name: "Equipment & Fixtures - Computers" },
    { number: "1508", name: "Equipment under financing" },
  ];
  for (const c of CANONICAL_LIST) {
    it(`"${c.name}" is NEVER classified as CURRENT_ASSETS / BS_OTHER_ASSETS`, () => {
      const p = predictCoaRow({ number: c.number, name: c.name });
      // Primary invariant: no capital-asset name falls to the
      // 1xxx bracket default.
      const isCurrentAssetsFallback =
        p.categoryKey === "CURRENT_ASSETS" && p.fsGroupKey === "BS_OTHER_ASSETS";
      expect(isCurrentAssetsFallback).toBe(false);
      // Secondary: category must be CAPITAL_ASSETS.
      expect(p.categoryKey).toBe("CAPITAL_ASSETS");
      // Tertiary: source is a real semantic match, not bracket
      // default.
      expect(p.source).not.toBe("number-range");
    });
  }
});
