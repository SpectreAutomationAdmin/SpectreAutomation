// Phase 4R rev-5 (2026-08-15) — breadcrumb derivation contract.
//
// Pins:
//   • Mission Control leaf override preserved
//   • `admin` segment suppressed everywhere
//   • `ap` → `AP` (acronym override), `coa` → `COA`, `pos` → `POS`, etc.
//   • cuid segments never leak to the user
//   • dynamicLabels replace cuids with entity display names
//   • sub-route hrefs use the ORIGINAL path (suppression must not
//     break navigation links)

import { describe, it, expect } from "vitest";
import {
  deriveBreadcrumbs,
  SEGMENT_LABEL_OVERRIDES,
  SEGMENT_SUPPRESS,
  PATH_LEAF_LABEL_OVERRIDES,
} from "@/lib/chrome/breadcrumb";

describe("deriveBreadcrumbs — Mission Control preserved", () => {
  it("/app/admin → App > Mission Control (no Admin crumb)", () => {
    const crumbs = deriveBreadcrumbs("/app/admin");
    expect(crumbs.map((c) => c.label)).toEqual(["App", "Mission Control"]);
    expect(crumbs[0].href).toBe("/app");
    expect(crumbs[1].href).toBeUndefined();
  });
  it("/app/member → App > Member Portal", () => {
    const crumbs = deriveBreadcrumbs("/app/member");
    expect(crumbs.map((c) => c.label)).toEqual(["App", "Member Portal"]);
  });
});

describe("deriveBreadcrumbs — admin segment suppressed", () => {
  it("/app/admin/members → App > Members (no Admin)", () => {
    const crumbs = deriveBreadcrumbs("/app/admin/members");
    expect(crumbs.map((c) => c.label)).toEqual(["App", "Members"]);
    // Href for leaf is undefined; parent href points to /app.
    expect(crumbs[0].href).toBe("/app");
    expect(crumbs[1].href).toBeUndefined();
  });
  it("/app/admin/ap → App > AP (no Admin, acronym applied)", () => {
    const crumbs = deriveBreadcrumbs("/app/admin/ap");
    expect(crumbs.map((c) => c.label)).toEqual(["App", "AP"]);
  });
  it("/app/admin/ap/vendors → App > AP > Vendors", () => {
    const crumbs = deriveBreadcrumbs("/app/admin/ap/vendors");
    expect(crumbs.map((c) => c.label)).toEqual(["App", "AP", "Vendors"]);
    // Non-leaf hrefs preserve the ORIGINAL URL (suppression must not
    // break navigation).
    expect(crumbs[0].href).toBe("/app");
    expect(crumbs[1].href).toBe("/app/admin/ap");
    expect(crumbs[2].href).toBeUndefined();
  });
});

describe("deriveBreadcrumbs — acronym overrides at any depth", () => {
  it.each([
    ["ap", "AP"],
    ["ar", "AR"],
    ["coa", "COA"],
    ["gl", "GL"],
    ["hr", "HR"],
    ["it", "IT"],
    ["mfa", "MFA"],
    ["pos", "POS"],
    ["ui", "UI"],
  ])("segment '%s' renders as '%s'", (seg, expected) => {
    const crumbs = deriveBreadcrumbs(`/app/admin/${seg}`);
    expect(crumbs.map((c) => c.label)).toEqual(["App", expected]);
  });
  it("ops → Operations (word override, not acronym)", () => {
    const crumbs = deriveBreadcrumbs("/app/admin/ops");
    expect(crumbs.map((c) => c.label)).toEqual(["App", "Operations"]);
  });
  it("overrides survive at deep positions (leaf AND non-leaf)", () => {
    const crumbs = deriveBreadcrumbs("/app/admin/ap/invoices");
    expect(crumbs.map((c) => c.label)).toEqual(["App", "AP", "Invoices"]);
  });
});

describe("deriveBreadcrumbs — cuid never leaks", () => {
  it("bare vendor cuid renders as 'Detail' when no dynamic label", () => {
    const crumbs = deriveBreadcrumbs("/app/admin/ap/vendors/cms4461to0002gypwkbhl8n67");
    expect(crumbs.map((c) => c.label)).toEqual(["App", "AP", "Vendors", "Detail"]);
    expect(crumbs.every((c) => !/cms4461|cms/.test(c.label))).toBe(true);
  });
  it("cuid + trailing segment renders 'Detail > Timeline'", () => {
    const crumbs = deriveBreadcrumbs("/app/admin/ap/vendors/cms4461to0002gypwkbhl8n67/timeline");
    expect(crumbs.map((c) => c.label)).toEqual(["App", "AP", "Vendors", "Detail", "Timeline"]);
  });
  it("UUIDs never leak either (defence for non-cuid stores)", () => {
    const uuid = "9bfaeadd-1234-4a4b-8c8d-6f8f8b8a8b8c";
    const crumbs = deriveBreadcrumbs(`/app/admin/members/${uuid}`);
    expect(crumbs.map((c) => c.label)).toEqual(["App", "Members", "Detail"]);
  });
});

describe("deriveBreadcrumbs — dynamicLabels resolve entity IDs", () => {
  it("vendor cuid → 'Microsoft Corporation' with dynamicLabels", () => {
    const crumbs = deriveBreadcrumbs(
      "/app/admin/ap/vendors/cms4461to0002gypwkbhl8n67/timeline",
      { dynamicLabels: { cms4461to0002gypwkbhl8n67: "Microsoft Corporation" } },
    );
    expect(crumbs.map((c) => c.label)).toEqual([
      "App", "AP", "Vendors", "Microsoft Corporation", "Timeline",
    ]);
  });
  it("second vendor works too (proves the mechanism is dynamic)", () => {
    const crumbs = deriveBreadcrumbs(
      "/app/admin/ap/vendors/cms111zzz9999xxxyyy222aaa/timeline",
      { dynamicLabels: { cms111zzz9999xxxyyy222aaa: "Club Support Inc" } },
    );
    expect(crumbs.map((c) => c.label)).toEqual([
      "App", "AP", "Vendors", "Club Support Inc", "Timeline",
    ]);
  });
  it("mechanism generalises to invoice ids on invoice detail", () => {
    const crumbs = deriveBreadcrumbs(
      "/app/admin/ap/invoices/cmsInv00001aabbccddeeff",
      { dynamicLabels: { cmsInv00001aabbccddeeff: "AP-2026-000001" } },
    );
    expect(crumbs.map((c) => c.label)).toEqual([
      "App", "AP", "Invoices", "AP-2026-000001",
    ]);
  });
  it("missing dynamicLabel falls back to 'Detail' — never to the raw id", () => {
    const crumbs = deriveBreadcrumbs(
      "/app/admin/ap/invoices/cmsInv00001aabbccddeeff",
      { dynamicLabels: {} },
    );
    expect(crumbs.map((c) => c.label)).toEqual([
      "App", "AP", "Invoices", "Detail",
    ]);
    expect(crumbs.every((c) => !/cms/i.test(c.label))).toBe(true);
  });
});

describe("deriveBreadcrumbs — non-leaf hrefs preserve original URL", () => {
  it("Microsoft timeline: parent 'Vendors' href is /app/admin/ap/vendors", () => {
    const crumbs = deriveBreadcrumbs(
      "/app/admin/ap/vendors/cms4461to0002gypwkbhl8n67/timeline",
      { dynamicLabels: { cms4461to0002gypwkbhl8n67: "Microsoft Corporation" } },
    );
    const vendorsCrumb = crumbs.find((c) => c.label === "Vendors");
    expect(vendorsCrumb?.href).toBe("/app/admin/ap/vendors");
    // The dynamic vendor crumb points at the vendor detail route.
    const msftCrumb = crumbs.find((c) => c.label === "Microsoft Corporation");
    expect(msftCrumb?.href).toBe("/app/admin/ap/vendors/cms4461to0002gypwkbhl8n67");
    // Leaf has no href.
    const timelineCrumb = crumbs[crumbs.length - 1];
    expect(timelineCrumb.label).toBe("Timeline");
    expect(timelineCrumb.href).toBeUndefined();
  });
});

describe("configuration surface", () => {
  it("SEGMENT_SUPPRESS contains 'admin'", () => {
    expect(SEGMENT_SUPPRESS.has("admin")).toBe(true);
  });
  it("SEGMENT_LABEL_OVERRIDES pins the acronyms", () => {
    expect(SEGMENT_LABEL_OVERRIDES.ap).toBe("AP");
    expect(SEGMENT_LABEL_OVERRIDES.coa).toBe("COA");
  });
  it("PATH_LEAF_LABEL_OVERRIDES still contains Mission Control", () => {
    expect(PATH_LEAF_LABEL_OVERRIDES["/app/admin"]).toBe("Mission Control");
  });
});
