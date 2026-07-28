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
// Sprint 3 · Checkpoint 15O — the provisional page was removed;
// this constant is intentionally left empty so the file still
// parses. Tests that referenced PROV_PG have been rewritten below
// to lock the 15O contract (provisional route gone; unmatched vendor
// name opens the modal instead of a URL).
const PROV_PG      = "";
const FEED_PILL    = read("src/components/mission-control/FeedSyncedStatusPill.tsx");
const FEED_LOADER  = read("src/lib/mission-control/feed-synced-status.ts");
const LIVE_REFRESH = read("src/components/mission-control/MissionControlLiveRefresh.tsx");
const IRI          = read("src/lib/mission-control/intelligence-review-intakes.ts");

describe("15M — real Create Vendor & Post transaction (SUPERSEDED by 15O two-step split)", () => {
  // Sprint 3 · Checkpoint 15O rejected the combined single-transaction
  // path. The same safety invariants (permission gates, WI re-fetch,
  // GL validation, tx timeout, dup detection, WI resolve, audits,
  // timeline link) are now locked against the SPLIT files in
  // tests/c15o-two-step-vendor-and-ap-workflow-source-contract.test.ts:
  //     • src/app/app/admin/ap/_create-vendor-actions.ts     (Step 1)
  //     • src/app/app/admin/ap/_post-ap-invoice-actions.ts   (Step 2)
  //
  // The pre-15O combined action is a compile-time stub — kept only so
  // a stale import errors loudly. Assert that stub shape here so a
  // future regression that reintroduces the combined path is caught
  // by BOTH suites.
  it("the pre-15O combined action is retired (throws on call, references the 15O replacements in-comment)", () => {
    expect(CVAP_ACTION).toMatch(/createVendorAndPostAction was retired in Checkpoint 15O/);
    expect(CVAP_ACTION).toMatch(/throw new Error/);
  });
  it("card no longer imports the retired combined action", () => {
    // The card now delegates to the two step actions via the modal
    // itself — see tests/c15o-*.test.ts for the current wiring.
    expect(CARD).not.toMatch(/import\(.*_create-vendor-and-post-actions.*\)/);
  });
});

describe("15M — vendor timeline architecture", () => {
  it("loader lives in a reusable module (matched-vendor path; provisional path removed in 15O)", () => {
    expect(TIMELINE_LIB).toMatch(/export async function loadVendorTimeline/);
    // Sprint 3 · Checkpoint 15O rejected the provisional loader.
    // Kept as a superseded-marker guard so a future regression is
    // caught by both this suite and c15o.
    expect(TIMELINE_LIB).not.toMatch(/export async function loadProvisionalVendorTimeline/);
  });
  it("returns a NEWEST-FIRST event stream (15O renamed the local from events → clamped)", () => {
    // Sprint 3 · Checkpoint 15O added a lower-bound clamp before the
    // sort. The invariant (newest-first) is preserved; the local
    // is now called `clamped`.
    expect(TIMELINE_LIB).toMatch(/clamped\.sort\(\(a, b\) => b\.ts\.localeCompare\(a\.ts\)\)/);
  });
  it("aggregates events from EmailMessage + IngestedDocument + APInvoice + Vendor + WorkIntake — no dedicated event table", () => {
    expect(TIMELINE_LIB).toMatch(/prisma\.emailMessage\.findMany/);
    expect(TIMELINE_LIB).toMatch(/prisma\.ingestedDocument\.findMany/);
    expect(TIMELINE_LIB).toMatch(/prisma\.aPInvoice\.findMany/);
    // Explicit note about not duplicating source data (comment
    // preserved through 15O — wording slightly reworded).
    expect(TIMELINE_LIB).toMatch(/No new event table is introduced/);
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
  it("provisional route + loader are REMOVED in Checkpoint 15O (superseded by two-step modal)", () => {
    // 15O rejected the provisional model entirely. The route file
    // is gone and the loader is no longer exported.
    void PROV_PG;
    expect(TIMELINE_LIB).not.toMatch(/export async function loadProvisionalVendorTimeline/);
  });
  it("card title vendor-name behaviour (superseded by 15O): matched → /timeline link, unmatched → opens modal", () => {
    // See tests/c15o-*.test.ts for the current contract. Kept here
    // as a superseded-marker so a future regression to the pre-15O
    // provisional route is caught by BOTH suites.
    expect(CARD).toMatch(/function ApTitle/);
    // Matched vendor path — anchor element with href built from matchedVendorId.
    expect(CARD).toMatch(/matchedVendorId\)\s*\}\/timeline/);
    expect(CARD).toMatch(/data-testid="ap-title-vendor-link"/);
    // Unmatched vendor path — button element that opens the modal.
    expect(CARD).toMatch(/data-testid="ap-title-vendor-button"/);
    // Provisional route removed entirely.
    expect(CARD).not.toMatch(/\/app\/admin\/ap\/vendors\/provisional/);
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
  it("action derivation returns { label, icon } for every state (15P-5: via deriveApAction)", () => {
    // 15P-5 retired primaryActionForApWorkflow — the label + icon
    // now live on the shared `deriveApAction` in
    // src/lib/mission-control/ap-action.ts. The card's PrimaryIconKind
    // type is still there for the icon-component prop.
    const APACTION = readFileSync(join(process.cwd(), "src/lib/mission-control/ap-action.ts"), "utf8");
    expect(CARD).toMatch(/type PrimaryIconKind =/);
    expect(APACTION).toMatch(/label: "Approve & post"[\s\S]{0,80}icon: "check"/);
    expect(APACTION).toMatch(/label: "Create vendor & post"[\s\S]{0,80}icon: "vendor-plus"/);
    expect(APACTION).toMatch(/label: "Request information"[\s\S]{0,80}icon: "envelope"/);
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
