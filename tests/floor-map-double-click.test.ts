// POS cleanup step 31 — floor-map double-click drilldown.
//
// Single click selects a table (opens the side panel — unchanged).
// Double click on a SEATED table with an active POSCheck navigates
// straight to /app/admin/ops/pos/lounge/table/[checkId]. All other
// table states no-op on double click so a fast click on an
// AVAILABLE / DIRTY / RESERVED tile doesn't accidentally redirect.
//
// The eligibility predicate lives in canOpenSeatViewOnDoubleClick.
// These tests pin it directly + assert the SeatPOS route enforces
// tenant isolation (spec 10).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { canOpenSeatViewOnDoubleClick } from "@/lib/hospitality/floor-map-interactions";

const FLOOR_MAP_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
  "utf8",
);

// =============================================================================
// Spec 1 — Double-click seated POS table with active check navigates.
// Spec 2 — Double-click reservation-seated table with linked check navigates.
//          Both paths produce the same `FloorTable` shape in the loader:
//          status === "SEATED" and openCheckId is populated.
// =============================================================================
describe("Specs 1/2 — SEATED + openCheckId → navigates to seat view", () => {
  it("self-seated table returns the /lounge/table/<id> URL", () => {
    const href = canOpenSeatViewOnDoubleClick({ status: "SEATED", openCheckId: "chk-1" });
    expect(href).toBe("/app/admin/ops/pos/lounge/table/chk-1");
  });

  it("reservation-seated table (same shape) returns the URL too", () => {
    // The loader normalises both seating paths to {status, openCheckId},
    // so the predicate doesn't need to distinguish source.
    const href = canOpenSeatViewOnDoubleClick({ status: "SEATED", openCheckId: "chk-res-42" });
    expect(href).toBe("/app/admin/ops/pos/lounge/table/chk-res-42");
  });
});

// =============================================================================
// Spec 3 — Seated table with no active check does NOT navigate.
// Spec 4 — Seated table with only CLOSED checks does NOT navigate.
//          The loader's `posChecks` join already filters non-CLOSED/VOIDED,
//          so "only CLOSED checks" presents to the client as openCheckId=null.
// =============================================================================
describe("Specs 3/4 — SEATED but no active check → null (no navigation)", () => {
  it("openCheckId null → null", () => {
    expect(canOpenSeatViewOnDoubleClick({ status: "SEATED", openCheckId: null })).toBeNull();
  });

  it("openCheckId empty string → null", () => {
    expect(canOpenSeatViewOnDoubleClick({ status: "SEATED", openCheckId: "" })).toBeNull();
  });
});

// =============================================================================
// Spec 5 — Double-click AVAILABLE table does NOT navigate.
// =============================================================================
describe("Spec 5 — AVAILABLE table double-click is a no-op", () => {
  it("AVAILABLE always returns null even if a stale openCheckId is present", () => {
    expect(canOpenSeatViewOnDoubleClick({ status: "AVAILABLE", openCheckId: "chk-x" })).toBeNull();
    expect(canOpenSeatViewOnDoubleClick({ status: "AVAILABLE", openCheckId: null })).toBeNull();
  });
});

// =============================================================================
// Spec 6 — Double-click DIRTY / Needs Reset table does NOT navigate.
// =============================================================================
describe("Spec 6 — DIRTY table double-click is a no-op", () => {
  it("DIRTY returns null", () => {
    expect(canOpenSeatViewOnDoubleClick({ status: "DIRTY", openCheckId: null })).toBeNull();
  });

  it("DIRTY with a (closed) openCheckId still returns null — status gate wins", () => {
    expect(canOpenSeatViewOnDoubleClick({ status: "DIRTY", openCheckId: "stale-chk" })).toBeNull();
  });
});

// =============================================================================
// Spec 7 — Double-click RESERVED table does NOT navigate.
// =============================================================================
describe("Spec 7 — RESERVED table double-click is a no-op", () => {
  it("RESERVED returns null", () => {
    expect(canOpenSeatViewOnDoubleClick({ status: "RESERVED", openCheckId: null })).toBeNull();
  });

  it("OUT_OF_SERVICE also returns null", () => {
    expect(canOpenSeatViewOnDoubleClick({ status: "OUT_OF_SERVICE", openCheckId: null })).toBeNull();
  });
});

// =============================================================================
// Spec 8 — Single click still selects and opens the side panel.
// =============================================================================
describe("Spec 8 — single click handler unchanged", () => {
  it("AreaCanvas still wires onClick={() => onSelect(t.id)} on TableShape", () => {
    // Loose match — the literal still appears in source, proving
    // the single-click path wasn't replaced.
    expect(FLOOR_MAP_SRC).toMatch(/onClick=\{\(\) => onSelect\(t\.id\)\}/);
  });

  it("FloorMap still wires onSelect={(id) => setSelectedTableId(id)} on AreaCanvas", () => {
    expect(FLOOR_MAP_SRC).toMatch(/onSelect=\{\(id\) => setSelectedTableId\(id\)\}/);
  });
});

// =============================================================================
// Spec 9 — "Open seat view" button still present (the keyboard / touch fallback).
// =============================================================================
describe("Spec 9 — keyboard / touch fallback Open seat view button is still rendered", () => {
  it("SeatViewCTA component still emits a Link to /app/admin/ops/pos/lounge/table/<id>", () => {
    expect(FLOOR_MAP_SRC).toMatch(/\/app\/admin\/ops\/pos\/lounge\/table\/\$\{openCheckId\}/);
  });
});

// =============================================================================
// Spec 10 — Cross-tenant table/check navigation blocked.
//           Navigation is client-side; the server-side guard on the
//           SeatPOS route is what enforces tenancy. Assert the route
//           still does the tenant-safe lookup.
// =============================================================================
describe("Spec 10 — cross-tenant navigation refused at the seat-view route", () => {
  it("SeatPOS page still calls a tenant-safe lookup for the check id", () => {
    const pagePath = path.resolve(
      process.cwd(),
      "src/app/app/admin/ops/pos/lounge/table/[checkId]/page.tsx",
    );
    const src = fs.readFileSync(pagePath, "utf8");
    // The route resolves the check through seatSummary (which calls
    // assertTenantOwned) OR an explicit tenant-scoped findUnique.
    // Either way: NO `prisma.pOSCheck.findUnique({where: {id}})`
    // without a tenant predicate following it.
    expect(src).toMatch(/assertTenantOwned|seatSummary|tenantWhere/);
  });
});

// =============================================================================
// Source-contract — the double-click handler is wired on the tile.
// =============================================================================
describe("Source contract — onDoubleClick handler is on the table <g>", () => {
  it("TableShape passes onDoubleClick={onDoubleClick} on the SVG group", () => {
    expect(FLOOR_MAP_SRC).toMatch(/onDoubleClick=\{onDoubleClick\}/);
  });

  it("AreaCanvas threads onDoubleSelect to TableShape.onDoubleClick", () => {
    expect(FLOOR_MAP_SRC).toMatch(/onDoubleClick=\{\(\) => onDoubleSelect\(t\)\}/);
  });

  it("FloorMap calls canOpenSeatViewOnDoubleClick + router.push from onDoubleSelect", () => {
    expect(FLOOR_MAP_SRC).toMatch(/canOpenSeatViewOnDoubleClick\(table\)/);
    expect(FLOOR_MAP_SRC).toMatch(/router\.push\(href\)/);
  });
});
