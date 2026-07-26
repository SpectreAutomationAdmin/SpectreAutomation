// Sprint 3 Checkpoint 15I (2026-07-26) — Variant D Work Intake card
// source-contract locks. These tests hold the shape of the two
// production card components so that future edits cannot silently:
//   • drop the Variant D `.spectre-mc-item` shell in favour of the
//     old `spectre-mc-worktype`-eyebrow / `spectre-mc-evidence` DOM,
//   • re-introduce the collapsed-row "Open review / View PDF /
//     View email / Review & send reply" button row,
//   • lose click-to-expand + mark-read behaviour,
//   • fire the outer card open/collapse when the user clicks a tab
//     or a nested action,
//   • conflate sender identity with the extracted vendor identity,
//   • lose the per-user read-state projection or the mark-read
//     action wiring,
//   • drop the `?view=history` completed-history filter,
//   • regress the Sprint 3 Checkpoint 15H CSP that lets the PDF
//     preview modal render (see middleware-csp-pdf-preview.test.ts
//     — still active).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EMAIL_CARD = read("src/components/mission-control/EmailIntakeCard.tsx");
const REVIEW_CARD = read("src/components/mission-control/IntelligenceReviewCard.tsx");
const PAGE = read("src/app/app/admin/page.tsx");
const LOADER = read("src/lib/mission-control/index.ts");
const AP_LOADER = read("src/lib/mission-control/intelligence-review-intakes.ts");
const EMAIL_LOADER = read("src/lib/mission-control/email-intake.ts");
const ACTIONS = read("src/lib/work-intake/actions.ts");
const ACTION_ROUTE = read("src/app/api/work-intake/action/route.ts");
const CSS = read("src/app/globals.css");
const SCHEMA_SQLITE = read("prisma/schema.prisma");
const SCHEMA_PG = read("prisma-postgres/schema.prisma");
const MIGRATION = read("prisma-postgres/migrations/20260726_c15i_work_intake_item_read/migration.sql");
const CARDS: Array<[string, string]> = [["EmailIntakeCard", EMAIL_CARD], ["IntelligenceReviewCard", REVIEW_CARD]];

function read(p: string) {
  return readFileSync(join(process.cwd(), p), "utf8");
}

describe("Variant D card shell — both cards use the same class system", () => {
  it.each(CARDS)("%s renders the Variant D .spectre-mc-item outer with pill + h3 + readout + rec", (name, src) => {
    expect(src).toMatch(/className=\{`spectre-mc-item /);
    expect(src).toMatch(/spectre-mc-item-head/);
    expect(src).toMatch(/spectre-mc-pill/);
    expect(src).toMatch(/spectre-mc-readout/);   // Variant D 4-cell metric strip
    expect(src).toMatch(/spectre-mc-rec/);       // Variant D recommendation strip
  });
  it.each(CARDS)("%s uses .spectre-mc-work paragraph (not .spectre-mc-synopsis) — Variant D vocab", (name, src) => {
    // The rejected pre-15I DOM used `.spectre-mc-synopsis`. Variant D
    // is `.spectre-mc-work`.
    expect(src).toMatch(/spectre-mc-work/);
    expect(src).not.toMatch(/className="spectre-mc-synopsis"/);
  });
  it.each(CARDS)("%s does NOT ship the old .spectre-mc-worktype eyebrow (superseded by the pill)", (name, src) => {
    expect(src).not.toMatch(/spectre-mc-worktype/);
  });
  it.each(CARDS)("%s does NOT ship the old .spectre-mc-evidence grid (superseded by .spectre-mc-readout)", (name, src) => {
    expect(src).not.toMatch(/className="spectre-mc-evidence"/);
  });
});

describe("Click-to-expand + mark-read (Checkpoint 15I §3.2/§3.3)", () => {
  it.each(CARDS)("%s primary surface is role='button' with aria-expanded", (name, src) => {
    expect(src).toMatch(/role="button"/);
    expect(src).toMatch(/aria-expanded=\{expanded\}/);
    expect(src).toMatch(/spectre-mc-item-surface/);
  });
  it.each(CARDS)("%s primary surface handles keyboard (Enter + Space)", (name, src) => {
    expect(src).toMatch(/e\.key === "Enter" \|\| e\.key === " "/);
  });
  it.each(CARDS)("%s expanded region stops propagation so tabs/actions don't collapse the card", (name, src) => {
    expect(src).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  });
  it.each(CARDS)("%s calls the mark_read action on first expand", (name, src) => {
    expect(src).toMatch(/action:\s*"mark_read"/);
  });
});

describe("Collapsed-row buttons removed (Checkpoint 15I §3.4)", () => {
  it.each(CARDS)("%s does NOT render 'Open review' on the collapsed row", (name, src) => {
    expect(src).not.toMatch(/>\s*Open review\s*</);
  });
  it("EmailIntakeCard does NOT render 'View PDF' as a collapsed-row button (it lives inside the Attachments tab)", () => {
    // The Attachments-tab body legitimately renders View PDF buttons
    // for each attachment row — those live inside `unified-attachment-preview-*`
    // testids. There must NOT be a `unified-view-pdf` collapsed-row button.
    expect(EMAIL_CARD).not.toMatch(/data-testid="unified-view-pdf"/);
  });
  it("EmailIntakeCard does NOT render a collapsed-row 'Review & send reply' button", () => {
    // Reply now lives inside the Conversation tab as tab-conversation-reply.
    expect(EMAIL_CARD).not.toMatch(/data-testid="email-action-open-composer"/);
  });
});

describe("Card-level Resolve action (Checkpoint 15I §4.2)", () => {
  it.each(CARDS)("%s exposes a Resolve button with data-testid='card-resolve'", (name, src) => {
    expect(src).toMatch(/data-testid="card-resolve"/);
    expect(src).toMatch(/action:\s*"resolve"/);
  });
  it.each(CARDS)("%s calls router.refresh() after resolve so the item drops from the active feed", (name, src) => {
    expect(src).toMatch(/router\.refresh\(\)/);
  });
});

describe("Contextual tabs (Checkpoint 15I §3.3 · preserves 15H)", () => {
  it("EmailIntakeCard's tabsFor() gates invoice/statement/attachments tabs on the linked intelligence counts", () => {
    expect(EMAIL_CARD).toMatch(/function tabsFor\(/);
    expect(EMAIL_CARD).toMatch(/linked\?\.invoiceAttachmentCount/);
    expect(EMAIL_CARD).toMatch(/linked\?\.statementAttachmentCount/);
    expect(EMAIL_CARD).toMatch(/linked\?\.attachmentCount/);
  });
  it("EmailIntakeCard TabBar buttons stopPropagation so tab-clicks never collapse the card", () => {
    const bar = EMAIL_CARD.slice(EMAIL_CARD.indexOf("function TabBar"));
    expect(bar).toMatch(/e\.stopPropagation\(\)/);
  });
});

describe("Sender ≠ vendor (Checkpoint 15I §3.5 · preserves 15H)", () => {
  it("EmailIntakeCard sender-line shows contextLine (email `from`), not vendorGuess", () => {
    // The sender line is fed by `data.contextLine`. The extracted
    // vendor lives in the Invoice tab as `payload.extraction.vendor.guessedName`.
    expect(EMAIL_CARD).toMatch(/className="spectre-mc-sender"[\s\S]{0,120}data\.contextLine/);
    expect(EMAIL_CARD).toMatch(/vendor\.guessedName/);
  });
  it("Invoice pane explicitly labels the sender as 'email sender — provenance only'", () => {
    expect(EMAIL_CARD).toMatch(/email sender — provenance only/);
  });
});

describe("Per-user read state (Checkpoint 15I §3.2 · Phase 4)", () => {
  it("schema: WorkIntakeItemRead exists in BOTH SQLite (dev) and Postgres (canonical)", () => {
    expect(SCHEMA_SQLITE).toMatch(/model WorkIntakeItemRead \{/);
    expect(SCHEMA_PG).toMatch(/model WorkIntakeItemRead \{/);
  });
  it("schema: composite PK (workIntakeItemId, userId) so repeated writes are idempotent", () => {
    expect(SCHEMA_SQLITE).toMatch(/@@id\(\[workIntakeItemId, userId\]\)/);
    expect(SCHEMA_PG).toMatch(/@@id\(\[workIntakeItemId, userId\]\)/);
  });
  it("migration: creates the table + FKs + read index", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE "WorkIntakeItemRead"/);
    expect(MIGRATION).toMatch(/"WorkIntakeItemRead_workIntakeItemId_fkey"/);
    expect(MIGRATION).toMatch(/"WorkIntakeItemRead_userId_fkey"/);
    expect(MIGRATION).toMatch(/CREATE INDEX "WorkIntakeItemRead_userId_readAt_idx"/);
  });
  it("markWorkIntakeRead server action exists and is idempotent (upsert with empty update)", () => {
    expect(ACTIONS).toMatch(/export async function markWorkIntakeRead/);
    expect(ACTIONS).toMatch(/prisma\.workIntakeItemRead\.upsert/);
    expect(ACTIONS).toMatch(/update:\s*\{\},\s*\/\/ idempotent/);
  });
  it("action route accepts 'mark_read'", () => {
    expect(ACTION_ROUTE).toMatch(/case "mark_read"/);
    expect(ACTION_ROUTE).toMatch(/markWorkIntakeRead\(ctx\)/);
  });
  it("loader projects viewerHasRead + isUnread from WorkIntakeItemRead per user (NOT from EmailMessage.isRead)", () => {
    expect(LOADER).toMatch(/projectViewerReadState/);
    expect(LOADER).toMatch(/prisma\.workIntakeItemRead\.findMany/);
    expect(LOADER).toMatch(/item\.viewerHasRead = readSet\.has/);
    expect(LOADER).toMatch(/item\.isUnread = !item\.viewerHasRead/);
  });
  it("loader does NOT flip read state merely by rendering (§3.2 last-line)", () => {
    // The projection reads existing rows and does not INSERT. Confirm
    // via absence of a create/upsert on the read table in the loader.
    const block = LOADER.slice(LOADER.indexOf("projectViewerReadState"), LOADER.indexOf("projectViewerReadState") + 1200);
    expect(block).not.toMatch(/prisma\.workIntakeItemRead\.(create|upsert)/);
  });
});

describe("History filter (Checkpoint 15I §4.3)", () => {
  it("page.tsx reads ?view=history and passes feedFilter into the loader", () => {
    expect(PAGE).toMatch(/searchParams\?\.view === "history"/);
    expect(PAGE).toMatch(/loadMissionControlSnapshot\(principal, clubId, \{ feedFilter: view \}\)/);
  });
  it("page.tsx exposes Active / Completed toggle chips linked to ?view=active and ?view=history", () => {
    expect(PAGE).toMatch(/data-testid="feed-view-active"/);
    expect(PAGE).toMatch(/data-testid="feed-view-history"/);
    expect(PAGE).toMatch(/href="\/app\/admin\?view=history"/);
  });
  it("loader filters visible items by lifecycle state per view mode", () => {
    expect(LOADER).toMatch(/feedFilter === "history"[\s\S]*?workIntakeStatus === "RESOLVED"/);
    expect(LOADER).toMatch(/\.filter\(\(w\) => w\.workIntakeStatus !== "RESOLVED"\)/);
  });
});

describe("workIntakeStatus + WorkItem type", () => {
  it("WorkItem exposes viewerHasRead + workIntakeStatus", () => {
    expect(LOADER).toMatch(/viewerHasRead\?:\s*boolean/);
    expect(LOADER).toMatch(/workIntakeStatus\?:\s*string/);
  });
  it("AP + Statement loaders project workIntakeStatus = i.status", () => {
    // Both call-sites push workIntakeStatus.
    expect(AP_LOADER).toMatch(/workIntakeStatus:\s*i\.status/);
    // Grep the file for both occurrences (AP + Statement loaders).
    const matches = AP_LOADER.match(/workIntakeStatus:\s*i\.status/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
  it("Email loader projects workIntakeStatus = it.status", () => {
    expect(EMAIL_LOADER).toMatch(/workIntakeStatus:\s*it\.status/);
  });
});

describe("CSS — Variant D shell + expanded region + a11y", () => {
  it("adds .spectre-mc-item-surface with focus-visible outline", () => {
    expect(CSS).toMatch(/\.spectre-mc-item-surface/);
    expect(CSS).toMatch(/\.spectre-mc-item-surface:focus-visible \{[\s\S]*?outline:/);
  });
  it("adds .spectre-mc-item-expanded region separator", () => {
    expect(CSS).toMatch(/\.spectre-mc-item-expanded/);
  });
  it("existing Variant D .spectre-mc-readout / .spectre-mc-rec still defined (contract for the shell)", () => {
    expect(CSS).toMatch(/\.spectre-mc-readout/);
    expect(CSS).toMatch(/\.spectre-mc-rec/);
    expect(CSS).toMatch(/\.spectre-mc-pill/);
  });
});

describe("Non-regression of Checkpoint 15H architecture (must never quietly break)", () => {
  it("EmailIntakeCard still uses DocumentPreviewModal (blob-URL bypass for X-Frame-Options)", () => {
    expect(EMAIL_CARD).toMatch(/import DocumentPreviewModal/);
    expect(EMAIL_CARD).toMatch(/<DocumentPreviewModal/);
  });
  it("loader still calls loadChildReviewIntakesToSuppress (parent-only visible card)", () => {
    expect(LOADER).toMatch(/loadChildReviewIntakesToSuppress\(/);
  });
  it("loader still calls loadLinkedIntelligenceForEmailIntakes (facet aggregation)", () => {
    expect(LOADER).toMatch(/loadLinkedIntelligenceForEmailIntakes\(/);
  });
  it("AP loader still filters suppressedIds via id notIn", () => {
    expect(AP_LOADER).toMatch(/suppressedIds\?:\s*Set<string>/);
    expect(AP_LOADER).toMatch(/notIn:\s*\[\.\.\.args\.suppressedIds\]/);
  });
});
