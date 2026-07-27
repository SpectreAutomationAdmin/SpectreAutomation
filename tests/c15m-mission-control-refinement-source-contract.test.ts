// Sprint 3 · Checkpoint 15M (2026-07-27) — Mission Control refinement
// source-contract locks.
//
// The founder-approved refinement resolves the 15L critical limitation
// (Create Vendor & Post modal had no operational confirm handler)
// AND ships the smaller-but-visible fixes:
//   • Real vendor + AP atomic transaction wired end-to-end.
//   • Vendor timeline (matched + provisional) reached via the card
//     title's vendor-name link.
//   • Sidebar: "Dashboard" renamed to "Mission Control", duplicate
//     top-level Search removed, "Connected accounts" removed from
//     the personal-item list (replaced by a header pill).
//   • Header: "Feed synced" health pill (real MailboxConnection
//     signals — SYNCED / DELAYED / RECONNECT / NONE — never green
//     just because a row exists), plus the "Last refreshed X ago"
//     count-up label removed.
//   • Icons on the dark-green primary action button, mapped per
//     workflow state (checkmark / envelope / vendor-plus / …).
//   • Currency: $31.29 CAD default via a shared Intl-driven
//     formatter, controlled by a per-club `currency_show_code`
//     preference (default true, false → $31.29).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(p: string) { return readFileSync(join(process.cwd(), p), "utf8"); }

const NAV_DATA     = read("src/components/sidebar-nav-data.ts");
const CARD         = read("src/components/mission-control/EmailIntakeCard.tsx");
const MC_PAGE      = read("src/app/app/admin/page.tsx");
const CVAP_ACTION  = read("src/app/app/admin/ap/_create-vendor-and-post-actions.ts");
const TIMELINE_LIB = read("src/lib/vendor-timeline.ts");
const TIMELINE_PG  = read("src/app/app/admin/ap/vendors/[id]/timeline/page.tsx");
const PROV_PG      = read("src/app/app/admin/ap/vendors/provisional/page.tsx");
const FEED_PILL    = read("src/components/mission-control/FeedSyncedStatusPill.tsx");
const FEED_LOADER  = read("src/lib/mission-control/feed-synced-status.ts");
const LIVE_REFRESH = read("src/components/mission-control/MissionControlLiveRefresh.tsx");
const IRI          = read("src/lib/mission-control/intelligence-review-intakes.ts");

describe("15M — real Create Vendor & Post transaction", () => {
  it("server action exists and is 'use server'", () => {
    expect(CVAP_ACTION).toMatch(/"use server"/);
    expect(CVAP_ACTION).toMatch(/export async function createVendorAndPostAction/);
  });
  it("enforces vendor:create + ap:invoice:create permissions before doing any work", () => {
    expect(CVAP_ACTION).toMatch(/hasPermission\(principal, clubId, "vendor:create"\)/);
    expect(CVAP_ACTION).toMatch(/hasPermission\(principal, clubId, "ap:invoice:create"\)/);
  });
  it("re-fetches the Work Intake item server-side (client cannot be trusted)", () => {
    expect(CVAP_ACTION).toMatch(/prisma\.workIntakeItem\.findFirst/);
    expect(CVAP_ACTION).toMatch(/where: \{ id: input\.workIntakeItemId, clubId \}/);
  });
  it("validates that the target GL is active + EXPENSE-or-ASSET-typed on this club", () => {
    expect(CVAP_ACTION).toMatch(/isActive: true/);
    expect(CVAP_ACTION).toMatch(/account\.type !== "EXPENSE" && account\.type !== "ASSET"/);
  });
  it("wraps vendor + AP + WorkIntake resolution in one $transaction with 15I-5 timeout", () => {
    expect(CVAP_ACTION).toMatch(/prisma\.\$transaction\(async \(tx\) =>/);
    expect(CVAP_ACTION).toMatch(/timeout: 60_000/);
    expect(CVAP_ACTION).toMatch(/maxWait: 15_000/);
  });
  it("detects duplicate invoice (same vendor + same vendorReference) BEFORE writing anything else", () => {
    const dup = CVAP_ACTION.indexOf("dupInv");
    const create = CVAP_ACTION.indexOf("tx.aPInvoice.create");
    expect(dup).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(dup);
  });
  it("resolves the Work Intake item to RESOLVED with resolvedAt + resolvedByUserId stamped", () => {
    expect(CVAP_ACTION).toMatch(/tx\.workIntakeItem\.update\(\{\s+where: \{ id: wi\.id \},[\s\S]{0,300}status: "RESOLVED"[\s\S]{0,200}resolvedAt: new Date\(\)/);
  });
  it("audits vendor creation, AP invoice creation, and work-intake resolution separately", () => {
    expect(CVAP_ACTION).toMatch(/action: "vendor\.create"/);
    expect(CVAP_ACTION).toMatch(/action: "ap\.invoice\.create"/);
    expect(CVAP_ACTION).toMatch(/action: "work-intake\.resolve"/);
  });
  it("returns a link to the vendor timeline and the created AP invoice on success", () => {
    expect(CVAP_ACTION).toMatch(/timelineUrl: `\/app\/admin\/ap\/vendors\/\$\{encodeURIComponent\(result\.vendorId\)\}`/);
    expect(CVAP_ACTION).toMatch(/apInvoiceUrl:\s+`\/app\/admin\/ap\/invoices\/\$\{encodeURIComponent\(result\.invoiceId\)\}`/);
  });
  it("card's onConfirm handler wires directly to the server action", () => {
    expect(CARD).toMatch(/import\(.*_create-vendor-and-post-actions.*\)/);
    expect(CARD).toMatch(/createVendorAndPostAction\(payload\)/);
    // Success path refreshes the router so the resolved item drops
    // from the feed AND the vendor timeline picks up the new event.
    expect(CARD).toMatch(/router\.refresh\(\)/);
  });
});

describe("15M — vendor timeline architecture", () => {
  it("loader lives in a reusable module (not vendor-specific to one page)", () => {
    expect(TIMELINE_LIB).toMatch(/export async function loadVendorTimeline/);
    expect(TIMELINE_LIB).toMatch(/export async function loadProvisionalVendorTimeline/);
  });
  it("returns a NEWEST-FIRST event stream", () => {
    expect(TIMELINE_LIB).toMatch(/events\.sort\(\(a, b\) => b\.ts\.localeCompare\(a\.ts\)\)/);
  });
  it("aggregates events from EmailMessage + IngestedDocument + APInvoice + Vendor + WorkIntake — no dedicated event table", () => {
    expect(TIMELINE_LIB).toMatch(/prisma\.emailMessage\.findMany/);
    expect(TIMELINE_LIB).toMatch(/prisma\.ingestedDocument\.findMany/);
    expect(TIMELINE_LIB).toMatch(/prisma\.aPInvoice\.findMany/);
    // Explicit note about not duplicating source data.
    expect(TIMELINE_LIB).toMatch(/No new event table introduced/);
  });
  it("every DOMAIN query is tenant-scoped by clubId (no cross-tenant leakage)", () => {
    // Grep every findMany / findFirst / count on the DOMAIN tables
    // (vendor, aPInvoice, emailMessage, ingestedDocument,
    // workIntakeItem, workIntakeOrigin, emailAttachment). The
    // secondary User.findFirst lookup for the actor name is
    // deliberately not tenant-scoped — User is a global table
    // (memberships route via UserClubRole) and the vendor.createdByUserId
    // link is already tenant-safe because the vendor row itself was
    // filtered by clubId. Assert the domain queries only.
    const domain = /prisma\.(vendor|aPInvoice|emailMessage|ingestedDocument|workIntakeItem|workIntakeOrigin|emailAttachment)\.find(?:First|Many|Unique)\(\{[\s\S]*?\}\)/g;
    const matches = TIMELINE_LIB.match(domain) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const q of matches) {
      expect(q, `domain query without clubId: ${q.slice(0, 120)}...`).toMatch(/clubId/);
    }
  });
  it("timeline route is /app/admin/ap/vendors/[id]/timeline (reusable pattern)", () => {
    expect(TIMELINE_PG).toMatch(/loadVendorTimeline/);
    expect(TIMELINE_PG).toMatch(/if \(!timeline\) notFound\(\)/);
    // Cross-tenant vendor id returns 404 — loader returns null for
    // wrong-tenant, page then calls notFound().
  });
  it("provisional route survives vendor-creation (keyed to extracted name + workIntakeItemId)", () => {
    expect(PROV_PG).toMatch(/searchParams:.*name/);
    expect(PROV_PG).toMatch(/workIntakeItemId/);
    expect(PROV_PG).toMatch(/loadProvisionalVendorTimeline/);
    expect(TIMELINE_LIB).toMatch(/loadProvisionalVendorTimeline/);
  });
  it("card title's vendor name is an anchor — matched vendors route to the timeline, unmatched to the provisional view", () => {
    expect(CARD).toMatch(/function ApTitle/);
    // Matched → vendor timeline route.
    expect(CARD).toMatch(/ap\.vendorMatch\.matchedVendorId\s*\?\s*[`\s\S]*\/timeline/);
    // Unmatched → provisional route with extracted name + workIntakeItemId.
    expect(CARD).toMatch(/\/app\/admin\/ap\/vendors\/provisional\?name=/);
    // Nested link never toggles the card's accordion.
    expect(CARD).toMatch(/data-testid="ap-title-vendor-link"[\s\S]{0,120}onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  });
});

describe("15M — sidebar navigation refinement", () => {
  it('Dashboard is renamed to "Mission Control"', () => {
    expect(NAV_DATA).toMatch(/label: "Mission Control"/);
    expect(NAV_DATA).not.toMatch(/label: "Dashboard"/);
  });
  it("URL /app/admin is preserved so bookmarks / breadcrumbs / internal links keep working", () => {
    expect(NAV_DATA).toMatch(/href: "\/app\/admin", label: "Mission Control"/);
  });
  it("duplicate top-level Search entry is removed (a single search lives in SpectreSidebar)", () => {
    // ADMIN_TOP_LEVEL used to include a Search entry; it must not
    // any more.
    const topLevelBlock = NAV_DATA.slice(NAV_DATA.indexOf("ADMIN_TOP_LEVEL"), NAV_DATA.indexOf("ADMIN_SECTIONS"));
    expect(topLevelBlock).not.toMatch(/label: "Search"/);
  });
  it("Connected accounts is removed from the personal-item list (surfaced as header pill instead)", () => {
    const personalBlock = NAV_DATA.slice(NAV_DATA.indexOf("ADMIN_PERSONAL"), NAV_DATA.length);
    expect(personalBlock).not.toMatch(/label: "Connected accounts"/);
  });
});

describe("15M — Feed synced header pill", () => {
  it("pill is server-rendered with a state prop; anchor to the reconnect route", () => {
    expect(FEED_PILL).toMatch(/data-testid="feed-synced-pill"/);
    expect(FEED_PILL).toMatch(/data-state=\{status\.state\}/);
    expect(FEED_PILL).toMatch(/href=\{status\.href\}/);
  });
  it('loader returns SYNCED only when status === "CONNECTED" AND access token is still valid AND last sync is fresh', () => {
    expect(FEED_LOADER).toMatch(/const tokenExpired = conn\.accessTokenExpiresAt\.getTime\(\) < now/);
    expect(FEED_LOADER).toMatch(/if \(disconnected \|\| tokenExpired\)/);
    expect(FEED_LOADER).toMatch(/state: "RECONNECT"/);
    expect(FEED_LOADER).toMatch(/state: "DELAYED"/);
    expect(FEED_LOADER).toMatch(/state: "SYNCED"/);
  });
  it("Mission Control page loads + renders the pill in the header meta strip", () => {
    expect(MC_PAGE).toMatch(/loadFeedSyncedStatus/);
    expect(MC_PAGE).toMatch(/<FeedSyncedStatusPill status=\{feedSyncedStatus\}/);
  });
  it('"Last refreshed X ago" count-up ticker is REMOVED from MissionControlLiveRefresh', () => {
    // The literal label text is gone from the render.
    expect(LIVE_REFRESH).not.toMatch(/`Last refreshed \$\{ageLabel\}`/);
    // "Refresh now" button remains.
    expect(LIVE_REFRESH).toMatch(/data-testid="mc-refresh-now"/);
  });
});

describe("15M — icons on dark-green primary actions", () => {
  it("primaryActionForApWorkflow returns { label, icon } for every state", () => {
    expect(CARD).toMatch(/type PrimaryIconKind =/);
    expect(CARD).toMatch(/label: "Approve & post",\s+icon: "check"/);
    expect(CARD).toMatch(/label: "Create vendor & post",\s+icon: "vendor-plus"/);
    expect(CARD).toMatch(/label: "Request information",\s+icon: "envelope"/);
  });
  it("PrimaryActionIcon component is rendered inside the primary button", () => {
    expect(CARD).toMatch(/<PrimaryActionIcon kind=\{primary\.icon\} \/>/);
    expect(CARD).toMatch(/function PrimaryActionIcon\(\{ kind \}: \{ kind: PrimaryIconKind \}\)/);
  });
  it("icons are aria-hidden (label carries the semantic action)", () => {
    expect(CARD).toMatch(/"aria-hidden": true/);
  });
});

describe("15M — currency $31.29 CAD + Club preference", () => {
  it("shared operational money formatter uses Intl.NumberFormat with narrowSymbol", () => {
    expect(CARD).toMatch(/function formatOperationalMoney/);
    expect(CARD).toMatch(/Intl\.NumberFormat\("en-US", \{\s+style: "currency",[\s\S]{0,120}currencyDisplay: "narrowSymbol"/);
  });
  it("appends trailing ISO code only when showCurrencyCode is true", () => {
    expect(CARD).toMatch(/showCurrencyCode \? `\$\{localized\} \$\{currency\}` : localized/);
  });
  it("projection payload carries the per-club currencyShowCode preference", () => {
    expect(IRI).toMatch(/currencyShowCode\?: boolean/);
    expect(IRI).toMatch(/async function loadCurrencyShowCode/);
    // Default is TRUE (so pre-15M behaviour is preserved).
    expect(IRI).toMatch(/return v == null \? true : v/);
  });
  it("readout + summary + title all consume currencyShowCode via the shared formatter", () => {
    // Three surfaces call formatOperationalMoney.
    const uses = CARD.match(/formatOperationalMoney\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });
});
