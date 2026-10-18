// WI-SYNC-1e (2026-10-18) — source-contract locks for the final
// UI integration + user-facing restore endpoint + production
// safety gate on debug endpoints.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROW = readFileSync(
  join(process.cwd(), "src/components/mission-control/MailboxActionsRow.tsx"),
  "utf8",
);
const CARD = readFileSync(
  join(process.cwd(), "src/components/mission-control/EmailIntakeCard.tsx"),
  "utf8",
);
const RESTORE_ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/work-intake/[id]/restore-email/route.ts"),
  "utf8",
);
const DEBUG_ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/admin/mailbox/debug/move-to-inbox/route.ts"),
  "utf8",
);

describe("WI-SYNC-1e · MailboxActionsRow component", () => {
  it('is a "use client" component wired to Next router.refresh()', () => {
    expect(ROW).toMatch(/"use client"/);
    expect(ROW).toMatch(/useRouter/);
    expect(ROW).toMatch(/router\.refresh\(\)/);
  });
  it("renders two actions on active WIs: dismiss + delete", () => {
    // The exposed ActionKey union is exactly these two.
    expect(ROW).toMatch(/type ActionKey = "delete" \| "dismiss"/);
    expect(ROW).toMatch(/dismiss:\s*\{/);
    expect(ROW).toMatch(/delete:\s*\{/);
    // Visibility: only on active WI statuses.
    expect(ROW).toMatch(/isActive =/);
    expect(ROW).toMatch(/"OPEN"/);
    expect(ROW).toMatch(/"INFORMATIONAL"/);
    expect(ROW).toMatch(/visible\.push\("dismiss", "delete"\)/);
  });
  it("fires POST against the correct endpoints", () => {
    expect(ROW).toMatch(/\/api\/work-intake\/\$\{encodeURIComponent\(wiId\)\}\/dismiss/);
    expect(ROW).toMatch(/\/api\/work-intake\/\$\{encodeURIComponent\(wiId\)\}\/delete-email/);
    expect(ROW).toMatch(/method: "POST"/);
  });
  it("renders loading / success / failure feedback", () => {
    expect(ROW).toMatch(/pending/);
    expect(ROW).toMatch(/successFlash/);
    expect(ROW).toMatch(/data-flashed/);
    expect(ROW).toMatch(/role="alert"/);
    expect(ROW).toMatch(/mailbox-actions-error/);
  });
  it("reuses existing design-system btn tokens (no new branding)", () => {
    expect(ROW).toMatch(/"spectre-btn spectre-btn--secondary spectre-btn--sm"/);
    expect(ROW).toMatch(/"spectre-mc-inline-status spectre-mc-inline-status--error"/);
  });
  it("accessibility: role=group + aria-label on the row + aria-label per button + visible focus is from design-system", () => {
    expect(ROW).toMatch(/role="group"/);
    expect(ROW).toMatch(/aria-label="Mailbox actions"/);
    expect(ROW).toMatch(/aria-label=\{def\.label\}/);
  });
  it("stops propagation so clicks do not toggle the parent card", () => {
    expect(ROW).toMatch(/e\.stopPropagation\(\)/);
  });
  it("disables ALL buttons while one is pending so a user can't fire two actions concurrently", () => {
    expect(ROW).toMatch(/disabled=\{pending !== null\}/);
  });
  it("never writes to AP / journal / approval / payment surfaces", () => {
    for (const forbidden of [
      /prisma\.aPInvoice\./,
      /prisma\.journalEntry\./,
      /prisma\.approval\./,
      /prisma\.payment\./,
    ]) {
      expect(ROW).not.toMatch(forbidden);
    }
  });
});

describe("WI-SYNC-1e · EmailIntakeCard integration", () => {
  it("imports MailboxActionsRow", () => {
    expect(CARD).toMatch(/import MailboxActionsRow from "\.\/MailboxActionsRow"/);
  });
  it("mounts MailboxActionsRow inside the active actions row (not inside the completed/resolved branch)", () => {
    const rowMount = CARD.indexOf("<MailboxActionsRow");
    const resolveBtn = CARD.indexOf('data-testid="card-resolve"');
    expect(rowMount).toBeGreaterThan(0);
    expect(resolveBtn).toBeGreaterThan(0);
    // The row sits adjacent to the Resolve button (same else-branch).
    expect(Math.abs(rowMount - resolveBtn)).toBeLessThan(2_000);
  });
  it("passes workIntakeStatus as wiStatus so the row's visibility filter can run", () => {
    expect(CARD).toMatch(/wiStatus=\{data\.workIntakeStatus/);
  });
});

describe("WI-SYNC-1e · user-facing /restore-email route", () => {
  it("401 unauthenticated / 400 no active club / 403 cross-tenant / 404 feature off / 409 no eligible email / 422 mailbox disconnected / 502 Graph error", () => {
    expect(RESTORE_ROUTE).toMatch(/"unauthenticated"/);
    expect(RESTORE_ROUTE).toMatch(/"no_active_club"/);
    expect(RESTORE_ROUTE).toMatch(/"cross_tenant"/);
    expect(RESTORE_ROUTE).toMatch(/"mailbox_integration_disabled"/);
    expect(RESTORE_ROUTE).toMatch(/"no_primary_email_origin"/);
    expect(RESTORE_ROUTE).toMatch(/"email_not_soft_deleted"/);
    expect(RESTORE_ROUTE).toMatch(/"mailbox_not_connected"/);
    expect(RESTORE_ROUTE).toMatch(/"graph_error"/);
  });
  it("tenant-guards both the WI's clubId and the mailbox's clubId", () => {
    expect(RESTORE_ROUTE).toMatch(/link\.workIntakeItem\.clubId !== clubId/);
    expect(RESTORE_ROUTE).toMatch(/mailbox\.clubId !== clubId/);
  });
  it("uses the Graph provider moveMessage with destination=inbox + ImmutableId", () => {
    expect(RESTORE_ROUTE).toMatch(/getMicrosoftDelegatedProvider\(\)\.moveMessage\(/);
    expect(RESTORE_ROUTE).toMatch(/destinationId:\s*"inbox"/);
    expect(RESTORE_ROUTE).toMatch(/immutableId \|\| link\.emailMessage\.graphMessageId/);
  });
  it("writes an audit row — action=work-intake.restore-email", () => {
    expect(RESTORE_ROUTE).toMatch(/action:\s*"work-intake\.restore-email"/);
  });
  it("does NOT clear softDeletedAt or flip WI status in the API handler — delta sync owns the restore", () => {
    // The handler ONLY does the Graph move + audit; it does not
    // write to EmailMessage or WorkIntakeItem.
    expect(RESTORE_ROUTE).not.toMatch(/prisma\.emailMessage\.update/);
    expect(RESTORE_ROUTE).not.toMatch(/prisma\.workIntakeItem\.update/);
  });
  it("never touches APInvoice / JournalEntry / Approval / Payment", () => {
    for (const forbidden of [
      /prisma\.aPInvoice\./,
      /prisma\.journalEntry\./,
      /prisma\.approval\./,
      /prisma\.payment\./,
    ]) {
      expect(RESTORE_ROUTE).not.toMatch(forbidden);
    }
  });
});

describe("WI-SYNC-1e · production safety gate on /api/admin/mailbox/debug/*", () => {
  it("move-to-inbox returns 404 when SPECTRE_ALLOW_STAGING_DEBUG !== '1'", () => {
    expect(DEBUG_ROUTE).toMatch(/SPECTRE_ALLOW_STAGING_DEBUG !== "1"/);
    expect(DEBUG_ROUTE).toMatch(/"debug_endpoint_disabled"/);
    // The gate is the FIRST check so unauthenticated callers never
    // leak any mailbox state via a different error code.  Compare
    // the first OCCURRENCE OF THE CHECK — not the import line that
    // simply mentions the symbol name.
    const gateIdx = DEBUG_ROUTE.indexOf("process.env.SPECTRE_ALLOW_STAGING_DEBUG");
    const sessionCallIdx = DEBUG_ROUTE.indexOf("await getCurrentPrincipal(");
    expect(gateIdx).toBeGreaterThan(0);
    expect(gateIdx).toBeLessThan(sessionCallIdx);
  });
});
