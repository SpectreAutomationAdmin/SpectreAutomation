// Sprint 3 · Checkpoint 15P-7 (2026-07-28) — source-contract locks
// for the atomic AP-posting rewrite.
//
// Founder rule (§Required posting invariant):
//   "A successful posting response must mean all required
//    accounting writes completed. It must never return success
//    merely because the journal-entry rows were created while the
//    AP invoice remains Draft."
//
// This suite guards the invariant at the source level: the post
// action must create BOTH the AP invoice (as POSTED) AND the
// journal entry (as POSTED) AND resolve the WI in ONE Prisma
// $transaction, and must preflight the fiscal period before any
// writes.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(p: string) { return readFileSync(join(process.cwd(), p), "utf8"); }

const POST_ACTION    = read("src/app/app/admin/ap/_post-ap-invoice-actions.ts");
const FISCAL_PRE     = read("src/lib/ap-intelligence/fiscal-period-preflight.ts");
const MAILBOX_ARCH   = read("src/lib/mailbox/archive.ts");
const QUEUE_INDEX    = read("src/lib/queue/index.ts");
const QUEUE_HANDLERS = read("src/lib/queue/handlers.ts");
const MODAL          = read("src/components/mission-control/CreateVendorAndPostModal.tsx");
const VENDORS_PAGE   = read("src/app/app/admin/ap/vendors/page.tsx");
const TIMELINE_PAGE  = read("src/app/app/admin/ap/vendors/[id]/timeline/page.tsx");

// ---------------------------------------------------------------------------
// Atomic transaction
// ---------------------------------------------------------------------------

describe("15P-7 · atomic AP posting — one $transaction covers every accounting write", () => {
  it("post action opens ONE prisma.$transaction and does all accounting writes inside it", () => {
    // The tx block must include: aPInvoice.create (status POSTED),
    // aPInvoiceLine.create, journalEntry.create (status POSTED),
    // journalEntryLine.createMany, aPInvoice.update (JE backfill),
    // workIntakeItem.update.
    const txStart = POST_ACTION.indexOf("await prisma.$transaction");
    expect(txStart).toBeGreaterThan(-1);
    const txEnd = POST_ACTION.indexOf("}, { timeout: 60_000", txStart);
    expect(txEnd).toBeGreaterThan(txStart);
    const txBody = POST_ACTION.slice(txStart, txEnd);
    for (const write of [
      "tx.aPInvoice.create",
      "tx.aPInvoiceLine.create",
      "tx.journalEntry.create",
      "tx.journalEntryLine.createMany",
      "tx.aPInvoice.update",
      "tx.workIntakeItem.update",
    ]) {
      expect(txBody).toContain(write);
    }
  });
  it("AP invoice is created with status POSTED (not DRAFT) + postedAt + postedByUserId", () => {
    // Founder rule: no more DRAFT → POSTED flip outside the tx.
    expect(POST_ACTION).toMatch(/status: "POSTED",\s*postedAt: nowTs,\s*postedByUserId: principal\.id/);
    // The pre-15P-7 "status: DRAFT" then flip pattern is gone.
    const draftCreates = POST_ACTION.match(/status: "DRAFT"/g) ?? [];
    // No DRAFT literal remains in the writer.
    expect(draftCreates.length).toBe(0);
  });
  it("journal entry is created inside the same tx with status POSTED + postedAt + postedByUserId", () => {
    const txStart = POST_ACTION.indexOf("await prisma.$transaction");
    const txEnd = POST_ACTION.indexOf("}, { timeout: 60_000", txStart);
    const txBody = POST_ACTION.slice(txStart, txEnd);
    expect(txBody).toMatch(/tx\.journalEntry\.create\([\s\S]{0,1200}status: "POSTED"/);
    expect(txBody).toMatch(/postedAt: nowTs/);
    expect(txBody).toMatch(/postedByUserId: principal\.id/);
  });
  it("invoice.postedJournalEntryId is backfilled inside the same tx", () => {
    const txStart = POST_ACTION.indexOf("await prisma.$transaction");
    const txEnd = POST_ACTION.indexOf("}, { timeout: 60_000", txStart);
    const txBody = POST_ACTION.slice(txStart, txEnd);
    expect(txBody).toMatch(/tx\.aPInvoice\.update\(\{[\s\S]{0,200}postedJournalEntryId: je\.id/);
  });
  it("post action does NOT call postInvoiceToGl outside the tx (the pre-15P-7 outer-catch race is gone)", () => {
    // The pre-15P-7 bug was `const je = await postInvoiceToGl(...)`
    // outside the transaction. Removed.
    expect(POST_ACTION).not.toMatch(/postInvoiceToGl\(/);
  });
});

// ---------------------------------------------------------------------------
// Fiscal-period preflight
// ---------------------------------------------------------------------------

describe("15P-7 · fiscal-period preflight — bootstraps if missing", () => {
  it("ensureFiscalPeriodForPosting exists, idempotent, uses ensureFiscalYear as bootstrap", () => {
    expect(FISCAL_PRE).toMatch(/export async function ensureFiscalPeriodForPosting/);
    expect(FISCAL_PRE).toMatch(/await ensureFiscalYear\(clubId, \{ startYear: year \}\)/);
  });
  it("throws ConflictError with an actionable message when both lookup + bootstrap fail", () => {
    expect(FISCAL_PRE).toMatch(/No fiscal period covers .+ Configure a fiscal year/);
    expect(FISCAL_PRE).toMatch(/throw new ConflictError/);
  });
  it("post action calls the preflight BEFORE opening the $transaction", () => {
    const preflightIdx = POST_ACTION.indexOf("ensureFiscalPeriodForPosting");
    const txIdx = POST_ACTION.indexOf("await prisma.$transaction");
    expect(preflightIdx).toBeGreaterThan(-1);
    expect(txIdx).toBeGreaterThan(preflightIdx);
  });
  it("preflight failure returns ok:false with code NO_FISCAL_PERIOD", () => {
    expect(POST_ACTION).toMatch(/code: "NO_FISCAL_PERIOD"/);
  });
});

// ---------------------------------------------------------------------------
// Outlook archive outbox
// ---------------------------------------------------------------------------

describe("15P-7 · Outlook archive via post-commit outbox", () => {
  it("MAILBOX_ARCHIVE_MESSAGE is a registered JobKind", () => {
    expect(QUEUE_INDEX).toMatch(/"MAILBOX_ARCHIVE_MESSAGE"/);
  });
  it("archive handler is registered + delegates to runMailboxArchiveMessage", () => {
    expect(QUEUE_HANDLERS).toMatch(/registerHandler<\{[\s\S]{0,300}\}>\("MAILBOX_ARCHIVE_MESSAGE"/);
    expect(QUEUE_HANDLERS).toMatch(/runMailboxArchiveMessage/);
  });
  it("archive module respects the delegated-scope allowlist — Mail.ReadWrite absence returns PENDING_SCOPE (does NOT throw)", () => {
    expect(MAILBOX_ARCH).toMatch(/APPROVED_DELEGATED_SCOPES/);
    expect(MAILBOX_ARCH).toMatch(/status: "PENDING_SCOPE"/);
  });
  it("post action enqueues MAILBOX_ARCHIVE_MESSAGE AFTER the tx commits (post-commit outbox)", () => {
    // Enqueue is outside the $transaction and comes after audit calls.
    const txEnd = POST_ACTION.indexOf("}, { timeout: 60_000");
    const enqueueIdx = POST_ACTION.indexOf('kind: "MAILBOX_ARCHIVE_MESSAGE"');
    expect(enqueueIdx).toBeGreaterThan(txEnd);
    // Uses an idempotency key derived from the invoice id.
    expect(POST_ACTION).toMatch(/idempotencyKey: `mailbox-archive:\$\{result\.invoiceId\}`/);
  });
  it("enqueue failure does NOT reverse the accounting posting", () => {
    // The enqueue is wrapped in try/catch that ONLY logs + records
    // ENQUEUE_FAILED status. The success path returns ok:true anyway.
    expect(POST_ACTION).toMatch(/status: "ENQUEUE_FAILED"/);
    expect(POST_ACTION).toMatch(/mission-control\.post-ap-invoice\.archive-enqueue-failed/);
  });
});

// ---------------------------------------------------------------------------
// Modal button UX
// ---------------------------------------------------------------------------

describe("15P-7 · modal posting button UX", () => {
  it("primary button label is 'Post & clear work item' (was 'Post invoice')", () => {
    expect(MODAL).toMatch(/"Post & clear work item"/);
    expect(MODAL).not.toMatch(/: "Post invoice"/);
  });
  it("loading state uses 'Posting and clearing…' with a spinner element", () => {
    expect(MODAL).toMatch(/spectre-cvap-spinner/);
    expect(MODAL).toMatch(/Posting and clearing…/);
  });
  it("button disables + sets aria-busy while submitting", () => {
    expect(MODAL).toMatch(/disabled=\{!canStep2Post \|\| submitting \|\| postResult != null\}/);
    expect(MODAL).toMatch(/aria-busy=\{submitting\}/);
  });
  it("success confirmation panel renders with the JE + WI + email-archive status", () => {
    expect(MODAL).toMatch(/data-testid="cvap-post-success"/);
    expect(MODAL).toMatch(/Invoice posted/);
    expect(MODAL).toMatch(/Journal entry balanced and Work Intake item cleared/);
    expect(MODAL).toMatch(/data-testid="cvap-post-success-archive"/);
  });
  it("failure keeps the modal open + restores the button (no partial success language)", () => {
    // The catch handler sets submitError; postResult stays null;
    // the render tree keeps rendering the Step-2 form.
    expect(MODAL).toMatch(/if \(!result\.ok\) \{ setSubmitError\(result\.message\); return; \}/);
  });
});

// ---------------------------------------------------------------------------
// Vendor list route
// ---------------------------------------------------------------------------

describe("15P-7 · vendor list opens the timeline; settings live behind the gear", () => {
  it("vendor row href now points to /timeline", () => {
    expect(VENDORS_PAGE).toMatch(/href=\{`\/app\/admin\/ap\/vendors\/\$\{v\.id\}\/timeline`\}/);
    // The pre-15P-7 direct-to-settings link is gone from the row.
    expect(VENDORS_PAGE).not.toMatch(/href=\{`\/app\/admin\/ap\/vendors\/\$\{v\.id\}`\}/);
  });
  it("timeline header has a gear icon that links to the existing settings page", () => {
    expect(TIMELINE_PAGE).toMatch(/data-testid="vendor-timeline-settings-gear"/);
    expect(TIMELINE_PAGE).toMatch(/href=\{`\/app\/admin\/ap\/vendors\/\$\{params\.id\}`\}/);
    expect(TIMELINE_PAGE).toMatch(/aria-label="Vendor settings"/);
  });
});
